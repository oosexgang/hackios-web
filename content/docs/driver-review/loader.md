# Review: boot loader (xnuloader/loader.c)

## Scope and method

Files read (read-only; nothing built, nothing run, no git state touched):

| file | lines |
|---|---|
| xnuloader/loader.c | 4135 (read in full for the parts below; the UFS survey/GPT diagnostics 1100-1440 and the battery/charger code only skimmed) |
| xnuloader/efi.h | 298 (struct layouts, EFI_FILE_INFO offset, allocate_pages/free_pages signatures) |
| xnuloader/mkpayload.py | 59 (payload producer: are text entries NUL-terminated, what does `size` mean) |
| tools/mkesp.py | 96 (payload validator on the host side) |
| docs/uefi-boot.md | read for what the doc claims about the payload region |

Method: traced the USB command path (usb_command_loop / usb_poll_command -> fb_command), then every user of host-controlled
bytes (command text, `download:` size and data, the payload header/entries, the payload's cmdline), then
load_payload_from_volume(), block_poll()/block_start(), the memory-map code, the device-tree writer and the kernel
command-line assembly. Each finding below was traced from input to effect in the source; where an effect depends on
hardware or firmware behaviour that this repository does not state, the confidence is NEEDS-HARDWARE.

Threat-model note that affects every severity below. The USB host chooses the payload, and the payload contains the
kernel that the loader then jumps to (and the cmdline, including `ufs_write=1`, `ufs_native=`, `physbase`). A hostile host
therefore already has code execution at EL1 with the MMU off and direct UFS controller access through `ufs_native=`. Memory-safety
flaws in payload parsing are consequently robustness/brick-avoidance problems (a malformed or truncated payload corrupting
the loader, the kernel window or boot_args; a wedged loader), not privilege escalations over a trusted loader. The same holds
for block_write's guard: it protects darwin's first 2042368 blocks and the other partitions against a buggy kernel, not against a
malicious one. I rate with that in mind. Findings that matter even for a benign host (wrong state, truncated file,
stale data) are rated higher than ones that need a deliberately lying payload.

## Findings

| id | severity | confidence | where | one line |
|---|---|---|---|---|
| L1 | medium | CONFIRMED | loader.c:2255, 3627, 3630, 3548 | "busy" is `running_live != NULL`, but running_live is NULL for any kernel without a kernel_live block; then download/oem run/oem ramdisk are accepted while the kernel runs |
| L2 | medium | CONFIRMED | loader.c:4005-4016, 4123 | failed volume read frees the pages but leaves a valid XNUP header there; efi_main then boots the torn payload |
| L3 | medium | NEEDS-HARDWARE | loader.c:3997-4001, 3679, 3188 | volume load claims only `pages` of the file, but `download:` and the panic-log memset use the whole 63/64 MiB |
| L4 | low-medium | CONFIRMED | loader.c:2523-2551, 2832-2833, 3993 | payload header size and entry sizes are never checked against the file/region; ramdisk memcpy can read up to 4 GiB past the payload |
| L5 | low-medium | CONFIRMED | loader.c:2751-2827 | Mach-O segment extents unchecked (vmaddr+vmsize wrap, filesize>vmsize, cmdsize 0, fileoff): arbitrary physical writes before the kernel starts |
| L6 | low | CONFIRMED | loader.c:2787-2812 | `rdres` (resident_rd_size) has no upper bound; rounding and `dt_pa` arithmetic can wrap |
| L7 | low | CONFIRMED | loader.c:398-408, 2809, 3049, 3287 | device-tree writer has no bound; dt_len never compared with the 64 KiB reserved; boot_args sits right after it and is written first |
| L8 | low | CONFIRMED / NEEDS-HARDWARE | loader.c:3600-3606, 3647, 3685, 3696-3701 | `download:` to the resident area accepts >= 4 GiB but replies with 32 bits; received count `r` is not clamped to `want` |
| L9 | low | CONFIRMED | loader.c:3664-3667, 3694-3710 | `oem ramdisk none` leaves the ramdisk download armed; a failed `download:` leaves a half-overwritten payload with a valid header |
| L10 | low | CONFIRMED | loader.c:2868-2871, 1984, 2988 | flags that are not reset per run: hc_requested, block_probe_requested, block_enabled (stale page and ufs_shared_pa offered to a run that did not ask) |
| L11 | low | CONFIRMED | loader.c:266, 1391, 1406, 1877, 1894 | every locate_handle_buffer() result is leaked (no free_pool anywhere); find_log_partition() runs on every log write |
| L12 | low | PLAUSIBLE | loader.c:2090-2094 | block_poll takes bounds (parts, blocks, block_size, read twice) from the kernel-writable shared page; the write guard itself uses loader-private state and is sound |

No finding lets the USB host write outside the documented regions through the command parser itself: `download:` is bounded to
PAYLOAD_BASE..+63 MiB or to the resident area (L8 covers the one assumption it makes).

## Details

### L1 (medium, CONFIRMED) busy state is lost when the kernel has no kernel_live block

- Code: `running_live = live;` (loader.c:2255, in run_on_other_cpu) and `int busy = running_live != NULL;` (3627).
  `live` is `kernel_live`, which run_kernel sets only if it finds KERNEL_LIVE_MAGIC while scanning the loaded kernel
  (2891-2898); otherwise it stays NULL and is passed on at 3329.
- Scenario: payload with `usb`, cmdline `bootcpu=N` (kernel on another core) and a kernel image that does not contain the
  magic (older kernel, the QEMU hello kernel). run_on_other_cpu still polls the host every pass (`usb_poll_command()` at
  2348, which only checks `USB == NULL`). fb_command is entered with busy == 0, so:
  - `download:` writes to PAYLOAD_BASE or, after `oem ramdisk`, over the resident root image at win_base+0x08000000 while that
    kernel is running and using it as its root device;
  - `oem run` re-enters run_kernel: it memsets and rewrites the kernel segments under the running kernel and overwrites
    loader_ctx (the saved return context of the first run), so the first kernel's return lands in the wrong frame;
  - `oem stop` does nothing (3636 requires busy), so the run cannot be ended from the host;
  - usb_wait's 3 s give-up (3548) is also keyed to running_live != NULL, so a nested `download:` whose host goes quiet blocks the
    watcher forever (it only pets the watchdog), and the kernel's return is never noticed.
- Fix (text diff):
  ```
  -static const struct kernel_live *running_live;
  +static const struct kernel_live *running_live;
  +static int run_active;                  /* set for the whole of run_on_other_cpu(), live block or not */
   ...run_on_other_cpu():
  -	running_live = live;
  +	running_live = live; run_active = 1;
   ...
  -	running_live = NULL;
  +	running_live = NULL; run_active = 0;
   ...fb_command():
  -	int busy = running_live != NULL;
  +	int busy = run_active;
   ...  "oem stop": if (busy && running_live) ...
   ...  "oem log":  if (busy && running_live) compose_live_log(...); else compose_logs(NULL, 0);
   ...usb_wait(): if (run_active && ...) return -1;
  ```

### L2 (medium, CONFIRMED) a failed or short volume read leaves a valid payload header behind

- Code: loader.c:4002-4009. The first 1 MiB chunk is read to PAYLOAD_BASE (so `magic == XNUP` is already in memory); if a later
  `file->read` fails or returns 0, the code sets the note, calls `BS->free_pages(PAYLOAD_BASE, pages)` and returns 0. Nothing clears
  the header and free_pages does not scrub. efi_main then calls `parse_payload(&pi, 0)` (4123), which only tests
  `ph->magic == PAYLOAD_MAGIC` at PAYLOAD_BASE (2519) and returns 1.
- Scenario: a payload.bin larger than 1 MiB on a flaky card/USB stick, or a volume that returns an error on the second read.
  Screen says "payload: none in memory, and ... could not be read to its end" (4096), yet the loader goes on to run_kernel with the
  truncated payload (the kernel Mach-O or ramdisk is cut off, the rest of it is whatever the freed pages held) or enters the USB
  loop. The same applies to the `magic != XNUP` path only if the header was valid, which it is not, so that path is fine.
- Fix:
  ```
  	if (EFI_ERROR(file->read(...)) || chunk == 0) {
  		volume_payload_note = "...could not be read to its end";
  +		((struct payload_header *)PAYLOAD_BASE)->magic = 0;
  		BS->free_pages(PAYLOAD_BASE, pages);
  		goto close;
  ```
  Also validate `ph->size` there (see L4).
- Handle handling in this function is otherwise right: every path after a successful `open` reaches `close:` exactly once; `root` is
  closed on the open-failure return; no double close; pages are freed on every failure after allocation.

### L3 (medium, NEEDS-HARDWARE) volume load claims only the file's pages, the rest of the region is used anyway

- Code: `pages = (size + 0xfff) / 0x1000; allocate_pages(AllocateAddress, ..., pages, &address)` (3997-3998), i.e. only the bytes
  of the file. But `download:` writes up to `PAYLOAD_MAX_SIZE - 0x100000` (3679-3680) at PAYLOAD_BASE, run_kernel zeroes the
  panic log at PANIC_LOG_BASE = PAYLOAD_BASE+63 MiB, 512 KiB (3187-3188), and choose_window() assumes the whole 64 MiB is outside any
  allocation (2669, 2685-2691). docs/uefi-boot.md:47-51 says "the loader's payload region is 64 MiB"; with the shim or QEMU the
  region is placed and (per the comment at 42) reserved in the memory map; in the volume case the success of AllocateAddress
  implies the region was NOT reserved.
- Scenario: payload.bin (say 15 MiB) from a volume, with a `usb` entry. usb_start() then allocates two 1 MiB transfer buffers
  (3516-3517), and other drivers allocate; any of them may land in the unclaimed 48 MiB. A following `download:` of a larger
  payload overwrites them mid-transfer (corrupt data or wedged USB), and the panic-log memset zeroes whatever lives at
  0xF3F00000. Whether the firmware's allocator hands out those pages is firmware behaviour: not stated in this repository.
- Fix: claim the whole region when the loader will use it, e.g. allocate `PAYLOAD_MAX_SIZE >> 12` pages (fall back to the file's
  pages and refuse `usb` mode / panic log if the full claim fails), or at least claim PANIC_LOG_BASE separately.

### L4 (low-medium, CONFIRMED) payload sizes are never validated against the payload

- parse_payload (2523-2551) and payload_kernel_version (4037-4048): `pend = p + ph->size` is only used to stop the walk;
  `ph->size` is not compared with the file size (volume: 3993 checks only `size >= 8` and `<= 63 MiB`), nor with
  PAYLOAD_MAX_SIZE, and no entry is checked for `p + sizeof(entry) + e->size <= pend`.
- Arithmetic itself (what you asked for): `e->size` is uint32_t and `15` is int, so `(e->size + 15) & ~15u` is evaluated in 32 bits.
  For `e->size` in 0xFFFFFFF1..0xFFFFFFFF it wraps to 0 and `p` advances 24 bytes (no loop, no hang; the next "entry" is parsed out of
  the current entry's data). For 0x...F0 or below `p += 24 + up to 4 GiB` in 64-bit pointer arithmetic: cannot wrap, the loop condition
  `p + 24 <= pend` then ends the walk. Both are safe from loops; neither rejects the entry. (tools/mkesp.py:49-50 uses Python
  integers, so for those sizes it parses differently from the loader.)
- Effects: (a) `pi->ramdisk = p + 24; pi->ramdisk_size = e->size` (2534-2535) is used as `memcpy((void *)rd_pa, pi.ramdisk, pi.ramdisk_size)` (2833).
  The destination is bounded (2813 checks the window), the source is not: a ramdisk entry claiming up to 4 GiB reads beyond the payload
  into whatever follows (stale RAM, the loader's own image, possibly unmapped or device memory -> exception -> reset). The
  kernel-version walk and the banner read the same stale memory. (b) With `ph->size` larger than the file, an entry walk without a
  terminator continues through unclaimed memory (fresh AllocatePages memory is not zeroed).
- Names that are not NUL-terminated within 16 bytes: str_eq stops at the literal's NUL, so lookups never read past the 24-byte header;
  only the verbose `print("%s", e->name)` (2531) runs on into the size field and data until a NUL (bounded by log_buf's check in put_char).
- Text values (`cmdline`, `kernel.ver`, `physbase`, `rdres`, `checkpoint`): mkpayload.py always appends a NUL inside the entry and pads, but the
  loader does not check it. Reads of an unterminated value run to the next NUL anywhere in memory. All writes derived from them are
  bounded: the cmdline copy by `n < BOOT_LINE_LENGTH - 1`, hakios_kver by `n + need < BOOT_LINE_LENGTH - 1` with `need` from the same str_len.
  `parse_number` wraps silently on long digit strings (no overflow trap) and returns 0 when there are no digits; no memory effect.
- Fix: in load_payload_from_volume, `if (ph->size > size - 8) fail`; in parse_payload and payload_kernel_version bound `pend` by a
  caller-supplied limit (volume size, or the download size recorded at `download:` time; fall back to PAYLOAD_MAX_SIZE - 1 MiB) and add
  `if ((uint64_t)e->size > (uint64_t)(pend - (p + sizeof(*e)))) break;` with the 64-bit rounding
  `(((uint64_t)e->size + 15) & ~15ULL)`; for `ramdisk`/`kernel` require the whole entry inside; for text entries require a NUL within `e->size`.

### L5 (low-medium, CONFIRMED) Mach-O segments are loaded without bounds

- Code: first pass 2751-2767, load pass 2820-2827. `vm_hi = sg->vmaddr + sg->vmsize` can wrap; `vm_lo` is only compared with the low
  limit; the load does `memset(vmaddr + slide, 0, vmsize); memcpy(vmaddr + slide, kernel + fileoff, filesize)` with no check that
  `vmaddr+vmsize` is inside `[kern_lo, kern_hi)` (it is not if it wrapped), that `filesize <= vmsize` (a larger file size writes past
  kern_hi into the resident image, device tree or boot_args), or that `fileoff + filesize` is inside the payload. `lc->cmdsize == 0`
  keeps `lc` in place for `ncmds` (up to 2^32) iterations; `ncmds`/`cmdsize` are not checked against `sizeofcmds` or the payload. LC_UNIXTHREAD
  reads 17 words without checking cmdsize.
- Scenario: a payload whose kernel is truncated, corrupt or made for another link layout; or a second segment with a high vmaddr. The
  loader writes into physical memory outside the window it claimed (its own image, UEFI, the payload being read), and the failure is a reset
  or a silent corruption, not a diagnostic.
- Fix: after the extent pass `if (vm_hi < vm_lo || kern_hi > win_base + win_size) fail;` and per segment require
  `filesize <= vmsize`, `vmaddr >= vm_lo`, `vmaddr + vmsize <= vm_hi` (no wrap), `fileoff + filesize <= kernel_len` (needs L4's
  entry bound), and `cmdsize >= sizeof(struct load_command)` and `cmdsize <= sizeofcmds - consumed`.

### L6 (low, CONFIRMED) resident image size from `rdres` is unbounded

- Code: `if (pi.resident_rd != 0) resident_rd_size = pi.resident_rd;` (2787-2789), then `res_size = (resident_rd_size + 0x3fff) & ~0x3fff` (2792),
  `dt_pa = rd1_pa + rd1_size` (2808), `top`, and the check `win_size < top - phys_base + 0x4000000` (2813). The `download:` path caps the size at
  `win_size - OFFSET - RESERVE` (3685), the `rdres` path does not. For `rdres` >= 2^64 - 0x3fff the rounding wraps to 0
  (resident entry with size 0, kernel starts without a root). For `rdres` near 2^64 - 0x108000000, `rd1_pa + rd1_size` wraps, `top - phys_base`
  becomes small, the 2813 check passes and the device tree and boot_args are written at a wrapped `dt_pa` inside the kernel's own segments.
  The value also persists in `resident_rd_size` for later runs (it is a static), even when the next payload has no `rdres`.
- The overlap check itself is right for what it covers: `kern_hi + rd_size > res_pa` (2794) uses 64-bit values from sizes that are bounded by 2813
  except for the wrap above.
- Fix: `if (resident_rd_size > win_size - RESIDENT_RD_OFFSET - RESIDENT_RD_RESERVE) fail;` right after the assignment (and check
  `win_size > OFFSET + RESERVE` first).

### L7 (low, CONFIRMED) device-tree writer has no bound

- Code: dt_prop (399-408) writes `36 + ((len+3)&~3)` bytes at `w->cur` without comparing with an end; `dt_len` is computed at 3287 and never compared with
  `dt_max = 0x10000` (2809), the space reserved before boot_args (`ba_pa = dt_pa + dt_max`). boot_args is memset and fully filled
  (2921-3045) BEFORE the tree is written (3049...), so an oversized tree silently overwrites commandLine, bootFlags etc. Names of 32 or more
  characters would run into the length field (memcpy of `str_len(name)` bytes into a 32-byte field).
- Bound on actual content: everything except identity.h is constant (8 KiB NVRAM image + a few KB, at most 8 cpu nodes). identity.h is generated
  from the builder's own IPSW (not in the repository, see build.sh/mkidentity.py), so its size cannot be established here; `mkidentity.py` copies
  property values without a size limit, names are Apple's (31 chars). Probability low, consequence a corrupt boot with no message.
- Depth: counts[16], deepest nesting used is 3: fine. `dt_prop_padded`'s 64-byte `field` takes at most 17 characters + the 32-byte size: fine.
- Fix: give dt_writer an `end` pointer, make dt_prop refuse (set an `overflow` flag) when `cur + 36 + padded > end`, and
  `if (w.overflow || dt_len > dt_max) { print("device tree too big\n"); return 0; }` before using it.

### L8 (low, CONFIRMED / NEEDS-HARDWARE) `download:` size reply and chunk accounting

- 32-bit reply: fb_reply_data (3600-3606) prints only the low 32 bits. The resident-area limit (3685) is `win_size - 0x08000000 - 0x30000000`, up to
  0x148000000 (win_size max 6 GiB, 2704). A host asking for `download:100000000` .. limit is accepted and answered `DATA00000000`; the loader waits for
  the full count while the host sends none, then the next command is swallowed as data (into the resident area) and the transfer ends "short download".
  `getvar:max-download-size` says 0xffffffff in this mode (3647) even though the real limit can be lower or higher. Fix: `if (limit > 0xffffffffULL) limit = 0xffffffffULL;`
  and advertise `limit`.
- r not clamped (NEEDS-HARDWARE): `r = usb_rx(usb_rx_buf, want)` then `memcpy(dest + got, usb_rx_buf, r)` (3696-3701) and `got += r`. If the controller ever
  reports more than `want` (a USB 3 burst delivering more than the request; not stated anywhere in this repository), the memcpy runs past `total`,
  and past `limit` at the end of the region, and reads past the 1 MiB receive buffer. Fix: `if (r > (int64_t)want) r = (int64_t)want;`.
- `parse_number` on `download:`: overflow wraps (17+ hex digits), "no digits" gives 0 -> "bad size". Wrapped values are small and are used consistently as
  `total`, so there is no memory effect, only a surprising size.

### L9 (low, CONFIRMED) command-state slips

- `oem ramdisk none` (3664-3667) returns after clearing resident_rd_size but does not clear `download_to_ramdisk`. Sequence `oem ramdisk`, `oem ramdisk none`,
  `download:<payload>`: the payload goes over the resident area (and `resident_rd_size = total`, the next kernel gets the payload file as md0) instead of
  to PAYLOAD_BASE. Fix: `download_to_ramdisk = 0;` in that branch.
- A `download:` to PAYLOAD_BASE writes straight over the live payload (3700). If it fails ("short download", cable event, 3703-3710) the old header may still be
  valid but its entries/tail are a mix of new and old data; `oem run` then parses that. Fix: zero `ph->magic` at the start of the download and write it
  back only when `got == total`.
- Parser/command state otherwise: `oem stop` when idle is a no-op; `oem run` when not busy runs; `reboot`, `oem hang`, `upload`, `oem log` while busy are by design.
  After OTHER_CPU_HUNG (3336-3342) run_on_other_cpu has cleared running_live, so the loader reports idle and accepts `download:`/`oem run` while a hung kernel
  may still be alive on its core; the only warning for a core left running (3373-3380) is on the came-back path. PLAUSIBLE: add a "kernel_may_be_alive" flag, set on
  HUNG, that makes fb_command refuse download/run/ramdisk until `reboot`.

### L10 (low, CONFIRMED) flags that outlive the run that set them

- run_kernel resets gamut_p3, block_write_requested and block_write_part per run (2849-2853) with the comment that the loader stays resident. Three
  similar states are not reset: `hc_requested |= ...` (2871; only |= exists, never `= 0`), `block_probe_requested |=` (2868), and `block_enabled` (set at 1984, never
  cleared). Effect: a run that asks for `ufs=2` after one that had `ufs_native=1` gets the kernel-owned transfer list offered (1966, 1768) without asking; a run
  that does NOT ask for ufs=2 after one that did still gets `ufs_shared_pa=0x...` appended to its command line (2988) and is still served by block_poll
  (2345-2349) from the stale page (read-only: block_write_part is -1 so writes are refused; `write_part_plus_one` in the stale page still says otherwise, so a
  kernel would try and be refused).
- Fix: `hc_requested = 0; block_probe_requested = 0; block_enabled = 0;` next to 2849-2853.

### L11 (low, CONFIRMED) pool leak

- `BS->locate_handle_buffer` allocates the handle array from the pool; `free_pool` is not called anywhere in loader.c (it is only declared in efi.h:50). Sites: 266
  (find_log_partition, called from every write_logs; flush_log runs every 2 s for 24 s of each other-core run, 2285-2294), 1391/1406 (ufs_survey), 1877/1894 (block_start).
  A phone with ~100 GPT partitions leaks ~0.8 KB per call, order of 10 KB per run, with the loader resident across many runs. Fix: `BS->free_pool(handles)` after use.

### L12 (low, PLAUSIBLE) block_poll relies on kernel-writable fields for bounds

- Code: 2090-2094 reads `block_shared.parts`, `block_shared.part[part].block_size` (twice: once in the `count <=` test, once for `bytes`) and `.blocks` from the page the kernel can
  write (it is the kernel's mailbox, same page, 8 KB aligned). The write guard is not among them and is sound: `block_write_part` and `BLOCK_WRITE_FIRST` are loader statics, `lba + count`
  is checked by subtraction (no overflow: `count <= 4 MiB / block_size`), there is exactly one `write_blocks` for the kernel (2123), the other is the logdump write (361), and
  block_start sets block_write_part only for the entry that passes block_is_darwin (1927-1929). What a kernel that corrupts the page (a stray store, or a data race against the
  re-read of block_size between 2090 and 2094) can do: pass `bytes > BLOCK_BUFFER_SIZE` to read_blocks/write_blocks (write beyond or read from beyond block_buffer) or an `lba`
  past the end of darwin (then only UEFI's own partition bound stops it, as the comment at 1454 says).
- Fix: keep a loader-private copy (`static uint32_t priv_block_size[]; static uint64_t priv_blocks[]`) or read them from `block_bios[part]->media` (block_size, last_block + 1), and read each once into locals.

## Checked and found fine

Command parser
- usb_command_loop (3835-3857) and usb_poll_command (3802-3832): the receive is 511 bytes into a 1 MiB buffer (3516), the copy into `cmd[128]` is clamped to 127 and NUL-terminated both places
  (3828-3830, 3850-3854); a longer command is truncated, not overflowed. No command takes an argument longer than 127 bytes (the longest is a number).
- starts_with (3610-3618) never reads past the NUL of `s`; prefix matching is loose ("oem runX" runs, "rebootfoo" reboots) but harmless. `cmd + 9`, `cmd + 7`, `cmd + 11`, `c[8]`, `c[9]`, `c[11]` accesses happen only after
  the prefix matched, so they read at most the NUL.
- `getvar:` replies: fb_reply copies at most 63 text characters into usb_tx_buf (1 MiB); the `screen` reply goes through print and restores log_len; log_buf[log_len] is in range
  because put_char keeps log_len <= sizeof-1 (177).
- `download:` bounds: PAYLOAD_BASE target limited to 0x03f00000 = PAYLOAD_MAX_SIZE - 1 MiB (never touches the panic-log MiB) and equal to the advertised max-download-size; ramdisk target limited
  to `win_size - 0x08000000 - 0x30000000` with `win_size > OFFSET + RESERVE` verified at `oem ramdisk` time (3671) and win_size never shrinking (choose_window returns early once set);
  `total == 0` and `total > limit` rejected before any write; `to_ramdisk` consumed once (3681-3683); resident_rd_size zeroed before a ramdisk transfer and set only on full success (3687, 3704-3706).
- `oem ramdisk`, `oem run`, `oem selftest`, `oem hang`, `oem recording`, `oem sound`, `oem clearscreen`, `oem memmap` are refused while busy (3630-3633) when `busy` is true (see L1 for when it is not).
  `oem ramdisk none` while busy is also refused because it begins with "oem ramdisk".
- parse_number (2498-2510): no digits -> 0; invalid character stops; arithmetic wraps without UB (unsigned); callers: download size (checked afterwards), checkpoint (only compared with 999 and stored), physbase, rdres.
- `oem run [N]`: `arg = cmd + 7` is within the command; checkpoint 999 maps to the self-test path as `oem selftest` does.
- upload: `staged_len` chunks of at most 1 MiB copied into usb_tx_buf (3714-3720); out_buf is 2 MiB and staged_len is clamped by compose_logs (312-314) and compose_live_log's PUT (1011-1018)
  with `n <= room` invariant (n starts at log_len <= 32767); the log text written to logdump is at most about 2 MiB - 8 KiB + 4 KiB rounding, below sizeof(out_buf).

Payload parsing
- Termination: every iteration advances `p` by at least 24 bytes (size wrap gives 0 padding, not negative); no infinite loop; no 64-bit pointer wrap. Entry header is fully inside `[p, pend)`
  before it is read (`p + 24 <= pend`).
- str_eq against literals never reads beyond the literal's length + 1, so a name without a NUL in 16 bytes is not over-read by matching.
- The cmdline scans in run_kernel (2854-2873, 2899-2906, 2937-2939, 2959-2960, 2975-2977) test `c[-1]` only for `c > pi.cmdline` (via `c == pi.cmdline ||`), and never read past a NUL.
  `loader_return_after=` digit loop stops at NUL; `kernel_budget` can wrap with 20+ digits (only effect: stops petting the watchdog sooner).
- mkpayload.py NUL-terminates every text entry inside the entry's size and pads to 16; its header size covers the 24-byte terminator; mkesp.py's PAYLOAD_LIMIT equals the loader's
  `PAYLOAD_MAX_SIZE - 0x100000`.

Volume loader (load_payload_from_volume, 3962-4022)
- Size: read from get_info at offset 8 (efi.h:207 documents it), `size >= 8` and `<= 63 MiB` enforced before allocation; `pages` rounded up correctly; `info` is 512 bytes (only a short file name is returned; a
  BUFFER_TOO_SMALL would just fail into the "cannot be read" note).
- The read loop reads at most 1 MiB at a time at `PAYLOAD_BASE + done`, handles short reads, stops on `chunk == 0`, and never exceeds `size`.
- Close paths: `root->close` on open failure; `file`/`root` closed exactly once at `close:` on all later paths (including success); no handle leaked and none closed twice; the pages are freed on both
  read failure and bad magic; success keeps them on purpose. (The one defect on these paths is the stale header, L2.)

Block service
- Only one kernel-reachable `write_blocks` (2123) and it is behind `block_write_part >= 0 && part == block_write_part && lba >= BLOCK_WRITE_FIRST`; `lba + count` overflow is excluded by `count <= blocks - lba`;
  `bytes = count * block_size` cannot exceed 4 MiB given the same block_size; unknown `op` touches nothing (2144-2146); division by a zero block_size yields 0 on AArch64 and the request is refused.
- block_write_part is the index of the entry in `block_shared.part[]` at the time block_is_darwin passed (1927-1928, before `parts++`); units are appended after the partitions so indices do not shift; limits:
  `parts + nunits < 160`, `nunits <= 16`. block_is_darwin requires exact name "darwin" (7 bytes compared, ufs_name maps non-ASCII to '?'), both GUIDs, start/end LBA, unit 0, block size 4096, block count, not read-only.
  A second partition cannot pass it (unique GUID).
- Per-run reset of block_write_requested/block_write_part (2852-2853) holds; a run without `ufs_write=1` has writes refused even if the page is stale (L10 notes the page contents).
- The tally reset (1973) and the answer/mailbox handshake (request volatile, dmb before `answered`) are consistent.

Memory map / window
- choose_window's exclusion of PAYLOAD_BASE..+64 MiB (2685-2691) is correct for all four overlap shapes; the unsigned `pay_lo - lo` only matters where `pay_lo > lo` is also tested. A descriptor that
  ends inside the payload region is dropped rather than trimmed (loses memory, never overlaps). `claim` goes through AllocateAddress, so the firmware refuses overlap; `best_size >> 12 == 0` fails cleanly.
- `win_size < top - phys_base + 64 MiB` (2813) is the single check that makes the DT, boot_args, kernel and payload ramdisk copies land inside the window, given kern_hi is sane (L5) and the resident size
  is bounded (L6).
- print_memory_map: `totals[d->type]` guarded by `type < 16`; `get_memory_map` failure is handled; a 64 KiB static buffer is used.

Command line (BOOT_LINE_LENGTH 608)
- All base pieces (2964-2987) and the two `*_shared_pa=0x%016x` pieces (2993-3013) check `n < BOOT_LINE_LENGTH - 1` per character, so none can write past index 606; ba was memset to 0, so index 607 stays NUL.
- hakios_kver (3015-3031): `need = 12 + strlen + 1`, tested with `n + need < 607` before any byte is written; the copy writes at most `need` bytes (the loop stops at a space, so possibly fewer); the else branch
  prints the warning and writes nothing. No overflow, no uninitialised read. The cmdline tail (3037-3044) is bounded by the same limit; the truncation warning prints `str_len(rest)` correctly and the
  `print` arguments are cast to uint64_t as print's `%d`/`%x` require. A value with a tab or other whitespace in kernel.ver is passed through (only ' ' ends it); whether the kernel's boot-arg parser treats
  those as separators is not in this repository (no isargsep found), so not decided here.
- The loader's own `ufs_write=1` / `ufs_native=` detection requires a preceding space or start of line; the kernel could accept other separators, which can only make the loader stricter (writes refused), not looser.

Device tree
- Depth never exceeds 3; `dt_prop_padded` field is 64 bytes for strings of at most 17 characters; per-property copy uses the same padded length as the memset; names written by the loader itself are all < 32 characters.

## Not checked

- Hardware behaviour: whether PAYLOAD_BASE..+64 MiB is free or reserved on the phone, whether the USB controller can return `bytes_completed > requested`, how Qualcomm's block I/O bounds a partition, cache state of the
  panic-log region that run_kernel zeroes (3188) with the data cache on while the cache-clean loop (3309-3320) only covers some memory-map types (NEEDS-HARDWARE; not traced).
- identity.h is not in the tree (generated from the builder's IPSW), so the device tree's real size and the property names/lengths could not be measured (L7).
- The kernel-supplied fields: kernel_live (log/log_len/log_head/log_ring pointers and offsets, recording and sound pointers and lengths up to 1 GiB used by `upload` and write_logs, loader_ctx log pointer/length printed
  unclamped when there is no log partition). They come from the kernel the host chose, so I treated them as trusted (see the threat-model note).
- USB device protocol details of the Qualcomm stack (usb_start, descriptors, handle_event semantics), the UFS host-controller take-back code (hc_*), the charger/battery code, the Block I/O 2 probe, ramfb/fw_cfg code (QEMU only),
  the assembly (loader_save_ctx, return stubs, other_cpu_entry), the watchdog SMC code and the exception hook. Only skimmed or not read.
- The ufs_survey/ufs_check_gpt/ufs_dump_super diagnostics read flash-controlled GPT/liblp data; I looked at their size arithmetic (all reads stay inside the 1 MiB ufs_buffer) but did not audit them line by line.
- docs/ and Makefile/qemu scripts beyond what is quoted above; tools/darwin-write.py (the build side of the darwin identity constants).

## Fix status

Each finding was re-read in the current tree first. Nothing was built or run; edits were re-read for syntax only. All edits are in `xnuloader/loader.c`. The write guard (`block_is_darwin`, the write branch of `block_poll`, the `ufs_write=` parse) was not touched.

- L1: FIXED. New `run_active` flag, set for the whole of `run_on_other_cpu()`. `fb_command` (`busy`) and `usb_wait` (the 3 s give-up) use it; `oem stop` and `oem log` still need `running_live != NULL` for the live block itself.
- L2: ALREADY FIXED (the header's magic is zeroed before the pages are freed in `load_payload_from_volume`).
- L3: ALREADY FIXED (the volume load now claims the whole 64 MiB region).
- L4: FIXED, in part. `payload_walk_size()` caps the header's size at what the region holds; `parse_payload` refuses a payload (returns 0, one message) whose entry claims more than is left, and `payload_kernel_version` stops the walk there; so the 32-bit rounding cannot wrap and the ramdisk copy cannot read past the payload. SKIPPED: the check that text entries hold a NUL (mkpayload.py always writes one, and the entry-size bound limits the over-read).
- L5: FIXED. `parse_payload` records `kernel_size`; `run_kernel` now refuses a kernel whose `sizeofcmds` exceeds it, a load command shorter than its header or past `sizeofcmds` (also stops a `cmdsize` of 0), a segment whose `vmaddr + vmsize` wraps, whose `filesize > vmsize` or whose file range leaves the kernel entry, a `vm_hi` more than `MAX_MEM_SIZE` past the virtual base, and an LC_UNIXTHREAD too short to hold pc.
- L6: FIXED. An `rdres` larger than the window above `RESIDENT_RD_OFFSET` is refused before it is stored (not the 768 MiB `RESIDENT_RD_RESERVE` of the `download:` path: that would reject setups the room check accepts today).
- L7: FIXED. `dt_writer` has an `end` (`dt_pa + dt_max`) and an `overflow` flag: `dt_prop` and `dt_begin` write nothing that does not fit (and refuse a name over 32 bytes), `run_kernel` prints "device tree does not fit" and returns 0 instead of handing the kernel a tree that overwrote boot_args.
- L8: FIXED, in part. The `download:` limit in ramdisk mode is capped at 0xffffffff (the reply carries 32 bits), and the received count `r` is clamped to `want`. SKIPPED: advertising the real limit in `getvar:max-download-size`.
- L9: FIXED, two of three. `oem ramdisk none` clears `download_to_ramdisk`; a `download:` over the payload takes the XNUP magic out as soon as it arrives and puts it back only when the whole file is in, so a failed transfer leaves no payload instead of a mix. SKIPPED: the `kernel_may_be_alive` flag after OTHER_CPU_HUNG (a design change in what the loader accepts after a hang).
- L10: FIXED. `hc_requested`, `block_probe_requested` and `block_enabled` are reset at the start of each run, next to the existing `block_write_requested` reset.
- L11: FIXED. `BS->free_pool(handles)` after every `locate_handle_buffer` use: `find_log_partition` (both exits), `ufs_survey` (both calls), `block_start` (both calls).
- L12: SKIPPED. The fix changes the bound check that gates both the read and the write branch of `block_poll`, which is the write guard's function; the report finds the guard itself sound, so it is left as it is.

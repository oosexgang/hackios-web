# Driver review: audio DSP loader, battery, CPU frequency

## Scope and method

Files read in full (paths under `xnu/files/`):

| File | Lines |
|---|---|
| `drivers/audio/hakios.adsp.c` | 3244 |
| `drivers/power/hakios.battery.c` | 198 |
| `drivers/power/hakios.battery.cpp` | 230 |
| `drivers/power/hakios.cpufreq.c` | 597 |

Context also read: the callers `drivers/input/hakios.input.c:217-226`, `osfmk/arm64/loader_return.c:377-379,445,492`, the consumer `drivers/camera/hakios.torch.c:454`, and the lock declarations in `hakios.wifi.c:190-192`. Nothing from the modem files was analysed.

Method: read-only, line-by-line. For every value that the DSP, the always-on processor (AOP) or the firmware files supply (SMEM entry headers, SMP2P words, GLINK queue messages, QRTR and APR payloads, battmgr answers, MDT/ELF segment headers, the AOP mailbox descriptor, the command database) I traced how it becomes a size, an offset, a loop bound or an index. For every wait loop I noted the bound and the timeout action. Nothing was built or run, and no hardware facts were assumed. Where severity depends on silicon behaviour the finding says NEEDS-HARDWARE.

Threat model used: the DSP (and AOP) can write arbitrary bytes into the shared memory it shares with us, and so can stale state left by an earlier kernel or Android.

## Findings

| ID | Severity | Confidence | Where | One line |
|---|---|---|---|---|
| F1 | High | CONFIRMED | adsp.c:2012-2023, 2058, 2099, 2150 | GLINK message length wraps to 0: the listener livelocks holding `glink_lock`; the stop path then hangs |
| F2 | High | CONFIRMED | adsp.c:408, 424, 1861-1867, 1907, 1940 | SMEM item size underflows and offsets are unchecked: GLINK queues are accessed outside the SMEM window |
| F3 | Medium | CONFIRMED | adsp.c:2488, 2495, 2515 | APR payload length underflows: 256-byte out-of-bounds read, leaked to handlers and the log |
| F4 | Medium | CONFIRMED | adsp.c:2400, 2420 | QRTR `at + size > length` wraps: out-of-bounds read |
| F5 | Medium | CONFIRMED (severity NEEDS-HARDWARE) | battery.c:98-110, 139; adsp.c:2752-2808; torch.c:454 | Battery temperature has no freshness or range check, and the flashlight thermal guard consumes it |
| F6 | Medium | CONFIRMED | adsp.c:686 | `box + size > aoss.size` can overflow: mailbox writes outside the mapped block |
| F7 | Low-Med | CONFIRMED (a), PLAUSIBLE (b) | adsp.c:1145-1159, 1096-1099, 1123 | Firmware-file cleanup frees with the wrong size; mixed-source free; tiny `.mdt` read |
| F8 | Low | CONFIRMED | adsp.c:1257, 1594-1596 | Our SMP2P item is zeroed (340 bytes) at an unvalidated SMEM offset |
| F9 | Low | PLAUSIBLE | adsp.c:1371-1374, 900 | Panic way-back path calls `rails(0)`, which takes a mutex |
| F10 | Low | PLAUSIBLE | adsp.c:1893-1909, 2004-2010 | No read barrier between loading the DSP's queue head and its payload |
| F11 | Low | CONFIRMED | adsp.c:1407-1430, 1982-1983, 2916-2925 | Leaks: header page every start, GLINK intent buffers never freed |
| F12 | Low | PLAUSIBLE | adsp.c:2514-2519, 2575-2582 | `apr_answer` is published with no ordering |
| F13 | Low | CONFIRMED | cpufreq.c:573, 588-590 | `cpufreq=2` (any value) also starts `membench=2` |
| F14 | Low | PLAUSIBLE | cpufreq.c:557-587 | `cpufreq=1` / `ddr=1` have no platform check, unlike `adsp=1` |
| F15 | Low | CONFIRMED | cpufreq.c:358, 366 | Command-DB bounds checks are dead or off by 0x50 (diagnostic mode) |
| F16 | Low | CONFIRMED | battery.c:134, 139; battery.cpp:118, 130 | DSP-supplied values: signed overflow in `+50` rounding, negative to unsigned casts |
| F17 | Low | PLAUSIBLE | battery.c:188-189 | Shared struct can straddle the single mapped 16 KB page |
| F18 | Low | NEEDS-HARDWARE | adsp.c:1654 vs 1367 | IPCC GLINK enable bit set at start, never cleared at shutdown |

## Details

### F1 - GLINK length arithmetic wraps; zero-length message livelocks `glink_pump` (High, CONFIRMED)

`glink_pump()` computes the message length from DSP-written fields in 32-bit arithmetic:

- `adsp.c:2012`: `length += message.param2;` (OPEN)
- `adsp.c:2014`: `length += 8 * message.param2;` (INTENT)
- `adsp.c:2020`: `length = 16 + words[0];` (DATA, DATA_MORE)
- `adsp.c:2022-2023`: `length = (length + 7) & ~7u;` then `if (length > glink.theirs_size - 8)`

Failure scenarios (the DSP writes one 8-byte or 16-byte message into its own queue):

1. OPEN with `param2 = 0xFFFFFFF8`, or DATA with `words[0] = 0xFFFFFFF0`, or INTENT with `param2 = 0x1FFFFFFF`: `length` wraps to exactly 0. The size check passes and `waiting < length` is false. The handler then calls `glink_advance(length)` (2058, 2150, 2111) which moves the tail by 0. The `while (glink.up && !glink.broken)` loop at 2004 sees the same message again, forever. For DATA the drop path at 2148 also prints a line every iteration. For OPEN each pass sends another OPEN_ACK until our queue is full.
2. INTENT with `param2 = 0x20000001`: `8*param2` wraps to 8, so `length = 16` and the check passes. The loop at 2099 then runs 536,870,913 iterations of `glink_peek` (8 byte-wise SMEM reads each) plus a 64-entry scan.

`glink_pump()` runs with `glink_lock` held (`link_thread` at 2870-2871, `glink_send` at 2225-2231). Consequences:

- The link thread spins at 100% on one core.
- Every `glink_send` caller (QRTR, APR, battmgr, sound, mic) blocks in `lck_mtx_lock` with no timeout.
- `link_stop()` (called from `dsp_shutdown`, reached from `hakios_adsp_stop`, `loader_return.c:445`) waits 2 s, then does `lck_mtx_lock(&glink_lock)` at 2914 and blocks forever. The orderly return to the loader never completes.

Fix (compute in 64 bits and reject non-progress):

```diff
-	uint32_t waiting = glink_waiting(), length = sizeof(message);
+	uint32_t waiting = glink_waiting();
+	uint64_t length = sizeof(message);
 ...
-		length += message.param2;
+		length += message.param2;            /* now 64-bit: cannot wrap */
 ...
-		length += 8 * message.param2;
+		length += 8ull * message.param2;
 ...
-		length = 16 + words[0];
+		length = 16ull + words[0];
 	}
-	length = (length + 7) & ~7u;
-	if (length > glink.theirs_size - 8) {
+	length = (length + 7) & ~7ull;
+	if (length < sizeof(message) || length > glink.theirs_size - 8) {
```

Also make the INTENT loop `for (i = 0; i < message.param2 && 8 + 8*(uint64_t)(i+1) <= length; i++)`.

### F2 - SMEM entry size underflows and offset is never bounded; GLINK queues are accessed without bounds checks (High, CONFIRMED)

`smem_items()` builds each item's extent from DSP-writable entry headers:

- `adsp.c:408` and `adsp.c:424`: `found[count].size = entry.size - entry.padding_data;` (`padding_data` is a uint16 and `entry.size` a uint32, with no `padding_data <= size` check; an underflow yields about 4 GB).
- `adsp.c:407`, `adsp.c:423`: `found[count].offset = partition + at + sizeof(entry) + entry.padding_header` (up to 64 KB past the entry; never compared with `SMEM_SIZE` or the partition end).

`glink_find()` (1861-1867) accepts item 480 (created by the DSP itself, see the comment at step_survey 959) if `size >= 1024 && !(size & 7)`. It then uses the values raw, with no `smem_peek`-style window check:

- `adsp.c:1907`: `smem[glink.theirs + (at + i) % glink.theirs_size]`
- `adsp.c:1932`, `1940`: `queue[(head + i) % glink.ours_size] = ...` (a write)
- `smem_word(glink.descriptor + ...)` and `smem_poke(...)` are likewise unbounded.

Scenario: the DSP writes entry header item=480, `size=0x400`, `padding_data=0x408`. The size becomes 0xFFFFFFF8, which passes `glink_find`. The head/tail checks (`< theirs_size`, 1895 and 1922) now accept any 32-bit value. The first `glink_peek` reads `smem + theirs + up to 4 GB` and the link thread takes a data abort, which is a kernel panic. Even without the wrap, `offset + size` can exceed the mapped 2 MB window (padding_header adds up to 64 KB) and writes from `glink_put` land outside it. Items 478/479 have the same problem, because the DSP can edit their headers too.

Fix:

```diff
 /* in smem_items(), both loops */
-	found[count].size = entry.size - entry.padding_data;
+	if (entry.padding_data > entry.size || entry.padding_header > header.size ||
+	    (uint64_t)off + entry.size > partition + header.size) break;   /* off = computed offset */
+	found[count].size = entry.size - entry.padding_data;
```

And in `glink_find()` add `(uint64_t)x + size <= SMEM_SIZE` for each of the three items.

### F3 - APR payload length underflows (Medium, CONFIRMED)

`adsp.c:2488`: `payload = (header.size < length ? header.size : length) - header_length;`. `header_length` is 20..60 (validated against `length`); `header.size` is a DSP-written uint16 and is not validated against `header_length`. If `header.size < header_length` (for example `size = 0`) the subtraction wraps to about 4 billion.

The wrapped `payload` is then used at:

- `adsp.c:2495-2497`: `memcpy(words, data + header_length, payload < sizeof(words) ? payload : sizeof(words))` copies 256 bytes from a packet that may be only 20 bytes long, which is a heap over-read of up to 236 bytes. It is passed to the sound and mic event handlers with length 256.
- `adsp.c:2509`: the same for the first 16 bytes, which are printed.
- `adsp.c:2515-2516`: the over-read bytes go into `apr_answer.words`, with `apr_answer.length = payload` (about 4 G). `hakios_adsp_apr` copies those words to its caller (2581), and `step_apr` prints `apr_answer.words[i]` (3082-3083).

Result: kernel heap contents leak to the log and the handlers, and the read can fault if the packet sits at the end of a mapping.

Fix:

```diff
-	payload = (header.size < length ? header.size : length) - header_length;
+	{
+		uint32_t total = header.size < length ? header.size : length;
+		if (total < header_length) { printf("adsp: apr: size %u below header %u: dropped\n", total, header_length); return; }
+		payload = total - header_length;
+	}
```

### F4 - QRTR datagram size check wraps (Medium, CONFIRMED)

`adsp.c:2400`: `if (header.size == 0 || at + header.size > length)`. `at` (32 or `16 + data[3]`) and `header.size` (a DSP-supplied uint32, read at 2382 or 2388) are both uint32, so `header.size = 0xFFFFFFF0` wraps the sum to a small number and the datagram is accepted. At 2420, `memcpy(&control, data + at, header.size < sizeof(control) ? header.size : sizeof(control))` then copies 20 bytes from `data + at`. With a v1 header in a 32-byte packet that reads 20 bytes past the `kalloc_data(sizeof(*packet) + length)` element. For the v3 header `at` can be up to 271 bytes past `length`. The over-read bytes become `control->words`, which are stored in `qrtr_servers[]` (2343-2346) and printed.

Fix:

```diff
-	if (header.size == 0 || at + header.size > length) {
+	if (header.size == 0 || at > length || header.size > length - at) {
```

### F5 - Battery temperature: no freshness or range handling, consumed by the flashlight thermal guard (Medium, CONFIRMED; real-world severity NEEDS-HARDWARE)

- `battery.c:139`: `battery_temperature_c = (b->temperature_hundredths + 50) / 100;` (DSP path). `battery.c:104`: `battery_temperature_c = sample.temperature_c;` (loader path). Neither has a timestamp or a range check.
- `hakios_battery_temperature()` (47-51) returns the last value forever.
- `torch.c:454`: `if (hakios_battery_temperature() >= HOTTEST_BATTERY_C)` is the only check of the battery temperature.

Staleness paths, all traced:

1. `battmgr_thread` leaves its loop for good when the DSP closes PMIC_RTR_ADSP_APPS (`adsp.c:2752`, `channel->open=false` at 2184) or `glink.up` clears, and is never restarted (2807-2808). The last temperature stays.
2. If any of the seven `battmgr_get` calls fails, `good` is false and nothing is reported (2765): the old value stays, with only a log line.
3. `battery_poll` failure (`battery.c:95-99`) only increments `battery_failures`.

The unknown value is -273, which is below 45, so the guard treats "unknown" and "stale" as safe.

Range: `temperature_hundredths` comes straight from a DSP uint32 cast to int32 (2781). For `0x7FFFFFFF` the `+ 50` is signed overflow (undefined behaviour; in practice it wraps negative), so a garbage or lying DSP reads as cold, not hot.

Fix:

```diff
 /* battery.c */
+static uint64_t battery_temp_at;   /* mach_absolute_time of last good report */
 int hakios_battery_temperature(void) {
-	return battery_temperature_c;
+	return (mach_absolute_time() - battery_temp_at < FRESH_TICKS) ? battery_temperature_c : -273;
 }
-	battery_temperature_c = (b->temperature_hundredths + 50) / 100;
+	battery_temperature_c = (int)(((int64_t)b->temperature_hundredths + 50) / 100);
+	battery_temp_at = mach_absolute_time();
```

and make the torch guard fail closed on -273 if the board is known to have a battery. Whether fail-closed is right depends on policy, so I only flag it.

### F6 - AOP mailbox bounds check overflows (Medium, CONFIRMED)

`adsp.c:686`: `if (size < QMP_MESSAGE + 4 || box < 0x3c || box + size > aoss.size || (box & 3))`. `box` and `size` are uint32 read from the AOP's message RAM (684-685), and `aoss.size` is 0x400. With `box = 0x3fc` and `size = 0xFFFFFF00` the sum is 0x2FC and the check passes. `mailbox_send` then writes `aoss.base + our_box + 4 + 4*i` for 16 words (749-752), which goes from 0x400 to 0x43f, outside the mapped block, into whatever the neighbouring AOSS registers are (NEEDS-HARDWARE for the effect). The AOP is a remote processor, so this value is untrusted input. (The same pattern exists in `hakios.wifi.c`; not reviewed here.)

Fix: `|| size > aoss.size - box` after `box < 0x3c || box >= aoss.size`.

### F7 - Firmware image bookkeeping (Low-Medium)

(a) CONFIRMED. `adsp.c:1145` stores the header's `file_size` in `image.segment[n].file_size`. The file was allocated with `attributes.va_data_size` (`root_file`, 1003). On a size mismatch (1156-1159) the code does `image.segments++` so the file is released, but `image_forget()` (1098) calls `kfree_data(data, image.segment[s].file_size)`, which is the header's value, not the allocation size. With a wrong `adsp.bNN` on the root file system, the clean "has N bytes, the header says M" failure becomes a `kfree_data` size mismatch (a zone panic or heap corruption). Fix: store the real `file_size` (`image.segment[n].file_size = file_size;`) before `goto fail`, or keep a separate allocation size.

(b) PLAUSIBLE. `from_root` (1053) is set when any one file came from `/fw` on the root. `image_forget()` then frees all files, including `image.header` and segments that came from the small image (`hakios_image_file`, 1043), which are not `kalloc` memory. This needs a partly populated small image (header there, a segment missing, taken from root). Fix: track the source per file (a flag per segment and for the header).

(c) CONFIRMED but trivial. `adsp.c:1123`: `memcmp(header, "\177ELF\1", 5)` is evaluated before any size check, so a 1..4 byte `adsp.mdt` over-reads up to 4 bytes (and the print at 1124 reads `header[0..3]`).

Checked fine in the same function: segment window checks (1138-1139) correctly bound `paddr`, `file_size` and `memory_size` in 64 bits against `[0x86700000, +64 MB)`, and `count <= MAX_SEGMENTS` bounds `image.segment[]`.

### F8 - Our SMP2P item is written at an unvalidated offset (Low, CONFIRMED)

`our_item_find()` (1252-1258) accepts item 429 if `size >= sizeof(struct smp2p)`, where `size` is the F2-underflowable value, and returns the raw offset. `step_our_item()` then does `for (at < 340) smem_poke(our_item + at, 0)` (1594-1596) and several more pokes, with no `smem_peek` bounds check first (unlike `dsp_listen` and `dsp_ask_to_stop`, which peek first). A stale or corrupt entry for item 429 (padding_header up to 64 KB, or size underflowed) makes the kernel write 340 bytes outside the item. That is either a data abort past the 2 MB window or corruption of other processors' SMEM items. At this step the DSP has been shut down, so the source is stale state from an earlier run. Fix: reuse the F2 validation and `if (!smem_peek(our_item, &ours, sizeof ours)) return false;` before the zeroing loop.

### F9 - Panic way-back path takes a mutex (Low, PLAUSIBLE)

`hakios_adsp_quiesce()` (3141-3150) sets `leaving` and calls `dsp_shutdown()`. `mailbox_send` honours `leaving` (no lock), but `rails(0)` (1371-1374) unconditionally does `lck_mtx_lock(&hakios_rsc_lock)` at line 900, with interrupts off and the other CPUs stopped. If a stopped CPU held `hakios_rsc_lock` (the modem driver `hakios.mpss.c:899,959` takes the same lock), the panic return hangs and the loader never gets control back. The window is small: `rails_asked` is only true until the DSP says "handover" (about 40 ms after start) or after a failed give-back. Fix: `if (!leaving) lck_mtx_lock(...)` as `mailbox_send` does, and skip `hold()` (it is already skipped when `leaving`).

Related note: `ddr_rpmh_write` in cpufreq.c (465-507) drives the same TCS 0 with no `hakios_rsc_lock`. That is safe today because `ddr_raise` runs at the start of `hakios_input_init` before any DSP driver exists, and `hakios_ddr_quiesce` runs with the other CPUs stopped. A CPU stopped mid-`rails()` leaves the TCS busy and the vote is skipped after a 200 ms wait. This is latent only.

### F10 - No read barrier between queue head and payload (Low, PLAUSIBLE, NEEDS-HARDWARE)

`glink_waiting()` (1893) loads the DSP's head with `rd()`. This is a plain `ldr` with only a compiler barrier. `glink_pump` then reads the payload with byte loads from the same Normal-NC (VM_WIMG_WCOMB) mapping (1907). There is no `dmb ld` between them (a control dependency does not order loads), so on a weakly ordered core the payload loads can be satisfied before the head load and show stale bytes (zeros or an old message). The result is a mis-parsed message, and an unknown command sets `glink.broken` (2192-2196), which permanently stops the link. The producer side is correct (`settle()` before the head update in `glink_put`, 1943). Whether the core reorders here is NEEDS-HARDWARE. Fix: `__asm__ volatile("dmb ishld" ::: "memory");` after reading the head in `glink_waiting`. `battery_snapshot()` already does this correctly (`battery.c:81,83`).

### F11 - Leaks (Low, CONFIRMED)

- `step_header` (1407) allocates a page with `kmem_alloc` and never frees it, on any return path. The comment does not say why. Linux keeps the metadata buffer until after `auth_and_reset`, so it may be deliberate until that point, but nothing releases it afterwards. This is 16 KB per start; the code runs once per boot with `adsp=1`, but `adsp_step` and `adsp_again` re-runs repeat it.
- `glink_offer` (1982-1983) allocates intent buffers (up to about 115 KB at the default sizes, up to 24 x 64 KB per channel when the DSP requests sizes). `link_stop` frees queued packets (2920-2923) but never `our_intents[].data`. When the size at a slot differs from the previous one, the old pointer is overwritten (1982-1983) and leaked.
- `step_image` returns false on a misaligned segment (1464-1467) without `image_forget()`; it is freed on the next `step_firmware` only.

### F12 - `apr_answer` is published without ordering (Low, PLAUSIBLE)

The link thread fills `apr_answer.words/length/opcode/token` and then sets `there = true` (2514-2519). `hakios_adsp_apr` polls `there` and `token`, then `memcpy`s the words (2575-2581). Only `there` is `volatile`, and volatile gives no ordering with the other (non-volatile) fields. There is no `dmb`, no atomic release or acquire. On arm64 the reader can see `there` and `token` before `words`, and so copy a stale or half-written answer. The one-answer-at-a-time design (`apr_lock`) limits exposure. Compare `battmgr`, which does this correctly with `os_atomic_inc(..., release)` / `os_atomic_load(..., acquire)` (2692, 2700-2706). Fix: use `os_atomic_store(&apr_answer.there, true, release)` and `os_atomic_load(&apr_answer.there, acquire)`.

### F13 - `cpufreq=2` also starts the all-core memory benchmark (Low, CONFIRMED)

`cpufreq.c:572-573` reads `cpufreq` into `enabled`. At 588: `if (PE_parse_boot_argn("membench", &enabled, ...) && enabled == 1) {...} else if (enabled == 2)`. When `membench` is absent the parse leaves `enabled` unchanged, so the `else if` tests the `cpufreq` value. With `cpufreq=2` (accepted as "on" by `cpufreq_wanted`), 8 threads each allocate 2 x 16 MB and run a spin-wait rendezvous. Fix: use a separate variable for `membench`.

### F14 - cpufreq/ddr have no platform check (Low, PLAUSIBLE)

`hakios_cpufreq_init` runs unconditionally from `hakios_input_init` (`hakios.input.c:217`). `adsp=1` refuses to run unless `pe_arm_get_soc_base_phys() == HAKIOS_SOC_BASE` (`adsp.c:3209`). The cpufreq code instead relies only on the boot-arg: `cpufreq=1` maps and reads EPSS at 0x18591000 and the RSC at 0x18220000 (95-106, 390-400); `ddr=1` does the same without needing `cpufreq`. The file header says the addresses are the phone's. On QEMU or any other board those addresses are unrelated MMIO or RAM, so the first access is likely an external abort (panic). The effect is not traced, since QEMU's memory map is outside this repository. Fix: the same `pe_arm_get_soc_base_phys()` gate at the top of `hakios_cpufreq_init`.

### F15 - Command-database bounds checks are dead or off by 0x50 (Low, CONFIRMED; diagnostic code)

`cpufreq.c:358` and `452`: `slave->header_offset >= CMD_DB_SIZE - 0x1000` is never true, because `header_offset` is a uint16 (max 0xFFFF < 0x1F000). The entry array is still inside the window (max 0xFFFF + 0x90 + 512 x 24 < 0x20000), so that one is only a dead check. At `cpufreq.c:366` the check is `slave->data_offset + entry[i].offset + sizeof(aux) < CMD_DB_SIZE - 0x40`, but the read is `db->data + that`, and `data` starts at +0x90. The read can end at 0x20050, which is 0x50 bytes past the mapped 0x20000. Compare the correct check in `adsp.c:852` (`> CMD_DB_SIZE - 0x1000`, ending before 0x1F090). The command database is written by the boot firmware, so the practical risk is low, and the code only runs with `ddr=1`. Fix: use the check of `adsp.c:852`.

### F16 - Arithmetic on DSP-supplied battery values (Low, CONFIRMED)

DSP words become `int32_t` at `adsp.c:2778-2791` with no range check. Then:

- `battery.c:134`: `(b->percent_hundredths + 50) / 100` is signed overflow for values above INT32_MAX-50 (undefined behaviour; it wraps negative in practice and the clamp turns 100% into 0%). The same is at `battery.c:139` and `battery.cpp:118, 225`.
- `battery.cpp:130`: `setVoltage((unsigned)(b->voltage_uv / 1000))`, a negative value becomes about 4 million mV.
- `battery.cpp:133`: `number("Temperature", ...)` stores negative values in a 32-bit unsigned OSNumber. Whether powerd reads it as signed is unverified.

No crash path: the divisors are constants, so there is no division by zero. Fix: do the rounding in `int64_t`, and clamp voltage, current and temperature to plausible ranges and reject the sample otherwise.

### F17 - Shared battery struct can straddle the mapped page (Low, PLAUSIBLE)

`battery.c:188-189` maps one 16 KB page, `ml_io_map(shared_pa & ~0x3fff, 0x4000)`, and points `shared_battery` at `page + (shared_pa & 0x3fff)`. Nothing checks that the offset plus `sizeof(struct loader_battery)` (56 bytes) stays inside the page, and `sample.size` is only checked as a minimum (96). The boot-arg comes from the loader, so this is a robustness issue. Fix: reject `(shared_pa & 0x3fff) + sizeof(*shared_battery) > LOADER_PAGE_SIZE`.

### F18 - IPCC GLINK enable bit is never cleared (Low, NEEDS-HARDWARE)

`step_start` enables the LPASS doorbell for both SMP2P and GLINK (`adsp.c:1653-1654`). `dsp_shutdown` disables only SMP2P (`1367`). Nothing disables GLINK, including on the failed-start paths (1657-1679). The effect of leaving a stale enable in the IPCC, after the DSP is off and rails are given back, is a hardware matter.

## Checked and found fine

Every wait loop has a bound, and a stated action at the bound:

- `mailbox_wait` (655-664): 1000 ms each. On timeout `mailbox_open` takes our link and channel down again (700-722). `mailbox_send` takes the message back (755-758).
- `rails()` completion wait (925-931): 100 ms. The TCS is cleaned up and `false` is returned. The busy-TCS pre-check (902-907) is under `hakios_rsc_lock`.
- `step_start` watch (1685-1729): `adsp_wait` seconds (default 10), shortened to 3 s after "up". `adsp_wait` times 1000000ull cannot overflow. On timeout or `DSP_FATAL` the step fails, and `steps_over()` shuts the DSP down (3108-3109), because `dsp_started` is already true. The DSP is not left running on this path.
- `dsp_ask_to_stop` (1328-1334): 5 s (2 s when leaving). On timeout it takes our stop bit back (1339) and `dsp_shutdown` still goes on to the TrustZone shutdown.
- `scm()` (1229): at most 100 retries on `SCM_INTERRUPTED`. Both the return value and the answer are checked by all four callers. `answer` is initialised to `~0` so a failure cannot read as success.
- `our_item_make` hardware spinlock (1513-1520): about 1 s, released on every exit (1556).
- `glink_send` (2230-2263): 5000 x 1 ms with the mutex dropped around the sleep. `battmgr_get`: 1000 ms. `hakios_adsp_apr`: `ms`. `step_link`: 5 s. `battmgr_stop` and `link_stop`: 2 s each.
- `doorbells()` and the pre-start doorbell drain: 8 iterations.
- cpufreq `ddr_rpmh_write`: 2000 x 100 us at both waits. `load_thread` and `bench_all` waits are diagnostic and by design.

Start and stop sequencing:

- The stop sequence order (ask the DSP, TrustZone shutdown, tell the AOP "off", give back rails) is what the file header says (`dsp_shutdown`, 1348-1376). `link_stop` runs first, so the link thread is no longer a second reader of SMEM when `dsp_ask_to_stop` runs.
- Error mid-start: failed `rails()` and failed `mailbox_send` and failed AUTH_AND_RESET each release the rails and the `dsp_lock` (1657-1679). A failed `mailbox_open` leaves the mailbox in its previous state.
- A `hakios_adsp_stop` that arrives while `step_start` is mid-flight cannot miss a started DSP: `dsp_started` is set under `dsp_lock`, and the panic path re-checks `dsp_started` (3144).
- `dsp_words`' static `at` and `smem_item`'s static `found[256]` are only used concurrently if `dsp_words` has never found item 443. Once the DSP is up, `at` is cached and `link_thread` does not call `smem_item`.

Memory-safety items traced and fine:

- `smem_peek` bounds the read in 64-bit (`offset + size`). `smem_partition` checks `table.count <= 64`, `entry.offset + entry.size` in 64-bit, and the `$TOC`/`$PRT` magics. `smem_items` loops always progress (at least 16 bytes) and are bounded by the 2 MB window; the cached-side loop guards `step_back` with `cacheline` being a power of two and `entry.size > at`. SMP2P entries are used only with `i < min(valid, 16)`. SMP2P `smem_poke` offsets are at most 336 + 4 inside the 340 bytes that `smem_peek` validated first. Crash-reason text is clamped to 80 bytes and zeroed first.
- `rail_position` (825-877): the command-DB entry array and data reads are inside the 0x20000 window (`CMD_DB_SIZE - 0x1000` check at 852). `levels[160]` cannot overflow (at most about 124 bytes).
- GLINK: head and tail are validated against the queue sizes at each use (`glink_waiting` 1895, `glink_room` 1922); `glink_peek` and `glink_advance` take the modulus. OPEN names are clamped to 32 bytes plus a terminating zero. DATA copies are bounded by `our_intents[].size - fill`, `intent < our_intent_count <= 24`, and the received packet is allocated at `fill` bytes. `glink_offer` is capped at 0x10000 bytes x 24 intents. `their_intents` insertion is bounded to 64.
- battmgr: `battmgr_input` copies at most `sizeof(m)` into a zeroed struct; `battmgr_get` requires `length >= sizeof(m)`; the answer is published with release/acquire atomics. Only `get` opcodes are sent, so there are no SCM, setting or limit writes to the charger. With `battery=1` battmgr refuses to start (2822), so the two writers of the `battery_*` globals are never both active.
- Firmware loading: the MDT header is bounded to `PAGE_SIZE`, `count <= 48`, `52 + 32*count <= size`, the hashes size is cross-checked, every segment is checked in 64-bit against the reserved window, and the 8-byte alignment is checked before writing (1464). Writes and read-back stay inside `[0x86700000, +64 MB)`. `memcpy` of the header into the SCM page is bounded by the header's `PAGE_SIZE` check. The cache is cleaned (`dc civac`) and `dsb`'d before the SCM call. SCM `MEM_SETUP` is passed the exact window and the computed image size (at most 64 MB).
- Barriers: `settle()` (dsb sy) before every IPCC doorbell and before every queue head update; `(void)rd()` after the mailbox message; `battery_snapshot` seqlock uses `dmb ishld` correctly and retries a bounded 4 times.
- Locks: `glink_lock`, `dsp_lock`, `apr_lock`, `say_lock` are all mutexes; the only sleeps under a lock are `sleep_*` inside mutex sections (legal). Nested orders found: `dsp_lock` then `hakios_rsc_lock` or `hakios_aop_mailbox_lock`, and `dsp_lock` then `glink_lock` (via `link_stop`). The reverse orders do not occur in this file, and `hakios.wifi.c` does not take `hakios_rsc_lock`. `qrtr_input` and `apr_input` are called without `glink_lock` held, so their `glink_send` calls do not self-deadlock.
- cpufreq: the value written to hardware is a table row index chosen from rows 0..39 only (`EPSS_TABLE_ROWS`); the table read stays below 0x1A0, inside the 0x1000 domain window. The selection rule (strictly increasing frequency) cannot pick an out-of-table row. No boot-arg or user-space interface selects a row: `cpufreq=` is on/off only, and there is no sysctl or ioctl in these files that writes frequency. `domain_of` returns 0..2, matching `cores[EPSS_DOMAINS]`. `ddr_vote` is range-checked to 1..0x3fff (`ddr_raise`, 527), `ddr_rest` is clamped to 0x3fff, and `ddr_rest=0` means "no request" (documented: slow loader USB, nothing unsafe is traced). `load_thread`'s buffer logic is safe, and `100 * busy / (now - then)` cannot divide by zero after a >= 1 ms delay.
- battery: every sysctl is `CTLFLAG_RD` over plain `int`, so user space can read but not write (the `kern.hakios` node itself is `CTLFLAG_RW`, with no handler). No division by a variable exists anywhere in these files. `HakiosBatteryReport` validates both `size` and `b->size`, and all OSObject allocations (the adapter dictionary, the numbers) are released on every path read; `attach` and `start` failure paths release or detach.
- Boot-args in the audio DSP file (`adsp`, `adsp_step`, `adsp_wait`, `adsp_listen`, `adsp_pause`, `adsp_new`, `adsp_keep`, `adsp_again`, `adsp_return`, `battmgr`): all parsed into uint32 with defaults. Only `adsp=1` or `adsp_step` start anything, and the platform check is at 3209. `adsp_listen * 1000` can wrap only for values above 4,294,967 (a harmless short wait).

## Not checked

- The Wi-Fi, modem and shared helper implementations in `hakios.wifi.c`, `hakios.mpss.c` (the same QMP mailbox, SMEM and RPMh pattern appears there; F6 applies to `hakios.wifi.c` at the same lines, unverified).
- The consumers of `hakios_adsp_apr` and the APR event handlers (`hakios.sound.c`, `hakios.mic.c`), including whether a handler called from the link thread can wait for an answer that only that thread can deliver.
- `hakios_image_file` (`hakios.image.c`), i.e. what memory the small-image pointers refer to, which F7(b) depends on.
- IOKit internals: `IOPMPowerSource::updateStatus()` being called before `attach`/`start` (`battery.cpp:212`), and `OSNumber` signedness as read by powerd.
- Hardware facts, all NEEDS-HARDWARE: that EPSS has 40 rows, its register layout, and thermal limiting of the top row (I found no software thermal path for the CPUs in these files); RPMh command timing and what clearing a TCS while a request is in flight does; whether `ml_io_map` returns NULL on failure (none of `smem`, `cmd_db`, `dsp_memory`, `ipcc.base` is checked for NULL); cache and WC-mapping coherence of the reserved DSP memory against the kernel's own linear map; TrustZone behaviour on a failed AUTH_AND_RESET (whether a PAS shutdown is needed).
- The loader side of the battery cache (`xnuloader`) and the QEMU build.
- Not built or run; all findings are from reading the code.

## Fix status

- F1: FIXED. adsp.c `glink_pump()`: the message length is worked out in 64 bits (`wide`) and checked against the queue before it is narrowed, so it cannot wrap to 0 and the loop always makes progress; an oversize message sets `glink.broken` as before.
- F2: FIXED. adsp.c `smem_items()` (both loops): stop at an entry with `padding_data > size` or whose item ends beyond its partition; `glink_find()` and `glink_reset()`: descriptor and both queues must lie inside the SMEM window (64-bit sums).
- F3: FIXED. adsp.c `apr_input()`: a packet whose size is below its header length is dropped before `payload` is computed.
- F4: FIXED. adsp.c `qrtr_input()`: the check is now `at > length || header.size > length - at`.
- F5: SKIPPED. A freshness limit or a "stale means unknown" value needs a policy decision, and the guard (`torch.c`, not one of my files) treats -273 as safe, so only a fail-closed change there would help. The signed overflow in the temperature rounding is fixed under F16.
- F6: FIXED. adsp.c `mailbox_open()`: `box >= aoss.size || size > aoss.size - box` instead of `box + size > aoss.size`.
- F7: (a) FIXED: on a file size mismatch the real allocation size is stored before the cleanup (`step_firmware()`); (c) FIXED: `size < 5` is tested before the `memcmp` and the log line prints from a bounded copy; (b) SKIPPED: PLAUSIBLE only, needs a per-file "came from the root" flag and knowledge of what `hakios_image_file()` returns.
- F8: FIXED. adsp.c `our_item_find()` requires the item to end inside the SMEM window; the F2 fix also bounds the offset.
- F9: FIXED. adsp.c `rails()` takes and drops `hakios_rsc_lock` only when `!leaving`, as `mailbox_send()` does.
- F10: SKIPPED. Needs hardware knowledge (whether and where a `dmb ld` is needed on this Normal-NC mapping); report says NEEDS-HARDWARE.
- F11: PARTLY FIXED. The intent buffers are given back in `link_stop()` and a buffer of another size is freed before it is replaced in `glink_offer()`. SKIPPED: the `step_header` page (when TrustZone is done with it is unknown). `step_image` is not a leak: the image is freed at the next `step_firmware()`.
- F12: FIXED. adsp.c `apr_input()` publishes `apr_answer.there` with `os_atomic_store(..., release)` and `hakios_adsp_apr()` reads it with `os_atomic_load(..., acquire)`.
- F13: FIXED. cpufreq.c `hakios_cpufreq_init()`: `membench` has its own variable, so `cpufreq=2` no longer starts the all-core benchmark.
- F14: SKIPPED. PLAUSIBLE only (the effect on other boards is not shown), and a platform gate would silently turn cpufreq off if the SoC base value differed; the owner should decide.
- F15: FIXED. cpufreq.c `ddr_look()`: the data read check now counts the header (`sizeof(*db) + ... <= CMD_DB_SIZE`). The dead `header_offset` checks (`ddr_look()`, `cmd_db_address()`) are harmless and left as they are.
- F16: FIXED in part. The `+50` roundings are done in 64 bits (battery.c `hakios_battery_report()`, battery.cpp `report()` and the log line), and a negative voltage becomes 0 before the unsigned `setVoltage()`. SKIPPED: clamping current, voltage and temperature to plausible ranges (hardware knowledge) and the negative temperature in the unsigned OSNumber (whether powerd reads it as signed is unverified).
- F17: FIXED. battery.c `hakios_battery_init()` rejects a `battery_shared_pa` whose struct would cross the end of the mapped page.
- F18: SKIPPED. NEEDS-HARDWARE (effect of a stale IPCC enable bit).
- S-13: FIXED. Same fix as F3 (adsp.c `apr_input()`): the packet is dropped when `header.size` is below the header length, and the copies are bounded by `min(header.size, length) - header_length`.

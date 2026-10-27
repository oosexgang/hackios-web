# Wi-Fi bring-up review: hakios.wifi.c

## Scope and method

- File: `drivers/wifi/hakios.wifi.c`, 4394 lines, read in full, line by line.
- A few lines of context were read in other files to size the impact of a finding. They were not audited:
  `xnu/files/bsd/sys/hakios.qrtr.h`, `drivers/modem/hakios.qmi.c` (the receive path only), `userland/build.sh` (how `fw/network` is installed), and a grep for users of `hakios_wifi_say`, `hakios_wifi_tell` and `passphrase`.
- Modem code was not examined.
- Method: manual tracing of every value that comes from a remote processor or the firmware (SMEM partition and item headers, SMP2P, the QMP descriptor, GLINK queue words, QRTR headers, MDT/ELF header, QMI-reported register window) to its first use as a size, offset or index. Wait loops, error paths, locks, the shutdown path, the log functions and boot-arg parsing were traced the same way.
- Nothing was built or run. Findings carry CONFIRMED (traced end to end in the source), PLAUSIBLE, or NEEDS-HARDWARE. "Remote" below means the DSP, the AOP or the radio firmware, and the shared memory is writable by them by design.

## Findings

| id | severity | confidence | where | one line |
|----|----------|------------|-------|----------|
| W1 | HIGH | CONFIRMED | 2470-2488, 2519-2523, 2586-2599 | GLINK message length overflows uint32 to 0; the message is never consumed and `glink_pump()` loops forever with `glink_lock` held, which also wedges shutdown |
| W2 | HIGH | CONFIRMED | 571-572, 587-589, 2312-2318, 2358-2363, 2388-2396 | SMEM item offset and size are not checked against the partition or the 2 MB mapping; the GLINK queues index the mapping with remote-chosen extents |
| W3 | MEDIUM | CONFIRMED | 866, 1480, 1562-1566 | the AOP's mailbox `box + size <= 0x400` check wraps in uint32, so `our_box` can lie outside the mapped block |
| W4 | LOW | CONFIRMED | 2915, 2935, 3251 | QRTR `at + header.size > length` wraps; the receiver is handed a huge length and a pointer that is not inside the packet |
| W5 | MEDIUM | PLAUSIBLE / NEEDS-HARDWARE | 3086-3091, 3974-3977 | a DSP that says "err-fatal" is only logged; the driver is not stopped and `hakios_wifi_dsp_is_up()` still says yes |
| W6 | LOW | PLAUSIBLE | 604-620, 657-661, 3035, 3217 | state shared by the link thread and the main thread without a lock: static `found[256]`, static `at`, `link_thread_is` |
| W7 | LOW | CONFIRMED | 3437-3466 | step 16 maps `size` bytes at a firmware-given address with no upper bound, and does not check the map result |
| W8 | LOW | CONFIRMED | 1894-1897, 1832-1836, 2440-2442, 399, 502, 1889 | error-path leaks (25 MB mapping, a page per start, intent buffers) and unchecked `ml_io_map*` results |
| W9 | LOW | NEEDS-HARDWARE | 2146-2156, 1810-1856, 4149-4163 | errors between step 8 and `dsp_started = true` never ask TrustZone to shut the image down; a panic in a small window is not cleaned up |
| W10 | LOW | PLAUSIBLE | 4104-4113 | the end-of-run stop waits at most 40 s for the start thread, then shuts the DSP down under it |
| W11 | LOW | PLAUSIBLE | 2602-2614 | the list of received packets and the intents' DONE_REUSE have no bound; a flooding DSP can use unbounded memory while the link thread is slow |
| W12 | LOW | NEEDS-HARDWARE | 2469-2475, 2358-2363 | no load barrier between reading the DSP's queue head and reading the payload |
| W13 | LOW | CONFIRMED | 4016, 4048-4052, 4080 | `wifi_mac` is a boot-arg although the file's own text says boot-args are echoed and printed with a panic; the passphrase length is logged |

Counts: 7 CONFIRMED (W1, W2, W3, W4, W7, W8, W13), 4 PLAUSIBLE (W5, W6, W10, W11; W5 also depends on hardware), 2 NEEDS-HARDWARE (W9, W12). Severity: 2 HIGH (W1, W2), 2 MEDIUM (W3, W5), 9 LOW.

## Details

### W1 GLINK length overflow: an endless loop under `glink_lock` (HIGH, CONFIRMED)

`glink_pump()` (line 2470) works out the message length in a `uint32_t` from fields of the DSP's own message.
- Line 2470: `uint32_t ... length = sizeof(message)`.
- Line 2477: OPEN, `length += message.param2`.
- Line 2479: INTENT, `length += 8 * message.param2`.
- Line 2485: DATA/DATA_MORE, `length = 16 + words[0]`.
- Line 2487: `length = (length + 7) & ~7u`.
- Line 2488: the only check is `length > glink.theirs_size - 8`.

All three sums wrap. With OPEN `param2 = 0xfffffff8`, `length = 8 + 0xfffffff8 = 0`, and `(0 + 7) & ~7 = 0`, so both of these pass:
- `0 > theirs_size - 8` is false;
- `waiting < 0` is false.

The `GLINK_OPEN` case then runs `glink_advance(0)` (line 2522), which stores the tail it just read, and breaks. The queue has not moved, `waiting` is still at least 8, and the `while (glink.up && !glink.broken)` loop (line 2469) reads the same message again, forever. The same happens with DATA and `words[0] = 0xfffffff0`. The intent is invalid, so the message is dropped with `glink_advance(0)` at line 2594, and again nothing is consumed.

A third variant is INTENT with `param2 = 0x20000000`. Then `8 * param2` is 0 and `length` is 8, but the loop at line 2546 runs 536 million times with `glink_peek` inside it, reading past the message. It runs only if `param1 == glink.their_channel`.

Consequences, all traced:
- The link thread spins at 100% CPU holding `glink_lock`. The OPEN path prints one log line per turn (line 2524), which floods the log and the loader log.
- `glink_send()` takes `glink_lock` (line 2671), so every QRTR sender (the driver, step 14 and step 15) blocks for good.
- Shutdown cannot finish. `dsp_shutdown()` calls `hakios_lx_stop()`, which sends through `glink_send` and blocks. Even without that, `link_stop()` waits 2 s (line 3125) and then does `lck_mtx_lock(&glink_lock)` (line 3132), which never returns. TrustZone is never asked to shut the DSP down, and the next kernel finds it running.

A crashed or hostile DSP can produce this by writing one 8-byte message into its queue.

Fix (sketch):
```
-	uint32_t waiting = glink_waiting(), length = sizeof(message);
+	uint32_t waiting = glink_waiting();
+	uint64_t length = sizeof(message);
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
 		... glink.broken = true; return;
 	}
```
Also bound the INTENT loop by `length / 8 - 1` rather than `param2`, and consider a per-call iteration cap in the pump so that a DSP that never stops writing cannot hold the lock indefinitely.

### W2 SMEM item extents unchecked: remote-chosen offsets and sizes index the mapping (HIGH, CONFIRMED)

`smem_items()` builds `found[].offset` and `.size` from the entries in the partition. The partition is in shared memory, and the DSP makes item 480 itself when it starts (see the comment at line 2230).
- Bottom entries (lines 571-572): `offset = partition + at + sizeof(entry) + entry.padding_header`, `size = entry.size - entry.padding_data`.
  - Both paddings are `uint16_t` fields from memory.
  - `padding_data > entry.size` makes `size` wrap to about 4 GB.
  - The only bound is `entry.size > header.size` (line 566). Nothing checks that `at + 16 + padding_header + size` stays inside `header.size`, or inside `SMEM_SIZE`.
- Top entries (lines 587-589) have the same `entry.size - entry.padding_data` wrap. Their offset is bounded (`entry.size <= at`).

Consumers trust the result:
- `glink_find()` (line 2312) accepts any `ours_size` or `theirs_size` that is a multiple of 8 and at least 1024. A wrapped `0xfffffff8` passes.
- `glink_waiting()` (line 2349) only compares head and tail with `theirs_size`. Both words are in the DSP-writable descriptor.
- `glink_peek()` (line 2361) reads `smem[glink.theirs + (at + i) % theirs_size]` and `glink_put()` (line 2396) writes `queue[(head + i) % ours_size]`. Neither has any bound against the 2 MB mapping.
- A DSP that publishes item 480 with `size = 0x400, padding_data = 0x408` gets `theirs_size = 0xfffffff8`, then a head word of 0x7ffffff8 is "valid". The next `glink_peek` reads far outside the mapping, which is a kernel data abort (panic). For item 479 (`ours`), `glink_put` writes the kernel's message bytes at the same kind of unchecked offset.
- `smem_poke()` (line 515) has no bound check at all. `step_our_item()` pokes `our_item + 0..340` (line 2059) and `dsp_listen()` and `dsp_ask_to_stop()` poke into `our_item`. `our_item_find()` (line 1603) only checks `size >= sizeof(struct smp2p)`, and for a bottom entry that wrapped, this passes with an offset that can lie past the mapping.

`smem_peek()` itself is safe (it checks `offset + size > SMEM_SIZE`). The unsafe parts are `smem_word()`, `smem_poke()`, `glink_peek()` and `glink_put()`.

Fix (sketch), in `smem_items()` before using `entry`:
```
+	if ((uint32_t)entry.padding_data + entry.padding_header > entry.size ||
+	    at + sizeof(entry) + entry.padding_header + entry.size > header.free_uncached) { break; }
```
For top entries require `entry.padding_data <= entry.size`. Then, in `smem_item()` and `glink_find()`, reject any item with `offset + size > SMEM_SIZE`. Make `smem_poke()` and `smem_word()` check `offset + 4 <= SMEM_SIZE` and return false (or ignore) otherwise.

### W3 QMP mailbox bounds wrap (MEDIUM, CONFIRMED)

- `step_mailbox_open_locked()` line 1480: `if (size < QMP_MESSAGE + 4 || box < 0x3c || box + size > aoss.size || (box & 3))`.
- `step_mailbox()` line 866 has the same check.

`box` and `size` are read from the AOP's message memory (`get()` at 1478-1479). Both are `uint32_t`. `box = 0x100000` and `size = 0xffff0000` sum to 0 and pass. `our_box = 0x100000` is accepted (line 1488 or 1523). `mailbox_send_locked()` then does `rd(aoss.base + our_box)` and 16 `wr(aoss.base + our_box + 4 + 4*i, ...)` (lines 1557-1564). The mapping is 0x400 bytes (line 804). This is a read and write outside the mapping, at an offset chosen by the AOP. In `step_mailbox` it is a read only. The AOP is more trusted than the DSP, but its message memory is remote input all the same.

Fix:
```
-	if (size < QMP_MESSAGE + 4 || box < 0x3c || box + size > aoss.size || (box & 3)) {
+	if (size < QMP_MESSAGE + 4 || box < 0x3c || box > aoss.size || size > aoss.size - box || (box & 3)) {
```
(the same in `step_mailbox`).

### W4 QRTR size check wraps (LOW, CONFIRMED)

Line 2915: `if (header.size == 0 || at + header.size > length)`. Both `at` and `header.size` are `uint32_t`. With a v1 header (`at = 32`) a `header.size >= 0xffffffe0` makes the sum wrap to a small value and the datagram is accepted. For a v2 header `at` is 16..271 and the same holds for `size >= 0x100000000 - at`.
- `receive(context, ..., data + at, header.size)` (line 2948) is called with a length of about 4 GB and a pointer that may run past the packet allocation (the packet is `sizeof(*packet) + fill` bytes).
- The QMI path is protected: `qmi_receive` at `hakios.qmi.c:686` rejects `length > largest + QMI_HEADER_SIZE`.
- `wlfw_receive()` (line 3248) clamps to 64 bytes, so it over-reads at most 64 bytes of adjacent heap into `wlfw_answer_bytes`. Only step 14 with `wifi_ask=1` prints it (line 3520).
- For control messages, line 2935 copies `min(header.size, 20)` bytes from `data + at` (up to 20 bytes beyond the packet).

Impact is a small heap over-read from remote-chosen sizes. Fix: `if (header.size == 0 || header.size > length || at > length - header.size)`.

### W5 A crashed DSP is not reported to the driver (MEDIUM, PLAUSIBLE / NEEDS-HARDWARE)

`link_thread()` (lines 3086-3091) prints once when the DSP's "slave-kernel" word has bit 0 ("err-fatal") and keeps pumping. `hakios_wifi_dsp_is_up()` (line 3974) returns `dsp_started && glink.open`, with no fatal state. Nothing stops the driver, or marks the link broken, so `glink_send()` waits 5 s per call and the driver's own threads keep running.

The file's own comment (lines 3332-3339) records that a phone reset without a word when the driver's thread "was then still writing ring pointers into registers that had stopped answering". After an err-fatal the radio's registers are in the same state. Whether that is the same fault could not be settled from the repository: NEEDS-HARDWARE.

Fix (sketch): add a `static volatile bool dsp_dead`, set it in `link_thread` (and in `dsp_listen`) when `DSP_FATAL` is seen, make `hakios_wifi_dsp_is_up()` return false, make `glink_send()` return `ENOTCONN` at once, and ask the driver to stop (`hakios_lx_stop()` from the shutdown path is already in place).

### W6 State shared across threads without a lock (LOW, PLAUSIBLE)

- `smem_item()` (line 604) uses one `static struct smem_item found[256]`, filled and then searched with no lock. It is called from the link thread (`show_crash_reason()` at 3089, and `dsp_words()` while `at == 0`) and from the main thread (`our_item_find()` in `dsp_ask_to_stop()` during shutdown, `glink_reset()`). If two scans overlap, a match in one can return the offset of an entry that the other has overwritten, and `smem_poke()` then writes at the wrong place. Window: a DSP crash message at the same moment as a shutdown, which is narrow. Fix: make `found` a stack or per-caller array, or take `hakios_smem_alloc_lock` around the scan.
- `dsp_words()` caches `at` in a function static (line 657) written by both threads (harmless today because the value is idempotent).
- `link_thread_is` (lines 3035 and 3217) holds a `thread_t` that has been deallocated once the thread has ended. `qrtr_close()` compares `current_thread()` against it to decide whether to wait on `qrtr_calling`. If the address is reused by a new thread, that thread skips the wait and a callback that is running can use a closed port. It is set after `kernel_thread_start` returns, so the first moments are also unprotected. Fix: clear it when `link_runs` goes false.

### W7 Step 16 trusts the firmware's register window (LOW, CONFIRMED)

Lines 3437-3454: `address` (from `hakios_wlfw_registers`, i.e. what the Wi-Fi firmware told over QMI) is bounded only by `<= 0xffffffff`, and `size` only by `>= 3 * RADIO_WINDOW`. The step maps `ml_io_map_unmappable(radio.phys, radio.size, VM_WIMG_IO)` (line 3454), checks nothing about the result, and reads seven words at fixed offsets below `3 * RADIO_WINDOW`. A firmware that reports another physical address makes the kernel read there (a protected region ends the kernel, as the comment at 3384-3395 says). It only runs with `wifi_radio_read=1`. Fix: require `size == 0x200000` (or `<= 0x200000`), `address + size <= 0x100000000`, and a non-zero map result.

### W8 Error-path leaks and unchecked map results (LOW, CONFIRMED)

- `step_image()` lines 1894-1897 return false on a misaligned segment without `ml_io_unmap()` of the 25 MB mapping made at 1889. A step that fails here and is retried leaks address space. Fix: break out and fall through to the unmap.
- `step_header()` allocates one page per start with `kmem_alloc` (line 1832) that is "never freed" (the comment says so), including on every failure path after it. One page per start attempt.
- `glink_offer()` lines 2440-2442: when `our_intents[i].data != NULL` and `size != size`, a new buffer replaces the pointer and the old one is leaked. The size comes from the DSP's INTENT_REQUEST (line 2576), and `our_intent_count` is reset by every `step_link`. Bounded at 24 buffers of 64 KB per link restart.
- `need()` (line 399), `smem_peek()` (line 502), `step_image()` (line 1889) and `step_registers()` (line 3454) use the result of `ml_io_map*` without a check. If the call returns 0 on failure (not verified, see Not checked), the next access is a load from a low address.

### W9 Half-started TrustZone state (LOW, NEEDS-HARDWARE)

- Step 8 ends with TrustZone holding the image header and the memory window (`INIT_IMAGE`, `MEM_SETUP`). If step 9, 10 or 11 then fails before `AUTH_AND_RESET` succeeds, `steps_over()` only shuts down when `dsp_started` (line 4152-4157), so `PAS_SHUTDOWN` is never called for that peripheral. The AUTH failure path (line 2150-2154) tells the AOP "off" but does not call `PAS_SHUTDOWN` either. The file's own history (lines 69-77) says a wrong TrustZone shutdown state stopped the DSP from starting again. Whether TrustZone needs the shutdown after a failed start, as Linux's remoteproc error path does, cannot be told from the sources here.
- `dsp_started` is set only at line 2156, after the SMC returns, a `printf` inside `scm()` (which takes `say_lock` and prints to the console) and the code after it. A panic on another processor inside that window makes `hakios_wifi_quiesce()` return at line 4135 with the DSP running and not stopped. The window is a few milliseconds at most.

Fix (sketch): set a `dsp_starting` flag before the SMC and let `quiesce` and `steps_over` treat it as started; call `PAS_SHUTDOWN` on every failure after step 8 succeeded.

### W10 The end-of-run stop does not wait for the start thread for long enough (LOW, PLAUSIBLE)

`hakios_wifi_stop()` (lines 4107-4109) waits `whole_runs` for 40 s and then goes on regardless. With `wifi=1` the thread can still be inside step 15 (the driver start, calibration alone is 7 s, and the file's own comment documents a 12 s join). Shutting the DSP down under a driver that is still starting is the "registers stop answering" case at lines 3332-3339. Fix: either wait without a bound (the thread's own steps all have bounds) or set a "stop wanted" flag that `whole_thread` checks between steps and `link_stop`/`glink_send` honour.

### W11 Unbounded queue of received packets (LOW, PLAUSIBLE)

In `glink_pump()` lines 2600-2616, a complete DATA message is copied into a `kalloc_data` packet and appended to `glink.first/last`, and the DSP is told DONE_REUSE at once, so it can send again at once. The consumer is the link thread, which can be held in a callback or in `glink_send()` for up to 5 s (line 2701) while the main thread's `glink_send()` also pumps and enqueues. A DSP that streams packets of up to 64 KB (`size > 0x10000` is rejected in `glink_offer`) grows the list without bound during that time. Fix: cap the list (count or bytes) and delay DONE_REUSE until the packet has been consumed.

### W12 Missing load barrier on the DSP's queue (LOW, NEEDS-HARDWARE)

`glink_waiting()` reads the DSP's head with `rd()` (line 2347), and `glink_peek()` then reads the payload with plain byte loads from the same mapping (line 2361). The producer side is ordered (`settle()` between payload and head in `glink_put`, lines 2399-2400), but the consumer has no `dmb ishld` or `dsb ld` between reading the head and the payload. Whether the mapping (`VM_WIMG_WCOMB`) allows the loads to be reordered is not stated in this repository: NEEDS-HARDWARE. Fix: `__asm__ volatile ("dmb ld" ::: "memory")` in `glink_waiting()` after the head read.

### W13 Credentials and identifiers in the log and in boot-args (LOW, CONFIRMED)

- `hakios_wifi_radio_address()` (line 4016) reads the radio's MAC from the boot-arg `wifi_mac`. The comment above `hakios_wifi_network()` (4048-4052) says boot-args "are echoed by the loader and printed with a panic", which is why the passphrase is not one; the same reasoning applies to the MAC (a device identifier). No code in this file reads `fw-wifi/mac`; if the reviewer's brief expects it, it is not here (lines 4001-4007 say the value is "nowhere in these sources"). The log prints only the length of the MAC (line 4039), which is fine.
- `hakios_wifi_network()` prints the lengths of the name and the passphrase (line 4080) and nothing else; `join_given()` zeroes its copy after the join is asked for (4196). The passphrase itself never reaches the log from this file. `userland/build.sh:384` installs `fw/network` with mode 0600.
- A failed join flushes the whole kept log (`say_kept()`, line 4210) into the real log and into the loader's log. That log holds what the driver and the steps said; this file's own lines contain no secrets, and the driver files were not audited for them (`lx_80211.c:24` says only lengths are said).

## Checked and found fine

- `smem_peek()` bound (line 504): `offset` is `uint64_t`, so `offset + size` cannot wrap; every `smem_peek` caller is safe from out-of-range reads. The unsafe parts are listed in W2.
- `smem_partition()` (521-549): the TOC `count` is capped at 64 (3104 bytes of table, within the 4 KB), partition `offset + size` is checked against the TOC, `header.size == entry.size` is required.
- `smem_items()` loop termination: each bottom iteration advances `at` by at least 16 and the loop ends at `free_uncached`, which is bounded by `header.size`; the top loop ends on `at <= free_cached` and on the `entry.size + step_back > at` guard (line 592), so a corrupt partition cannot make it loop. The scan cost is bounded (at most 131072 entries).
- `smp2p_entry()` and every use of `words->valid`: capped at 16. `show_words()` uses `%.16s` and a bounded `snprintf` with a size guard. `dsp_ask_to_stop()`, `dsp_listen()` and `step_our_item()` index `entry[]` only with the capped value, and the poke offsets (at most 336 of 340 bytes) fit the item.
- `show_crash_reason()` (710-726): `text[81]` is zeroed, the copy is `min(size, 80)`, printed with `%s` as an argument (not a format).
- Torn reads of the 340-byte SMP2P item: `smem_peek` copies bytewise, so a snapshot can mix old and new bytes, but no state bit can appear that was not set in the old or the new value, and `memcmp` change detection is only an optimisation.
- Every `say()`, `hakios_wifi_say()`, `hakios_wifi_tell()` and `printf` (macro for `say`) call in this file has a literal format; remote data (DSP names, crash text, SMP2P names, QRTR sizes) is only passed as `%s`, `%u` or `%.16s` arguments. Buffers are 400 bytes with `vsnprintf`, `say_kept()`'s `piece[201]` and its modulo indexing are right, the `kept[]` ring writes are under `say_lock`. The one effect left is that remote text can contain control characters or a fake log line (cosmetic).
- `rd()`, `wr()` and `need()`: every `rd` or `wr` on a block (`ipcc`, `aoss`, `rsc`, `arb_*`, `tlmm`, `apps_smmu*`, `smem_lock`) is preceded by a `get`/`put`/`need` in the same step, and the steps run in order: `wifi_step=N` always runs 1..N, and `needed[]` for `wifi=1` includes step 2 (which maps `ipcc` and `aoss`) before any step that uses them. Offsets checked against block sizes: `RSC_TCS(7) + TCS_COMMAND(15)` fits 0x10000; `ARB_CHANNEL(511)` and `ARB_OWNER(511)` fit 0x1100 and 0x1000; the observer window for channel 511 ends at 0x10000; `GPIO_*` for pins 84-86 fit 0x3000; SMMU `SMR`/`S2CR` for 255 entries fit 0x2000.
- `cmd_db`/RPMh readers: slave counts are capped at 512, offsets stay inside the 128 KB map for the sizes involved, `data_offset + entry->offset + length` is checked against `CMD_DB_SIZE - 0x1000`, `levels[160]` is guarded. (The command database is the boot loader's, not remote-writable at run time.)
- MDT/ELF loading (1312-1385): the size is capped at one page, segment count is 3..16 and `52 + 32 * count <= size`; each loaded segment is checked against the reserved window in 64 bits (`paddr >= WPSS_MEMORY`, `file_size <= memory_size`, `paddr + memory_size <= window end`), so the uint32 `highest` cannot wrap; `image.segment[]` cannot overflow because `count <= MAX_SEGMENTS`; the segment file sizes are compared to the header; `52 + 32 * count + hashes == size` is required; `name[16]` fits `wpss.bNN`. `step_image()` requires 8-byte alignment of start and length, writes only inside the window, reads everything back, and `segment_word()` cannot read beyond `file_size`. Only the first few bytes of `header[0..4]` are read before the size is known to be at least 5 (the file is in the RAM disk; at most a few bytes past a tiny file).
- SCM calls (1724-1755): all arguments are compile-time constants or validated values (`image.size`, `WPSS_MEMORY`, `kvtophys` of a page-aligned single page from `kmem_alloc(KMA_KOBJECT)`), the metadata page is cache-cleaned before the call, a preempted call is retried at most 100 times, errors are checked by every caller.
- Wait and poll loops, with what happens at the timeout: `mailbox_wait` (1 s, link and channel taken down again on each failure), `mailbox_send_locked` (1 s, message taken back), `our_item_make_locked` (1 s, lock not owned so nothing written; the hardware lock is released on every other path), `spmi_read` (2 ms), `radio_space_on` TLB sync (100 ms, returns false before the context is switched on), `step_start` (`wifi_wait`, always bounded by `limit` or `!dsp_started`), `dsp_ask_to_stop` (`bound_ms`), `glink_send` (5000 ms), `step_link` (5 s), `link_stop` (2 s), `doorbells()` (8 iterations), the IPCC drain in `step_start` (8). The only unbounded loop reachable from remote data is W1.
- Shutdown path (`dsp_shutdown`, `hakios_wifi_stop`, `steps_over`, `hakios_wifi_quiesce`): order is driver, wlfw, link, ask-to-stop, TrustZone shutdown, doorbell disable, AOP "off", SMMU context back (only for a DSP started by this kernel, and only after TrustZone has agreed: if the shutdown fails the SMMU is left on, which is the safe choice). The panic path takes no lock and does not rely on a thread (the `leaving` flag), and its waits are loops. A failed `PAS_SHUTDOWN` leaves `dsp_started` true.
- Lock order: `dsp_lock` -> `hakios_aop_mailbox_lock`/`glink_lock` -> `say_lock`; `qrtr_calling` -> `qrtr_lock`/`glink_lock`; no path takes them the other way round. No spinlock is held across a sleep (there are none in this file; sleeps are `delay_for_interval` with mutexes held, which is allowed). `qrtr_close()` waits for a running callback with `qrtr_calling` unless called from the link thread.
- Use after free: `link_thread()` reads `packet->length` while building the `kfree_data` argument, before the free; `link_stop()` frees queued packets under `glink_lock`; QRTR callbacks run under `qrtr_calling`; `our_intents[].data` buffers are never freed (so never dangling); `qrtr_out_packet()` frees after `glink_send` returns (which copies into the queue).
- Uninitialised data: `struct smp2p` copies are fully written by `smem_peek` before use; `qrtr_control` is zeroed before the copy; `mailbox_send_locked` zero-fills its 64 bytes; `show_words`'s `line` is zeroed; `dsp_ask_to_stop()`'s `theirs.flags` printout follows a successful `dsp_words`.
- `glink_pump()`'s other cases: the name copy is bounded (`min(param2, 32)`) and zero-terminated; DATA copies at most the intent's free space (`words[0] <= size - fill` is checked before the copy and `fill <= size` is an invariant); the intent index is checked against `our_intent_count`; `their_intents[]` insertion is bounded to 64; `glink_offer()` caps at 24 intents of at most 64 KB and rejects zero.
- `glink_send()` and `glink_put()` sizes: the message size is bounded against the queue (`EMSGSIZE`), `glink_room()` checks the head and tail from shared memory against `ours_size` (apart from W2), the head is reduced modulo `ours_size`, and a head that is changed between the room check and the use is still reduced.
- `qrtr_out_packet()`: length 1..8192, allocation `sizeof(header) + padded`, and `memcpy` of `length`. Tables (`qrtr_servers[64]`, `qrtr_ports[16]`, lookups[4]) are bounded; a full table drops silently. A DSP cannot make us answer HELLO more than once.
- Boot-arg parsing: `wifi_mac` (lines 4008-4046): at most 32 characters, at most 2 digits per byte, at most 6 bytes, a multicast or all-zero address is refused, `bytes[]` is only copied when valid. `wifi_step` is clamped to `STEPS`; the other numeric args (`wifi_wait`, `wifi_listen`, `wifi_watch`, `wifi_pause`, `wifi_new`) only affect how long a step waits and use 64-bit arithmetic for the time (the one 32-bit product, `seconds * 1000` in `step_qrtr`, wraps only for a boot-arg above about 4 million seconds). `hakios_wifi_option()` returns 0 for anything unknown.
- `hakios_wifi_network()` parsing: bounds are by `end`, an empty line gives 0, CR is trimmed only when present, lengths over the destination size are not copied, a missing second line leaves `lengths[1] = 0`, which fails the 8..63 check. The result is rejected unless the name is 1..32 and the passphrase 8..63.
- SMMU code: `radio_space_find()` bounds `used[256]` and the context against `contexts`; `radio_enter()` indexes page tables by shifted bits, stops at `RADIO_TABLES` (32) and returns false; `radio_map()` bounds the address pool; every `put` into the SMMU is undone by `radio_space_off()` once `radio_space.on` is true.
- DMA coherence: the header page and the radio's page tables are cleaned with `dc civac` and followed by `dsb sy`; the image is written through a write-combining map with a `dsb sy` before TrustZone starts the DSP.

## Not checked

- Everything outside this file: `hakios.lx.c`, `hakios.wlfw.c`, `hakios.qmi.c` (beyond the one bound read), `hakios.sta.c`, `hakios.apple80211.c`, `hakios.adsp.c` (which shares the mailbox lock and the SMEM allocation lock), `hakios_image_file()`, `loader_log_putc()` and the Wi-Fi driver under `wifi/lx/`. Whether any of them logs a key or the passphrase, takes `hakios_wifi_say` in interrupt context (it takes a mutex), or calls `qrtr_close()` from a context that deadlocks with `qrtr_calling`, is open.
- Whether `ml_io_map`, `ml_io_map_unmappable` or `ml_io_map_wcomb` return 0 on failure or panic (W8); how `PE_parse_boot_argn` treats a non-numeric value for a 4-byte buffer (a value like `wifi_file=off` could be read as non-zero); how `thread_terminate(current_thread())` behaves on a kernel thread that is finishing itself.
- Hardware facts: the mapping attribute behind `VM_WIMG_WCOMB` (so the alignment and ordering rules for W12 and unaligned `ldr` on item offsets), register layouts of IPCC, QMP, the PMIC arbiter, the RSC, the SMMU and TZ calling conventions, and whether a stale `STATUS_DONE` in the arbiter's observer can answer a new read early (`spmi_read`, line 1104). Timings stated in comments were not verified.
- Whether TrustZone expects `PAS_SHUTDOWN` after a failed start (W9) and whether the DSP's SMP2P "restart" handshake in `dsp_listen()` matches Linux in every case.
- Modem code (out of scope) and the audio loader beyond the shared-lock declarations.
- No build, run, or runtime test was done.

## Fix status

All edits are in `drivers/wifi/hakios.wifi.c`; nothing was compiled or run. Line numbers are from the file after the edits.

- W1 FIXED: `glink_pump()` (about 2505-2535) sums the message length in a `uint64_t` (`wide`), so OPEN, INTENT and DATA lengths can no longer wrap to 0; the existing `> theirs_size - 8` check now rejects them (queue marked broken), and `length` is narrowed only after that check. This also bounds the INTENT loop. Not done: a per-call iteration cap in the pump (design change).
- W2 FIXED: `smem_items()` ends the walk for an entry with `padding_data > size` or one that reaches past `free_uncached` (bottom), or `padding_data > size` (top); `glink_find()` requires the descriptor and both queues to lie inside the 2 MB mapping; `smem_poke()` and `smem_word()` ignore/return 0 for an offset outside the mapping or while it is not mapped.
- W3 FIXED: the mailbox check is now `box > aoss.size || size > aoss.size - box` in both `step_mailbox()` and `step_mailbox_open_locked()`.
- W4 FIXED: `qrtr_input()` checks `header.size > length || at > length - header.size` instead of the wrapping sum.
- W5 SKIPPED: the fix is a new "dead" state that stops the driver and changes what `glink_send()` and `hakios_wifi_dsp_is_up()` return; it is a design change, and what the radio does after err-fatal needs hardware.
- W6 PARTLY FIXED: `link_thread_is` is cleared when the link thread ends. SKIPPED: the shared `static found[256]` in `smem_item()` (a mutex cannot be used, because the panic path calls it with no lock taken; a 3 KB stack array needs a decision on stack use), and the `dsp_words()` static `at` (idempotent).
- W7 FIXED: step 16 requires `size <= 4 * RADIO_WINDOW` (2 MB) and `address + size <= 4 GB`, and returns false if the map result is 0.
- W8 PARTLY FIXED: `step_image()` unmaps the 25 MB window on the misaligned-segment return and returns false if the map is 0; `glink_offer()` frees a kept intent buffer of another size before replacing it; `smem_peek()` and `step_registers()` check the map result. SKIPPED: the page of `step_header()` that is "never freed" on purpose (TrustZone may still use it; whether it can be freed needs hardware knowledge), and `need()` (it returns void and its callers cannot handle a failure; whether `ml_io_map` can return 0 is not known).
- W9 SKIPPED: needs knowledge of what TrustZone expects after a failed start, and a new "starting" state (design change).
- W10 SKIPPED: waiting without a bound or a "stop wanted" flag changes the shutdown flow (design change).
- W11 SKIPPED: capping the list and delaying DONE_REUSE changes the protocol flow (design change); a plain cap would drop packets.
- W12 SKIPPED: whether the WCOMB mapping reorders the loads is hardware behaviour, and a barrier there is a memory-ordering decision.
- W13 SKIPPED: reading the MAC from somewhere other than a boot-arg is a new feature, and the logged lengths of the name and passphrase are deliberate and documented in the comments (they help to diagnose a bad `fw/network`); no secret reaches the log.

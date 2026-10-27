# Driver review: input and touch

## Scope and method

Read-only audit; this is the only file written.

| File (under xnu/files/bsd/) | Lines | Read |
|---|---|---|
| dev/hakios.input.c | 228 | all |
| dev/hakios.goodix.c | 1515 | all, except the array in hakios.focaltech_fw.h (only its header: `FOCALTECH_FW_LENGTH 116448`, declared as `focaltech_fw[FOCALTECH_FW_LENGTH]`) |
| dev/hakios.buttons.c | 583 | all |
| dev/hakios.virtio_input.c | 365 | all |
| sys/hakios.input.h | 125 | all |

Method: traced the producer path (goodix/focaltech/buttons/virtio thread -> `hakios_touch_post` -> `touch_queue` -> `touch_read` -> `uiomove`), every length that comes from a chip, the SPI engine, the command database or the firmware blob, every polling loop, every boot-arg. Cross-checked the shared hardware (RPMh TCS 0, GCC vote register, SPMI arbiter) against the other drivers in `dev/` by grep. The XNU kernel source itself is not in this tree, so behaviour of kernel primitives (`ml_io_map`, `delay_for_interval`, `uiomove`, `PE_parse_boot_argn`) is assumed to be standard. Nothing was built or run. No hardware facts are asserted beyond what the repository's own comments say.

Confidence: CONFIRMED = path traced end to end in the source; PLAUSIBLE = mechanism is in the source but depends on timing or an input I cannot show occurs; NEEDS-HARDWARE = the code is as described but the effect depends on chip behaviour.

## Findings

| Id | Severity | Confidence | Where | One line |
|---|---|---|---|---|
| F1 | Medium | PLAUSIBLE | goodix.c:203-239 | `rpmh_write` uses RPMh TCS 0 without `hakios_rsc_lock`, which adsp.c and mpss.c take for the same TCS |
| F2 | Medium | CONFIRMED (effect NEEDS-HARDWARE) | goodix.c:1353 | `io_supply_on()` result ignored; analog supply and pins are driven anyway, and a failed bring-up leaves everything powered |
| F3 | Medium | CONFIRMED | input.c:213 | `/dev/hakios-touch` is mode 0666: any process can forge touches and buttons (including Lock) and read everyone's touches |
| F4 | Low | CONFIRMED | input.c:170-176 | A record is dequeued before `uiomove`; a failed copy-out loses it |
| F5 | Low | CONFIRMED | input.c:162-181 | `read()` with fewer than 24 bytes blocks for data, then returns 0 (EOF) without consuming anything |
| F6 | Medium | CONFIRMED (absence); effect NEEDS-HARDWARE | goodix.c:1155-1161 | FocalTech firmware download is bounded but never verified before the application is started |
| F7 | Low | PLAUSIBLE | goodix.c:1222-1227 | FocalTech coordinates are not clamped before mirroring: x above max-1 underflows |
| F8 | Low | PLAUSIBLE | virtio_input.c:260-263 | No load barrier between reading `used->idx` and reading the ring entry and event |
| F9 | Low | CONFIRMED | virtio_input.c:286-312 | Page from `kmem_alloc` leaked, device left half-initialised, on the two failure returns |
| F10 | Low | NEEDS-HARDWARE | goodix.c:1410-1419 | Bit-bang fallback's second attempt drives the pin that the first attempt used as input |

Counts: 6 CONFIRMED (F2, F3, F4, F5, F6, F9), 3 PLAUSIBLE (F1, F7, F8), 1 NEEDS-HARDWARE (F10). No memory-safety bug (out-of-bounds, overflow, info leak) was found in the queue or in the SPI buffers; see "Checked and found fine".

## Details

### F1. RPMh TCS 0 used without the shared lock (goodix.c:203-239)

`rpmh_write()` programs command slots in TCS 0 of the application processor's DRV2 (`TCS(reg)` is `rsc + 0xd00 + reg`, goodix.c:122), with no lock. hakios.adsp.c programs the same TCS 0 (`RPMH_TCS 0`, adsp.c:821, 912-937) and mpss.c does too (mpss.c:899-937, 959-991), and both take `hakios_rsc_lock` (defined at wifi.c:192) for exactly this reason (the comment at wifi.c:192 and adsp.c:112 says the sequencer is shared). goodix.c does not reference `hakios_rsc_lock` anywhere.

Scenario: `hakios_input_init()` starts the goodix thread (input.c:219) before adsp/modem init (input.c:226-227). The goodix thread calls `io_supply_on()` -> `rpmh_write()` at the start of `bring_up()`. If the audio-DSP or modem thread reaches its own `rails()` request while that is in flight, the two threads interleave writes of MSGID/ADDR/DATA, ENABLE and TRIGGER on one TCS. The worst outcome is a request mixing one driver's address with the other's data on a power rail (lcx/lmx level, or ldoc2 voltage). The window is short (the goodix request happens within milliseconds of the thread's start), so the likelihood depends on how soon the other threads get that far: PLAUSIBLE.

Fix:
```
+extern lck_mtx_t hakios_rsc_lock;
 static bool rpmh_write(...) {
+	lck_mtx_lock(&hakios_rsc_lock);
 	...
-	return done;
+	lck_mtx_unlock(&hakios_rsc_lock);   /* and on the early "stay busy" return */
+	return done;
```
(`<kern/locks.h>` is needed; goodix.c does not include it today.)

### F2. I/O supply failure ignored; failed bring-up leaves hardware on (goodix.c:1348-1357, 1454-1458)

`power_on()` calls `io_supply_on();` and discards the bool (line 1353). That function returns false when the command database has no `ldoc2` (goodix.c:250-253) or when the TCS stays busy or the request times out (rpmh_write). The code then switches the analog supply on (`gpio_output(PIN_AVDD, true...)`, line 1355), configures the reset and interrupt pins as driven outputs/pull-ups (1351-1352), and goes on to drive SPI pins towards a chip whose I/O rail may be off. Whether back-powering or damage can occur is NEEDS-HARDWARE; the ignored error is CONFIRMED.

Related error path: when `bring_up()` fails the thread prints and calls `thread_terminate` (1454-1458) with AVDD still high, the GCC clock votes still set, and the five `ml_io_map` mappings (1448-1452) never released. Small and one-time, but the chip is left powered with no driver.

Fix:
```
-	io_supply_on();
-	sleep_ms(3);
+	if (!io_supply_on()) { return false; }   /* make power_on() return bool; bring_up() then reports and returns false before touching AVDD */
```
and, in the failure path, drive `PIN_AVDD` low and clear the votes.

### F3. Device node is world read/write (input.c:213)

`devfs_make_node(..., UID_ROOT, GID_WHEEL, 0666, "hakios-touch")`; `touch_open` (143-147) does no check. Any process that can open the node (subject to whatever sandbox the iOS userland applies; not examined here) can:
- `write()` records: forged DOWN/MOVE/UP samples and `HAKIOS_BUTTON_DOWN/UP` with `finger = HAKIOS_BUTTON_LOCK`, which backboardd turns into the power key (inject.c:871-879). Only the five-finger exit is protected (it counts driver fingers only, input.c:130).
- `read()`: steal the real touch stream (any reader takes records away from backboardd, since there is one shared queue with no exclusive open).

Whether this matters depends on the iOS sandbox profile for third-party apps; in the kernel there is no restriction.

Fix: `0600` (or `0660` with a dedicated group) and, if backboardd runs as another user, set that uid/gid in `devfs_make_node`; optionally make `touch_open` return `EBUSY` for a second opener.

### F4. Record lost when copy-out fails (input.c:170-176)

```
t = touch_queue[touch_head++ % TOUCH_QUEUE];
lck_mtx_unlock(&touch_lock);
error = uiomove((caddr_t)&t, sizeof(t), uio);
```
`touch_head` is advanced before the copy. If `uiomove` fails (a user buffer that is partly unmapped, or one the process unmaps concurrently), the sample is gone; if `moved > 0` the function returns 0 and the failure is invisible. A lost UP or DOWN leaves the consumer's finger state stale (inject.c:818-821 ignores non-DOWN events for fingers it believes are up, and keeps a finger down until an UP). Same effect, from the producer side, when the 512-record ring overflows: `touch_head++` at input.c:115-117 drops the oldest record whatever its type. That second case is by design ("nobody reads") and only noted.

Fix: peek first, advance after success (single-reader assumption) or push the record back:
```
-	t = touch_queue[touch_head++ % TOUCH_QUEUE];
+	t = touch_queue[touch_head % TOUCH_QUEUE];
 	unlock; error = uiomove(...); lock;
-	if (error) break;
+	if (error) break;
+	touch_head++;     /* only if it is still the same record: with two readers, re-check head */
```

### F5. Short read returns EOF (input.c:162-181)

The first loop waits until the queue is non-empty regardless of the buffer size. The second loop requires `uio_resid(uio) >= sizeof(t)` (24). With a buffer of 1..23 bytes, `read()` blocks until a sample exists, then returns 0 with nothing consumed, which a caller reads as end of file; callers that retry spin at 100% CPU because the queue stays non-empty. The shipping consumer reads exactly 24 bytes (inject.c:950), so there is no current victim.

Fix: at entry `if (uio_resid(uio) < (user_ssize_t)sizeof(struct hakios_touch)) return EINVAL;`.

### F6. Touch-controller firmware download is bounded but not verified (goodix.c:1101-1124, 1155-1161)

What is bounded: `focaltech_write_pram()` loops `offset < len` in 32-byte chunks, with the last chunk shortened (1106-1110); `len` is `FOCALTECH_FW_LENGTH` (116448, a multiple of 32), the array is declared with exactly that size, and the transfer buffer (71 bytes) holds the largest frame (7 + 32). The 24-bit PRAM address in `addr_bytes` cannot wrap (116448 < 2^24). The sequence is only entered after `focaltech_enter_boot_rom()` has read back the boot ID 0x56 0x62 with a valid CRC (1076-1094).

What is missing: nothing checks the blob or what the chip received before `focaltech_start_app()` makes the boot ROM jump to it (1161). There is no checksum/length/magic check of `focaltech_fw` against a value fixed at build time, no read-back or on-chip check of the written PRAM, and the only per-chunk check is the status byte `rx[3] & 0xa0` (focaltech_write 1000-1001), which is the busy/CRC-error bit of the transfer, not of the content. A corrupted source blob or a dropped/duplicated chunk (retried up to 3 times by `focaltech_write`) is started as is. This download also runs automatically on every cold start where the runtime ID is not yet valid (1144-1167), and again up to three times in total if bring-up falls back to the pin-driven bus (chip_probe is re-run, 1402-1420).

Whether this PRAM download can leave a persistent bad state in the chip's flash is not answerable from the sources here: NEEDS-HARDWARE. The comments (1096-1100) describe it as a RAM upload only.

Fix: generate a CRC-32 (or SHA-256) of the blob next to `FOCALTECH_FW_LENGTH` in hakios.focaltech_fw.h and compare before the first write:
```
+	if (crc32(0, focaltech_fw, FOCALTECH_FW_LENGTH) != FOCALTECH_FW_CRC) { printf(...); return false; }
```
and, if the boot ROM offers a checksum command (the vendor flow does, per its own source; I did not verify here), run it before `focaltech_start_app()`.

### F7. FocalTech coordinates not clamped before mirroring (goodix.c:1222-1227)

`x` is built from a 15-bit field (up to 32767, goodix.c:1265-1268) and the panel size is 10800 (1246). The code's own comment (1191-1192) calls the values 15-bit sub-pixel values. In `focaltech_contact_update` there is no clamp: with `touch_flip` 1 or 3, `x = max_report_x - 1 - x` wraps to about 4.29e9 when `x > 10799`, and `(uint64_t)x * 65535 / 10799` truncated to `uint32_t` is an unrelated number; `touch_post` only clamps values above 65535, so the touch can land anywhere. Without flip, the result exceeds 65535 and is clamped, so only the flip case is wrong. The Goodix path does clamp (`x >= max_x ? 65535 : ...`, line 819). Whether the chip ever reports above the panel size is NEEDS-HARDWARE, hence PLAUSIBLE.

Fix: `if (x > max_report_x - 1) x = max_report_x - 1;` (same for y) before the `switch (flip)`.

### F8. Missing load barrier on the virtio used ring (virtio_input.c:260-263)

```
while (d->seen != *(volatile uint16_t *)&d->used->idx) {
	uint32_t id = d->used->ring[d->seen++ % QUEUE_SIZE].id % QUEUE_SIZE;
	input_event(d, &d->events[id]);
```
The loads of `ring[]` and of `events[id]` are not ordered after the load of `idx` (the ring address depends on `d->seen`, not on the idx load; a control dependency does not order loads on arm64). The return path does have `dmb ish` before `avail->idx++` (265-267). Effect: on a host where the device model runs on another core with weak ordering (QEMU under KVM/HVF), a stale ring entry or event can be read, giving a repeated or wrong sample. Not reproduced; PLAUSIBLE. QEMU-only code (boot-arg `virtio_input=1`).

Fix: `__builtin_arm_dmb(0x9);  /* ISHLD */` after the `idx` read inside the loop, before touching `ring`/`events`. (The ring's `id` is already reduced `% QUEUE_SIZE`, so a bad value cannot index out of `events`.)

### F9. Page leak and half-initialised device on attach failure (virtio_input.c:286-312)

`input_attach` takes a page (286), then returns false at 305 ("features refused") and 312 (queue too small) without `kmem_free` and without resetting the device status (it stays at `FEATURES_OK` or lower, never `FAILED`). The caller just skips the slot (354). Cost: one 4 KiB page per failing slot, at boot, under QEMU only. Fix: `kmem_free(kernel_map, page, PAGE_SIZE); reg_write(d, VIRTIO_STATUS, 0x80);` before each `return false`.

### F10. Bit-bang fallback may drive a chip output (goodix.c:1410-1419)

If the serial engine path gets no answer, the driver tries twice by hand: first MOSI=gpio53 out / MISO=gpio52 in, then the reverse, because "which of the two data pins is the input is not written down anywhere" (its own comment). On the second attempt `bitbang_init()` configures gpio52 as a driven output (1413-1415, 565-568). If gpio52 is the chip's MISO output, two drivers fight on one line; the comment at lines 80-83 names 52 as MISO. Duration is short (one probe) but nothing limits the current beyond pin drive strength set at 6 mA. NEEDS-HARDWARE. Fix: probe the second orientation only with the former output pin as a pulled input and read-only for one cycle, or drop the swap now that the pin roles are documented in the same file.

## Checked and found fine

Queue and user space (hakios.input.c, hakios.input.h):
- `struct hakios_touch` is 8+4+4+4+4 = 24 bytes, natural alignment, no padding. Every queue slot is fully written in `touch_post` (time, type, finger, x, y) before it is published under `touch_lock`; the static array is zero-initialised. `touch_read` copies a stack copy of one whole record: nothing uninitialised reaches user space.
- Ring arithmetic: `TOUCH_QUEUE` is 512, `head`/`tail` are `uint32_t` free-running counters, indexed `% 512`; 2^32 is a multiple of 512, so wrap-around is exact. `tail - head == 512` is the full test and is correct across wrap; overflow drops the oldest, never writes past the array.
- Locking: all `head`/`tail`/`fingers_down` accesses are under `touch_lock` (mutex); `msleep` releases it atomically so there is no lost wakeup; `wakeup` after unlock is fine. `touch_post` takes a mutex and calls thread_call APIs: it must not be called from interrupt context, which the header says, and none of the producers (goodix thread, buttons thread, virtio thread_call) does.
- `touch_write` validates `type` in 1..5 before posting and clamps x, y to 65535 in `touch_post`; `finger` is unbounded in the queue but `count_fingers` ignores `finger >= 32` and driver-only posting is required for the exit combo; the consumer bounds `f >= MAX_FINGERS` (inject.c:818).
- `count_fingers`: shifts guarded by `finger >= 32`; `thread_call_enter_delayed`/`cancel` under the lock are safe; `exit_call` is allocated before any driver starts (input.c:216-219).
- `latency_lines()` is only called with the lock held; `hakios_tl` uses a 192-byte buffer with `vsnprintf`.

Goodix chip path:
- `goodix_read`/`goodix_write` reject lengths above 1024; `spi_tx`/`spi_rx` are 8+1024 bytes and the largest frame is 8+1024 / 5+1024. All callers pass constants or values bounded before the call.
- `goodix_probe`: the chip-supplied description length is checked (`40 <= length < 1024`) before the second read; the five-list walk checks `offset >= length` before each `info[offset]`; the following reads at `offset+44..47`, `offset+122+16..19` are guarded by `offset + 48 + 2 <= length` and `offset + 122 + 20 + 2 <= length`; the version string prints use precision (`%.6s`, `%.8s`) on a non-terminated 28-byte buffer, and the offsets stay inside it. The 16-bit-sum check is weak, but the addresses taken from it (`touch_address`, `command_address`) are only used as SPI register addresses of the chip itself.
- `goodix_poll`: `report` is 90 bytes; the first read is 26, the second `8 + 8*count + 2` with `count <= 10` (guard at line 862), maximum 90; `count` 11..15 is refused at line 885 after the header checksum. The ack write is a single zero byte.
- `goodix_report`: finger id >= 10 skipped; `x * 65535 / max_x` cannot overflow `uint32_t` because `x < max_x <= 65535` is tested first; `max_x`/`max_y` come from `le16` and are only adopted if non-zero.
- `goodix_command`: fixed 16-byte buffers, 6x6 bounded attempts, and `command_address == 0` is rejected.
- `geni_transfer`: 200 ms deadline; busy-wait before start bounded (2000 x 100 us, then cancel/abort in `geni_recover`, itself bounded to 2 x 2000 x 100 us); `geni_drain` never writes beyond `length` (guarded by `*received < length`), and the unsigned underflow of `bytes` when `words == 0` is not used because the loop runs zero times; transfer lengths (<= 1032) fit the 24-bit TRANS_LEN registers; `fifo_depth >= 4` is checked before `fifo_depth - 3`, `- 2`.
- Other polling loops all have counters: `rpmh_wait` (2000 x 100 us), the TCS-idle wait (2000), GCC clock wait (1000 x 10 us), SE clock configuration wait (500 x 10 us), `focaltech_wait_valid` (5 x 200 ms), `focaltech_enter_boot_rom` (3 attempts), `focaltech_read` (3 attempts), `goodix_command` (36 looks). The main loop is intentionally endless and sleeps `poll_us` per tick.
- `rpmh_address`: the check `header_offset >= CMD_DB_SIZE - 0x1000` is vacuous for a `uint16_t`, but the largest possible access is 0x90 + 0xffff + 512 x 24 = 0x13090, inside the 0x20000 mapping, so there is no out-of-range read from a corrupt database. `count > 512` is skipped.
- `rpmh_write` is only called with `count == 3` and 3-element arrays; `(1u << count) - 1` is in range.
- `rcg_rate`: 64-bit intermediate, `cfg >> 8 & 7` indexes an 8-entry table, division guarded by `if (n)`.
- Global `GCC_VOTE` (gcc + 0x52008) is only touched by this driver in the tree (grep over `dev/hakios.*.c`), so the read-modify-write at 310/340 has no other writer. The TLMM per-pin registers used here are not used by other drivers for these pins (not exhaustively checked for every pin number).
- Boot-args: `touchscreen` (1508), `touch_flip` (1511, a mask or a switch value with no out-of-range effect), `touch_poll_us` (range-checked 250..100000 else 8000; `1000000 / poll_us` and `80000 / poll_us` cannot divide by zero; `idle_looks` becomes 0 above 80000 us, which means "look every tick", harmless), `touch_spi_hz` (100 kHz..10 MHz else 1 MHz; the 12-bit divider cannot overflow for the sources this code can pick, <= 600 MHz / 100 kHz = 6000 would, but the chosen source is the lowest preset >= 4 MHz or the crystal, so in practice <= 192), `touch_rate` (only the value 480 acts), `touch_lat`, `touch_flip`. All use `PE_parse_boot_argn` with a 4-byte target.
- FocalTech: `focaltech_read` length bounded by `transfer_length > sizeof(focaltech_tx)` (callers pass 1, 2 or 62; the check could wrap for `length` near 2^32, but no caller can pass that); `focaltech_report` reads at most `report[2+6*9+4] = report[60]` of the 62-byte buffer; the read is CRC-checked before use; `focaltech_write_pram` frames never exceed 7+32. The boot-ROM entry is gated on reading back the boot ID, so the firmware blob is not sent to a chip that does not answer as the FT3680 boot ROM (this is also what protects a Goodix phone if the strap detection is wrong).

Buttons (hakios.buttons.c):
- `spmi_read` takes `count` 1..8 from constant callers (1, 2, 8) and writes `bytes[i]` for `i < count` into buffers of matching size (`is[2]`, `r[8]`, `c[8]`, `&status`); `data[1]` is read only for `count > 4`.
- Channel numbers come from the arbiter's table (`n < channels <= 512`); `ARB_CHANNEL(n)` max 0x10fc < `ARB_CORE_SIZE` 0x1100, `ARB_OWNER(n)` max 0xefc < 0x1000, observer offset `0x80 * 511 + 0x1c` < 0x10000. The version is checked (`>= 5`, `< 7`) before anything else is read.
- The SPMI spin lock is held for at most the 2 ms read timeout, with only MMIO and `mach_absolute_time` inside; nothing sleeps under it. Lock order: `spmi_lock` is a leaf; `touch_lock` is taken after it is dropped.
- Only register reads go to the PMICs (as the file comment says); the single write is the arbiter's command word.
- State (`power`, `volume_*`, `bus`) is touched by the one buttons thread only. `status & PON_KPDPWR` converts to `bool` by non-zero test, so 0x80 is true.
- The "held at start is not believed until seen released" logic matches the comments; the thread ends with `thread_terminate` on all paths.

virtio_input.c:
- `used->ring[...].id % QUEUE_SIZE` bounds the event index; `seen`, `avail->idx` are `uint16_t` and 65536 is a multiple of 64, so wrap-around is exact; the `avail` update has a `dmb ish` before the index bump and one before the notify.
- `command_key`: `name[32]`, `length < 31` guard, NUL written at `name[length]` with `length <= 31`; the key table index is checked against `sizeof(plain) - 1`; the keyboard-typed name is only passed to `ustacks_now` through `%s`/a string argument.
- Static state (`name`, `shift`, ...) is shared by the up-to-four devices but only touched from `input_poll`, which re-arms itself after finishing, so it never runs concurrently with itself.

## Not checked

- Anything outside the five files: the consumer side (userland/src/inject.c) beyond the finger bounds check; `loader_log_line`/`loader_log_putc` (whether they are safe to call while holding `touch_lock`, input.c:124); `loader_return()` and what happens to the endless polling thread when the run ends (the touch thread has no stop flag and keeps polling hardware: goodix.c:1472-1499).
- The kernel's behaviour for `ml_io_map` failure: all `ml_io_map` results are used unchecked (goodix.c:1448-1452, buttons.c:458-460, virtio_input.c:342). Whether it can return 0 here needs the XNU source.
- Any register layout, timing or strap meaning (TLMM, GCC, GENI, RPMh, SPMI arbiter, Goodix Berlin command format, FocalTech boot ROM protocol, PIN_GOODIX_ID/PIN_FOCALTECH_ID being valid for this board) beyond internal consistency with the repository's comments.
- Whether a Goodix finger lift is always reported as a status with the touch bit and zero count: if the chip instead reports status 0, `goodix_poll` returns at line 857 without posting UP and the finger stays down. NEEDS-HARDWARE; a hand test is noted in the buttons comment but not for this.
- The content of `focaltech_fw` (706 KB array) and its provenance.
- Whether the PRAM download can touch persistent flash, and whether the vendor flow's own integrity step exists in the boot ROM.
- The iOS sandbox profile for `/dev/hakios-touch` (F3 impact).
- Build correctness (flags of `kmem_alloc`, `__builtin_arm_dmb` use) and the other drivers in the tree, other than reading the lines named above for `hakios_rsc_lock`.

## Fix status

Edited: drivers/input/hakios.goodix.c, hakios.input.c, hakios.virtio_input.c. Nothing was compiled or run; every edit was re-read for syntax and types.

- F1 FIXED. goodix.c: `rpmh_write()` now takes `hakios_rsc_lock` (extern declared next to the other externs, `<kern/locks.h>` included) before the first TCS 0 access and releases it on the busy return and at the end. Same lock the audio DSP and modem drivers take; the lock is a leaf here (nothing else is taken while it is held), so no ordering problem. The mutex is held across `sleep_us`, exactly as adsp.c does.
- F2 FIXED (the ignored error). goodix.c: `power_on()` returns bool and `bring_up()` stops with a message before AVDD or any bus work if `io_supply_on()` fails. NOT done: driving AVDD low and clearing the GCC clock votes when a later bring-up step fails. Power-down order and clock-vote semantics are hardware knowledge; SKIPPED for that part.
- F3 SKIPPED. Mode 0666 of /dev/hakios-touch is policy and was explicitly not to be changed.
- F4 FIXED. input.c `touch_read()`: if `uiomove` fails, the dequeued record is put back at the head (only if the ring still has room, so it can never overwrite a live slot).
- F5 FIXED. input.c `touch_read()`: a zero-length read returns 0, a read of 1..23 bytes returns EINVAL instead of blocking and then returning EOF. Reads of 24 bytes or more behave as before.
- F6 SKIPPED. A checksum of the FocalTech firmware needs a value generated at build time for hakios.focaltech_fw.h (not a file I may edit) and, for an on-chip check, knowledge of the boot ROM protocol that cannot be established from the repository.
- F7 FIXED. goodix.c `focaltech_contact_update()`: x and y are clamped to `max_report - 1` before the flip, so the mirroring cannot underflow. In range values and the unflipped case are unchanged (an out-of-range value was already ending at 65535).
- F8 FIXED. virtio_input.c `input_poll()`: `__builtin_arm_dmb(0x9)` (ISHLD) after the `used->idx` check, before the ring entry and the event are read.
- F9 FIXED. virtio_input.c `input_attach()`: both failure returns now write STATUS_FAILED (0x80, new define) to the device and `kmem_free` the page. The device was never given the queue on those paths.
- F10 SKIPPED. Which of gpio52/gpio53 is the chip's output is hardware knowledge, and dropping or changing the probe order is a behaviour decision for the owner.

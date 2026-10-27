# Driver review: sound path (speakers, microphone, /dev/hakios-audio)

Read-only audit; nothing was built, run or changed except this file.

## Scope and method

Files (all under `xnu/files/bsd/dev/` unless noted):

| file | lines |
|---|---|
| hakios.audio.c | 354 |
| hakios.sound.c | 1518 |
| hakios.speaker.c | 1211 |
| hakios.mic.c | 1847 |
| hakios.virtio_sound.c | 406 |
| `userland/src/audio_plugin.c` (writer/reader side, volume control) | 1041 |

Also read because the sound path depends on them (not in the group, so only the parts the sound path uses):
`xnu/files/bsd/sys/hakios.audio.h`, `hakios.guard.c` (the guard that limits what the amplifiers get), and in `hakios.adsp.c`
only `root_file()`/`hakios_adsp_fw_file()` (loader of aw882xx_acf.bin) and `apr_input()`/`hakios_adsp_apr()`.

Method: whole-file reading of the five kernel files and the I/O and volume parts of the plug-in; each finding traced from
the input (user write/ioctl/read, file contents, DSP event, boot-arg) to the faulty operation. Tracing of arithmetic was
done by hand (uint32 wrap points worked out with concrete numbers). Nothing was executed, and the real
aw882xx_acf.bin is not in the repository, so file-driven findings are traced against the parser only.
Hardware facts (register layouts, what level is safe for the amplifier) are not asserted; where a consequence
depends on them the finding says NEEDS-HARDWARE.

Severity is about the effect if the trigger happens; confidence is as defined in the task (CONFIRMED = path traced end to end).

## Findings

| id | severity | confidence | file:line | one line |
|---|---|---|---|---|
| S-01 | High | CONFIRMED (effect on hardware: NEEDS-HARDWARE) | audio.c:268, sound.c:1267/1272/1279, speaker.c:897-941, guard.c:160 | unclamped user `below` can make the volume fade loop spin forever at Android's loudest level while the guard is told "amplifiers off" |
| S-02 | Medium | CONFIRMED | audio.c:268, sound.c:1267/1279 | `below + extra` wraps: any local user can lift the level to Android's maximum, past `sound_below` |
| S-03 | Medium | CONFIRMED | speaker.c:478-479, 484, 495 | monitor-table bounds check done in uint32: crafted ACF makes the row pointer go up to 3.5 GB out of the file buffer |
| S-04 | Medium | PLAUSIBLE | speaker.c:688-696, 1033-1065, sound.c:1346 | `hakios_speaker_stop()` gives up on the first failed I2C read, leaves both amplifiers up, and its caller then stops the TDM clock |
| S-05 | Medium | PLAUSIBLE | speaker.c:623-646, 1068-1080 | `power_down_now()` clears `started` even when its power-down write was not acknowledged; the panic quiesce then skips the amplifier that is still on |
| S-06 | Medium | CONFIRMED | mic.c:1737-1778 | mic=4: a bring-up that fails without setting `broken` is retried forever (no failure count), re-toggling the codec reset and the DSP votes |
| S-07 | Low | CONFIRMED | sound.c:635, 693-706 | page tables for the DSP's SMMU context are allocated at every `space_on()` and never freed (12 KB per recording in mic=4) |
| S-08 | Medium | PLAUSIBLE (mode CONFIRMED; reach depends on iOS sandbox) | audio.c:343, mic.c:1732, 1524-1534 | both device nodes are 0666; any process can start the microphone, steal/split its samples, set the volume or mute; open state is a flag, not a count |
| S-09 | Low | PLAUSIBLE | mic.c:719, 727 | SoundWire read id cycles through 0; an empty (zero) FIFO word matches id 0 and is returned as a successful read of 0 |
| S-10 | Low | NEEDS-HARDWARE | mic.c:704-710 | `swr_write()` waits for FIFO room at most 10 ms and then writes anyway; the result is always `true` |
| S-11 | Low | NEEDS-HARDWARE | sound.c:719, mic.c:1614-1617 | DSP-written mic buffer is only invalidated after the DSP has used it; dirty zero-fill lines are never cleaned first |
| S-12 | Low | PLAUSIBLE | virtio_sound.c:249-251 | used-ring entry read without a load barrier, and its `id` trusted as an index into `tx_free[]`/the shared area |
| S-13 | Low | CONFIRMED (file outside this group) | hakios.adsp.c:2488-2495 | `payload` underflows when the DSP's `header.size` < header length; 256 bytes are then copied from beyond the packet |
| S-14 | Low | PLAUSIBLE | audio_plugin.c:282, 788-793 | a NaN volume passes the clamp, `lround(NaN)` gives `below` 0 and `muted` 0: loudest |
| S-15 | Low | CONFIRMED | sound.c:1195-1199, mic.c:1644 | a period whose submission to the DSP fails is never re-submitted: the stream starves one period at a time |
| S-16 | Low | CONFIRMED | mic.c:1597 | mic=1..3 `listen(false)` ignores `stopping`: `hakios_mic_dsp_down()` can block for `mic_secs` (up to 600 s) |

## Details

### S-01  High  CONFIRMED (hardware effect NEEDS-HARDWARE)

Unclamped `below` from user space reaches `hakios_speaker_volume()`, whose fade loop can never finish, and it also makes the guard think the amplifiers are off.

Chain:

1. `audio.c:268` `volume_below = volume->below;` ioctl `HAKIOS_AUDIO_SET_VOLUME` stores any uint32; the node is mode 0666 (`audio.c:343`), no privilege test, no range test.
2. `sound.c:1253-1272` (watch thread) takes it as `extra` and does `guard_level(below + extra)` (1272) and `hakios_speaker_volume(below + extra, 1)` (1267, 1279). `below` is `sound_below`, default 240. The sum is uint32 and wraps.
3. `speaker.c:897` and `:914`: `uint32_t target = a->volume_at + below;` wraps again. Take `extra = 0xFFFFFF0F` (so `below + extra = 0xFFFFFFFF`): `target = volume_at - 1`, which is *below* `volume_at`. With the profile's level (the header comment says Android's is -2.1 dB, so `volume_at` is about 17, never 0) the clamp `if (target > VOLUME_LOWEST)` does not trigger.
4. `speaker.c:919` `if (a->volume == target) continue;` can never be true: `set_volume()` (707-709) raises every request to `volume_at`, so `a->volume` bottoms out at `volume_at` and `target` stays under it. The `for (;;)` at 909 sees `moved = true` forever: one I2C write plus read-back and a 1 ms wait per round, two log lines each. There is no `stopping` check and, with `step_ms = 1`, not even the status check (928 needs `step_ms >= 10`). The watcher thread is stuck, so no silence timeout, no fault polling and no `hakios_speaker_stop()` happens. Only `take_down()` at the run's end breaks it, because it calls `hakios_speaker_stop()` after 3 s and a failed/`broken` write makes the loop return.
5. At the same time step 2's `guard_level(0xFFFFFFFF)` equals `HAKIOS_GUARD_SILENT` (`guard_level()` takes `min(level, guard_as)` and `guard_as` defaults to UINT32_MAX). In `hakios.guard.c:160` that means `to_speaker = 0` (no power limit) and at `:225` the peak ceiling stays at full scale: the guard only clips. Any `s` in `[2^32 - volume_at, 2^32 - 1]` is blind in the same way, because `amplitude(2 * attenuation)` wraps to a huge index and returns 0.

Failure scenario: `ioctl(fd, HAKIOS_AUDIO_SET_VOLUME, {below = 0xFFFFFF0F, muted = 0})` from any process, then any non-silent write to the same node (or iOS playing anything). The amplifiers are faded to Android's loudest level, the speaker guard is off, and the thread that should turn them off after three seconds of silence is in an endless I2C loop. Whether that level without the guard can hurt the speakers is NEEDS-HARDWARE (the guard exists "for want of the DSP's speaker protection", per `hakios.audio.h`).

Fix (three independent layers; do all):

```diff
--- hakios.audio.c  audio_ioctl
+#define HAKIOS_AUDIO_BELOW_MAX  (90 * 8)        /* the amplifiers' own floor: speaker.c VOLUME_LOWEST */
 	lck_mtx_lock(&audio_lock);
-	volume_below = volume->below;
+	volume_below = volume->below > HAKIOS_AUDIO_BELOW_MAX ? HAKIOS_AUDIO_BELOW_MAX : volume->below;
--- hakios.sound.c  watch()
-	hakios_speaker_volume(below + extra, 1)
+	hakios_speaker_volume(below_total, 1)        /* uint32 below_total = below > 720 ? 720 : below; below_total += extra (extra already <= 720) */
--- hakios.speaker.c  hakios_speaker_volume
-	uint32_t target = a->volume_at + below;
+	uint32_t target = a->volume_at + (below > VOLUME_LOWEST ? VOLUME_LOWEST : below);   /* (both loops) */
 	/* and make the loop finish: */
-	if (a->volume == target) continue;
+	if (a->volume == target || target < a->volume_at) continue;     /* (target is already clamped, belt and braces) */
```
Also give the guard a value that cannot collide with the sentinel (`guard_level()` should clamp to `HAKIOS_GUARD_SILENT - 1`), and add an iteration limit (about 2 * VOLUME_LOWEST / 1 steps) to the fade loop.

### S-02  Medium  CONFIRMED

Same cause as S-01: `sound.c:1267, 1279` computes `below + extra` in uint32 with `extra` from user space. `extra = 2^32 - 240` (with `below = 240`) gives 0, so `hakios_speaker_volume(0, 1)` fades to `volume_at`, Android's level, 30 dB louder than the cap (the code's default `below = 240` eighths; the header comment says 160) that `sound_below` is documented to be ("sound_below, which stays the loudest", `sound.c:31-32`; `hakios.audio.h:34-36`). Here the guard still sees the true level (`guard_level(0)`), so its power and peak limits apply; the cap that the operator set at boot does not. Whether Android's level is safe for this phone is NEEDS-HARDWARE; the cap bypass itself is certain. The fix of S-01 (clamp `extra`, saturating add) closes it.

### S-03  Medium  CONFIRMED

`acf_monitor()` bounds check in 32-bit arithmetic, `speaker.c:478-479`:

```c
temp_at + temp_count * temp_size > length || vbat_at + vbat_count * vbat_size > length
```
`temp_count` is checked `<= 8` but `temp_size` has only a lower bound (`>= 12`). All three are uint32, so `temp_count = 8, temp_size = 0x20000000, temp_at = 0x48` gives `8 * 0x20000000 = 0` (mod 2^32), the check passes, and the loop at 483-493 reads `row = block + temp_at + i * temp_size` for i up to 7: reads from `block + 0xE0000048`, 3.5 GB past a buffer of at most 1 MB (`acf_profiles()` limits the file to 0x100000). Also `temp_at = 0xFFFFFFFC, count 1, size 12` wraps to 8 and passes (row at `block + 4 GB`). The same holds for `vbat_*` at 494-504. The byte-sum checksum (469-471, 478) is trivial to satisfy for whoever crafts the file. Effect: synchronous data abort (kernel panic) in `hakios_speaker_prepare()` at the first sound=3/4 start, or, if the address happens to be mapped, garbage reductions in `temp_rows/vbat_rows`. The file comes from the system image, so the realistic trigger is a corrupted or hostile image rather than a remote attacker; but this is the loader the task asked about and the only parser step whose bounds are not sound (the others are fine, see below).

Fix:
```diff
-	    temp_at + temp_count * temp_size > length || vbat_at + vbat_count * vbat_size > length) {
+	    (uint64_t)temp_at + (uint64_t)temp_count * temp_size > length ||
+	    (uint64_t)vbat_at + (uint64_t)vbat_count * vbat_size > length) {
```
and loop with `(uint64_t)i * temp_size`. Also saturate the `less` additions at 502 (`uint16_t` wrap, a file with a large `vmax` turns a big reduction into a small one).

### S-04  Medium  PLAUSIBLE

`hakios_speaker_stop()` abandons the sequence on the first failure and does not power anything down:

- `speaker.c:688-696` `sysctrl()`: if `get()` (an I2C read) fails it returns false and does *not* call `power_down_now()` (only `put()` does).
- `speaker.c:1045-1061` `hakios_speaker_stop()`: `return;` on every failed step (1046, 1051, 1055, 1059). The `return` is inside the loop over the two amplifiers, so a failure at amplifier 0 leaves amplifier 1 untouched (still started, unmuted, volume as it was) and amplifier 0 half-way (e.g. ULS-muted, volume stepped but not powered down).
- Callers: `sound.c:1299` (watcher, after silence; `on = false` is set regardless) and `sound.c:1346` (`take_down()`), which ignores the failure and goes on to `stream_off()` and `afe_off()` (`sound.c:1347-1348`), i.e. stops the TDM clock the amplifiers are locked to.

Scenario: one NACK or "bus not at rest" (`bus_take()` returning false: SDA or SCL read low, `speaker.c:272`) during the final stop. Result: amplifier(s) left with power-down off, no bit clock, nothing retrying. In the watcher case the next `hakios_speaker_start()` restarts the sequence, so only the run-end case is permanent. How an Awinic amplifier behaves without a clock is NEEDS-HARDWARE.

Fix: make `hakios_speaker_stop()` finish every amplifier regardless of earlier ones and fall back to the unconditional power-down:
```diff
-		if (!sysctrl(a, SYSCTRL_ULS_HMUTE, true)) { return; }
+		if (!sysctrl(a, SYSCTRL_ULS_HMUTE, true)) { power_down_now("stop: could not mute"); return; }
 		...  (same for the other `return;` lines)
```
and let `take_down()` check a returned bool / `hakios_speaker_quiesce()` after a failed stop.

### S-05  Medium  PLAUSIBLE

`power_down_now()` (`speaker.c:623-646`) sets `broken = true` first and `a->started = false` at 644 after the write, whether or not the write and read-back at 639 were acknowledged (the failure only logs "NOT ACKNOWLEDGED", 640). After that:

- `put()`, `sysctrl()`, `hakios_speaker_stop()` all return at once on `broken` (654, 692, 1035): nothing retries.
- `hakios_speaker_quiesce()` (1068-1080) returns early when no amplifier has `started` set (`any` false), so the panic path of `hakios_sound_quiesce()` does not even try.

Scenario: an I2C fault (bus not at rest, NACK) in the very moment a fault is handled leaves an amplifier powered with the code believing it is off. Also in a panic: other CPUs are halted wherever they were, possibly with SCL or SDA held low by an interrupted bit-bang transfer; `bus_take()` then refuses to touch the bus (272-278) and `quiesce` gets no power-down through, and there is no bus-recovery (clocking out up to nine pulses) anywhere. Hardware behaviour of the frozen bus is NEEDS-HARDWARE, the bookkeeping error is not.

Fix: keep `started` true when the power-down write failed (`if (ok) a->started = false;`), let `quiesce` run when `broken && any prepared amplifier is not known off`, and add a bus-recovery step (SCL pulses with SDA released, then STOP) before giving up in `bus_take()`.

### S-06  Medium  CONFIRMED

mic=4 retry loop, `mic.c:1737-1778`. `failed = broken;` (1761) is the only failure signal counted (`++failures >= 3`, 1770). But `path_up()` fails *without* setting `broken` in several places: `clocks_on()` false (1696-1699), `codec_wait() == 0` (1704-1706), `bolero_look()` unknown version (1118), `dsp_path_on()`/`dsp_port_on()` (APR refusal), `datapath_on()` returning false after a failed `swr_read()` (1001-1003), and `listen()` returning early on a refused RUN (1565-1569). In all of those `failed` is false, the code prints "ended", runs `undo()` and loops: `ios_wants` is still 1 while iOS keeps the device open, so it immediately starts another attempt. Each attempt is `clocks_on` (DSP votes and clock commands, up to 1 s per unanswered command), the codec reset pulse on GPIO 83, pins, SoundWire master bring-up, `codec_wait()` (200 ms) and the undo of all of it, indefinitely, with lines suppressed by `quiet` after the first. `recordings` grows without limit.

Scenario: codec or DSP not answering (the case the retry cap was written for) while the audio server holds the input open: the cap never fires.

Fix:
```diff
-			if (path_up()) {
-				listen(true);
-			}
-			failed = broken;
+			bool up = path_up();
+			if (up) { listen(true); }
+			failed = broken || !up || (listen produced no samples, e.g. reads_done == 0);
```
(then the existing `failures >= 3` and the "wait until iOS closes" logic apply).

### S-07  Low  CONFIRMED

`sound.c:635` `kmem_alloc(... &space.tables, 3 * 4096 ...)` in `space_on()`; `space_off()` (693-706) and the rest of the file never free it (`grep kmem_free`: no hits in the five files). `shared_get()` calls `space_on()` whenever `space_users == 0` and `!space.on` (725-730). With mic=4 and no sound=N every iOS recording takes and gives back the last user (`hakios_audio_dsp_memory()` / `_put()`), so each recording leaks 12 KB of wired kernel memory and overwrites the pointer. The same happens after the TLB-wait timeout return at 672-675 (tables allocated, `space.on` false, next call allocates again). Not freeing while the context could still be walked is safe (the pointer is simply lost); fix: keep one allocation (`if (space.tables == 0) kmem_alloc(...)`) and re-zero it, or free it in `space_off()` after the context is switched off and the TLB invalidated.

### S-08  Medium  PLAUSIBLE (mode CONFIRMED, effect depends on sandboxing, which I did not examine)

`audio.c:343` and `mic.c:1732` create the nodes with mode 0666. In XNU file permissions are the only gate in the kernel for `open()` (a sandbox profile may add more).

- Microphone: opening `/dev/hakios-mic` sets `ios_wants = 1` (mic.c:1524-1526), which makes the for_ios thread power the codec path up and fill `ring`; any reader gets the audio (`mic_dev_read`, 1484-1519). Two readers split the stream. The ring is not cleared between sessions (only reset in the thread, 1752-1754, which races with a reader that starts at open).
- `ios_wants` is a single flag: `mic_dev_close` sets it to 0 (1532). If any other process opens and closes the node (or XNU calls `d_close` for a close that is not the last: I could not confirm from this tree which, the XNU `spec_close` source is not in the repository), the audio server's recording path is taken down while it still reads.
- `/dev/hakios-audio`: any process can inject audio and call `HAKIOS_AUDIO_SET_VOLUME` (mute, unmute, S-01/S-02). Each ioctl also logs through `printf` (audio.c:272) and, in sound.c, `say()` to the loader log (1258), so a loop of ioctls floods a log that "keeps its beginning and its end".

Memory safety of the concurrent readers was checked and is fine (all indices are taken modulo the ring size and every copy length is clamped; at worst a reader gets torn or repeated audio).

Fix: create both nodes `0600`/root:wheel (or a dedicated group of the audio server), refcount opens (`ios_wants` as a counter or open-exclusive with `EBUSY`), rate-limit the ioctl logging.

### S-09  Low  PLAUSIBLE

`mic.c:719` `read_id = read_id < 14 ? read_id + 1 : 0;` so ids 0..14 are used, and 727 accepts `((answer >> 8) & 0xf) == read_id`. When `read_id == 0` (every 15th read) and the FIFO is empty, `answer = swr_rd(SWRM_CMD_FIFO_RD_FIFO)` at 726 (read after the 10 ms wait without checking that the FIFO has data) is likely 0, whose id field is 0: the read "succeeds" with value 0. `codec_bits()`/`codec_put()` then compare against it. The same wrap exists for `write_id`, harmlessly. That an empty FIFO reads 0 is NEEDS-HARDWARE. Fix: count ids 1..14 (`read_id = read_id >= 14 ? 1 : read_id + 1`), and test the FIFO level (`>> 16 & 0x1f`) again before using `answer`.

### S-10  Low  NEEDS-HARDWARE

`swr_write()` (`mic.c:700-711`): `for (i < 20 && fifo_level >= 16) spin_us(500)` then writes the command regardless and returns true. Callers `port_config()` (972-982), `to_all()`, `broadcast()` and `codec_put(..., check = 0)` ignore the result. If the command FIFO stays full for 10 ms the write is lost without a trace and the SoundWire data port is left half-configured. Fix: return false after the wait times out and propagate.

### S-11  Low  NEEDS-HARDWARE

The DSP writes into `buffer + BUFFER_BYTES` (`sound.c:766`, memory from `kmem_alloc(... KMA_ZERO ...)` at 719, normal cacheable memory; the SMMU PTEs use MAIR attribute 0, 0x44 = non-cacheable, `AUDIO_PTE` at 526 with `SMMU_MAIR0` at 523). The CPU invalidates a period only *after* the DSP reports it done (`dc ivac`, `mic.c:1614-1617`). Nothing cleans/invalidates these lines before the first `ASM_DATA_CMD_READ_V2`, although the zero fill left them dirty in the CPU cache (the file does `dc civac` for its page tables at `sound.c:646` and `dc cvac` for the speaker periods, so the pattern is known). A later eviction of a dirty zero line would overwrite DSP-written data in memory and the `ivac` would then read the zeros. Visible effect: occasional zeroed samples in the first periods. Whether the DSP's stream is I/O-coherent (which would make the whole thing moot) is NEEDS-HARDWARE. Fix: `dc civac` over `[buffer + BUFFER_BYTES, +MIC_BYTES)` plus `dsb sy` in `hakios_audio_dsp_memory()` before returning.

### S-12  Low  PLAUSIBLE (QEMU only)

`virtio_sound.c:249-251`: `tx_free[tx_free_count++] = (uint16_t)(tx.used->ring[tx.seen++ % QUEUE_SIZE].id / 2);` after reading `used->idx`: (a) no load-acquire/`dmb ishld` between the `idx` load and the ring load, which ARM may reorder when the device runs on another host thread (KVM/HVF); (b) the device-written `id` is used unchecked as a buffer number, `buffer = shared + OFFSET_TX + n` (254), and the number of entries is not compared with `TX_BUFFERS`: a misbehaving device writes up to 1932 bytes at an arbitrary offset or overruns `tx_free[32]`. QEMU is trusted here, so this is hardening. Fix: `__builtin_arm_dmb(0x9)` (ISHLD) after the `idx` load; `if (id / 2 >= TX_BUFFERS || tx_free_count >= TX_BUFFERS) break;`.

### S-13  Low  CONFIRMED (hakios.adsp.c, outside this group; reported for its owner)

`hakios.adsp.c:2488` `payload = (header.size < length ? header.size : length) - header_length;`. `header_length <= length` is checked (2484) but `header.size` (set by the DSP) is not compared with `header_length`. With `header.size < header_length`, `payload` underflows to about 4 GB. Then `memcpy(words, data + header_length, min(payload, 256))` (2495) and `memcpy(apr_answer.words, ..., 2515)` copy 256 bytes from beyond the received packet (over-read of the glink receive buffer), `apr_answer.length = payload` is huge, and handlers receive length 256 with nonsense words (the handlers in sound.c/mic.c test `length` against 16/24 and index only within it, so they are safe in themselves). The DSP is firmware we start ourselves, so the trigger is a firmware bug or a corrupted glink packet. Fix: `if (header.size < header_length) return;` and clamp the copy to `length - header_length`.

### S-14  Low  PLAUSIBLE

`audio_plugin.c:788-793`: `wanted < 0 ? 0 : wanted > 1 ? 1 : wanted` lets NaN through (both comparisons false); `db_to_scalar()` (271-276) does the same. `volume_to_kernel()` (282) then builds `{ lround(-scalar_to_db(NaN) * 8) , NaN <= 0 }`: `lround(NaN)` is unspecified, in practice 0 or `LONG_MIN`, both give `below = 0` after the uint32 cast, and `muted` is false: loudest instead of muted. A CoreAudio client can set the property. S-01's kernel-side clamp does not cover this (0 is in range), so check `isnan()` in the plug-in (`wanted = isnan(wanted) ? 0 : ...`).

### S-15  Low  CONFIRMED

Periods are re-submitted only when the DSP says it has finished the previous submission of that period. `sound.c:1194-1199` (feeder) counts a failed `period_write()` in `failed++` and moves on; `mic.c:1644` `(void)mic_read(next);`. `hakios_adsp_apr(..., ms = 0, ...)` returns false when the glink send fails or the channel is not open (`hakios.adsp.c:2536, 2555-2557`). That period never comes back (no event is ever generated for it), so after eight failures the stream is permanently empty: speakers play silence from the DSP's own underflow handling, and the mic loop spins in `sleep_ms(2)` until iOS closes the device (the "no read has come back" guard at `mic.c:1601` only counts while `reads_done == 0`). Fix: keep a "pending" bitmask of periods that failed to submit and retry them in the loop.

### S-16  Low  CONFIRMED (test configuration)

`mic.c:1597`: the end condition is `(for_ios ? (!ios_wants || stopping) : elapsed_ms >= mic_secs * 1000ull) || broken`. For mic=1..3 `stopping` is ignored, but `hakios_mic_dsp_down()` (1839-1847) sets `stopping` and then waits on `mic_lock`, which `mic_thread` holds through the whole `listen(false)`. So the DSP shutdown at the run's end is delayed by up to `mic_secs` (clamped to 600). Fix: test `stopping` in both branches.

## Checked and found fine

hakios.audio.c
- `audio_write()`: 4 KB stack buffer, chunk length rounded to whole frames and clamped to the buffer, `uiomove` length cast safe, tail of fewer than 4 bytes dropped (not copied uninitialised), error from `uiomove` returned.
- `audio_record()`: bound `rec_used + sizeof(block) + bytes > rec_size` includes the block header; `rec_frames_max` / `rec_size` computed in uint64; `rec_sound` clamped to 1200 s; memory zeroed (`KMA_ZERO`), header written before `loader_sound[]` is published; `loader_sound[1]` updated under `audio_lock`.
- Locking: `audio_lock` is a mutex; the sink is called under it and must not sleep, and neither `ios_sink` nor `sound_play` does; lock order is `audio_lock` -> `sound_lock`/nothing, never the reverse (`sound.c` takes `audio_lock` only in `hakios_audio_set_sink`/`hakios_audio_volume` without holding `sound_lock`, except `sound_thread` which takes `sound_lock` -> `audio_lock`; no path takes them the other way round). `audio_report` is re-armed under the lock and its divisions are guarded (`lasted >= 1 s`).
- `audio_play()` when the sink is replaced by NULL (take_down) is correct; sinks return `taken <= count` so `stretch_lost` cannot underflow.

hakios.virtio_sound.c
- Ring arithmetic: `RING_FRAMES` is a power of two and indices are free-running uint32, so `ring_tail - ring_head` and `% RING_FRAMES` stay consistent through wrap; room/`taken` computation cannot exceed the ring.
- Shared-area layout: desc/avail/used of both queues, the control request/answer (0x1000/0x1800, answer at most 260 bytes) and the 32 transmit buffers (1932 bytes each) do not overlap and fit in `SHARED_SIZE` (0x14000); descriptor lengths match the `tx_buffer` fields; `QUEUE_SIZE` checked against `QUEUE_NUM_MAX`; stream count clamped to `MAX_STREAMS` and the answer buffer is sized for it.
- `control_request()` wait is bounded (1000 x 1 ms); only used during attach. DMA memory from `kmem_alloc_contig`, physical address from `kvtophys`, `dmb ish` between ring entry and index and before notify.
- Failure paths in `sound_attach()` leak the shared area and leave the device configured (boot time, QEMU only; not worth a finding).

hakios.sound.c
- SMMU page-table construction: all indices (`root[0]`, `second[0]`, `third[0..23]`) are constants inside one table; `SHARED_BYTES / 4096` entries fit; tables cleaned with `dc civac` + `dsb` before the context is enabled; `used[256]` is indexed with `s2cr & 0xff`; `contexts` from `idr1 & 0xff` bounds the context search; IDR-derived geometry is validated against 1 MB before use; `space_find()` refuses to touch a context or match register that is in use.
- Speaker period cache maintenance: `period_fill()` and `period_fill_ios()` clean every line of the period (`dc cvac` loop over `PERIOD_BYTES`, then `dsb sy`) after the guard has processed it and before submission; periods are refilled only after the DSP has returned them.
- Ring between `ios_sink` (producer, serialized by `audio_lock`) and `period_fill_ios` (single consumer): free-running volatile indices, power-of-two size, data written before `ring_head` with `OSMemoryBarrier`, consumer reads `ring_head` before the data; `ring_tail` advanced after the copy; `available` can never exceed the ring.
- `events()`: payload length tested before `payload[3]`; bit index from the DSP's token only sets bits in a mask, extra bits are cleared by the receivers.
- Every wait loop is bounded: `play()` (2 s after end, 1 s first period), TLB wait 100 ms, `take_down()` 3 s, `pin_activity` fixed 20000 reads, APR waits 1 s. Stop ordering in `take_down()`: amplifiers stop before the stream closes, the stream closes before the region is unmapped, the region is unmapped before the SMMU context is restored; the shared buffer is deliberately never freed (no use after free).
- AFE parameter packets (`afe_service_param`, `afe_port_param`): payload at most 44 bytes into a 64-byte area, all sizes constant.
- Boot-args: `sound` clamped to 4; `sound_gain` clamped to `HAKIOS_GUARD_MAX_GAIN` (12 dB) in both places; `sound_secs` clamped to 3 for the test-tone levels; `sound_below`, `sound_pause`, `sound_guard_as` are accepted as given (operator test knobs: 0 means Android's own level; only level 1 uses an unclamped `seconds * 1000`, which wraps for more than 4.29 million seconds).

hakios.speaker.c
- ACF loader `acf_profiles()`: file size 0x50..1 MB; table `at + entry_size <= size` in uint64; `entries` 1..64 and stride at least 0x30 so every field read (up to offset 40) stays in the entry; per-entry `offset + length <= size` in uint64 before the data is touched (for the monitor entries `length` is replaced by 0 on failure); `count <= 64` with `profile[64][2]`; `data_length == 4 + 4 * count` makes the uint32 wrap in `ACF_BLOCK_HEADER + data_length` unusable; checksum loop stays inside `length`; registers 0 and 0x70 and above (fuse registers, soft reset) are refused before the `(uint8_t)` truncation at line 785 (so no register number from the file is truncated into a forbidden one); register 0x04 keeps the power-down/mute bits as read, 0x08 TX enable cleared, 0x05 (volume) is set to the lowest right after the profile, 0x50 recomputed from the fuses; `volume_at` decode cannot reach 0x300+ and values at or above `VOLUME_LOWEST` are refused.
- `set_volume()` clamps both ways (never below Android's level in loudness, never above -90 dB attenuation) and the register encoding (`volume / 48 << 6 | volume % 48`, at most 0x3c0) fits the 10-bit field. Start refuses on an unlocked PLL or any fault bit; the amplifier stays muted and at the lowest volume until the feedback is on; every register write is read back and a mismatch powers both down.
- I2C bit-bang: clock-stretch wait bounded (100 half bits), STATUS_TRIES bounded, `bus_take()` refuses a busy bus and gives the pins back as found; `spin_us` used in the panic path (no sleeping).
- Monitor: `looks`-based division by 1..3, `per_eighth` division guarded by `less != 0`, tables at most 8 rows, row index -1 handled. (Gap rows between temperature ranges return the previous row; at the very first reading a gap yields no reduction, which mirrors the table, not a bug I can show.)
- `rpmh_address()`: `header_offset` is a uint16, so even the maximum plus 512 entries stays inside the 128 KB mapping; the bounds test there is vacuous but harmless.

hakios.mic.c
- `mic_events()`: period index from the token tested `< MIC_PERIODS` before use; `length >= 24` before `payload[0]`/`payload[4]`; DSP-reported size clamped to `MIC_PERIOD_FRAMES` before the copy and the `int16_t stereo[480]` use.
- Mic buffer geometry: `bytes >= MIC_PERIODS * 4096` checked; each period uses the first 1920 bytes of its own page; invalidation covers exactly `MIC_PERIOD_BYTES`; no overlap with the speaker periods (separate pages).
- `/dev/hakios-mic` read path: ring is zeroed (`Z_ZERO`), all copies are `min(want, avail, RING_FRAMES - at)` with `at = read % RING_FRAMES`, `uiomove` length cast fits int, an `avail` underflow from a racing second reader is caught by the `> RING_MOST` branch; `ring_put()` publishes `ring_written` with release ordering and the reader loads it with acquire; the ring is never freed.
- Bring-up/undo: restore functions clear `broken` first so put-back writes happen; undo is the reverse of bring-up and is idempotent (flags per resource), so the second call from `hakios_mic_dsp_down()` is harmless; `mic_lock` and `hakios_smmu_lock` are always taken in that order.
- All tables (SoundWire, codec, macro registers) are compile-time constants; no length or offset comes from a file or user. Polling loops bounded: SoundWire link 100 x 510 us, `codec_wait()` 200 ms, FIFO waits 20 x 500 us, `swr_read()` 4 tries.
- Boot-args: `mic` clamped to 4, `mic_secs` to 1..600, `mic_input` masked with 0x0f; `mic_adc`, `mic_main`, `mic_test`, `mic_tap` are test switches with no size effect.

userland/src/audio_plugin.c
- Output writes are whole frames (`frames * 4`) of the stream's own format, and the non-blocking handling is consistent with the kernel (which never blocks); input read is `frames * 2` bytes into a mono 16-bit buffer, short reads zero-filled; the silent-input memset uses the stream's own channel count; volume is clamped to 0..1 before the ioctl (except NaN, S-14).

## Not checked

- hakios.guard.c beyond the parts the sound path calls (`block()` read for the sentinel and attenuation handling; no review of its fixed-point arithmetic, filter stability or overflow of the Q30 products).
- Other drivers that share the SMMU lock or the I2C/TLMM pins: hakios.wifi.c, hakios.camera.c, hakios.haptic.c, hakios.torch.c; whether any of them touches GPIO 12/13 while the speaker code holds the pins (the speaker code has no lock at all against another I2C user; only the sound thread, `take_down()` and the optional `speaker_probe` thread use it).
- hakios.adsp.c apart from `root_file()`, `hakios_adsp_apr()`, `apr_input()` (glink, firmware loading, the answer buffer's lack of synchronisation between the link thread and the waiter).
- What a real aw882xx_acf.bin looks like (not in the repository) and whether the registers in a genuine profile are safe; Awinic register semantics, safe amplifier limits, the behaviour of the amplifier with no bit clock (NEEDS-HARDWARE in S-01, S-02, S-04, S-05).
- SMMU/MAIR/I/O-coherency behaviour of the audio stream (S-11), SoundWire FIFO semantics (S-09, S-10).
- XNU's `spec_close` last-close behaviour and any MAC/sandbox policy on `/dev/hakios-*` (not in the tree; affects S-08).
- QEMU's virtio-sound device behaviour; the audio_plugin.c property/object plumbing outside I/O and volume.
- Timing, latency and audio quality (underflow behaviour of the 160 ms DSP queue, the 5 ms virtio poll).
- Nothing was built or executed; no sanitizer or fuzzing was run on the ACF parser.

## Fix status

Edits only in drivers/audio/hakios.{audio,sound,speaker,mic,virtio_sound}.c and drivers/audio/hakios.guard.c (then in drivers/storage/). Nothing was compiled or run.

- S-01 FIXED. Three layers: audio.c audio_ioctl clamps the user's `below` to HAKIOS_AUDIO_BELOW_MAX (90 * 8 = speaker.c VOLUME_LOWEST, the documented "sound_below=720" floor); sound.c watch() now uses a saturating below_with(extra) instead of `below + extra` (three places), and guard_level() never passes a level equal to the HAKIOS_GUARD_SILENT sentinel; speaker.c hakios_speaker_volume() clamps `below` to VOLUME_LOWEST before `volume_at + below`, so the fade loop's target can no longer wrap under volume_at and the loop always ends. guard.c block(): `2 * attenuation` no longer wraps in 32 bits (the blind-guard range from item 5). Not done: an iteration limit on the fade loop (not needed once the target is in range) and a guard_level() clamp beyond the sentinel one.
- S-02 FIXED with S-01 (clamp of `extra` in audio.c, saturating sum in sound.c).
- S-03 FIXED. speaker.c acf_monitor(): both table-end checks are done in uint64; the `less` addition for the battery rows now saturates at 0xffff instead of wrapping.
- S-04 FIXED (partly). speaker.c hakios_speaker_stop(): every failed step now goes through stop_failed(), which calls power_down_now() (both amplifiers, unless already broken), so a failed read in sysctrl() no longer leaves the amplifiers up. NOT done: take_down() in sound.c still ignores the result of the stop (it is a void function; changing it is a design change), but it now finds the amplifiers powered down or retained as "started" for the quiesce.
- S-05 FIXED (partly). speaker.c power_down_now(): `started` is cleared only when the power-down write and read-back were acknowledged, so hakios_speaker_quiesce() still tries again. SKIPPED: the bus recovery (clocking out SCL pulses) in bus_take(); it needs knowledge of the I2C/amplifier hardware.
- S-06 FIXED. mic.c: listen() now returns bool (false when the RUN is refused, a read cannot be sent, or no read comes back in 1.5 s); for_ios() counts `!path_up() || !listen()` as a failure, so the existing three-failure limit applies. Not done: counting "listen produced no samples" beyond those cases.
- S-07 FIXED. sound.c space_on(): the three page-table pages are allocated once and re-zeroed on reuse, instead of a new kmem_alloc at every call.
- S-08 SKIPPED. The fix is a change of the node mode (0666), which is policy and not to be changed here; the refcount of opens and the rate limit of the ioctl log are a design change.
- S-09 SKIPPED. Changing the SoundWire read id range (and re-testing the FIFO) depends on how the hardware treats id 0 and an empty FIFO (NEEDS-HARDWARE).
- S-10 SKIPPED. NEEDS-HARDWARE: what to do when the command FIFO stays full, and every caller would have to propagate a failure.
- S-11 SKIPPED. NEEDS-HARDWARE: cache maintenance for the DSP's buffers depends on whether the stream is I/O-coherent.
- S-12 FIXED. virtio_sound.c sound_pump(): a barrier after the idx load, and a used-ring id that is not one of the TX_BUFFERS buffers (or more entries than buffers) is dropped instead of used as an index.
- S-13 SKIPPED. In hakios.adsp.c, which is not in this task's file list (someone else's).
- S-14 SKIPPED. In userland/src/audio_plugin.c, outside the allowed files. Its fix (isnan) is still needed; the kernel clamp does not cover it.
- S-15 SKIPPED. A pending-period retry mask in the feeder and mic loop is a design change.
- S-16 FIXED. mic.c listen(): `stopping` now ends the loop for mic=1..3 too, so hakios_mic_dsp_down() is not held for mic_secs.

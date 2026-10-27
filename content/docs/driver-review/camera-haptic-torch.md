# Driver review: camera, haptics, torch

## Scope and method

Read-only audit. Files read in full unless noted.

| File | Lines | Read |
|---|---|---|
| drivers/camera/hakios.torch.c | 763 | all |
| drivers/haptic/hakios.haptic.c | 1005 | all |
| drivers/camera/hakios.camera.c | 4264 | all except 1568-1750 only skimmed (read-only RPMh/SMMU/PLL printers) |
| xnu/files/bsd/sys/hakios.camera.h | - | all (user ABI) |
| userland/src/camera_device.c (1280-1420), camera_isp.c (840-1033) | - | the parts that talk to the kernel node and parse the `.isp` file |
| tools/camsensor.py, tools/camtuning.py | - | header comments and pack lines only (to learn the on-disk format) |
| hakios.buttons.c (spmi lock), loader_return.c (quiesce call site), hakios.wifi.c (`hakios_wifi_file`) | - | the few lines needed |

Method: traced every user-reachable entry (torch `write`/`read`, haptic `write`, camera `open`/`close`/`read`/`write`; none of the three nodes has an ioctl, all use `eno_ioctl`/`eno_mmap`) end to end; followed every table-derived length and count; checked every polling loop for a bound; checked lock use between the service thread and the file operations; checked each boot-arg. Nothing was built or run. No hardware facts are asserted: where an outcome depends on how the chip behaves it is marked NEEDS-HARDWARE.

## Findings

| id | severity | confidence | file:line | one line |
|---|---|---|---|---|
| CAM-1 | high | CONFIRMED | hakios.camera.c:3873-3884 vs 3363-3376, 3401-3425 | `camdev_read` copies from `ring` with no reference held; the capture thread frees `ring` under it (use-after-free read, or panic in `dc civac`) |
| CAM-2 | medium | CONFIRMED | hakios.camera.c:3969-3978, 4019-4035, 3379-3384, 3500-3503, 4000 | any process (node is 0666) picks sensor and any table mode, so can force a huge kernel allocation or a permanent camera shutdown |
| TORCH-1 | medium | CONFIRMED (code path); effect NEEDS-HARDWARE | hakios.torch.c:330, 506-511, 605-633 | the "light off" path is blocked by the sticky `broken` flag, so after one failed write the LED stays on with no monitoring and no timer |
| TORCH-2 | medium | CONFIRMED (code path); effect NEEDS-HARDWARE | hakios.torch.c:487-499, 697-717, 632, 750 | `lit` is set only after all enabling writes succeed; a write that lands but fails read-back leaves the LED possibly on with `lit == false`, so nothing turns it off |
| HAPTIC-1 | medium | CONFIRMED (code path); effect NEEDS-HARDWARE | hakios.haptic.c:961-971, 570-580 | haptic=5 starts serving the motor even when the waveform file did not load |
| CAM-3 | low | PLAUSIBLE / NEEDS-HARDWARE | hakios.camera.c:2989 vs 1830, 3003, 3066 | lens-motor supply is not given back if RPMh did not report "done" in time, unlike the CX/MX rails |
| CAM-4 | low | CONFIRMED | hakios.camera.c:1218-1225, 1269 vs 2708-2710 | power-sequence delays from the table are not clamped (sensor-register delays are): up to ~71 min with rails on, or in the panic path |
| CAM-5 | low | CONFIRMED (arithmetic), PLAUSIBLE (reach) | hakios.camera.c:3316, 3347, 4053, 4036, 3436, 2197 | mode fields from the table only partly range-checked: `frame_length < 40` underflows, width/height unbounded |
| CAM-6 | low | CONFIRMED | hakios.camera.c:3906-3938 | `keep_picture` has no lock: two writers interleave into the same `keep` buffer and header |
| HAPTIC-2 | low | PLAUSIBLE | hakios.haptic.c:847-866 | the 1 s cap applies per vibration; back-to-back taps from user writes have no rest or duty limit, only the chip's fault flags |
| TORCH-3 | low | CONFIRMED | hakios.torch.c:585-590, 608-618 | the 30 s cap is "ask anew": an unprivileged writer that writes 0 then a level again keeps the light on indefinitely |
| DEV-1 | info | CONFIRMED | torch.c:575, haptic.c:828, camera.c:4000 | all three nodes are mode 0666: any process can use the camera, torch and motor, so user-space permission prompts are the only gate |

## Details

### CAM-1 camera read vs. session end: use-after-free of the frame ring

`camdev_read` marks a place READING under `ios_lock`, drops the lock at 3869, then reads the globals `ring`, `ring_place_bytes` and `ring_frame_bytes` with no lock and copies the frame:

```
3873  vm_offset_t at = ring + (uint64_t)b * ring_place_bytes;
3879  for (vm_offset_t line = at & ~63ul; line < at + n; line += 64) dc civac
3884  error = uiomove((caddr_t)at, (int)n, uio);
```

The capture thread ends a session in `ios_stop()` (3401): it sets every place FREE under the lock (3405-3407, which also overwrites READING), then, without waiting for any reader, runs `titan_down(); power_down(); ring_free();` and `ring_free()` does `kmem_free(kernel_map, ring, ring_bytes)` and `ring = 0` (3370-3374). Nothing counts readers, so a reader mid-copy keeps a pointer into freed memory.

Ways the session ends while a reader is copying (a 12 MB frame is copied in milliseconds, and the code itself logs the time at 3891):
- another process writes `HAKIOS_CAMERA_SENSOR` (3969-3978): `ios_switch_to` is seen by the loop at 3512, `ios_stop` runs within about 1 ms;
- no read activity for `IDLE_MS` (1000 ms, 3526): `ios_last_read` is only refreshed at the start of a read (3810, 3843) and at its end (3899), not during the copy, so a reader that is descheduled or stuck in page faults on a big user buffer for 1 s is declared idle;
- any fault (`healthy()`, SMMU fault, 1.5 s without a frame, an exposure write NACK) -> `give_up` -> `ios_stop`.

Result: `dc civac` on the unmapped VA (a cache-maintenance fault from kernel code with no recovery handler) -> kernel panic; if the range was reused (the next `ring_alloc`, or any other kmem allocation) `uiomove` copies unrelated kernel memory out to user space; if `ring` was already zeroed, `at` is a near-NULL address. Reachable by any process that can open the 0666 node.

Fix (sketch):
```
+ static unsigned ios_readers;                 /* under ios_lock */
  camdev_read: under ios_lock, after choosing b:
-   place[b].state = PLACE_READING;
+   place[b].state = PLACE_READING; ios_readers++;
+   snapshot at/n/ring_frame_bytes into locals here, still under the lock
  ... at the end (the existing lock at 3895):
+   ios_readers--; wakeup(&ios_readers);
  ios_stop(), before ring_free():
+   lck_mtx_lock(&ios_lock);
+   while (ios_readers != 0) msleep(&ios_readers, &ios_lock, PZERO, "hakios-camera-drain", NULL);
+   lck_mtx_unlock(&ios_lock);
```
Also refresh `ios_last_read` while `ios_readers != 0` in the idle test.

### CAM-2 unprivileged control of sensor and mode; permanent shutdown

`HAKIOS_CAMERA_SENSOR` accepts any sensor index (< 4) and any mode number `c.b` (3969-3978). `ios_select()` honours an explicit mode directly: the 4:3 / 31 fps / 13 MP filter at 4019-4032 only runs when `mode_n >= ctab->modes`; an explicit mode is accepted if it passes the checks at 4035 (lanes, data type 0x2b, `width % 4`, fps and frame length non-zero). `ios_start()` then calls `ring_alloc(RAW10_STRIDE(width) * height)` (3436) for `RING = 3` places (3254, 3383) of kernel memory. If a table has a full-resolution mode (the S5KHM2SD is a 108 MP sensor; the tables are not in the repository, so NEEDS-HARDWARE/IMAGE for the actual sizes) this is hundreds of MB per session from an unprivileged process, and each session start repeats it.

Consequences of failure are permanent: a failed `ring_alloc` or any other step in `ios_start` returns false -> `give_up("the camera did not start")` (3500-3503); `ios_select` failing for a sensor with no `.tab` in `fw/` (the build only installs tabs for module files present in `fw-camera/`, userland/build.sh:392-400) -> `give_up("a sensor that cannot be used")` (4091-4093). `broken` is never cleared (except in quiesce), every later open/read returns EIO (3785, 3816). The same holds for one transient NACK: `exposure_write` -> `give_up` (3356-3358, 3593-3595), `sensor_table` has no retry (2703), whereas the PMIC and chip-ID reads retry (697, 1432).

Fix (sketch):
```
 camdev_write, HAKIOS_CAMERA_SENSOR:
-   ios_switch_mode = c.b;
+   ios_switch_mode = c.b;               /* and in ios_select(): */
 ios_select(), for an explicit mode_n also require
+   pixels <= 13000000 && fps_milli <= 31000
 ios_select failure / ios_start failure for a switch requested from user space:
-   give_up(...)
+   fall back to the previous sensor/mode; only give_up on hardware faults
 devfs_make_node(..., 0666, ...) -> 0660 with a group the media daemon is in
```

### TORCH-1 the off path is gated by the sticky `broken` flag

`put()` begins with `if (broken || !allowed || ...) { give_up(...); return false; }` (330-333) and every failure inside `put()` calls `give_up()`, which sets `broken` (308-314). `dark()` is a chain of four `put*` calls (506-507) joined by `&&`. So:

1. light is lit (`lit == true`), user asks a different level, `light()` -> `put_bits(FLASH_ITARGET0)` writes but the read-back differs (or the read fails) -> `broken = true`, `light()` returns false.
2. `serve()` breaks out (605) and runs the last-ditch `if (lit) (void)dark();` (632-634). `dark()` -> `put_bits(FLASH_EN_LED_CTRL, 1, 0)` -> `get()` works (reads are not gated) -> value differs -> `put()` sees `broken` -> false. The channel stays enabled.
3. The thread says "the light is given up on" and terminates (636, 723). From here nothing checks fault flags, battery temperature or the time limit; the LED stays on at the last current until `hakios_torch_quiesce()` at the run's end (which does reset `broken = false`, 751).

The same happens when `dark()` itself loses a write mid-chain (cut path 612-614, trouble path 625: dark runs first, so a failed first step blocks the remaining steps). The retry at 632 is dead code in exactly the situations it is there for. Contrast with camera.c, whose off path uses a `force` argument (`pm8008_put(..., true)` at 813, `pgpio_put(..., true)`) for the same reason.

Cheap trigger: none needed beyond one dropped/failed SPMI transfer; user space only has to change the level while lit (any process, 0666).

NEEDS-HARDWARE: whether a LED stays lit after a failed read-back, and what it dissipates, is not derivable here (the file's own comment says Android's torch has no safety timer, 125 mA channel 0).

Fix (sketch):
```
-static bool put(uint8_t reg, uint8_t value)
+static bool put(uint8_t reg, uint8_t value, bool force)
-	if (broken || !allowed || ...
+	if ((broken && !force) || !allowed || ...
 dark(): use force=true for every write, and do not stop at the first failure (try all four, retry each up to 3 times)
 serve() end: if (lit) { dark(); } with the forced path; also keep calling dark() every 100 ms until it succeeds or the run ends
```

### TORCH-2 `lit` is set after the enabling writes

`light()` sets `lit = true` only at line 498, after `put(FLASH_MODULE_EN, 0x80)` and `put_bits(FLASH_EN_LED_CTRL, 1, 1)` (495-497). If the module-enable write lands and the channel write lands but fails its read-back (or the read fails), `put()` returns false, `lit` stays false, `broken` is set. Then:
- level 2 (697): `light(1000)` false -> the whole `if` is skipped, no `dark()` at all (713);
- level 3: `serve()` end `if (lit)` skipped (632);
- `hakios_torch_quiesce()` `if (lit)` skipped (750); it only prints "(NOT DARK)" (762) and does not act on it.

The module/channel may therefore stay enabled and unmonitored. NEEDS-HARDWARE for whether the chip actually lights in that state.

Fix: set `lit = true` before the first enabling write (before `put(FLASH_MODULE_EN, ...)`), and let `dark()` clear it only on success; make quiesce call `dark()` when the read-back says not dark.

### HAPTIC-1 haptic=5 serves without waveforms after a load failure

```
961  if (level >= 3 && configure() && load_waveforms() && level == 4) { ... play_effect }
969  } else if (level == 5 && !broken) { serve(); }
```
`load_waveforms()` returns false without `give_up()` when the file is missing, shorter than 8 bytes, or its checksum does not add up (570-580). For level 5 the `else if` is then taken and `serve()` starts the motor service (waveform 1 for taps, 11 looped) although Android's waveforms were never written to the chip's RAM (the header comment promises "configured and loaded as for 3"). Effects played from RAM that holds whatever the chip had after reset/Android: NEEDS-HARDWARE (strength and length of such a waveform are unknown; the gain and the 1 s cap still apply).

Fix:
```
-	} else if (level == 5 && !broken) {
+	} else if (level == 5 && !broken && loaded) {
```
with `loaded` set by `configure() && load_waveforms()` evaluated separately from `level == 4`, and `give_up("the waveforms are not loaded")` on that path.

### CAM-3 lens-motor supply vote not tracked on timeout

`rails()` records the vote before asking (`rails_voted |= on;`, 1830) so a request that RPMh finishes after our 100 ms poll is still given back. `vaf()` records it only on success: `vaf_voted = on && done;` (2989). In `af_up()`, `if (!vaf(true)) return;` (3003) leaves `vaf_voted == false`, so `af_down()` (3066) never sends the off request, and quiesce does not know about it either. If the WRITE_WAITED commands were accepted but completion was not seen in 100 ms (rpmh_write 1796-1806), the DW9800's supply stays on. NEEDS-HARDWARE (whether a late completion happens).

Fix: `vaf_voted |= on; ... if (!on) vaf_voted = !done;`, i.e. set it before the write like `rails()`.

### CAM-4 power-sequence delays are not clamped

`power_step()` ends with `sensor_delay(e->delay_us)` (1269). `delay_us` is a 32-bit field of the table (camsensor.py:131 packs `d * 1000` into a `<I`), `sensor_delay()` sleeps `us / 1000` ms (up to 4,294,967 ms) and the sensor-register path is clamped at 100 ms (2708-2710) but this one is not. A corrupt or odd table keeps the rails/MCLK up for the whole delay during power-up; in `power_down()` under `leaving` (panic path) `wait_ms` becomes `spin_us` (141-147) and spins with interrupts as they are. The table comes from the system image built by this repo's tool, so this is robustness, not an attack.

Fix: `sensor_delay(us > 100000 ? 100000 : us)`.

### CAM-5 mode fields only partly validated

`ios_select()` checks lanes, data type, `width % 4`, fps and frame_length != 0 (4035-4036) but:
- `frame_length < EXPOSURE_MARGIN (40)` makes `ios_ask.lines = frame_length - EXPOSURE_MARGIN` (4053) wrap to ~4G (clamped later at 3311) and `*frame_lines - EXPOSURE_MARGIN` (3316) wrap so the final clamp of `lines` is skipped; `exposure_write` default branch computes `extra = frame_lines - ios_mode->frame_length` (3347), which wraps if `shortest > FRAME_LINES_MAX`.
- width/height have no upper bound: `RAW10_STRIDE(width) * ios_mode->height` is 32-bit (3436; also `frames_alloc` 2084 and 3161) and wraps; the SMMU mapping (sized from the ring) and the IFE's real write size then disagree, the SMMU refuses the overflow (so this is a fault, not corruption). In `smmu_up()` a mapping above 1 GiB gives `thirds > 512` and `second[... + t]` (2197) writes past the second-level page into the third-level pages of the same allocation (SMMU table corruption, not a heap overflow).

Reachable only through the table (or CAM-2's mode selection). Fix: reject modes with `frame_length <= EXPOSURE_MARGIN`, `width > 16384`, `height > 16384` in `ios_select()` and `capture_sensor()`.

### CAM-6 `keep_picture` unserialised

`HAKIOS_CAMERA_KEEP` (3959-3960 -> 3906) does `bzero(keep header)`, fills the header, `uiomove`s into `keep + 4096` and updates `loader_recording[]` with no lock. Two writers (any process) interleave: header of one picture over the data of the other, `frames = 1`. Memory-safe (same bounds, `want <= keep_bytes` is checked at 3914). Fix: take `ios_lock` (or a dedicated mutex) around the body.

### HAPTIC-2 no duty-cycle limit across taps

`HAPTIC_MAX_MS` (349) limits one LOOP state, followed by an equal rest (906-910). A TAP (waveform 1, 856-859) has no rest: iOS (or any process writing to the 0666 node) writing a burst, 30 ms of silence, another burst ... starts a new tap each time `onset_us` changes (847). Only the chip's fault flags (checked every 50 ms, 925-929) stop it. PLAUSIBLE; whether this can overheat the motor is NEEDS-HARDWARE.

### TORCH-3 30 s cap restarts on request

`waiting_for_off` is cleared when `wanted == 0` is sampled (585-587) and `since` restarts when `applied` goes from 0 to nonzero (593-596). Any writer that writes `0`, waits more than the 20 ms poll, then writes a level re-arms the light for another `max_secs`. The cap is therefore a per-request cap, not a limit; the fault/temperature checks (100 ms) stay active. Informational unless the intent was a hard on-time limit.

### DEV-1 device node permissions

`devfs_make_node(..., 0666, ...)` for hakios-torch (575), hakios-haptic (828) and hakios-camera (4000). Anything that can open a device node gets frames, light and vibration. This is the precondition for CAM-1, CAM-2, CAM-6, HAPTIC-2 and TORCH-3 being reachable by unprivileged code.

## Checked and found fine

Torch
- `torch_write` (520-533): loop reads exactly 4 bytes per `uiomove`, value clamped to 1000 (529), the current is then computed in `light()` as `125000 * permille / 1000` (no 32-bit overflow: max 1.25e8) and clamped twice (`code > ANDROID_ITARGET` 484). Nothing user-set reaches the ITARGET register unclamped. A trailing 1-3 bytes are left unconsumed (write returns short), no memory issue.
- `torch_read` (539-544): `uiomove` of `MIN(4, resid)` from a local; no leak.
- Register allow-list in `put()` (303-305, 327-333), read-back of every write (349-358), arbiter channel re-check before each write (335-338), `flash.id` check, mapping sizes: `ARB_CHANNEL(n)` and `ARB_OWNER(n)` at n <= 511 are inside the 0x1100/0x1000 mappings, observer `0x80 * 511 + 0x1c` is inside 0x10000, write channel mapped 0x1000.
- `spmi_read_once`/`show_registers`/`trouble` buffers (`r[8]`, `more[8]`, `latched[2]`, `data[2]`) sized for the counts used; `count - 1` with count 1-8 only.
- Every polling loop has a bound: `wait_done` 2 ms, retries 3, serve loop 20 ms steps, level-2 loop `secs`.
- Boot-args: `torch` (clamped 1-3, 731-734), `torch_max_s` (1..120, 687), `torch_secs` (1..max, 694); `now - since >= max_secs * 1000ull` (608) is 64-bit.
- `hakios_spmi_lock` is a spin lock held for at most one transfer (<= 2 ms); not held across `say`/sleep.
- Light is switched off in the cut path (612) and the trouble path (625) in the right order (dark before give_up), and on quiesce (750-752).

Haptic
- `haptic_write` (689-727): 512-byte stack buffer, `bytes` capped to that and made even (698-701), `uiomove` size matches; `-(int32_t)samples[i]` cannot overflow in 32 bits; shared state is `volatile` 64/32-bit, a lost update of `heard_peak` is benign. No path blocks.
- `load_waveforms` (563-621): size >= 8 checked before any index; checksum over the file; writes `file + 4 + at` in chunks of at most 32 with `n = min(32, length - at)` so never past `size`; read-back compared chunk-wise with a 64-byte local; `length = size - 4` cannot underflow. The chip's RAM capacity is NEEDS-HARDWARE, but a too-large file fails the compare and gives up.
- I2C by hand: clock stretch bound 100 x 5 us (216), bus_take restores the pins when the bus is not at rest, no unbounded loop; register read buffers sized to counts (1, 2); `regs_read` leaves caller buffers initialised (callers zero them).
- LOOP vibration stop path: cut at `HAPTIC_MAX_MS` (902-908); a stop that fails -> `give_up` -> reset pin low (352-359), which does not depend on I2C; a failed gain write or health check also gives up. Exits from `serve()` all go through `broken`. `gain_for` cannot exceed Android's 0x80 (814-816).
- Boot-args: `haptic` (clamped 5, 985), `haptic_effect` (1..10, 965).
- Quiesce puts the chip in reset (997-1003).

Camera, kernel side
- Sensor table parse (`ctab_load` 1106-1143, `ctab_block` 1146-1161, `ctab_find`): magic, `size >= sizeof(head)`, `modes` 1..16, `at + 12 > end` before each power block header, `ctab_tables + 4 > end`; every block is re-checked `at + 12 + n * 12 <= end` before use (`n * sizeof` is 64-bit so it does not wrap; the pointer arithmetic can only exceed `end` by < 51 GB, no wrap at kernel VAs); the mode array is covered by the `ctab_power` check. `sizeof(struct ctab_entry)` is 12 and `ctab_mode` 48, matching camsensor.py's packing.
- `sensor_table` (2676-2714): operation/address/data widths validated per entry (2689), `out[4]` always enough, per-entry delay clamped to 100 ms. `read_chip_id`: `in` forced to 1-4 so `id[4]` is safe, `out` is 1 or 2.
- All table-driven power kinds are validated (`power_step` 1233-1268): MCLK only 0/19200/24000, supply kinds only 1-3, others -> give up; the voltage written to an LDO can only be the one in `sensors[]` (`sensor_ldo`/`pm8008_put` allow-lists 645-653, 688-691; arrays indexed with `n <= 7`).
- Register write allow-lists: camcc (875-879), PM8008i, PMIC GPIO 3 (555-559); read-backs on all of them; off paths for camera use `force` and always run to the end (`power_down`, `ldo_off`).
- Every polling loop is bounded: `wait_done`, `wait_bits`, `wait_reg`, SMMU TLB sync (2222), clock branches (1986), `rpmh_write` (100 ms), `ios_session` (frame timeout 1.5 s, 3521), `wait_standby`, `bus_unwedge`, `capture_tpg` (2 s), `capture_sensor` (5 s).
- User commands (`camdev_write` 3942-3981): fixed 24-byte struct, size checked first; `HAKIOS_CAMERA_SENSOR` index bounds-checked (3970); EXPOSURE values are unclamped when stored but clamped before use in all three consumers (3480, 3591, 3705, 3728); FOCUS clamped to 1023 in `af_move` (3039). `keep_picture` bounds: `bytes != 0`, `d` 1-3, `stride * height <= 2 * bytes` in 64-bit, `want <= keep_bytes`, copy size `min(bytes, resid)`.
- `camdev_read` header: `bzero(&f)` before filling, `MIN(sizeof(f), resid)`, so no uninitialised bytes leave; place indexes `b < RING`; state reads/writes under `ios_lock`, the lock is not held across `uiomove`/`msleep` misuse (msleep releases it).
- Locking between ioctl-side and capture thread: shared `place[]`, `ios_ask`, `ios_given` are under `ios_lock`; `ios_switch_to`/`ios_open` etc are volatile flags; lock order is always (ios_lock) or (hakios_smmu_lock) or (spmi spin), never nested with each other. The one gap is CAM-1.
- Single reader: a reader cannot be handed the place that is being programmed for the next frame (the next place is the lowest-sequence non-READING place, the reader takes the highest unread), so I found no tearing with one reader; with two simultaneous readers I did not prove either way.
- IFE DMA is confined by an SMMU context that maps only the ring (or `frames_bytes`); the order in `ios_stop` stops the write master (`paths_down`), tears the SMMU context down and only then frees memory. Cache maintenance (`dc civac` before reads, `dsb sy`) is present where the CPU reads DMA memory.
- Idle timeout and frame timeout: a stalled sensor ends the session in 1.5 s (3521-3525).
- Boot-args: `cam` (clamped 0-5), `cam_sensor` (string compared against the fixed names, cannot index out of range), `cam_mode` (checked against `modes` in both paths), `cam_frames` (1..300), `cam_fake_fps` (1..30), `cam_keep_mb` (<= 64), `cam_settle` (masked to a byte), `cam_vblank` (<= 0x3fff), `cam_gain`/`cam_shutter` clamped before the registers are written (3091-3103, `exposure_limits`). `cam_after` is unclamped, `secs * 1000` wraps for absurd values: trusted boot-arg.
- `RPMh` command DB parse (`rpmh_resource`): `slave->count > 512` skipped, data offsets checked against the mapping, `levels[]` filled up to `max` only.

Camera, user-space side
- `isp_load_tuning` / `tune_set` (camera_isp.c:880-960): size window 8 B..16 MB, every count (`n <= 6`, `ccts <= 6`, `refs <= 16`) is checked before it is used as a loop bound or array index, every read is preceded by an `end - p` check, `memcpy(t->ref, p, refs * 12)` fits `ref[16][3]`. Gamma lookup is clamped to 0..4095 (line 411), so a NaN or huge gain from a bad file cannot index out of range. File and descriptor are released on every error path.
- `camera_device.c` worker: header size handshake and read sizes match the kernel's `ring_frame_bytes`; EIO stops the worker.

## Not checked

- The cellular modem, QMI, IPA (out of scope).
- Hardware facts: register layouts, timings, safe LED current and motor limits, whether reset stops the motor, whether RAM survives a soft reset, RPMh completion timing, SMMU attribute encodings (`CAM_PTE`, `SMMU_MAIR0`): not derivable from the repository.
- The sensor tables and the `.isp` files themselves (`fw-camera/` is not in the tree): mode sizes, delays, lane assignments are assumed from tools/camsensor.py's description. `camsensor.py` and `camtuning.py` parsing of the vendor files (host-side tools) was not reviewed, only their output format.
- The 1568-1750 stretch of hakios.camera.c (read-only `show_*` printers) and `userland/src/camera_isp.c` outside the tuning loader (demosaic, AE, AWB) and `camera_test.c`, `camera_avtest.m`: not read for safety.
- `hakios_wifi_file()`/`image_file()` (hakios.wifi.c): assumed to return a stable read-only pointer into the image; ownership and alignment not verified.
- `ml_io_map_unmappable` failure mode in `rpmh_resource` (cmd_db NULL dereference if the mapping fails): not verified.
- Behaviour with two simultaneous camera readers beyond what is said above; behaviour when `psci_smp_stop_others()` leaves a stopped CPU holding `ios_lock` or `hakios_smmu_lock` (the quiesce paths skip those locks when `leaving`, torch/haptic/camera all do).
- Interplay with the audio DSP driver's use of the RPMh TCS 0 and with hakios.speaker.c / buttons for shared pins and the SPMI arbiter beyond the spin lock.
- userland/src/inject_media.c (writes the torch node) and the camera ISP's float handling.

## Fix status

Nothing was built or run; each edit was re-read for syntax and types only.

- CAM-1: FIXED (hakios.camera.c). New `ios_readers` count (under `ios_lock`); `camdev_read` counts itself in the same lock hold that marks the place READING and takes `at` and the frame size from `ring`, `ring_place_bytes` and `ring_frame_bytes` there; it leaves the count (and `wakeup`s) in its final lock section. New `ios_drain_readers()` (waits under `ios_lock` with `msleep` until the count is 0) is called before `ring_free()` in `ios_stop()` and in `fake_session()`. Lock order: the drain holds only `ios_lock` (power is already down); nothing else nests with it. The optional "refresh `ios_last_read` while a read is in progress" was not done: the drain already makes an idle stop safe.
- CAM-2: SKIPPED. Capping the mode's pixels or fps for user-chosen modes changes the documented ABI (`HAKIOS_CAMERA_SENSOR` takes any mode), and the real mode sizes live in tables that are not in the tree. Replacing `give_up` with a fall back to the previous sensor and mode is a design change. Node mode is policy (see DEV-1).
- TORCH-1: FIXED (hakios.torch.c). `dark()` sets a `forcing` flag while it runs and `put()` ignores the `broken` latch only then (all other checks, the allow-list, the arbiter check and the read-back stay). `dark()` also tries all four steps instead of stopping at the first failure; a clean run does the same writes in the same order. Not done: the repeated dark() retry every 100 ms in `serve()` (a design change).
- TORCH-2: FIXED (hakios.torch.c). `light()` sets `lit = true` before the module-enable write; `dark()` still clears it only on success. In the torch=2 path, a failed `light(1000)` now calls `dark()` if `lit` is set. Quiesce is unchanged: it already calls `dark()` when `lit` is set, which is now true in the failing case.
- HAPTIC-1: FIXED (hakios.haptic.c). `loaded = level >= 3 && configure() && load_waveforms()` is evaluated apart from `level == 4`; level 5 calls `serve()` only when `loaded`, otherwise `give_up("the waveforms are not loaded")` (chip into reset).
- CAM-3: FIXED (hakios.camera.c). `vaf()` records `vaf_voted = on` before the RPMh request, as `rails()` does, so `af_down()` sends the "off" even if RPMh did not report done in time. Worst case is one extra harmless "off" request. Whether a late completion really happens is hardware behaviour.
- CAM-4: FIXED (hakios.camera.c). `power_step()` passes `delay_us` capped at 100000 to `sensor_delay()`, the same cap the sensor-register path uses.
- CAM-5: FIXED (hakios.camera.c). `ios_select()` rejects modes with `frame_length <= EXPOSURE_MARGIN`, `frame_length > FRAME_LINES_MAX`, width or height over 16384; `capture_sensor()` rejects width/height over 16384 and `frame_length <= 40` (EXPOSURE_MARGIN is defined later in the file, so the literal 40 as in `exposure()`). 16384 x 16384 keeps the 32-bit sizes and the SMMU third-level count in range.
- CAM-6: FIXED (hakios.camera.c). New `keep_lock` mutex (own mutex, not `ios_lock`, so the capture thread never waits on a user copy) held across the header and data writes in `keep_picture()`; never nested with `ios_lock`.
- HAPTIC-2: SKIPPED. A duty-cycle limit needs the motor's thermal limits (hardware) and is a policy change.
- TORCH-3: SKIPPED. The cap is per request by design; a hard on-time limit is a policy change.
- DEV-1: SKIPPED. Node mode 0666 is policy and was not to be changed.

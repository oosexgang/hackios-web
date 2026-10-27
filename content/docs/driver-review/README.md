# Driver review

Ten read-only audits of the kernel's drivers and of the boot loader, then one pass of fixes. The audits were done by
reading the code (nothing was run against hardware); each finding has a file and line, a failure scenario and a
confidence. A fix pass re-read every finding, called some of them not worth fixing, and changed the code only where a
fix was mechanical and safe (a bound, a wider integer, a lock, an error path). **Nothing here was tested on a phone.**
What was run: the kernel and the loader build from `drivers/` (via `xnu/apply.sh`), boot in QEMU both from the payload
device and from the volume (`QEMU_ESP=1`), and the host-side test suites pass (`tools/wpa-test` passes for the
Wi-Fi supplicant change). The phone-only paths (UFS, GPU, DSP, camera, Wi-Fi bring-up) compile, which is all that was
checked about them.

| Report | Covers | Findings | After the fix pass |
|---|---|---|---|
| [input.md](input.md) | touch, input queue, buttons | 10 | most fixed; firmware verification and the 0666 node left (below) |
| [gpu-display.md](gpu-display.md) | Adreno, IOSurface, framebuffer | 17 | surface and fence checks fixed; **G1 (no GPU command validation) left** |
| [camera-haptic-torch.md](camera-haptic-torch.md) | camera, flashlight, vibration | 12 | use-after-free read, torch latch, haptic start fixed |
| [adsp-battery-cpufreq.md](adsp-battery-cpufreq.md) | audio DSP loader, battery, cpufreq | 18 | DSP-supplied lengths and offsets bounded |
| [sound.md](sound.md) | speakers, microphone, `/dev/hakios-audio` | 16 | volume clamp, table bounds, guard arithmetic fixed |
| [wifi-bringup.md](wifi-bringup.md) | Wi-Fi subsystem start | 13 | remote lengths and offsets bounded |
| [wifi-stack.md](wifi-stack.md) | WPA2 supplicant, 802.11, WLFW | 12 | forged message 1 and last-writer-wins fixed; crypto was found correct |
| [storage.md](storage.md) | UFS, images, **the write guard** | 12 | guard held against every route tried; timeouts and bounds fixed |
| [loader.md](loader.md) | USB command parser, payload, volume read | 12 | bounds, busy state and half-read payload fixed |
| [policy-glue.md](policy-glue.md) | AMFI/MAC stand-ins, device nodes, sysctls, patch hunks | 7 | **nothing changed: decisions for the owners** |

Each report ends with a "Fix status" section: what was fixed and where, and what was left and why.

## Decisions that are not mechanical (open)

These are in the reports; they are listed here because a fix is a choice, not a repair.

1. **Persona entitlement removed from `posix_spawn`** (policy-glue P1, in `xnu/hakios.patch`). Any process can spawn
   a root child. The reason in the patch comment (nobody carries the entitlement) is out of date, because the
   code-signing stand-in now reads entitlements from signatures. Restore the check, or document the whole system as
   single-user.
2. **`PRIV_NET_PRIVILEGED_SOCKET_DELEGATE` granted to every credential** (P4, patch). Same kind of choice.
3. **Six device nodes are mode 0666** (P3: touch, audio, microphone, camera, haptic, flashlight): any process can
   read the microphone and the camera and read or forge the touch stream. They are open because every iOS daemon,
   whatever its user, has to reach them today; tightening them means choosing which user gets which node, and
   that needs the iOS user space running to check. The volume ioctl that made the audio node dangerous is fixed;
   the modes are not changed. Until this is decided, a process on this system is trusted with the sensors.
4. **GPU command streams are not validated and no `CP_PROTECT` table is written** (gpu-display G1). A client can
   make the GPU write anywhere its SMMU context reaches. Needs hardware knowledge of the Adreno's protection
   registers; until then, GPU access is as trusted as root.
5. **Touch controller firmware is downloaded without a checksum or read-back** (input F6), and its header is the
   open licensing item `hakios.focaltech_fw.h` (`tools/provenance.allow`, `COMPLIANCE.md`).
6. **Camera: a user-chosen mode can ask for a very large allocation** (CAM-2) needs an ABI decision (a maximum frame
   size).
7. **Wi-Fi: a forged message 1 before message 3 can still fail a join** (wifi-stack W1, rest of it): the proper fix
   keeps a candidate key set and needs a change to the header the supplicant shares with the 802.11 layer.
8. **The vsync notification is now sent with the framebuffer's lock held** (input/gpu fix G8). It closes a
   use-after-release of the notification port; it was not run with the iOS user space. If a deadlock shows up in
   `IOMobileFramebufferUserClient::vsync`, that is the place to look.

## What the audits did not cover

The modem drivers (left out on purpose), XNU itself, `tools/darwin-write.py`, `var_store.c`, parts of `apfs_lib.c`,
anything that needs a device on the desk (register values, timings, safe limits).

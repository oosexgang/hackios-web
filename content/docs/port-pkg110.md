# Bring-up on the connected device (branded PKG110)

Status of getting HakiOS — and the cellular path — running and debuggable on the phone attached to
this machine. Everything below was verified on the actual device or the actual files; nothing is
assumed.

## The decisive finding: it's `redwood` / SM7325, the reference platform

The connected phone reports itself as OnePlus **PKG110**, but that branding is spoofed (KernelSU +
`rezygisk` + `tricky_store`). The device tree — which the bootloader fills and which is not spoofed
— tells the truth:

```
/proc/device-tree/model = "redwood based Qualcomm Technologies, Inc. SM7325"
compatible              = qcom,yupik-idp qcom,yupik qcom,idp
ro.soc.model            = SM7325
ro.product.board        = redwood
```

**Same SoC (SM7325) and same board codename (`redwood`) HakiOS already targets as the POCO X5 Pro 5G.**
This is not a new port; it is bring-up of the existing `redwood` support on this unit. No new
`devices/<name>/` with its own SoC map, UEFI port or driver addresses is required.

### SoC args verified against the hardware

Pulled the phone's own `/sys/firmware/fdt` (via root) and ran `tools/soc-args.py` on it. Every
address it produced matches the reference `devices/redwood/soc.args`:

```
soc_ipa_base=0x1e40000   soc_gsi_base=0x1e04000   soc_ipcc=0x408000
soc_rsc=0x18220000       soc_apps_smmu=0x15000000 soc_cmd_db=0x80860000
soc_mpss_mem=0x8b800000  modem_ipa_fw_at=0x8b710000 soc_smem=0x80900000
soc_imem=0x14600000      soc_ipa_stream=0x480     soc_ipa_stream_uc=0x482
soc_pas_mpss=0x4         soc_pas_ipa=0xf          soc_ipa_fw=yupik_ipa_fws
```

Only `soc_aoss` was not emitted (its node is named differently in this unit's DT); that register is
fixed by the SoC, not the board, so the kernel's built-in SM7325 default (`0xc300000`) applies.
**No boot-arg overrides are needed on this device.**

## Firmware: pulled — after a real porting fix

The stock `devices/redwood/pull-firmware.sh` got **0 files** on this ROM. Not because anything
is missing: `/vendor/firmware_mnt` is a vfat mount owned by `system` with `fmask=0337`, and
`/vendor/firmware` is not readable by the adb shell user either, so a plain `adb pull` is refused
for every file. Under root all of it is there.

Fix: `devices/redwood/pull-firmware-root.sh` — the same pull by way of `su`, through a
world-readable staging directory in `/data/local/tmp` that is removed afterwards. Nothing on the
phone is changed. Result, verified:

| dir | contents | size |
|---|---|---|
| `fw-modem/` | `modem.mdt` + 28 segments, and `image/` (370 files: the modem's own files for TFTP) | 273 MB |
| `fw-audio/` | `adsp.mdt` + b00–b36 (38) | 21 MB |
| `fw-wifi/` | `wpss.mdt` + b00–b07 (9) | 7.3 MB |
| `fw-gpu/` | `a660_gmu.bin`, `a660_sqe.fw`, `a660_zap.*` (7) | 137 KB |
| `fw-haptic/` | `aw8697_haptic.bin` | 7.5 KB |

(837 files, 313 MB, 10.7 s. Camera firmware is not pulled: its files carry the first phone's renamed
names and are not needed for the modem or the network.)

## Bootloader

`ro.boot.flash.locked=1`, `verifiedbootstate=green`, `ro.secureboot.lockstate=locked` — but
`tricky_store` is installed, whose whole job is to report a locked/green state while the device is
unlocked. KernelSU cannot be installed on a genuinely locked bootloader of this class, so the
bootloader is almost certainly **unlocked, with its lock state spoofed**. The definitive check is
the boot test itself: `./xl enter` does a `fastboot boot`, which a truly locked device refuses.

## Running from Windows (Git Bash) — what had to be solved

- **No theos needed for a first boot.** `xl` falls back to `prebuilt/hakios-kernel` and
  `prebuilt/loader.efi` when nothing is built (`xl:50-53,120`): those are the `redwood` kernel and
  loader, i.e. for this SoC. The toolchain is only needed to build a *changed* kernel (which the
  cellular fix eventually is).
- **The iOS system image IS needed for a modem run** (a correction: the first run proved the
  earlier assumption wrong). With no ramdisk at all (`XL_RAMDISK=none`) the kernel panics before
  the modem thread starts -- `Failed to mount root device @IOKitBSDInit.cpp:926` -- because the
  modem steps run "once the root is there" (`hakios.mpss.c:6256`). And the modem's firmware is read
  from `/fw` of the system image, which `MODEM=1 userland/build.sh` fills from `fw-modem/`
  (`hakios.mpss.c:1045-1110`). The modem's own file systems (modemst1/2, fsc, fsg) do come from the
  phone's UFS (`ufs=2`), but in addition to the image, not instead of it. So the project's standard
  path applies: `sysimage/unpack.sh YOUR.ipsw` (iOS 16.5, which you supply; ~7.4 GB unpacked) and
  `PREBUILT=1 REST=1 MODEM=1 SYSTEM=1 userland/build.sh`.
- **Build in WSL's own ext4, not on `/mnt/d`.** `unpack.sh` relies on 7z leaving files named
  `NAME:com.apple.decmpfs` (finished by `unzbm`); `:` is not a legal NTFS file-name character, and
  drvfs is slow on tens of thousands of small files. A local clone in `~/hakios` plus a copy of
  `fw-*` is used; the finished `root.apfs`/`system.apfs` are copied back to the D: checkout for `xl`.
  Verified beforehand: 7-Zip 26 (>= 23 reads APFS), `cc` (builds `unzbm`), `numpy` present and
  guarded anyway; `lzfse` is not on the build path (`mkapfs.py` is stdlib-only) -- note the PyPI
  package `pyliblzfse` provides the module `liblzfse`, not `lzfse`; what the scripts import is the
  PyPI package `lzfse`. `modem_firmware.py` validated this unit's 28 modem segments against the DTB
  window to the byte (the last segment ends exactly at `0x9ae00000`).
- **`flock` is absent in Git Bash**, and `xl` wraps every `fastboot` call in it (`xl:60`) and takes a
  run lock on a file descriptor (`xl:109`). `tools/win-bin/flock` is a shim that drops the lock
  arguments and runs the command as it is (one `xl` at a time here, so the lock buys nothing).
  Verified for both forms. WSL2 would have the real `flock` but cannot see USB without usbipd.
- **`python3` is real** (3.14.7, not the Store stub); `mkpayload.py` and `mkxnuimg.py` are stdlib only.
- **The modem run payload builds locally** with the exact invocation `xl run` uses:
  16 809 392 bytes (the kernel is 16 809 112), the command line embedded. This is what gets staged.

## The build (done, verified)

In WSL's ext4 (`~/hakios`, a local clone plus `fw-*`):

- `sysimage/unpack.sh`: ~9 min. `done: 2.9G rootfs, 26M cryptex, 11M App cryptex, 2.6G dyld shared
  cache` (5.7 GB in `sysimage/`); `unzbm` built by `cc`, the LZBITMAP files finished, PingFang
  trimmed 74 -> 26 MB.
- `PREBUILT=1 REST=1 MODEM=1 SYSTEM=1 userland/build.sh`: ~4 min, exit 0. The small image got
  `fw/` from `fw-gpu fw-wifi fw-haptic fw-audio` (15 files; camera absent, not needed); the modem's
  firmware went into `system.apfs` `/fw` (`MODEM=1`, validated first).
- `root.apfs`: 2371 blocks x 4096 = 9 711 616 bytes. `system.apfs`: 641 948 blocks x 4096 =
  2 629 419 008 bytes (2.5 GB). Copied to the D: checkout's `userland/` for `xl`: sizes identical
  byte for byte, both carry the APFS container magic `NXSB` in block 0.

## The run (the project's own cellular runner)

With `userland/system.apfs` and `root.apfs` in the D: checkout, from the repository root in Git Bash:

```sh
XL_SB_DELAY=8 XL_END=android \
tools/modem-cycle-win.sh "modem=1 modem_again=1 modem_buffer=0xa8000000 modem_ipa_data_trace=1 net_trace=20" 600
```

`modem-cycle-win.sh` is `tools/modem-cycle.sh` with only its PATH lines changed. The original
prepends `tools/macos-bin`, whose `stat` and `timeout` exec `/opt/local/bin/gstat`/`gtimeout`
(MacPorts) and whose `flock` is a Python script on `fcntl` -- none of which exist under Git Bash, so
the original fails there on its first `fastboot` call (`xl:60`). The variant uses Git Bash's own
GNU `stat` and `timeout` and the `tools/win-bin/flock` shim. It does `./xl enter`, `./xl ramdisk userland/system.apfs` (~80 s), then `./xl run`
with `debug=0x8 rd=md0 hv_wdt_pet=1 bootcpu=7 cpus=8 cpufreq=1 ufs=2` plus those args, follows the
log live, prints a modem-only summary of it, and (`XL_END=android`) returns the phone to Android.
This is the full bring-up through registration and the data session; `modem_ipa_data_trace=1` and
`net_trace=20` make the QMI exchange and the first frames visible -- the evidence the fix is made from.

### What the first run showed

Booted with no ramdisk at all, the prebuilt kernel came up, then panicked at 56 s on
`Failed to mount root device` -- before any `mpss:` line. Not a modem failure: a missing root. That
run did prove the bootloader unlock, the Windows fastboot driver and the whole local pipeline.

## What this does to the phone — read before saying go

`./xl enter` **reboots the phone out of Android** into fastboot and RAM-boots the loader; `./xl run`
RAM-boots an experimental kernel for the session. **Nothing is flashed**: `./xl reboot` (or a
power-cycle) brings the phone's own Android back. If the bootloader turns out to be genuinely
locked, `fastboot boot` is refused and the phone sits in fastboot until `fastboot reboot`. It is
your daily phone, so this step runs only on your explicit go-ahead.

## After the log

Read `logs/*-run.log` → find where registration / the data session stops (QMI error codes, timing)
→ make the targeted fix in `hakios.mpss.c` / `hakios.qmi.c` → set up theos to rebuild → re-run →
iterate. The fix is made and verified only against the real on-device log; nothing here fabricates
a result.

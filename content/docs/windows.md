# HakiOS on a Windows machine

How to build and run HakiOS with a Windows PC and a phone. It works, with each tool where it fits.
Everything here was done on a real machine and phone; `tools/doctor.sh` checks the same things for you.

## What runs where

| Job | Where | Why |
|---|---|---|
| Build the images (`sysimage/unpack.sh`, `userland/build.sh`) | **WSL 2, in its own filesystem** (`~/hakios`) | `unpack.sh` makes files named `NAME:com.apple.decmpfs`; NTFS forbids `:`. The Windows drive is also slow for tens of thousands of small files. |
| Drive the phone (`./xl`, `tools/modem-cycle-win.sh`) | **Git Bash**, in your Windows checkout | `fastboot` and `adb` are Windows programs that see the phone's USB; WSL 2 does not, without usbipd. |

So: build in WSL, copy `userland/root.apfs` and `userland/system.apfs` to the Windows checkout, run `xl`
from Git Bash.

## Setup

1. **Platform-tools:** unpack Google's Android platform-tools to `C:\platform-tools` (adb, fastboot).
   fastboot worked here without a separate USB driver.
2. **WSL 2 Ubuntu:** `sudo apt install 7zip clang lld lz4 python3 git make` (7-Zip must be 23 or newer).
3. **Git Bash** (Git for Windows). Check your Windows checkout and WSL both with:
   ```sh
   tools/doctor.sh           # in Git Bash (host checks for the xl side, and the phone)
   tools/doctor.sh           # in WSL, in ~/hakios (host checks for the build side)
   ```
4. **In Git Bash**, before using `xl`: `export PATH="$PWD/tools/win-bin:/c/platform-tools:$PATH"`.
   `tools/win-bin/flock` replaces util-linux's `flock`, which Git Bash does not have and `xl` needs.

## The phone

- Turn on USB debugging. Unlock the bootloader (yours to do; it wipes the phone).
- **Trust the device tree, not the product name.** Some units report a different brand and model than
  the board they really are (root-hiding modules fake the identity and even the bootloader's
  "locked" state). `tools/doctor.sh` prints both. The supported platform is `redwood` / SM7325.
- **Firmware needs root on some ROMs.** If `devices/redwood/pull-firmware.sh` reports every file
  "not on the phone" but `doctor` says the firmware is readable only by root, use
  `devices/redwood/pull-firmware-root.sh`. It copies under `su` to a staging directory, pulls, and
  removes the staging directory; nothing on the phone is changed.

## Build and run

```sh
# WSL, in ~/hakios (a clone in WSL's own filesystem, with fw-*/ copied in):
sysimage/unpack.sh ~/iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw   # your own IPSW, ~5 min
PREBUILT=1 REST=1 MODEM=1 SYSTEM=1 userland/build.sh     # root.apfs + system.apfs, ~4 min, no theos needed
cp userland/root.apfs userland/system.apfs /mnt/d/.../hakios/userland/

# Git Bash, in the Windows checkout:
./xl enter                  # Android -> fastboot -> the loader in RAM (also the unlock test)
./xl screenshot logs/s.png  # what the loader put on the screen
./xl log                    # the loader's log
./xl reload                 # restart the phone and enter the loader again
./xl reboot                 # back to Android
```

Nothing is flashed: everything is booted from RAM, and a reboot brings Android back.

## When something goes wrong

- **`xl state` says `absent`** for more than three minutes: the phone is not on USB at all. Check the
  cable and the screen; hold power about 15 seconds to restart it into Android. `doctor` shows whether
  Windows sees any device.
- **`Failed to mount root device`** from a run: it was started without a root image. A run needs
  `system.apfs` built with `MODEM=1` if it uses the modem (`tools/modem-cycle-win.sh`).
- **`tools/modem-cycle.sh` fails under Git Bash:** use `tools/modem-cycle-win.sh`; the original puts the
  macOS helpers in `tools/macos-bin` first on `PATH`, and they do not run on Windows.

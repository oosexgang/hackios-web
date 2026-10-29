# Installing beside Android

HakiOS on the POCO X5 Pro (redwood) as a second system: Android stays where it is, and at every start a menu asks which
one to run. This page is for the person installing it. How it works underneath, and every step as it was first done and
checked, is in [U-Boot](u-boot.md).

| | |
|---|---|
| Started by | HakiOS's U-Boot in `boot_a`; it takes the loader and the kernel from memory |
| The system | the partition `darwin`, 20 GiB at the end of LUN 0 |
| Your data | HFS Plus, journaled, about 12 GB, kept between starts |
| Android | slot b, untouched |

## Before you start

You need an unlocked bootloader, a computer with `fastboot` and `adb`, and a USB cable. The system's images come from
your own copy of the firmware: none of it is in the repositories.

**The installation erases Android's data.** `darwin` is cut from the end of `userdata`, and `fastboot -w` follows. Keep
a copy of what you need, and keep the partition backup of step 1 off the phone.

## Install

1. **Back up the partitions.** From Android, as root: both slots' boot partitions, `vbmeta*`, `persist`, `modemst1/2`,
   the first and last blocks of every unit. Without this copy a broken partition table cannot be put back.

   ```sh
   python3 tools/backup-partitions.py --yes
   ```

2. **Make `darwin`.** `userdata` is shortened and `darwin` (20 GiB) made at the end of LUN 0; then Android's data is
   erased.

   ```sh
   python3 tools/userdata-carve.py --wipe backups 20
   fastboot -w
   ```

3. **Write the system volume.** The system volume and the two cryptexes from your firmware go to the start of `darwin`.
   Google's `fastboot` for Windows runs out of memory on one 8 GB image, so it is cut into pieces flashed one after the
   other.

   ```sh
   python3 tools/sparse-split.py darwin.img pieces
   fastboot flash darwin pieces/piece-00.simg     # and every other piece
   ```

4. **Make the data volume.** An empty HFS Plus volume in the rest of `darwin`. The image is about 50 KB and leaves the
   system volume alone. Flashing it again empties the data volume.

   ```sh
   python3 tools/mkdatavol.py data.simg
   fastboot flash darwin data.simg
   ```

5. **Install the boot image.** U-Boot, the loader and the kernel in `boot_a`, slot a made active: the menu comes up at
   the next start.

   ```sh
   fastboot flash boot_a hakios-install.img
   fastboot set_active a
   fastboot reboot
   ```

## The menu

The menu waits 10 seconds. With no choice it starts Android: under HakiOS the phone does not charge, so a phone that
restarts by itself is better off in Android. The volume keys move, the power key chooses.

| Entry | What it does |
|---|---|
| Android (the default) | marks slot a unbootable and restarts; ABL makes Android's slot active |
| HakiOS (Darwin) | starts the system from memory |
| HakiOS over fastboot | waits for a new kernel from the computer (development) |
| Fastboot | the phone's bootloader |
| What is in memory | what is loaded, and which slot is active |
| U-Boot shell | U-Boot's command line |
| Reset | restarts |

After Android is chosen, slot b is active and the phone starts straight into Android. To have the menu again:
`fastboot set_active a`, or, in Android with root, the service `hakios-menu.sh` (`devices/redwood/u-boot/android/`),
which does it after every boot.

## Your data

`/private/var` is the HFS Plus volume in `darwin`, right after the system: about 12 GB, kept between starts, and
replayed from its journal after a sudden power-off. If it does not mount, the system starts on a memory volume
instead: empty at every start, and Settings shows about 1 GB.

The first start on a new volume is the slowest: the system registers its applications and sets up its data. Until it
has finished, some icons and the wallpaper may be missing.

## What works

| Part | State | |
|---|---|---|
| Display, touch, the interface | works | drawn by the Adreno 642L through OpenGL ES |
| Data volume | works | HFS Plus, about 12 GB, kept |
| Wi-Fi | partly | started with `wifi=1` |
| Graphics effects | partly | the renderer lacks some of the functions a few effects use |
| Sound, vibration | off | they stop the phone when started under U-Boot |
| Cellular | no | the modem starts; nothing uses it yet |
| Charging | no | charge in Android |

## When it goes wrong

**A black screen or a hang.** Hold volume down and power until fastboot appears. From there, Android:
`fastboot set_active b`, then `fastboot reboot`.

**"Device Error" for every image.** ABL found the slots' attributes and the partitions' types out of step. Do not flash
another phone's partition table: put back your own from step 1, then `fastboot set_active` to the slot that works. The
whole recovery, step by step, is in [U-Boot](u-boot.md#which-slot-is-active-is-never-u-boots-to-change).

**What happened.** The loader writes the log of every start to the partition `logdump`; on the computer, `./xl log`
fetches it.

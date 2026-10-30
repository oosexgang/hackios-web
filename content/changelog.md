# Changelog

What changed, newest first. One line a change: the part of the system, then what is different for whoever runs it.
The commits say how; `docs/` says why.

## 2026-10-30

- site: a Changelog page, this file
- site: the commands to start with clone the public repository (`hakios-xnu-kernel`, branch `hakios`); `oosexgang/hakios` is private and cloned for nobody
- site: the documentation synced, with the guide to installing beside Android and the U-Boot page in the table of contents

## 2026-10-29

- u-boot: HakiOS's own U-Boot, started by the phone's bootloader from RAM; it starts the loader and the kernel from memory, nothing of the vendor's firmware in between
- u-boot: the loader's fastboot works under U-Boot (USB 2.0 without the link power states that dropped the cable after 3 s, endpoints and packet sizes as the loader asks, DWC3 transfers started when queued)
- u-boot: every download and every step says what it does on the screen, tagged `[oosexgang]`
- u-boot: `hakios sum` checks a flashed partition from the phone itself; `hakios reboot bootloader` gets to fastboot
- install: HakiOS beside Android: U-Boot in `boot_a`, Android in slot b untouched, a menu at every start (Android after 10 s, HakiOS (Darwin), fastboot, U-Boot's shell)
- install: choosing Android marks HakiOS's slot unbootable and lets the bootloader switch; U-Boot never changes which slot is active (changing it by hand once left every image refused with "Device Error")
- install: `tools/userdata-carve.py --wipe` makes `darwin` at the end of userdata; `tools/sparse-split.py` cuts an 8 GB image into pieces Windows fastboot can send
- storage: the data volume is HFS Plus in `darwin` after the system, about 12 GB, journaled, kept between starts; before, `/private/var` was a memory volume shown as 1 GB and empty at every start
- storage: HFS Plus built into the kernel; Apple's sources are fetched at `xnu/apply.sh`, only this port's changes are kept
- storage: the data volume's writes go straight to the flash and the cache is flushed when the journal asks (a flush and a read back after every write made the system crawl)
- storage: the loader takes any phone's `darwin` (name, type, unit, at least 20 GiB), not only the first phone's place and identifier
- storage: `tools/mkdatavol.py` makes the empty volume as a 50 KB image that leaves the system volume alone
- graphics: the installed image draws with the GPU (Mesa, `GL=1`): smooth, and the wallpaper drawn
- graphics: the system's other services and the processes that draw parts of the interface are in the image (`REST=1`): the wallpaper and the applications that need them
- graphics: frames at 120 a second (`fb_hz=120`), and `fb_measure=1` writes to the log how often the panel itself refreshes
- loader: nothing printed over the system's screen while it runs; the log still takes every line
- loader: its log written under U-Boot too; a download the computer gave up on no longer hangs it
- wifi: the Wi-Fi controller is found where the system looks for its address, so registering applications no longer waits 5 s for each (found by the ios-sapphire port)
- tree: Darwin, not iOS, in the sources, the scripts, the file names and the documentation; no file of Apple's in the repositories
- docs: installing beside Android, step by step (`docs/dual-boot.md`, in Russian too), and the U-Boot page with everything as it was done and checked

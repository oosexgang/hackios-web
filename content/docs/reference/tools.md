# Commands

Every `make` target is a script below it; run the script itself for its options (`--help`, or the comment at its top).

## make

| Target | Does |
|---|---|
| `make` | the list below |
| `make doctor` | checks this machine (and a phone on `adb`) for what HakiOS needs |
| `make unpack IPSW=F` | the OS files out of your own iOS 16.5 IPSW into `sysimage/` (nothing is downloaded) |
| `make images` | `userland/root.apfs` and `userland/system.apfs` |
| `make kernel` | the kernel from source, with the `.config`'s drivers |
| `make loader` / `make loader-open` | the boot loader with your IPSW's identity / the placeholder that boots the open kernel only |
| `make qemu` / `make qemu-open` | a session in QEMU with iOS / the open kernel with nothing of Apple's |
| `make phone` | a session on the phone with the `.config`'s arguments |
| `make firmware` | the phone's firmware off the phone (`devices/$(DEVICE)/pull-firmware.sh`) |
| `make esp` | an EFI system partition tree for a UEFI-native boot ([UEFI boot](../uefi-boot.md)) |
| `make prebuilt` | refresh `prebuilt/` from what was built |
| `make clean` | the build output of the kernel, loader and images |
| `make NAME_defconfig` | `.config` from a defconfig of any repository (`FRAGMENTS="open trace"` on top) |
| `make NAME.config` | a fragment over the `.config` |
| `make config` / `make savedefconfig` | what the `.config` is / it as a minimal defconfig |
| `make devices` | the device and SoC repositories |

## tools/

| Tool | Does | Page |
|---|---|---|
| `hakios-config.py` | defconfigs, fragments, `.config`, boot-arguments, the drivers' choice into the kernel tree | [Configuration](../configs.md) |
| `hakios-device.py` | device and SoC repositories: list, check, new, sync, lock, split | [Repositories](../porting/repositories.md) |
| `new-device.py` | a device's directory from the phone's own device tree: `soc.args`, how far the SoC code carries | [Port a device](../porting/index.md) |
| `boot-args.py` | the catalogue of every boot-argument the source reads | [Boot arguments](../boot-args.md) |
| `docs-gen.py` | the pages of this documentation made from the source | |
| `drivers-check.py` | `drivers/map` and `drivers/*/conf` agree | [Drivers in the configuration](../drivers-config.md) |
| `make-kernel.sh` | the kernel build `make kernel` runs, judged by what failed | [Building](../getting-started/building.md) |
| `kernel-version.py` | the kernel's version string, `kernel.ver` | [Versioning](../versioning.md) |
| `provenance-check.py` | nothing in the tree that must not be, and every piece of code that can write to a phone declared | |
| `metallib.py` | a `.metallib` taken apart | [AIR](../air.md) |
| `metallib-test.sh`, `metal-plugin-test.sh` | the Metal plug-in's reading of libraries and its objects, under sanitizers | [Metal plan](../metal-plan.md) |
| `modem-cycle.sh` | a whole phone session in one command | [On the phone](../getting-started/phone.md) |
| `soc-args.py` | the `soc_*` addresses out of a device tree | |
| `backup-partitions.py` | a read-only backup of the phone's partitions, each copy proven | [Install, safely](../install-safe.md) |

## xnu/

| Script | Does |
|---|---|
| `xnu/apply.sh` | Apple's XNU at the tag, with `hakios.patch`, `files/`, the drivers and the drivers' choice laid over it, into `xnu-src/` |
| `xnu/sync-drivers.sh` | the drivers edited in `drivers/` (and the SoC's and device's) into the tree |
| `xnu/export.sh` | the tree back into `hakios.patch`, `files/` and `drivers/` |

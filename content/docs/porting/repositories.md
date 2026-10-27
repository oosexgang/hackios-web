# How the repositories fit

HakiOS is put together from layers, the way an Android device's source is (`device/<vendor>/<name>`, a `<soc>-common`, a manifest
that names them):

```
hakios/              common: the kernel port, every common driver, the loader, user space, the tools, the docs
├── socs/<soc>/                  a SoC family: soc.conf, configs/<soc>.config, drivers/ of its own
├── devices/<name>/              a device: device.conf, configs/<name>_defconfig and <name>.config, drivers/, its UEFI, scripts
└── devices/manifest.conf        every SoC and device repository: kept in this tree, or a repository of its own at a revision
```

A SoC or device directory is the same whether it is kept in the common tree (`devices/qemu` is) or is a git repository of its own
that `tools/hakios-device.py sync` cloned into place (the others are): the tools look for `socs/*/soc.conf` and
`devices/*/device.conf`, whatever put them there. The common repository ignores what `sync` clones.

## A device repository

| File | What | Required |
|---|---|---|
| `device.conf` | what the device is, and how far each part works | yes |
| `configs/<name>_defconfig` | `#include common_defconfig`, `#include <soc>.config`, `#include <name>.config` | yes |
| `configs/<name>.config` | what is this device's own: drivers left out or in, arguments, `CONFIG_DEVICE="<name>"` | yes |
| `drivers/<subsystem>/conf` and the files it names | drivers of its own ([Writing a driver](drivers.md)) | no |
| `pull-firmware.sh` | the device's firmware, from your own device, into `fw-*/` | for a phone |
| `uefi/`, `prebuilt/` | the device's UEFI port and the images made of it | for a phone |
| `README.md` | anything else a person needs to know | yes |

### `device.conf`

```
device redwood
	title       POCO X5 Pro 5G
	vendor      Xiaomi
	soc         sc7280
	defconfig   redwood_defconfig
	firmware    pull-firmware.sh
	maintainer  the HakiOS developers (README.md)
	status      touch       works     Goodix GT9916 / FocalTech FT3680 on SPI, multitouch (touchscreen=1)
	status      cellular    partial   the modem boots, sees the network; no registration yet
	status      bluetooth   missing   step one only
```

| Word | Means |
|---|---|
| `title`, `vendor` | what it is called |
| `soc` | the SoC family: `socs/<soc>/` must be there; `none` for a machine without one (QEMU) |
| `defconfig` | its defconfig, in its `configs/` |
| `firmware` | the script that pulls its firmware |
| `maintainer` | who answers for it |
| `status <area> works\|partial\|missing <note>` | how far a part works, **as seen on this device**; the note says how it is turned on and what is not done. Areas: display, touch, buttons, cpu, gpu, storage, audio, battery, haptic, camera, torch, wifi, bluetooth, cellular, network, thermal, usb, sensors |

The device's page in this documentation ([redwood](../devices/redwood.md)) and the table of [all devices](../devices/index.md)
are made from it by `tools/docs-gen.py`: the status is written once, next to the code it describes.

## A SoC repository

```
soc sc7280
	title       Qualcomm SC7280 family (SM7325 "Snapdragon 778G", QCM6490; "yupik", "kodiak")
	vendor      Qualcomm
	cores       8, the biggest is core 7
	gpu         Adreno 642L
	maintainer  the HakiOS developers (README.md)
```

and `configs/<soc>.config`, the SoC's facts: `CONFIG_SOC`, its cores, and **the drivers of the SoC family**
(`CONFIG_HAKIOS_CPUFREQ=y`, `CONFIG_HAKIOS_THERMAL=y`, ...), so that every device with the SoC has them, whatever it leaves out of
its own.

## The manifest

`devices/manifest.conf` names every SoC and device:

```
soc sc7280
	repository  https://github.com/oosexgang/hakios-sc7280-common.git
	revision    

device qemu
	path        devices/qemu                       kept in the common tree

device sheng
	repository  https://github.com/<you>/hakios-device-sheng.git
	revision    0123456789abcdef0123456789abcdef01234567
```

| Command | Does |
|---|---|
| `tools/hakios-device.py list` (`make devices`) | every device and SoC, where it is, how much of it works |
| `tools/hakios-device.py check [NAME...]` | a repository holds together: its conf reads, its defconfig includes the common kernel and its SoC's fragment and passes `hakios-config.py check`, its drivers' files are there, no two repositories have a configuration of the same name |
| `tools/hakios-device.py new NAME --soc SOC --title ...` | a new device repository ([Port a device](index.md)) |
| `tools/hakios-device.py sync [NAME...]` | clone or update the repositories that live elsewhere, at their revisions |
| `tools/hakios-device.py lock NAME` | write the revision checked out into the manifest |
| `tools/hakios-device.py split NAME DIR` | a device kept in this tree, as a git repository of its own with its history, ready to push |

## How a device's own driver reaches the kernel

A driver in `devices/<name>/drivers/<subsystem>/conf` is a `CONFIG_HAKIOS_<NAME>` symbol like the common ones. `make kernel` copies
its files into the kernel tree (`xnu/sync-drivers.sh`, through `tools/hakios-config.py external-files`) and writes it into XNU's
`conf/files` as `optional`; `xnu/export.sh` leaves it out of the common patch, because it is the device's. A device repository
cannot declare `standard` files: what every kernel has is the common repository's to decide.

## Publishing a device

1. `tools/hakios-device.py check NAME` passes.
2. `tools/hakios-device.py split NAME ../hakios-device-NAME` makes it a repository of its own.
3. Push it to a repository named `hakios-device-NAME` (or `hakios-soc-SOC` for a SoC).
4. In a pull request to the common repository: its block in `devices/manifest.conf` with `repository` and `revision`
   (`tools/hakios-device.py lock NAME` writes it), and nothing else.

## Compared with others

| | Android | UniXNU | HakiOS |
|---|---|---|---|
| the shared part | AOSP, the GKI kernel | `UniXNU` (tools, components, ARM64 support) | `hakios` (the kernel port, drivers, loader, tools) |
| a SoC | `<soc>-common` | `UniXNU-<soc>-common` (`soc.toml`) | `socs/<soc>` (`soc.conf`) |
| a device | `device/<vendor>/<name>` | `UniXNU-<name>` (`board.toml`) | `devices/<name>` (`device.conf`) |
| what names them | `repo` manifest | `devices.toml` | `devices/manifest.conf` |
| a driver | kernel module, `Kconfig` | a component repository | `drivers/<sub>/conf`, an XNU `option` |
| the status of a device | nothing of the kind | a page per device | `status` lines in `device.conf`, the page made from them, checked in CI |

# Configurations: the common kernel, a SoC, a phone

A Linux kernel is configured with a `.config` made from a defconfig, and an Android kernel is put together from layers: the
common kernel's `gki_defconfig`, the SoC vendor's fragment, the device's. This kernel does the same, with one difference that
is most of the design: **most of its options are not compiled in.** XNU takes them from the boot-arguments, so most of a
configuration here is `CONFIG_*` symbols that `tools/hakios-config.py` turns into the kernel's command line. The exception is
the drivers themselves: `CONFIG_HAKIOS_<NAME>` decides whether a driver is compiled into the kernel at all, through XNU's own
`options` and `conf/files` ([drivers-config.md](drivers-config.md)), so that a device's defconfig builds the drivers that phone has.

```
configs/defconfig             what every configuration starts from: the OPEN one (nothing of a phone's own, one core)
configs/common_defconfig      THE COMMON KERNEL: every setting there is, each with what it does (about 1000 lines)
configs/sc7280.config         the Qualcomm SC7280 family (SM7325, QCM6490): eight cores, the sensors, the chip's identity
configs/redwood.config        the POCO X5 Pro 5G: its vibration motor, where its modem's buffer is
configs/redwood_defconfig     a phone: #include common_defconfig, sc7280.config, redwood.config (three lines)
configs/qemu_defconfig        QEMU's virt machine: the phone's drivers left out of the kernel (CONFIG_HAKIOS_*)
configs/open.config           fragment: the open profile (CONFIG_FIRMWARE="none")
configs/virt.config           fragment: QEMU's virt machine (virtio network)
configs/trace.config          fragment: log a line for each of the first frames on the network interfaces
configs/persist.config        fragment: keep /private/var across reboots (THIS WRITES TO THE PHONE, partition `darwin`)
configs/symbols.tsv           the symbols that are made from the source (see below); do not edit
```

The common kernel does not say which phone it is for. A phone is the common kernel plus the facts of its SoC plus its own, which
is how Android builds a device's kernel; a new device adds a fragment and a three-line defconfig, not a new copy of everything.

## Use

```bash
make redwood_defconfig                  # .config = defconfig + common_defconfig + sc7280.config + redwood.config
make redwood_defconfig FRAGMENTS=trace  # ... and a fragment on top
make common_defconfig                   # the common kernel alone, for a phone that has no fragments yet
make virt.config                        # lay a fragment over the .config there is
make config                             # show it: symbols, the kernel's arguments, the firmware it wants
make savedefconfig                      # the .config as a minimal defconfig (what differs from configs/defconfig)
make phone                              # with a .config, ITS arguments are the kernel's
```

The same without make: `tools/hakios-config.py defconfig|merge|args|check|show|needs|savedefconfig|list|listing|complete|help`.
`tools/hakios-config.py help GPU` says what a symbol means, what it needs and what it requires. `make doctor` checks the host.

## What a symbol is

`CONFIG_HAKIOS_GOODIX=y` is not an argument: it builds the touch driver into the kernel ([drivers-config.md](drivers-config.md)).
Every other symbol is one: `CONFIG_GPU=y` is the argument `gpu=1`; `CONFIG_CPUS=8` is `cpus=8`; `CONFIG_MODEM_BUFFER=0xa8000000` is
`modem_buffer=0xa8000000`. A symbol that is `# CONFIG_X is not set` is left out, and the kernel's own default applies.
Three symbols are facts about the build, not arguments: `CONFIG_DEVICE`, `CONFIG_SOC` (it goes into the kernel's version
string, see [versioning.md](versioning.md)) and `CONFIG_FIRMWARE`.

There are two kinds of symbol, and the difference is honest:

- **The stable switches** are written by hand in the `SYMBOLS` table at the top of `tools/hakios-config.py`: they have a
  meaning, a type, a range, a firmware they need, a symbol they require (`CONFIG_SOUND` requires `CONFIG_ADSP`). About thirty.
- **The rest** are made from the source. Every argument that the kernel, the loader or user space reads
  ([boot-args.md](boot-args.md)) gets a symbol, except the few that the loader and the runner set themselves (`epoch`, the time
  of the run ...). They are typed as "a switch (`y` is 1), a number as written, or a quoted text", and the one-line meaning is
  taken from the source where the file that reads the argument has a documentation line for it; where it has none, the line
  says which file reads it and nothing more. They are `configs/symbols.tsv`, made by `tools/boot-args.py --symbols`, and CI fails
  when a driver adds an argument and the file is not made again. Most of these are the knobs of bring-up (a driver's steps and
  pauses, traces, test modes); they are here so that a run is written down in one file with typos refused, not because each one
  is a feature.

## `common_defconfig`: every setting, documented

Linux's defconfigs list only what differs from the defaults. This one lists **every** symbol, set or `# CONFIG_X is not set`,
each under a comment that says what it does, in groups (GPU and display, Wi-Fi, Cellular, Storage ...). That is why it is a
thousand lines long, and why a reader of one file can see every setting the kernel has. It is made, not written:

```bash
tools/hakios-config.py listing common -o configs/common_defconfig    # after changing a value or adding a driver
tools/hakios-config.py complete common                               # it must name every symbol (CI runs this, in the tests)
```

Change a value by editing the line and running `listing common -o configs/common_defconfig` again: the file reads back the
same. Not `listing common > configs/common_defconfig`: the shell empties the file before the tool reads it, and what is written is
then `configs/defconfig` alone. That is how `common_defconfig` once lost the values of the phone line (the GPU, Wi-Fi, audio and
modem switches, `CONFIG_FIRMWARE="device"`), and why `-o` exists.

## `#include`: putting a device together

A line `#include NAME` in a defconfig or fragment (a comment to any other reader) stands for `configs/NAME`, `NAME_defconfig` or
`NAME.config`, laid first; the including file wins over what it includes; a loop is an error. This is the whole of
`redwood_defconfig`. The order for `make redwood_defconfig` is `defconfig` (open, one core), then the common kernel, then the
SoC, then the phone, then the fragments you named.

## What is checked, and why

- **Types and ranges.** A bool is `y` or not set, a hex number starts with `0x`, `CONFIG_CPUS` is 1 to 8, `CONFIG_THERMAL_STOP`
  is 0 to 160. A typo in a name gets a suggestion (`no symbol CONFIG_GPUU (did you mean CONFIG_GPU?)`).
- **Dependencies.** `CONFIG_VAR_STORE` requires `CONFIG_UFS_WRITE`, which requires `CONFIG_UFS=2`; `CONFIG_SOUND` requires
  `CONFIG_ADSP`; `CONFIG_THERMAL_STOP` requires `CONFIG_THERMAL`; the modem requires the storage service.
- **Firmware.** `CONFIG_FIRMWARE="none"` is the open profile: *nothing of the phone's own is loaded.* The check refuses
  a configuration that says `none` and still asks for the GPU, Wi-Fi, audio, haptics, cameras or the modem, because each
  of those uses firmware pulled from the owner's own phone (`fw-*/`, never in this repository).
- **The command line fits.** The kernel's boot line holds 607 characters, and a longer one loses its tail without an
  error. The check counts the arguments, adds what a run adds itself (about 260) and refuses what cannot fit.

## `CONFIG_BOOTARGS`: Linux's `CONFIG_CMDLINE`

For an argument that has no symbol of its own, or a value the symbols cannot say: `CONFIG_BOOTARGS="fb_beat=2 loader_return_after=5"`. It is not an
escape from the checks. Every name must be one the source reads ([boot-args.md](boot-args.md)), so `fb_beet=2` is an error with a
suggestion rather than a silent no-op; an argument that a symbol already sets (`cpus=8`) is refused with the name of the symbol; a
word is `name=value` with no space, quote or backslash in it; and the words count towards the 607 characters.

## What is the same as Linux, and what is not

| | Linux / Android | here |
|---|---|---|
| the common kernel | `gki_defconfig` | `common_defconfig` |
| a SoC, a device | vendor and device fragments, `build.config` | `sc7280.config`, `redwood.config`, `#include` |
| a fragment | `kernel/configs/*.config`, `merge_config.sh` | `configs/*.config`, `make NAME.config` |
| the result | `.config`, compiled in | `.config`: the drivers compiled in (`CONFIG_HAKIOS_*`), the rest becomes the boot-arguments |
| a driver's options | `Kconfig` + `obj-$(CONFIG_X) += x.o` | `drivers/<subsystem>/conf`, XNU's `options` and `optional` in `conf/files` |
| a minimal config | `make savedefconfig` | `make savedefconfig` |
| a command line baked in | `CONFIG_CMDLINE` | `CONFIG_BOOTARGS` (names checked) |
| an option that needs a blob | `CONFIG_EXTRA_FIRMWARE` | `CONFIG_FIRMWARE="device"` / `"none"`, and `needs` |
| the version | `uname -r` | `kern.hakios.version`, `kernel.ver=` |
| how many options | thousands, in Kconfig | about 310, one for each argument the source reads |

The last row is the honest one. This is not Kconfig and has no thousand options: apart from which drivers it has, the kernel is not
built from its options. The number of symbols is the number of arguments the code reads, plus one for each driver.

## A new device

`tools/new-device.py` makes `devices/<name>/` from a phone's own device tree. Its configuration is a fragment and a defconfig of a few
lines: `configs/<name>.config` with what is true of that phone only, and `configs/<name>_defconfig` that includes the common kernel, the
SoC's fragment and that one, and nothing more until the phone has been shown to do it. The fragment is also where the phone leaves out
the drivers of hardware it does not have or that has not been ported to it (`# CONFIG_HAKIOS_GOODIX is not set`: see
[drivers-config.md](drivers-config.md)).

## What a configuration does not do

It does not make a driver exist, and it does not make a driver work on a phone it was not written for. A symbol builds
in, or turns on, a part of the kernel that is already there; whether it works on a given phone is what [the device's page](../devices)
and the tests say, and the project does not claim a result it has not seen.

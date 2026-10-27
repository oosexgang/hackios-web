# Architecture

HakiOS is three programs of its own between a phone's firmware and a user space: a UEFI application that loads the kernel, the
kernel (Apple's XNU with this port), and the drivers inside it. Everything else is either the phone's (its UEFI, its firmware) or
yours (the user space you lay out).

## A boot, from the button to the home screen

```
 Android's fastboot        HakiOS UEFI              xnuloader              XNU + HakiOS             launchd       user space
 (the phone's own)   -->   (Mu-Silicium with   -->  (loader.efi,     -->   (xnu/, drivers/)   -->            -->   (yours: iOS 16.5,
  fastboot boot             HakiOS's changes,        xnuloader/)            drivers started                       or userland/hello)
                            uefi/ + the device's)    reads the payload      by boot-arguments
```

| Step | What happens | Where it is |
|---|---|---|
| 1. into RAM | Android's fastboot receives a boot image and runs it; nothing is flashed | `./xl enter` |
| 2. UEFI | HakiOS's UEFI (Mu-Silicium with HakiOS's changes and banner, and the phone's platform) starts on the SoC, shows the HakiOS logo, offers the framebuffer and storage, and starts the loader from the image | `uefi/`, `devices/<name>/uefi/` |
| 3. the loader | `xnuloader` reads the payload (the kernel, the command line, `kernel.ver`), lays out memory and the device tree the kernel expects, keeps a service for the storage, starts the kernel; at the end of a run it takes control back | `xnuloader/` |
| 4. the kernel | XNU with this port: Apple's patched files (`xnu/hakios.patch`), new ones (`xnu/files/`), the drivers (`drivers/`) | [Building](../getting-started/building.md) |
| 5. the drivers | each one does nothing until its boot-argument asks; those the configuration left out are not in the kernel at all | [Drivers in the configuration](../drivers-config.md) |
| 6. user space | launchd starts what the system image holds: iOS 16.5's (layer 2, yours), or `userland/hello` for the open kernel | `userland/` |

## How a configuration becomes a kernel and a command line

```
 configs/common_defconfig                 (common)
 devices/redwood/soc/configs/sc7280.config  (SoC)      make redwood_defconfig
 devices/redwood/configs/redwood.config      (device)   ------------------------->  .config
                                                                                    |
               CONFIG_HAKIOS_*  ->  tools/hakios-config.py kernel  ->  XNU's options (config/MASTER.hakios, conf/files)  ->  make kernel
               every other CONFIG_*  ->  tools/hakios-config.py args  ->  the kernel's boot-arguments  ->  make phone, ./xl run
```

Two kinds of symbol: `CONFIG_HAKIOS_<NAME>` decides whether a driver is compiled in, through XNU's own option mechanism; every other
`CONFIG_` symbol is a boot-argument, because XNU takes its knobs from the command line. One `.config` gives both.
[Configuration](../configs.md) and [Drivers in the configuration](../drivers-config.md) have the detail.

## Common, SoC, device

What is true of every device is the common repository's; what is true of a SoC family, the SoC's; what is true of one device, that
device's. A device's defconfig is three lines: the common kernel, its SoC's fragment, its own.
[How the repositories fit](../porting/repositories.md).

| Layer | Has | Example |
|---|---|---|
| common | the kernel port, every driver, the loader, user space, the tools, the documentation | this repository |
| SoC | the SoC's facts (cores, addresses that are the family's), its drivers; carried by each device that has the SoC | `devices/redwood/soc` |
| device | its defconfig, its status, its UEFI platform, its firmware script, drivers of its own | `devices/redwood` |
| UEFI | Mu-Silicium with HakiOS's boot path, banner and name | `uefi` ([its README](https://github.com/oosexgang/hakios/blob/main/uefi/README.md)) |

## What is written to the phone

| What | When | Where |
|---|---|---|
| the loader's log, a few KB | at the end of every run | the `logdump` partition |
| `/private/var` | only with `ufs_write=1 var_store=1` | the partition `darwin`, which you create yourself (`tools/userdata-carve.py` prints the commands; it changes nothing) |
| anything else | never | the loader refuses every other write; `tools/provenance.allow` lists each piece of code that can write, and why |

[LEGAL.md](https://github.com/oosexgang/hakios/blob/main/LEGAL.md) has the same, with what is and is not distributed.

## Where the code is

| Directory | What |
|---|---|
| `xnu/` | the kernel: `hakios.patch` (Apple's files, changed), `files/` (new files), `apply.sh`, `export.sh` |
| `drivers/<subsystem>/` | the drivers, by subsystem, each with its `conf` ([reference](../reference/drivers.md)) |
| `xnuloader/` | the boot loader (a UEFI application, no EDK2) |
| `userland/` | programs and libraries of our own (`src/`), the Metal plug-in, the image build, launchd jobs |
| `configs/` | the common kernel's configuration and the generic fragments |
| `devices/` | the device repositories (each with its SoC's layer in `soc/`), and `devices/manifest.conf` |
| `sysimage/` | scripts that fetch and unpack the OS files from the IPSW (none of the files) |
| `tools/` | configuration, devices, checks, APFS, firmware, QMI, the run scripts |
| `qemu/` | running in QEMU |
| `prebuilt/` | the kernel, loader and libraries built from this source |

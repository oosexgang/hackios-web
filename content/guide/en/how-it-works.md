# How it works

From the power button to an app, every step of hakios is a small program with one job. This page walks the chain once, so the rest of the guide makes sense.

## The boot chain on the phone

```text
the phone's own boot loader (fastboot)
   └─ fastboot boot  ──►  HakiOS UEFI (Mu-Silicium)  or  HakiOS U-Boot      ← in RAM, nothing flashed
                              └─ loader.efi  (xnuloader)
                                    └─ XNU  (hakios-kernel)  + drivers chosen by .config
                                          └─ launchd  ──►  the Darwin user space you supplied
```

1. **The phone's boot loader.** With the boot loader unlocked, `fastboot boot` takes an image over USB and runs it from RAM. `./xl enter` does this for you.
2. **HakiOS UEFI or HakiOS U-Boot.** A small firmware that sets up the screen and memory. A shim copies our payload to `0xF0000000`, and the firmware starts `loader.efi` from it. If you have not built Silicium with your phone's vendor drivers, `xl` uses U-Boot, which needs no vendor files.
3. **The loader** (`xnuloader/`). It talks fastboot itself (it shows up as `product: xnuloader`), receives the kernel, the system image and the boot arguments, builds the device tree XNU expects and starts the kernel. When the run ends it writes its log to `logdump` and waits for the next command.
4. **XNU with our drivers.** Apple's kernel, patched (`xnu/hakios.patch`) and with our drivers built in: touch, storage, GPU, audio, Wi-Fi, modem and more. Each driver starts only if its boot argument is on.
5. **launchd and the user space.** The first process. From here on it is the Darwin user space built from your own restore image, plus our small programs and libraries in `/redwood`.

## The boot chain in QEMU

The same kernel and loader run in QEMU's `virt` machine (Cortex-A76, GICv3, UEFI from edk2). Instead of phone drivers, four virtio drivers: input, block storage, sound and network. The *open* kernel needs nothing of Apple's; the full Darwin user space in QEMU needs your restore image, like the phone.

## One configuration, two outputs

```text
configs/common_defconfig     ← every device
socs/<soc> fragment          ← the chip family, e.g. sc7280.config
devices/<name> fragment      ← the phone, e.g. redwood.config
            │
            ▼   make redwood_defconfig
         .config
       ┌────┴─────────────────────────────┐
CONFIG_HAKIOS_ADRENO=y          CONFIG_GPU=y
→ the driver is built in       → gpu=1 on the command line
```

- `CONFIG_HAKIOS_<NAME>=y` builds a driver into the kernel.
- Every other `CONFIG_<NAME>` becomes a boot argument: `CONFIG_GPU=y` is `gpu=1`, `CONFIG_HAPTIC=5` is `haptic=5`.
- `make config` checks the file and tells you what is wrong and why. The command line has a limit of 607 characters, and the check counts it for you.
- `tools/hakios-config.py help GPU` explains any symbol.

## What lives where

| Repository | What is in it |
|---|---|
| [hakios-xnu-kernel](https://github.com/oosexgang/hakios-xnu-kernel) | the kernel port, every common driver, the loader, our user-space programs, the tools, `xl`, the reference docs |
| [hakios-sm7325](https://github.com/oosexgang/hakios-sm7325) | POCO X5 Pro 5G: its `device.conf`, configuration, firmware script, UEFI platform and the SC7280 chip layer |
| [hakios-uefi](https://github.com/oosexgang/hakios-uefi) | HakiOS UEFI: Mu-Silicium at a pinned commit, with our boot path, name and logo |
| [hakios-metal](https://github.com/oosexgang/hakios-metal) | Metal's command model on the Adreno GPU, in C++ |
| [hakios-mt6768](https://github.com/oosexgang/hakios-mt6768) | an experimental MediaTek port (Infinix Hot 20), with its own loader |

`tools/hakios-device.py sync` clones the device repositories and the UEFI into the main tree (`devices/<name>/`, `uefi/`) at the revisions pinned in `devices/manifest.conf`.

## What is written to the phone

By default, only the loader's log (a few KB) to the `logdump` partition at the end of each run. The kernel writes to storage only if you ask with `ufs_write=1`, and then only to a partition named `darwin` that you create yourself; everything else is refused. The list of everything that may write is checked in CI (`tools/provenance.allow`).

> **The exception is the dual-boot install.** [Installing beside Android](/docs/dual-boot) flashes `boot_a`, shrinks `userdata` and erases Android's data. It is a separate, manual procedure; nothing in this guide does it.

## The three layers, legally

1. **The open core**: the kernel port, loader, drivers and tools. Source code, builds and runs with nothing of Apple's and nothing of any phone's.
2. **The user space you supply**: the project ships none of it and does not decrypt or patch anything to get it. Whether you may use it on this hardware is your decision and your responsibility.
3. **Apple's services**: not supported, and a change that tries to make a device pass as an iPhone to Apple's servers is refused.

Licences: the changes to XNU and the drivers are under the Apple Public Source License 2.0, like XNU; everything else of ours is MIT.

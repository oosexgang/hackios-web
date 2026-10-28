# HakiOS

**Apple's open-source Darwin kernel (XNU) on Android phones with a Qualcomm SoC**, the way Android is Linux on phones: a boot
loader of its own, drivers of its own, a configuration system and a version of its own. The same kernel runs in QEMU with nothing
of Apple's and nothing of any phone's.

Where to start:

- [Getting started](getting-started/index.md): the open kernel in QEMU in a few commands, or the iOS 16.5 user space you lay
  out yourself.
- [On the phone](getting-started/phone.md): the POCO X5 Pro 5G, in RAM with `fastboot boot`, back to Android with a reboot.
- [Port a device](porting/index.md): a device is a repository of its own over the common one: a defconfig, a status file, its
  drivers.
- [Reference](reference/drivers.md): every driver, configuration symbol and boot argument, made from the source.

## What works

The table is made from the devices' own `device.conf`: [all devices](devices/index.md).

| | POCO X5 Pro 5G (`redwood`) | QEMU `virt` |
|---|---|---|
| Lock screen, home screen, the stock apps | yes | yes (slow: the CPU is emulated) |
| Touch, buttons | yes | yes (the mouse and the keyboard) |
| GPU (OpenGL ES through Mesa) | yes | no |
| Metal | partly: a device that Metal loads (seen in QEMU); buffers and libraries written, checked on a Mac only; nothing drawn ([plan](metal-plan.md)) | partly, the same |
| Wi-Fi | yes | yes (virtio-net) |
| Sound, microphone | yes | sound only (virtio) |
| Cameras, vibration | yes | no |
| Flashlight, temperature guard | partly: written, some of it seen ([redwood](devices/redwood.md)) | no |
| Cellular | partly: the modem is up and sees the network; no registration yet ([cellular](cellular.md)) | no |
| Bluetooth | no | no |

## The three layers

1. **The open core**: the kernel port, the loader, the drivers, the tools. All source, in these repositories.
2. **What you put on top**: the kernel can start a user space you supply; it was built so that it can start iOS 16.5's, which you
   lay out yourself from Apple's own download. None of it is in the repositories.
3. **Apple's services** (activation, Apple ID, iCloud, the App Store): not supported and not a goal.

By default nothing is installed: the loader goes into RAM, the system lives in RAM for a session, a reboot gives the phone back to
Android. What is and is not written to a phone: [Architecture](concepts/architecture.md#what-is-written-to-the-phone).

## The repositories

| Repository | What |
|---|---|
| [hakios](https://github.com/oosexgang/hakios) | **common**: the kernel port, every common driver, the loader, user space, the tools, this documentation, and `devices/qemu` |
| [hakios-sm7325](https://github.com/oosexgang/hakios-sm7325) | POCO X5 Pro 5G: its defconfig, status, UEFI platform, firmware script, and its SoC's layer (`soc/`: the Qualcomm SC7280 family) |
| [hakios-uefi](https://github.com/oosexgang/hakios-uefi) | HakiOS's UEFI: Mu-Silicium with HakiOS's boot path, banner and name |

`devices/manifest.conf` in the common repository names each one and the revision it is at; `tools/hakios-device.py sync` clones them
into `devices/` and `uefi/`. One repository per device: it carries its SoC's layer, and `tools/hakios-device.py new` makes one. [How the repositories fit](porting/repositories.md).

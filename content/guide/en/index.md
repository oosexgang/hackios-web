# Start here

hakios runs Apple's open-source Darwin kernel (XNU) on Android phones, the way Android runs Linux: with its own boot loader, its own drivers and one configuration per device. This guide takes you from nothing to a running kernel, then to Metal and to your own phone.

## What you can do with it

| You want to… | Read | You need |
|---|---|---|
| see it boot, today, with nothing to lose | [Run it in QEMU](qemu.md) | a computer, 30 minutes |
| understand the pieces before touching anything | [How it works](how-it-works.md) | nothing |
| run it on a real phone | [Run it on a phone](phone.md) | a POCO X5 Pro 5G with an unlocked boot loader |
| talk to the GPU through Metal | [Metal](metal.md) | the phone, or just a computer for the tests |
| bring hakios to another phone | [Adapt it to your device](your-device.md) | an ARM64 phone, patience |
| fix a run that went wrong | [When something goes wrong](troubleshooting.md) | the log |

## Three things to know first

1. **Nothing is installed by default.** The phone boots hakios from RAM with `fastboot boot`. A reboot gives you Android back. The only thing written is the loader's own log, a few kilobytes, to the `logdump` partition.
2. **The open core is ours, the system on top is yours.** Our repositories hold the kernel port, the loader, the drivers and the tools. The Darwin user space (lock screen, home screen, apps) comes from an Apple restore image that *you* supply; none of it is in our repositories, and nothing downloads it for you.
3. **Apple's services are not a goal.** Activation, Apple ID, iCloud and the App Store do not work and will not be made to work.

## What works today

| | POCO X5 Pro 5G | QEMU |
|---|---|---|
| Lock screen, home screen, stock apps | yes | yes, slowly |
| Touch and buttons | yes | yes |
| GPU (OpenGL ES through Mesa) | yes | no (software drawing) |
| Wi-Fi | yes | network (virtio) |
| Speakers, microphone, battery level | yes | sound |
| Cameras, vibration | yes | no |
| Metal | started: buffers, command buffers, GPU blits | started |
| Cellular | partly: the modem boots and sees the network | no |
| Bluetooth | no | no |
| Charging while hakios runs | no | — |

The full table for each device is generated from its own status file: see [all devices](/docs/devices).

## The words you will meet

- **XNU**: the kernel of Apple's systems; its source is public. hakios uses tag `xnu-8796.121.2`.
- **Loader** (`xnuloader`, `loader.efi`): our UEFI program that puts the kernel, the boot arguments and the device tree in memory and starts XNU.
- **UEFI**: the small firmware that starts the loader. On the phone it is HakiOS UEFI (Mu-Silicium) or HakiOS U-Boot, both started from RAM.
- **`xl`**: a script in the main repository that drives the loader on the phone over USB: enter, send the system image, run, fetch the log, reboot.
- **Boot arguments**: switches on the kernel's command line, like `gpu=1`. Every hardware driver does nothing until its argument is given.
- **`.config`**: one file that says which drivers are built into the kernel *and* which boot arguments a run gets. `make redwood_defconfig` writes it.
- **Device repository**: everything about one phone (configuration, status, firmware script, UEFI platform) in its own repository, like `hakios-sm7325`.

## Where to get help

The project's Telegram has an AI thread for questions and the team reads it: [t.me/oosexgangdevs](https://t.me/oosexgangdevs). When you ask, attach `logs/last.log` and say which command you ran.

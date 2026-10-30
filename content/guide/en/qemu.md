# Run it in QEMU

The fastest way to see hakios boot: the open kernel in QEMU needs no phone and nothing of Apple's. Then, if you want the lock screen and the home screen, the full Darwin user space runs in QEMU too.

## 1. The open kernel (10–30 minutes)

### What you need

| | Linux x86-64 | macOS (Apple silicon) | Windows |
|---|---|---|---|
| build the kernel and the loader | yes | yes | in WSL 2 |
| run QEMU | yes | yes, see the note below | in WSL 2 |

- `git`, `python3` 3.8 or newer, `clang`, `lld-link`, `make`
- `qemu-system-aarch64` with UEFI firmware for it (`edk2-aarch64` or `AAVMF` on Linux; on macOS `brew install qemu` brings `edk2-aarch64-code.fd`)

`make doctor` checks all of this for you and prints what is missing and how to get it. It changes nothing.

### Steps

```sh
git clone https://github.com/oosexgang/hakios-xnu-kernel.git hakios
cd hakios
make doctor          # what this machine lacks, and what to do
make qemu-open       # builds what is missing, then boots
```

`make qemu-open` builds the kernel, a loader with a placeholder identity and a tiny user-space program, then starts QEMU for 600 seconds. The log goes to `logs/qemu-open.log`.

### What you should see

```text
== XNULOADER v3 ==
hakios-kernel: version 2.1.13-hakios ...
hakios-kernel: N drivers built in (...)
Hello from user space on Darwin!
```

The last line is printed by `userland/hello`, a static program that talks to the kernel with raw system calls and reads `sysctl kern.hakios.version`. If you see it, the kernel, the loader and user space all work on your machine.

> **On macOS** QEMU's UEFI is not found automatically: point the run at Homebrew's files.
> ```sh
> export QEMU_EFI=$(brew --prefix qemu)/share/qemu/edk2-aarch64-code.fd
> export QEMU_VARS=$(brew --prefix qemu)/share/qemu/edk2-arm-vars.fd
> ```
> The run script also calls GNU `timeout`: `brew install coreutils` provides it.

### Useful knobs

| Variable or target | What it does |
|---|---|
| `make qemu_defconfig` then `make qemu-open` | a kernel with only QEMU's four drivers instead of all 25 |
| `make qemu-open SECS=120` | a shorter session |
| `QEMU_MEM=4G make qemu-open` | the memory QEMU gets (default 6 GB) |
| `QEMU_SMP=4 make qemu-open` | more cores (default 1) |
| `make qemu-u-boot` | the same payload, started through HakiOS U-Boot instead of the UEFI shell |

## 2. The full Darwin user space (about an hour)

This is the lock screen, the home screen and the stock apps, in a window on your computer. It needs things the open kernel does not.

- **Linux x86-64** (the run script reads `/proc/meminfo`), about 12 GB of free disk, 7 GB of free RAM
- `7z` 23 or newer, `lz4`, `qemu-system-aarch64` 7.0 or newer with `ramfb`
- **your own copy** of the restore image `iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw` (6,165,698,198 bytes). hakios does not download it and does not ship any of it.

```sh
make doctor
sysimage/unpack.sh ~/iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw   # the parts we need, about 7.4 GB
REST=1 userland/build.sh      # the system images: userland/root.apfs and userland/system.apfs
make loader                   # the loader, with the identity taken from your restore image
mkdir -p logs
qemu/run-darwin.sh 1200 -display gtk > logs/qemu.log     # a 20-minute session
```

What happens: a black window for about a minute, the Apple logo for about a minute, then the home screen after roughly five minutes on a fast desktop. QEMU emulates the CPU, so everything is slow; that is expected.

| In the QEMU window | Is |
|---|---|
| the mouse | your finger |
| `H` | Home |
| `L` | the power button |
| arrow keys | volume |

Network: `QEMU_NET=1 qemu/run-darwin.sh ...` gives the system a virtio network card as `en0`.

## Next

- To run the same thing on a phone: [Run it on a phone](phone.md).
- To try Metal in QEMU: [Metal](metal.md#try-it-in-qemu).
- A black window that stays black, or a log that stops: [When something goes wrong](troubleshooting.md).

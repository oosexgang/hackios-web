# UEFI boot

HakiOS can start the way a UEFI operating system starts: the firmware runs `\EFI\BOOT\BOOTAA64.EFI` from a volume,
that loader reads the kernel from the same volume, and nothing else is needed: no fastboot, no host computer.

Status in one line: **works in QEMU (checked); not tried on a phone.** The sections below say exactly what was run.

## Three ways a payload reaches the loader

The payload is what the loader starts: the kernel, a small root image, the command line and `kernel.ver`
(`xnuloader/mkpayload.py`). The loader takes a payload that is already in memory first, and looks on the volume
only when there is none.

| Way | How | Where | Checked |
|---|---|---|---|
| `fastboot boot` | `./xl enter`: a boot image holding Project Silicium's UEFI, a shim and the payload; the shim copies the payload to `0xF0000000` | the phone | yes: the loader started on the attached phone, its banner was read back from the screen and from the log |
| a loader device | QEMU's `-device loader` puts the payload at `0xF0000000` (`make qemu-open`) | QEMU | yes |
| **a file of the volume** | the loader opens the volume it was started from and reads `\EFI\hakios\payload.bin` itself | any UEFI that starts the loader from a volume | **in QEMU only** (AAVMF) |

## The volume

```
EFI/BOOT/BOOTAA64.EFI       the loader, where an AArch64 UEFI boots a removable volume from
EFI/hakios/payload.bin      the payload
EFI/hakios/kernel.ver       the version, as text, for a person to read
```

`make esp` makes the tree in `build/esp` (`tools/mkesp.py`, which refuses what the loader would refuse: not a payload,
no kernel in it, over 63 MiB, a loader that is not an EFI application, a directory that is not empty). Copy it to a
FAT32 volume, or serve it to QEMU.

## Try it (QEMU, nothing of Apple's closed software: `make doctor` first)

```sh
make qemu-open                    # builds the kernel, the open loader, hello, and boots them (the payload device)
QEMU_ESP=1 qemu/run.sh 90         # the same payload, but as the file \EFI\hakios\payload.bin: no loader device
make esp                          # the tree for a real volume: build/esp
```

What `QEMU_ESP=1` prints under the banner: `payload: 15306944 bytes from \EFI\hakios\payload.bin on the volume this
loader was started from`, then the kernel boots and `hello` reads the same version through `sysctl kern.hakios.version`.
A file that is not a payload gives `is not a payload (no XNUP at its start)`, and no file gives `there is no
\EFI\hakios\payload.bin on the volume`, each with `kernel.ver=unknown` and no crash (both were run).

## Limits

- **63 MiB.** The loader's payload region is 64 MiB and its last MiB holds the panic log. The kernel is about 15 MiB;
  the **big iOS system image (2.5 GB) does not come this way**. It comes over USB (`xl ramdisk`, once per loader
  session) or, in the flash recipe, from the partition `darwin` (`docs/install.md`).
- **The region has to be free.** The loader takes all 64 MiB of it with `AllocatePages(AllocateAddress)` (not only the
  pages the file fills: a payload sent over USB later, and the panic log, are written into the rest). A firmware that
  keeps it reserved refuses, and the loader says so and goes on without a payload, as it always did. A file that
  cannot be read to its end is dropped, and its header is wiped, so a half-read payload is never started.
- **Nothing is signed.** The loader is not signed and no Secure Boot is involved.

## On a phone: what is known and what is not

- Project Silicium's Boot Manager, in this port, is changed to start the XNU loader **from the container the shim
  leaves in memory instead of a menu** (`uefi/README.md`). It does not look for a loader on a
  volume. So the file-of-the-volume way has **not** been tried on the phone, and it needs a change to the Boot
  Manager (or a UEFI that boots from a volume) before it can be.
- Whether Silicium leaves `0xF0000000` free at the point where the loader runs is not known.
- The way to a phone that does not need a host today is the boot image itself, in a boot slot: `docs/install.md`.

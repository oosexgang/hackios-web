# HakiOS next to the other XNU-on-a-phone projects

There are other projects that put Apple's open-source XNU on hardware that is not Apple's. This page says, as plainly
as it can, where this one is different. It is written from their public README pages as read on 2026-10-27; they
change, so read theirs, and tell us if a line here is out of date or wrong
(an issue is enough). Where the table says something about **our** runtime state, it is what
this repository's README claims; the things this repository has *tested* are marked.

| | [ios-sweet](https://github.com/dipa-studio/ios-sweet) | [UniXNU](https://github.com/UniXNU/UniXNU) | [Bergamota](https://github.com/ry-diffusion/bergamota) | HakiOS |
|---|---|---|---|---|
| What it is | one phone, bring-up of iOS 16 | a general UEFI environment for iOS/macOS on ARM64, in the manner of OpenCore | one phone, bring-up of iOS 18 (a fork of ios-sweet) | a Darwin kernel port with its own loader and driver set, and a Linux-style configuration system |
| Hardware | Redmi Note 10 Pro (SM7150) | Xiaomi Pad 6S Pro (SM8550), shared SoC code | Poco F1 (SDM845) | POCO X5 Pro 5G (SM7325), and a generator for a new device from its own device tree |
| Kernel | Apple's open xnu-8796 | not stated on its page | xnu-11215 ("Heartwood") | Apple's open xnu-8796.121.2 |
| Boot | `fastboot boot` of a shim; HFS+ root in `userdata` | UEFI | its own bootloader from `boot` | `fastboot boot` (RAM only), or a UEFI loader that reads its payload from the volume it was started from (tested in QEMU; not yet on a phone) |
| Licence of its code | MIT | BSD-2-Clause-Patent | none stated on the page | MIT; kernel changes APSL 2.0 |
| Says it ships Apple binaries | no | not stated | no | no, and CI fails if a binary of a kind that cannot be ours is added |

## What this project does that the others' pages do not describe

These are things that exist in this repository and that a reader can check:

- **A configuration system, like Linux's.** `configs/defconfig`, `configs/<device>_defconfig`, fragments, a `.config`,
  `savedefconfig`, and dependency and length checks ([configs.md](configs.md)). A kernel that is configured by its
  command line gets a file format for it, with the typo caught before the boot rather than after.
- **A version string that says what it is built from**, shown by the loader and by `sysctl kern.hakios.version`
  ([versioning.md](versioning.md)).
- **A catalogue of every boot-argument**, made from the source by a scanner, checked in CI, so the list cannot go
  stale ([boot-args.md](boot-args.md), 300+ arguments).
- **An open configuration that needs nothing of Apple's and nothing of the phone's**: `make qemu-open` boots the kernel
  with its own userland and prints the banner, `kern.hakios.version` and a hello. This is the part anybody can
  contribute to without touching an IPSW or a firmware file. (Tested.)
- **A provenance guard** (`tools/provenance-check.py`, in CI): it refuses a binary that is not explained, a file of
  a kind the project promises never to carry, and a writer to the phone's flash that is not declared. The answer to
  "what exactly does this write to my phone?" is a file you can read ([legal-review.md](legal-review.md),
  [LEGAL.md](../LEGAL.md)).
- **Its own loader, its own drivers**: GPU (Mesa over a Darwin driver), Wi-Fi, audio, haptics, cameras, touch, storage,
  modem bring-up. [driver-review/](driver-review/README.md) says what each is, and what has and has not been verified.

## What the others have that this one does not

- ios-sweet and Bergamota are small enough to read in an afternoon, and Bergamota targets a newer iOS (18) with its
  own tool for the arm64e/pointer-authentication gap. HakiOS targets the iOS 16.5 generation, whose userland the
  open xnu-8796 matches.
- UniXNU is aiming at a shared UEFI layer that many devices use; HakiOS's loader is one device family's, so far.
- Bergamota ships a macOS control app. HakiOS has `xl` and `make`, which are command lines.

## What nobody here can do

Run an Apple account, activation, iMessage or the other Apple services: no project here can, and ours does not try
(see [LEGAL.md](../LEGAL.md)). None of the four is an iPhone to Apple's servers, and none should pretend to be.

## What "different" does not mean

It does not mean better on a given day. The things in the first section are about how the project is built and checked,
not about how many apps open. If you want to see which of these the phone has actually passed, read the status table in
the README and `docs/port-pkg110.md`, and run it yourself.

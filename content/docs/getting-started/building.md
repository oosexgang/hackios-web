# Building from source

`prebuilt/` has what most people need. Build when you change something, and to check that the source is what was shipped.

## The kernel

Apple's XNU sources (the release iOS 16.5 was built from) with this port laid over them:

```sh
make redwood_defconfig   # or any device's defconfig; without a .config every driver is built
make kernel              # xnu/apply.sh (once), xnu-deps/setup.sh (once), then the build
```

`make kernel` is `tools/make-kernel.sh`: it copies the drivers you edited into the tree (`xnu/sync-drivers.sh`), puts the
configuration's choice of drivers where XNU's build reads it (`tools/hakios-config.py kernel`), builds, and judges the result by
what failed rather than by the exit status (the last steps of XNU's own build always fail on this machine configuration, for kext
symbol sets this kernel does not have; any other failure is a failure). The kernel is **`hakios-kernel`** at the top of the
repository (XNU's build calls it `mach.development.bcm2837` in `xnu-src/.../BUILD/obj/DEVELOPMENT_ARM64_BCM2837/`; every tool
takes the copy named `hakios-kernel`, and `prebuilt/hakios-kernel` when there is none).

| Host | Toolchain |
|---|---|
| Linux | theos with its cctools and `iPhoneOS16.5.sdk`; `xnu-deps/setup.sh` lays it out |
| macOS | Xcode or the command-line tools; the SDK is fetched for you |

### Changing the kernel

The kernel's changes live in this repository in two forms: `xnu/hakios.patch` (Apple's files, changed) and `xnu/files/` (new
files), with the drivers by subsystem in `drivers/`. Work in the tree (`xnu-src/xnu-8796.121.2`), then save it:

```sh
xnu/export.sh                       # the tree -> xnu/hakios.patch, xnu/files/, drivers/
python3 tools/drivers-check.py      # drivers/map and drivers/*/conf agree
```

A driver you edit in `drivers/` goes into the tree by itself on the next `make kernel`.

## The loader

```sh
make loader          # xnuloader/build.sh: clang and lld-link, an EFI application without EDK2
```

The header `xnuloader/identity.h`, the properties by which iOS tells which iPhone it is, is not kept in the repository:
`xnuloader/mkidentity.sh` makes it at build time from the device tree in your own IPSW (`sysimage/unpack.sh` leaves it in `sysimage/`). `make loader-open` makes the placeholder
loader that boots the open kernel only.

## User space and the images

```sh
REST=1 userland/build.sh      # programs, libraries, the Metal plug-in, the APFS images
GL=1 REST=1 userland/build.sh # ... with Mesa, for gpu=1
```

`MODEM=1 SYSTEM=1` put the modem's firmware into the system image.

## The checks

What CI runs, and what to run before a pull request:

```sh
python3 tools/hakios-config-test.py     # configurations, drivers' choice
python3 tools/hakios-device-test.py     # SoC and device repositories
python3 tools/hakios-device.py check    # every device and SoC checked out holds together
python3 tools/drivers-check.py          # drivers/map, drivers/*/conf
python3 tools/boot-args.py --check      # the boot-argument catalogue is current
python3 tools/docs-gen.py --check       # the made documentation pages are current
python3 tools/docs-check.py             # every link of the documentation goes somewhere
python3 tools/provenance-check.py       # nothing in the tree that must not be
sh tools/metallib-test.sh               # the Metal plug-in's metallib reader, under sanitizers
tools/metal-plugin-test.sh              # (macOS) the Metal plug-in's objects on the Mac's own Metal
```

`python3 tools/docs-check.py` checks that every link of the documentation goes somewhere. The website (`hakios-web`) shows these
same pages; its `npm run docs` takes them from this repository.

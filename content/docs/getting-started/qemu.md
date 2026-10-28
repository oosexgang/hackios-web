# QEMU

## The open kernel

The kernel, a placeholder loader and a tiny raw-syscall user space: **nothing of Apple's and nothing of any phone's**.

```sh
git clone https://github.com/oosexgang/hakios.git hakios
cd hakios
tools/hakios-device.py sync    # the SoC, device and UEFI repositories (the open kernel needs none of them; the rest does)
make doctor          # what this machine lacks, and what to do
make qemu-open       # builds what is missing, then boots
```

What you should see in the log: `== XNULOADER v3 ==`, the kernel's banner with `hakios-kernel: version ...`, the drivers built in
(`hakios-kernel: N drivers built in (...)`), and the user space's own lines. `make qemu-open` uses `configs/defconfig`; with
`make qemu_defconfig` first, the kernel is built with only QEMU's drivers in it ([devices/qemu](../devices/qemu.md)).

## iOS in QEMU

Linux x86-64, about 12 GB of disk, 7-Zip 23 or newer, `lz4`, `qemu-system-aarch64`, `edk2-aarch64`.

```sh
make doctor                   # QEMU's display device, UEFI firmware, memory: what is missing, and what to do
sysimage/unpack.sh ~/iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw   # YOUR IPSW: the needed parts unpacked (7.4 GB)
REST=1 userland/build.sh      # the APFS images: userland/root.apfs and userland/system.apfs
make loader                   # the boot loader, with the iPhone's identity taken from YOUR copy of the IPSW
mkdir -p logs
qemu/run-ios.sh 1200 -display gtk > logs/qemu.log     # a 20-minute session
```

`make loader` is not optional here: `prebuilt/loader.efi` has no Apple data in it on purpose and boots the open kernel only.
`qemu/run-ios.sh` refuses to start without your own `xnuloader/loader.efi`, and says so.

### What you will see

The CPU is emulated, so it is slow, and **the window is black at first**: that is normal. On a fast desktop: black for the first
minute, the Apple logo at about one minute, the home screen at about five. Longer on a slower machine.

| Input | Is |
|---|---|
| the mouse, with the button held | a finger |
| `H` | Home |
| `L` | the power button |
| `↑` `↓` | volume |

### If it stays black

Check these in order.

1. **The log.** `tail -f logs/qemu.log` in another terminal. It should print `== XNULOADER v3 ==` within seconds, and kernel and
   launchd lines after that. Nothing at all: QEMU did not start the loader; run `make doctor`.
2. **An old loader.** A log with `ramfb: control ... after the request` near its top is a loader built before 27 October 2026 (a
   compiler could skip the check of the display request): the window stays at 800x600 and iOS draws outside it. `make loader` again.
3. **What the guest shows.** `qemu/screendump.sh` saves the guest's screen to `logs/qemu-screen.png`, whatever your window does.
4. **No window.** Your QEMU may have no GTK window (a headless package, WSL without WSLg). Use
   `qemu/run-ios.sh 1200 -display vnc=127.0.0.1:0 > logs/qemu.log` and a VNC viewer on `127.0.0.1:5900`.
5. **Memory.** The guest asks for 7 GB (`QEMU_RAM_GB`; 6 at the very least: the system image sits 3 GB into it and is 2.5 GB).
   Without that the host swaps and everything is very slow.
6. **The images.** `qemu/run-ios.sh` needs `userland/system.apfs` and `userland/root.apfs`; a missing one is reported at once.

## Metal in QEMU

`RC_JOBS=rc.jobs.metal` with the boot argument `metal=1` runs `metal_test`, which prints what iOS believes about Metal, what the
device makes (buffers, a library) and what CoreImage does. [The Metal plan](../metal-plan.md) has what each line means.

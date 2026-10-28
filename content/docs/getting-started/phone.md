# On the phone

The phone with a port today is the **POCO X5 Pro 5G** (`redwood`, Snapdragon 778G): [its page](../devices/redwood.md). Another
phone needs a port first: [Port a device](../porting/index.md).

## What happens to the phone

Nothing is installed. The loader goes into RAM with `fastboot boot`, the system image is sent into RAM, a session runs for as long
as you say, and a reboot brings the phone back to its own Android. The one thing written by default is the loader's own log, a
few KB, to the phone's `logdump` partition. With `ufs_write=1` (off unless you ask) the kernel writes to a partition named `darwin`
that you create yourself, and nowhere else. [What is written, exactly](../concepts/architecture.md#what-is-written-to-the-phone).

## What you need

- the phone, its boot loader unlocked;
- `adb` and `fastboot` on the PC (Google's platform-tools; on Windows, see [Windows](../windows.md));
- the images of [iOS in QEMU](qemu.md#ios-in-qemu) (`userland/system.apfs`), and `make loader` done once;
- the phone's own firmware, pulled from it (below). It is the vendor's and is never in the repositories.

## Step by step

```sh
tools/hakios-device.py sync         # hakios-sm7325 (with its SoC layer) and hakios-uefi into devices/ and uefi/
devices/redwood/pull-firmware.sh    # Android running, on adb: GPU, Wi-Fi, audio, haptics, modem, cameras -> fw-*/
make redwood_defconfig              # the phone's configuration: the common kernel, the SC7280's, the phone's own
make config                         # what it is: the drivers built in, the kernel's arguments, the firmware it wants
make phone SECS=600                 # a 10-minute session with the .config's arguments
```

`make phone` checks the `.config` and runs `tools/modem-cycle.sh`: it waits for the phone, enters the loader, uploads the system
image, runs the kernel with the configuration's arguments and summarises the log in `logs/`. The phone is never flashed. It is left in our
loader for the next run; `XL_END=android make phone ...` sends it back to Android at the end.

The same by hand, one step at a time:

```sh
./xl enter                          # Android -> fastboot -> our loader in RAM
./xl ramdisk userland/system.apfs   # the system image into the phone's RAM (about 80 s), once per loader session
XL_SECS=600 XL_CMDLINE="$(tools/hakios-config.py args)" ./xl run     # a session; the log goes to logs/
./xl reboot                         # back to Android
```

## The arguments that matter

A configuration sets them for you (`CONFIG_GPU=y` is `gpu=1`); [every argument](../boot-args.md) is listed with what reads it.

| Argument | What it does |
|---|---|
| `cpus=8 bootcpu=7 cpufreq=1` | all eight cores, the biggest one at full speed |
| `touchscreen=1` | the touch screen and the buttons |
| `gpu=1` | rendering on the Adreno (an image built with `GL=1`, firmware in `fw-gpu/`) |
| `adsp=1 sound=4 mic=4` | the audio DSP: speakers, microphone; the battery's level comes with it |
| `haptic=5` | the vibration motor |
| `wifi=1` | Wi-Fi (the network from `fw-wifi/network`) |
| `cam=5` | the cameras |
| `modem=1` | the modem: its firmware, file systems, data path, SIM ([cellular](../cellular.md)) |
| `var_store=1 ufs_write=1` | keep `/private/var` across reboots (**writes** to the partition `darwin`) |
| `thermal=1` | read the temperatures (the SC7280's fragment sets it), and hand back to the loader at 105 °C: the driver's own default, `thermal_stop=N` for another limit, `thermal_stop=0` for none |
| `battery_stop=15` | hand back to the loader before the battery is flat |

## When something goes wrong

| You see | Do |
|---|---|
| a session that does not end | `./xl` leaves its log in `logs/` and brings the phone back from the boot loader, or tells you which keys to press |
| the phone getting hot | with `thermal=1` (the SC7280's fragment sets it) the run is handed back to the loader at 105 °C; `thermal_stop=N` changes the limit. Seen on the phone, 27 October 2026: `thermal: ... stop at 105 C` |
| a run left alone on battery | `battery_stop=<percent>` ends it before the battery is flat |
| a problem in `make config` | it names the symbol and why: a driver left out that an argument needs, firmware the open profile does not load |
| anything else | the log in `logs/`, and `make doctor` with the phone on `adb` |

# Run it on a phone

The reference phone is the **POCO X5 Pro 5G** (code name `redwood`, Snapdragon 778G). hakios boots on it from RAM: nothing is flashed, and a reboot gives Android back. For any other phone, see [Adapt it to your device](your-device.md).

> **Before you start.** An unlocked boot loader is required, and unlocking it usually erases the phone. hakios does not charge the battery while it runs, so start with the battery above 50%. Keep the USB cable connected for the whole session.

## What you need

- A POCO X5 Pro 5G with the boot loader unlocked, Android working, and USB debugging on
- `adb` and `fastboot` (Google's platform-tools) on your computer
- The main repository, built as in [Run it in QEMU](qemu.md): `make doctor` passes
- The system images from **your own** restore image: `userland/system.apfs` (see [the Darwin user space](qemu.md#2-the-full-darwin-user-space-about-an-hour))
- A loader with your identity: `make loader`, once
- The phone's own firmware for the GPU, Wi-Fi, audio, haptics, modem and cameras, pulled from the phone itself (step 2). hakios never ships it.

## The short way: one command

```sh
tools/hakios-device.py sync          # the device repository and the UEFI, into devices/ and uefi/
devices/redwood/pull-firmware.sh     # Android running, on adb: the phone's firmware -> fw-*/
make redwood_defconfig               # the phone's configuration: common + SC7280 + redwood
make config                          # check it; it names any problem and the reason
make phone SECS=600                  # a 10-minute session in RAM, the log in logs/
```

`make phone` takes the phone from Android to our loader, sends the system image, runs the kernel with the arguments from your `.config`, fetches the log and leaves the phone in the loader for the next run. To go back to Android when the session ends, add `XL_END=android`:

```sh
XL_END=android make phone SECS=600
```

## The same, step by step with `xl`

`xl` is the script behind `make phone`. Use it directly to see each stage.

```sh
./xl enter                          # Android -> fastboot -> our loader, in RAM
./xl ramdisk userland/system.apfs   # the system image into the phone's RAM (about 80 s), once per loader session
XL_SECS=600 XL_CMDLINE="$(tools/hakios-config.py args)" ./xl run    # a session; the log goes to logs/
./xl reboot                         # back to Android
```

| Command | What it does |
|---|---|
| `./xl state` | where the phone is: `android`, `fastboot`, `loader` or `absent` |
| `./xl log` | fetch the loader's last log from `logdump` |
| `./xl screenshot` | a picture of the phone's screen |
| `./xl reload` | restart the loader without going through Android |
| `./xl stop` | end the running session early |

> **One run per loader session.** A second kernel run in the same loader session has died at once every time it was tried. Between runs, `./xl reload` or `./xl reboot`.

## Choosing what the kernel turns on

Your `.config` decides. The arguments it gives look like this:

```text
touchscreen=1 gpu=1 adsp=1 sound=4 wifi=1 haptic=5 modem=1 modem_again=1 modem_buffer=0xa8000000
```

| Argument | Turns on | Needs |
|---|---|---|
| `touchscreen=1` | touch, power and volume buttons | — |
| `gpu=1` | the Adreno GPU for drawing | `fw-gpu/` |
| `adsp=1` `sound=4` `mic=4` | the audio DSP, speakers, microphone, battery level | `fw-audio/` |
| `wifi=1` | Wi-Fi | `fw-wifi/` |
| `haptic=5` | vibration | the haptic firmware |
| `cam=5` | cameras | the camera firmware |
| `modem=1` | the cellular modem | `fw-modem/`, `ufs=2` |
| `cpus=8 bootcpu=7 cpufreq=1` | all eight cores, start on the big one at full speed | — |
| `thermal_stop=105` `battery_stop=15` | end the run by itself when hot or low | — |

To add or remove one for a single run, override the line: `make phone ARGS="touchscreen=1 gpu=1"`. To change it for good, edit the device's fragment and run `make config` again. Every argument that exists is in the [boot arguments catalogue](/docs/boot-args).

## Getting back to Android

| Situation | Do |
|---|---|
| the session ended normally | `./xl reboot` |
| you want it automatic | `XL_END=android make phone ...` or `XL_REBOOT_AFTER=1 ./xl run` |
| the phone looks frozen | wait: `xl` waits for the watchdog and tells you which keys to press |
| nothing responds | hold **power** for about 15 seconds: the phone restarts into Android |
| you need fastboot | hold **power + volume down** |

## Want it to stay? Dual boot

There is a manual procedure that installs hakios beside Android with a boot menu. It **erases Android's data**, flashes `boot_a` and has only been done on this phone. Read [Installing beside Android](/docs/dual-boot) in full before running any of it, and back up your partitions first.

## Next

- Everything else that can go wrong: [When something goes wrong](troubleshooting.md).
- Use the GPU through Metal: [Metal](metal.md).

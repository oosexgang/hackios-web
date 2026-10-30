# When something goes wrong

Every run leaves a log. Start there: `logs/last.log` after a phone run, `logs/qemu-open.log` or `logs/qemu.log` after QEMU. Each hardware step logs one line when it fails, naming the step and the register, so the log almost always says what happened.

## Before anything else

```sh
make doctor          # what this machine and the connected phone lack, read-only
make config          # what is wrong with the .config, and why
./xl state           # where the phone is: android, fastboot, loader or absent
./xl log             # the loader's last log from the phone
```

## Building

| You see | Do |
|---|---|
| `make doctor` lists something as missing | install it as the line says, open a new terminal, run it again |
| `make kernel` stops in the kext symbol-set steps | expected: those failures are tolerated. Any other error stops the build and is real |
| `make loader` asks for your restore image | build the open loader instead (`make loader-open`) for QEMU, or unpack yours (`make unpack IPSW=...`) |
| `sysimage/unpack.sh` refuses the file | it must be exactly `iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw`, 6,165,698,198 bytes |
| no space left | the user-space build wants about 12 GB free while it runs |

## QEMU

| You see | Do |
|---|---|
| `run.sh: no UEFI firmware found` | set `QEMU_EFI` and `QEMU_VARS` (on macOS, Homebrew's `edk2-aarch64-code.fd` and `edk2-arm-vars.fd`) |
| `timeout: command not found` on macOS | `brew install coreutils` |
| a black window for more than two minutes with the full user space | give QEMU at least 7 GB of RAM and wait: the Apple logo comes after about a minute, the home screen after about five |
| `run-darwin.sh` refuses the prebuilt loader | the full user space needs your own `make loader`; the prebuilt one has no Apple data and boots only the open kernel |
| Metal test never runs | the session is too short: give it 480 seconds or more |

## The phone

| You see | Do |
|---|---|
| `./xl enter` waits forever | is USB debugging on, and did you accept the computer on the phone? `adb devices` must list it |
| `fastboot boot` is refused | the boot loader is not unlocked |
| `mkxnuimg.py` stops and points to the UEFI README | you have no Silicium image for the phone; use U-Boot: `XL_FIRMWARE=u-boot ./xl enter` (after `make u-boot`) |
| nothing after the loader's banner | the firmware did not give the loader a framebuffer: try the other one (`XL_FIRMWARE=u-boot` or `silicium`) |
| the second run in a session dies at once | known: one run per loader session. `./xl reload` between runs |
| `gpu=1` and the screen draws in software | the GPU did not start; the log says which step. Most often `fw-gpu/` is missing: `make firmware` with the phone in Android |
| Wi-Fi, sound or the modem do nothing | each needs its `fw-*/` folder and its argument; `make config` refuses them with `CONFIG_FIRMWARE="none"` |
| the phone got hot or the battery low during a long run | add `thermal_stop=95 battery_stop=20`: the run ends itself and hands the phone back |
| the phone looks frozen | wait: `xl` waits for the watchdog and prints which keys to press. Holding power for about 15 seconds restarts into Android |

## Metal

| You see | Do |
|---|---|
| `probe: no GPU: …` | the kernel was started without `gpu=1`, or the GPU did not start (see above) |
| `MTLCreateSystemDefaultDevice()` returns nil | the device is hidden unless `metal=1` (only `metal_test`), `2` or `3` is given |
| the window server restarts in a loop | `metal=3` exposes a device that cannot draw yet to the window server; use `1` or `2` |
| the plug-in has no command buffers | it was built without the library: see [Linking the plug-in with the GPU](metal.md#linking-the-plug-in-with-the-gpu) |
| `HakiosMetal: asked and not implemented: -…` | not an error of yours: the app wanted a part of Metal that does not exist yet. The line names it |

## Asking for help

In the [Telegram channel](https://t.me/oosexgangdevs), say:

1. the command you ran, exactly;
2. your computer (Linux / macOS / Windows) and the phone;
3. the output of `make doctor`;
4. `logs/last.log`, attached as a file.

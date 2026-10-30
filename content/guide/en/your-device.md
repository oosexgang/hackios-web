# Adapt it to your device

hakios is built so that a new phone is a new **device repository**, not a fork. You describe the phone, boot a kernel with nothing of the phone's in it, then turn its hardware on one driver at a time. This page is the whole path; the exact formats are in the reference: [Port a device](/docs/porting), [How the repositories fit](/docs/porting/repositories), [Writing a driver](/docs/porting/drivers).

## Can my phone run it?

| Your phone has | Then |
|---|---|
| an ARM64 **Qualcomm** chip, an unlockable boot loader | the documented path below. Closest start: a Snapdragon of the SC7280 family (778G, QCM6490) shares the reference phone's chip layer |
| another Qualcomm generation | the same path, with a new chip layer (`--soc sm8250 --soc-title "Snapdragon 865"`) |
| a **MediaTek** chip | possible but not documented: the Infinix Hot 20 port ([hakios-mt6768](https://github.com/oosexgang/hakios-mt6768)) uses its own bare-metal loader in `boot_a` and a rooted Android. Start from its README |
| a locked boot loader | not possible |

You also need: a UEFI for the phone (a Mu-Silicium port, or HakiOS U-Boot), the phone's device tree, and a computer that builds the kernel (see [Run it in QEMU](qemu.md)).

## The plan

```text
1  describe the phone        tools/hakios-device.py new        → devices/<name>/ passes `check`
2  boot with nothing of it   make phone SECS=120               → the run reaches launchd and ends by itself
3  turn hardware on          one driver at a time, in order    → each one seen working
4  write down what works     device.conf status lines          → the site's device table
5  publish                   your repository + a manifest PR   → anyone can `sync` your phone
```

## 1. Describe the phone

Pull the phone's own device tree while it runs Android, then let the tool make the repository:

```sh
adb pull /sys/firmware/fdt device-tree.dtb
tools/hakios-device.py new mydevice --soc sc7280 --title "My Phone" --vendor Someone --maintainer "you" --fdt device-tree.dtb
make mydevice_defconfig
make config
```

| Option | Means |
|---|---|
| `mydevice` | the code name: lowercase letters, digits, `-` and `_` |
| `--soc` | the chip family. An existing one is copied in; a new name makes a new chip layer (add `--soc-title`) |
| `--fdt FILE` or `--adb` | the device tree, from a file or straight from the phone. With it the tool also writes `soc.args`, `pull-soc.sh` and a checklist in the README |
| `--repo` | make it a git repository, ready to push as `hakios-mydevice` |

What you get in `devices/mydevice/`:

```text
device.conf                  who the phone is, and what works on it
configs/mydevice_defconfig   three lines: common_defconfig + <soc>.config + mydevice.config
configs/mydevice.config      CONFIG_DEVICE="mydevice", every phone driver off to begin with
soc/                         the chip layer: soc.conf and configs/<soc>.config
soc.args                     the chip's addresses (soc_*), read from your device tree
README.md                    the checklist of what is the phone's own
```

Done when `tools/hakios-device.py check mydevice` passes.

### `device.conf`

```text
device mydevice
	title       My Phone
	vendor      Someone
	soc         sc7280
	defconfig   mydevice_defconfig
	firmware    pull-firmware.sh
	maintainer  you
	status      display     partial   UEFI's framebuffer, through the loader (to be checked)
```

- One `status <area> works|partial|missing <note>` line per area. Areas: `display touch buttons cpu gpu storage audio battery haptic camera torch wifi bluetooth cellular network thermal usb sensors`.
- **Only what you have seen on the phone is `works`.** Written but not yet seen is `partial`, with a note saying what is missing.
- The site's device pages are generated from this file (`python3 tools/docs-gen.py`): never edit them by hand.

### Files you will edit

| File | What you put in it |
|---|---|
| `configs/mydevice.config` | `CONFIG_HAKIOS_<DRIVER>=y` for each driver you turn on, and the phone's own values as `CONFIG_<NAME>=...` |
| `soc.args` | the `soc_*` addresses. `tools/soc-args.py` reads most from the device tree; four memory ones (`soc_smem`, `soc_cmd_db`, `soc_mpss_mem`, `soc_imem`) you copy by hand from its `reserved-memory` nodes |
| `pull-firmware.sh` | where your phone keeps its vendor firmware (GPU, Wi-Fi, audio…), so `make firmware` can copy it into `fw-*/` |
| `uefi/files/` | the Mu-Silicium platform for your phone, if you use Silicium |
| `drivers/<subsystem>/` | a driver for hardware the common tree does not have |

## 2. Boot with nothing of the phone's

```sh
make kernel
make loader
make phone SECS=120          # the arguments come from your .config
```

Look in `logs/last.log` for, in this order: the loader's banner, `kernel.ver=`, `hakios-kernel: N drivers built in (...)`, then launchd. **Done when a run reaches launchd, ends by itself and the phone comes back.**

| It stops… | Look at |
|---|---|
| right after the loader's banner | the UEFI port: the loader needs the framebuffer and its own file from UEFI |
| early in the kernel | the chip addresses in `soc.args` |
| `make config` complains | it names the symbol and the reason |

## 3. Turn the hardware on, one driver at a time

Every driver does nothing until its boot argument is given, and a failing step writes one line to the log and stops, so a wrong address costs you a log line, not a phone. Go in this order; each step needs the ones before it.

| Step | Drivers | Boot arguments | Needs |
|---|---|---|---|
| 1 | `CPUFREQ` `THERMAL` `SOCINFO` | `cpus=8 bootcpu=7 cpufreq=1 thermal=1 socinfo=1` | — |
| 2 | `BUTTONS`, touch | `touchscreen=1` | — |
| 3 | `UFS` | `ufs=1` (read only), then `ufs=2` | — |
| 4 | `ADRENO` | `gpu=1` | `fw-gpu/` |
| 5 | `ADSP` `BATTERY` `SPEAKER` `SOUND` `MIC` | `adsp=1 sound=4 mic=4` | `fw-audio/` |
| 6 | `WIFI` (+ `QMI`) | `wifi=1` | `fw-wifi/` |
| 7 | `HAPTIC` `CAMERA` `TORCH` `MODEM` `BT` | `haptic=… cam=… modem=1` | their firmware |

For each driver:

1. Read the comment at the top of its file in `drivers/`: it says where **every** address and number came from on the reference phone.
2. Find the same node in your device tree.
3. Put what differs where it belongs: a chip fact in the chip layer's fragment, a phone fact in `configs/mydevice.config` as a boot argument.
4. Turn it on, run, read the log, repeat.

Hardware the common tree does not cover (another touch controller, eMMC instead of UFS, another Wi-Fi chip) gets its own driver: a `hakios.<name>.c` file and a block in `drivers/<subsystem>/conf`. [Writing a driver](/docs/porting/drivers) is the recipe; `python3 tools/drivers-check.py` checks it.

## 4. Write down what works

Update the `status` lines, then:

```sh
python3 tools/docs-gen.py               # the device page, from device.conf
tools/hakios-device.py check mydevice
```

## 5. Publish

```sh
tools/hakios-device.py split mydevice ../hakios-device-mydevice
```

Push it as `hakios-device-mydevice` (or `hakios-soc-<soc>` for a shared chip layer), then open a pull request on the main repository that adds your block to `devices/manifest.conf`. `tools/hakios-device.py lock mydevice` writes the revision into it. From then on anyone can `tools/hakios-device.py sync mydevice`.

## Rules every port keeps

- No vendor firmware, no Apple files and no real serial numbers in any repository. Firmware is pulled from the user's own phone into `fw-*/`, which git ignores.
- A port that copies the chip layer must keep it identical to every other copy; the tools refuse two different copies and name both.
- Ask in the [Telegram channel](https://t.me/oosexgangdevs) before you start: someone may already be on your phone.

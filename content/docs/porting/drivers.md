# Writing a driver

A driver here is one or more C or C++ files of the kernel, a block in a `conf` file that makes it a configuration symbol, and a
boot-argument that starts it. This page goes through adding one; [Drivers in the configuration](../drivers-config.md) is the
reference for the mechanism.

## Where it goes

| The driver is | Put it in |
|---|---|
| for hardware many devices share, or a SoC family's | the common repository: `drivers/<subsystem>/` |
| one device's own (a touch controller only it has) | that device's repository: `devices/<name>/drivers/<subsystem>/` |
| a SoC family's own | the SoC's layer: `devices/<name>/soc/drivers/<subsystem>/` |

Subsystems: input, storage, gpu, camera, haptic, audio, power, wifi, bluetooth, modem, net, core.

## 1. The file

`hakios.<name>.c` (or `.cpp` for an IOKit service). The head says what it is, where every address and number came from (the
device tree, the vendor's Linux driver, a measurement), and what has been seen working:

```c
/*
 * The touch screen of the My Phone (mydevice): a Novatek NT36672 on I2C 2, as a source of touches for /dev/hakios-touch
 * (sys/hakios.input.h). Only with boot-arg touchscreen=1.
 *
 * Where the numbers come from: the phone's device tree (i2c@988000, novatek,nt36xxx), Novatek's Linux driver ...
 *
 * Status: written, not yet run.
 */
#include <pexpert/pexpert.h>
#include <sys/hakios.input.h>

void
hakios_nt36672_init(void)
{
	uint32_t enabled = 0;

	if (!PE_parse_boot_argn("touchscreen", &enabled, sizeof(enabled)) || !enabled) {
		return;                 /* nothing is touched unless a boot-argument asks */
	}
	/* ... hakios_touch_post(HAKIOS_TOUCH_DOWN, finger, x, y) for each sample ... */
}
```

Rules every driver here follows:

- **nothing happens without its boot-argument**; a driver that is built in and not asked for touches no register;
- every value read from the phone is checked before it is used: a length, an offset, an index;
- a step that fails says which, in one log line, and the driver stops rather than guessing;
- writes to a PMIC or to storage are the exception, and are listed in `tools/provenance.allow` with why.

## 2. Make it a symbol

In the `conf` of its subsystem (common: `drivers/input/conf`; a device's: `devices/<name>/drivers/input/conf`):

```
driver NT36672
	file    bsd/dev/hakios.nt36672.c
	help    the touch screen of the My Phone: a Novatek NT36672 on I2C (touchscreen=1)
```

`file` is the file's place in Apple's tree: `bsd/dev/` for C, `iokit/Kernel/` for C++ (with `iokitcpp`). `requires` names
drivers it cannot be built without.

A common driver is also a line of `drivers/map` (`input    bsd/dev/hakios.nt36672.c`); a device's is not, it is found by its conf.

## 3. Start it

Drivers are started in one of two ways:

- by XNU's own initcall, `STARTUP(EARLY_BOOT, STARTUP_RANK_LAST, my_init);` at the end of the file. Nothing else to change; this
  is how `socinfo`, `thermal`, `pmic`, `battguard` and `bt` start. **Prefer this for a new driver.**
- from a hub's list (`hakios_input_init()` in `hakios.input.c`, `hakios_audio_init()` in `hakios.audio.c`), when the order
  matters. Then the hub calls it whether or not it is built: give it a stand-in in `drivers/core/hakios.stubs.c`
  (`#ifndef HAKIOS_NT36672 void hakios_nt36672_init(void) {} #endif`), or the kernel will not link without it.

## 4. Build it, check it

```sh
echo CONFIG_HAKIOS_NT36672=y >> devices/mydevice/configs/mydevice.config
make mydevice_defconfig && make kernel
python3 tools/drivers-check.py          # (common drivers) the map and the conf files agree
tools/hakios-device.py check mydevice   # (a device's) its files are there
python3 tools/boot-args.py --check      # a new boot-argument is in the catalogue: run without --check to add it
python3 tools/docs-gen.py               # the reference page
```

The boot log says `hakios-kernel: N drivers built in (... nt36672 ...)`, and `sysctl kern.hakios.drivers` the same.

## 5. Write down what it does

The driver's head says what has been seen (on the phone, in QEMU, compiled only). The device's `device.conf` has a `status` line
for the part it makes work. [docs/driver-review](https://github.com/oosexgang/hakios/tree/main/docs/driver-review)
holds the audits of the common drivers: a new common driver gets one before it is relied on.

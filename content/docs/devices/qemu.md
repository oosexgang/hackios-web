<!-- Made by tools/docs-gen.py from devices/qemu/device.conf. Do not edit: change that, then run tools/docs-gen.py. -->


# QEMU virt (aarch64) (`qemu`)

| | |
|---|---|
| Vendor | QEMU |
| SoC | `none` |
| Configuration | `make qemu_defconfig` |
| Maintainer | the HakiOS developers (README.md) |
| Repository | [`devices/qemu/`](https://github.com/oosexgang/hakios/tree/main/devices/qemu) |

## What works

| Part | State | |
|---|---|---|
| display | works | ramfb, through the loader |
| touch | works | virtio tablet as the touch screen (CONFIG_HAKIOS_VIRTIO_INPUT) |
| buttons | works | virtio keyboard: H is Home, L the power button, arrows the volume |
| storage | works | virtio-blk images (CONFIG_HAKIOS_VIRTIO_BLK) |
| audio | works | virtio sound (CONFIG_HAKIOS_VIRTIO_SOUND) |
| network | works | virtio-net as en0 (CONFIG_HAKIOS_VIRTIO_NET) |
| gpu | no | no GPU: the screen is drawn in software |

The state is what has been seen on this device, written down in `devices/qemu/device.conf`; a part the table does not name has not been looked at.

<!-- Made from devices/redmi-note-10-je/device.conf for HakiOS documentation -->

# Redmi Note 10 JE (`redmi-note-10-je`)

| | |
|---|---|
| Vendor | Xiaomi |
| SoC | `sm4350` (Snapdragon 480 5G) |
| Configuration | `make redmi_note_10_je_defconfig` |
| Maintainer | asahi0416 (README.md) |
| Repository | [hakios-device-redmi-note-10-je](https://github.com/asahi0416/hakios-device-redmi-note-10-je) |
| Firmware | `devices/redmi-note-10-je/pull-firmware.sh` pulls it from your own phone |

## What works

| Part | State | Notes |
|---|---|---|
| display | works | Novatek NT36672C (1080x2400 @60Hz), UEFI framebuffer & Metal zero-copy IOMobileFramebuffer |
| touch | works | Novatek NT36672C (PID 595A), SPI 4-byte CRC2 protocol, normalized 0..65535 (touch_flip=0) |
| buttons | works | Power and volume keys via TLMM GPIO |
| cpu | works | Qualcomm Snapdragon 480 5G (SM4350, 8 cores: 2x Cortex-A76 + 6x Cortex-A55, cpus=8 bootcpu=7) |
| gpu | works | Adreno 619, Mesa AIR->NIR->ir3 JIT, Hardware Metal with QuartzCore CoreAnimation @600MHz |
| storage | partial | UFS 2.2 storage supported / booted via RAM rootfs APFS mount |
| audio | partial | ADSP Hexagon DSP PAS Step 4..10 loaded, service 400 active |
| battery | works | PM7250B QG (0x248) raw ADC + DTB LUT dynamic SOC/voltage, Apple powerd & _UIBatteryView UI |
| haptic | partial | PM6150L haptic engine mapped |
| camera | works | Samsung S5KGM1ST (48MP) raw Bayer streaming, WL2866D PMIC, MCLK 19.2MHz, Camera.app real-time live preview |
| torch | works | PM6150L flash/torch (peripheral 0x05d3), 4-step gamma curve (25..250mA), AVCaptureDevice |
| wifi | partial | Qualcomm WCN3988 firmware extracted; initialization pipeline in progress |
| bluetooth | missing | Bluetooth stack bring-up pending |
| cellular | partial | Qualcomm Snapdragon X51 5G modem firmware mapped, PAS ID 4 authenticated |
| network | partial | USB Fastboot networking active |
| thermal | works | Qualcomm TSENS thermal sensors active |
| usb | works | USB DWC3 SuperSpeed controller, Fastboot protocol with zero-stall log & screenshot capture |
| sensors | works | QMC6308 magnetometer + ICM4x6xx 6-axis IMU on SSC_QUPV3_SE0, 30Hz continuous dynamic Compass.app |

The state is what has been seen on this device, written down in `devices/redmi-note-10-je/device.conf`.

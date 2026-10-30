# Адаптация под устройство

hakios устроен так, что новый телефон — это новый **репозиторий устройства**, а не форк. Вы описываете телефон, загружаете ядро без единого его драйвера, а затем включаете железо по одному драйверу за раз. Здесь весь путь целиком; точные форматы — в справочнике: [Port a device](/docs/porting), [How the repositories fit](/docs/porting/repositories), [Writing a driver](/docs/porting/drivers).

## Подойдёт ли мой телефон?

| В вашем телефоне | Тогда |
|---|---|
| ARM64-чип **Qualcomm** и разблокируемый загрузчик | путь ниже. Ближе всего — Snapdragon семейства SC7280 (778G, QCM6490): у него общий слой чипа с эталонным телефоном |
| Qualcomm другого поколения | тот же путь с новым слоем чипа (`--soc sm8250 --soc-title "Snapdragon 865"`) |
| чип **MediaTek** | возможно, но не описано: порт на Infinix Hot 20 ([hakios-mt6768](https://github.com/oosexgang/hakios-mt6768)) использует свой bare-metal загрузчик в `boot_a` и рутованный Android. Начните с его README |
| заблокированный загрузчик | невозможно |

Ещё понадобятся: UEFI для телефона (порт Mu-Silicium или HakiOS U-Boot), дерево устройств телефона и компьютер, на котором собирается ядро (см. [Запуск в QEMU](qemu.md)).

## План

```text
1  описать телефон          tools/hakios-device.py new        → devices/<name>/ проходит `check`
2  загрузиться без него     make phone SECS=120               → сессия доходит до launchd и завершается сама
3  включить железо          по одному драйверу, по порядку    → каждый увиден работающим
4  записать, что работает   строки status в device.conf       → таблица устройств на сайте
5  опубликовать             ваш репозиторий + PR в манифест   → любой может сделать `sync` вашего телефона
```

## 1. Описать телефон

Снимите дерево устройств, пока телефон работает в Android, и пусть инструмент создаст репозиторий:

```sh
adb pull /sys/firmware/fdt device-tree.dtb
tools/hakios-device.py new mydevice --soc sc7280 --title "My Phone" --vendor Someone --maintainer "you" --fdt device-tree.dtb
make mydevice_defconfig
make config
```

| Параметр | Значит |
|---|---|
| `mydevice` | кодовое имя: строчные буквы, цифры, `-` и `_` |
| `--soc` | семейство чипа. Существующее копируется, новое имя создаёт новый слой чипа (добавьте `--soc-title`) |
| `--fdt FILE` или `--adb` | дерево устройств из файла или прямо с телефона. С ним инструмент пишет ещё `soc.args`, `pull-soc.sh` и чек-лист в README |
| `--repo` | сделать git-репозиторий, готовый к публикации как `hakios-mydevice` |

Что появится в `devices/mydevice/`:

```text
device.conf                  что это за телефон и что на нём работает
configs/mydevice_defconfig   три строки: common_defconfig + <soc>.config + mydevice.config
configs/mydevice.config      CONFIG_DEVICE="mydevice", все драйверы телефона для начала выключены
soc/                         слой чипа: soc.conf и configs/<soc>.config
soc.args                     адреса чипа (soc_*), прочитанные из дерева устройств
README.md                    чек-лист того, что у телефона своё
```

Готово, когда проходит `tools/hakios-device.py check mydevice`.

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

- Одна строка `status <область> works|partial|missing <пояснение>` на область. Области: `display touch buttons cpu gpu storage audio battery haptic camera torch wifi bluetooth cellular network thermal usb sensors`.
- **`works` — только то, что вы видели работающим на телефоне.** Написанное, но не проверенное — `partial` с пояснением, чего не хватает.
- Страницы устройств на сайте генерируются из этого файла (`python3 tools/docs-gen.py`) — не правьте их руками.

### Файлы, которые вы будете править

| Файл | Что в него писать |
|---|---|
| `configs/mydevice.config` | `CONFIG_HAKIOS_<DRIVER>=y` для каждого включённого драйвера и значения телефона как `CONFIG_<NAME>=...` |
| `soc.args` | адреса `soc_*`. Большую часть `tools/soc-args.py` читает из дерева устройств; четыре адреса памяти (`soc_smem`, `soc_cmd_db`, `soc_mpss_mem`, `soc_imem`) переносите руками из узлов `reserved-memory` |
| `pull-firmware.sh` | где ваш телефон хранит прошивки производителя (GPU, Wi-Fi, звук…), чтобы `make firmware` скопировал их в `fw-*/` |
| `uefi/files/` | платформа Mu-Silicium для вашего телефона, если используете Silicium |
| `drivers/<subsystem>/` | драйвер для железа, которого нет в общем дереве |

## 2. Загрузиться без драйверов телефона

```sh
make kernel
make loader
make phone SECS=120          # аргументы берутся из вашего .config
```

Ищите в `logs/last.log` по порядку: баннер загрузчика, `kernel.ver=`, `hakios-kernel: N drivers built in (...)`, затем launchd. **Готово, когда сессия доходит до launchd, завершается сама и телефон возвращается.**

| Останавливается… | Смотрите |
|---|---|
| сразу после баннера загрузчика | порт UEFI: загрузчику нужен framebuffer и его файл от UEFI |
| рано в ядре | адреса чипа в `soc.args` |
| ругается `make config` | он называет символ и причину |

## 3. Включать железо по одному драйверу

Каждый драйвер ничего не делает без своего аргумента, а неудачный шаг пишет одну строку в лог и останавливается — поэтому неверный адрес стоит вам строки в логе, а не телефона. Идите в этом порядке: каждому шагу нужны предыдущие.

| Шаг | Драйверы | Аргументы | Нужно |
|---|---|---|---|
| 1 | `CPUFREQ` `THERMAL` `SOCINFO` | `cpus=8 bootcpu=7 cpufreq=1 thermal=1 socinfo=1` | — |
| 2 | `BUTTONS`, тач | `touchscreen=1` | — |
| 3 | `UFS` | `ufs=1` (только чтение), затем `ufs=2` | — |
| 4 | `ADRENO` | `gpu=1` | `fw-gpu/` |
| 5 | `ADSP` `BATTERY` `SPEAKER` `SOUND` `MIC` | `adsp=1 sound=4 mic=4` | `fw-audio/` |
| 6 | `WIFI` (+ `QMI`) | `wifi=1` | `fw-wifi/` |
| 7 | `HAPTIC` `CAMERA` `TORCH` `MODEM` `BT` | `haptic=… cam=… modem=1` | их прошивки |

Для каждого драйвера:

1. Прочитайте комментарий в начале его файла в `drivers/`: там сказано, откуда на эталонном телефоне взят **каждый** адрес и каждое число.
2. Найдите тот же узел в своём дереве устройств.
3. Разложите отличия по местам: факт о чипе — во фрагмент слоя чипа, факт о телефоне — в `configs/mydevice.config` как аргумент.
4. Включите, запустите, прочитайте лог, повторите.

Для железа, которого нет в общем дереве (другой контроллер тача, eMMC вместо UFS, другой чип Wi-Fi), пишется свой драйвер: файл `hakios.<name>.c` и блок в `drivers/<subsystem>/conf`. Рецепт — [Writing a driver](/docs/porting/drivers); проверяет `python3 tools/drivers-check.py`.

## 4. Записать, что работает

Обновите строки `status`, затем:

```sh
python3 tools/docs-gen.py               # страница устройства из device.conf
tools/hakios-device.py check mydevice
```

## 5. Опубликовать

```sh
tools/hakios-device.py split mydevice ../hakios-device-mydevice
```

Опубликуйте как `hakios-device-mydevice` (или `hakios-soc-<soc>` для общего слоя чипа) и откройте pull request в основной репозиторий, который добавляет ваш блок в `devices/manifest.conf`. `tools/hakios-device.py lock mydevice` впишет туда ревизию. После этого любой сможет сделать `tools/hakios-device.py sync mydevice`.

## Правила для любого порта

- Никаких прошивок производителя, файлов Apple и настоящих серийных номеров ни в одном репозитории. Прошивки снимаются с собственного телефона пользователя в `fw-*/`, который git игнорирует.
- Порт, который копирует слой чипа, держит его идентичным всем остальным копиям; инструменты отказываются работать с двумя разными копиями и называют обе.
- Напишите в [Telegram-канал](https://t.me/oosexgangdevs), прежде чем начать: возможно, вашим телефоном уже кто-то занимается.

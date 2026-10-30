# Запуск в QEMU

Самый быстрый способ увидеть, как грузится hakios: открытому ядру в QEMU не нужны ни телефон, ни что-либо от Apple. А если хочется экран блокировки и рабочий стол — полное пользовательское пространство Darwin тоже работает в QEMU.

## 1. Открытое ядро (10–30 минут)

### Что нужно

| | Linux x86-64 | macOS (Apple silicon) | Windows |
|---|---|---|---|
| собрать ядро и загрузчик | да | да | в WSL 2 |
| запустить QEMU | да | да, см. примечание ниже | в WSL 2 |

- `git`, `python3` 3.8 или новее, `clang`, `lld-link`, `make`
- `qemu-system-aarch64` и UEFI-прошивка для него (`edk2-aarch64` или `AAVMF` в Linux; в macOS `brew install qemu` ставит `edk2-aarch64-code.fd`)

`make doctor` проверит всё это за вас и напишет, чего не хватает и как это получить. Он ничего не меняет.

### Шаги

```sh
git clone https://github.com/oosexgang/hakios-xnu-kernel.git hakios
cd hakios
make doctor          # чего не хватает на этой машине и что делать
make qemu-open       # собирает недостающее и загружает
```

`make qemu-open` собирает ядро, загрузчик с условной идентичностью и крошечную программу пользовательского пространства, затем запускает QEMU на 600 секунд. Лог пишется в `logs/qemu-open.log`.

### Что вы должны увидеть

```text
== XNULOADER v3 ==
hakios-kernel: version 2.1.13-hakios ...
hakios-kernel: N drivers built in (...)
Hello from user space on Darwin!
```

Последнюю строку печатает `userland/hello` — статическая программа, которая говорит с ядром прямыми системными вызовами и читает `sysctl kern.hakios.version`. Если она есть, то ядро, загрузчик и пользовательское пространство работают на вашей машине.

> **В macOS** UEFI для QEMU не находится сам: укажите файлы Homebrew.
> ```sh
> export QEMU_EFI=$(brew --prefix qemu)/share/qemu/edk2-aarch64-code.fd
> export QEMU_VARS=$(brew --prefix qemu)/share/qemu/edk2-arm-vars.fd
> ```
> Скрипт запуска также вызывает GNU `timeout`: его даёт `brew install coreutils`.

### Полезные ручки

| Переменная или цель | Что делает |
|---|---|
| `make qemu_defconfig`, затем `make qemu-open` | ядро только с четырьмя драйверами QEMU вместо всех 25 |
| `make qemu-open SECS=120` | более короткая сессия |
| `QEMU_MEM=4G make qemu-open` | память для QEMU (по умолчанию 6 ГБ) |
| `QEMU_SMP=4 make qemu-open` | больше ядер (по умолчанию 1) |
| `make qemu-u-boot` | тот же пакет, но запуск через HakiOS U-Boot вместо оболочки UEFI |

## 2. Полное пользовательское пространство Darwin (около часа)

Это экран блокировки, рабочий стол и штатные приложения в окне на вашем компьютере. Здесь нужно то, без чего обходится открытое ядро.

- **Linux x86-64** (скрипт запуска читает `/proc/meminfo`), около 12 ГБ свободного места на диске, 7 ГБ свободной памяти
- `7z` версии 23 или новее, `lz4`, `qemu-system-aarch64` 7.0 или новее с `ramfb`
- **ваша собственная копия** образа восстановления `iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw` (6 165 698 198 байт). hakios не скачивает его и не распространяет ничего из него.

```sh
make doctor
sysimage/unpack.sh ~/iPhone10,3,iPhone10,6_16.5_20F66_Restore.ipsw   # нужные части, около 7,4 ГБ
REST=1 userland/build.sh      # образы системы: userland/root.apfs и userland/system.apfs
make loader                   # загрузчик с идентичностью из вашего образа
mkdir -p logs
qemu/run-darwin.sh 1200 -display gtk > logs/qemu.log     # сессия на 20 минут
```

Что происходит: около минуты чёрное окно, около минуты логотип Apple, затем рабочий стол — примерно через пять минут на быстром компьютере. QEMU эмулирует процессор, поэтому всё медленно; так и должно быть.

| В окне QEMU | Это |
|---|---|
| мышь | ваш палец |
| `H` | кнопка «Домой» |
| `L` | кнопка питания |
| стрелки | громкость |

Сеть: `QEMU_NET=1 qemu/run-darwin.sh ...` даёт системе сетевую карту virtio как `en0`.

## Дальше

- То же самое на телефоне: [Запуск на телефоне](phone.md).
- Metal в QEMU: [Metal](metal.md#попробовать-в-qemu).
- Окно остаётся чёрным или лог обрывается: [Если что-то пошло не так](troubleshooting.md).

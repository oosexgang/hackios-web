# Metal

Metal — интерфейс GPU от Apple: приложение записывает работу в командные буферы, а GPU её выполняет. В hakios за это отвечает **hakios-metal**: он превращает работу в собственные командные пакеты GPU Adreno и передаёт их напрямую драйверу GPU в ядре. Без Vulkan и без Mesa посередине.

## Где мы сейчас

| Часть | Состояние |
|---|---|
| очереди и командные буферы — с состояниями Metal и обработчиками завершения в порядке отправки | **работает** на GPU телефона |
| буферы в памяти GPU | **работает** |
| копирование и заливка (blit) командным процессором GPU | **работает** на GPU телефона |
| библиотеки шейдеров `.metallib`: чтение и проверка | **работает** |
| шейдеры: выполнение функции Metal на GPU | **ещё нет**: компилятор AIR → NIR → ir3 уже есть в сборке Mesa в hakios, его подключают к драйверу |
| конвейеры отрисовки и вычислений, текстуры | **ещё нет** |
| интерфейс системы рисуется через Metal | **ещё нет**: сейчас — через OpenGL ES |

На Adreno 642L в POCO X5 Pro 28 октября 2026 года проба прошла все проверки:

| Проверка | Результат |
|---|---|
| копирование 500 000 байт | байт в байт, соседняя память не тронута, 4,2 мс |
| заливка 4, 256, 260, 65 540 и 999 996 байт | всё верно |
| 40 командных буферов одновременно | завершились по порядку, с обработчиками |
| копирование 16 МБ | 182 мс (92 МБ/с: верно, но медленно; быстрый путь — блиттер GPU, он следующий) |

## Как связаны части

```text
программа на Metal
   │  MTLDevice · MTLCommandQueue · MTLCommandBuffer · MTLBlitCommandEncoder
   ▼
HakiosMetal.bundle        плагин Metal (hakios-xnu-kernel: userland/src/HakiosMetal.m)
   ▼
command.hpp               очереди, командные буферы, blit → пакеты PM4 (pm4.hpp)
   ▼
gpu.hpp                   буферы GPU, отправка, барьеры (fences)
   ▼
транспорт                 iokit_transport на телефоне  ·  fake_gpu в тестах
   ▼
HakiosGPU                 драйвер GPU в ядре (drivers/gpu/hakios.gpu.cpp)  ──►  Adreno
```

Как Metal его находит: с аргументом загрузки `metal=N` ядро называет `HakiosMetal` плагином Metal для GPU. Metal загружает `/System/Library/Extensions/HakiosMetal.bundle`, и `MTLCreateSystemDefaultDevice()` возвращает наше устройство.

| `metal=` | Кто видит устройство Metal |
|---|---|
| (не задан) | никто — так по умолчанию, специально |
| `1` | только тестовая программа `metal_test` |
| `2` | все процессы, кроме оконного сервера |
| `3` | все процессы |

> **Почему выключено по умолчанию.** Устройство Metal, которое пока не умеет рисовать, заставляет оконный сервер запросить его, упасть и перезапускаться по кругу. Пока шейдеры не работают, держите `metal=` на 1 или 2.

## 1. Сборка и тесты на компьютере

Тесты гоняют драйвер на поддельном GPU, который так же строг, как настоящий командный процессор: неверный бит чётности, счётчик за концом, неизвестный опкод или адрес вне всех буферов — это сбой, а не падение. Подойдёт любой компилятор C++17 в macOS или Linux.

```sh
git clone https://github.com/oosexgang/hakios-metal.git
cd hakios-metal
make test             # 21 тест на поддельном GPU
out/host/tests copy   # только тесты, в имени которых есть "copy"
```

## 2. Проба на GPU телефона

Проба делает на настоящем GPU то же, что тесты на поддельном, по строке на проверку. Нужен телефон с hakios и `gpu=1` (значит, `fw-gpu/` уже снят) и iPhoneOS 16.5 SDK — его скачивает `xnu-deps/setup.sh` в основном репозитории.

Положите `hakios-metal` рядом с основным репозиторием:

```text
work/
├── hakios/          hakios-xnu-kernel
└── hakios-metal/
```

```sh
cd hakios-metal
make ios HAKIOS=../hakios        # out/ios/hakios-metal-probe и out/ios/libhakios-metal.a
cd ../hakios
# список задач: что система запустит, когда поднимется
printf '/redwood/bin/hakios-metal-probe\n' > userland/rc.jobs.metalprobe
EXTRA="../hakios-metal/out/ios/hakios-metal-probe" RC_JOBS=rc.jobs.metalprobe userland/build.sh
./xl enter && ./xl ramdisk userland/system.apfs
XL_SECS=120 XL_CMDLINE="$(tools/hakios-config.py args) gpu=1" ./xl run
grep probe: logs/last.log
```

- `EXTRA` копирует программы с вашего компьютера в `/redwood/bin` на телефоне.
- `RC_JOBS` выбирает список команд, которые система выполнит, когда поднимется. Это не скрипт оболочки: одна команда на строку, без переменных и кавычек.
- Что печатает удачный запуск:

```text
probe: GPU 660, chip id 0x…
probe: ok   …          по строке на проверку: копирование, заливки, 40 командных буферов, 16 МБ
probe: 0 failures
```

Код выхода — число сбоев; `100` значит «нет GPU» (строкой выше сказано почему — например, ядро запущено без `gpu=1`).

## 3. Использование из кода

### Через Metal (Objective-C)

Это настоящий путь через API — те же вызовы, что делает приложение. Сокращённый фрагмент `userland/src/metal_test.m`.

```objc
id<MTLDevice> device = MTLCreateSystemDefaultDevice();
id<MTLCommandQueue> queue = [device newCommandQueue];
id<MTLBuffer> a = [device newBufferWithLength:n options:MTLResourceStorageModeShared];
id<MTLBuffer> b = [device newBufferWithLength:n options:MTLResourceStorageModeShared];

id<MTLCommandBuffer> cb = [queue commandBuffer];
id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
[blit copyFromBuffer:a sourceOffset:4096 toBuffer:b destinationOffset:8192 size:500000];
[blit fillBuffer:b range:NSMakeRange(600000, 4096) value:0xa5];
[blit endEncoding];
[cb addCompletedHandler:^(id<MTLCommandBuffer> done) { /* done.status == MTLCommandBufferStatusCompleted */ }];
[cb commit];
[cb waitUntilCompleted];
```

- Смещения и размеры должны быть кратны 4.
- Нужны `gpu=1` и `metal=1` (или выше) в командной строке.
- То, что плагин ещё не умеет, пишется в лог как `HakiosMetal: asked and not implemented: -...` и получает ответ nil: лог точно говорит, чего хотело приложение.

### Без Metal (C)

`include/hakios-metal/hakios_metal.h` — небольшой интерфейс на C, его можно вызывать из любой программы. Каждый вызов сообщает, получилось ли; причина — в `hakios_metal_error()`.

```c
#include <hakios-metal/hakios_metal.h>

hakios_metal_device *d = hakios_metal_open();      /* NULL без gpu=1: см. hakios_metal_error() */
hakios_metal_buffer *a = hakios_metal_buffer_new(d, 4096);
hakios_metal_buffer *b = hakios_metal_buffer_new(d, 4096);
memset(hakios_metal_buffer_contents(a), 0x3c, 4096);

hakios_metal_queue *q = hakios_metal_queue_new(d);
hakios_metal_cb *cb = hakios_metal_cb_new(q);
hakios_metal_cb_copy(cb, a, 0, b, 0, 4096);        /* 0, или -1 и причина в hakios_metal_error() */
hakios_metal_cb_commit(cb, NULL, NULL);            /* или обратный вызов в потоке очереди */
hakios_metal_cb_wait(cb);
/* hakios_metal_cb_status(cb) == HAKIOS_METAL_COMPLETED */
hakios_metal_cb_free(cb);
```

`hakios_metal_open_fake()` даёт то же устройство на поддельном GPU — для тестов на компьютере.

### Связать плагин с GPU

`userland/build.sh` собирает `HakiosMetal.bundle` с командными буферами и копированием на GPU, только если находит `../../hakios-metal/out/darwin/libhakios-metal.a` (или `$HAKIOS_METAL/out/darwin/...`). Без неё буферы лежат в обычной памяти, а очередь не создаёт командных буферов. Makefile hakios-metal пока пишет библиотеку в `out/ios/`; пока у него нет цели `darwin`, положите её туда, где её ищет сборка:

```sh
mkdir -p ../hakios-metal/out/darwin && cp ../hakios-metal/out/ios/libhakios-metal.a ../hakios-metal/out/darwin/
userland/build.sh        # напишет "HakiosMetal with hakios-metal (...)", если нашёл
```

## Попробовать в QEMU

В QEMU нет Adreno, поэтому пути через GPU там нет, но можно увидеть, что Darwin думает о Metal: какие сервисы ищет, загружается ли плагин, какое устройство возвращает `MTLCreateSystemDefaultDevice()`.

```sh
RC_JOBS=rc.jobs.metal REST=1 userland/build.sh
CMDLINE="metal=1" qemu/run-darwin.sh 600 -display gtk > logs/qemu.log
```

Сессия должна быть длинной: в QEMU SpringBoard поднимается примерно за 208 секунд, а `metal_test` идёт после него — дайте 480 секунд или больше.

## Что дальше

1. Шейдеры: подключить фронтенд AIR (`tools/mesa/air` в основном репозитории) к драйверу, чтобы функция Metal компилировалась в ir3 для Adreno. Из 456 шейдерных модулей системы 321 уже доходит до ir3, а 54 выполнились на GPU телефона.
2. Конвейеры отрисовки и вычислений поверх этих шейдеров.
3. Быстрое копирование через блиттер GPU.
4. Тогда CoreAnimation сможет рисовать через Metal вместо OpenGL ES.

Подробный план со всеми шагами и тестами: [Metal на Adreno](/docs/metal-plan) и [компилятор шейдеров](/docs/air).

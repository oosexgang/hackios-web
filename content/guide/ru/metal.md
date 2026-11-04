# Metal

Metal — интерфейс GPU от Apple: программа записывает работу в командные буферы, а GPU её выполняет. На POCO X5 Pro 5G оконный сервер может рисовать через Metal на Adreno 642L, двумя путями; путь выбирается при загрузке. Без `metal=1` он рисует через OpenGL ES, как и раньше.

## Где мы сейчас

Измерено на телефоне 3 и 4 ноября 2026 года: Adreno на 550 МГц, панель 1080 x 2400 на 120 Гц. Оба пути рисуют систему правильно. **120 кадров в секунду не достигнуто.**



| | hakios-metal | Metal поверх Vulkan |
|---|---|---|
| Как | собственные командные пакеты Adreno; шейдеры компилирует ir3 из Mesa прямо в процессе | стек UniXNU: фронтенд AdrenoMetal, metal2vulkan, Turnip |
| Перелистывание страниц, кадров в секунду | 100–104 | 50–57 |
| Прокрутка Settings | около 90 | 41 |
| Открытие приложения | около 90 | не записано |
| Кнопка «домой» | 92 с обоями, застывшими в одну картинку (`wallpaper_freeze=1`), 28 с `wallpaper_cache=1` | 41–57 |
| Кадры дольше 16,7 мс | 4% | не записано |

После того как палец поднят, 185 из 205 кадров перелистывания на hakios-metal занимают 8,3 мс, один период обновления панели. Пока палец тянет страницу, кадры идут с частотой 75–80 в секунду, а оконный сервер ждёт GPU по 8–14 мс. Всё, что пробовали, и что не помогло: [Metal measurements](/docs/reference/metal-measurements). Полный справочник: [Metal on the Adreno](/docs/reference/metal).

Показано только рисование собственного интерфейса системы. Что работают другие программы на Metal, не показано; игры не заявляются.

## Оконный сервер через Metal

Это вы собираете сами. В `prebuilt/` этого нет, а `PREBUILT=1` плагин не собирает: нужны кросс-инструменты (`xnu-deps/setup.sh`), ваш пользовательский Darwin, разложенный через `sysimage/unpack.sh`, и прошивка GPU телефона в `fw-gpu/`.

**Библиотека шейдеров оконного сервера.** В QuartzCore этой системы её нет, поэтому вы делаете её на своей машине из той, что у вас есть, и библиотеки более позднего CoreAnimation, которую даёте сами. В репозиторий она не попадает.

```sh
CA_QC_METALLIB=/путь/к/default.metallib tools/ca-metallib.py ~/ca-share
```

**Путь hakios-metal.** Положите [hakios-metal](https://github.com/oosexgang/hakios-metal) рядом с основным репозиторием.

```sh
tools/mk-mesa.sh
(cd ../hakios-metal && make ios HAKIOS=../hakios-xnu-kernel MESA=1)
METAL_PLUGIN=ca RC_JOBS=rc.jobs.bench EXTRA_SHARE=~/ca-share REST=1 SYSTEM=1 userland/build.sh
```

**Путь Metal поверх Vulkan.** Ещё нужны cargo из rustup с Rust 1.98 и целью `aarch64-apple-ios`, `llvm-as` из LLVM 21 (apt: `llvm-21`), `glslang-tools`, clang и theos iPhoneOS 16.5 SDK. Исходники скрипты забирают сами, на закреплённых ревизиях. Его среда выполнения под GPL-2.0-or-later или LGPL-3.0-or-later и компонуется статически: что обязывает бинарник такой сборки, ещё [предстоит проверить](/docs/reference/metal#licenses), поэтому собирайте для себя и не раздавайте.

```sh
tools/mk-mesa.sh && tools/mk-turnip.sh && tools/mk-m2v.sh
METAL_PLUGIN=ca TURNIP=1 M2V=1 RC_JOBS=rc.jobs.bench EXTRA_SHARE=~/ca-share REST=1 SYSTEM=1 userland/build.sh
```

**Запуск и измерение.** Одна команда забирает телефон из Android, загружает систему, прогоняет четыре круга бенчмарка и пишет сводку. Из Windows: сборка в WSL, это — в Git Bash: [Windows](/docs/windows).

```sh
tools/metal-run.sh                      # hakios-metal, 180 с; сводка в logs/<время>-metal.txt
MORE="metal_m2v=1" tools/metal-run.sh   # Metal поверх Vulkan
MORE="wallpaper_cache=1" tools/metal-run.sh   # любой аргумент загрузки сверх стандартных
```

Скрипт задаёт `wallpaper_freeze=1`, поэтому значки один раз моргают на домашнем экране, а обои не меняются до следующей загрузки. Чтобы запустить без него, измените `ARGS` в скрипте: через `MORE` его не выключить.

В сводке кадры по жестам (`tools/frames.py`), счётчики плагина, отказы, кадры на панели и падения, если были. Что делает каждый аргумент загрузки: [таблица](/docs/reference/metal#boot-arguments).

## Модель команд Metal сама по себе

**hakios-metal** превращает работу Metal в собственные командные пакеты GPU Adreno и передаёт их напрямую драйверу GPU в ядре. Остаток страницы — об этом драйвере самом по себе: его тесты, проба и вызов из кода.

| Часть | Состояние |
|---|---|
| очереди и командные буферы — с состояниями Metal и обработчиками завершения в порядке отправки | **работает** на GPU телефона |
| буферы в памяти GPU | **работает** |
| копирование и заливка (blit) командным процессором GPU | **работает** на GPU телефона |
| библиотеки шейдеров `.metallib`: чтение и проверка | **работает** |
| шейдеры, конвейеры отрисовки, текстуры | **работает для оконного сервера**: плагин `METAL_PLUGIN=ca` и hakios-metal, собранный с `MESA=1` |
| плагин по умолчанию, `userland/src/HakiosMetal.m`, для других программ | буферы, командные буферы и blit; чего он не умеет, пишет в журнал |

На Adreno 642L в POCO X5 Pro 28 октября 2026 года проба прошла все проверки:

| Проверка | Результат |
|---|---|
| копирование 500 000 байт | байт в байт, соседняя память не тронута, 4,2 мс |
| заливка 4, 256, 260, 65 540 и 999 996 байт | всё верно |
| 40 командных буферов одновременно | завершились по порядку, с обработчиками |
| копирование 16 МБ | 182 мс (92 МБ/с: верно, но медленно; быстрый путь — блиттер GPU) |

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
| `1` | только тестовая программа `metal_test`; с плагином `METAL_PLUGIN=ca` — только оконный сервер |
| `2` | все процессы, кроме оконного сервера (плагин по умолчанию) |
| `3` | все процессы (плагин по умолчанию) |

> **Почему выключено по умолчанию.** Плагин по умолчанию не умеет рисовать для оконного сервера: с `metal=3` тот просит устройство, падает и перезапускается по кругу. Держите 1 или 2, если образ не собран с `METAL_PLUGIN=ca`.

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

1. Перетаскивание: пока палец двигает страницу, кадры идут с частотой 75–80 в секунду, а в анимации после него большинство кадров занимает один период обновления. Почему оконный сервер так долго ждёт GPU, не установлено.
2. Обои: 92 кадра в секунду на кнопке «домой» получены тем, что обои застывают в одну картинку. Обои, которые движутся или меняются, снова это стоят.
3. Разрывы кадра: панель читает тот же буфер, в который пишет драйвер. Запись позади линии сканирования (`fb_beam`, включена по умолчанию) убрала полосы на глаз и не стоит кадров; 2–16 кадров за 5 с всё ещё опаздывают к своей развёртке.
4. В пути Metal поверх Vulkan — слияние после каждого кадра: вычислительный проход поверх тайлового изображения.

Как к этому пришли, со всеми шагами и тестами: [план](/docs/metal-plan) и [компилятор шейдеров](/docs/air).

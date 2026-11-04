# Metal

Metal is Apple's GPU interface: programs record work into command buffers and the GPU runs it. On the POCO X5 Pro 5G the window server can draw through Metal on the Adreno 642L, by two paths, chosen at boot. Without `metal=1` it draws through OpenGL ES, as it always has.

## Where it stands

Measured on the phone on 3 and 4 November 2026: the Adreno at 550 MHz, the panel 1080 x 2400 at 120 Hz. Both paths draw the system correctly. **120 frames a second has not been reached.**

<!-- FINAL-NUMBERS -->

| | hakios-metal | Metal on Vulkan |
|---|---|---|
| How | the Adreno's own command packets; shaders compiled by Mesa's ir3 in the process | UniXNU's stack: AdrenoMetal's frontend, metal2vulkan, Turnip |
| Page swipe, frames a second | 100 to 104 | 50 to 57 |
| Settings' scroll | 109 | 41 |
| Opening an app | about 90 | not recorded |
| Home button | 92 with the wallpaper frozen to one picture (`wallpaper_freeze=1`), 28 with `wallpaper_cache=1` | 41 to 57 |
| Frames over 16.7 ms | 4% | not recorded |

After the finger lifts, 185 of a swipe's 205 frames on hakios-metal take 8.3 ms, one refresh. While it drags, frames come at 75 to 80 a second, with the window server waiting 8 to 14 ms on the GPU. Everything that was tried, and what did not help: [Metal measurements](/docs/reference/metal-measurements). The whole reference: [Metal on the Adreno](/docs/reference/metal).

Only the system's own interface is shown drawing. Other Metal programs are not shown to work, and games are not claimed.

## Draw the window server through Metal

You build this yourself. Nothing of it is in `prebuilt/`, and `PREBUILT=1` compiles no plug-in: you need the cross toolchain (`xnu-deps/setup.sh`), your own Darwin user space laid out with `sysimage/unpack.sh`, and the phone's GPU firmware in `fw-gpu/`.

**The window server's shader library.** This system's QuartzCore has none, so you make one on your machine from the one you have and a later CoreAnimation's that you supply. It is never committed.

```sh
CA_QC_METALLIB=/path/to/default.metallib tools/ca-metallib.py ~/ca-share
```

**The hakios-metal path.** Put [hakios-metal](https://github.com/oosexgang/hakios-metal) beside the main repository.

```sh
tools/mk-mesa.sh
(cd ../hakios-metal && make ios HAKIOS=../hakios-xnu-kernel MESA=1)
METAL_PLUGIN=ca RC_JOBS=rc.jobs.bench EXTRA_SHARE=~/ca-share REST=1 SYSTEM=1 userland/build.sh
```

**The Metal on Vulkan path.** It also needs rustup's cargo with Rust 1.98 and the `aarch64-apple-ios` target, `llvm-as` of LLVM 21 (apt: `llvm-21`), `glslang-tools`, clang, and the theos iPhoneOS 16.5 SDK. Its sources are fetched at pinned revisions by the scripts. Its runtime is GPL-2.0-or-later or LGPL-3.0-or-later and is linked statically: what a binary so built obliges is [to verify](/docs/reference/metal#licenses), so build it for yourself and do not hand it round.

```sh
tools/mk-mesa.sh && tools/mk-turnip.sh && tools/mk-m2v.sh
METAL_PLUGIN=ca TURNIP=1 M2V=1 RC_JOBS=rc.jobs.bench EXTRA_SHARE=~/ca-share REST=1 SYSTEM=1 userland/build.sh
```

**Run and measure.** One command takes the phone from Android, boots, runs the bench four rounds and writes a summary. From Windows, the build in WSL and this in Git Bash: [Windows](/docs/windows).

```sh
tools/metal-run.sh                      # hakios-metal, 180 s; the summary in logs/<time>-metal.txt
MORE="metal_m2v=1" tools/metal-run.sh   # Metal on Vulkan
MORE="wallpaper_cache=1" tools/metal-run.sh   # any boot argument beside the defaults
```

The script sets `wallpaper_freeze=1`, so the icons blink once at the home screen and the wallpaper stays still until the next boot. To run without it, change `ARGS` in the script: `MORE` cannot turn it off.

The summary has the frames per gesture (`tools/frames.py`), the plug-in's counters, what was refused, the frames on the panel, and any crash. What each boot argument does: [the table](/docs/reference/metal#boot-arguments).

## Metal's command model on its own

**hakios-metal** turns Metal's work into the Adreno's own command packets and hands them straight to the kernel's GPU driver. The rest of this page is that driver by itself: its tests, its probe, and calling it from code.

| Part | State |
|---|---|
| command queues and command buffers, with Metal's states and completion handlers in commit order | **works**, on the phone's GPU |
| buffers in GPU memory | **works** |
| blits: copy and fill, done by the GPU's command processor | **works**, on the phone's GPU |
| `.metallib` shader libraries: read and checked | **works** |
| shaders, render pipelines, textures | **works for the window server**, in the plug-in `METAL_PLUGIN=ca` builds and hakios-metal built with `MESA=1` |
| the default plug-in, `userland/src/HakiosMetal.m`, for other programs | buffers, command buffers and blits; what it does not implement it logs |

On the POCO X5 Pro's Adreno 642L, on 28 October 2026, the probe passed every check:

| Check | Result |
|---|---|
| copy 500,000 bytes | byte for byte, nothing around it touched, 4.2 ms |
| fill 4, 256, 260, 65,540 and 999,996 bytes | all correct |
| 40 command buffers in flight | completed in order, with their handlers |
| copy 16 MB | 182 ms (92 MB/s: correct but slow; the fast path is the GPU's blitter) |

## How the pieces fit

```text
a Metal program
   │  MTLDevice · MTLCommandQueue · MTLCommandBuffer · MTLBlitCommandEncoder
   ▼
HakiosMetal.bundle        the Metal plug-in (hakios-xnu-kernel: userland/src/HakiosMetal.m)
   ▼
command.hpp               queues, command buffers, blits → PM4 packets (pm4.hpp)
   ▼
gpu.hpp                   GPU buffers, submissions, fences
   ▼
transport                 iokit_transport on the phone  ·  fake_gpu in the tests
   ▼
HakiosGPU                 the kernel's GPU driver (drivers/gpu/hakios.gpu.cpp)  ──►  Adreno
```

How Metal finds it: with the boot argument `metal=N`, the kernel names `HakiosMetal` as the GPU's Metal plug-in. Metal loads `/System/Library/Extensions/HakiosMetal.bundle`, and `MTLCreateSystemDefaultDevice()` returns our device.

| `metal=` | Who sees the Metal device |
|---|---|
| (not set) | nobody: the default, on purpose |
| `1` | only the test program `metal_test`; with the `METAL_PLUGIN=ca` plug-in, the window server alone |
| `2` | every process except the window server (default plug-in) |
| `3` | every process (default plug-in) |

> **Why off by default.** The default plug-in cannot draw for the window server: with `metal=3` it asks for the device, fails and restarts in a loop. Keep it at 1 or 2 unless the image was built with `METAL_PLUGIN=ca`.

## 1. Build and test on your computer

The tests run the driver against a fake GPU that is as strict as the real command processor: a bad parity bit, a count past the end, an unknown opcode or an address outside every buffer is a fault, not a crash. Any C++17 compiler on macOS or Linux.

```sh
git clone https://github.com/oosexgang/hakios-metal.git
cd hakios-metal
make test             # 21 tests against the fake GPU
out/host/tests copy   # only the tests whose name contains "copy"
```

## 2. Run the probe on the phone's GPU

The probe does on the real GPU what the tests do on the fake one, one line per check. You need the phone running hakios with `gpu=1` (so `fw-gpu/` pulled), and the iPhoneOS 16.5 SDK, which `xnu-deps/setup.sh` in the main repository fetches.

Put `hakios-metal` beside the main repository:

```text
work/
├── hakios/          hakios-xnu-kernel
└── hakios-metal/
```

```sh
cd hakios-metal
make ios HAKIOS=../hakios        # out/ios/hakios-metal-probe and out/ios/libhakios-metal.a
cd ../hakios
# the job list: what the system runs once it is up
printf '/redwood/bin/hakios-metal-probe\n' > userland/rc.jobs.metalprobe
EXTRA="../hakios-metal/out/ios/hakios-metal-probe" RC_JOBS=rc.jobs.metalprobe userland/build.sh
./xl enter && ./xl ramdisk userland/system.apfs
XL_SECS=120 XL_CMDLINE="$(tools/hakios-config.py args) gpu=1" ./xl run
grep probe: logs/last.log
```

- `EXTRA` copies programs from your computer into `/redwood/bin` on the phone.
- `RC_JOBS` picks the list of commands the system runs once it is up. A job list is not a shell script: one command per line, no variables or quoting.
- What a good run prints:

```text
probe: GPU 660, chip id 0x…
probe: ok   …          one line per check: the copy, the fills, the 40 command buffers, the 16 MB copy
probe: 0 failures
```

The exit status is the number of failures; `100` means no GPU (the line before says why, for example that the kernel was started without `gpu=1`).

## 3. Use it from code

### Through Metal (Objective-C)

This is the real API path: the same calls an app makes. It is a trimmed piece of `userland/src/metal_test.m`.

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

- Offsets and sizes must be multiples of 4.
- It needs `gpu=1` and `metal=1` (or higher) on the command line.
- What the plug-in does not implement yet is logged as `HakiosMetal: asked and not implemented: -...` and answered with nil: the log tells you exactly what an app wanted.

### Without Metal (C)

`include/hakios-metal/hakios_metal.h` is a small C interface you can call from any program. Every call says whether it worked; the reason is in `hakios_metal_error()`.

```c
#include <hakios-metal/hakios_metal.h>

hakios_metal_device *d = hakios_metal_open();      /* NULL without gpu=1: see hakios_metal_error() */
hakios_metal_buffer *a = hakios_metal_buffer_new(d, 4096);
hakios_metal_buffer *b = hakios_metal_buffer_new(d, 4096);
memset(hakios_metal_buffer_contents(a), 0x3c, 4096);

hakios_metal_queue *q = hakios_metal_queue_new(d);
hakios_metal_cb *cb = hakios_metal_cb_new(q);
hakios_metal_cb_copy(cb, a, 0, b, 0, 4096);        /* 0, or -1 and the reason in hakios_metal_error() */
hakios_metal_cb_commit(cb, NULL, NULL);            /* or a callback, run on the queue's thread */
hakios_metal_cb_wait(cb);
/* hakios_metal_cb_status(cb) == HAKIOS_METAL_COMPLETED */
hakios_metal_cb_free(cb);
```

`hakios_metal_open_fake()` gives the same device on the fake GPU, for tests on your computer.

### Linking the plug-in with the GPU

`userland/build.sh` builds `HakiosMetal.bundle` with GPU command buffers and blits only if it finds `../../hakios-metal/out/darwin/libhakios-metal.a` (or `$HAKIOS_METAL/out/darwin/...`). Without it, buffers live in plain memory and the queue makes no command buffers. The hakios-metal Makefile writes the library to `out/ios/` for now; until it has a `darwin` target, put it where the build looks:

```sh
mkdir -p ../hakios-metal/out/darwin && cp ../hakios-metal/out/ios/libhakios-metal.a ../hakios-metal/out/darwin/
userland/build.sh        # prints "HakiosMetal with hakios-metal (...)" when it found it
```

## Try it in QEMU

QEMU has no Adreno, so there is no GPU path there, but you can see what Darwin believes about Metal: the services it looks for, the plug-in loading, the device `MTLCreateSystemDefaultDevice()` returns.

```sh
RC_JOBS=rc.jobs.metal REST=1 userland/build.sh
CMDLINE="metal=1" qemu/run-darwin.sh 600 -display gtk > logs/qemu.log
```

The session must be long: in QEMU SpringBoard is up after about 208 seconds, and `metal_test` runs after it, so give it 480 seconds or more.

## What comes next

1. The drag: frames come at 75 to 80 a second while a finger moves the page; in the animation after it most frames take one refresh. Why the window server waits on the GPU that long is not established.
2. The wallpaper: the home button's 92 frames a second come from freezing it to one picture. A wallpaper that moves or changes costs that again.
3. Tearing: the panel reads the one buffer the driver writes. Writing behind the scan line (`fb_beam`, on by default) removed the bands to the eye, and costs no frames; 2 to 16 frames in 5 s still miss their scan.
4. On Metal on Vulkan, the merge back after each frame: a compute pass over a tiled image.

How it got here, every step and test: [the plan](/docs/metal-plan) and [the shader compiler](/docs/air).

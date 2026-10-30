# Metal

Metal is Apple's GPU interface: apps record work into command buffers and the GPU runs it. In hakios, **hakios-metal** turns that work into the Adreno GPU's own command packets and hands them straight to the kernel's GPU driver. No Vulkan, no Mesa in between.

## Where it stands

| Part | State |
|---|---|
| command queues and command buffers, with Metal's states and completion handlers in commit order | **works**, on the phone's GPU |
| buffers in GPU memory | **works** |
| blits: copy and fill, done by the GPU's command processor | **works**, on the phone's GPU |
| `.metallib` shader libraries: read and checked | **works** |
| shaders: running a Metal function on the GPU | **not yet**: the AIR → NIR → ir3 compiler exists in hakios's Mesa build and is being joined to the driver |
| render and compute pipelines, textures | **not yet** |
| the system drawing its UI through Metal | **not yet**: it draws through OpenGL ES today |

On the POCO X5 Pro's Adreno 642L, on 28 October 2026, the probe passed every check:

| Check | Result |
|---|---|
| copy 500,000 bytes | byte for byte, nothing around it touched, 4.2 ms |
| fill 4, 256, 260, 65,540 and 999,996 bytes | all correct |
| 40 command buffers in flight | completed in order, with their handlers |
| copy 16 MB | 182 ms (92 MB/s: correct but slow; the fast path is the GPU's blitter, next) |

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
| `1` | only the test program `metal_test` |
| `2` | every process except the window server |
| `3` | every process |

> **Why off by default.** A Metal device that cannot draw yet makes the window server ask for it, fail, and restart in a loop. Until shaders work, keep `metal=` at 1 or 2.

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

1. Shaders: connect the AIR front end (`tools/mesa/air` in the main repository) to the driver, so a Metal function compiles to the Adreno's ir3. Of the system's 456 shader modules, 321 already reach ir3 and 54 have run on the phone's GPU.
2. Render and compute pipelines over those shaders.
3. Fast copies through the GPU's blitter.
4. Then CoreAnimation can draw through Metal instead of OpenGL ES.

The long plan, with every step and test: [Metal on the Adreno](/docs/metal-plan) and [the shader compiler](/docs/air).

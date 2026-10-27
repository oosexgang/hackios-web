# AIR → NIR: a Metal shader frontend for Mesa

This is the compiler third of running Metal on the Adreno of this port: a translator from Apple's
shader bitcode (AIR, the contents of a `.metallib`) to Mesa's NIR, so that ir3 — the same compiler
that already runs the port's OpenGL ES through freedreno — turns Metal shaders into Adreno code.

The other two thirds are **not** here and are not started: the `_MTLDevice`/`IOGPUMetalDevice`
object graph (AGXMetalA11 alone is 53 classes and 1158 methods, IOGPU.framework 711 more), and the
kernel ABI that submits work. Where a decision below constrains them it says so, and section 7
collects those constraints in one list.

Why this is worth doing at all, and what it costs, is argued in `docs/metal.md` section 9. This
document assumes those measurements and records the decisions taken on top of them.

## Where it stands, and what that does not mean

Of the 456 modules of the device's system `.metallib` files (`tools/air/check.sh`, and
`docs/air-report.md` for the breakdown):

| | of 456 |
| --- | --- |
| read by our own bitcode reader, byte for byte as `llvm-dis` reads them | 456 |
| translated to NIR, passing `nir_validate` | 321 |
| compiled by ir3 into Adreno machine code | 321 |
| numerically identical to LLVM's own execution, and drawn | 255 |
| **run on the phone's GPU** — 7 drawn, 47 dispatched | **54** |

And of the 119 distinct `air.*` operations those modules call (`tools/air/intrincheck.py`):

| | of 119 |
| --- | --- |
| checked numerically, one operation at a time, against a reference outside this tree | 78 |
| of those, exactly defined and agreeing on every case (45 697 cases) | 71 |
| of those, approximate, so measured against libm and nothing concluded | 7 |
| of those, also *run* by a Gallium driver rather than folded (softpipe, 2 586 cases) | 47 |
| of those, run **on the phone's own Adreno** (714 cases) and agreeing there | 61 |
| of those, disagreeing before the `ir3` rounding fix this port now carries (0 after) | 5 |
| of those, set aside: they return `half`, which `air_run` cannot read back | 10 |
| the atomics and the barrier, against kernels written for them (`atomiccheck.py`) | 10 |
| texture operations verified exactly, on several texels each (`texopcheck.py`) | 13 |
| texture operations with a case softpipe cannot run: a 16-bit result | 7 |
| texture operations with no case: multisample, depth, write | 11 |

321 of 456 is **every entry point** of the corpus: 271 fragment shaders, 47 compute kernels and 3
vertex shaders. The other 135 modules are `air.visible` library functions, not entry points at
all, and they have a measurement of their own:

| the 135 library functions | |
| --- | --- |
| wrapped in a generated entry point and translated (`--library`) | 124 |
| refused: a texture, sampler or matrix argument the wrapper cannot pass | 11 |
| dispatched by a Gallium driver and read back | 124 |
| of those, agreeing with our own constant folding of the same shader | 104 |
| of those, run but disagreeing | 0 |
| ran, but the folder did not reduce the result to a constant | 20 |
| **agreeing with LLVM on this machine, bit for bit** | **21 of 21** |

`tools/air/libcheck.py` prints that table and refuses to print it when the rows do not add up.
The last row is the one that counts, and it is small for a stated reason: LLVM can be the
reference only for a function that calls no `air.*` at all, because an `air.*` call is an
undefined symbol on the host and defining one would put our own reading of that operation on
both sides of the comparison. 57 more call only exactly defined `air.*` operations and could be
compared that way if those definitions were written; 46 call an approximate one
(`air.fast_pow` and the like), which nothing compares bit-exactly anywhere.

**What a library function's measurement is not: evidence about Metal's stitching.** Metal links
these into a caller at pipeline time through the ABI their own metadata describes
(`air.stitching_info`, with the four functions that do it and each argument's size and
alignment). That ABI is the runtime's, not the compiler's, and it is not implemented. The wrapper
is this project's own calling convention, invented to make the bodies runnable.

**And what the 456 itself is not: the number of shaders on the device.** It is the number of
modules in the `.metallib` *files* under `sysimage/rootfs`. A library can also be a blob inside a
dylib — `GPUCompiler`'s own `GNR.videoprocessor` carries one in `__DATA`, found while looking for
something else — so every statement here of the form "the corpus contains no X" is bounded by how
the corpus was collected, not by what the system contains. Where that distinction matters, this
document says so; extending the corpus to embedded libraries would move this denominator and
every percentage computed from it, so it is a change to make in one commit and recount, not a
figure to adjust.

**What those numbers are not**, because they will be quoted without this paragraph otherwise:

- **The arithmetic operations are checked; two of them have now been checked against the
  Adreno, and the other 76 have not.** 71 of the corpus's declarations agree with C's own
  functions on every one of 45 697 cases, and 47 of them agree again when *executed* by softpipe
  instead of folded — which is a real answer to what used to be the largest hole here (section 4,
  item 4), and found three bugs getting there. But those two engines are both on an x86 host. An
  opcode whose Adreno instruction differs from what `nir_opt_constant_folding` and TGSI compute is
  invisible to all 48 283 of those cases, and the 24 narrow-type declarations softpipe cannot run
  at all are exactly the ones where ir3 differs most from it.

  On 20 October that stopped being true. All 78 declarations ran on the phone's own Adreno, and
  twice: once as the port stood, and once with the one-line `ir3` rounding fix this tree now
  carries (`tools/mesa/ir3-round-default.patch`).

  | | agree | differ | set aside | cases |
  | --- | --- | --- | --- | --- |
  | as the port stood (`logs/090218-run.log`) | 56 | **5** | 10 | 714 |
  | with the rounding fix (`logs/090918-run.log`) | **61** | **0** | 10 | 714 |

  The 5 were the whole point of having gone there, because every engine on this machine agrees
  with C about them. All five are integer-to-float conversions:
  `air.convert.f.{f32,v2f32,v3f32}.u.*` and, once the pool was sharpened to ask,
  `air.convert.f.{f32,v2f32}.s.*` as well — `i2f` truncates exactly as `u2f` does, which the
  earlier pool had no value to notice. With the fix all five agree and nothing else moved, which is
  the useful shape of an after-measurement: the thing that was wrong is right, and nothing that was
  right has changed.

  **An earlier version of this paragraph said 66 agree on 808 cases, and that was 10 declarations
  too many.** It also said the 24 narrow-type declarations softpipe cannot run had all run on the
  Adreno and agreed, which was the part that mattered and the part that was wrong. Ten of them
  return `half`, `air_run` reads back through a 32-bit float target and has none that is 16 bits
  wide, so the half is widened at once and NIR folds the conversion into a 32-bit one: the
  reference describes an operation the shader does not perform. They are now set aside by name —
  `air.convert.f.f16.{s.i32,u.i16,u.i32,u.i8}`, `air.fmax.{f16,v4f16}`, `air.fmin.{f16,v4f16}`,
  `air.mix.f16`, `air.saturate.f16` — and 56 + 5 + 10 = 71 closes the account. What is true of the
  narrow types is narrower than before: the `i1`, `i8` and `i16` ones ran and agree; the `f16` ones
  were never asked. Nothing refused to run, though: no assertion, no fallback, no module missing.

  The row "run on the phone's GPU" in the first table above does not count these: it counts
  modules of the 456-module corpus, and these are generated modules that are not in it. The two
  measurements are deliberately not added together. That row now reads **51** for a different
  reason — 7 fragment shaders drawn and 44 compute kernels dispatched, which are disjoint sets
  because a kernel is not a fragment shader. It read 7 until the kernels ran, and it stayed 7 for
  a while after they did, which is the third time this one figure has been left behind by the work
  that moved it.
- **Two traps this frontend's own checks fell into, kept here for the instances; the general forms
  are in README's "Как врут собственные проверки", which collects all six and belongs there because
  the others came from the camera, the services and the build rather than from AIR.** Comparing one
  file of Mesa's `main` against ours had to start from a fresh tarball extract, because ours carries
  our own patch — 202 487 bytes against 202 144 clean — so a comparison from this tree would have
  differed by exactly our own change. And `patch -s --dry-run` exiting 0 against that file was
  written down as "applies cleanly" when without `-s` it says "succeeded at 410 (offset 2 lines)":
  the context matched and the line number had moved, which is the more useful statement and the one
  the patch header now carries.

- **A `continue` that adds nothing to a total is where this check has gone wrong three times.**
  Not a maxim but a thing to grep for, and the general form is in README beside the other five.
  Three times on 20 October an absent check was dressed as a passing one, and each time the shape
  was identical: a loop skipped a case and incremented no counter, so "not examined" was reported
  as "examined and agreed".

  - `if idx >= len(flat): continue` dropped every case whose value was missing from the log, and
    the total fell by exactly as much as nobody was watching;
  - `read_whole`'s predecessors read a configuration file with one `read()` into a fixed buffer, so
    a file past its buffer silently lost its tail and the jobs in it never ran;
  - `check_log` skipped every infinite expectation, which is how ten `half`-returning declarations
    came to be reported as agreeing on every case when three of every four cases were not compared
    at all.

  So the rule is not "skip less". It is that every case set aside must reach the summary with its
  own number and its own reason, and that a verdict resting on very few cases must say how few —
  `air.all.v2i1` agrees on two cases, and that is worth knowing before quoting it. Green has to
  mean "looked at and agreed", never "did not look".

- **The Adreno truncates `u32 → f32` where C, NIR and softpipe round.** This is the first thing
  found here that no engine on this machine could have found, and it is why the suite was carried
  to the phone at all. `air.convert.f.f32.u.i32` and its 2- and 3-component forms, given
  `0xFFFFFFFF` (4 294 967 295 unsigned), return **4 294 967 040** where C returns
  **4 294 967 296**.

  The arithmetic is worth writing out, because the two numbers look like a printing difference and
  are not. In `binary32` the spacing between representable values in [2³¹, 2³²) is 2⁸ = 256, so the
  neighbours of 2³² − 1 are 2³² − 256 and 2³². Their distances from it are 255 and 1, so
  round-to-nearest gives 2³² = `0x4f800000`, which is what `(float)4294967295u` is in C, checked
  by compiling it. The Adreno's answer, 2³² − 256, is exactly `0xFFFFFFFF & 0xFFFFFF00`: the low
  eight bits dropped. That is truncation toward zero, not rounding. Metal's conversions are
  OpenCL's, which require round-to-nearest-even, so this is a real divergence and not a matter of
  taste. Only the cases where rounding decides anything differ — 1 of 4, 2 of 8 and 3 of 12 — and
  every value that is exactly representable agrees.

  **Where it comes from is settled as far as inspection can settle it, and no further.** Two of the
  three possible culprits are eliminated by reading code rather than by guessing:

  - the frontend emits `nir_u2fN`, the correct opcode (`air_intrinsics.c`, the `convert` branch);
  - ir3 turns that into a *single* `cov.u32f32` with no compensation. For a 32-bit source
    `create_cov` has no special case at all — the special cases there are for 8-bit sources and
    for `f32 → u8`. The generated Adreno code for the module is five instructions, four of them
    `cov.u32f32` reading straight out of the constant buffer, with nothing between the load and the
    conversion.

  So the truncation is the behaviour of the a6xx `cov.u32f32` instruction itself. **Whose job it is
  to compensate is not established**, and needs the a6xx ISA documentation, which is not to hand:
  if `cov` is specified to round, this is a hardware erratum ir3 should work around; if it is
  specified to truncate, then every API that requires round-to-nearest — OpenCL, Metal, and Vulkan's
  `ConvertUToF` — has to compensate, and ir3 does not. Not worked around in the frontend, because
  the frontend is emitting the right opcode and a workaround there would hide a fault that belongs
  to everything ir3 compiles.

  **The prediction that followed has been tested and holds, by a peer session rather than here.**
  The port's OpenGL ES goes through the same ir3 and the same instruction, so a GLES shader should
  truncate identically — and `userland/src/u2f_test.c` (`RC=rc.u2f`) asks GLSL ES 3.0 the same
  question through the same Mesa, with no AIR anywhere in it. Four of its six inputs disagree with
  C on `freedreno; Adreno 7c+ Gen 3; OpenGL ES 3.2 Mesa 25.0.7`, and the two that agree are exactly
  the two where truncation and rounding give the same answer — so agreement there is the absence of
  a question, not a confirmation. **Everything ir3 compiles on this phone converts unsigned to
  float by truncating, the window server's drawing included**, and this frontend is not party to
  it: it is physically absent from that test.

  **The cause is ir3 and not the a6xx instruction, and an earlier draft of this section had that
  wrong.** It said inspection had eliminated two of three culprits and the remaining one was the
  hardware. The steps were right and the conclusion was not: `create_cov` ends with a rounding
  field that the reading stopped short of. `cov` *has* a rounding mode — `ROUND_ZERO = 0`,
  `ROUND_EVEN = 1` in `instr-a3xx.h` — and `ir3_compiler_nir.c` sets it for a destination of
  `TYPE_F16` or `TYPE_F32` from `float_controls_execution_mode`, which is a SPIR-V declaration.
  `nir_get_rounding_mode_from_float_controls` returns `nir_rounding_mode_undef` when nothing is
  declared, so neither branch fires and the field keeps its zero, which is truncation. GLSL ES
  declares nothing and this frontend declares nothing, which is exactly why two independent paths
  returned the same wrong number. **The hardware can round; ir3 only asks when someone else has
  asked first, and supplies no default where IEEE-754 and GLSL both require round-to-nearest.**
  **How much this reaches is a number and not an adjective.** Of the 456 modules of the corpus, 20
  contain a conversion the patch can change — a `u2f`, an `i2f` or an `f2f16`, the three that
  round; none contains only the exact kinds (`f2f32`, `b2f`), where setting the mode cannot alter a
  value. So on the Metal side the blast radius is 20 modules, not all 313 that translate, and
  whether each of those 20 actually changes depends on the values it meets at run time.

  That bounds this frontend's half. **The other half has now been measured too, by a peer session,
  and the answer has a shape worth keeping.** The port's OpenGL ES reaches ir3 through Mesa's own
  GLSL compiler, which the count above does not look at, so what the patch does to the screen could
  only be answered by looking at the screen: one image, one command line, an ordinary boot to the
  home screen, patched against unpatched.

  | | differ by 1–8 | differ by more than 8 |
  | --- | --- | --- |
  | patched against unpatched (4 min 33 s apart) | 10 835 | 2 508 |
  | unpatched against unpatched (8 min 36 s apart) | **13 738** | 2 286 |

  Both large patches in the pair were cut out and looked at rather than guessed from their
  coordinates: the Clock icon, whose hands had moved, and the status bar's clock. **No geometry
  moved and no colour changed.** The small residue sat in the bottom bands — search, dock, page
  dots, the transparent things with a blur behind them — exactly where a rounding change would show
  and at exactly the magnitude predicted, which is why the control mattered: two runs of the *same*
  binary, with a larger gap, differ by **more**. So the residue belongs to the run and not to the
  patch, and the honest statement is not "nothing changed" but **"any change is smaller than what
  the screen does to itself between launches"**.

  That is the useful form here, because the pair alone would have supported a confident wrong
  answer. The pixels were in the right place, of the right size, and told a coherent story about
  blur arithmetic; a measurement without a control answers a question nobody asked, and it cost one
  extra run to find out.

  The fix is one line, and unlike the `ir3_cmdline` bug this one is in a file upstream still
  carries, with reproduction down two independent paths — so it is the first thing in this work
  that can actually be reported. The change is now carried here as `tools/mesa/ir3-round-default.patch`, measured on the
  phone before and after down both paths.

  **The same branch covers `TYPE_F16`, and that half of it is still unanswered — this suite cannot
  ask it.** Ten declarations of the corpus return `half`, and every one of them was reported as
  agreeing on the Adreno while being tested on almost nothing: the pool gave them only values that
  overflow `f16`, so their expectations read `[0, inf, inf, inf]`, and the comparison skipped every
  infinity without counting it, leaving the zero to carry the verdict. They are set aside by name
  now (the table at the top of this document has their row), and the reason is the harness and not
  the hardware: `air_run` reads back through a 32-bit float target, so a half result is widened at
  once and NIR folds the conversion into a 32-bit one. The generated Adreno code for
  `air.convert.f.f16.u.i32` is four `cov.u32f32` and not one `cov.u32f16`.

  The pool has the value that would decide it. In `f16` integers are exact to 2048 and spaced by 2
  above, so **2051** is the discriminator — between 2050 and 2052 with an odd lower neighbour,
  where round-to-nearest-even gives 2052 and truncation gives 2050 — and 2049 is carried beside it
  as a midpoint where both rules agree, to show that a midpoint is not automatically a test.

  **`air_run` now has the 16-bit render target, and it is not enough.** Picking
  `R16G16B16A16_FLOAT` for a `half` output was necessary and was only one of two causes; the other
  is in the generator, which packs every float-ish result into a `float4` with an explicit
  `fpext half ... to float` (`intrincheck.py`, `emit_buffered`). The widening therefore happens
  inside the shader and no choice of target can undo it.

  **Going further would mean guessing, so it stops here.** A half-returning fragment shader needs
  `!"air.render_target"` metadata naming the type, and the corpus is the authority on that
  vocabulary — the whole `air.*` meaning was read out of `AGXCompilerCore` rather than invented. Of
  the 456 modules, the render-target type names used are `float4` (275), `int4` (268), `uint4` (268)
  and `ushort` (2). **There is no `half4` among them.** The token does occur once somewhere in the
  shared cache, which makes the spelling plausible and attests nothing about this use of it.

  **And there is a second half to the f16 question that no harness can settle, because nothing is
  required.** One F16 path through that `create_cov` branch is `pack_half_2x16`, and
  `nir_lower_mediump.c` says of it, in Mesa's own words, "pack_half rounding is undefined". Where
  the specification requires nothing, a truncating `packHalf2x16` is a permitted choice and not a
  fault, so a measurement of it would be an observation about an implementation rather than an
  argument about conformance — and the patch's header now scopes its case to the destinations where
  a mode *is* required, integer to float, naming the `pack_half` path as a reviewer's question
  instead of leaving it to be found. A peer session had planned to reach the F16 branch through
  `packHalf2x16` for exactly that reason and dropped it on this, which is the better call: the
  experiment would have answered our internal question and been useless for the report.

  So the f16 question is two questions. For integer-to-half, round-to-nearest-even is required and
  this instrument cannot ask. For `pack_half`, nothing is required and there is nothing to ask.

  And the spelling is the smaller problem. A `half` render target appears in **no** module of the
  corpus, so a shader built around one would exercise a path through this frontend that Apple's own
  shaders never take and that nothing else here tests. A disagreement would then sit between two
  explanations — the GPU rounds wrong, or this frontend mishandles a construct it has never seen —
  and an ambiguous measurement is worth less than a stated gap. So the ten declarations stay set
  aside, and **the rounding fix is measured for 32-bit destinations only**, which is what the
  patch's header claims and no more.

  **Which rule it is, as against merely "not round-to-nearest", is settled by one value.**
  `0x01000003` is 2²⁴+3, half way between the representable 2²⁴+2 and 2²⁴+4; round-half-to-even and
  round-half-away-from-zero both give 2²⁴+4, and the GPU gives 2²⁴+2. That is truncation and nothing
  else. `0xFFFFFFFF` alone could never have shown this, and neither could `0x01000001`, the other
  midpoint, where truncation and round-to-even happen to agree — which is why the pool carries both
  and why one midpoint is not a test of a rounding rule. What remains unestablished is only whose
  job the compensation is, and that still needs the a6xx ISA documentation.

- **`air.fast_pow` returns NaN on the Adreno for a negative base, where softpipe returns the exact
  value.** `fast_pow(-0.5, 1)` is `-0.5` in C and on softpipe, and NaN on the phone. This is
  recorded rather than reported as a bug: Metal's `fast::` functions, like OpenCL's `native_`
  ones, are explicitly undefined outside a restricted domain, and a negative base is outside it.
  It is worth naming because it sits inside the "approximate, nothing concluded" bucket, which is
  exactly where a real difference can hide behind a reasonable-looking ulp figure — the line says
  "worst inf ulp", and an inf ulp is not a rounding difference. Any corpus shader that calls
  `fast_pow` with a base that can go negative will behave differently on this phone than in any
  test on this machine.
- **The atomics compute the right thing and the barrier waits; whether the atomics are *atomic*
  is still open.** `tools/air/atomiccheck.py` dispatches two kernels written for the purpose
  (section 4, item 5) and all eight operations the corpus uses agree — five on device memory
  (`add.s`, `load`, `max.s`, `min.s`, `store`), three on threadgroup memory (`add.u`, `load`,
  `store`) across two `air.wg.barrier`s. Among them a signed minimum taken across negative
  values, which is where an unsigned one passes unnoticed. The barrier is genuinely under test:
  softpipe advances its invocations in groups of four, so making the barrier a no-op leaves every
  thread seeing 4 of 16 increments, and the check says exactly that. **Atomicity is not under
  test**, because softpipe applies a group's atomic lane by lane and so cannot lose an update
  however the lowering is written. That needs the phone. Two things are settled without running
  anything: every atomic in the corpus asks for `memory_order_relaxed`, and a stronger order is
  now refused by name instead of ignored, which is what the lowering used to do.
- **All 119 declarations are now accounted for**, which is new as of tonight and is a weaker
  claim than "all checked" — the distinction matters and an earlier draft of this paragraph, and
  the commit message of `bbf6c3c`, ran the two together:

  | | of 119 |
  | --- | --- |
  | verified: the answer was compared with one computed elsewhere and agreed | 94 |
  | measured, no verdict: approximate arithmetic, against this machine's libm | 7 |
  | has a case, which softpipe cannot run: a 16-bit result or operand | 7 |
  | has no case, for a reason given in section 4 item 6: multisample, depth, write | 11 |

  The 94 are 71 arithmetic operations, 10 atomics and the barrier, and 13 texture operations. The
  derivatives and the simd reductions are in none of these rows because **no module of the corpus
  calls them**: unexercised code, not untested behaviour, and saying "unverified" of them would
  overstate what is at stake.
- **The weakest of the three groups is the textures**, and the gap is not in the fetch — which is
  now checked at the corners as well as the middle, and for integer and unsigned textures too —
  but in everything Metal's sampler state decides. The 64-bit `constexpr sampler` word is still
  not decoded (section 3.3) and every coordinate checked is a texel centre or a clean footprint
  corner, where nearest filtering has no weights to round and clamping has no arithmetic.
  The six texture shaders that drew on the Adreno took their sampler from the API too, so what
  they are evidence about is binding, descriptors and ir3's texture instructions — exactly what
  they were built to be — and silence about everything Metal's sampler state decides. **Ten**
  modules of the corpus declare a `constexpr sampler`, carrying three distinct state words, all
  ten in `PortraitFilters.cifilter/default.metallib`; everywhere else the API supplies it. This
  paragraph said "two" for a while, while the mapping table in section 7 said ten: two numbers for
  one fact in one file, and the disagreement was enough to settle it without any new evidence.
  Where the "two" came from is not established. What is worth recording is how the ten were
  counted, because the obvious way does not work: a plain `grep` for `__air_sampler_state` over
  the 456 modules finds **none**, since bitcode is bit-packed and a name matches only when it
  happens to land on byte boundaries. The count above is from `llvm-dis` output, module by
  module.
- **A function of the module that takes a texture: done, and the diagnosis was the work.** All
  four such entry points translate — three with this fix, the fourth once the shuffle mask it also
  stopped on was decoded. The fix is a split of `translate_globals`, and arriving at it took two
  reverts and three failed guesses, which is the part worth keeping.

  A texture is not a value in this frontend: it is resolved at translation time into a binding,
  and `tex_handle` wants an `AIR_VAL_PTR` rather than an SSA def. So a pointer-class argument is
  bound from the caller's own resolution and takes no NIR parameter, which specialises the callee
  to its call site — free here, since each of the four has exactly one. That much worked at once.

  What did not was everything after. The callee needs the module's globals, and copying the entry
  point's values into it crashed three of the four in `nir_lower_goto_ifs` → `nir_repair_ssa` →
  `nir_block_is_unreachable`. **Two hypotheses died with evidence before the right one arrived**:
  the callee has no unreachable block at all, and `nir_validate_shader` — the test a peer session
  proposed for it — fails identically on `fbs_slice_trilinear`, which translates perfectly, so
  its complaint about block indices in an unstructured impl was true and about something else.
  The peer's reading of the assertion was right and their route was not: it asks *the block's own*
  impl for dominance metadata, so a use in another function's block asks the wrong function — but
  the cross-function value arrived through the globals, not through an argument. A guard refusing
  a pointer argument with a byte offset was evaluated 26 times over the corpus and never fired, so
  arguments are not the carrier; the count is the evidence, because a silent guard and an
  unreachable guard look the same.

  So `translate_globals` is now two. `plan_globals` decides what each global is and runs **once**,
  because it appends inline samplers to `info->resources` and lays out shared and scratch memory.
  `materialise_globals` builds the values and runs **per function**, because a byte offset is an
  `nir_def` and a def belongs to the impl that made it. Module-level constants needed neither:
  `air_get` already materialises one in whichever builder asks, which was checked rather than
  assumed.

- **Of Apple's own 47 kernels, all 47 are dispatched on the Adreno and none crash.**
  `tools/air/kernelcheck.py` prints where each one stops, as a table whose rows are checked
  against the total before it is printed:

  | | on softpipe | **on the Adreno** |
  | --- | --- | --- |
  | dispatched and read back | 6 | **47** |
  | softpipe's `nir_to_tgsi`: scratch and intrinsics it lacks | 41 | — |
  | a shuffle mask our reader would not decode (ours, now fixed) | 0 | 0 |
  | **crashed `air_run`** (a defect here, not a limit) | 0 | **0** |

  `logs/170547-run.log`, 710 919 bytes with no truncation marker. The three that the shuffle-mask
  fix unblocked dispatched on the first run and read their images back; two of them bind six
  textures, which is well past where the sampler bug used to fault, so that fix is confirmed a
  second time by shaders it was not measured on.

  **The deferred question is answered: ir3 runs them.** 41 kernels stop at a software rasteriser
  that has no scratch memory and lacks compute intrinsics; on the hardware every one of the 47
  dispatches and reads its result back, images and all. The phone replaced softpipe, and both
  columns that were ours — the harness's refusals and the frontend's — are empty.

  What the rows do **not** say is right. There is no executed reference for these kernels
  anywhere: softpipe refuses 41 of them, which is why they came here, so a number out of the
  Adreno has nothing on this machine to disagree with. 47 have been shown to *run*, which is a
  statement about capability and not about correctness.

  **The last row was blaming the shader for our own gap.** "A shuffle mask that is not constant"
  was impossible as written: LLVM requires a `shufflevector` mask to be constant, so the message
  was describing something that cannot occur. What the three kernels actually carry is a mask like
  `<i32 0, i32 poison, i32 1, i32 poison>` — the shape a Metal `half2`-to-`half4` widening
  compiles to — and in it the zero is written `CST_CODE_NULL`, not `CST_CODE_INTEGER 0`, because
  that is how LLVM stores every zero of a scalar type. A mask is stored as an aggregate of
  element constants rather than as plain data exactly when one lane is poison, so those two
  encodings meet only in this case, and our reader accepted only the second. We refused on a zero
  we could read perfectly well, and recorded it as a limit of the shader.

  **And the decoder for it already existed.** `air_const_uint` (`air_module.h`) has read both
  spellings since long before this, with a comment beside one of its callers saying that a zero
  arrives as `CST_CODE_NULL` about as often as not. Four places tested `ckind == AIR_CONST_INT`
  by hand instead of calling it — the shuffle mask, the `llvm.memcpy` and `llvm.memset` lengths,
  and the `air.wg.barrier` flags — and the shuffle mask is the one where it cost something. All
  four go through the helper now, which removed more code than it added.

  The first write-up of this fix claimed it "closes a class" by adding that decoder. It did not:
  the class was already closed and one reader had opted out of it, which is a different and less
  flattering story. Worth keeping for the shape — a hand-rolled test beside an existing helper
  that does the same job, in a file big enough that neither author sees the other.

  The four that used to crash now dispatch, and the crash was this harness's:

      void *csampler = NULL;
      pipe->bind_sampler_states(pipe, PIPE_SHADER_COMPUTE, 0, num_tex, &csampler);

  `bind_sampler_states` reads `num_tex` pointers from the address it is given, and `&csampler` is
  the address of *one*, so it reads `num_tex - 1` words past that variable and stores whatever is
  there as `samplers[1..]`. The draw path beside it has always built a proper `void *samplers[]`
  array, so the new code failed to learn what the old code already knew. The fault was at
  `fd6_texture_state + 0xd4`, reached through `fd6_emit_cs_state` from `fd_launch_grid`: a wild
  pointer plus a small field offset, which is exactly the `0x100000000034` that was being
  dereferenced.

  **What that mechanism does and does not predict.** Both of freedreno's loops skip an empty slot
  (`if (!tex->samplers[i]) continue;` in `fd6_texture_state`, a zeroed dummy in the emit path), and
  `fd_sampler_states_bind` sets a slot's valid bit only for a non-NULL pointer — so a stack word
  that happens to be zero is read, stored and harmlessly ignored. The read goes out of bounds at
  `num_tex >= 2`; the *fault* needs one of those words to be non-zero. So the texture count is not
  a threshold, and the pre-fix run says so plainly (`logs/155708-run.log`): eight kernels with two
  textures (`BlitKernel_Unorm`, three `BlitLuma*`, `MetalFaceMask_GenerateMask`, `confidence`,
  `fbs_bistochastize_final`, `fbs_slice_trilinear`) and two with three (`BlitChromaKernel_Uint`,
  `BlitChromaKernel_Unorm`) all dispatched while the read was still out of bounds for every one of
  them. The four that died read 4, 4, 6 and 6. Said as a threshold of two, this would predict a
  crash for ten kernels that did not crash.

  **The feature that looked discriminating was a confound, and the run settled it.** Exactly 4 of
  the 47 kernels carry an inlined module-local function; three crashed and the fourth was refused
  earlier on the shuffle mask, so every one that reached dispatch died — 3 of 3, which is not a
  correlation so much as an invitation. `spillCorrectionPreProcess` carries no call at all and
  died with them, and all four now dispatch with the inlining path untouched. Had the inlining
  been "fixed" instead, three might have gone through and the fourth would have been left needing
  a second cause.

  Two other explanations were already dead before this one, and killing them was what left the
  adjacent line to be read: the driver's texture state is not uninitialised
  (`CALLOC_STRUCT(fd6_context)` zeroes it), and it was not "an image with no buffer", because
  nine kernels of exactly that shape — one image, written — dispatched throughout
  (`logs/155708-run.log`). A peer session's reading of the same
  function proposed `view_seqno[16]` overflowing against `textures[32]` — a real fragility in
  freedreno — and it is not reachable from here, because this harness refuses a slot index of 16
  or more by name. Checking whether someone else's bug was reachable, instead of looking one line
  further for our own, is how two of the three earlier attempts on this function were spent.

  `air_run` now prints the texture count beside the image count, which is what made the paragraph
  above a measurement instead of an argument — and the first thing written from that run was still
  the wrong generalisation, "two is the threshold", corrected with a guess ("there are surely
  kernels reading two among the forty") when the counts were already in the log. A peer session
  counted them. That is where accuracy usually goes: not in the first claim but in its repair,
  which arrives feeling like diligence and is rarely re-checked against the same evidence.

  The row for a call of a module-local function was 5 until those calls were translated; it is now
  gone, its five having moved to softpipe (four) and the shuffle mask (one) — and that last one
  moved again when the mask was decoded, so all five are softpipe's. Twice in a row the
  dispatched count on softpipe stayed at 6 while a column stopped being ours, and the run above is
  where that finally paid: those same kernels dispatch on the hardware. Until 20 October, 24 of these were
  refused by `air_run` itself — it bound textures and images for a draw and not for a dispatch —
  and binding them moved the count only from 5 to 6, because softpipe is the wall behind ours.
  What changed is whose wall it is: **nothing is refused by this harness any more**, and the 34
  are stopped by a software rasteriser that lacks scratch memory and some compute intrinsics,
  both of which ir3 has. They are a question for the phone now rather than a question for us,
  which they were not before. Claiming 24 unblocked would be false; they moved from one wall to
  another and the second is not ours.

  Images are read back after a dispatch, which also matters for the textures: most of these
  kernels write *only* an image, so without the readback a dispatch would have reported success
  with nothing examined — and that is the shape this check has been caught by three times
  (README, "Как врут собственные проверки"). The readback is what `air.write_texture_2d/3d` needed
  as well, which `texopcheck.py` had listed as having no case for exactly this reason.

  So the atomics being checked (above) is still a statement about two kernels written here for
  that purpose, not about the 17 of Apple's 44 that use one.

## 1. Where the frontend lives: inside Mesa, as `src/compiler/air`

**Decision: a Mesa frontend in Mesa's tree, shaped like `src/compiler/spirv`.** Its entry point
is one function, `air_to_nir()` (`nir_air.h`), the analogue of `spirv_to_nir()`. In this
repository the sources are `tools/mesa/air/`; `tools/mk-mesa.sh` and `tools/air/mk-host.sh` copy
them to `src/compiler/air/` of the pinned Mesa release, exactly as `tools/mesa/hakios-drm/` is
copied to `src/hakios-drm/`, and `tools/mesa/air.patch` adds the two lines of meson that build
it. The tree is the shape an upstream merge request would have.

Why not a standalone library that Mesa links:

- **NIR has no stable ABI.** A `nir_shader` is a graph of Mesa-internal structures that change
  every release; `nir_builder` is a header of inline functions. A library outside Mesa producing
  NIR would have to be built against one exact Mesa and versioned with it — it would be inside
  Mesa in everything but name. A library producing something *else* (a serialized NIR, or its own
  IR) would add a second translation for nothing.
- **Everything else that feeds ir3 is in Mesa too:** GLSL, SPIR-V, TGSI, CL. Living beside them
  means the same NIR passes, the same `nir_validate`, the same test framework (`nir_tests`), and
  ir3 changes that break us break in Mesa's own CI.

What it costs the eventual Metal runtime, which must compile from `newLibraryWithData:` (or, more
exactly, at pipeline creation — see 7.1) in-process: **nothing extra**. The runtime must have ir3
in its process anyway, and ir3 is only reachable as part of Mesa; the port already ships Mesa as
one dylib (`libOSMesa.8.dylib`, freedreno and ir3 inside). The frontend adds a few hundred KB of
code to that dylib and no dependency. The cost is the inverse one: the runtime's Mesa must be a
build with this frontend in it, and the runtime calls a Mesa-internal API (`air_to_nir`, then
ir3), so it is compiled against Mesa's headers and moves with Mesa's version.

## 2. How the bitcode is read: our own reader, not LLVM's

This is the biggest commitment of the project, so both sides in full.

**For linking LLVM's bitcode reader** (`llvm::parseBitcodeFile`, then walk an `llvm::Module`):

- It is finished work. It reads every bitcode version, upgrades old constructs (typed pointers,
  old intrinsics) and verifies the module. All 456 modules of the corpus are already read by
  stock `llvm-dis` 22.1.8 without a failure; day one would be spent on translation, not parsing.
- It comes with passes. If a shader ever needs SROA, inlining or `mem2reg` before translation, LLVM
  has them, and a hand-written reader means hand-written equivalents (or NIR's, after translation).
- Future AIR versions (iOS 17, 18…) come from newer Apple LLVMs; LLVM's reader follows them for
  free, ours must be extended.

**Against it, and for our own reader:**

- **The cost lands in every Metal process.** libLLVM is 50–100 MB of C++ with global constructors,
  a static option registry and its own copy of libc++ assumptions, loaded into every app that
  touches Metal. On this port that is every app: CoreAnimation, CoreImage and UIKit all link
  Metal. The port's Mesa is built with `-Dllvm=disabled` (`tools/mk-mesa.sh`) for exactly this
  reason today.
- **It would have to be cross-built for iOS** with the port's toolchain (the `xnu-clang` wrapper,
  the iOS SDK, ld64). That is a multi-hour build and a second large dependency to keep building
  — the project's experience with V8 on musl says what such a build costs to keep alive.
- **Apple already has an LLVM in the shared cache** (MTLCompiler, AGXCompilerCore — 3.6 MB). Ours
  would be a second one in the same process, of a different version. Two-level namespaces keep the
  symbols apart, but it is a hazard nobody needs.
- **The subset is small and measured.** Over all 456 modules (`llvm-bcanalyzer -dump`, then a
  histogram of records), the whole of what occurs is: 17 instruction records (BINOP, CAST, LOAD,
  STORE, GEP, CALL, RET, BR, PHI, CMP2, VSELECT, EXTRACTELT, INSERTELT, SHUFFLEVEC, EXTRACTVAL,
  INSERTVAL, ALLOCA), 6 constant records (INTEGER, FLOAT, NULL, UNDEF, AGGREGATE, DATA,
  CE_CAST), 13 type records and 8 metadata records. No switch, no invoke, no atomics as
  instructions (they are `air.*` calls), no `ptrtoint`/`inttoptr`, no `addrspacecast`, no debug
  info. The bitstream container itself is documented ("LLVM Bitcode File Format") and is a few
  hundred lines.
- **The reader has an exact oracle.** `llvm-dis` prints every module; our reader prints its own
  parse in the same `.ll` syntax for the constructs it supports, and the corpus check diffs the
  two. A reader that agrees with LLVM on 456 modules is not a guess. LLVM stays a *test* tool, not
  a runtime one.
- **Mesa already chose this once.** The DXIL backend (`src/microsoft/compiler/dxil_module.c`)
  writes LLVM 3.7 bitcode by hand rather than link LLVM. The same reasoning applies to reading.

**Decision: our own reader** (`air_bitcode.c`: the bitstream; `air_module.c`: records → an
in-memory IR of the subset). The price is accepted with open eyes: about 2–3 thousand lines of C,
and every new record kind in a future AIR version is work. Unknown records are never skipped
silently: they make the module fail with the record's name, and the corpus report counts them, so
the price is visible as a number rather than as a wrong shader.

**It is written, and it agrees with LLVM on all 456 modules of the corpus** —
`tools/air/reader-check.sh`, 1 900 lines of C for the reader and its printer. What the check
compares is described in section 4; the two things it does *not* keep are function and parameter
attributes (`nounwind`, `captures(none)`, the attribute groups) and the order of declarations,
because the translation uses neither. Everything else — types, constants, every instruction,
metadata, fast-math flags, alignments, calling conventions, linkage — comes back byte for byte.

What would reverse this: if a later AIR (a newer `.metallib` corpus) turned out to need large
parts of LLVM's auto-upgrade machinery, or if translation turned out to need LLVM's own passes
before NIR. Neither is true of iOS 16.5.

## 3. What a translation unit is

A `.metallib` is a container of **one LLVM module per function** (`docs/metal.md` 9.1). The unit
of translation is therefore **one module → one `nir_shader`**, and the stage of that shader is read
from the module's named metadata, never from the container: the container's `TYPE` tag and the
metadata are cross-checked by the corpus tool and disagreements are reported.

| module carries | NIR shader | notes |
| --- | --- | --- |
| `!air.vertex` | `MESA_SHADER_VERTEX`, one entry point | |
| `!air.fragment` | `MESA_SHADER_FRAGMENT`, one entry point | |
| `!air.kernel` | `MESA_SHADER_COMPUTE`, one entry point | threadgroup size is an API value (7.4) |
| `!air.visible` | a library shader: one exported, non-entry `nir_function` | linked at pipeline time (7.5) |

Other functions in a module (helpers, `stitching_traits` methods, `air.static_init` constructors)
become non-entry `nir_function`s and are inlined. Constructors listed in `@llvm.global_ctors`
run at the top of the entry point; that is how function-constant-derived program variables get
their values (AV1SW's `kPixelShift` is computed in one from `kBitDepth`).

**Pointers.** Metal buffers are pointers, and AIR passes them as `ptr addrspace(N)` parameters.
The translator keeps every pointer as *(where, byte offset)*: *where* is a buffer binding, the
threadgroup block, a private allocation or a constant global; the offset is an SSA value computed
from GEPs with the datalayout's sizes. This is NIR's `32bit_index_offset` model and is enough for
the whole corpus (no pointer is ever converted to an integer or between address spaces). Pointers
stored to memory — argument buffers, which no system shader here uses — will need 64-bit global
addresses instead (7.2).

### 3.1 The interface: AIR metadata → NIR

The entry-point node is `!{ptr @fn, !{outputs…}, !{inputs…}}`; each input starts with its
parameter number, each output is a field of the returned `<{…}>` struct, in order. Every entry is a
flat list of `!"air.<key>"` strings, some followed by values. This table is the specification the
translator and its tests are written against. "Seen" is the number of corpus modules carrying the
key (of 456), so the order of work follows it.

**Resources (inputs of every stage)**

| AIR | seen | NIR | binding rule |
| --- | --- | --- | --- |
| `air.buffer`, `air.address_space 2` (constant) | 393 total | `load_ubo` | UBO index = `air.location_index` |
| `air.buffer`, `air.address_space 1` (device) | (of buffers) | `load_ssbo`/`store_ssbo`/`ssbo_atomic` | SSBO index = `air.location_index` |
| `air.buffer`, `air.address_space 3` (threadgroup) | 3 | `load_shared`/`store_shared`, base from a driver uniform | sized at dispatch (7.4) |
| `air.buffer_size N` | 309 | UBO range hint (`range` of `load_ubo`) | |
| `air.read` / `air.write` / `air.read_write` | | `ACCESS_NON_WRITEABLE` etc. on the access | |
| `air.texture` + `air.sample`/`air.read` | 96 | `nir_tex_instr`, `texture_index` = `location_index` | sampled/read textures |
| `air.texture` + `air.write`/`air.read_write` | | `image_store`/`image_load`, image index = `location_index` | storage images (7.3) |
| `air.sampler` | 15 | `sampler_index` = `location_index` | |
| `!air.sampler_states` (inline `constexpr sampler`) | 10 | inline sampler, index after the API ones | **the state word is not decoded**: passed to the runtime verbatim (section 3.3) |
| `!air.function_constants` | 11 | constant folded from the values given to `air_to_nir` | `!{ptr @g, type, name, index, i1}` |
| `air.struct_type_info`, `air.arg_type_*` | | reflection only, not used for code | layout comes from the LLVM types |

**Vertex stage**

| AIR | NIR |
| --- | --- |
| `air.vertex_input` + `air.location_index n` | `shader_in`, `VERT_ATTRIB_GENERIC0 + n` |
| `air.vertex_id` | `load_vertex_id` (includes the base vertex, as Metal's does) |
| `air.instance_id` | `load_instance_id + load_base_instance` (Metal's includes the base instance, GL's does not) |
| `air.base_vertex` / `air.base_instance` | `load_first_vertex` / `load_base_instance` |
| output `air.position` | `VARYING_SLOT_POS` |
| output `air.vertex_output "name"` | `VARYING_SLOT_VAR0 + k`, `k` = position among user outputs; the name is kept on the variable |
| output `air.point_size` | `VARYING_SLOT_PSIZ` |
| output `air.clip_distance` | `VARYING_SLOT_CLIP_DIST0` (array) |
| output `air.render_target_array_index` / `air.viewport_array_index` | `VARYING_SLOT_LAYER` / `VARYING_SLOT_VIEWPORT` |

**Fragment stage**

| AIR | NIR |
| --- | --- |
| `air.position` | `load_frag_coord`; `origin_upper_left`, half-integer centres (Metal's convention, and Adreno's natively); `.w` is 1/w as in GL |
| `air.fragment_input "name"` | `shader_in`, `VARYING_SLOT_VAR0 + k` matched to the vertex output **by name** (7.5) |
| `air.center` / `air.centroid` / `air.sample` | plain / `centroid` / `sample` on the variable (`air.center` is the default and is therefore read by not being looked for) |
| `air.perspective` / `air.no_perspective` / `air.flat` | `INTERP_MODE_SMOOTH` / `NOPERSPECTIVE` / `FLAT` |
| `air.front_facing` | `load_front_face` |
| `air.sample_id`, `air.sample_mask` (input) | `load_sample_id`, `load_sample_mask_in` |
| `air.point_coord` | `load_point_coord` |
| output `air.render_target i32 n, i32 idx` | `FRAG_RESULT_DATA0 + n`, dual-source index `idx` |
| output `air.depth` + `air.depth_qualifier any/greater/less` | `FRAG_RESULT_DEPTH`, `info.fs.depth_layout` |
| output `air.sample_mask` / `air.stencil` | `FRAG_RESULT_SAMPLE_MASK` / `FRAG_RESULT_STENCIL` |
| `air.discard_fragment` | `demote` (Metal keeps the fragment alive for derivatives) — **not implemented**; no corpus module uses it, and a shader that did would fail with `intrinsic: air.discard_fragment` |

**Compute stage**

| AIR | NIR |
| --- | --- |
| `air.thread_position_in_grid` | `load_global_invocation_id` |
| `air.thread_position_in_threadgroup` | `load_local_invocation_id` |
| `air.threadgroup_position_in_grid` | `load_workgroup_id` |
| `air.threads_per_threadgroup` | `load_workgroup_size` |
| `air.threadgroups_per_grid` | `load_num_workgroups` |
| `air.threads_per_grid` | `load_num_workgroups × load_workgroup_size` |
| `air.thread_index_in_threadgroup` | `load_local_invocation_index` |
| `air.thread_index_in_simdgroup` / `air.simdgroup_index_in_threadgroup` / `air.threads_per_simdgroup` | `load_subgroup_invocation` / `load_subgroup_id` / `load_subgroup_size` |

The scalar-or-vector type of each of these (`uint`, `uint2`, `uint3`, `ushort…`) comes from the
LLVM parameter type, and the NIR value is cut or converted to it.

**Values and operations**

| AIR / LLVM | NIR |
| --- | --- |
| `i1/i8/i16/i32/i64`, `half/float/double`, vectors ≤ 4 | the same bit sizes; wider vectors are split |
| structs and arrays as SSA values (`insertvalue`, `extractvalue`) | trees of SSA values inside the translator, never NIR values |
| `br`, `phi` (unstructured CFG) | an unstructured `nir_function_impl`, then `nir_lower_goto_ifs` — the path Mesa's OpenCL frontend uses |
| `alloca` | `load_scratch`/`store_scratch` on a per-invocation block (ir3 private memory) |
| `addrspace(2)` global `constant` with initializer | `nir->constant_data` + `load_constant` |
| `addrspace(2)` global without `constant` (program-scope variables) | a private copy per invocation (written by the constructors) |
| `fast` flags on an instruction | the NIR ALU is not `exact`; without them it is |
| `air.<op>.<type suffix>` | one handler per op in `air_intrinsics.c`; the suffix is checked against the LLVM types, not trusted |

### 3.2 The vocabulary, read off Apple's own compiler

What each `air.*` name means was a guess until this was read, and one of the guesses was wrong.
`AGXCompilerCore` — the back end of Apple's own shader compiler, in **this device's** shared
cache (`sysimage/20F66__iPhone10,3_6`, never another device's) — carries its whole operation
vocabulary as a run of C strings at file offsets `0x16cf9f`–`0x16d400`, which is virtual
`0x1bbf43f9f`–`0x1bbf44400` (`__cstring` begins at file 1 482 768 for `0x1bbf41010`). 137 names,
and they are suffixes: the full function is `air.` + name + `.` + a type suffix, which is why
grepping the library for `air.fast_exp` finds nothing.

```
.add .sub .or .xor .and .min .max  global local  .s .u  .max.u.i64 .min.u.i64 .xchg.i32
.cmpxchg.weak.i32 .store.i32 .load.i32  global.{add,sub,xchg,cmpxchg.weak,store,load}.f32
acos asin atan atan2 acosh asinh atanh pow powr cosh sinh tanh exp10 log10 cos sin tan sincos
rint round fmod ceil exp exp2 fabs floor fma fmax fmin fract ldexp log log2 mad rsqrt sqrt trunc
fast_{acos asin atan atan2 exp10 log10 acosh asinh atanh pow powr cosh sinh tanh cos sin tan
      sincos round fmod mod exp exp2 ldexp log log2 rsqrt sqrt ceil fabs floor fract rint trunc
      fmax fmin clamp saturate}
gamma_expand gamma_compress gamma_expand_xr gamma_compress_xr  convert pack unpack
abs abs_diff add_sat sub_sat hadd rhadd clamp clz ctz mad_hi mad_sat mul_hi rotate popcount
extract_bits insert_bits reverse_bits  any all any_msb all_msb  saturate mix sign dot
dfdx dfdy fwidth  atomic assert  get_simd_width get_thread_execution_width
```

**This settles the two operations whose meaning was a guess, and corrects one of them.** The list
distinguishes exactly the functions the Metal Shading Language Specification defines, one name per
function:

| the question | what the list says | what we had |
| --- | --- | --- |
| is `air.fast_exp` the natural `exp` or `exp2`? | `exp` and `exp2` are separate names, and so are `fast_exp` and `fast_exp2` | right: natural `exp` |
| does `air.fast_round` take a half away from zero (`round`) or to even (`rint`)? | `round` and `rint` are separate, **and so are `fast_round` and `fast_rint`** | **wrong**: it was `nir_fround_even`, which is `rint` |

`air.fast_round` is now `trunc(x)`, stepped one away from zero when `|x - trunc(x)| >= 0.5`.
Not `trunc(x + copysign(0.5, x))`, which is the obvious formula and is wrong: for an `x` just
below a half that addition itself rounds up and the answer comes out 1 where it should be 0.
The subtraction is exact for every float, so the version used needs no magnitude guard and keeps
the sign of a negative zero; it was checked bit-exact against C's `roundf` over the halves, the
sub-halves, both zeros and 2^24.

Reading the list also closed gaps that had not been noticed: `exp10`, `log10`, `powr`, `fmod`,
`mod`, `mad`, `abs`, `abs_diff`, `add_sat`, `sub_sat`, `mul_hi`, `popcount`, `clz`, `ctz`,
`rotate`, `reverse_bits`, `extract_bits`, `insert_bits`, `dfdx`, `dfdy`, `fwidth`,
`get_simd_width` and `rint` itself are all implemented now. None of them occurs in the 456-module
corpus, so none is tested by anything here; they are in because the list says they exist and
guessing at them later would be the same mistake again.

Still unimplemented, and now known by name rather than by surprise: the inverse and hyperbolic
trigonometry (`acos`, `asin`, `atan`, `acosh`, `asinh`, `atanh`, `cosh`, `sinh`, `tanh`),
`sincos` (two results from one call), `hadd`, `rhadd`, `mad_hi`, `mad_sat`, `any_msb`/`all_msb`,
the `gamma_*` conversions, `pack`/`unpack`, and `assert`.

### 3.3 The sampler state word, which is not decoded

Metal's `constexpr sampler` — a sampler the shader declares itself rather than one the API binds —
arrives as a global holding one 64-bit word. **That word's layout is not worked out.** The
frontend passes it to the runtime verbatim (`air_resource::sampler_state`), assigns the sampler an
index after the API's, and says so rather than guessing: a wrong filter or wrap mode renders
plausibly and wrongly, which is the failure that costs a week later instead of an hour now.

What is known is only the shape. Three distinct words occur in the corpus, quoted here so that
the inference below can be checked and extended rather than taken on trust — that is the whole
reason for writing a guess down as a guess:

```
0x807bff0000088049    0x807bff0000088a00    0x807bff0000088a49
```

They share everything above the low twelve bits, and the differences are `0x049`, `0xa00` and
their union `0xa49` — which looks like three three-bit fields at bits 0, 3 and 6 (the s, t and r
address modes) and two bits at 9 and 11 (the two filters). That is a guess from three samples and
it is **not** used by anything.

Unlike the operation vocabulary, Apple's compiler does not hand this over: `AGXCompilerCore`'s
`sampler_words` is an identifier in a hand-written-assembly test harness, not the state format.
So it needs a different kind of evidence — the driver that programs the hardware from it
(`AGXMetalA11`) is where to look next.

**How much it blocks: two modules.** Of the texture shaders in the corpus, 29 take no sampler at
all (they fetch by integer coordinate), 9 take one as an API argument, and 2 declare their own. So
this is a narrow gap and not a blocked family — but it is the reason no result here says anything
about Apple's filtering.

### 3.4 A question for daylight: what of Apple's may this repository contain?

Raised on 20 October and deliberately not settled at three in the morning. The working line is
**explanation, not input**: a short excerpt quoted beside an analysis so a reader can check it is
technical writing, while corpus bytes committed as an *input* — a fixture a test opens, a trimmed
`.metallib`, a dump something parses — is redistribution for use. The repository should never be a
place to get Apple's shaders; it may be a place that explains them.

By that line, two things in these documents are excerpts and are kept: the three sampler words
above, and the six-line listing of `clearFragment01` in `docs/metal.md` section 9.5. Neither
substitutes for the thing it came from, and both carry the analysis they exist to support. Nothing
committed anywhere is corpus bytes as an input: `docs/air-report.md` holds module names, counts and
error strings, which are facts about Apple's shaders and not Apple's shaders, and no test here has
a fixture — `tools/air/check.sh` reads `sysimage/rootfs`, which is not in the repository and cannot
be.

The part needing a decision rather than a convention: whether that line is the right one, and what
it says about the twenty-odd screenshots in `docs/` of the running port, which are Apple's rendered
artwork and a different class again. That belongs to whoever owns the repository, awake.

## 4. How it is proven right

A shader is reported as *working* only when its output was compared, never because it compiled.
Three references, each independent of the translator:

1. **LLVM on the CPU (the strongest).** `tools/air/cpuref.py` changes the module's triple to the
   host's, compiles it with `llc`, fills a buffer per `air.buffer` argument with a fixed pattern
   and calls the entry point; `air2nir --eval` replaces the same buffer loads in *our* NIR with
   the same bytes and folds it with `nir_opt_constant_folding` (no algebraic rewriting, so the
   arithmetic stays IEEE and comparable); the two sets of numbers are compared. LLVM — not our
   reader, not our translator — decides what the shader means, and neither side can see the
   other's answer. Needs no Apple hardware and no GPU.

   **255 shaders agree, bit for bit, and none differ.** The call into the shader is made from a
   wrapper written in LLVM IR rather than from C, because a shader returns a struct of vectors by
   value and how `llc` lowers that is its own business: a C declaration of the same struct agrees
   for a single vector and stops agreeing past it (this cost an afternoon's false "243 differ").
   With the wrapper, only `void(const void *, void *)` crosses into C and the question does not
   arise.

   **And what those 255 do not cover: not one `air.*` function.** Every one of them is plain
   LLVM IR, so the agreement is a strong statement about the reader, the interface mapping
   (buffers to the right UBO index, result fields to the right render targets in the right order)
   and the instruction translation — and no statement at all about `air_intrinsics.c`. The
   shaders that do call `air.*` are exactly the ones this check cannot judge: the texture ones
   have a varying for a parameter, the math-heavy ones are compute kernels or `air.visible`
   library functions. So this check says nothing about `air_intrinsics.c`; item 4 below is what
   does, and the paragraph that used to stand here — that nothing but M4's buffer readback could —
   was wrong about the reference being necessarily circular. The objection it raised is answered
   there rather than dropped, because it is the right objection.

   The first oracle for the intrinsics that needs no hardware is section 3.2: **Apple's own
   compiler, which knows what each name means because it compiles it.** Its vocabulary settled
   the two guesses and found one of them wrong. What that oracle gives is each operation's
   *identity*, not its numerical result, so it decides `round` against `rint` and `exp` against
   `exp2` and cannot decide how many ULP Apple's `fast_sin` is allowed to be out by. The second
   is item 4, which takes that identity and checks the arithmetic against C's own function; what
   neither can do is tell you what the Adreno computes.

   What it cannot decide, and says so rather than passing: a shader with a non-buffer argument —
   a varying, `air.position`, a thread id — because what is in it is the GPU's business (19 in
   AppleMetalGLRenderer, all of them the texture ones), and a compute kernel, which returns
   nothing and writes through pointers (47 of them). Reading the buffers back after the call
   would settle the kernels and is M4's acceptance test; it is not written.
2. **The same shader drawn by a Gallium driver, and the pixel read back.** `air_run.c` puts the
   translated NIR into a `pipe_shader_state` as `PIPE_SHADER_IR_NIR`, draws one quad into a
   32-bit render target and prints the pixel. Both drivers of interest take NIR directly: ir3 is
   a NIR compiler, and softpipe takes it through `nir_to_tgsi`.

   **255 shaders draw and the pixel matches LLVM, bit for bit, with no GPU** — `cpuref.py --all
   --draw` compares all three (LLVM's execution, the folded NIR, the drawn pixel). That is M1's
   acceptance test, run 255 times, with softpipe standing in for the Adreno.

   Three things this caught that compiling never would, each of which looks like a translation
   bug and is not one: an integer-returning shader read back through a float target (the bits are
   right, read the wrong way); a shader whose outputs outnumber the framebuffer's attachments,
   which draws nothing at all; and `clearFragment04`, which writes `FRAG_RESULT_DATA1` alone, so
   target 0 holds the clear colour. The harness now takes its format from the shader's output
   type, binds an attachment per render target, and reads back the lowest target the shader
   actually writes.
3. **NIR's own checks:** `nir_validate` after every pass (the translator runs with validation
   on), and unit tests on Mesa's `nir_tests` framework for the translator's building blocks.
4. **Each `air.*` operation on its own, against C's own functions.** `tools/air/intrincheck.py`
   takes the declarations the corpus actually uses — `air2nir --ll` over the 456 modules gives
   119 of them — and for each one generates a fragment shader that calls it on constant
   arguments and returns the result, assembles that with `llvm-as`, and folds it with `air2nir
   --eval`. The reference is the C library's own `roundf`, `floorf`, `fmaxf`, `ldexpf` and the
   IEEE definitions, evaluated at the operation's own precision.

   **71 exactly defined operations agree on every one of 45 697 cases; none differ.** Seven are
   approximate (`fast_sin`, `fast_cos`, `fast_exp`, `fast_pow`, `fast_atan2`) and are reported
   with their worst distance from libm and counted as nothing — see below.

   **Why this is not the circular reference rejected under item 1,** which it looks like at first
   and which is the objection that kept it unwritten for a week. Writing C implementations of the
   `air.*` *operations* would be circular: they would encode the same belief as the lowering, by
   the same author, and agree by construction. What this does instead is split the claim in two,
   and each half has an oracle that is not this tree:

   - *which function each name is* — settled by Apple's own compiler, section 3.2. That is where
     `air.fast_round` was found to be `round` and not `rint`.
   - *whether the lowering computes that function* — settled by the C library, which implements
     `round` because the C standard says what `round` is, and has never heard of this port.

   Neither half alone is enough and together they are not circular. What makes it work is that
   Metal's math functions are OpenCL's, which are C's: there is a specification outside both
   Apple and Mesa for almost every one of them.

   **What it does not reach.** For the seven approximate operations NIR's folder calls the same
   libm this script does, so `0 ulp` there carries no information beyond section 3.2 — it says
   the lowering picked `sinf` and not that the Adreno's `sin` instruction agrees with `sinf`,
   which it certainly does not to the last bit. Metal's `fast_` prefix permits that. And for all
   71 of the exact ones, what is folded is NIR's constant expression for each opcode on this
   machine: an opcode whose Adreno instruction differs from what `nir_opt_constant_folding`
   computes is invisible here. That gap closes only on the phone.

   **What it found.** Two things, in opposite directions:

   - `air.fast_atan2` was wrong at the origin. Mesa's `nir_atan2` returns 3π/4 for `atan2(0, 0)`,
     and its own comment says why: GLSL licenses an implementation to deviate from IEEE there, so
     it pretends 0/0 = 1. Metal's `atan2` is OpenCL's and keeps the IEEE values — `atan2(±0, x>0)`
     is `±0`, `atan2(±0, x<0)` is `±π`. A shader taking the angle of a vector that happens to be
     zero got 135° instead of 0°, which is not the kind of deviation `fast_` permits.
     `air_intrinsics.c` now handles the origin itself and leaves the rest to Mesa. Mesa's
     deviation is confined to the origin: the four `(±0, ±0)` cases, and no other.
   - NIR's `ldexp` loses an overflow, and that one is Mesa's. Its constant expression is
     `dst = ldexpf(src0, src1); /* flush denormals to zero. */ if (!isnormal(dst)) dst =
     copysignf(0.0f, src0);` — and `!isnormal` is true of an infinity as well as of a denormal, so
     `ldexp(0.5, 32767)` folds to `0` where Metal, OpenCL and C all say `+inf`. The comment names
     denormals; the condition catches more than it means to. Present in Mesa 26.2.5, the newest
     release at the time of writing, byte for byte — checked by extracting that one file from
     `archive.mesa3d.org`, which is a plain file server, because freedesktop's GitLab is behind
     bot protection and the GitHub mirror paths 404. The merge request that looks like its origin
     is freedesktop 3982, "nir: Flush to zero with OOB low exponents in ldexp", whose title says
     both what it was for and what it missed: out-of-bounds *low* exponents, the high end never
     considered. The MR itself could not be read, so treat the origin as likely and the state of
     the current release as established. A one-line fix would be `isfinite(dst) && !isnormal(dst)`.
     Worth reporting upstream by someone who can open the page; it is a bug for every Mesa
     frontend whose language keeps IEEE overflow, which is OpenCL and Metal at least. Not worked
     around here, because the frontend's `nir_ldexp` is the right opcode.

   **The check can fail,** which is the first thing to establish about any check in this
   repository, after four that passed for the wrong reason. Reinstating the `fast_round` bug —
   `nir_fround_even` in place of the trunc-and-step — is caught at `0.5`, `-0.5`, `±2.5` and in
   each component of the vector form separately; dropping the last component of `air.dot` is
   caught on 83 of 100 cases. Every component of a vector result is compared, and every component
   of a vector argument is given a *different* value, because with the same value in all of them a
   lowering that swizzled or dropped a component returns the right answer for the wrong reason.

   **Folded is not run, and the difference is not a matter of degree.** `--eval` asks NIR's
   constant folder; `intrincheck.py --run` builds the same operations into shaders that *load
   their arguments from a buffer* and hands them to `air_run`, which draws with them through a
   real driver's compilation and execution. The buffer is the whole point: ir3 folds too, so a
   shader calling `air.fast_round(0.5)` on an immediate is answered by the compiler and the
   hardware never sees the instruction — a GPU test built that way passes with the GPU switched
   off. A value loaded from a buffer cannot be folded, and `air_run` puts bytes the harness chose
   there (`AIR_RUN_BUFFER`, added for this).

   **47 of the 78 declarations agree on every one of 2 586 cases, run by softpipe rather than
   folded; none differ.** Seven more are the approximate ones. The remaining 24 touch a type
   narrower than 32 bits (`i1`, `i8`, `i16`, `f16`) and TGSI's registers are 32-bit, so softpipe
   cannot answer for them: `nir_to_tgsi` asserts for the integers, which is loud and fine, and
   for a half it computes at 32 bits instead — it answered `32767` where a half rounds to
   `32768`, which is a verdict about softpipe and not about this frontend. `--check` reads the
   screen out of `air_run`'s own first line and sets those aside by name. ir3 has real 16-bit
   registers, so they are a question for the phone and are open.

   Running them found two things the folding check could not, and could never have:

   - **`air.sign(-0)` gave `+0`.** Metal's `sign` is OpenCL's, where `sign(-0)` is `-0` and
     `sign(NaN)` is `+0`. `nir_fsign` does not promise either; its own documentation says that
     for a zero source "there is a preference for the result to have the same sign, but this is
     not required (it is required by OpenCL)". So a backend is licensed to lose it, NIR's
     *constant folder* happens not to, and softpipe does — which is exactly why folding the
     shader could not show it. Same shape as the atan2 bug: an opcode whose contract is weaker
     than Metal's requirement. `air_intrinsics.c` now builds `sign` from comparisons, which
     promise what Metal needs, rather than asking for a preference.
   - **The 16-bit gap above, which is softpipe's and not ours** — but it took a wrong answer
     (`32767` for a half that rounds to `32768`) to notice, not an assertion, and a check that
     had trusted the number would have recorded a frontend bug that does not exist.

   **It has now run on the phone, and two operations of it are answered there.** `--emit DIR`
   writes the modules, the bytes for their input buffer, a `manifest.json` of what each should
   return, a `run.sh` for this machine and an `rc.jobs` for the device. `--check DIR LOG` then
   judges the log wherever it was produced, so the arithmetic reference never leaves the host and
   the device needs nothing but `air_run`. `manifest.json` is deliberately not carried: nothing on
   the device reads it, and leaving it behind keeps the stronger claim literally true — the device
   cannot be made to agree by reading the answer.

   **The reason this took a night longer than it needed to was a sentence in this document, and
   it was wrong.** It said that "getting that directory into the boot image is the flash-root
   machinery of subsystem (2), which this work is not supposed to touch". It is not. `/redwood/share`
   already existed and already carried a data file that a test reads (`pattern.bin`, which `init`
   verifies through `read()` and `mmap()`), and `EXTRA` already carried arbitrary host files into
   `/redwood/bin`. `EXTRA_SHARE` is ten lines of `build.sh`. A boundary the brief drew for good
   reasons had been reached for as the reason not to look into something, and the check that would
   have cost a minute — reading what `/redwood/share` is for — was never made. A constraint is not
   evidence about a thing it does not cover.

   **What the first run on the phone actually found was in the harness, not the GPU**
   (`logs/074504-run.log`, 20 October 07:45). The flash root mounted, the Adreno came up, and
   `air_run` opened it: `clearFragment01` and then two generated modules each printed
   `on Adreno 7c+ Gen 3 (the GPU, through the kernel's msm device)`. `air.fast_sqrt.f32` returned
   `1.44972523e-09  2.15926367e+15` and `air.dot.v4f32` returned `-inf -inf` — bit for bit what
   the host returns for the same module over the same pattern buffer, which is the comparison
   those two were put in the job list to make: a job line cannot set `AIR_RUN_BUFFER`, so they
   read `air_run`'s own pattern bytes, which the host can read too, and their numbers are
   therefore comparable without the manifest and without a shell.

   The other 98 of the 100 modules carried did not run, because the job list ended with
   `/bin/sh /redwood/share/airops/run.sh` and the answer was
   **`/bin/sh: No such file or directory`, status 127. iOS 16.5's own root has no shell at all**
   — `/bin` holds `df` and `ps`, and nothing else. The `/var/jb/bin/sh` that `rc.jobs.jb` and
   `rc.jobs.sileo` run belongs to the package manager's prefix, which only a `JB=1` image carries.
   This was asserted, not checked: a `grep` for `bin/sh` matched six `rc.jobs*` files and the
   matches were read as `/bin/sh` without opening a line of any of them — the same shape of
   mistake as the claim about `air_run`'s texture format a day earlier, a conclusion drawn from a
   pattern match instead of from the code. It is now written beside `RC_JOBS` in `build.sh`,
   because anyone writing a job list with a shell in it will meet the same 127.

   So the shell was removed rather than replaced. `air_run` grew `--buffer FILE` — `AIR_RUN_BUFFER`
   as an argument, which is the one thing `init`'s `run_command` can express — and `--emit` now
   writes an `rc.jobs` with one line per module. On the phone 27 modules ran in 0.6 s, about 22 ms
   each including opening the GPU, so 225 separate processes cost about five seconds and a loop
   inside one process would buy nothing worth the refactor. (An earlier estimate of 50–150 ms per
   module, taken from the spacing of nearby `launchd` lines, was wrong by a factor of five; the
   figure above is from the run that executed them.)

   **Two more things had to be found before the suite would report anything, and neither was in the
   GPU.** The first was in `init` and is written up where it belongs (`userland/src/init.c`,
   `read_whole`): three configuration files were each read with one `read()` into a fixed buffer
   with no check, so a file longer than its buffer silently lost its tail. The job list is 21 KB
   against a 8 KB buffer, so 94 of its 244 lines were read and about 150 modules did not run —
   which reads exactly like a test that found nothing. Caught before a run rather than after,
   by counting how many lines fit before claiming that 225 modules had passed.

   The second is a property of the loader's log and will catch anything verbose:
   **the log keeps the first 256 KB and the last 1 MB and drops the middle**, saying so in one
   line. With `XL_SECS=120` and `REST=1`, iOS wrote more than a megabyte of `os_log` after the
   suite had finished, so the suite's own output was in the dropped middle — 27 modules survived,
   at the front. `XL_FOLLOW`'s intermediate log does not help, because the drop has already
   happened by the time it is fetched, and a filter removes lines that are already gone. Two levers
   keep a run under the cap and neither is sufficient alone — `QUIET=1`, which drops `launchd`'s own
   thousands of lines, and a short `XL_SECS` — because the volume comes from the number of services
   and from the length of the session both. What is actually diagnostic is the size of the file:
   1 466 58x bytes *is* the cap, so a log that size is truncated however many drop markers it
   carries (the intact run here has two and lost nothing; a truncated one had one). `README.md`
   carries this beside `./xl log`, with the three runs tabulated, because it catches anything
   verbose and not just this suite.

   **How much room is left is worth knowing before the suite grows.** In the run that worked, at
   `XL_SECS=30`, `air_run`'s own output was 93 459 bytes for 225 modules — 415 bytes each — and the
   other 1 092 137 bytes, 92% of the log, was iOS booting *with* `QUIET=1` already on. So the
   headroom is about 280 KB, or roughly 650 more modules if they cost nothing in time, and fewer
   because each one adds 22 ms of further boot noise. `--cases 8` should still fit; past that it
   will not, and the answer then is not a bigger cap but to stop booting iOS for a measurement at
   all: `init` runs programs itself, before `launchd`, where the log is nearly empty and nothing
   can push the output out of it (`RC=<file>`, as `rc.ios` does it). The GPU is up by then, since
   the kernel brings it up, and a question about what the hardware does to a number does not need
   a window server. That is the shape this suite should take if it ever outgrows `--cases 4`; it
   has not yet, and the 225 modules above all arrived.

5. **The atomics, with a kernel written to make a lost update show.** This document used to say
   that none of Apple's kernels could test an atomic and why: "a sum written by threads that never
   raced looks exactly like a sum written by threads that did. Detecting a lost update needs the
   expected total to depend on every thread having contributed — which needs a kernel whose
   arithmetic is known, i.e. one written for the purpose rather than one of Apple's."
   `tools/air/atomiccheck.py` is that kernel, generated as AIR, assembled with `llvm-as` and
   dispatched by `air_run` over its 4×4 threads, with both device buffers' initial bytes chosen
   rather than left to the harness's pattern.

   Four of its five checks are ordinary: the counter reaches the thread count, the atomic load
   returns what was put there, the signed maximum is the largest thread index, and the signed
   minimum of `index - 100` is `-100` — that last one is where an unsigned minimum would answer
   `0xffffff9c` as a huge number, and where it did when the lowering was broken on purpose to see
   whether this check works.

   The fifth is the one that can see a race, and it needs no knowledge of the order the threads
   ran in. Each thread writes the value its own `fetch_add` returned, so if the increment is
   atomic those sixteen returned values are the numbers 0 to 15 in *some* order. A lost update
   leaves a duplicate and a gap, and the gap names the increment that went missing. Each is
   written as `old * 16 + index + 1`, so a slot no thread wrote cannot look like a result and a
   thread writing another thread's slot does not read as correct either.

   A second kernel does the threadgroup atomics and the barrier, which the first cannot reach —
   they go through `nir_shared_atomic` and a different path for the memory. Threadgroup memory is
   not zeroed at dispatch, and neither Metal nor Mesa promises it is, so the kernel initialises
   it: every thread storing 0 to the same two words does that without needing a branch. Then each
   thread adds 1 to one word and `1 << its own index` to the other, and after the second barrier
   reads both back into its own slot of two device buffers. Every slot must hold 16 and `0xffff`,
   and the two ways it can fail are told apart by *which* slot is wrong: a lost add clears a bit
   in every slot and the bit names the thread whose increment went missing, while a barrier that
   did not wait leaves a smaller number in the slot of the thread that ran ahead.

   **All eight operations agree.** The barrier is genuinely under test, which was a surprise worth
   recording: softpipe does not advance its invocations one at a time but in groups of four, so
   with `barrier_op` made a no-op every thread sees 4 of 16 increments and the check says so,
   naming the twelve threads whose bits are missing.

   **Atomicity is still not under test.** Softpipe applies a group's atomic lane by lane, so it
   cannot lose an update however the lowering is written, and the permutation comes out correct by
   construction. The check passes there by being right rather than by being unopposed. What would
   make it evidence is the same two kernels on the Adreno, where sixteen threads really do race,
   and that has not happened. It is also only the eight operations the corpus proves exist, read
   off its own declarations; `air_intrinsics.c` also handles `and`, `or`, `xor` and `xchg`, and
   those stay untested because the names Apple would emit for them are a guess, and a test of a
   guessed name is a test of the guess.

6. **The texture operations, on more than one texel.** `tools/air/texcheck.sh` runs the corpus's
   own texture shaders and 6 of its 55 return the exact texel on the Adreno; 49 cannot be run,
   most of them because they are `air.visible` library functions and not entry points. Two things
   that leaves undone, and the second is the serious one:

   - whole operations have no coverage from it at all — the texel fetch, the size queries;
   - **every one of those six samples the same texel**, `(1, 1)`, because that is where
     `air_run`'s vertex shader puts the coordinate. A lowering that ignored the coordinate
     entirely and always fetched `(1, 1)` would pass all six of them.

   `tools/air/texopcheck.py` generates a fragment shader per operation *and coordinate*, asking
   for the corners as well as the middle. **All 35 calls return exactly what was put there**,
   covering 13 of the 31 texture declarations: `read_texture_2d` with 32- and with 16-bit
   coordinates, the two size queries, `sample_texture_2d` and `sample_texture_3d`, each of those
   for float, signed-integer and unsigned-integer textures, and `gather_texture_2d`. The
   coordinates are immediates here, unlike the arithmetic: a texture fetch is not constant-folded
   by NIR or by ir3, so there is nothing for the compiler to answer in the shader's place and no
   buffer is needed to defeat it.

   The integer-typed textures work because `air_run` already picks the texture's format from what
   the shader samples into, with its own comment saying why — "a Metal `texture2d<uint>` read out
   of a float texture gives numbers that are neither right nor obviously wrong". An earlier
   version of this section said those declarations could not be checked for exactly that reason,
   which was written from the probe's output without reading the code beside it. They can, and
   the render target's type has to follow as well or the bits come back read the wrong way.

   A gather returns one channel of the four texels around the coordinate, and Metal fixes the
   order they come back in. They came back in GL's order, `(i0j1, i1j1, i1j0, i0j0)`, but that
   Metal's convention is the same is not established here — so the four values are compared as a
   multiset. That checks the footprint and the channel selection without committing to an order,
   and since every channel gives a different multiset a wrong channel still shows. The coordinate
   is `1.75/4`, which is `1.25` in texel space, so the footprint is `{1,2}×{1,2}` with nothing
   ambiguous about the rounding.

   Made to fail: swapping the first two coordinate components is caught on all five asymmetric
   coordinates and correctly *not* on the three symmetric ones, which is the difference between
   this and `texcheck.sh` stated as a measurement rather than an argument.

   **What it does not check**, and these are the texture half's real remaining gaps:

   - Metal's own sampler state. The sampler is the API's — nearest, clamped — and every
     coordinate is a texel centre, where nearest filtering has no weights to round and clamping
     has no arithmetic. The 64-bit `constexpr sampler` word remains undecoded (section 3.3).
   - The seven declarations whose result or coordinate is 16-bit. They have cases and softpipe
     refuses them: TGSI's registers are 32-bit, so `nir_to_tgsi` asserts rather than answering
     wrongly, which is the better of its two failure modes. ir3 has real 16-bit registers, so
     these are a question for the phone.
   - `write_texture_2d` and `write_texture_3d` (4 declarations), which need the texture read back
     after the draw, and the multisample reads (5), which need a multisample texture. Neither is
     bound by `air_run`.
   - The depth sample and the multisample depth read (2): nothing binds a depth texture, and a
     shader reading an attachment nothing stored to is one of the four tests this port has
     already had pass for the wrong reason.

Where a shader has a known GLSL equivalent (AppleMetalGLRenderer's shaders *are* the GL
pipeline's fixed functions), rendering both through the port's GLES and comparing images is a
fourth check; it is not built yet.

The bitcode reader has its own oracle (section 2): its parse is printed as `.ll` and diffed
against `llvm-dis` for every module of the corpus.

## 4a. What it does and does not keep

Written down because a reader that silently drops something is worse than one that refuses:

- **Not kept, and not needed:** attributes (`nounwind`, `memory(none)`, `captures(none)`,
  `dereferenceable`, the `#N` groups), the identification block, debug info, the symbol table's
  order, use lists, operand bundles. None of them carries meaning the translation reads.
- **Kept but unused so far:** `air.struct_type_info` and the `air.arg_type_*` keys (reflection:
  the runtime will want them for `MTLArgument`), TBAA, the module's hash.
- **Refused rather than guessed:** every record kind not in the subset, a pointer stored to memory
  or cast to an integer, a `switch`, a call through a pointer, a struct field chosen at run time,
  a vector `getelementptr`. Each refusal names what it was and lands in the report's table.

Two things the translation leaves to its consumer, by Mesa's convention rather than by choice:
**system values** (`load_global_invocation_id` and the rest are emitted as NIR's own, and the
driver lowers them with `nir_lower_system_values` / `nir_lower_compute_system_values`, exactly as
the SPIR-V frontend does) and **I/O lowering** (variables with locations, then `nir_lower_io`).

## 5. Milestones and how each is measured

The corpus report (`tools/air/corpus.py report`) is the progress meter: every number below comes
out of it, and it runs from `tools/air/check.sh` (section 6). Two corpora:

- **the device image** — the five `.metallib` files the port installs (`sysimage/rootfs` +
  `sysimage/cryptex`): 456 modules. This is the corpus the milestones are stated against.
- **the full IPSW** — all 134 MTLB libraries of the iOS 16.5 root filesystem and cryptexes,
  16 841 functions, extracted from `rootfs.dmg` with 7-Zip. Reported alongside, because the
  device image is a selection and the system's own shaders are this set.

Each module goes through stages, and the report counts how many reach each: *container* (the
module is found and unwrapped) → *llvm-dis* (stock LLVM reads it) → *reader* (ours reads it and
agrees with `llvm-dis`) → *translate* (`air_to_nir` succeeds and `nir_validate` passes) → *ir3*
(compiles for Adreno 7c+ Gen 3, chip 0x06030500, without error) → *softpipe* (output matches the
CPU reference) → *adreno* (output on the phone matches the CPU reference). A module that stops is
counted under the first stage it fails and the reason (an unknown record, an unhandled `air.*`,
an unhandled metadata key), so "features not yet handled" is a ranked list, not a guess.

- **M0** — container and corpus: every module reaches *llvm-dis*; the report exists.
  **Done**, and further than stated: all 456 also pass *reader*, our own reader agreeing with
  `llvm-dis` on every one.
- **M1** — `clearFragment01` reaches *adreno*: translated, compiled by ir3, rendered on the
  Adreno, framebuffer equal to the colour in its constant buffer. **Done** (20 October, section
  5a).
  **Done except for the Adreno itself.** It is `nir_load_ubo` + a store to `FRAG_RESULT_DATA0`
  as predicted, and ir3 turns it into five Adreno instructions (four `mov`s out of the constant
  file, where ir3 promoted the UBO load). Over a buffer of known bytes, LLVM's own execution of
  the module, our folded NIR, and **the pixel drawn by a Gallium driver and read back** all give
  the same four floats, bit for bit. What has not happened is the draw going through *ir3 on the
  phone's GPU*: the screen here is softpipe. Section 5a says what is left for that, and it is
  not much.
- **M2** — the 283 modules with no `air.*` call: a stated fraction reach *ir3*, a growing subset
  *softpipe*/*adreno*.
  **262 of the 283 reach ir3**, 255 of them agree with LLVM numerically, and those same 255 draw
  a matching pixel. (With textures done the whole corpus reached 313 of 456, and 315 once calls
  to a function of the module were translated; this milestone's own count is the intrinsic-free
  subset.) The other 21 are
  `air.visible` library functions, which are not entry points at all (below). Counting every
  entry point rather than every module: 275 of 321, 86%. Nothing has run on the Adreno.
- **M3** — textures and samplers, each form with a test that renders a known image.
  **Translated, compiled, and six of them rendered on the Adreno and checked.** The family took the corpus from 275 modules to
  313, and all 313 compile for the Adreno. What is *not* done is M3's acceptance test: not one
  texture operation had been run until `air_run` learned to bind one. The forms written are 2D, 3D, 1D,
  cube and their array and multisample variants, for sampling (plain, explicit level, bias,
  minimum-level clamp), gathering, fetching by integer coordinate, writing, and the queries
  (width, height, depth, array size, level count, sample count). Refused with a named error, not
  guessed at: compare sampling (`sample_compare`, `gather_compare`), texture buffers, and a depth
  texture whose aspect selector is not 1.

  **Six texture shaders have now been run and return the exact texel**
  (`tools/air/texcheck.sh`). `air_run` binds a texture whose texel is
  `(100+x, 200+y, 300+x+y+z, 400)` — 4×4 for a 2D sampler, 4×4×4 for a 3D one — a nearest
  sampler with clamped addressing, and a coordinate at the centre of texel (1, 1). A single
  sample or fetch must then return that texel *exactly*: nearest filtering at a texel centre has
  no weights to round and clamping has no arithmetic. 2D and 3D, in float, int and uint, all six
  return it; **none returns anything else**.

  Binding the matching target mattered more than it looks: with a 2D texture bound for a 3D
  sampler the three 3D shaders also "passed", by accident. With a real 4×4×4 texture they return
  `101 201 303 400` — the 3D texel — and only then are they evidence.

  **And all six draw on the Adreno and return the same exact texels** (20 October,
  `logs/003327-run.log`, `RC_JOBS=rc.jobs.airtex`): three `101 201 302 400` for the 2D samplers
  and three `101 201 303 400` for the 3D ones, each under its own
  `air_run: … on Adreno 7c+ Gen 3 (the GPU, through the kernel's msm device)`. No crash, no
  fallback, both flash-root mount lines present, nothing said about missing firmware.

  That run was worth more than its five minutes, and a peer session had to argue for it: softpipe's
  agreement proves least exactly here. Softpipe takes a `pipe_sampler_view` and samples it in C,
  while a6xx wants real descriptors in memory, a sampler state block and the right binding slots
  for the texture instructions ir3 emits — so six exact texels on softpipe said nothing about any
  of it, and the whole texture path could have been one the phone never takes. It was also the
  most diagnostic moment this test will ever have: nearest filtering at a texel centre has no
  weights to round and clamped addressing has no arithmetic, so a mismatch could only have been
  binding or descriptors. That narrowness disappears as soon as real filtering is tested.

  Of 55 texture shaders, 49 are not run, and the reasons are the honest part: 24 are compute
  kernels (`air_run` dispatches those as of 20 October, but softpipe's `nir_to_tgsi` stops most of
  them — see the kernel table above); 11 are `air.visible` library functions; 4
  sample a multisample texture the harness does not bind; 1 writes only depth; 1 hits an
  assertion in softpipe's own NIR-to-TGSI; 8 are other translation refusals. **Not one returns a
  wrong number** — the failures are all a refusal to run, which is the shape of failure to want.

  `texturedFragment3DDepth` is worth naming because it cost a wrong-looking result: it returns
  `{undef, depth}` and stores *nothing* to its colour attachment, so reading the colour gave the
  clear value — a number that means nothing and looks like an answer. `air_run` now checks that
  the attachment it reads is one the shader actually stores to, and refuses when it is not.

  The sampler state is the gap that matters for correctness, and it has a section of its own
  (3.3). In short: Metal's `constexpr sampler` arrives
  as a global holding one 64-bit word, and **that word's layout is not decoded**: the frontend
  reports it to the runtime verbatim (`air_resource::sampler_state`) and assigns the sampler an
  index after the API's. Until it is decoded, nothing knows whether a sample is meant to be
  nearest or linear, clamped or repeated — which is exactly the sort of thing that renders
  plausibly and wrongly. `AGXCompilerCore` has a `sampler_words` symbol, so the layout is
  discoverable the same way the vocabulary was.
- **M4** — atomics, barriers, threadgroup memory, compute against the CPU reference.
  Atomics, the barrier and threadgroup memory are written (`air_intrinsics.c`) and 16 kernels
  compile through ir3 with them; none has been *run*, so M4's acceptance test is untouched.

### `air.visible`, and why 135 modules are none of these milestones

135 of the 456 modules — every one in `portrait_filters.metallib` — carry `!air.visible`
instead of a stage. They are CoreImage's stitchable kernels: library functions, with
`air.visible_input`/`air.visible_output` interfaces and `air.stitching_info` describing how
CoreImage assembles them into a shader at run time. They have no entry point, so there is no
`nir_shader` to make of one by itself; each becomes a `nir_function` linked into its caller at
pipeline time (`nir_link_shader_functions`). The translator refuses them with
`stage: air.visible` so that the report counts them as one known thing rather than as 135
failures. 21 of them call no `air.*` at all, which is why the intrinsic-free count (283) and the
M2 count (262) differ.

### 5a. Is there a path from a `nir_shader` to a draw on the phone? Yes.

This was the open question, because nothing here had run. The answer is that the harness can ride
the Mesa already on the phone rather than being built from nothing:

- The port's Mesa **already creates a Gallium screen for the Adreno**:
  `osmesa_create_gpu_screen()` in `tools/mesa/freedreno-darwin.patch` opens the kernel's `msm`
  driver through `tools/mesa/hakios-drm` and calls `fd_drm_screen_create_renderonly()`. It also
  already has `osmesa_surface_resource()`, which wraps an IOSurface as a `pipe_resource`. So the
  Gallium layer is reachable inside the library CoreAnimation already draws iOS through.
- **freedreno takes NIR natively** (`PIPE_SHADER_CAP_SUPPORTED_IRS` includes
  `PIPE_SHADER_IR_NIR`; `ir3_gallium.c` handles `cso->ir_type == PIPE_SHADER_IR_NIR`), so nothing
  has to go through GLSL on the way.
- `air_run.c` is written against that interface and nothing else. Here it asks for a software
  screen (`sw_screen_create(null_sw_create())`); on the phone it wants the screen
  `osmesa_create_gpu_screen()` makes, and **no line below that changes**.

**That is now built and in the image, and no export was needed.** `air_run` is built *inside* the
Mesa cross build (`AIR=1 tools/mk-mesa.sh`), so it links Gallium's own static libraries and opens
the Adreno itself — `drmOpenWithType("msm", …)` through `tools/mesa/hakios-drm`, then
`fd_drm_screen_create_renderonly()`, exactly as `osmesa_create_gpu_screen()` does. It needs
nothing exported from `libOSMesa` and does not load it: a 9.8 MB arm64 Mach-O against libSystem,
libz and IOKit alone. `userland/build.sh` puts it in `/redwood/bin`, and `rc.jobs.air` runs it.

The same source takes the GPU where there is one and falls back to software where there is not,
so it is the binary tested on this machine — not a variant of it. Its first line says which it
got (`air_run: clearFragment01 on softpipe` here), and that line must be read before any number
below it is believed. `AIR_RUN_SOFTWARE=1` forces software even on the phone, for comparing the
two on the same device.

**It runs on iOS, and the numbers are exact there.** In QEMU (`CMDLINE="cpus=4
RC_JOBS=rc.jobs.air" qemu/run-ios.sh 420`, a clean boot: 72 `[ ok ]` lines, SpringBoard up),
`air_run` translated `clearFragment01`, found no `msm` device, fell back to softpipe as designed,
drew the quad and read back

```
2.10170319e-18  0.178894654  1.48687698e+16  1.21394141e+33
```

— the same four floats, bit for bit, that LLVM computes on a computer and that softpipe draws
there. So the whole chain works on the target operating system: the container, the reader, the
translation, Gallium, the draw and the readback. What is left is one substitution — softpipe for
ir3 on the Adreno — and that needs the phone.

**On the phone, with the root on the flash, it runs and is exact — and it ran on softpipe.** The
first run of it (19 October, `logs/232842-run.log`) booted the flash-root recipe properly (both
`[ ok ] mount the iOS volume read only` and `[ ok ] the iOS volume is the root, the RAM part of
the boot on /private/preboot`), translated `clearFragment01` and read back the same four exact
floats as everywhere else. But its first line said `on softpipe`, and the kernel said why:

```
adreno: THE GPU IS NOT STARTED: the small image has no fw/a660_gmu.bin
        (the phone's /vendor/firmware/a660_gmu.bin goes into fw-gpu/)
```

The GPU driver had not started at all, because this working copy had no `fw-gpu/` — the phone's
own firmware, which is not in the repository. **Not the driver refusing work: no driver.** This is
exactly what that first line is for: the pixel was right, and reporting it as a result on the
Adreno would have been false. Read the line before the numbers.

**Second run, with the firmware in place: the GPU driver came up and `air_run` died reaching it.**
`logs/233855-run.log` has the Adreno starting properly — the GMU, the zap shader through
TrustZone, the SMMU — and then nothing from `air_run` but one line, which is the whole reason
that line exists:

```
air_run: signal 11 at 0x10, pc 0x10037e404, lr 0x1002829b0,
         called from 0x1002829b0 0x1000a139c 0x1000077e8 0x1c3fef344 (unslid)
```

Joined against `llvm-nm` of the binary by nearest preceding symbol, that is

```
pc   driParseConfigFiles + 0x54     <- the fault, at address 0x10
lr   fd_screen_create + 0x344
     u_pipe_screen_lookup_or_create + 0xa4
     main + 0x1f8
```

`fd_screen_create` passes the `pipe_screen_config` straight to `driParseConfigFiles`, which
dereferences it; this program handed it a zeroed struct. The port's own
`osmesa_create_gpu_screen()` fills it in with `driParseOptionInfo` and `driParseConfigFiles` over
`driinfo_freedreno.h`, and that sequence — the one CoreAnimation goes through on this device every
day — is now what `air_run` uses. **A machine with no `msm` device never reaches that code**, so
no amount of running it here would have found it; it took the first contact with real hardware.

Without the fault handler there would have been nothing at all to go on: iOS answers a crash here
with "Failed to send exception EXC_CORPSE_NOTIFY" and no report. Four lines of borrowed code
turned a silent exit into an exact address.

### It drew on the Adreno. M1 is finished.

20 October, `logs/000338-run.log`, with the config bug fixed:

```
air_run: clearFragment01 on Adreno 7c+ Gen 3 (the GPU, through the kernel's msm device)
...
air_run: read back from Adreno 7c+ Gen 3 (the GPU, through the kernel's msm device),
         ir3's instructions are above
air_run: the pixel at (0, 0) of render target 0 came back as:
  2.10170319e-18
  0.178894654
  1.48687698e+16
  1.21394141e+33
```

**A shader Apple compiled for Metal, translated here, compiled by ir3, run on the phone's GPU,
giving the colour out of its constant buffer bit for bit.** Four independent references now agree
on those four floats: LLVM's own execution of the module on a computer, our NIR folded over the
same bytes, softpipe, and the Adreno.

Three things had to be asserted rather than assumed, because the pixel looks identical whichever
path produced it:

- **which screen was created** — the first line, which is what caught the earlier run where the
  GPU driver had never started;
- **which screen the pixel came out of** — the same name printed again beside the numbers;
- **that the shader went through ir3 at all** — `--disasm`, which puts ir3's own output in the
  log. It is `; FRAG prog 1/1: 5 instr, 0 nops, 5 non-nops, 4 mov` and four `mov.u32u32 r0.x,
  c0.x`: the same five instructions, mov for mov, that `ir3_compiler` produced for this shader on
  the host months of work earlier. The constant file holds the Metal buffer, which is where ir3
  promoted the `nir_load_ubo` to.

### And the driver takes work that is not the window server's

`logs/000739-run.log`, `rc.jobs.air2`: the same draw after SpringBoard is up — 287 mentions of it
in the log, the ringer sounding at 29 s, the window server holding the GPU and drawing iOS through
`src/eagl.c`. `air_run` still got `Adreno 7c+ Gen 3` and still read back the same four floats.

So the kernel's GPU driver serves a second process while CoreAnimation is drawing. That question
was owed to the whole port rather than to this frontend, and the answer is yes. `rc.jobs.air` asks with the GPU idle; `rc.jobs.air2` asks again after SpringBoard
is up and holding it. A refusal is a finding the whole port needs, not just this frontend, so
either answer is worth the run.

(Counting anything out of a QEMU log here: `qemu/run-ios.sh` prints every line twice, and
`sort -u` does not catch it because the pairs are separated by other output.)

### 5b. Dispatching a kernel

`air_run` dispatches a 4×4 workgroup, binds every buffer the kernel declares — constant ones as
UBOs, device ones as writable SSBOs, all filled with the same `(i * 7 + 13) & 0xff` pattern — and
prints the device buffers afterwards. `MetalFaceMask_InitMinMax` is the first kernel through it:

```
  [ 0] 0x7fffffff   [ 1] 0x7fffffff   [ 2] 0x7fffffff
  [ 3] 0x80000000   [ 4] 0x80000000   [ 5] 0x80000000
  [ 6] 0xcac3bcb5   <- still the input pattern
```

which is exactly its NIR: six `store_ssbo`s, `INT_MAX` at offsets 0, 4, 8 and `INT_MIN` at 0xc,
0x10, 0x14. Six words written, nothing beyond them touched, and the name means what it does — a
min/max table initialised to the extremes.

**Two things that only showed because the input was a distinctive pattern**, and would have been
invisible against a zeroed buffer:

- the first dispatch ran **zero threads** and the buffer came back untouched. Metal's threadgroup
  size is a dispatch argument, so the frontend rightly leaves `workgroup_size_variable` set
  (section 7.4) — but softpipe reads the block size from `TGSI_PROPERTY_CS_FIXED_BLOCK_*`, which
  is then zero. Whoever dispatches has to fix the size; `air_run` now does. A kernel called
  `InitMinMax` writing zeros to a zeroed buffer would have looked like a pass.
- word 6 holding the pattern is what says the kernel wrote *only* its own 24 bytes.

**What this does not test: atomicity.** Seventeen of the forty kernels that translate use a global
atomic, and a sum written by threads that never raced is identical to one written by threads that
did. A test that could fail needs a kernel whose arithmetic is known — one written for the purpose
rather than one of Apple's — with the thread's own identity in what it writes. Until that exists,
a kernel that uses atomics and produces sensible numbers here has been shown to *run*, and nothing
more.

## 6. Running it

```
tools/air/mk-host.sh            # Mesa for this machine (x86-64): the frontend, ir3, softpipe
tools/air/check.sh              # the reader against llvm-dis, the corpus report, LLVM, the operations
```

and on one shader:

```
build/mesa-host/build/src/compiler/air/air2nir --ll  FILE[.metallib] [FUNCTION]   # what the reader read
build/mesa-host/build/src/compiler/air/air2nir       FILE[.metallib] [FUNCTION]   # the NIR
build/mesa-host/build/src/compiler/air/air2nir --eval FILE[.metallib] [FUNCTION]  # folded to numbers
build/mesa-host/build/src/gallium/drivers/freedreno/ir3_compiler \
        --chip-id 0x007506030500 FILE[.metallib] [FUNCTION]                      # Adreno code
tools/air/cpuref.py --compare FILE[.metallib] [FUNCTION]   # ours against LLVM's own answer
tools/air/cpuref.py --all --draw FILE.metallib             # every function: LLVM, folded, drawn
tools/air/intrincheck.py [-v] [OP ...]                     # one air.* operation at a time, folded
tools/air/intrincheck.py --run --few [OP ...]              # the same, drawn by a real driver
tools/air/intrincheck.py --emit DIR --few                  # modules + inputs + run.sh, to carry
tools/air/intrincheck.py --check DIR RUN.LOG               # judge what the runner printed
tools/air/atomiccheck.py [--keep DIR]                      # the atomics, with its own kernel
build/mesa-host/build/src/gallium/drivers/freedreno/air_run \
        FILE[.metallib] [FUNCTION]                         # draw with it, print the pixel
tools/air/texcheck.sh [FILE.metallib ...]                  # every texture shader, the texel it returns
tools/air/texopcheck.py [-v] [--keep DIR]                  # the texture calls, several texels each
```

`intrincheck.py` with no argument checks every operation the corpus calls; with one or more names
it checks only those, which is how it is used while changing a lowering:
`tools/air/intrincheck.py atan2`.

`--run` is the same operations *executed* instead of folded, and it is a different check, not a
slower one — section 4 item 4 says what each can see that the other cannot. `--emit` writes the
modules, the bytes for their input buffer, a `manifest.json` of what each should return and a
`run.sh` that uses only `for`, `echo` and parameter expansion, because what runs it may be the
phone's Darwin userland and not this machine's shell. `--check` then judges the log wherever it
was produced: the arithmetic reference never leaves the host.

`0x007506030500` is how freedreno names the redwood's Adreno 7c+ Gen 3 (A635); it has no
`gpu-id`, which is why `tools/mesa/air-ir3.patch` adds `--chip-id` to that tool.

There is no hosted CI: the corpus is Apple's code and stays out of the repository (and out of
GitHub). `check.sh` is the CI; it takes about five minutes, most of it the two per-operation checks, so it runs before every commit that touches
the frontend, and the report it writes is committed as `docs/air-report.md` with the numbers of
that commit.

The frontend lives in `tools/mesa/air/` and `mk-host.sh` links it into the pinned Mesa as
`src/compiler/air` — a link, not a copy, so there is no stale copy to build by mistake (a trap
this project has already fallen into once with `tools/mk-mesa.sh` and the freedreno patches).
`tools/mesa/air-ir3.patch` is the two-file change that teaches `ir3_compiler` to read AIR and
declares `air_run` beside it; it also removes a call of `ir3_nir_lower_variant` that tool makes
itself, which is a bug of the tool — `ir3_context_init` already calls it on its own clone, and
the const-state setup inside asserts the second time. It shows on every vertex shader and on
anything with image dimensions, and hid on everything else.

**That bug cannot be sent upstream, because the file is gone: `ir3_cmdline` was deleted from
Mesa on 2025-07-23** ("freedreno: remove ir3_cmdline — Nobody is using it anymore", 986530d2,
MR 36313). It is real in the 25.0.7 this port pins, and in every release before the deletion,
and in nothing that upstream still carries. The other half of it is untouched in main
(`ir3_context.c` still calls `ir3_nir_lower_variant`), and with no second caller there is
nothing wrong there. So there is no report to file; checking before writing one saved a
maintainer the time.

It leaves a consequence worth being plain about: **the `ir3` column of the corpus report rests on
a tool upstream has deleted.** While the port stays on Mesa 25.0.7 that is fine — the tool is in
the tarball and the patch applies — but it is not a route that survives a Mesa upgrade, and it
could never have been upstreamed. `air_run` does not share the problem: it uses the ordinary
Gallium interface (`screen->context_create`, `create_fs_state`, `draw_vbo`), which is what the
drivers and the port's own Mesa are built on. The durable way to get the `ir3` number after an
upgrade is `air_run` against a freedreno screen, which means on the phone, because freedreno
needs a real `msm` device and this machine has none.

A working copy also needs the phone's own firmware for the GPU to start at all: `fw-gpu/`
(`a660_gmu.bin`, `a660_sqe.fw`, the `a660_zap.*` pieces), which is not in the repository and which
`tools/new-workspace.sh` does not copy. Without it the kernel says so plainly and the system falls
back to software, so a run that looks fine can be a run on no GPU.

Needed on this machine: meson, ninja, bison, flex, python3 with venv, and LLVM's `llvm-as` /
`llvm-dis` for the reader check (22.1.8 here). The host build also patches Mesa 25.0's
`src/c11/threads.h`, because glibc 2.43 and later declare C11's `once_flag` and `call_once` in
`<stdlib.h>` and Mesa defines them again; the iOS cross build has its own libc and does not.

## 7. What this decides for the runtime (2) and the kernel ABI (3)

**Read this as intent, not as design.** The runtime and the kernel ABI do not exist; nothing below
has been built against, and none of it is a measurement. What each item *is* is the consequence
that this frontend's choices force on whoever writes those parts — so an item can be wrong in two
ways: the consequence may be mis-stated, or the frontend may have changed since. Where the
frontend already does its half, the item says so; where it does not, the item is a promise nobody
has kept yet. The one thing here that has been exercised at all is item 2's buffer binding, and
only through `air_run`, which is not a Metal runtime and binds by the same indices the frontend
reports.


1. **Compilation happens at pipeline creation, not at `newLibraryWithData:`.** Function constants
   (`newFunctionWithName:constantValues:`), vertex/fragment varying linking and visible-function
   linking are only known then. The library step can translate eagerly and cache NIR; the ir3
   step cannot run before the pipeline. (On real iOS the compile also leaves the process, for
   `MTLCompilerService`; whether this runtime does the same is a decision for (2), and NIR
   serialization — `nir_serialize` — makes either possible.)
2. **Buffers are bound per stage by index, as UBOs (constant) and SSBOs (device).**
   *(The frontend's half is done: it emits `load_ubo`/`load_ssbo` at Metal's own index and reports
   the kind per index in `air_shader_info`. `air_run` binds by those indices and the results come
   back right, which is the only thing that has tested this.)*
   `setVertexBuffer:offset:atIndex:` maps to the UBO or SSBO slot `index` of that stage; the
   frontend reports which kind each index is. Adreno's UBO and SSBO base addresses have alignment
   rules Metal's offsets do not (Metal allows 4-byte offsets for constant buffers); the runtime
   must bind an aligned base and the frontend will take the remainder from a driver uniform when
   that becomes necessary. Argument buffers (pointers in memory) will need GPU virtual addresses
   of buffers stable across submissions — a requirement on (3) — and 64-bit global access.
3. **One Metal texture index may be a sampler view or an image** depending on the shader's access
   qualifier; the frontend reports which, the runtime binds accordingly.
4. **Threadgroup memory passed as an argument is sized at dispatch**
   (`setThreadgroupMemoryLength:atIndex:`): the translator addresses it from base offsets in a
   driver uniform and Gallium's `variable_shared_mem` carries the total (as rusticl does for
   OpenCL `__local` arguments). The threadgroup size is a dispatch argument too
   (`dispatchThreadgroups:threadsPerThreadgroup:`), so `workgroup_size` is not fixed in NIR.
5. **Vertex outputs and fragment inputs match by name** (`"generated(8texcoordDv2_f)"`, `user(...)`),
   not by location: a pipeline-time link step assigns the same `VARYING_SLOT_VAR*` to the same
   name on both sides. Visible functions (CoreImage's 135 stitchable kernels are all of this
   kind) are linked into the calling shader by name with `nir_link_shader_functions`.
6. *(Half done: the frontend sets `origin_upper_left` on the fragment shader. `clip_halfz` is
   rasterizer state and nothing sets it — `air_run` never needed it, because its quad is already
   in clip space.)* **Clip space and the framebuffer are Metal's:** NDC depth is [0, 1] (`clip_halfz`), the
   framebuffer origin is the top-left; the frontend emits no flips, the runtime's viewport and
   rasterizer state must say this.
7. **Inline samplers** (`constexpr sampler` in the source, `!air.sampler_states`) are created by
   the runtime and bound after the API's samplers. *(Half done, and the half that is missing is
   the important one: the frontend assigns the index and passes the state word through, but it
   does **not** decode it — section 3.3. The earlier wording here said "from the state the
   frontend decodes", which was never true.)*

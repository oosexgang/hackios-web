# Review: security-policy stand-ins and the kernel surface the port adds

## Scope and method

Read-only audit. Nothing was built or run; no file other than this one was written.

Files read in full (line counts):

| File | Lines |
|---|---|
| xnu/files/bsd/kern/kern_minimac.c | 369 |
| xnu/files/libkern/amfi/miniamfi.c | 264 |
| xnu/files/libkern/amfi/miniamfi_entitlements.cpp | 123 |
| xnu/files/iokit/Kernel/MiniAppleKeyStore.cpp | 335 |
| xnu/files/iokit/Kernel/GenericARMPE.cpp | 407 |
| xnu/files/iokit/Kernel/MiniIONetworkStack.cpp | 114 |
| xnu/files/iokit/Kernel/MiniDrivers.h | 21 |
| xnu/files/osfmk/arm64/loader_return.c (the loader-return code) | 597 |
| xnu/files/osfmk/arm64/user_exception_trace.c | 440 |
| xnu/hakios.patch (all 73 hunks' files, every hunk read) | 3242 |

Also read, for the surface questions: the devfs/sysctl registration and the user-facing handlers in
bsd/dev/hakios.{input,audio,mic,camera,haptic,torch,sparse,virtio_blk,ufs,apfs_check,sound,speaker,guard}.c and
bsd/miscfs/apfs/apfs_vfsops.c (the three sysctls). The modem files (mpss, qmi, nas, ipa, cell) were skipped as
instructed.

Method. For each stub I traced who calls it and what the caller does with the answer. For each patch hunk I read the
unchanged Apple function around it. Apple's original code was read with `git show c54f35ca...:<path>` (read-only) from
the XNU checkout that lives in WSL (`/home/shimoku/hakios/xnu-src/xnu-8796.121.2`), because this Windows tree has no
`xnu-src`. Line numbers of the form "Apple file:N" are in that original file; "patch:N" are lines of
xnu/hakios.patch; everything else is a line of the file named.

Overlap: the sound/input/camera reviewers (docs/driver-review/sound.md, input.md, camera-haptic-torch.md) found P2 and
P3's touch/audio/mic parts independently; I re-derived them because the question asked for every device node, and I
cross-reference instead of repeating their detail. P1, P4, P5, P6, P7 are not in those documents.

## Findings

| id | severity | confidence | where | one line |
|---|---|---|---|---|
| P1 | High | CONFIRMED | patch:518-606 (Apple kern_exec.c:3097, 3107-3111, 3132-3135, 3591, 3985) | any process becomes uid 0 with `posix_spawn` persona OVERRIDE: the entitlement check and the persona lookup were removed, nothing replaced them |
| P2 | High (effect on hardware), Medium (as a bug) | CONFIRMED trace / NEEDS-HARDWARE effect | hakios.audio.c:259-275, hakios.sound.c:1267/1272/1279, hakios.speaker.c:897/914 | unprivileged ioctl value wraps in `below + extra`: loudest level past `sound_below`, speaker guard blinded, watcher thread stuck (same as sound.md S-01/S-02) |
| P3 | Medium | CONFIRMED (mode) | hakios.input.c:213, hakios.audio.c:343, hakios.mic.c:1732, hakios.camera.c:4000, hakios.haptic.c:828, hakios.torch.c:575 | six device nodes are mode 0666: any process can read the microphone and camera, read and forge every touch and button |
| P4 | Medium | CONFIRMED (hunk) / PLAUSIBLE (reach) | patch:828-839 (kern_priv.c) | `PRIV_NET_PRIVILEGED_SOCKET_DELEGATE` returned 0 for every credential, before the MAC deny policies; the reason given in the comment is stale |
| P5 | Low | CONFIRMED | patch:853-859 (kern_sig.c), user_exception_trace.c:112-145 | `user_abort_trace()` prints from `pthread_kill(SIGABRT)` with no boot-arg gate, unlike its sibling |
| P6 | Low | PLAUSIBLE | patch:726-742 (Apple kern_exec.c:6639) | the "do not bump the pid version" exception is keyed on the process name `xpcproxy` only |
| P7 | Low | PLAUSIBLE | kern_minimac.c:169-224 | Sandbox request 4 answers for any pid, from memory the target process can rewrite |

Counts: 4 CONFIRMED (P1, P3, P4, P5), 1 CONFIRMED trace with NEEDS-HARDWARE effect (P2), 2 PLAUSIBLE (P6, P7).

Once P1 holds, every "root required" statement below (sysctls, raw storage nodes) stops being a boundary for a
process that can call `posix_spawn`; I note that where it matters.

## P1. Any process can become root: persona check removed (High, CONFIRMED)

Where. patch:518-606, which changes `spawn_validate_persona()` and `spawn_persona_adopt()` in bsd/kern/kern_exec.c.

What Apple's code did (Apple kern_exec.c:3092-3166, called from 3591 and 3985):

- `spawn_validate_persona()` returned EPERM unless the caller held `PERSONA_MGMT_ENTITLEMENT`
  (3097-3099), and ESRCH if the persona did not exist (3107-3111).
- `spawn_persona_adopt()` then applied `pspi_uid`, `pspi_gid` and the groups from the caller's `posix_spawn` argument
  to the child's credential (3139-3159).
- The sibling argument `posix_cred_info` is guarded differently: `kauth_cred_issuser()` or EPERM (Apple
  kern_exec.c:3604-3607).

What the patch does. Both guards are deleted (patch:522-524, 543-547, 556-558). When the persona does not exist
(which is always the case here) the new branch at patch:566-606 sets the uid, gid and groups from the caller's request
on the child with `proc_update_label()` and returns 0.

Failure scenario. Any process, at any uid, with no entitlement and no signature, calls `posix_spawn` with a persona
attribute (`posix_spawnattr_set_persona_np`, flags OVERRIDE, `posix_spawnattr_set_persona_uid_np(attr, 0)`) for any
path. The child is created with uid 0, gid and groups of the caller's choosing. Nothing in the spawn path checks the
caller. The patch's own comment says this is what Sileo relies on to become root ("Sileo asks posix_spawn for persona
99 with OVERRIDE and uid 0 ... that is how it runs apt and dpkg"). The comment justifies the removal with "the
entitlement is one nobody carries here (nothing is signed, AMFI is a stub)".

Why that justification is out of date. miniamfi_entitlements.cpp now answers entitlement queries from the entitlements
in the program's own signature, `IOCurrentTaskHasEntitlement()` reaches it (iokit/Kernel/IOUserClient.cpp:1507,
iokit/bsddev/IOKitBSDInit.cpp:1495-1559), and the sibling hunk in the same file keeps the check for bindfs
(patch:964-973). So the entitlement route works now; the unconditional removal is not needed for Sileo, whose binary
can carry `com.apple.private.persona-mgmt` in an ldid signature.

Consequences. A root child can open /dev/rufs_* and /dev/rvblk0 (see the table below), set `kern.exec_inject`, call
`reboot(2)` (which now returns to the loader, see halt_all_cpus in patch:2199-2211), and so on.

Fix (text only):

```
 spawn_validate_persona(struct _posix_spawn_persona_info *px_persona)
 {
 	int error = 0;
 	struct persona *persona = NULL;
 
+	if (!IOCurrentTaskHasEntitlement(PERSONA_MGMT_ENTITLEMENT)) {
+		return EPERM;
+	}
 	if (px_persona->pspi_flags & POSIX_SPAWN_PERSONA_GROUPS) {
```

and sign Sileo (and anything else that must do this) with that entitlement. Keep the `persona == NULL` branch in
`spawn_persona_adopt()`, which is only reachable after the check.

## P2. Unprivileged volume ioctl wraps uint32: loudest level, guard blinded, thread stuck (CONFIRMED trace, NEEDS-HARDWARE effect)

Same defect as sound.md S-01/S-02; traced again here because the node is part of the user-reachable surface.

Trace. `HAKIOS_AUDIO_SET_VOLUME` (hakios.audio.c:259-275, node mode 0666 at :343) stores any `uint32` `below`
(`volume_below = volume->below`, :268) with no range test. The sound watcher (hakios.sound.c:1253-1279) computes
`below + extra` in `uint32_t` (default `below` is 240) and passes it to `hakios_speaker_volume()` and `guard_level()`.
In `hakios_speaker_volume()` (hakios.speaker.c:897 and :914) `target = a->volume_at + below` wraps again.

With `extra = 0xFFFFFF0F` the sum is `0xFFFFFFFF`:

- `guard_level(0xFFFFFFFF)` is `HAKIOS_GUARD_SILENT` (hakios.sound.c:1214-1216, `guard_as` defaults to UINT32_MAX), so
  in hakios.guard.c:160 `to_speaker = 0`: no power limit, only the full-scale clip at :225.
- `target = volume_at - 1`. `set_volume()` clamps up to `volume_at` (hakios.speaker.c:707-709) and stores the
  clamped value in `a->volume`, so `a->volume == target` never holds (:919). The `for (;;)` at :909 never ends (with
  `step_ms == 1` the fault check at :928 is skipped), and the watcher thread never reaches `hakios_speaker_stop()`.

Failure scenario (sound=4 boot-arg, phone): any process does the ioctl `{below = 0xFFFFFF0F, muted = 0}` and writes
non-silent frames. The amplifiers go to Android's loudest level, the guard computes zero speaker power, and the
amplifiers are never powered down. Whether Android's level without the guard damages the speakers is NEEDS-HARDWARE.

Fix: see sound.md S-01 (clamp `below` at the ioctl, saturating add in sound.c and speaker.c); and fix P3 for this node.

## P3. Six device nodes are world read/write (Medium, CONFIRMED for the mode)

Every node the port creates, with mode and owner:

| Node | Created at | Mode, owner | What an unprivileged opener can do |
|---|---|---|---|
| /dev/hakios-touch | hakios.input.c:213 | 0666 root:wheel | read every touch sample (and consume them: one shared queue, `touch_read` pops); write forged DOWN/MOVE/UP and button events, including Lock/Home/Volume (`touch_write`, :184-200; only real-driver fingers count towards the five-finger exit, :87-107) |
| /dev/hakios-audio | hakios.audio.c:343 | 0666 root:wheel | inject audio into the speaker path; set or reset volume and mute (P2) |
| /dev/hakios-mic | hakios.mic.c:1732 | 0666 root:wheel | `mic_dev_open` (:1522) switches the DSP microphone path on; `mic_dev_read` returns live samples to any reader; two readers split the stream (no lock on `ring_read`, memory-safe) |
| /dev/hakios-camera | hakios.camera.c:4000 | 0666 root:wheel | `camdev_read` (:3803) starts the sensor and returns frames; `camdev_write` sets exposure, focus, sensor, and fills the "picture for the host" buffer that the loader hands out (`keep_picture`, :3906-3940, bounded by `want <= keep_bytes`) |
| /dev/hakios-haptic | hakios.haptic.c:828 | 0666 root:wheel | drive the vibration motor (`haptic_write`) |
| /dev/hakios-torch | hakios.torch.c:575 | 0666 root:wheel | light the flashlight (`torch_write`; level clamped to 1000, the driver has a 30 s limit) |
| /dev/ufs_* , /dev/rufs_* | hakios.ufs.c:1517, 1522 | 0640 root:operator | raw phone storage, read only (see below) |
| /dev/rvblk0, /dev/rrvblk0 | hakios.virtio_blk.c:516-518 | 0600 root:operator | QEMU disk image |
| /dev/rsp0 | hakios.sparse.c:270 | 0600 root:operator | part of an image, block device |
| /dev/md*, /dev/rmd* | Apple bsd/dev/memdev.c:686-697 (unchanged) | 0600 root:operator | RAM disks, including the second image added at patch:1713-1723 |

Can an unprivileged process read the phone's raw storage? Not directly: /dev/ufs_* and /dev/rufs_* are 0640
root:operator (owner root, group operator read-only; on iOS the group has only root in it), /dev/rvblk0 and /dev/rsp0
are 0600. With P1, any process can reach root and therefore all of them. The write path to /dev/rufs_darwin is bounded
(see "Checked and found fine").

The code does no check of its own in any `d_open` (`touch_open`, `audio_open`, `mic_dev_open`, `camdev_open`,
`haptic_open`, `torch_open`); file mode is the only gate. Whether the iOS sandbox adds one is out of reach here (the
Sandbox is a stub that allows everything, kern_minimac.c:230-242).

Fix: create these nodes 0600 root:wheel, or 0660 with the group of the one daemon that uses each (backboardd for touch,
mediaserverd for audio, mic, camera, haptic, torch), or test an entitlement in `d_open`, for example in touch_open:

```
 static int
 touch_open(...)
 {
-	return 0;
+	return IOCurrentTaskHasEntitlement("com.apple.hakios.touch") || suser(kauth_cred_get(), NULL) == 0 ? 0 : EPERM;
 }
```

## P4. A privilege that was refused is now granted to everyone, before the deny policies (Medium)

Where. patch:828-839, `priv_check_cred()` in bsd/kern/kern_priv.c:

```
if (priv == PRIV_NET_PRIVILEGED_SOCKET_DELEGATE) { return 0; }
```

placed before `mac_priv_check()` (Apple kern_priv.c:89-94), so no MAC policy can deny it, and for every credential, not
just mobile.

What it enables. The privilege is the gate for socket delegation: `so_set_effective_pid()`/`so_set_effective_uuid()`
when the target is not the caller (Apple uipc_socket.c:8111-8117, :8235), `socket_delegate()` (Apple
uipc_syscalls.c:270-276), NECP client delegation (necp_client.c:6917, necp.c:6847), and the Skywalk delegate checks
(fsw.c:973, nx_netif.c:1575). With the hunk any process can attribute its sockets to any other pid and executable UUID,
so per-process network policy, statistics and accounting see the victim instead of the caller.

The stated reason is stale. The comment says no process carries an entitlement. Today miniamfi_entitlements.cpp reads the
entitlements from each program's signature, and kern_minimac.c:290 already maps this very privilege to
`com.apple.private.network.socket-delegate`; trustd, nsurlsessiond and mediaserverd carry it in their Apple signatures.
So the hunk is redundant and makes the stub's entry dead code. (kern_minimac.c:253-258 says the NECP refusal "costs
nothing"; with this hunk the macro is never refused, so that comment and this hunk cannot both describe the current
tree.)

Reach is PLAUSIBLE only because I did not run it: whether anything in this port enforces NECP policy per app was not
examined.

Fix: delete the hunk. The entitlement path in `minisandbox_priv_grant()` grants the privilege to the daemons that hold
the entitlement.

## P5. An unconditional kernel printf on a user-controlled path (Low, CONFIRMED)

patch:853-859 adds, in `__pthread_kill()`:

```
if (signum == SIGABRT) { user_abort_trace(); }
```

`user_abort_trace()` (user_exception_trace.c:112-145) has no gate. Its sibling `user_exception_trace()` returns at once
unless the boot-arg `systrace` is set (:48); `ustacks` is boot-arg driven. The file's header says the facility is on
"with boot-arg systrace set".

Failure scenario. A process ignores SIGABRT (`signal(SIGABRT, SIG_IGN)`) and calls `pthread_kill(pthread_self(),
SIGABRT)` in a loop. Each call does one `printf` of up to 24 return addresses, plus the process name (which the process
chooses: its executable's last path component, so it can embed newlines). That goes to the console (video console and
UART, which the loader comments call very slow), to the kernel message buffer, and from there into the loader's log
(which keeps the first 256 KB and the last 1 MB, loader_return.c:30-38): the log's evidence is pushed out and the CPUs
that printf are slowed. Not a memory-safety problem: the frame walk is bounded (24 frames, monotonic, `copyin`).

Fix:

```
 void
 user_abort_trace(void)
 {
 	thread_t thread = current_thread();
+	if (!user_exception_trace_enabled) {
+		return;
+	}
```

## P6. Pid-version bump skipped by process name only (Low, PLAUSIBLE)

patch:726-742 skips `proc_setpidversion()` in `exec_handle_sugid()` (Apple kern_exec.c:6639) when
`strncmp(p->p_comm, "xpcproxy", ...) == 0`. At that point `p_comm` is still the name of the image that is exec'ing
(`set_proc_name()` runs later, Apple kern_exec.c:1924, after `exec_handle_sugid` at 1581). So the exception applies to
any process whose comm is `xpcproxy`, for any exec it does, not only the exec into the service xpcproxy was spawned
for. A process inherits the comm through fork, and a user can name a program `xpcproxy`.

The pid version in the audit token is what makes a daemon that holds an audit token notice an exec; without the bump a
process called xpcproxy can send an XPC message as itself, exec an entitled system binary, and the daemon's later
entitlement check on the unchanged token resolves to the new image (the classic exec race). On this port the same
effect is already cheaper through a self-written signature (the AMFI stub reads entitlements without validation), so
the practical gain is small; but the hunk regresses a property the kernel otherwise keeps. Reach depends on daemon
behaviour I did not examine, hence PLAUSIBLE.

Fix: also require the spawn that created the process to be launchd's, for example only skip when `p->p_ppid == 1` and
the target is not xpcproxy itself, or mark xpcproxy's spawn with a posix_spawn flag that the kernel records in the
`proc`, and test that instead of the name.

## P7. Sandbox request 4: container of any pid, read from memory the process owns (Low, PLAUSIBLE)

kern_minimac.c:147-225 answers `sandbox_container_path_for_pid()` for any `args.pid` the caller names (:173-176): no
check of the caller's credential, of its relation to the target, or of an entitlement. The answer is taken by scanning
the target's exec strings for `CFFIXED_USER_HOME=` in its live user stack (:196-222). That memory is writable by the
target after exec, and at exec time it is whatever environment the parent passed.

Failure scenario. Process A rewrites the `CFFIXED_USER_HOME=` string in its own stack (or execs itself with the
variable set). A daemon that asks the kernel "what is A's container" (the call exists for exactly that) gets the path A
chose, for example another application's data container, and may then read or write there on A's behalf. A different
process learns the container path of any other process. The kernel side is memory-safe: `strnlen` and `s + len < end`
bound the scan, `len < args.size` bounds the copyout, the map is referenced, and the page-rounded copy covers `argslen`.

The comment (kern_minimac.c:137-142) says the environment is where the container comes from, so this is by design; what
the comment does not say is that the answer is exposed for other pids and that the source is mutable. Which user-space
daemons use the answer for an access decision was not examined.

Fix, if it matters: cache the string in `struct proc` at exec time (the kernel already walks the strings in
`exec_extract_strings`) instead of re-reading the stack, and require `kauth_cred_getuid` equality or
`PRIV_...` for pid != caller.

## Checked and found fine

Policy stand-ins

- AMFI (miniamfi.c): `vnode_check_signature` sets CS_SIGNED and, for ad hoc signatures, CS_PLATFORM_BINARY, and returns 0
  (:45-62). That is stated at kern_minimac.c:11-17. The consequences I traced: `task_conversion_eval_internal` (Apple
  ipc_tt.c:2489) lets a platform binary resolve other platform binaries' task ports, and `F_ASSERT_BG_ACCESS` (Apple
  kern_descrip.c:5048) is platform-only; both are therefore open to any ad hoc signed program, which anyone can make.
  By design; noted so that nobody reads "platform" as a trust statement.
- The trust-cache and OSEntitlements tables answer "not found" or "unsupported" everywhere except the three
  `...WithProc` queries, which read the program's signature (miniamfi.c:93-124); only the `WithProc` variants are called
  by the kernel (IOKitBSDInit.cpp:1495/1526/1559, IOUserClient.cpp:1507). No stub answers "yes" for an entitlement the
  signature lacks; an absent signature has none (`cs_entitlements_blob_get` returns NULL when CS_SIGNED is unset, Apple
  kern_cs.c:1725-1727).
- `copy_entitlements` (miniamfi_entitlements.cpp:32-64): rejects `length <= sizeof(CS_GenericBlob)`, copies
  `length - 8` into a buffer of `+1` and terminates it. Notes, not findings: the plist is re-parsed on every query
  (no cache), and its size is bounded only by the code-signature blob limit.
- dyld policy request 0x5a and boot-arg query 0x60 (miniamfi.c:89-111): fixed 8-byte copyout to the address the caller
  gives; `copyin` of exactly 16 bytes; everything else is ENOPOLICY. It answers "allow everything" to every process,
  including DYLD_* variables and interposing for restricted programs; that is the purpose (kern_minimac.c:64-69).
- Sandbox (kern_minimac.c:230-242): every request except 4 returns 0 and writes nothing. A caller of an "issue
  extension" style request then reads an unwritten out buffer in user space; stated in the file's header.
- `minisandbox_priv_grant` (:318-349): consulted only after the root test (Apple kern_priv.c:104-119); the entitlement
  is read from the current process and only when `cred == kauth_cred_get()`; PRIV_WORK_INTERVAL is granted to all
  (:325, needed by UIKit; it gates `WORK_INTERVAL_OPERATION_CREATE2`, Apple sys_work_interval.c:71, and the effect of the
  work-interval classes needs a workload id, which I did not trace). The table maps privileges to entitlements that a
  user can write into their own signature (no validation: stated at miniamfi_entitlements.cpp:4-9), so for non-root
  these privileges are as strong as the signature a user chooses. Log lines are bounded (32 privileges).
- AppleKeyStore (MiniAppleKeyStore.cpp): answers "no passcode, unlocked" for state; lock, unlock and `UnlockBag`
  return success for any input, which is the right answer for a device with no passcode and, since no
  change-passcode selector exists (`kIOReturnUnsupported`, :314), no caller can set one. Wrap/unwrap are a reversible XOR
  (:173-181) and the file says so. Bounds: wrap needs `1..64` bytes into `wrapped[72]` (:261-277); unwrap
  `9..72` into `key[64]` (:285-290); DER buffers `der[128]` hold 91 and 30 bytes; `scalarOutputCount` and
  `structureOutputSize` are checked before writes. The user client has no task check, but nothing it returns or does is
  secret or persistent.
- Data protection: the APFS port implements no protection class and `apfs_vnop_ioctl` returns ENOTTY
  (apfs_vnops.c:1190-1197), so `F_SETPROTECTIONCLASS`-style callers get "unsupported", not success.
- MiniIONetworkStack: a service, an openable user client, `setProperties` refuses (:85-94); the open logs the registry
  state; no state is shared.
- GenericARMPE: CPU nubs are indexed only after `number >= MAX_CPUS` is excluded (:234); `reg` length checked (:77);
  `cpus[]` is static; the thread-call lambda touches only `cpus[]` and the topology. The device tree is the loader's.

Surface

- Every sysctl the port adds (grep over xnu/files; the modem files were not read):
  - writable: `kern.exec_inject` (root; see below), `kern.hakios_switch_root` (pid 1 and root, once, input
    `< 512` bytes, hakios.apfs_check.c:1753-1766), `kern.apfs_synthetic` (explicit `suser`, `newlen < MAXPATHLEN`,
    NUL-terminated, apfs_vfsops.c:660-671), `kern.apfs_stats` (write zeroes the counters, root through the sysctl
    layer), `kern.hakios.var_save`, `kern.hakios.var_busy`, `kern.hakios.ufs_native` (`sysctl_io_number`, a small state
    machine, root).
  - read-only: `kern.hakios.version`, `kern.hakios.battery_*`, `kern.hakios.ufs_*` counters, `kern.hakios_memory`
    (apfs_vfsops.c:474-478).
  - none uses CTLFLAG_ANYBODY (grep), and Apple's `sysctl_root` demands `proc_suser` for any write to an OID without it
    (Apple kern_newsysctl.c:1737-1745). So all writes need uid 0, which P1 makes available to any process.
- `kern.exec_inject` (patch:625-677): `SYSCTL_STRING(... exec_inject_conf, 512)`; Apple's `sysctl_io_string` refuses
  `newlen >= 512` and terminates at `newlen` (kern_newsysctl.c:530-536), so the buffer always has a NUL. The parser
  advances at least one byte per iteration or exits at NUL; the append test `used + 1 + liblen < size` leaves room for
  the `:` and the NUL; `inject_env` is 512 bytes, the same size as the buffer; matching is on the file's basename with an
  exact length compare. An unprivileged user can only get the library into a process they run themselves by naming it;
  that gives them nothing they lack. The variable is added after the caller's own environment, so a caller-supplied
  `DYLD_INSERT_LIBRARIES` comes first.
- bindfs exemption (patch:964-973): the entitlement test remains (and can now be satisfied from a signature); the extra
  `pid == 1` clause only matters to a process that is pid 1, which stays launchd after init execs it. Mounting still
  needs root.
- Raw-storage write path (hakios.ufs.c:566-625, 823-857): block aligned, only the one partition selected by the
  `ufs_write=1` boot-arg, from `UFS_WRITE_FIRST` on, `offset` and `len` checked against the partition size in uint64,
  the character open of that partition clears FWRITE before the open check but the node mode (0640, owner root) still
  decides who may open it for writing, and one writer at a time through the `var_busy` claim.
- Camera, mic, audio, haptic, torch handlers: every `uiomove` length is bounded by the destination size (`audio_write`
  chunks to the stack buffer; `mic_dev_read` `n <= RING_FRAMES`; `camdev_read` `n <= ring_frame_bytes`; `haptic_write`
  256 samples; `torch_write` clamps to 1000); exposure and focus values are clamped before they reach registers
  (`exposure_limits` :3306, `af_move` :3039).
- User-visible patch hunks, regression check: `mdevrw` (patch:311-321) keeps the original treatment of a negative offset
  (root-only, Apple's behaviour); `km.c` TIOCSCTTY refusal only affects the console; work-interval cases 6-8
  (patch:924-939) return 0 only for CoreAudio threads, otherwise the old ENOTSUP; vm_unix.c shared-region hunk
  (patch:1442-1462) adds an accept branch for a volume mounted directly inside Preboot's Cryptexes (root-only mount; the
  `va_uid == 0` owner check at Apple vm_unix.c:2475 still applies earlier) and keeps `vnode_put` balanced in all three
  arms; `percpu_foreach_secondary` rewrite is integer arithmetic with the same bounds; `halt_all_cpus` and
  `kdp_machine_reboot_type` call `loader_return()` first, which returns at once if no loader stub exists; the
  `systrace`, `applog`, `regtrace`, `exec_trace` hooks are boot-arg gated and bounded (`copyinstr` into 160- and 32-byte
  buffers, at most 6 mib words); `startup.c` declares `minimac_policy_init` inside `#if CONFIG_VNGUARD` while the call is
  outside it (a RELEASE configuration without vnguard would not compile; DEVELOPMENT builds are unaffected).
- Loader return (loader_return.c, start.s hunk patch:2392-2631): the stub address and the PA-VA offset are read from
  `loader_stub_slot`, which the loader patches in the kernel image and nothing user-reachable writes;
  `loader_jump` rejects `t0sz` outside 25..33 or a stub that does not fit under it, so `loader_l1[stub >> 30]` is
  below 512; the ring arithmetic keeps every index below `LOADER_LOG_SIZE`; the early exception vectors branch to the
  loader only while VBAR holds a physical address and spin as before when no stub was patched. The kernel does not check
  the slot's magic or that the stub lies outside the kernel, and it acts on `loader_live.stop` as soon as it is
  non-zero; both are writable only by the loader or by whoever has kernel memory. The loader in turn trusts the
  `loader_recording`/`loader_sound` physical addresses and lengths (at most 1 GB) that the kernel writes; the
  only user-influenced writer is the camera's `keep_picture`, which stores the address of its own buffer.
  Minor: `loader_return_entered` is tested and set without an atomic, so two processors reaching `loader_jump`
  together (a panic and the five-finger exit) could both pass it; `psci_smp_stop_others()` runs first and I did not trace
  its handling of that.

## Not checked

- IOKit user clients of MiniIOSurface.cpp, MiniIOMobileFramebuffer.cpp, hakios.gpu.cpp, hakios.wlan.cpp,
  hakios.battery.cpp (external methods, shared memory): outside the file list given to me.
- bsd/miscfs/ramfs and apfs vnode operations: how ownership, setuid bits and `access` are enforced there (ramfs stores
  `va_mode & ALLPERMS`, ramfs.c:152, 1032).
- What iOS user space does with the stub answers: whether cfprefsd, lsd or containermanagerd use P7's container path
  for an access decision; whether dyld honours DYLD_* for setuid programs given the allow-all AMFI answer; whether this
  port ships any setuid-root program; whether `task_for_pid` is otherwise gated for ad hoc signed callers.
- Behaviour on hardware: P2's effect on the speakers, whether the Sandbox stub's `0` for unknown requests produces
  usable values in `libsystem_sandbox`.
- gic_v3_irq.c, psci_smp.c, generic_arm64_support.c, minicrypto, the cellular files, xnuloader's USB side.
- The scheduler hunks for slower cores (sched_prim.c, machine_routines.c): read, not analysed for correctness; they
  are policy, not privilege.

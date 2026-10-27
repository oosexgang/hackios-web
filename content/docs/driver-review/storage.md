# Storage and the write guard: review

Read-only audit, no source file changed, nothing built. Evidence is file:line in the tree as it stood on 2026-10-26/27.

## Scope

Kernel, `xnu/files/bsd/dev/`:

| file | lines |
|---|---|
| hakios.ufs.c | 1654 |
| hakios.ufshc.c | 1333 |
| hakios.ufshc.h | 32 |
| hakios.sparse.c | 281 |
| hakios.virtio_blk.c | 530 |
| hakios.apfs_check.c | 1872 |
| hakios.image.c | 187 |
| hakios.guard.c | 315 (this is the speaker limiter, not a write guard) |

Headers read: `xnu/files/bsd/sys/hakios.virtio_blk.h`, `hakios.sparse.h`, `hakios.apfs_check.h`, `hakios.audio.h` (two defines).

Loader: `xnuloader/loader.c`, the block service (lines 1440-2160: `BLOCK_*`, `block_is_darwin`, `block_start`, `block_poll`, hc_take_back), the boot-arg parse (2840-2873), `write_logs` and `find_log_partition` (240-380), and the watch loop that calls them (2236-2365). The only two `write_blocks` call sites in the loader are 361 (logdump) and 2123 (darwin).

APFS read path, because `hakios.image.c` and `hakios.apfs_check.c` sit on it: `xnu/files/bsd/miscfs/apfs/apfs_lib.c` lines 100-1700 (blocks, node_parse/node_entry, omap, nx_open, vol_open, seek/cursor, xfields, inode, readdir) and 2020-4062 (xattr, extents, stream_plan/fetch, decmpfs header and tables, read_cfile_attr/rsrc, read_plain). Also all of `apfs_write.c`, `apfs_store.c`, and the mount/write-relevant lines of `apfs_vfsops.c` and `apfs_vnops.c` (grep for FWRITE, MNT_RDONLY, dev.write).

Method: read every function end to end on the write path (cwrite -> ufs_write -> ufs_request -> mailbox -> block_poll -> UEFI BlockIo) and on the strategy/completion path of the UFS host controller, then the other places that could reach storage (grep for `write_blocks`, `0x1d84000`, `UTRLDBR`, `VNOP_STRATEGY`, `B_WRITE`, `FWRITE`, `dev.write`). Arithmetic was checked by hand for wrap on every length and offset. The XNU source tree (`xnu-src/`) is not present on this machine, so anything that depends on XNU behaviour (spec_open, spec_strategy, PE_parse_boot_argn) is stated as an assumption.

## Summary

The write guard held against every route I tried (section "The write guard: routes tried"). No finding below lets a write reach anything but `darwin` from block 2042368 on, with `ufs_write=1`. The one documented exception to "only darwin" is the loader's own log write into `logdump` (F7), which is in `docs/install.md:11` and `tools/provenance.allow:28`.

12 findings: 6 CONFIRMED, 5 PLAUSIBLE, 1 NEEDS-HARDWARE. None is high. Two are medium (F1, F2).

## Findings

| id | severity | confidence | where | one line |
|---|---|---|---|---|
| F1 | medium | PLAUSIBLE | loader.c:370-372, 2285-2294, 2345 | `write_logs` reads the log back into `block_buffer`, the kernel's mailbox buffer, while the kernel is running |
| F2 | medium | CONFIRMED | ufshc.c:650-662, 572-579, 802-823 | after one slot times out, every other in-flight slot of the same read waits its own 10 s: N x 10 s |
| F3 | low | CONFIRMED | ufs.c:452-460 | `static bounce` allocated outside the lock: leak, and one reader can copy out of the wrong buffer |
| F4 | low | CONFIRMED | ufs.c:1307 | `crc32(0, h, header_size)` with a header size straight from disk over a 4096-byte buffer |
| F5 | low | CONFIRMED | sparse.c:85-89, 231, 245-252 | slot not checked against `sparse_present`; header size checks wrap |
| F6 | low | PLAUSIBLE | virtio_blk.c:241-254 | timed-out request stays on the queue; the next request can take the stale completion |
| F7 | info | CONFIRMED | loader.c:331-361, 263-286 | the loader writes `logdump` without `ufs_write=1`, identified by name only |
| F8 | low | PLAUSIBLE | loader.c:2869 vs ufs.c:1535 | duplicated `ufs_write=` : loader ORs all, kernel takes the first |
| F9 | low | NEEDS-HARDWARE | ufshc.c:887-910, 1063-1066 | up to ~2 s with interrupts off when the doorbell never clears |
| F10 | low | PLAUSIBLE | ufs.c:704, 736-747 | `ufs_bsize[]` is changed under a mounted device by the 512-and-back dance of `spec_open` |
| F11 | low | PLAUSIBLE | ufs.c:1094, 534-555, 970-978 | `hakios_ufs_read_partition` range check wraps; `ufs_read` has no partition bound on the native path |
| F12 | low | CONFIRMED | apfs_lib.c:1063 vs 1107 | `block_count` of the chosen superblock replaces block 0's without the device-size check |

## Details

### F1 - the log write-back shares the mailbox buffer with the kernel (medium, PLAUSIBLE)

- `loader.c:370-372`: `rs = bio->read_blocks(..., 0, len, block_buffer); same = ... memcmp(block_buffer, out_buf, len)`.
- `block_buffer` is also the kernel's data buffer (`loader.c:298`, handed out as `buffer_pa` at 1982).
- `write_logs` is called from `flush_log()` at 2276 and 2293. On redwood `log_other_cpu = 1` (544), so while the kernel runs on the other core, every 2 s for the first `NOTE_SECONDS` (24 s, line 937) core 0 runs `flush_log()` before it calls `block_poll()` (2345).
- Failure: the kernel has been answered for a read of N bytes (the answer is posted at the end of `block_poll`) and is copying out of the buffer (`ufs.c:384-385`). Core 0 enters `write_logs` and its `read_blocks` overwrites `block_buffer[0..len)` with the log. The kernel copies log bytes as file or APFS metadata and gets success: silent wrong data. The reverse order (kernel `memcpy` into the buffer for a write while `read_blocks` lands) is not caught by the loader's own read-back check, because `want = ufs_crc32(block_buffer, bytes)` at 2122 is taken after the damage; but writes normally happen at the end of a run, outside the 24 s.
- Why only PLAUSIBLE: the window is the time between the answer and the end of the kernel's copy (microseconds to a few ms), and `write_logs` spends ms in `write_blocks` before it reads back, so the copy is usually over. Needs a trace to see it. With `ufs_native=1` the log write is skipped (`hc_list_is_uefis()` false, 353) so the window does not exist there.
- Fix: do not use `block_buffer` for the log read-back.

```
-static uint8_t block_buffer[BLOCK_BUFFER_SIZE] ...
+static uint8_t block_buffer[BLOCK_BUFFER_SIZE] ...;           /* kernel's mailbox only */
+static uint8_t log_verify[2 * 1024 * 1024 + 8192] __attribute__((aligned(0x2000)));
 ...
-		if (len <= sizeof(block_buffer)) {
-			rs = bio->read_blocks(bio, bio->media->media_id, 0, len, block_buffer);
-			same = !EFI_ERROR(rs) && memcmp(block_buffer, out_buf, len) == 0;
+		if (len <= sizeof(log_verify)) {
+			rs = bio->read_blocks(bio, bio->media->media_id, 0, len, log_verify);
+			flush_dcache((uint64_t)(uintptr_t)log_verify, (uint64_t)(uintptr_t)log_verify + len);
+			same = !EFI_ERROR(rs) && memcmp(log_verify, out_buf, len) == 0;
```

(or simply skip the read-back when `block_enabled` and the kernel is running).

### F2 - a dead controller blocks one read for N x 10 s (medium, CONFIRMED by trace)

- `ufshc.c:650-662`: the sleeping wait in `hc_complete` leaves only when `hc_done & bit` is set or its own 10 s (`TIMEOUT_MS`) have passed since its own `started`. It never looks at `hc_dead`.
- `hc_off()` (572-579) sets `hc_dead` and wakes only `&hc_free`, not the slots' waiters.
- `ufshc_read` (802-823) completes its queue strictly in order, and each `hc_complete` call gets a fresh `started`.
- Scenario: the device stops answering with 31 slots in flight (a read of 8 MB with the default 256 KB slot buffer). Slot 1 times out after 10 s, `hc_dead` is set, slot 2 then waits another 10 s, and so on: up to 310 s before `ufshc_read` returns ETIMEDOUT, so `ufs_read` (534-555) cannot even start its fallback through the loader (which is itself 20 s). The caller is a pager or vnode thread; the kernel heartbeat the loader watches is on other threads, but the I/O is stuck for minutes.
- Fix: end the wait for everyone once the path is off.

```
 			while ((hc_done & bit) == 0) {
 				(void)msleep(s, &hc_lock, PRIBIO, "ufshc-io", &second);
 				us = hc_us_since(started);
-				if ((hc_done & bit) == 0 && us > TIMEOUT_MS * 1000ULL) {
+				if ((hc_done & bit) == 0 && (hc_dead || us > TIMEOUT_MS * 1000ULL)) {
```

and in `hc_off()` after `hc_dead = true` take `hc_lock` and `wakeup(&hc_slots[i])` for the bits of `hc_waiting` (or loop `for i in 0..SLOTS`). The slot is not given back either way (as now).

### F3 - `bounce` allocated outside the lock (low, CONFIRMED)

- `ufs.c:452-460`: `static uint8_t *bounce; if (bounce == NULL) { bounce = kalloc_data(ufs_buffer_size, Z_WAITOK); ...}` runs before `lck_mtx_lock(&ufs_lock)` at 461.
- Two threads whose first request is an unaligned or partial-block read both see NULL and both allocate. One buffer (4 MB) is leaked. Worse, the later store changes the pointer while the other thread may already be between `ufs_request(..., bounce, ...)` (485) and `memcpy(dst, bounce + skip, take)` (487): it reads from the new, never-filled buffer and returns zeros or stale data with `error == 0`.
- Window: only the first unaligned read of the run, and only if two threads are there at once (a mount and `ufs_check`, say). `ufs_native_map` makes a read in `hakios_ufs_init` when `ufs_native=` is set, which fills `bounce` early on that path; without it nothing does.
- Fix: allocate under the lock.

```
-	if (bounce == NULL) {
-		bounce = kalloc_data(ufs_buffer_size, Z_WAITOK);
-		if (bounce == NULL) {
-			return ENOMEM;
-		}
-	}
 	lck_mtx_lock(&ufs_lock);
+	if (bounce == NULL) {
+		bounce = kalloc_data(ufs_buffer_size, Z_WAITOK);
+		if (bounce == NULL) {
+			lck_mtx_unlock(&ufs_lock);
+			return ENOMEM;
+		}
+	}
```

(or allocate it once in `hakios_ufs_init`).

### F4 - GPT header size from disk used as a length (low, CONFIRMED, debug boot-arg only)

- `ufs.c:1300-1307`, in `ufs_native_check` (only with `ufs_native_check=1`): `h = kalloc_data(4096)`, filled with block 1 of a unit; `got = crc32(0, h, *(uint32_t *)(h + 12));`. Offset 12 of a GPT header is `HeaderSize`, 4 bytes from the flash.
- Failure: a header with `HeaderSize` above 4096 (corrupt flash, or a unit whose block 1 is not a GPT but starts with "EFI PART" followed by junk) makes `crc32` read up to 4 GiB past a 4 KB heap object: a data abort in a bsd_init thread, or an info leak into the log line. The loader bounds the same field (`loader.c:1267`: `header_size < 92 || header_size > sizeof(header)`).
- Fix:

```
 			want = *(uint32_t *)(h + 16);
 			*(uint32_t *)(h + 16) = 0;
-			got = crc32(0, h, *(uint32_t *)(h + 12));
+			{
+				uint32_t hs = *(uint32_t *)(h + 12);
+				got = (hs >= 92 && hs <= 4096) ? crc32(0, h, hs) : ~want;
+			}
```

Also the same function leaks `h`, `ufs_cmp_x` and `ufs_cmp_y` on its early `no memory` return (1282-1285); test code only.

### F5 - sparse image: unchecked slot, wrapping header checks (low, CONFIRMED)

- `sparse.c:85-89`: `memcpy(&slot, sparse_table + blk * 4, ...); if (slot == 0) return NULL; return sparse_data + (uint64_t)(slot - 1) * sparse_block_size;`. `slot` is never compared with `sparse_present`, which init validated only as a count (251).
- Failure: a table entry above `sparse_present` (a truncated or hand-made image) makes `sparse_strategy` (134) `memcpy` from up to 4G x `sparse_block_size` beyond the image: either a data abort or other kernel memory returned to the reader of `/dev/rsp0`. This is the same data path the APFS mount takes.
- The header checks at 231 and 251-252 can also wrap: `off + sizeof(*hdr) > size` with `off` near 2^64 (boot-arg), and `off + hdr->sh_data_off + sparse_present * sparse_block_size` and `sparse_block_count * 4` with 64-bit values from the image. `sparse_strategy` (113) multiplies `sparse_block_count * sparse_block_size` unchecked as well.
- The image is built by `tools/apfs/mksparse.py` on the host, so this is robustness, not an attack surface; it turns a bad image into a panic instead of an error message.
- Fix:

```
 	slot = ...;
-	if (slot == 0) {
+	if (slot == 0 || slot > sparse_present) {
 		return NULL;
 	}
```

and in `hakios_sparse_init` replace the two range tests by a helper that checks each term with `x > size - y` style comparisons, plus `sparse_block_count > UINT64_MAX / sparse_block_size` and `UINT64_MAX / 4`.

### F6 - virtio-blk: a timed-out request is left on the queue (low, PLAUSIBLE, QEMU only)

- `virtio_blk.c:247-252`: after 10 s without an answer the function returns EIO and unlocks, but the descriptor chain and `avail->idx` stay published, `d->seen` is not advanced, and the caller is free to reuse or free `data`.
- Failure: if QEMU answers late it DMAs into the caller's old buffer (freed or reused), and the next `blk_read` finds `used->idx != seen` at once (243) and returns before its own data has arrived, with `status` possibly set by the old request. Needs a QEMU that stalls for 10 s.
- Fix: on timeout set `blk_ready = false` (the device is off from now on, like `ufs_dead`), or reset the device (`reg_write(d, VIRTIO_STATUS, 0)`) before returning.

### F7 - the loader writes `logdump` by default, identified by name (info, CONFIRMED)

- `loader.c:361`: `ws = bio->write_blocks(bio, bio->media->media_id, 0, len, out_buf);`, from `write_logs()` at the end of every run (also 560, 2276, 2293, 3296, 3341, 3351, 3427, 4125). No `ufs_write=1` is needed.
- The partition is found by name only (`find_log_partition`, 263-286: UTF-16 compare with `logdump`); no GUID, no LBA range, no size check, no check that the name is unique. Bounds come from UEFI's partition BlockIo (a write longer than the partition fails whole).
- This is documented (`docs/install.md:11`, `tools/provenance.allow:28`), but it is not "only darwin". If the promise is meant literally, say so in the README, or give `logdump` the same treatment as `block_is_darwin` (type and unique GUID, start and end LBA, size, `len <= bytes`).

### F8 - duplicate `ufs_write=` arguments (low, PLAUSIBLE)

- Loader: `loader.c:2869` uses `|=` over every occurrence of `ufs_write=1`. Kernel: `ufs.c:1535` `PE_parse_boot_argn("ufs_write", &check, ...) && check == 1`, which (as far as I know of XNU, source not here) takes the first occurrence.
- `ufs_write=1 ... ufs_write=0`: loader enables, kernel enables: writes are on although the last word said off. `ufs_write=0 ... ufs_write=1`: loader on, kernel off: no writes (safe). Both sides need to say yes, so this can only turn writes on when a first `=1` is present; a tool that appends `ufs_write=0` to switch writes off will not.
- Fix, loader: take only the first occurrence.

```
-		block_write_requested |= starts_with(c, "ufs_write=1") && (c == pi.cmdline || c[-1] == ' ') && ...
+		if (!write_seen && starts_with(c, "ufs_write=") && (c == pi.cmdline || c[-1] == ' ')) {
+			write_seen = 1;
+			block_write_requested = starts_with(c, "ufs_write=1") && (c[11] == 0 || c[11] == ' ');
+		}
```

### F9 - interrupts off for up to ~2 s when the doorbell does not clear (low, NEEDS-HARDWARE)

- `ufshc.c:1063-1066`: `lck_mtx_lock(&hc_lock); istate = ml_set_interrupts_enabled(FALSE); hc_put_back(&r);`. `hc_put_back` (887-927) spins with `yield` up to 1 s for the doorbell (893-896), up to 1 s again after UTRLCLR (899-901), and 5 ms for the run bit, all with interrupts off. `ufs_native_out` reaches it from the read-failure path (`ufs.c:552`) after the kernel's own 2 s sleeping wait (1060-1062).
- Failure: with a device that never answers, one core spends ~2 s with interrupts masked. Whether that is acceptable (scheduler or interrupt-latency checks in this kernel configuration, GIC, the loader's heartbeat) I cannot tell from the repository.
- Fix (only if the hang test shows trouble): spin with interrupts on until the first loop is over, mask them only for the writes of UTRLBA/UTRLRSR.

### F10 - the block size under a mounted device changes briefly (low, PLAUSIBLE)

- `ufs.c:746`: `DKIOCSETBLOCKSIZE` stores into the global `ufs_bsize[part]`, and `ufs_strategy` (704) computes `offset = buf_blkno(bp) * ufs_bsize[part]` with whatever it reads. The comment at 737-741 says `spec_open()` sets 512 and then back on each open.
- Failure: while a filesystem is mounted on `/dev/ufs_darwin` (blkno counted in 4096-byte blocks), any other open of the block node (a `dd`, `mount`, a second mount) runs `spec_open`'s 512-and-back; a strategy call in between reads 8x too early and returns that data with success.
- Only PLAUSIBLE: depends on what `spec_open` does in this XNU (not in the tree), and Apple's own `dkstrategy` has the same shape (per-minor `bdevBlockSize`). The window is two ioctls wide.
- Fix: keep the mounted block size apart from the transient one (remember the value set by a non-512 call and ignore a 512 set that is followed by a restore), or hold a lock around both in `ufs_ioctl` and `ufs_strategy` (which does not close the window by itself).

### F11 - range checks that wrap, and no partition bound in `ufs_read` (low, PLAUSIBLE)

- `ufs.c:1094`: `if (offset + len > ufs_part_bytes(part)) return EINVAL;` wraps for `offset` near 2^64. Only caller today is `hakios.mpss.c:3610` with offset 0 and a size from `ufs_part_bytes`, so not reachable now.
- `ufs_read` (534-555) does not check the range at all; its callers clamp (strategy 703-714, cread 799-807). `ufs_check` (970-978) and `ufs_bench` (1025-1029) do not: `ufs_check` reads `ufs_references[r].bytes` from any partition whose name matches, regardless of its size. Through the loader an out-of-range read is refused (`loader.c:2090-2091`, written without wrap: `count <= blocks - lba`), but the native path has no bound (`ufshc_read` knows no unit size, `ufs.c:505`), so a short partition would be hashed together with the one after it. Reads only; no write consequence.
- Fix: a single bound check in `ufs_read` itself:

```
 static int
 ufs_read(uint32_t part, uint64_t offset, uint8_t *dst, uint64_t len)
 {
+	uint64_t size = ufs_part_bytes(part);
+	if (offset > size || len > size - offset) {
+		return EINVAL;
+	}
```

and the same form at 1094.

### F12 - `block_count` replaced without the device-size check (low, CONFIRMED)

- `apfs_lib.c:1063` checks `nx->block_count * bs > nx->dev.size` for block 0's count (the multiplication itself can wrap for `block_count >= 2^48`), then `1107` sets `nx->block_count = le64(blk + 40)` from the chosen checkpoint superblock with no check. `nx_block` (373) then trusts it.
- Failure: a superblock that claims more blocks than the device holds lets `nx_block` ask the device for addresses past its end (the device refuses: `mem_read` in `hakios.image.c:40` returns EIO, `ufs_strategy` returns EINVAL), so a damaged volume gives I/O errors rather than a clean "container larger than device"; and a count of 0 or below 16 is accepted at that point. No memory-safety effect found; `nx_block_unlocked` (292) cannot underflow because `addr < block_count` is checked first.
- Fix: after 1107, repeat `block_count < 16 || block_count > UINT64_MAX / bs || (dev.size != 0 && block_count * bs > dev.size)` and fail with EIO; use `block_count > dev.size / bs` instead of the multiplication at 1063.

## The write guard: routes tried

Each of these was traced to the line that refuses it, or to the reason there is no path.

1. **Write to another partition through `/dev/rufs_NAME`**. `ufs_copen` (660-666) drops FWRITE only when `minor == ufs_write_part`; every other partition goes to `ufs_open` and is refused at 652 (EROFS). `ufs_cwrite` (830) and `ufs_write` (571) both refuse `part != ufs_write_part`. The loader refuses again at `loader.c:2103` (`part != block_write_part`).
2. **Write through the block nodes `/dev/ufs_NAME`**. `ufs_open` refuses FWRITE (652); `ufs_strategy` refuses a buffer without B_READ (698). `DKIOCISWRITABLE` says 0. The block `bdevsw` has no `d_dump`, `eno_dump`.
3. **mknod with a chosen minor** (root only; the devices are 0640 root:operator). Minor beyond the table or a whole-unit entry: `ufs_open` 649; `ufs_cwrite` 830 needs `part == ufs_write_part`, which init sets only to an entry with `BLOCK_PART_UNIT` clear (1550).
4. **Overflow in the range check**. `ufs_write` 576-581 checks `offset > ufs_part_bytes` first and then `len > ufs_part_bytes - offset`: no wrap; `offset / nbs < UFS_WRITE_FIRST` is exact; `ufs_part_bytes = blocks * block_size` is `5242875 * 4096` (init pins both, 1559-1561). Loader 2090-2091 is `lba < blocks && count <= blocks - lba`, written without wrap, and `count <= BLOCK_BUFFER_SIZE / block_size`. Write branch at 2103 adds `lba >= BLOCK_WRITE_FIRST`. The two constants agree: 2042368 (ufs.c:78, loader.c:1480), and the kernel also refuses a page whose `write_first` differs (1538).
5. **Negative or huge offsets and sizes from user space**. `ufs_cwrite` 839: negative `uio_offset` is EINVAL, then offset and resid must be multiples of 4096; the loop (846-861) moves at most `ufs_buffer_size` per round (`(int)want` cannot truncate), and `ufs_write` re-checks every chunk. `bytes = count * block_size` in `ufs_request` is at most `ufs_buffer_size` because `count <= per`.
6. **32/64-bit truncation**. `(uint32_t)minor(dev)` and the table index are 32-bit; `ufs_write_part` is an int set from `i < parts <= 160`. LBA, count, offset are `uint64_t` end to end (ask.lba/count are 64-bit). `ufs_crc32` takes `uint64_t`. `buf_setresid` casts are on 32-bit buf counts.
7. **Index confusion kernel/loader**. Both sides index the same `part[]` of the same page. The loader sets `block_write_part = block_shared.parts` before `block_shared.parts++` (loader.c:1927-1930), so it is the index of that entry; units are appended after the partitions (1936-1951), so no whole-unit entry can alias the writable index. The kernel accepts the offer only if `i == offered - 1` and the entry is named `darwin`, not a unit, on unit 0, LBA 25374720, 5242875 blocks of 4096 (1542-1563). The loader's own identity test (1822-1855) adds both GUIDs, end LBA, and `!read_only`.
8. **TOCTOU between check and write**. The loader copies `part/lba/count/op` into locals once (2084-2087) before any test and uses the locals. The kernel holds `ufs_lock` for the whole request and `ufs_write_mtx` for the whole write. The page is mapped only into the kernel. The one thing that can touch the data buffer meanwhile is `write_logs` (F1).
9. **Per-run state**. `block_write_requested` and `block_write_part` are reset at each run (2852-2853); the counters at 1973; `write_part_plus_one` is zero unless `block_is_darwin` passed in this run (1974-1977), and the page is zeroed at the start of `block_start` (1874).
10. **Other writers in the kernel files**. `virtio_blk.c`: request type is the constant `VIRTIO_BLK_T_IN` (77, 194); open refuses FWRITE (274); strategy refuses writes (300); the cdev write is `eno_rdwrt` (408). `sparse.c`: same (66, 104, 190-191). `hakios.image.c`: only memory, no device. The APFS file system: mounts read only always (`apfs_vfsops.c:1168` sets MNT_RDONLY, 1232 refuses a write upgrade with EROFS, 1279 opens with FREAD only), opens for write refused (`apfs_vnops.c:1106`).
11. **`apfs_check=7` and `=8`** (`hakios.apfs_check.c:1145-1330, 1360-1493`) open a node named by `apfs_dev=` with FWRITE and write blocks with `VNOP_STRATEGY` (1065). On `ufs_darwin` the open fails (652); on `rufs_darwin` the open succeeds (660) but it is a character node and a buffer sent to it never reaches `ufs_cwrite`: the char `cdevsw` has `d_strategy = eno_strat` (885), and `bdevsw[cmajor]` is by default `eno_strat` as well (assumed, XNU not here). Even if strategy did reach `ufs_strategy` it refuses at 698. Apfs_write.c adds its own refusals (`dev.write == NULL` for every mount, sealed/snapshot/system volumes, the three-deep bound at 99-103, 164-194). Cannot reach the flash by this route.
12. **The kernel's own UFS controller driver cannot write**. Commands are only made by `hc_make_read` (READ(10)) and `hc_make_tur` (329-361). `hc_refusal` (253-311) refuses data direction host-to-device and 3 (261), non-SCSI UPIUs (268), the W flag (271), well-known LUNs (278), LUNs outside the mask (281), and every SCSI operation not on the list (285-310), and checks that the CDB length equals the UPIU length (294). `hc_place` writes into a slot only a command that passes, reads the first 32 bytes and the descriptor back and checks again before the doorbell (481-515). `hc_whitelist_selftest` (367-456) runs 33 made-up commands first. The doorbell is rung only at 533, from `hc_ring`, and nothing else in the tree touches `0x1d84000` or `UTRLDBR` (grep). LBA is 32-bit with an explicit `first + blocks > 0xffffffff` refusal (765).
13. **The loader does not write the controller** except to take UEFI's list back (`hc_wr` at 1729-1752); `write_blocks` appears at two places only (361 logdump, 2123 darwin).
14. **Timeout and failure do not turn into a different write**. `ufs_dead` (350) makes every later request EIO; a late answer is ignored; the loader's write is self-verified by CRC of the read-back (2120-2134). A failure of `ufs_native_out` before a write (`ufs.c:601`, return ignored) only makes the loader refuse with ACCESS_DENIED at 2095-2101, because `hc_list_is_uefis()` is false, so the ignored return is harmless.
15. **Boot-arg**. Writes need `ufs=2` and `ufs_write=1` on the loader's command line, matching `ufs_write=1` in the kernel's, `ufs_shared_pa` from the loader, and all identity checks. The loader requires `ufs_write=1` followed by NUL or space (2869-2870) and the kernel requires value 1 exactly (1535), so `ufs_write=10` or `=1x` does not enable it on the loader side. Both sides must agree, so the stricter wins. A hand-written `ufs_shared_pa=` pointing at a forged page only fakes the kernel's half: the loader's guard (a separate copy of the check) is the one that matters and is not reachable that way. (Duplicate arguments: F8.)

## Checked and found fine

UFS host controller (`hakios.ufshc.c`):

- Slot accounting: `hc_free` is a bitmap under `hc_lock`; `hc_take` waits only when something may free a slot (`hc_in && !hc_dead`); `hc_give` is skipped only for a slot that timed out, which is then never used again (its DMA buffer is persistent kernel memory, never freed, so a late DMA cannot land in freed memory).
- Doorbell: rung with interrupts off, with the list checked (`UTRLBA`, `UTRLBAU`, run bit, slot free, `take_back == 0`, `hc_in`, not closed or dead) in the same critical section (527-537); `hc_write` brackets with `dsb sy`.
- Completion: the response is read after the doorbell bit clears and a `dsb`; checks OCS, response type, tag, response code and status (671-674); a TEST UNIT READY accepts CHECK CONDITION only in the proof.
- DMA: slot buffers from `kmem_alloc_contig` (page aligned), flushed (DC CIVAC) before the doorbell and again before the copy-out; PRD entry count bounded by `ucd_size` (1154-1157, with `PRD_MAX` 256 KB and the 4 MB buffer limit at 1145); descriptor and UCD alignments checked at probe.
- `ufshc_read`: `q[SLOTS]` is 32 entries and the inner loop is guarded by `tail - head < SLOTS`; `take <= blocks*BLOCK - skip`; the `memcpy` out of a slot is only done when `error == 0`; no uninitialised slot data is copied out on error paths.
- Poller thread: `hc_waiting`, `hc_done` and `hc_poller_asleep` only change under `hc_lock`; a lost wakeup is bounded by the 1 s `msleep` timeout; a timed-out waiter clears its own `hc_waiting` bit so a stale poller snapshot sets `hc_done` only for a slot that is never reused.
- Lock order: `ufs_write_mtx` -> `ufs_lock` -> `hc_lock`; the sysctl paths take `ufs_write_mtx` or `ufs_lock` alone; no path takes them the other way round. Nothing sleeps while holding a spin lock (there are none); the interrupt-off sections call no blocking function.
- Switch in/out: `ufshc_switch_in` refuses unless UEFI's list is the one in the controller, the doorbell is 0, the list runs and is ready, and the loader has not asked for it back (967-985); the undo path is `hc_put_back`; `ufshc_switch_out` sets `hc_in = false` first, so no new doorbell can follow.

UFS mailbox (`hakios.ufs.c`) and loader service:

- Request/answer protocol: the request fields are written, `dmb sy`, then `request`; the answer is read after `answered == seq` and another `dmb sy`; the loader's `answer` struct is one cache line and is cleaned only after `answered` is stored (2156-2159). `ufs_seq` starts at the page's `answered`. Request, answer and table are in different 128-byte aligned blocks (static assert at 139).
- Timeout: 20 s with a yield-then-sleep poll; sets `ufs_dead`, returns EIO; every later call returns EIO at once (307). The mutex is held for those 20 s, so other readers wait, then get EIO.
- Buffer bounds: `per = ufs_buffer_size / nbs`, `count <= per`, `take <= len`; `memcpy(ufs_buffer, src, bytes)` and the copy-out are bounded by `bytes <= ufs_buffer_size`. The loader guarantees `0 < block_size <= BLOCK_BUFFER_SIZE` (1883, 1906), so `per >= 1` and the chunk loops always advance.
- `ufs_strategy` (687-721): negative `blkno` becomes a huge unsigned offset and is refused as EINVAL; `offset + len` cannot wrap after `offset < size`; the residual is computed in 32 bits from a 32-bit count.
- `ufs_cread`: reads are chunked to the bounce size, clamped to the partition, copied out only after a successful read of exactly that many bytes (no uninitialised bytes leave).
- `ufs_cwrite`: nothing of the driver is held while user memory is touched; a failed chunk rewinds the uio (858-859) so the byte count is not claimed.
- Claim of the store: `kern.hakios.var_busy` is root-only (no CTLFLAG_ANYBODY), held under `ufs_write_mtx`, taken over only from a pid that `proc_find` cannot find; `var_save` handshake transitions are all validated (241-249).
- Native map (`ufs_native_map`): `n < BLOCK_MAX_UNITS`, `unit < 8` before `1u << unit`, block size 4096 and `EFI PART` required for each unit before it is accepted; `kfree_data` pairs match allocations.
- Boot-args in `hakios_ufs_init`: `ufs_shared_pa`, `ufs_write`, `ufs_native`, `ufs_native_check`, `ufs_native_bench`, `ufs_bench`, `ufs_check` are all read into `uint32_t` / `uint64_t`; `check` is reset before the `ufs_check` read (1640); the page is validated for magic, version, size and `parts <= 160` before use (1489-1494).

`hakios.image.c` and the APFS read path it uses:

- `mem_read` (40) is wrap-free (`off > length || len > length - off`).
- `apfs_file`: in-place path checks `addr <= length / block_size && fsize <= length - addr * block_size` (115-116), no wrap; the `kept[]` table has 64 entries and the full case is tested before the copy is made (122); the `kept[i].data` store is last; `nx`/`vol` are freed on every path (`out:`); a failed `apfs_nx_open` frees `nx` in the callee and the caller NULLs it. `fsize` is limited to 256 MB before any allocation (108). `apfs_nx_close` before `nx->block_size` is read at 119 is fine: `apfs_nx_close` does not clear `block_size` (1146-1174).
- `node_parse` / `node_entry` (522-613): the table of contents, key and value areas are each checked to lie inside the block with subtraction-form comparisons; `nkeys` is bounded by `bs / entry size`; root nodes reserve the btree_info; ghost values handled; `(uint16_t)` truncations of `key_size` and `val_size` shorten and cannot lengthen.
- `omap_find`, `seek_to`, `fext_seek`, `apfs_cursor_next`: tree depth bounded by `APFS_MAX_LEVELS` on every descent, so a cyclic tree ends in EIO; key and value lengths are checked before every read of fixed offsets.
- `apfs_nx_open`: block size must be a power of two within limits; descriptor area checked to lie inside the container; superblock chosen by checksum and xid.
- `apfs_readdir`, `apfs_xattr_list`: names are bounded by `sizeof(name)` (256) before the copy and the terminator is written at `name_len - 1 <= 255`.
- `xfields_find`: every field is checked against the record length with 32-bit arithmetic, `off` stays below `len <= 65535`.
- Extents: `apfs_read_stream` and `stream_plan`: `end = off + len` cannot wrap because `len <= stream_size - off`; `logical >= end` ends the loop before `logical + length` is formed; `phys`/`length` are checked against `block_count`; `stream_fetch` writes only inside `[0, covered)`; run `at + len <= covered`.
- Compressed files: the piece index is checked against `piece_count` with 64-bit arithmetic (3640), so a header `size` that truncates the 32-bit count only makes reads fail; every `memcpy` into the caller's buffer is bounded (`direct` requires `len - *out >= want`; read-ahead index bounded by `APFS_RA_PIECES`); the parallel helper (`apfs_vfsops.c:839-919`) runs every item even after an error, so the `j->error` fields the read-ahead looks at are always written; stored (0xFF) and raw pieces are clamped to `dst_len`.
- `apfs_write.c`: `blocks_are_free_ground` has no wrap (`count > block_count - start`); `apfs_write_in_place` checks `off > ino.size || len > ino.size - off`, refuses holes, compressed files, shared extents, and reads back every block.
- `apfs_store.c`: header, slot size and payload bounds are checked with subtraction-form comparisons; `head_unpack` bounds `bytes` by `payload_max`.

`hakios.guard.c` (speaker limiter): all 64-bit intermediates stay below 2^63 (largest: the high-pass filter terms, about 2^58); `2 * attenuation` can wrap in 32 bits but only toward a smaller attenuation, i.e. a more conservative limit; `amplitude()` stops once the value is 0; `isqrt`, `headroom` and `hakios_guard_decibels` have no division by zero or out-of-range table index (index is 4 bits, table has 17 entries); frames per block are at most 1024 against `work[2048]`. No findings.

## Not checked

- `tools/darwin-write.py`, `tools/userdata-carve.py`, `userland/src/var_store.c` (user-space side of the store: the kernel half is covered), the RAM disk (`md`) devices.
- XNU itself: `spec_open`, `spec_strategy`, `physio`, `PE_parse_boot_argn` and `PE_parse_boot_arg_str` (prefix and duplicate rules), `kalloc_data` limits for very large sizes, the `buf_*` layer. These are named as assumptions where they matter (F8, F10, route 11).
- Parts of `apfs_lib.c` not on the read path of the two files: names hashing (1755-1950, only skimmed), `scratch_*`, `batch_group` arithmetic beyond the bounds already quoted, `apfs_deflate`/`zbitmap` wrappers and libzbitmap itself (the 12-line `apfs_zbitmap.c` calls it; only the caller's `n > dst_len` check was read), and the rest of `apfs_vfsops.c`/`apfs_vnops.c`.
- Hardware facts: UFSHCI register semantics (UTRLCLR written with 0, completion notification register, PRD byte-count field width), UEFI UFSDxe behaviour on a hung device, and cache attribute mixing (the kernel maps the loader's page write-combining and the loader uses it cacheable with explicit cleans; this works by design here but I did not prove it for every field).
- Whether the kernel configuration masks or traps long interrupt-off sections (F9).
- Dynamic behaviour: nothing was run, no log read; F1, F3, F6 and F10 need a trace to move from PLAUSIBLE.
- The modem and cellular files (mpss, qmi, nas, ipa) are out of scope and were not read; `hakios.mpss.c:3592-3610` was looked at only as a caller of `hakios_ufs_read_partition`.

## Fix status

Each finding was re-read in the current tree first. Nothing was built or run; edits were re-read for syntax only. Kernel files are under `drivers/storage/`. The write guard (`ufs_write`, `ufs_cwrite`, `block_poll`'s write branch, the `ufs_write=` parse) was not touched.

- F1: FIXED. `xnuloader/loader.c`: the log read-back in `write_logs()` now goes into its own `log_verify` buffer (new, `sizeof(out_buf) + 8192`, with a `flush_dcache` after the read) instead of `block_buffer`, so it can no longer overwrite what the kernel is copying out of the mailbox buffer.
- F2: FIXED. `hakios.ufshc.c`: in `hc_complete`'s sleeping wait, once `hc_dead` is set a waiter does not sleep again: a slot whose doorbell bit is clear is taken as done, any other returns ETIMEDOUT at once (one message). `hc_off()` also wakes every slot's waiter. A dead path now costs one 10 s timeout for the whole read, not one per slot.
- F3: FIXED. `hakios.ufs.c` `ufs_read_mailbox`: `bounce` is allocated after `ufs_lock` is taken, with an unlock on the ENOMEM return.
- F4: FIXED. `hakios.ufs.c` `ufs_native_check`: `crc32` only runs for a header size of 92..4096, otherwise the CRC is reported WRONG. The early "no memory" return now frees `h`, `ufs_cmp_x` and `ufs_cmp_y`.
- F5: FIXED. `hakios.sparse.c`: `sparse_block()` treats a slot above `sparse_present` as absent; the header checks in `hakios_sparse_init` are rewritten with subtractions and divisions (`off`, `sh_data_off`, `sh_table_off`, `sparse_present`, `sparse_block_count`, plus a count x size overflow test) so none can wrap.
- F6: FIXED. `hakios.virtio_blk.c`: after the 10 s timeout `blk_ready` is cleared (the device is off from then on, like `ufs_dead`), and `blk_read` re-checks `blk_ready` under its lock so a request that waited for the lock does not start on the stale queue.
- F7: NOT A BUG / SKIPPED. Documented behaviour (`docs/install.md:11`, `tools/provenance.allow:28`); giving `logdump` a guard like darwin's is a design change in the loader's write path, not a mechanical fix.
- F8: SKIPPED. The only fix is in the loader's `ufs_write=` parse, which is the write guard's enable switch; the report itself cannot say what the kernel's `PE_parse_boot_argn` does with duplicates (XNU source not here). Both sides must agree, so the stricter wins as today.
- F9: SKIPPED. Needs hardware knowledge (how long the doorbell takes to clear, whether interrupts may stay off); the report itself says NEEDS-HARDWARE.
- F10: SKIPPED. Design change (keep the mounted block size apart from the transient one) and depends on what `spec_open` does in this XNU, which is not in the tree.
- F11: FIXED. `hakios.ufs.c`: `ufs_read()` now refuses a read that leaves its partition (`offset > size || len > size - offset`, EINVAL), and the check in `hakios_ufs_read_partition` is written without the wrapping sum. Reads only; `ufs_write` and its checks are unchanged.
- F12: SKIPPED. The code is in `apfs_lib.c`, which is not one of the files this pass may edit.

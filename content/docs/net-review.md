# HakiOS — network stack review

A read-level audit of the networking code: the `en0`/`en1` data paths, the links behind them,
and the Apple80211 control plane iOS talks to. The goal was to find real correctness bugs and to
map what is genuinely left to do. No build or device run was part of this pass (done on a Windows
host); every finding is from reading the source, with file and line references so each can be
checked.

## Scope

Reviewed in full:

| File | What it is |
|---|---|
| `xnu/files/bsd/sys/hakios.net.h` | the link ⇄ interface contract |
| `drivers/net/hakios.net.c` | `enN`: the Ethernet-looking interface on the kernel KPI |
| `drivers/net/hakios.virtio_net.c` | the QEMU virtio-net link behind `en0` |
| `drivers/modem/hakios.cell.c` | `en1`: the modem's IP packets as Ethernet (ARP/DHCP in kernel) |
| `drivers/modem/hakios.ipa.c` | the IPA/GSI data path (rings, endpoints, tables) |
| `drivers/wifi/hakios.apple80211.c` | the Apple80211 ioctl/event surface for `wifid` |
| `drivers/wifi/hakios.sta.c` | the station boundary (scan/join/leave serialization) |
| `wifi/lx/src/lx_80211.c` | the ath11k port's boundary: beacon parse, scan results, join |

Not reviewed line-by-line this pass: `hakios.wifi.c` (DSP/subsystem bring-up — the radio works
today), `hakios.mpss.c` and `hakios.qmi.c` (the modem; the in-progress cellular registration lives
here — see the roadmap below), and the non-network virtio devices.

## Bottom line

**The core data paths are correct and defensively written. No confident, reachable correctness bug
was found in the reviewed code.** Bounds are checked at the trust boundaries (user space via
`copyin`/`copyout`, and over-the-air beacon data), ring invariants are maintained correctly, and
the cache is synchronised around every DMA buffer. The items below are latent portability concerns
and optional hardening — not live bugs on the POCO X5 Pro.

## What was verified correct (not just "looks fine")

- **virtio-net rings** (`hakios.virtio_net.c`): the split-queue handling is right. The receive
  queue is primed with all 64 buffers and `avail->idx` seeded to `QUEUE_SIZE` (`queue_make`,
  line 155); reclaim/refill use `% QUEUE_SIZE` masking with proper `dmb ish` barriers around the
  `avail->idx` publish (lines 188–192, 213–215). Transmit reclaims completed buffers before
  grabbing a free one and drops cleanly when full (lines 174–180).

- **IPA GSI receive invariant** (`hakios.ipa.c`): the "at most `slots-1` outstanding" rule is held
  end to end. Priming posts `slots-1` buffers (line 859), and `receive_event` consumes the buffer
  at `done % slots`, then posts the *previously free* buffer at `next % slots` (lines 655–695) — so
  the just-read buffer becomes the new free slot and is never re-posted while still being read. The
  off-by-one fixed in commit `03a098b` is correctly in place.

- **QMAP de-framing** (`hakios.ipa.c` `receive_event`, lines 671–689): every field is bounded —
  `at + 4 <= length`, `at + 4 + packet > length` break, and `pad > packet` reject — before handing
  `packet - pad` bytes up. No over-read.

- **In-kernel ARP/DHCP** (`hakios.cell.c`): the DHCP reply builder stays inside its buffer. Worst
  case option set is ~42 bytes from `bootp+240`; the 300-byte pad floor keeps the frame ≤ the
  346-byte `reply[]` (lines 142–221). The request parser bounds `ihl` and the options loop against
  the frame end (lines 126–162).

- **Apple80211 user boundary** (`hakios.apple80211.c`): `give()` always clamps `copyout` to
  `req_len` (line 239); `set_join`/`set_scan` validate `ssid_length` and `key_length` against the
  destination before `memcpy` (lines 477, 534, 543–549). Join buffers are wiped with `memset_s`
  before free (lines 560–565) so passphrases don't linger.

- **Beacon parse** (`wifi/lx/src/lx_80211.c`): `element()` (line 525) walks TLVs with both
  `at + 2 <= length` and `at + 2 + elements[at+1] <= length` guards. The SSID copy clamps to the
  32-byte field (`name[1] <= sizeof(network->name)`, line 608) and the elements copy is gated on
  `length - 36 <= ELEMENTS_MOST` (lines 597, 567). The single caller guards `skb->len >= 36` before
  calling `heard()` (line 908), so the `length - 36` subtraction cannot underflow in practice.

## Latent concerns (ranked) — not live bugs on the current phone

### 1. IPA event-ring write pointer is read as 32-bit only

`hakios.ipa.c`, `channel_events` (line 478):

```c
uint32_t wp = gsi_rd(EV_CNTXT(ch->ring_id, 4)), base = (uint32_t)ch->event_ring.phys, ...
if (wp < base || wp >= base + ch->slots * ELEMENT_SIZE) { ... return 0; }
```

Both the hardware write pointer and the ring base are truncated to 32 bits. This is correct as long
as the event ring's physical address — and the whole ring — sit in the low 4 GB, or at least do not
straddle a 4 GB boundary. On the POCO X5 Pro the data path comes up, so today this holds. On a
future port whose DDR layout places a GSI event ring above 4 GB, the comparison and the index math
break silently (the "write pointer outside the ring" path, line 482).

- **Risk:** medium for porting, none for the current device.
- **Recommendation:** when porting to a new SoC, also read the high word (`EV_CNTXT(ring, 5)`) and
  compare as 64-bit. **Do not change this blind on the working phone** — verify that reg 5 carries
  the write-pointer high word on the target GSI revision first, because a wrong assumption here
  would break a path that currently works. Flagged as a porting checklist item, not a patch.

### 2. Defense-in-depth at the `bss` → user boundary

`hakios.apple80211.c` `give_network` (lines 265–266) copies `bss->ssid_length` into the 32-byte
`result->ssid` without a local clamp. It is safe **only because** the producer guarantees
`ssid_length ≤ 32` (`lx_80211.c:608`, and `want_length` via the `:1586` check). That's a real
invariant today, but it lives in a different module (the ath11k port). A one-line clamp
(`min(ssid_length, sizeof result->ssid)`) at the consumer would make the kernel robust to a future
change in the port without relying on it. Same reasoning for `heard()` not trusting its caller's
`>= 36` guard.

- **Risk:** none today; cheap insurance against future refactors.
- **Recommendation:** optional hardening; apply with a build + a scan test.

### 3. IPv6 asymmetry on `en1` is by design, worth a note

`hakios.cell.c`: inbound IPv6 is wrapped and passed up (`cell_receive`, version 6 accepted,
line 267), but outbound IPv6 is dropped (`cell_transmit`, counted as `not_ip4`, line 253). The
data session is IPv4-only, so this is intentional; just confirming it's not an oversight. If an
IPv6 PDP type is ever enabled, the transmit side needs the matching branch.

## The real remaining work: cellular registration & data session

This is the part the README marks "in progress," and it is **not** in the reviewed files — it's in
`hakios.mpss.c` / `hakios.qmi.c` (QMI DPM/WDA/WDS, NAS). The data *plumbing* below it (`en1`, the
IPA path, ARP/DHCP) is in place and reviewed-correct; what's left is the modem-side handshake that
brings the session up so `hakios_cell_session(up=true, ...)` gets called with a real address.

From the git history the current frontier is: DPM Open Port → WDA Set Data Format → WDS Bind Mux →
Set IP Family → Start Network Interface, with registration gating the start (commits `82e0292`,
`3b146ba`, `150d30f`). Advancing this needs **a live run log from the phone**, not source reading —
the failures are QMI error codes and timing, visible only at runtime:

```sh
XL_SB_DELAY=8 XL_SECS=600 \
XL_CMDLINE="... modem=1 modem_ipa_data_trace=1 net_trace=20 net_names=1" \
./xl run
```

Send `logs/` from such a run and the cellular path can be debugged against the actual QMI exchange.

## How to proceed

1. The reviewed data paths are solid — no fixes needed to ship them.
2. The two optional hardening items (§2) are safe one-liners; say the word and they go in as a
   small, clearly-scoped patch for you to build and test.
3. The 32-bit event-pointer item (§1) is a porting note, deliberately not a blind patch.
4. Cellular registration is the open frontier and is log-driven — a phone run log unblocks it.

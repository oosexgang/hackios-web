# Wi-Fi stack above the bring-up: security and robustness review

Read-only audit. Nothing was built, run or modified except this file.

## Scope

| File | Lines |
|---|---|
| `wifi/lx/src/lx_wpa.c` (WPA2-PSK arithmetic, 4-way and group handshake) | 523 |
| `wifi/lx/src/lx_wpa.h` | 49 |
| `wifi/lx/src/lx_80211.c` (frames, scan, join, 802.11 <-> Ethernet) | 2097 |
| `wifi/lx/src/lx_base.c` (LinuxKPI stand-ins: threads, work, memory, DMA pool) | 1235 |
| `wifi/lx/src/lx_bus.c` (bus, ring service thread, IRQ glue, driver start/stop) | 863 |
| `wifi/lx/src/lx.h` | 20 |
| `drivers/wifi/hakios.lx.c` (kernel side of the driver object) | 582 |
| `drivers/wifi/hakios.wlfw.c` (WLFW client; also read the codec in `hakios.qmi.c` 197-575 and the rx/txn code 617-963, only as far as WLFW uses it) | 545 |
| `drivers/wifi/hakios.sta.c` | 371 |
| `drivers/wifi/hakios.apple80211.c` | 739 |

Also read for evidence: `tools/wpa-test/test_wpa.c`, `xnu/files/bsd/sys/hakios.sta.h`, `hakios_wifi_network()` in `hakios.wifi.c`, the boot seed in `xnuloader/loader.c` 3050-3080, `xnu/files/osfmk/minicrypto/mc_provider.c` (PRNG part).

Method: full read of every file above, tracing every length that comes from the air, firmware or userland to its use, checking `lx_wpa.c` line by line against IEEE 802.11-2020 clause 12.7 (key hierarchy, EAPOL-Key layout, supplicant rules), RFC 8018 (PBKDF2), RFC 2104 and RFC 3394. The ath11k driver sources are not in this tree (`xnu-deps/build/ath11k` is absent), so driver and firmware behaviour is inferred from comments only. The test program in `tools/wpa-test` was read but not run (no C compiler on this host).

Notes on the previous review (`docs/net-review.md`): beacon parsing in `heard()` and the SSID/element copies in `apple80211.c` were not redone; I only re-confirmed in passing that `element()` and the copies are bounded.

## Findings

| Id | Severity | Confidence | Where | One line |
|---|---|---|---|---|
| W1 | Medium | CONFIRMED | lx_wpa.c:472-477, 369-384; lx_80211.c:1809-1812 | An unauthenticated message 1 re-derives and overwrites the live KCK/KEK/TK, at any time, from any spoofed sender |
| W2 | Medium | CONFIRMED | lx_80211.c:807-813, 1795-1808 | Handshake result is last-writer-wins: one forged EAPOL frame aborts the join or hides a good message 3 |
| W3 | High if reachable | NEEDS-HARDWARE (code gap CONFIRMED) | lx_80211.c:752-777, 817-826, 913 | 802.11-format data frames reach the IP stack without any "protected / decrypted" check (mac80211's drop-unencrypted rule is missing) |
| W4 | Medium | CONFIRMED (absence in this layer) | lx_80211.c:16-18; lx_wpa.c:429; lx_wpa.h:31 | No packet-number (replay) check for group-addressed frames; the RSC from message 3 is stored and never used |
| W5 | Medium | PLAUSIBLE | lx_base.c:794-834, 759 | DMA ring pool is never freed; every peer or BA session consumes it for good, and the pool is a fixed 12 MB |
| W6 | Low-Medium | PLAUSIBLE | xnuloader/loader.c:3053-3057 -> lx_80211.c:1660 | The supplicant nonce comes from a CSPRNG whose boot seed is a function of the timer counter |
| W7 | Low | CONFIRMED | lx_wpa.c:415-434, 480-515 | Message 3 is not checked for RSNE match, Install/Secure bits, or GTK length/index |
| W8 | Low | CONFIRMED | lx_80211.c:1603, 1626-1628, 565-576 | A requested BSSID is ignored on the scan path, and the chosen target can be replaced by a stronger same-SSID beacon during the join |
| W9 | Low | PLAUSIBLE | lx_80211.c:1474-1503, 850, 872, 804-806 | Teardown races: rx path can queue work or use `radio->sta`/`radio->wpa` while `station_leave()` frees or wipes them |
| W10 | Low | CONFIRMED | lx_80211.c:1417-1428, 1380-1401 | Group rekey: a failed `set_key` is only logged and the old key is dropped anyway |
| W11 | Low | PLAUSIBLE | lx_base.c:342-357, 278-279; lx_bus.c:410-414 | `timer_delete_sync` does not wait for a running callback; `irq_group` can loop without bound under load |
| W12 | Info | CONFIRMED | lx_80211.c:669-672; lx_wpa.c:259-288 | The user's own AP BSSID is logged although the name is hidden; AES intermediates and failed-unwrap plaintext are not wiped |

Counts: 7 CONFIRMED (W1, W2, W4, W7, W8, W10, W12), 4 PLAUSIBLE (W5, W6, W9, W11), 1 NEEDS-HARDWARE (W3). The WPA2 arithmetic itself (PBKDF2, PRF, MIC, key unwrap, replay rule, nonce check) found no defect; see the section "Checked and found fine".

## Details

### W1 - an unsigned message 1 overwrites the live keys (Medium, CONFIRMED)

`lx_wpa.c:472-477`:

```c
if ((info & (INFO_PAIRWISE | INFO_ACK | INFO_MIC)) == (INFO_PAIRWISE | INFO_ACK)) {
	memcpy(wpa->peer_nonce, message + AT_NONCE, 32);
	derive(wpa);
```

`derive()` (369-384) writes `wpa->kck`, `wpa->kek`, `wpa->pairwise` and sets `have_keys`. There is no state check: the branch runs in any state, including after message 3 was accepted and after `joined`. The only filter is in `handshake_message()` (lx_80211.c:789): `radio->sta != NULL` and Ethernet source == the AP's BSSID, both of which an attacker in range can satisfy with a plaintext frame (EAPOL frames are plaintext by design; no MIC protects message 1).

Failure scenarios:

1. Window during join. After message 3 is accepted, `station_join()` waits (handshake loop) and then `lx_pause_ms(30)` (line 1809) before `key_set(radio, radio->wpa.pairwise, ...)` (1810). A forged message 1 arriving in that window replaces `wpa.pairwise` with a key derived from the attacker's ANonce. The firmware gets a wrong TK; the AP's frames cannot be deciphered and ours are rejected; the join reports success ("THE NETWORK IS JOINED"), the link is dead.
2. After join. A forged message 1 replaces KCK/KEK. Every later genuine group-key message (message 1 of the group handshake) then fails the MIC (`lx_wpa_message` returns `LX_WPA_BAD`), so the group key is never updated; once the AP rotates its GTK, broadcast and multicast traffic (ARP requests for our address, IPv6 RA/NS) stops reaching us. A retransmitted genuine message 3 also fails ("nonce is not message 1's").
3. Amplification: each forged message 1 costs one PRF (3 HMAC-SHA1) plus a transmitted 121-byte message 2, and one unconditional `printf` (lx_80211.c:800).

Standard: IEEE 802.11-2020 12.7.6 treats message 1 as unauthenticated; the supplicant is expected to tolerate extra or forged message 1 frames without changing the keys in use until a message 3 passes MIC verification (the usual solution is a candidate PTK). I could not quote the exact sentence offline, so the rule is marked as my reading of 12.7.6.2-12.7.6.4.

Suggested fix (candidate keys, promoted by a valid message 3):

```diff
 struct lx_wpa {
+	unsigned char cand_kck[16], cand_kek[16], cand_tk[16];  /* from the latest message 1, not yet proven */
 	unsigned char kck[16], kek[16];
@@ derive():
-	memcpy(wpa->kck, keys, 16);
-	memcpy(wpa->kek, keys + 16, 16);
-	memcpy(wpa->pairwise, keys + 32, 16);
-	wpa->have_keys = 1;
+	memcpy(wpa->cand_kck, keys, 16);  memcpy(wpa->cand_kek, keys + 16, 16);  memcpy(wpa->cand_tk, keys + 32, 16);
+	wpa->have_cand = 1;
@@ lx_wpa_message(), signed path:
+	/* message 3 (pairwise bit): verify with cand_kck; every other signed message with kck */
+	kck = (info & INFO_PAIRWISE) ? wpa->cand_kck : wpa->kck;   /* mic_of takes the key as a parameter */
+	... after MIC, nonce, replay, unwrap and GTK all pass, for a pairwise message:
+	memcpy(wpa->kck, wpa->cand_kck, 16); memcpy(wpa->kek, wpa->cand_kek, 16); memcpy(wpa->pairwise, wpa->cand_tk, 16);
+	wpa->have_keys = 1;
```

The unwrap in a pairwise message also has to use `cand_kek`. Message 2 is answered with `cand_kck` as it is now.

### W2 - the handshake outcome is overwritten by whatever came last (Medium, CONFIRMED)

`handshake_message()` stores every non-`NOTHING` result: lines 807-813 (`radio->handshake = said;`). `station_join()` waits with `while (radio->handshake != LX_WPA_KEYS && radio->handshake != LX_WPA_BAD && ...)` (1795-1797), then requires `radio->handshake == LX_WPA_KEYS` (1800).

Two failures, both from a spoofed plaintext EAPOL frame:

1. Any forged signed-looking key frame with `MIC|ACK` set and a bad MIC (or no message 1 seen yet) makes `lx_wpa_message` return `LX_WPA_BAD` (lx_wpa.c:484, 493). The loop exits at once and the join fails with `EAUTH`, which iOS shows as "wrong password" (`apple80211.c:639` maps `EAUTH` to result 21, "invalid PMK").
2. A genuine message 3 sets `handshake = KEYS`; a forged message 1 right behind it sets `ANSWER` before the join thread has run. The loop then keeps waiting and times out after 8 s, although the handshake succeeded and message 4 was sent.

Fix: make KEYS sticky, and do not end the wait on BAD (the standard says to silently discard bad frames):

```diff
-	if (said != LX_WPA_NOTHING) {
+	if (said == LX_WPA_KEYS || (said != LX_WPA_NOTHING && said != LX_WPA_BAD && radio->handshake != LX_WPA_KEYS)) {
 		...radio->handshake = said;
@@ station_join():
-	while (radio->handshake != LX_WPA_KEYS && radio->handshake != LX_WPA_BAD && radio->answer != ANSWER_GONE && ...
+	while (radio->handshake != LX_WPA_KEYS && radio->answer != ANSWER_GONE && ...
```

Keep a separate `radio->handshake_bad` counter and `handshake_why` for the log line.

### W3 - no "was it protected" check on the 802.11 data path (NEEDS-HARDWARE; code gap CONFIRMED)

`linuxkpi_ieee80211_rx()` (lx_80211.c:913) sends any 802.11 data frame through `to_ethernet()` and `ethernet_received()`. `to_ethernet()` reads the Protected bit (0x4000) only to size the header (line 767); it never requires it. `ethernet_received()` (817-826) hands every non-EAPOL frame to `lx_os_net_input()` when `radio->joined`. `RX_FLAG_DECRYPTED` is not looked at anywhere in the tree (grep), and the module header lists the missing group-frame PN check (see W4) but not this.

Under Linux, mac80211 supplies the rule (drop unencrypted data frames once a key is installed, except EAPOL). This layer replaces mac80211, so the rule has to be here. Failure scenario if the firmware passes a frame up in 802.11 form without having deciphered it: an attacker in range sends a From-DS data frame (TA = BSSID, RA = our MAC, Protected = 0, LLC/SNAP + ARP or IP) after the join; it is accepted and enters the IP stack (ARP poisoning, forged DNS or TCP). The RX_FLAG_8023 path (firmware decapsulates and deciphers) is not affected. Whether the ath11k firmware drops such frames itself I cannot tell from this tree; hence NEEDS-HARDWARE. A test: with a second radio, inject the frame after the join and watch `received` in the `lx_station_say()` line.

Suggested fix:

```diff
-static bool to_ethernet(struct sk_buff *skb, bool cipher_header_gone)
+static bool to_ethernet(struct sk_buff *skb, bool cipher_header_gone, bool *protected)
 ...
+	*protected = (control & 0x4000) != 0;
@@ linuxkpi_ieee80211_rx():
-	} else if (to_ethernet(skb, (status->flag & RX_FLAG_IV_STRIPPED) != 0)) {
-		ethernet_received(radio, skb);
+	} else if (to_ethernet(skb, (status->flag & RX_FLAG_IV_STRIPPED) != 0, &prot)) {
+		ethernet_received(radio, skb, prot && (status->flag & (RX_FLAG_DECRYPTED | RX_FLAG_IV_STRIPPED)));
@@ ethernet_received(radio, skb, bool ciphered):
-	} else if (radio->joined && skb->len >= 14) {
+	} else if (radio->joined && (ciphered || hardware_decap) && skb->len >= 14) {
```

(`hardware_decap` is true on the RX_FLAG_8023 call.)

### W4 - no replay check for group-addressed frames (Medium, CONFIRMED absence)

The module header (lx_80211.c:16-18) says "the check of the packet numbers of the group's frames that the driver leaves to this layer" is not done. `lx_wpa.c:429` stores the RSC from message 3 / group messages into `wpa->group_counter`; nothing reads it (grep: only lx_wpa.c:429 and lx_wpa.h:31). Unicast PN checking is in the firmware; for broadcast and multicast, ath11k's own comment says mac80211 does it.

Failure: an attacker records a genuine broadcast or multicast frame (ARP request, DHCP, mDNS, IPv6 router advertisement) and replays it later; it is accepted. A replayed RA with a short lifetime or an old prefix, or a replayed ARP, is enough to disturb the host. Standard: IEEE 802.11-2020 12.5.3.4.4 (CCMP decapsulation: discard an MPDU whose PN is not greater than the replay counter of the key/TID); the initial counter comes from the RSC in the key message (12.7.6.4). The clause number is from memory, hence the rule is PLAUSIBLE; the absence of any check is CONFIRMED. Whether the firmware performs a group PN check on its own is NEEDS-HARDWARE.

Fix: in the RX_FLAG_8023 path the PN is not visible, so either enable the firmware's group replay detection (driver option) or have the driver pass `status->extiv` for group frames and compare it with a per-key counter seeded from `wpa.group_counter` (reset on every group-key install):

```diff
+	if (is_multicast_ether_addr(da) && !pn_greater(status->extiv, radio->group_pn)) drop();
+	memcpy(radio->group_pn, status->extiv, 6) ... (little-endian PN, 6 bytes)
```

### W5 - the ring pool is never given back (Medium, PLAUSIBLE)

`linux_dma_alloc_coherent()` (lx_base.c:794-812) advances `pool.rings_used`; `kmem_free()` (814-818) and `dma_free_noncoherent()` (831-834) are empty. The pool is `POOL_RINGS` = 12 MB, of which the author notes the data path uses "about 6 MB" (759). The comment at 820-824 states that the data path takes a few KB per traffic class of every station and that "here they stay taken". `station_join()` creates a new station each attempt (lx_80211.c:1702-1708; a failed attempt included), `ba_handle()` restarts an RX BA session on every ADDBA from the AP.

Failure: each (re)join, each failed join, and each ADDBA (with `wifi_ba=1`) permanently consumes pool space. A phone that re-joins often (spoofed deauth frames are accepted because PMF is not implemented, so an attacker can force a re-join as often as wifid retries) eventually reaches "no room for N more bytes of rings" (line 804): the driver cannot create peers and Wi-Fi stays down until reboot. The leak is certain from the code; the per-join size (about 17 TIDs x 1 KB if ath11k sets up every TID) and thus the number of joins to exhaustion (a few hundred) is my estimate, and which ath11k allocations go through these two functions I cannot see.

Fix: replace the bump allocator with a free list of 64-byte-aligned extents (or a bitmap of 4 KB pages) and implement `kmem_free()` / `dma_free_noncoherent()`; also rate-limit RX_START per TID in `ba_handle()`.

### W6 - the supplicant nonce depends on a weak boot seed (Low-Medium, PLAUSIBLE)

Source of the SNonce: `get_random_bytes(radio->wpa.own_nonce, 32)` (lx_80211.c:1660) -> `arc4random_buf()` (lx_base.c:1206) -> `read_random()` (hakios.lx.c:205) -> the minicrypto HMAC-DRBG (`mc_provider.c`, seeded from the device-tree `random-seed`). That seed is built in the loader (`xnuloader/loader.c:3053-3057`):

```c
seed[i] = (uint8_t)(READ_SYSREG(CNTVCT_EL0) >> (i & 7)) ^ (uint8_t)(i * 37);
```

All 64 bytes are a function of a few consecutive reads of the virtual counter, so the entropy is that of the counter value at that moment, roughly 25-30 bits if the boot time is known to a few seconds (19.2 MHz counter assumed). Unless the kernel's entropy collector reseeds the DRBG with real entropy before the first join (`mc_prng_refresh`, not verifiable from here), the nonce, and everything else the kernel draws from `read_random`, is predictable by enumeration.

Impact on WPA2 itself is limited: the SNonce is sent in the clear in message 2, and the standard needs it to be unique, not secret (IEEE 802.11-2020 12.7.5: nonces to be random with negligible chance of repeating; the section number is from memory). A repeated SNonce combined with a repeated ANonce would repeat the PTK; the AP's ANonce is random. The finding is therefore mainly about the shared kernel PRNG; it is listed here because the task asked where the nonce comes from.

Fix: seed from several independent sources (CNTVCT jitter over many samples, the SoC's TRNG/PRNG registers, the DT `rng-seed` from the previous boot, UFS/timing jitter) and block the first `read_random` consumer until a reseed has happened.

### W7 - message 3 is not fully validated (Low, CONFIRMED)

`lx_wpa.c:480-515` accepts a message 3 on MIC, replay counter, ANonce match, Encrypted bit and a parseable GTK KDE. Not checked: (a) the RSNE in the key data against the RSNE the AP announced (the standard asks for this and for a deauthentication with reason 17 on mismatch; IEEE 802.11-2020 12.7.6.4, clause number PLAUSIBLE), so there is no downgrade protection for anybody holding the PSK; (b) Install and Secure bits; (c) GTK KDE: `e[1] - 6` may be anything from 5 to 32 (line 425-427) and the key id `e[6] & 3` may be 0, while `key_set()` always copies 16 bytes (lx_80211.c:1396) and installs with that index. `protection()` only accepts CCMP, so the right length is 16 and the right index 1-3.

Failure: an AP (or a PSK holder) can make the station install a GTK that is shorter than 16 bytes (the rest is stale `wpa->group` content, zero at join) or with index 0; this breaks group traffic rather than leaking anything.

Fix:

```diff
-	e[1] - 6u <= sizeof(wpa->group)) {
+	e[1] - 6u == 16 && (e[6] & 3) != 0) {
```

and in `lx_wpa_message()` for a pairwise message: `if (!(info & INFO_INSTALL) || !(info & INFO_SECURE)) -> BAD`, plus compare the RSNE found in `data` with the RSNE of the beacon (pass the target's element 48 to `lx_wpa_message`).

### W8 - requested BSSID ignored on the scan path; target replaced during join (Low, CONFIRMED)

`station_join()` honours `what->bssid` only when choosing from the already-heard list (lx_80211.c:1612-1613). If nothing matches, `station_scan()` is called up to three times (1626-1628) and `heard()` (565-576) fills `radio->target` with the strongest beacon of that name, with no BSSID filter. So an ASSOCIATE for a given access point (Apple80211 `bssid`, copied at apple80211.c:540) joins a different one.

`heard()` keeps overwriting `radio->target` as long as `radio->sta == NULL` (567), i.e. through the whole of the join up to line 1702, including the PMK derivation (1651-1665) and the channel set-up. A stronger beacon with the same SSID replaces address, capability and elements; `vif->bss_conf.bssid` is a pointer to `radio->target.address` (1668), so it changes under the driver. Also `bzero(target, ...)` at 1603 is done without `lx_os_lock()` while `heard()` writes it under the lock.

Fix: store `what->bssid` in `radio->want_bssid` and have `heard()` test it; stop `heard()` from updating `target` once `joining` is set (do the selection once, under the lock); copy the address into `vif->cfg.ap_addr`-backed storage instead of pointing at `target`.

### W9 - teardown races (Low, PLAUSIBLE)

`station_leave()` cancels `group_work` and `ba_work` (1474-1475) and later frees `radio->sta_memory` (1502) and wipes `radio->wpa` (1480), but rx runs on another thread. In between, `management_received()` still passes its guards (`radio->sta != NULL`, `radio->reached >= ASSOC`, line 850; `reached` is reset only at 1504) and calls `queue_work(radio->work, &radio->ba_work)` (872); `ba_handle()` captures `params.sta = radio->sta` (1107) before testing it (1122) and calls `ampdu_action` on a station that the driver has already removed or that is freed. Likewise `handshake_message()` can call `ethernet_send()` (798) which passes `radio->sta` to the driver while it is freed, and queue `group_work` after `joined` was cleared by someone else, in which case `group_rekey()` (1425) installs `radio->wpa.group` after it was zeroed (an all-zero GTK). The window is the duration of the `station_state` steps (tens of ms); `wifi_ba=1` is needed for the first case.

Fix: take `lx_os_lock()` around `radio->sta`/`reached` tests in the rx path and set a `radio->leaving` flag first in `station_leave()`; cancel the works after the flag is set; make `ba_handle()` read `radio->sta` once under the lock.

### W10 - a failed group-key install is only logged (Low, CONFIRMED)

`group_rekey()` (1417-1428): `radio->group_key = key_set(..., &error)`, then `key_drop(radio, &old, false)` whatever `error` is. `key_set()` returns the config even when `set_key` failed, or NULL on ENOMEM. After a failure the old key is removed from the firmware and the new one is not installed: group traffic is lost, `rekeys` is still incremented, only a `lx_tell` line says so. Also the replay counter was already advanced for this message, so the AP's retransmission is rejected.

Fix: drop the old key only if `error == 0`; on failure free the new config, keep the old key, and return the failure to the handshake so that the group message 2 is not sent (the AP will retransmit).

### W11 - timers and the IRQ thread (Low, PLAUSIBLE)

- `timer_delete_sync()` (lx_base.c:343-357) returns without waiting for a callback that the ticker thread is running (`due->function_415(due)` is called after unlocking, lines 278-279); the comment at 342 says so. If the driver frees the structure that contains the timer right after, the callback runs on freed memory. Fix: record `running` under the lock and wait for it in `timer_delete_sync()`.
- `irq_group()` (lx_bus.c:410-414) loops `do { ... } while (done >= DATA_BUDGET)` while holding `bus.service`, on the one thread that serves every vector. Sustained receive load keeps copy-engine interrupts (WMI, handshake) and the ring thread waiting. Fix: bound the loop (for example 4 rounds) and re-arm the vector so the thread yields.

### W12 - minor (Info, CONFIRMED)

- `say_heard()` (lx_80211.c:669-672) hides the name of "the network that is wanted" but prints its BSSID, channel and signal; the file header (24) and the code comment at 666 promise only that the name and passphrase are not said. A BSSID is a location identifier.
- Not wiped: `t[16]` in `aes_decrypt()` (lx_wpa.c:260-286, holds the last decrypted block, that is part of the GTK) and `a[8]` in `aes_unwrap()`; in `lx_wpa_message()` the `data[]` buffer is wiped on success and on "no group key" but not when `aes_unwrap()` fails (line 503-505). Kernel stack residue only.

## Checked and found fine

Cryptography in `lx_wpa.c`:

- PBKDF2-HMAC-SHA1 (RFC 8018 5.2 with SHA-1, 4096 iterations, 32-byte output = block 1 whole plus 12 bytes of block 2): salt is SSID || INT(block) with a big-endian 32-bit block number (149-154), `U_1 = HMAC(P, S || INT(i))`, `U_j = HMAC(P, U_{j-1})`, XOR-accumulated, 4095 further rounds (156-164). HMAC handles keys over 64 bytes by hashing. Matches the structure used by IEEE 802.11-2020 Annex J.4. `tools/wpa-test` checks the J.4.2 vectors and RFC 2202 (read, not run).
- PRF (171-185): label || 0x00 || data || counter byte, counter from 0, 20 bytes per round, 48 bytes for CCMP (KCK 16, KEK 16, TK 16); matches 12.7.1.2 / 12.7.1.3. PTK data (369-378): min(AA,SPA) || max(AA,SPA) || min(ANonce,SNonce) || max(...), 76 bytes with exact offsets. Roles: `own` is `vif->addr`, `peer` is the BSSID (lx_80211.c:1658-1659); correct for infrastructure (AA = BSSID).
- EAPOL-Key layout (`AT_*` offsets): 4+1+2+2+8+32+16+8+8 = 81 for the MIC, 97 for the data length, 99 for the data; matches figure 12-35.
- MIC (355-365): HMAC-SHA1 over the EAPOL frame from the version byte through the end of the declared body, with the 16 MIC bytes replaced by zeros, truncated to 16 bytes, key = 16-byte KCK; this is the rule for key descriptor version 2 (HMAC-SHA1-128). Computed over `4 + body` (the declared length), not the received length. Comparison is constant time (488-490). Descriptor version is required to be 2 (462) and descriptor type 2 (458).
- AES key unwrap (RFC 3394 2.2.2): six rounds j = 5..0, i = n..1, `t = n*j + i` XORed big-endian into A (307-320), integrity value A6A6A6A6A6A6A6A6 checked over all 8 bytes with an OR accumulator (321-323, 326); length must be a multiple of 8 and at least 24 (301); output buffer `data[640]` vs plaintext at most 4+body-99-8 <= 533. The `n = length/8 - 1` before the length test wraps for length 0 but is not used before the test. The `ENCRYPTED` bit is required (503). Test vectors in `tools/wpa-test` cover RFC 3394 4.1, a spoiled input and a wrong length.
- Key data length from the air: `4 + body` is bounded by the received length and by 640 (451); `AT_DATA + data_length > length` is rejected (466); reads of fixed offsets up to 98 only after `length >= 99`. Truncated or short frames return NOTHING or BAD without reading past the buffer (also covered by the test "a key message cut short").
- Replay counter: 8-byte big-endian comparison, strictly greater (495); updated only after MIC, nonce, unwrap and GTK parse all passed (513). Message 3 must carry message 1's ANonce (499). A retransmitted message 3 (higher counter) is answered again and does not reinstall keys: `handshake_message()` only queues work for `LX_WPA_GROUP`, and `station_join()` installs the PTK once, so there is no key-reinstallation (KRACK) exposure through message 3 retransmission. A replayed message 3 or group message 1 is rejected.
- GTK KDE walk (415-434): both `at + 2 <= length` and `at + 2 + len <= length`; `memcpy` size at most 32 into `group[32]`; the copy ends at the element end. Group message 1 requires MIC and ACK, the same MIC and replay path.
- Reply buffer: `handshake_message()` gives 14+256 bytes; replies are 99+22 = 121 (rsn_length is the constant 22, lx_80211.c:1662) or 99.
- Nonce source: see W6 (CSPRNG, fresh per join; one per join, reused for message 1 retransmissions, which is allowed).
- Wiping: PBKDF2 temporaries (166-167), HMAC pad and inner (137-138), PRF digest (184), derived `keys[48]` (382), unwrap round keys and block (324-325), `data[]` on success; `explicit_bzero(&radio->wpa)` at leave (lx_80211.c:1480); `key_drop()` wipes the key config; `what` zeroed after the join (1858); `apple80211.c:560-565` uses `memset_s`; `hakios.sta.c` zeroes the queued join request after copying it. `explicit_bzero` in `lx_base.c:1187` is a separate-TU `bzero` and is not elided.
- Logs: no printf or `lx_tell` in `lx_80211.c`, `lx_wpa.c`, `apple80211.c` or `hakios.sta.c` prints a passphrase, PMK, PTK, GTK or nonce; the join prints lengths only; `apple80211.c` logs types, lengths and kinds only. The Apple80211 `set_join` validates passphrase length 8..63 and PMK length 32 (543-549); `hakios_wifi_network()` validates 1..32 and 8..63 (4087-4090). `station_join()` itself does not re-check `passphrase_length <= 64` (it is a `uint8_t`; `lx_wpa_pmk` would over-read the `what` struct for larger values), but every in-tree caller validates.

Frame paths in `lx_80211.c`:

- Management: every fixed-offset read is behind a length test (`length < 26`, `>= 30` for authentication and association response, `>= 28`/`>= 33` for the ADDBA/DELBA action frames); `answer_length` is clamped to `ELEMENTS_MOST` (847); `aid` masked to 14 bits; deauthentication/disassociation handling reads only f[24..25]. The `tid` index is masked to 0..7. The sender (TA) and receiver (RA) addresses are compared against the AP and our own address.
- `to_ethernet()`: header size at most 24+6+2+4+8 = 44, `skb->len >= header + 8` checked before the LLC test, `skb_pull(header + 8 - 14)` is at least 18 and at most `len`; address and ethertype are copied out before the pull. (Minor: `f[0]`, `f[1]` are read before the first `skb->len` test; two bytes inside the same buffer, not exploitable.)
- A-MSDU and fragments: the A-MSDU bit is never interpreted, so flipping it (FragAttacks CVE-2020-24588) has no effect; there is no fragment reassembly, so the mixed-key and fragment-cache attacks do not apply here; fragments are not reassembled (a first fragment would be passed as a frame, but only decrypted data reaches this path, see W3 for the caveat).
- Association response parsing: `element()` walkers are bounded; WMM parse requires `e[1] >= 24` and reads at most `e+25`; HT (>= 26), VHT (>= 12), HT operation (>= 22) and TIM (>= 2) lengths are tested before use. A concurrent overwrite of `answer_elements` by a forged association response can change content under `station_abilities()`, but all reads stay in the 1024-byte array or at worst the next field of the same struct.
- `request_elements()` output is at most about 131 bytes into a 300-byte buffer.
- Rx serialization: when `wifi_irq=1`, copy-engine and data-path service run under `bus.service` (lx_bus.c:318, 397, 410), otherwise only the ring thread runs them; so `lx_wpa_message()` and `management_received()` are never run concurrently with themselves.
- Scan: `station_scan()` request is sized from the channel counts; channel list bounded by `frequency_count <= 64` (set in `apple80211.c:484`); SSID copy bounded (32).

`lx_base.c`, `lx_bus.c`, `hakios.lx.c`:

- DMA: `lkpi_dma_map_phys()` refuses anything outside the pool; `pmap_kextract` answers only for pool memory; ring allocations are rounded, overflow-safe (`size_t` arithmetic) and zeroed; skb data slots are bounds-checked against `POOL_SLOT` before allocation (879). The pool is one physically contiguous allocation behind the SMMU window; nothing is sized from a hardware register except the register window offsets in `window()`/`refused()`, which are range-checked against the three windows.
- Thread/IRQ model: the hard handler only masks the vector, ORs the pending bit and wakes; handlers run on one thread; `lx_os_irq_disable()` and `detach_all` wait for a running handler; there is no lost wakeup (`assert_wait` before the `xchg`). Sleeping lock words panic on self-recursion by design. `idr_*` and `rhashtable_*` are under the layer's lock. The transmit queue (`lx_queue`) keeps its slot reserved until `lx_queue_out++`; full-queue test is `in - out == LX_QUEUE`.
- `hakios.sta.c`: one worker thread, one lock; `hakios_sta_attach(NULL)` waits for calls and readers; request structs are copied under the lock and zeroed after use. `standing` (the passphrase of the file network) is kept for the life of the system by design (to re-join when the radio is switched on).
- `apple80211.c`: `give()` clamps `copyout` to the caller's `req_len`; `give_network()` clamps elements to the room the caller declared and to 1024; scan request lengths are checked against `sizeof`.

QMI codec as used by `hakios.wlfw.c` (WLFW service only):

- `decode_counted()` rejects a count above `elem_len` before storing it (499); arrays (numbers or structures, nested) therefore stay inside the C structure; static arrays use `elem_len`; strings need `length < elem_len` and are NUL-terminated (476-480), so the `%s` prints of `fw_build_id` and `fw_build_timestamp` (wlfw.c:449-454) are safe; each TLV's length is checked against the message and the message against the datagram (`qmi_receive`, 686-693); unknown TLVs are skipped; a TLV that does not describe a known element is ignored; the destination of a reply is decoded under the lock and the transaction is removed under the lock on timeout, so a late reply cannot write into a dead stack frame. Every `ask()` caller zeroes its reply structure first, and `send_file()` bounds the file (256 KiB) and each piece (`QMI_WLANFW_MAX_DATA_SIZE_V01`). A reply without the result TLV reads as "success" (the zeroed `result` is 0), as it does in Linux's qmi helpers.

Concurrency and lock order: no cycle found among `lx_lock`, `bus.service`, `wiphy->mtx`, `sta_lock`, `apple80211_lock`; `station_leave()` cancels work items without holding `wiphy->mtx`, so `ba_handle()`/`group_rekey()` cannot deadlock against it; the deauth path in the rx thread calls the station events after dropping `lx_os_lock`.

## Not checked

- The ath11k driver itself and the firmware (not in the tree): whether it drops unprotected data frames (W3), checks multicast PN (W4), and how much of its DMA goes through `dma_alloc_coherent`/`dma_alloc_noncoherent` (W5, its rate).
- `tools/wpa-test` was not run (no compiler available on the Windows host), and `reference.py` was not read line by line; the AES, PBKDF2 and unwrap checks above are by reading the code against the standards' vectors that the test cites.
- `hakios.wifi.c` (bring-up, firmware loading, DSP), `hakios.net.c` (what `hakios_net_input` does with a frame), the QRTR transport under `hakios.qmi.c`, and the generated `hakios.wlfw_ath11k.h` tables.
- The minicrypto DRBG internals and whether the kernel entropy collector reseeds it before the first join (W6).
- Side channels: the AES code is table-driven and `times()` has a data-dependent ternary; it runs only for the key unwrap, so only a local cache-timing attacker would matter.
- 40/80 MHz width selection and rate/HT/VHT handling were read for bounds only, not for correctness against the standard; power save, roaming, regulatory domain logic and the `wifi_lx=1` register-trace path were skimmed.
- Behaviour on hardware (everything marked PLAUSIBLE or NEEDS-HARDWARE).

## Fix status

- W1: FIXED (partly). `lx_wpa.c` `lx_wpa_message()`: an unsigned message 1 is accepted only while no signed message has been accepted yet (`!replay_known`); afterwards it is ignored (`LX_WPA_NOTHING`, no reply, keys untouched). This closes the 30 ms window before `key_set()` and the after-join KCK/KEK overwrite. SKIPPED: the candidate-key scheme for a forged message 1 *before* message 3 (needs new fields in `struct lx_wpa`, i.e. `lx_wpa.h`, which was not in the editable set; the forged frame still makes that join fail, as W2 case 1 describes).
- W2: FIXED. `lx_80211.c` `handshake_message()`: `radio->handshake` is no longer overwritten once it is `LX_WPA_KEYS`; `station_join()`: the wait no longer ends on `LX_WPA_BAD` (only KEYS, the AP's deauthentication or the 8 s timeout), the reason is still logged on timeout. A genuinely wrong passphrase still ends through deauthentication or the timeout.
- W3: SKIPPED. NEEDS-HARDWARE: whether the driver sets `RX_FLAG_DECRYPTED`/`IV_STRIPPED` on every legitimate 802.11-form frame is not known; requiring it could drop real group traffic.
- W4: SKIPPED. Protocol/design change (per-key PN state, and whether `status->extiv` carries the PN depends on the firmware/driver).
- W5: SKIPPED. Replacing the bump allocator with a freeing allocator is a design change and needs knowledge of which ath11k allocations go through it.
- W6: SKIPPED. The seed is in `xnuloader/loader.c`, outside the editable files.
- W7: FIXED (partly). `lx_wpa.c` `group_key()`: the GTK KDE must be 16 bytes and have key number 1 to 3. SKIPPED: the Install/Secure bit checks (supplicants such as wpa_supplicant do not require them; rejecting could break real APs) and the RSNE comparison with the beacon (needs a changed `lx_wpa_message()` signature / `lx_wpa.h`).
- W8: FIXED. `lx_80211.c`: the requested BSSID is stored in `radio->want_bssid` and tested in `heard()`; a new `radio->target_fixed` stops `heard()` from replacing `target` once the join has chosen; the `bzero(target)` is now under `lx_os_lock()`. SKIPPED: `vif->bss_conf.bssid` still points at `target.address` (now stable after the choice).
- W9: SKIPPED. Locking/teardown redesign (PLAUSIBLE, needs a `leaving` protocol across rx, work items and the driver).
- W10: FIXED (partly). `lx_80211.c` `group_rekey()`: on a failed `set_key` the old key is kept and the new configuration is wiped and freed. SKIPPED: not sending group message 2 and not consuming the replay counter on failure (needs a handshake design change).
- W11: SKIPPED. `timer_delete_sync()` waiting risks self-deadlock when called from the ticker's own callback, and bounding `irq_group()` needs knowledge of the vector's (edge/level) re-arm behaviour.
- W12: FIXED. `lx_80211.c` `say_heard()`: the BSSID of the wanted network is not printed. `lx_wpa.c`: the last AES block `t[16]` in `aes_decrypt()`, `a[8]` in `aes_unwrap()` and `data[]` after a failed unwrap are wiped.

Test: `tools/wpa-test` (copied to WSL, built with the sanitizers, no output left in the tree) passes, 195 checks 0 failed (seed 1); with seed 7 and one extra ad-hoc check (a forged message 1 after message 3 changes no key and gets no reply) 207 checks, 0 failed. `lx_80211.c` was only re-read, not compiled.

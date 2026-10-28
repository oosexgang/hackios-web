# Legal review of HakiOS (and of funding it with a token)

Date: 2026-10-26. Author: an AI assistant reading the repository and public sources. **This is not
legal advice and not a lawyer's opinion.** It is a risk map with evidence, meant to tell you what to
fix first and what to ask a real lawyer. Every claim about the repository was checked against the
files named; every claim about law or cases is linked to the source it came from. Where I could not
verify something, it says so.

## Verdict

"Is it legal?" has no single answer, because the project is four different things:

| Layer | Verdict | Why |
|---|---|---|
| The open code (kernel patch under APSL 2.0, our loader/tools/userland under MIT) | **Fine, with homework done well.** | `COMPLIANCE.md` is a solid checklist: source published, Apple's notices kept, XNU-derived code not relabelled MIT. |
| **Running iOS on non-Apple hardware** | **Grey, and a breach of Apple's licence for whoever does it.** | The licence grants use "on a single Apple-branded Device" and forbids copying/decrypting/modifying/deriving ([iOS 16 licence](https://www.apple.com/legal/sla/docs/iOS16_iPadOS16.pdf), §2(a), §2(d)). Not distributing iOS is the right mitigation and you do it. Courts split on the rest (below). |
| **Four things in the repo that contradict its own legal statements** | **Fix before anything else.** | Vendor blobs tracked in git, iOS screenshots still in history, App Store/FairPlay experiments plus an iPhone identity, "iOS" emphasised in the brand. Details below. |
| **The $HackiOS token** | **Separate, and the biggest risk of the whole thing.** | A token licenses nothing and cannot make the project "legal"; it can only fund it. But it turns a research project into one with a revenue stream, which changes how courts, Apple, platforms and regulators see it. |

The single most useful sentence: **keep the token and the code completely apart, and never sell or
gate anything that contains Apple's code behind it.**

## 1. Apple: what the cases actually say

- **[Apple v. Psystar](https://jolt.law.harvard.edu/digest/apple-inc-v-psystar-corp) (9th Cir., 2011):**
  Apple won. Psystar sold computers running Mac OS X, which its licence limits to Apple hardware; the
  court affirmed infringement and rejected "copyright misuse", so a licence restriction to Apple
  hardware was enforceable. Psystar was a commercial hardware seller, and the district court also
  found a DMCA violation (I could not confirm what the appeal said about the DMCA part).
- **[Apple v. Corellium](https://9to5mac.com/2023/05/08/us-court-corellium-apple-ios/) (11th Cir., May
  2023, unpublished):** Corellium won on fair use for its iOS virtualisation, reasoning that it
  advanced security research and that iOS is largely functional. Three limits matter to you: the
  opinion is unpublished and fact-specific; the court **sent back Apple's claims about icons and
  wallpapers** unresolved; and the parties [settled in December 2023](https://www.theregister.com/2023/12/18/apple_corellium_case_settles/)
  on confidential terms. Corellium was a research tool, not a consumer port.
- **What follows for HakiOS:** you sit between the two. You do not sell iOS or hardware (good, unlike
  Psystar), but you are a hardware port that lets people run iOS on a phone, not a research
  virtualiser, and Corellium's facts are about research. Do not rely on Corellium as a safe harbour.
- **Jurisdiction decides a lot.** Apple's licence is governed by California law (§12), but the
  maintainers and users live elsewhere. In the EU, rules on lawful acquirers and interoperability
  differ from US copyright law; in Ukraine I have not checked. This is the first question for a lawyer.

### What the build does that touches Apple's code (the exposure that is yours, not the user's)

- `sysimage/unpack.sh` unpacks parts of an IPSW the user supplies (nothing is downloaded) and `userland/build.sh`
  assembles a modified root image: it selects parts of iOS, replaces launchd with `stage0`, injects
  our dylibs into SpringBoard and other Apple processes (`userland/src/inject*.c`), and
  `xnuloader/mkidentity.py` copies the iPhone's device-tree identity so the system "believes it is
  the iPhone its files were built for". Licence §2(d) forbids to "modify, or create derivative works".
  That is the clause someone would point at. It is a licence/contract problem for the person
  running it first, and a "you are inducing it" argument against the project second.
- The kernel replaces Apple's code-signing policy with a stub (`libkern/amfi/miniamfi.c`,
  `bsd/kern/kern_minimac.c`; the patch says "nothing is signed here ... AMFI is a stub"). That is
  *implementing nothing* rather than *breaking* a protection, which likely sits on the safer side of
  the DMCA's anti-circumvention rule, but it is untested. Make the sentence "without decrypting or
  circumventing anything" in the README precise ("the IPSW is downloaded unmodified; no encryption is
  broken") instead of absolute.

## 2. Four places where the repo contradicts its own legal text — fix first

### P0-a. Vendor binaries are in git (and the docs say they are not)

`README.md` and `LEGAL.md` say the phone's firmware is "never" in the repository. But the tree tracks:
`devices/redwood/uefi/files/Binaries/redwood/**` (Qualcomm/Xiaomi UEFI drivers extracted from
`xbl.img`, e.g. `DisplayDxe.efi`, `DALSYSDxe.efi`, `XBLCore.te`), the **built image
`devices/redwood/prebuilt/SILICIUM_UEFI.fd` (2 MB, contains those drivers)**, and
`drivers/input/hakios.focaltech_fw.h` (713 KB, a touch-controller firmware turned into a header).
`COMPLIANCE.md` itself marks all of this "to verify, not cleared". The upstream [Mu-Silicium](https://github.com/Project-Silicium/Mu-Silicium)
licenses its *code* BSD-2-Clause (GPL for some dirs) and states **no terms** for the vendor-binaries
folder, so "Project Silicium does it too" is not a licence.

Note: deleting `Binaries/` is not enough, because `SILICIUM_UEFI.fd` carries the same drivers.

**Fix:** move all three to the pull-from-device model the rest of the firmware already uses (the
`pull-firmware-root.sh` and UEFIReader flow), build `SILICIUM_UEFI.fd` locally, and drop the tracked
copies. Then fix the sentences in README/LEGAL so they are true.

### P0-b. iOS screenshots are still in the history

Commit `3849ceb` (2026-10-25) removed `docs/homescreen.jpg`, `lockscreen`, `settings`, `messages`,
`maps`, `wallet`, `appstore-*`, and more, but they remain retrievable from history and from any clone
or fork made before. They show Apple's UI, icons and wallpapers, which is exactly what Apple's
remanded claims in *Corellium* were about.

**Fix:** purge them with `git filter-repo` and force-push (coordinate with the team: every clone and
fork must re-sync), then ask GitHub support to drop cached views of the old commits. Decide this
consciously: the alternative is to accept the risk and say so.

### P0-c. App Store / FairPlay experiments and the iPhone identity vs "not an iPhone to Apple's services"

`README.md:37` and `LEGAL.md:37` promise nothing "that would make the phone pass as an iPhone to
Apple's services". Yet: the loader presents the device as an iPhone (`identity.h`), and
`userland/src/inject_store.c` (opt-in `STOREFRONT=1`) injects into `appstored`, makes it answer with
the storefront `143469-2,8`, and notes that it fetched Apple's bag from `bag.itunes.apple.com` and
`init.itunes.apple.com` "by hand". `inject_fairplay.c` studies Apple's **FairPlay** daemon. iOS itself,
believing it is an iPhone X, also contacts Apple's servers on its own.

**Status (27 October 2026).** The App Store and FairPlay experiments were removed from the tree earlier. The Apple data in the
distributed loader is now gone too: `prebuilt/loader.efi` is built with the placeholder identity (`xnuloader/mkidentity.sh
--placeholder`, no Apple device-tree data in it; checked by searching the binary for the iPhone model and board names), and
`tools/update-prebuilt.sh` builds it that way in a temporary copy so that it cannot come back. The loader that starts iOS is built
by the user (`make loader`), on their own machine, with the identity taken from **their** copy of the IPSW. **Still open:** the
loader's own source writes two fixed device-tree values (`serial-number` "RDW00POCOX5P", `model-number` "MQAC2", in
`xnuloader/loader.c`; the second is an Apple model code), and older commits of `prebuilt/loader.efi` in the git history still
contain the earlier identity data (a history rewrite would be needed to remove them).

Whether any of that is unlawful depends on law I have not verified (terms of service, computer-misuse
statutes, DRM rules), but it plainly contradicts the stated promise, and touching FairPlay and the
store is what draws attention. **Fix:** keep these experiments out of the public repository (a private
branch), make outbound traffic to Apple's service hosts blocked by default in the image with a documented
switch, and rewrite the sentence to say what is true.

### P1. The name and the logo emphasise "iOS"

The project is "HakiOS" in the repo, "HackiOS" in the token and site, and the brand rules write "HACK in
white, iOS in red". "iOS" is Apple's mark; descriptive use ("works with iOS") is fine, but a product name
that embeds and highlights it is where confusion claims start, and `hackios.org` repeats it. This is a
branding decision, not a legal emergency: at least stop highlighting "iOS" in the logo, and use one
spelling everywhere. A rename is the clean fix if you expect to grow.

## 3. Copyright hygiene in your own code (low effort, high value)

- **Contributions:** `CONTRIBUTING.md` says contributions come under the same terms. Add a DCO
  sign-off requirement (`Signed-off-by:`) so each contributor states they have the right to submit.
- **APSL files:** the `xnu/files/` drivers are under APSL 2.0 (a conservative, correct choice). Keep the
  per-file headers; APSL has termination and patent provisions, so every maintainer should read it once.
- **The stray XNU build:** `prebuilt/mach.development.bcm2837` is a binary of APSL code, so APSL 2.3 needs
  corresponding source to be available. It is, in this repo plus Apple's tag; keep `apply.sh` pinned.

## 4. The token

What I know comes from your earlier notes and may be out of date; correct me. $HackiOS on BNB Chain
via [flap.sh](https://flap.sh), contract `0x5be8dca3…7777`, 1B supply, a 1% buy / 1% sell tax that funds
the team; a community site with three holder tiers, Snapshot voting on devices and roadmap, and a stated
fee split of 50% development / 30% growth / 20% community pot.

**I could not verify flap.sh's own terms or exactly how its creator-fee wallet works**: the sources I
found are secondary. Read its official docs and terms, and check whether your tax wallet, "dividend"
features and any token-gating are allowed.

### Can a token fund the project? Yes, and here is where it bites

1. **Securities risk (US).** The SEC staff's [February 2025 statement](https://www.winston.com/en/blogs-and-podcasts/non-fungible-insights-blockchain-decrypted/sec-staff-under-new-administration-issues-statement-declaring-that-meme-coins-are-not-securities)
   said *typical* meme coins are not securities. It is non-binding, and it excludes coins designed to
   evade the rules and projects whose economics point to profit from the team's efforts. A token whose
   tax is earmarked for a development team, with holder governance over the roadmap and a pot paid to
   holders, is closer to that line than a joke coin. **The "20% community pot" is the riskiest item:
   if it is paid to holders in proportion to what they hold, it looks like profit-sharing.** Make it a
   grant/bounty budget decided by vote, not a distribution to holders.
2. **EU (MiCA).** ESMA's [Q&A](https://www.esma.europa.eu/node/222469) says the white-paper exemptions
   can be lost depending on where the token is admitted to trading and that offers can still be public
   offers; a DEX launch does not make the question go away. Whether you are an "offeror" at all, when a
   bonding-curve contract sells the token, is for an EU lawyer.
3. **Ukraine.** The 2022 law "On Virtual Assets" ([No. 2074-IX](https://aub.org.ua/en/virtualni-aktyvy-novyi-etap-rehuliuvannia-ta-opodatkuvannia-v-ukraini-2/))
   is not yet in force because it waits for Tax Code amendments, and the tax bill (No. 10225-d) had
   passed only a [first reading](https://www.ey.com/en_ua/it-tax-law-digest/the-draft-law-on-the-taxation-of-income-from-virtual-assets-approved-by-the-parliamentary-committee)
   in what I found; check the Rada's site for the current state. "Not yet regulated" is not "approved".
   Fee income that reaches the team is income wherever it is tax-resident: keep records now.
4. **Consumer-protection and fraud exposure.** Statements like "revenue", "supports the price", "roadmap
   will deliver" are the usual source of liability. Your own brand rule ("honest, no price promises") is
   the right rule; put it in a published policy and hold every channel to it.
5. **Apple exposure grows with money.** Commercial exploitation weighs against fair use. If holders can
   obtain system images or Apple-derived artefacts through the token, you stop being a source project
   and start looking like Psystar. **Rule: the token gates community perks and votes, never a file that
   contains Apple code.**

### Structure that lowers the risk (cheap to do now)

- A legal entity (association/foundation, or a lawyer-advised wrapper) that owns the fee wallet, not
  individuals; a multisig with at least two signers; a public treasury and a published budget.
- Team vesting and a public statement of how fees are spent; no promise of returns, ever.
- No revenue distribution to holders; tiers give access and a vote, not money.
- Keep the token off the code repository entirely (it already is) and off the legal files.
- Geo-fence marketing away from US persons until counsel signs off; no "investment" language.
- A one-page disclaimer on the site: not affiliated with Apple; the token is not a licence; no
  expectation of profit; no access to Apple software.

## 5. What I could not check

flap.sh's official terms and creator-fee mechanics; the legal system you live in; Apple's current
enforcement posture; whether the vendors would object to the UEFI binaries; the current text of the
Ukrainian bills; what the website `hackios.org` says. A lawyer with crypto and IP experience should
review §2 and §4 before the team acts on this.

## 6. Decisions I need from you (ranked)

1. Remove the vendor blobs and the built UEFI image from the tree (P0-a)? I can prepare the change.
2. Purge the iOS screenshots from history (P0-b)? This rewrites history; it needs the whole team.
3. Move the App Store / FairPlay experiments off the public repository (P0-c)?
4. Keep the "HackiOS" name, or rename before it grows (P1)?
5. Change the community pot so it is never paid to holders pro rata (§4.1)?
6. Hire a lawyer for one hour on §1 (jurisdiction) and §4 (the token).

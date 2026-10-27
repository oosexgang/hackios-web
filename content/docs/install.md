# Installing HakiOS on a phone: the design, and what is missing

**Nothing in this document has been run on a phone.** The pieces it names exist and are tested one by one (in QEMU,
against stand-in programs, by their own self-tests). The whole chain has not been tried, and the attached phone was
not on USB while this was written. Read it as the safety model that an install has to meet, not as instructions.

## Today

HakiOS is booted from RAM: `./xl enter` takes a boot image with `fastboot boot`, and a reboot brings Android back.
Android's own partitions are not written. The one default write is the loader's log (a few KB) into the phone's
`logdump` partition at the end of a run, and with `ufs_write=1` the kernel may write to the port's own partition
`darwin` and nowhere else. The complete list of what can write is in `tools/provenance.allow` (the `flash` lines), and
CI fails if another writer appears.

## What "installed" would mean

Android stays, HakiOS sits beside it and is chosen at boot, and going back is a slot switch. Two things have to live
on the phone:

1. **The boot chain.** The boot image `./xl enter` builds (`mkxnuimg.py`: Project Silicium's UEFI, the shim and a
   payload) already starts with no host: the shim puts the payload in memory and the loader runs it, in one-shot mode
   when the payload carries no `usb` entry. Installed, that same kind of image would sit in the boot partition of the
   **inactive** slot.
2. **The system.** The partition `darwin`, cut off the end of Android's userdata once
   (`tools/userdata-carve.py` prints the plan and says what it does to Android's data), written by
   `tools/darwin-write.py`, which refuses everything but that partition and reads every write back. The root image for
   it is the flash recipe (`FLASHBOOT=1 userland/build.sh`).

`make doctor` already looks at what this stands on, read only: whether the phone reports two slots, which one Android
runs from, and whether `darwin` exists.

## Rules an install must keep

Each one is how the project already treats writes (`darwin-write.py`, the loader's refusals), carried over:

1. **Look before anything is written, and keep what was there.** Slots, partition table and free space are read first;
   before a write, the partitions that will be touched, the GPT head and tail and the boot and `vbmeta` partitions
   are copied off the phone and hashed twice.
2. **Only the inactive slot.** Never the slot Android runs from. No A/B, no install.
3. **Never the partitions that cannot be made again**: the bootloader chain, the modem's and radio's calibration, and
   the phone's own identity data.
4. **Every write is read back and compared**, and a mismatch stops everything.
5. **A way back that does not need this host**: choosing Android's slot again, with the standard `fastboot set_active`.
6. **Dry run by default.** Each step is printed with the checks it made, one at a time; a person types the
   confirmation for each; nothing is done on a script's own say-so.
7. **Everything is logged**, refusals too.

## What exists and what does not

| Needed | State |
|---|---|
| A boot image that starts with no host (shim + payload) | exists (`mkxnuimg.py`); the loader started from it by `fastboot boot` on the attached phone |
| A guarded writer for `darwin` | exists (`tools/darwin-write.py`); its self-test refuses the wrong partition |
| A plan for carving `darwin` | exists (`tools/userdata-carve.py`, prints the commands, writes nothing) |
| Read-only preflight | exists (`make doctor`): slots, `darwin`, firmware, root, bootloader as reported |
| **Writing the boot image to a slot and switching to it** | **not done, not tried** |
| **Booting the flash recipe's root from `darwin`** | **not verified** (the arguments it needs are not confirmed) |
| **Project Silicium's Boot Manager behaving the same from a boot slot** | **unknown** |
| **Verified boot (`vbmeta`) for a modified boot image** | **unknown** |
| An installer that chains the steps under the rules above | not written |

## Why there is no installer yet

A wrong write can leave a phone that does not boot, and an unlocked bootloader only makes the mistake possible, not
recoverable. An installer that has never been run on a phone, written without one on the desk, would be a guess
with a progress bar. What can be built and checked first is built and checked: the read-only preflight, the guarded
writer, the plans. The slot step comes when a phone is attached, a spare slot is confirmed, backups exist and a
person is watching.

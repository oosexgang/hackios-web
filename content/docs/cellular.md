# Cellular

Where the modem stands (October 2026). The detailed, step-by-step diary in Russian is
`docs/ru/cellular.md`.

## What works

- The modem (the Hexagon MPSS) boots from XNU: its firmware goes through TrustZone, the shared
  memory, SMP2P, GLINK and QRTR come up, and it announces about 88 QMI services.
- Its file systems (modemst1, modemst2, fsc, fsg) are served from the UFS partitions over RMTFS,
  read-only: writes stay in kernel memory for the session, the phone's flash is never touched.
- TFTP over QRTR and the service registry (what Android's tqftpserv and pd-mapper do) are ours.
- The IPA packet engine runs: firmware through TrustZone, its clock through RPMh, both of its SMMU
  streams through a translation context of ours (the hypervisor takes one match register per
  stream), the registers Android programs, the modem's filter-table item in shared memory, and the
  SMP2P entry `ipa` the modem's driver waits for. The INIT_DRIVER handshake goes through.
- The modem goes online and stays up. The SIM is found (physical slot 2 on the first phone),
  logical slot 1 is pointed at it, the provisioning session is bound to its USIM, and NAS reads
  the signal (-70 to -87 dBm on UMTS).
- SpringBoard's status bar: the signal item is hooked (`userland/src/inject_sb.c`) and shows the
  kernel's bars (`sysctl kern.hakios.cellular_bars`) once the modem is registered.

- The data session: once NAS reports registration, the kernel binds its QMI WDS client to QMAP
  mux 1 of the embedded port (the IPA), sets the port's data format (WDA: raw IP in QMAP, no
  checksum offload), starts an IPv4 session on the SIM's default profile and reads its settings
  (address, gateway, DNS, MTU: `sysctl kern.hakios.cellular_ip`, `_gateway`, `_dns`, `_mtu`,
  `_data`).

## The data path (2.0)

Packets go through the IPA, the SoC's packet engine, the way Linux's `drivers/net/ipa` does it
for IPA 4.11; everything is in `drivers/modem/hakios.ipa.c` and `hakios.cell.c`.

- Before the modem starts, the kernel sets up this processor's side of the IPA: four GSI
  channels with their event rings (the command channel 5, the LAN receive channel 14, the modem
  transmit channel 2 and the modem receive channel 7), the matching endpoints (7, 9, 2, 16:
  QMAP headers, deaggregation on the way out, aggregation up to 12 KB or 500 us on the way in),
  and the IPA's filter, route and header tables through immediate commands, so that the modem
  finds valid tables and adds its own rules to them.
- The rings are polled by the interface's thread; no interrupt is taken from the GSI.
- The modem's packets are an Ethernet-looking interface, `en1`, with a made-up router behind it.
  The kernel answers ARP for every address and DHCP with the session's address, a /24 around it,
  the router and the DNS servers, so iOS's configd configures `en1` as it would a USB Ethernet
  adapter and routes through it. IPv6 is not carried.
- The modem is told about this side the way ModemManager does for a phone behind the IPA
  (`net_driver == "ipa"`): **DPM Open Port** (Data Port Mapper) names the embedded port's IPA
  endpoints (the modem receives on our TX endpoint 2 and sends on our RX endpoint 16), then **WDA
  Set Data Format** sets raw IP in QMAP on it. Only then do the WDS steps run: **Bind Mux Data
  Port** (mux 1), **Set IP Family** (IPv4), **Start Network Interface** (with the APN) once NAS is
  registered, retried while the packet domain is still attaching. Skipping the DPM step was why
  WDA and the session answered InvalidOperation and the bind Internal (cycles 38-41): the modem
  had no embedded port to bind to.
- The rings are polled by the interface's thread; no interrupt is taken from the GSI.
- The modem's packets are an Ethernet-looking interface, `en1`, with a made-up router behind it.
  The kernel answers ARP for every address and DHCP with the session's address, a /24 around it,
  the router and the DNS servers, so iOS's configd configures `en1` as it would a USB Ethernet
  adapter and routes through it. IPv6 is not carried.
- `modem_ipa_data_off=1` leaves all of this out; `modem_dpm_off=1` / `modem_wda_off=1` skip those
  steps; `modem_ipa_data_trace=1` logs every packet.

## Another phone: the SoC addresses

The modem and IPA drivers carry the POCO X5 Pro's register and memory addresses as defaults and
take any that differ from boot-args `soc_*` (`hakios.mpss.c` `soc_override()`, `hakios.ipa.c`).
`tools/soc-args.py` reads a phone's own device tree (`devices/<name>/pull-soc.sh` pulls
`/sys/firmware/fdt` over adb) and prints the `soc_*` it needs; the run scripts append
`devices/<name>/soc.args`. For the first phone every generated value equals the default, so it
needs no arguments.

## Not yet

- Registration reaches full LTE service, but the data session is still refused until the packet
  domain attaches; the DPM/WDA/bind order above is the current attempt, untested on hardware since
  the phone went off USB.
- Calls, SMS, IPv6.

## How to run it

```sh
XL_SB_DELAY=8 tools/modem-cycle.sh "modem=1 modem_again=1 modem_buffer=0xa8000000" 600
```

`modem_step=N` runs the bring-up step by step and returns to the loader with the log;
`modem=1` brings the modem up beside the system. Everything is in
`drivers/modem/hakios.mpss.c` (the modem), `hakios.nas.c` (NAS), `hakios.qmi.c` (QMI).

## Kernel arguments

| Argument | Meaning |
|---|---|
| `modem=1` | the modem beside the system, on a thread of its own |
| `modem_step=N` | steps 1..N, then back to the loader (`modem_return=1`) |
| `modem_again=1` | start it although a kernel before this one left it shut down |
| `modem_buffer=0xa8000000` | the RMTFS buffer (below 4 GB) |
| `modem_nas_wait=S` | how long step 11 waits for registration |
| `modem_online=0` | do not put the modem online |
| `modem_ipa=3` (default) | the SMP2P entry `ipa`: valid, clock on |
| `modem_sim_switch_off=1` | do not point logical slot 1 at the slot with the ready card |
| `modem_sim_probe_off=1` | no SIM and network-selection queries |
| `modem_data_off=1` | no data session at all |
| `modem_dpm_off=1` / `modem_wda_off=1` | skip the DPM / WDA step |
| `modem_data_nobind=1` | the session without binding the client to the mux |
| `modem_apn=NAME` | the session to that APN instead of the SIM's default profile |
| `modem_ipa_data_off=1` | no IPA data path for this processor, no `en1` |
| `modem_ipa_data_trace=1` | a log line per packet, command and DHCP/ARP answer |

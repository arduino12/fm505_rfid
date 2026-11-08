# FM-505 RFID console

Browser console for the FM-505 UHF RFID module (EPC Gen2 / ISO 18000-6C, 902–928 MHz, 3 dBi antenna)
on a USB-UART adapter (tested with a CH340 on COM86, 38400 8N1). One HTML file, nothing to install:
the page talks to the module directly through Web Serial.

**Live:** https://arduino12.github.io/fm505_rfid/ (demo without hardware: [`?sim`](https://arduino12.github.io/fm505_rfid/?sim))

## Use

1. Open the live page or `index.html` in **Chrome or Edge** (desktop). Firefox and Safari have no Web Serial.
   Opening the file directly works; `python -m http.server 8552` in this folder serves it at
   http://127.0.0.1:8552/ as well.
2. Click **Connect** and pick the adapter's port (e.g. *USB-SERIAL CH340 (COM86)*).
   The port must not be open in another program.
3. Press **Start**. Tags appear in the table with first/last seen time (millisecond resolution),
   read count, reads per second and the decoded chip (from the TID).

The port picked once reconnects automatically on the next visit and when plugged back in.

`index.html?sim` runs against a simulated module (`sim.js`) with the tags recorded on the real
antenna, for UI work without hardware. The simulated tags lie in a row 0.5 m apart under an antenna
that moves from tag to tag, and whether each answers depends on TX power, distance and angle.

## Features

- **Inventory**: multi-tag (`U<Q>`, anti-collision with 2^Q slots) or single-tag (`Q`), optionally
  reading a memory bank of every tag in the same round (`U3,R2,0,6` = EPC + TID). Start/stop, read once,
  pause between rounds. Live stats: tags, reads, reads/s, rounds/s, round time.
- **Tags table**: EPC, PC word and EPC length, chip maker/model from the TID (GS1 MDID list), bank
  data, reads, rate, Hit %, min power, first seen, last seen, age. Sortable. CSV export.
- **Closest tag** (the module reports no RSSI, so two stand-ins):
  - *Hit %*: of the inventory rounds in a 0.5–5 s window that got any answer, the share each tag
    answered in. The card names the leader and says whether its lead is clear (30 points or more),
    too close to call, or weak (few rounds answered). The leading row gets a green edge in the table.
  - *Power sweep*: raises TX power from −2 dBm one step at a time (8 rounds per step), notes the power at
    which each tag first answers (the closest wakes first), stops once a second tag answers, puts the
    original power back, and offers a working power: 3 dB above the closest tag's first answer and
    at least 2 dB below the next tag's.
  - At full power every tag within reach answers about as often, so Hit % separates tags only when the
    power is low enough that the neighbours start missing.
- **Read log**: every read with its time and the round time of the command that produced it. CSV export.
- **Settings**: TX power (N0/N1), region (N4/N5), module baud rate (NA, the page reconnects), GPIO
  pins 10/11/14 direction and level (N6–N9). Firmware, hardware, reader ID shown from `V`/`S`.
- **Tag memory**: read/write any bank by word address, select one tag by EPC (`T`) when several are
  in the field, access password (`P`), automatic retries, Write EPC (rewrites the PC length bits when
  the length changes). Kill and lock are left out on purpose; the console can send them.
- **Console**: raw commands with history, round-trip time per command, optional inventory traffic.

## Protocol notes (firmware D29B, hardware CB, checked on the real module)

Vendor docs: "FM-503 command format" / "Module instruction specification" (Fongwah/Fangkang), mirrored in
[tmanabc123/FM-503-UHF-RFID-Reader](https://github.com/tmanabc123/FM-503-UHF-RFID-Reader/tree/main/reference_docs).

- Command `<LF>cmd<CR>`, reply `<LF>reply<CR><LF>`, ASCII, arguments in hex. Unknown command → `X`.
- `V` → `VD29B,000173B4,CB,1`: software version, reader ID, hardware version, **current region**
  (the last field follows N5).
- `Q` → `Q` (no tag) or `Q<PC><EPC><CRC16>`. Single-tag only: with several tags in the field it fails
  most of the time (collisions), and so do `R`/`W` unless a tag is selected with `T` first.
- `U<Q>` → one `U<PC><EPC><CRC16>` line per tag, then a bare `U`. With 3 tags `U3` (8 slots) found all
  of them in ~85 ms per round; `U4` ~160 ms; plain `U`/`U0` misses most.
- `U3,R2,0,6` → `U<PC+EPC+CRC>,R<data>` per tag, or `U<PC+EPC+CRC>,<error>` (e.g. `,3` when the
  tag has no User memory). `Q,R2,0,6` is the single-tag version.
- CRC16 over PC+EPC: poly 0x1021, init 0xFFFF, output inverted (matches every reply seen).
- `T1,20,60,<EPC>` selects a tag by EPC bits (bit 0x20 onward, at most 0x60 = 96 bits); `P<8 hex>` sets
  the access password. Both are one-shot: the next Q/R/W/K/L/U clears them.
- R/W errors come back bare: `0` other, `3` memory overrun, `4` locked, `B` insufficient power,
  `F` non-specific, and `E` (undocumented, seen once right after a `T`). Partial writes reply `Z<nn>`.
- **`N1,<00..1B>` sets TX power (value = dBm + 2) and `N5,<01..0A>` the region. Both reply at once
  with `N<value>`**; the manual says the module restarts silently, this firmware does not.
  Note `N1,00` and `N5,00` look like reads but are writes (−2 dBm / an invalid region). The reads are
  `N0,00` and `N4,00`.
- This module came with TX power `FF` (outside the documented table) and region `01` (US 902–928).
  `FF` reads about as well as `1B` (25 dBm). The page shows it as "factory value" and keeps it selectable.
- `N6,00`/`N8,00` read GPIO direction/level as one digit (4 = pin 10, 2 = pin 11, 1 = pin 14);
  `N7,<mask><dir>` / `N9,<mask><level>` set them.
- **N1 is saved in the module.** Set to `1A`, power-cycled, read back `1A` (2026-11-08). Every power
  change is a write to its memory, which is why the power sweep runs only on demand.
- Power changes take effect on the next command. In a sweep with 7 UCODE 8 tags around the antenna,
  nothing answered below 11 dBm, two tags from 11 dBm, five to seven from 19–21 dBm.
- **Most inventory rounds come back empty.** At full power with tags around the antenna, only 7–12 of 30
  rounds returned anything with `U3`, `U4` or `U5` alike, and a round that answers usually lists several
  tags together. Single-power readings are bursty too: two tags answered at 11–13 dBm in a sweep, then
  0 of 60 rounds at 12 dBm a minute later. Expect the sweep's first-answer levels to be good to a few dB.
- `NA,<0..7>` changes the UART baud (4800…230400) after replying. Not exercised on the real module.
- No RSSI is reported by this protocol.

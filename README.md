# ESC/POS Printer Emulator

A fake network receipt printer for developing RestroX printing without hardware.

It listens on a printer's **IP and port 9100** (raw TCP, the same socket QZ Tray opens) and shows a live picture of what the printer would print. It interprets the ESC/POS byte stream the way printer firmware does, so mistakes in the bytes show up the way they would on paper.

```
RestroX (browser) ──qz.print──▶ QZ Tray ──TCP──▶ 127.0.0.21:9100  ← this emulator
                                                     │
                                                     ▼
                                     http://127.0.0.1:9180  live viewer
```

## Quick start

```bash
npm install
cp printers.example.json printers.json   # edit names / IPs / paper widths
npm start                                # → viewer at http://127.0.0.1:9180
```

Then in RestroX, open **Settings → Printers**, add a network printer, and set its IP to one of the emulator's addresses (for example `127.0.0.21`). Print a test page, a KOT or an invoice: QZ connects to `IP:9100` and the receipt appears in the viewer.

RestroX always prints to **port 9100** (`zustand/printer/store.ts`). Each emulated printer therefore needs its **own IP**, not its own port.

### Which IPs can I use?

| Address                       | Setup                                                    |
| ----------------------------- | -------------------------------------------------------- |
| `127.0.0.x` (any x)           | None. All of `127.0.0.0/8` is loopback on Linux.          |
| A LAN-style IP, e.g. `192.168.1.201` | `scripts/ip-alias.sh add 192.168.1.201` (uses sudo once) |

QZ Tray runs on the same machine as the browser, so a loopback alias is enough. Nothing else on the network sees it. If a real printer already owns that IP on your LAN, use a different one.

## Config

`printers.json` (git-ignored; start from `printers.example.json`):

```jsonc
{
  "http": { "host": "127.0.0.1", "port": 9180 },
  "dataDir": "data",          // job history (.bin + rendered .json)
  "idleMs": 1500,             // a silent open socket counts as end of job after this
  "printers": [
    { "name": "Counter", "host": "127.0.0.21", "port": 9100, "paper": 80, "type": "Thermal" },
    { "name": "Kitchen", "host": "127.0.0.22", "paper": 58 },
    { "name": "Bar",     "host": "127.0.0.23", "type": "Dot Matrix" }
  ]
}
```

| Key                  | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `paper`              | `58`, `72` or `80` (mm), the same values as the RestroX printer record                               |
| `type`               | `"Thermal"` or `"Dot Matrix"`, the same values as `printerType`                                      |
| `profile`            | Picks a profile directly: `thermal-58`, `thermal-72`, `thermal-80`, `impact-76` (`node bin/escpos-emulator.js profiles` lists them) |
| `cutterOffsetMm`     | Distance from head to cutter (default 10 thermal / 15 impact). `0` cuts exactly at the head.          |
| `kanjiDefault`       | Boot in Kanji/GBK mode like Chinese-market firmware (shows why the generator sends `FS .`)           |
| `rasterHonoursAlign` | Whether `ESC a` applies to `GS v 0` (Xprinter: yes, default; ZKTeco: no)                              |

You can also skip the file and pass printers as flags:

```bash
node bin/escpos-emulator.js start \
  --printer name=Kitchen,host=127.0.0.21,paper=80 \
  --printer name=Bar,host=127.0.0.22,type=dot
```

## The viewer

- **Receipt**: each ticket (the paper between two cuts) drawn at the head's dot resolution and thresholded to 1-bit. A full cut shows a torn edge and a partial cut a dashed line; "paper continues" means the job never cut.
- **Text**: a plain-text rendition (double-width text appears spaced out).
- **Commands**: every command decoded, with byte offsets. Unsupported or unknown commands are marked red.
- **Hex**: the raw bytes.
- **Badges** for cut, beep (also played as a sound) and cash-drawer kicks. **Warnings** for anything a real printer would mishandle.
- **PNG** downloads the rendered strip, **.bin** downloads the exact bytes received, and **Replay** prints them again.
- **Printer controls**:
  - *Online*: normal operation.
  - *Offline*: refuses connections, so QZ gets `ECONNREFUSED` as with an unplugged printer.
  - *Jammed*: accepts connections but never reads, for testing print timeouts.
  - *Paper out / near end / cover open / drawer open*: change the status replies to `DLE EOT`, `GS r` and ASB.
- **Connection tests**: RestroX's `checkQzPrinterConnection` opens and closes a socket with no data. These, and status-only polls, are listed under the printers rather than as jobs.
- **Drop a `.bin`** onto the sidebar to print it on the selected printer.

## CLI

```bash
node bin/escpos-emulator.js start [--config file] [--printer …] [--http host:port]
node bin/escpos-emulator.js render job.bin [--paper 58] [--type dot] [--json]   # offline, no server
node bin/escpos-emulator.js send   job.bin 127.0.0.21[:9100]                   # what QZ does
node bin/escpos-emulator.js profiles
```

HTTP API, for scripts:

```bash
curl --data-binary @job.bin http://127.0.0.1:9180/api/printers/counter/print
curl http://127.0.0.1:9180/api/jobs            # newest first
curl -X POST -d '{"mode":"offline"}' http://127.0.0.1:9180/api/printers/counter/mode
curl -X POST -d '{"paperOut":true}'  http://127.0.0.1:9180/api/printers/counter/status
```

## What is emulated

All of the output RestroX's `apps/web/src/utils/esc-pos` generator and `zustand/printer/rasterise.ts` produce, plus the rest of the common ESC/POS command set:

- **Text**: `ESC @`, `ESC !`, `GS !` (1–8×), `ESC E`/`ESC G` bold, `ESC -` underline (1/2 dot), `GS B` reverse, `ESC M` fonts A/B/C, `ESC V` 90° rotation, `ESC {` upside-down, `ESC SP` spacing, `ESC r` red.
- **Code pages**: `ESC t n` with the generator's capability numbering (CP437, CP1252 = 16, CP850, CP858, CP866, …). `ESC R` for a few international sets. **Kanji**: `FS &` / `FS .`, GBK double-byte, `FS !`, `FS S`, `FS W`.
- **Layout**: `ESC a` (latched by the first character on a line, as in firmware), `ESC $`, `ESC \`, `HT`/`ESC D`, `GS L` / `GS W` margins, automatic wrapping at the print-area edge, `LF`, `ESC d`, `ESC J`, `ESC 2`/`ESC 3`, `ESC e`.
- **Images**: `ESC *` (m = 0, 1, 32, 33, mixed into the text line), `GS v 0` (with ×2 modes), `GS ( L` / `GS 8 L` graphics (store and print), `GS *` + `GS /`, `FS q` + `FS p` NV images (kept for the session), `ESC &` + `ESC %` user-defined characters.
- **Symbols**: `GS ( k` QR (model, module size, error correction, store, print), PDF417, DataMatrix, Aztec, MaxiCode. `GS k` UPC-A/E, EAN-13/8, CODE39, ITF, CODABAR, CODE93, CODE128 (with `{A`/`{B`/`{C` sets), plus `GS H`/`GS f`/`GS h`/`GS w` HRI and dimensions.
- **Paper**: `GS V` (all modes, including feed-and-cut), `ESC i`/`ESC m`. Cuts happen at the **blade**, `cutterOffsetMm` above the head, so content not fed past the blade appears at the top of the next ticket, as on real paper.
- **Peripherals**: `ESC p` / `DLE DC4` cash drawer, `ESC B` beeper (the Xprinter form the generator sends), `ESC ( A`.
- **Status**: `DLE EOT 1–4`, `GS r`, `GS I` (printer ID), `GS a` ASB, `ESC u`/`ESC v`. Replies go back on the socket.
- **Page mode**: `ESC L`, `ESC W`, `GS $`, `GS \`, `FF`, `ESC FF`, `CAN`, `ESC S` (left-to-right direction only).
- **Firmware behaviour**:
  - State persists between jobs, so a job that skips `ESC @` inherits the previous job's styles.
  - Bytes left without a final `LF` print with the next job.
  - Commands split across TCP packets are reassembled.
  - One connection is served at a time and the rest queue.
  - On the dot-matrix profile, `GS v 0`, `GS ( k`, `GS k` and 24-dot `ESC *` are **not supported**. The head drops the command and prints its data as characters, which is exactly the failure `rasterise.ts` works around.

Not emulated: macros (`GS :`), page-mode rotation (`ESC T` ≠ 0), multi-tone graphics beyond the first plane, and printing NV graphics by key code (shown as a placeholder box).

## Tests and samples

```bash
npm test                       # interpreter + TCP behaviour
tools/generate-samples.sh      # rebuild samples/*.bin with the real RestroX generator
```

`samples/` holds bytes produced by the actual RestroX code: the printer test page (`getTestPrintTemplate`), a receipt exercising every generator feature, and a KOT encoded for a dot-matrix head. The generation script bundles the TypeScript from `../restroXfrontend/apps/web` with the repo's own esbuild, so the samples track the app.

## Display list

`src/interpreter.js` produces, per job, `tickets[]` of positioned elements in profile units. The browser (`public/render.js`) turns them into pixels using `profile.unitMm`:

| `t`     | Fields                                                                                   |
| ------- | ---------------------------------------------------------------------------------------- |
| `text`  | `x y chars adv gw gh font bold ul rev rot up red`, a run of same-style characters        |
| `bits`  | `x y bw bh sx sy data` (base64, MSB-first rows), for images, QR and other 2D symbols     |
| `bars`  | `x y h mw sbs` (bar/space module widths), for linear barcodes                            |
| `box`   | `x y w h label`, a placeholder for something only real hardware has (NV logos by key)    |

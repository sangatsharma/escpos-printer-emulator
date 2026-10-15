# ESC/POS Printer Emulator

A fake network receipt printer for developing and testing ESC/POS printing without hardware.

It listens on a printer's **IP and port** (raw TCP, port 9100 by default, also known as RAW or JetDirect printing) and shows a live picture of what the printer would print. It interprets the ESC/POS byte stream the way printer firmware does, so mistakes in your bytes show up the way they would on paper.

Anything that can print to a network receipt printer works: POS and restaurant apps, QZ Tray, CUPS raw queues, Windows "Generic / Text Only" ports, and libraries such as `escpos-php`, `python-escpos`, `node-thermal-printer` or `esc_pos_utils`.

```
your app / driver / library ──raw TCP──▶ 127.0.0.21:9100   ← this emulator
                                                │
                                                ▼
                                http://127.0.0.1:9180  live viewer (React)
```

## Quick start

```bash
npm install
npm run build                            # compiles the server and the viewer into dist/
cp printers.example.json printers.json   # edit names / IPs / paper widths
npm start                                # → viewer at http://127.0.0.1:9180
```

Then point your app's network printer at one of the emulator's addresses (for example `127.0.0.21`, port `9100`) and print. To check it without an app:

```bash
node dist/cli.js send samples/receipt-80.bin 127.0.0.21
```

### Development

```bash
npm run dev        # emulator (tsx watch) + Vite dev server with hot reload
```

Open the URL Vite prints (http://localhost:5173). It forwards `/api` and `/events` to the emulator on port 9180; set `EMULATOR_URL` to point it somewhere else.

### Which addresses can I use?

Each printer needs its own **IP:port** pair. If your app lets you choose the port, `127.0.0.1` with ports 9100, 9101, … is the simplest setup. If the app always uses 9100, give each printer its own IP:

| Address                              | Setup                                                    |
| ------------------------------------ | -------------------------------------------------------- |
| `127.0.0.1` with different ports     | None.                                                     |
| `127.0.0.x` (any x)                  | None on Linux: all of `127.0.0.0/8` is loopback. macOS needs an alias (below). |
| A LAN-style IP, e.g. `192.168.1.201` | `scripts/ip-alias.sh add 192.168.1.201` (uses sudo once) |

If your app runs on the same machine as the emulator, a loopback alias is enough and nothing else on the network sees it. To print from another device (a tablet, a phone, a second PC), bind the printer to this machine's LAN IP or `0.0.0.0`. If a real printer already owns that IP on your LAN, use a different one.

## Config

`printers.json` in the current directory (git-ignored; start from `printers.example.json`), or `--config path`:

```jsonc
{
  "http": { "host": "127.0.0.1", "port": 9180 },
  "dataDir": "data",          // job history (.bin + rendered .json), relative to the cwd
  "idleMs": 1500,             // a silent open socket counts as end of job after this
  "printers": [
    { "name": "Front desk", "host": "127.0.0.21", "port": 9100, "paper": 80, "type": "thermal" },
    { "name": "Kitchen",    "host": "127.0.0.22", "paper": 58 },
    { "name": "Office",     "host": "127.0.0.1",  "port": 9101, "type": "dot matrix" },
    { "name": "Bar",        "host": "127.0.0.1",  "port": 9102, "type": "dot matrix", "paper": 58 }
  ]
}
```

| Key                  | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `paper`              | Thermal: `58`, `72` or `80` (mm, default 80). Dot matrix: `58` or `76` (default 76)                   |
| `type`               | `"thermal"` (default) or `"dot matrix"` / `"impact"`                                                 |
| `profile`            | Picks a profile directly: `thermal-58`, `thermal-72`, `thermal-80`, `impact-58`, `impact-76` (`escpos-emulator profiles` lists them) |
| `cutterOffsetMm`     | Distance from head to cutter (default 10 thermal / 15 impact). `0` cuts exactly at the head.          |
| `kanjiDefault`       | Boot in Kanji/GBK mode like Chinese-market firmware (shows why drivers send `FS .`)                  |
| `rasterHonoursAlign` | Whether `ESC a` applies to `GS v 0` (Xprinter: yes, default; ZKTeco: no)                              |
| `idleMs`             | Per-printer override of the end-of-job timeout                                                      |

You can also skip the file and pass printers as flags:

```bash
node dist/cli.js start \
  --printer name=Kitchen,host=127.0.0.21,paper=80 \
  --printer name=Office,port=9101,type=dot
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
  - *Offline*: refuses connections, so your app gets `ECONNREFUSED` as with an unplugged printer.
  - *Jammed*: accepts connections but never reads, for testing print timeouts.
  - *Paper out / near end / cover open / drawer open*: change the status replies to `DLE EOT`, `GS r` and ASB.
- **Connection tests**: many apps check a printer by opening and closing a socket with no data. These, and status-only polls, are listed under the printers rather than as jobs.
- **Drop a `.bin`** onto the sidebar to print it on the selected printer.

## CLI

```bash
escpos-emulator start [--config file] [--printer …] [--http host:port]
escpos-emulator render job.bin [--paper 58] [--type dot] [--json]   # offline, no server
escpos-emulator send   job.bin 127.0.0.21[:9100]                   # what any POS app does
escpos-emulator profiles
```

From a checkout, use `node dist/cli.js …` after `npm run build`, or `npx tsx src/cli.ts …` without building.

HTTP API, for scripts and CI:

```bash
curl --data-binary @job.bin http://127.0.0.1:9180/api/printers/front-desk/print
curl http://127.0.0.1:9180/api/jobs                  # newest first
curl http://127.0.0.1:9180/api/jobs/<id>             # with the decoded command trace
curl -O http://127.0.0.1:9180/api/jobs/<id>/raw      # the exact bytes
curl -X POST -d '{"mode":"offline"}' http://127.0.0.1:9180/api/printers/front-desk/mode
curl -X POST -d '{"paperOut":true}'  http://127.0.0.1:9180/api/printers/front-desk/status
```

Printer ids are the slugified `name` unless you set `id`.

## Library use

The interpreter has no server dependencies, so you can render ESC/POS bytes in your own tests:

```ts
import { EscPosPrinter, resolveProfile } from "escpos-printer-emulator";

const printer = new EscPosPrinter(resolveProfile({ paper: 80 }));
printer.beginJob();
printer.write(bytesFromYourApp);
const job = printer.endJob();

expect(job.warnings).toEqual([]);
expect(job.text).toContain("TOTAL");
expect(job.tickets.at(-1)?.cut).toBe("full");
```

`EmulatedPrinter`, `JobStore` and `startWebServer` are exported too, for running printers in-process.

## What is emulated

The common Epson ESC/POS command set, plus the variants popular clones use:

- **Text**: `ESC @`, `ESC !`, `GS !` (1–8×), `ESC E`/`ESC G` bold, `ESC -` underline (1/2 dot), `GS B` reverse, `ESC M` fonts A/B/C, `ESC V` 90° rotation, `ESC {` upside-down, `ESC SP` spacing, `ESC r` red.
- **Code pages**: `ESC t n` with the Epson numbering most libraries' default profile uses (CP437 = 0, CP850 = 2, CP1252 = 16, CP866 = 17, CP858 = 19, …). `ESC R` for a few international sets. **Kanji**: `FS &` / `FS .`, GBK double-byte, `FS !`, `FS S`, `FS W`.
- **Layout**: `ESC a` (latched by the first character on a line, as in firmware), `ESC $`, `ESC \`, `HT`/`ESC D`, `GS L` / `GS W` margins, automatic wrapping at the print-area edge, `LF`, `ESC d`, `ESC J`, `ESC 2`/`ESC 3`, `ESC e`.
- **Images**: `ESC *` (m = 0, 1, 32, 33, mixed into the text line), `GS v 0` (with ×2 modes), `GS ( L` / `GS 8 L` graphics (store and print), `GS *` + `GS /`, `FS q` + `FS p` NV images (kept for the session), `ESC &` + `ESC %` user-defined characters.
- **Symbols**: `GS ( k` QR (model, module size, error correction, store, print), PDF417, DataMatrix, Aztec, MaxiCode. `GS k` UPC-A/E, EAN-13/8, CODE39, ITF, CODABAR, CODE93, CODE128 (with `{A`/`{B`/`{C` sets), plus `GS H`/`GS f`/`GS h`/`GS w` HRI and dimensions.
- **Paper**: `GS V` (all modes, including feed-and-cut), `ESC i`/`ESC m`. Cuts happen at the **blade**, `cutterOffsetMm` above the head, so content not fed past the blade appears at the top of the next ticket, as on real paper.
- **Peripherals**: `ESC p` / `DLE DC4` cash drawer, `ESC B` beeper (Xprinter/Bixolon-style clones), `ESC ( A` (Epson).
- **Status**: `DLE EOT 1–4`, `GS r`, `GS I` (printer ID), `GS a` ASB, `ESC u`/`ESC v`. Replies go back on the socket.
- **Page mode**: `ESC L`, `ESC W`, `GS $`, `GS \`, `FF`, `ESC FF`, `CAN`, `ESC S` (left-to-right direction only).
- **Firmware behaviour**:
  - State persists between jobs, so a job that skips `ESC @` inherits the previous job's styles.
  - Bytes left without a final `LF` print with the next job.
  - Commands split across TCP packets are reassembled.
  - One connection is served at a time and the rest queue.
  - On the dot-matrix profile, `GS v 0`, `GS ( k`, `GS k` and 24-dot `ESC *` are **not supported**. The head drops the command and prints its data as characters, as a real impact printer does. Send impact heads 8-dot `ESC *` images instead.

Not emulated: macros (`GS :`), page-mode rotation (`ESC T` ≠ 0), multi-tone graphics beyond the first plane, and printing NV graphics by key code (shown as a placeholder box).

## Project layout

```
src/core/      interpreter, profiles, code pages, symbol encoders, shared types (no server deps)
src/server/    TCP printers, job store, HTTP + SSE API, config
src/cli.ts     the escpos-emulator command
web/           the viewer: React + Vite + TypeScript
tools/         sample generator and its small ESC/POS builder
test/          node:test suites (run through tsx)
```

## Tests and samples

```bash
npm test             # interpreter, TCP and HTTP behaviour
npm run typecheck    # server and viewer
npm run samples      # rebuild samples/*.bin
```

`samples/` holds a printer test page, a receipt that uses every common feature (raster and column images, double size, reverse, CP1252, QR, CODE128, drawer kick, beep, partial cut), and an order ticket encoded for a dot-matrix head. They are generated by `tools/generate-samples.ts`.

## Display list

`src/core/interpreter.ts` produces, per job, `tickets[]` of positioned elements in profile units (typed in `src/core/types.ts`). The viewer (`web/src/lib/render.ts`) turns them into pixels using `profile.unitMm`:

| `t`     | Fields                                                                                   |
| ------- | ---------------------------------------------------------------------------------------- |
| `text`  | `x y chars adv gw gh font bold ul rev rot up red`, a run of same-style characters        |
| `bits`  | `x y bw bh sx sy data` (base64, MSB-first rows), for images, QR and other 2D symbols     |
| `bars`  | `x y h mw sbs` (bar/space module widths), for linear barcodes                            |
| `box`   | `x y w h label`, a placeholder for something only real hardware has (NV logos by key)    |

## License

[MIT](LICENSE)

# ESC/POS Printer Emulator

[![npm](https://img.shields.io/npm/v/escpos-printer-emulator)](https://www.npmjs.com/package/escpos-printer-emulator)
[![license](https://img.shields.io/npm/l/escpos-printer-emulator)](LICENSE)

A fake network receipt printer for developing and testing ESC/POS printing without hardware.

It listens on a printer's **IP and port** (raw TCP, port 9100 by default, also known as RAW or JetDirect printing) and shows a live picture of what the printer would print. It interprets the ESC/POS byte stream the way printer firmware does, so mistakes in your bytes show up the way they would on paper.

Anything that can print to a network receipt printer works: POS and restaurant apps, QZ Tray, CUPS raw queues, Windows "Generic / Text Only" ports, and libraries such as `escpos-php`, `python-escpos`, `node-thermal-printer` or `esc_pos_utils`.

```
your app / driver / library ──raw TCP──▶ 127.0.0.21:9100   ← this emulator
                                                │
                                                ▼
                                http://127.0.0.1:9180  live viewer (React)
```

**Contents:** [Quick start](#quick-start) · [Config](#config) · [The viewer](#the-viewer) · [CLI](#cli) · [HTTP API](#http-api) · [Library](#library) · [What is emulated](#what-is-emulated)

## Quick start

Requires Node.js 20 or later. No install needed:

```bash
npx escpos-printer-emulator start        # one 80mm printer on 127.0.0.1:9100, viewer at http://127.0.0.1:9180
```

Then point your app's network printer at `127.0.0.1`, port `9100`, and print. To check it without an app, send a built-in sample from another terminal:

```bash
npx escpos-printer-emulator send --sample receipt-80 127.0.0.1
```

For several printers, create a `printers.json` in the current directory (see [Config](#config)) and run `start` again. To keep it in a project, install it as a dev dependency:

```bash
npm install --save-dev escpos-printer-emulator
npx escpos-emulator start                # the command is escpos-emulator once installed
```

### From source

```bash
git clone https://github.com/sangatsharma/escpos-printer-emulator.git
cd escpos-printer-emulator
npm install
npm run build                            # compiles the server and the viewer into dist/
cp printers.example.json printers.json   # edit names / IPs / paper widths
npm start                                # → viewer at http://127.0.0.1:9180
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
escpos-emulator start \
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

## Reference

Three ways to drive the emulator: the **CLI**, the **HTTP API** (with a live event stream) and the **JavaScript/TypeScript library**.

### CLI

Installed, the command is `escpos-emulator`. Without installing, use `npx escpos-printer-emulator` in its place. From a checkout, use `node dist/cli.js` after `npm run build`, or `npx tsx src/cli.ts` without building.

| Command | What it does |
| ------- | ------------ |
| `escpos-emulator start [options]` | Starts every configured printer and the live viewer. This is the default when no command is given. |
| `escpos-emulator render <input> [options]` | Interprets a job offline (no server) and prints a text rendition, events and warnings in the terminal. |
| `escpos-emulator send <input> <host[:port]>` | Sends a job to a printer over raw TCP, the way a POS app does. Port defaults to 9100. Prints any status reply the printer sends back. |
| `escpos-emulator samples` | Lists the built-in sample jobs. |
| `escpos-emulator profiles` | Lists the printer profiles and their widths. |
| `escpos-emulator help` | Shows usage (also `-h` / `--help`). |

**Input** for `render` and `send` is one of:

| Input | Meaning |
| ----- | ------- |
| `path/to/job.bin` | A file of raw ESC/POS bytes |
| `-` | Bytes from stdin |
| `--sample <name>` / `-s <name>` | A built-in sample: `test-print-80`, `test-print-58`, `receipt-80`, `receipt-58`, `order-impact` |

**Options**

| Option | Used by | Meaning |
| ------ | ------- | ------- |
| `--config <file>` / `-c` | `start` | Config file. Default: `./printers.json` if present |
| `--printer <spec>` / `-p` | `start` | Defines a printer; repeat for several. Replaces the config file's printers. See [printer spec](#printer-spec) |
| `--http <host:port>` | `start` | Viewer and API address. Default `127.0.0.1:9180` |
| `--paper <mm>` | `render` | Paper width: 58, 72, 80 (thermal) or 58, 76 (dot matrix) |
| `--type <thermal\|dot>` | `render` | Printer type. Anything containing `dot` or `impact` means dot matrix |
| `--profile <id>` | `render` | A profile id from `profiles`; overrides `--paper` and `--type` |
| `--json` | `render` | Prints the full result as JSON (elements, events, warnings, command trace) |

#### Printer spec

`--printer` takes comma-separated `key=value` pairs using the same keys as a `printers.json` entry (see [Config](#config)): `id`, `name`, `host`, `port`, `paper`, `type`, `profile`, `cutterOffsetMm`, `kanjiDefault`, `rasterHonoursAlign`, `idleMs`.

#### Examples

```bash
escpos-emulator start                                            # one 80mm printer on 127.0.0.1:9100
escpos-emulator start -p name=Kitchen,host=127.0.0.21,paper=58 -p name=Bar,port=9101,type=dot
escpos-emulator start --config ./my-printers.json --http 0.0.0.0:8080

escpos-emulator send --sample receipt-80 127.0.0.21
escpos-emulator send job.bin 127.0.0.21:9100
printf '\x1b@Hello\n\x1dVA\x03' | escpos-emulator send - 127.0.0.21           # escapes: ESC @, text, GS V cut
echo '1b 40 48 69 0a 1d 56 41 03' | xxd -r -p | escpos-emulator send - 127.0.0.21   # hex bytes
printf '%s' 'H4sI…' | base64 -d | gunzip | escpos-emulator send - 127.0.0.21       # base64 + gzip payload

escpos-emulator render --sample order-impact --type dot
escpos-emulator render job.bin --paper 58 --json > job.json
```

### HTTP API

Served on the viewer's address (default `http://127.0.0.1:9180`). Request and response bodies are JSON unless noted. Errors return `{ "error": "message" }` with status 400 (bad input), 404 (unknown printer or job) or 409 (printer busy with a network job).

A printer's `:id` is its `id` from the config, or else its `name` in lowercase with dashes (`"Front desk (80mm)"` → `front-desk-80mm`). `GET /api/printers` lists them.

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/printers` | | All printers: address, profile, mode, status flags, busy/queued |
| `GET` | `/api/printers/:id` | | One printer |
| `POST` | `/api/printers/:id/print` | Raw ESC/POS bytes | `{ id, warnings, text }`. Prints as if sent over TCP |
| `POST` | `/api/printers/:id/mode` | `{ "mode": "online" \| "offline" \| "hang" }` | The printer. `offline` refuses connections, `hang` accepts but never reads |
| `POST` | `/api/printers/:id/status` | Any of `{ "paperOut", "paperNearEnd", "coverOpen", "drawerOpen", "offline": boolean }` | The printer. Changes status replies (`DLE EOT`, `GS r`, ASB) |
| `GET` | `/api/jobs?printer=:id` | | Jobs, newest first, without the command trace. `printer` is optional |
| `DELETE` | `/api/jobs?printer=:id` | | Deletes all jobs, or one printer's |
| `GET` | `/api/jobs/:id` | | One job, including the decoded command `trace` |
| `GET` | `/api/jobs/:id/raw` | | The exact bytes received (`application/octet-stream`) |
| `POST` | `/api/jobs/:id/replay` | | `{ id }` of the new job. Prints the same bytes again |
| `DELETE` | `/api/jobs/:id` | | Deletes one job |
| `GET` | `/events` | | Live [event stream](#live-events) |

A job has `id`, `printerId`, `printerName`, `address`, `from`, `profile`, `startedAt`, `endedAt`, `bytes`, `rawSize`, `tickets` (the [display list](#display-list)), `events` (cut, beep, drawer, selftest), `warnings`, `text` (plain-text rendition) and, from `GET /api/jobs/:id` only, `trace`.

```bash
curl --data-binary @job.bin http://127.0.0.1:9180/api/printers/front-desk/print
curl -s http://127.0.0.1:9180/api/jobs | jq '.[0].warnings'
curl -O -J http://127.0.0.1:9180/api/jobs/<id>/raw
curl -X POST -d '{"mode":"offline"}' http://127.0.0.1:9180/api/printers/front-desk/mode
curl -X POST -d '{"paperOut":true}'  http://127.0.0.1:9180/api/printers/front-desk/status
curl -X DELETE http://127.0.0.1:9180/api/jobs
```

#### Live events

`GET /events` is a [server-sent event](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream; the viewer uses it. Each event's `data` is JSON:

| Event | Data | Sent when |
| ----- | ---- | --------- |
| `job` | The job (no trace) | A job finishes printing |
| `printer` | The printer | Its mode, status flags, listening state or queue changes |
| `probe` | `{ printerId, from, at, kind?, ms?, bytes? }` | A connection printed nothing: a reachability check, or a status-only poll (`kind: "status"`) |
| `removed` | `{ id }` | A job was deleted |
| `cleared` | `{ printerId }` (`null` = all) | Jobs were cleared |

```bash
curl -N http://127.0.0.1:9180/events
```

The API sends no CORS headers, so browser pages on other origins can't read it; scripts, servers and `curl` can. This keeps arbitrary websites you visit from reading your printed receipts.

### Library

```bash
npm install --save-dev escpos-printer-emulator
```

ESM only, with TypeScript types included. The interpreter has no server dependencies, so you can check your ESC/POS output in unit tests:

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

Or run printers and the viewer inside your own process, e.g. for integration tests:

```ts
import { EmulatedPrinter, JobStore, startWebServer } from "escpos-printer-emulator";

const printer = new EmulatedPrinter({ id: "test", name: "Test", host: "127.0.0.1", port: 9100, paper: 80 });
printer.on("job", (job) => console.log(job.text, job.warnings));
await printer.start();

// Optional: the viewer and HTTP API
await startWebServer({ host: "127.0.0.1", port: 9180, printers: [printer], store: new JobStore("./data") });
```

**Exports**

| Export | Description |
| ------ | ----------- |
| `EscPosPrinter` | The interpreter. `new EscPosPrinter(profile, options?)` |
| `resolveProfile({ profile?, paper?, type? })` | Returns a `Profile` for a paper width and type, or a profile id |
| `PROFILES` | All profile definitions by id |
| `EmulatedPrinter` | One network printer: a TCP listener plus an interpreter |
| `JobStore` | Job history on disk: `new JobStore(dataDir, { limit? })` |
| `startWebServer(options)` | The viewer, HTTP API and event stream. Resolves to a Node `http.Server` |
| `loadConfig(options?)` / `parsePrinterSpec(spec)` | Config loading the way the CLI does it |
| Types | `JobResult`, `Job`, `Ticket`, `Element`, `JobEvent`, `Profile`, `PrinterSummary`, `PrinterConfig`, … |

**`EscPosPrinter`**

| Member | Description |
| ------ | ----------- |
| `constructor(profile, { respond?, kanjiDefault?, rasterHonoursAlign?, cutterOffsetMm? })` | `respond(bytes)` receives status replies (`DLE EOT`, `GS r`, `GS I`, ASB) |
| `beginJob()` | Starts a job. `write` starts one automatically if needed |
| `write(bytes: Uint8Array)` | Feeds bytes. Call as often as you like; commands split across calls are reassembled |
| `endJob(): JobResult` | Finishes the job: `{ tickets, events, warnings, text, trace, bytes, startedAt, endedAt }` |
| `status` | Status flags: `paperOut`, `paperNearEnd`, `coverOpen`, `drawerOpen`, `offline` |
| `statusChanged()` | Call after changing `status` to send ASB to a host that enabled it |

Printer state (styles, code page, NV images, unprinted line) carries over between jobs, as on hardware.

**`EmulatedPrinter`**

| Member | Description |
| ------ | ----------- |
| `constructor(config, { idleMs? })` | `config` is a `printers.json` entry with `id`, `name`, `host` and `port` set |
| `start()` / `stop()` | Opens or closes the TCP listener. `start` never rejects: on failure it sets `error` (e.g. address not available) |
| `setMode("online" \| "offline" \| "hang")` | As in the viewer's printer controls |
| `setStatus({ paperOut?, … })` | Changes status flags |
| `inject(bytes, from?)` | Prints bytes directly, without TCP. Throws if a network job is in progress |
| `summary()` | Snapshot for display: address, profile, mode, status, busy, queued |
| Events | `job` (`Job`), `probe` (`Probe`), `change` |

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

`samples/` (also shipped in the npm package, for `--sample`) holds a printer test page, a receipt that uses every common feature (raster and column images, double size, reverse, CP1252, QR, CODE128, drawer kick, beep, partial cut), and an order ticket encoded for a dot-matrix head. They are generated by `tools/generate-samples.ts`.

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

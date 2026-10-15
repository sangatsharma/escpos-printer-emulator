#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { EscPosPrinter } from "./core/interpreter.js";
import { PROFILES, resolveProfile } from "./core/profiles.js";
import { DEFAULT_HTTP, DEFAULT_PRINTER_PORT, loadConfig } from "./server/config.js";
import { EmulatedPrinter } from "./server/printer-server.js";
import { JobStore } from "./server/store.js";
import { startWebServer } from "./server/web-server.js";

/** Sample jobs shipped with the package; one level up from both src/ and dist/. */
const SAMPLES_DIR = fileURLToPath(new URL("../samples/", import.meta.url));

const HELP = `ESC/POS network printer emulator

Usage
  escpos-emulator start   [--config printers.json] [--printer key=val,…]… [--http host:port]
  escpos-emulator render  <file.bin | - | --sample name> [--paper 80] [--type thermal|dot] [--profile id] [--json]
  escpos-emulator send    <file.bin | - | --sample name> <host[:port]>
  escpos-emulator samples
  escpos-emulator profiles

start     Listen as every configured printer and open the live viewer.
          Reads ./printers.json when present.
          --printer may repeat; keys: name host port paper type profile
          kanjiDefault cutterOffsetMm rasterHonoursAlign
render    Interpret a captured job offline and print the text rendition.
send      Send a file to a printer over raw TCP (port ${DEFAULT_PRINTER_PORT} by default),
          the way any POS app or print spooler does.
samples   List the built-in sample jobs for --sample.

Input     A file path, - for stdin, or --sample <name>.

Examples
  escpos-emulator start --printer name=Kitchen,host=127.0.0.21 --printer name=Bar,host=127.0.0.22,paper=58
  escpos-emulator start --printer name=Desk,port=9101
  escpos-emulator send --sample receipt-80 127.0.0.21
  printf 'Hello\\n\\035VA\\003' | escpos-emulator send - 127.0.0.21
`;

type Values = {
  config?: string;
  printer?: string[];
  http?: string;
  paper?: string;
  type?: string;
  profile?: string;
  sample?: string;
  json?: boolean;
  help?: boolean;
};

function listSamples(): string[] {
  if (!existsSync(SAMPLES_DIR)) return [];
  return readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".bin"))
    .map((f) => f.slice(0, -4))
    .sort();
}

/** The job bytes: a built-in sample, stdin ("-"), or a file. */
function readInput(file: string | undefined, sample: string | undefined): Buffer {
  if (sample) {
    const path = join(SAMPLES_DIR, `${sample.replace(/\.bin$/, "")}.bin`);
    if (!existsSync(path)) throw new Error(`Unknown sample "${sample}". Available: ${listSamples().join(", ")}`);
    return readFileSync(path);
  }
  if (!file) throw new Error("No input: give a file, - for stdin, or --sample <name>");
  return readFileSync(file === "-" ? 0 : file);
}

function log(msg: string): void {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

async function start(values: Values): Promise<void> {
  const [httpHost, httpPort] = values.http ? values.http.split(":") : [];
  const config = loadConfig({
    configPath: values.config ? resolve(values.config) : undefined,
    printerSpecs: values.printer ?? [],
    http: values.http
      ? { host: httpHost || DEFAULT_HTTP.host, port: Number(httpPort || DEFAULT_HTTP.port) }
      : undefined,
  });

  const store = new JobStore(config.dataDir);
  const printers = config.printers.map((p) => new EmulatedPrinter(p, { idleMs: config.idleMs }));

  await Promise.all(printers.map((p) => p.start()));

  for (const p of printers) {
    p.on("job", (job) => {
      const tickets = job.tickets.length;
      log(
        `${p.name}: job from ${job.from} — ${job.bytes} bytes, ${tickets} ticket${tickets === 1 ? "" : "s"}${job.warnings.length ? `, ${job.warnings.length} warning(s)` : ""}`,
      );
      for (const w of job.warnings) log(`   ⚠ ${w}`);
    });
    p.on("probe", (probe) => log(`${p.name}: ${probe.kind === "status" ? "status query" : "connection test"} from ${probe.from}`));
  }

  await startWebServer({ ...config.http, printers, store, log });

  console.log("");
  console.log(`  Config:  ${config.path ?? "(none — using --printer flags / defaults)"}`);
  console.log(`  Jobs:    ${store.dir}`);
  console.log(`  Viewer:  http://${config.http.host}:${config.http.port}`);
  console.log("");
  for (const p of printers) {
    const s = p.summary();
    const state = s.listening ? "listening" : "NOT LISTENING";
    console.log(`  ${s.name.padEnd(18)} ${`${s.host}:${s.port}`.padEnd(22)} ${s.profile.id.padEnd(12)} ${state}`);
    if (s.error) console.log(`     ↳ ${s.error}`);
  }
  console.log("");
  console.log("  Point your app's network/raw printer at one of the addresses above.");
  console.log("");

  const shutdown = async () => {
    await Promise.all(printers.map((p) => p.stop()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function render(data: Buffer, values: Values): void {
  const profile = resolveProfile({ profile: values.profile, paper: values.paper, type: values.type });
  const printer = new EscPosPrinter(profile, {
    respond: (b) => console.error(`(status reply ${[...b].map((x) => x.toString(16)).join(" ")})`),
  });
  printer.beginJob();
  printer.write(data);
  const job = printer.endJob();
  if (values.json) {
    console.log(JSON.stringify({ ...job, profile }, null, 2));
    return;
  }
  const width = Math.round(profile.widthUnits / profile.fonts.A.w);
  console.log(`┌${"─".repeat(width + 2)}┐  ${profile.id}`);
  for (const line of job.text.split("\n")) console.log(`│ ${line.padEnd(width)} │`);
  console.log(`└${"─".repeat(width + 2)}┘`);
  for (const { type, y: _y, ...detail } of job.events) console.log(`  event: ${type} ${JSON.stringify(detail)}`);
  for (const w of job.warnings) console.log(`  ⚠ ${w}`);
}

function send(data: Buffer, target: string): Promise<void> {
  const [host = "127.0.0.1", port = String(DEFAULT_PRINTER_PORT)] = target.split(":");
  return new Promise((resolveSend, reject) => {
    const socket = connect(Number(port), host, () => {
      socket.end(data, () => log(`sent ${data.length} bytes to ${host}:${port}`));
    });
    socket.on("data", (b) => log(`printer replied: ${[...b].map((x) => x.toString(16).padStart(2, "0")).join(" ")}`));
    socket.on("close", () => resolveSend());
    socket.on("error", reject);
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      printer: { type: "string", short: "p", multiple: true },
      http: { type: "string" },
      paper: { type: "string" },
      type: { type: "string" },
      profile: { type: "string" },
      sample: { type: "string", short: "s" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "start", ...args] = positionals;

  if (values.help || command === "help") return console.log(HELP);
  if (command === "start") return start(values);
  if (command === "render") {
    return render(readInput(args[0], values.sample), values);
  }
  if (command === "send") {
    // With --sample the only positional is the target.
    const [file, target] = values.sample ? [undefined, args[0]] : args;
    if (!target) throw new Error("send needs <file | - | --sample name> <host[:port]>");
    return send(readInput(file, values.sample), target);
  }
  if (command === "samples") {
    for (const name of listSamples()) console.log(name);
    return;
  }
  if (command === "profiles") {
    for (const [id, p] of Object.entries(PROFILES)) {
      console.log(
        `${id.padEnd(12)} ${p.kind.padEnd(8)} ${p.paperMm}mm paper, ${Math.round(p.widthUnits)} units, Font A ${Math.round(p.widthUnits / p.fonts.A.w)} cpl`,
      );
    }
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});

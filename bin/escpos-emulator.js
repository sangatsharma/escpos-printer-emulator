#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { EscPosPrinter } from "../src/interpreter.js";
import { EmulatedPrinter } from "../src/printer-server.js";
import { PROFILES, resolveProfile } from "../src/profiles.js";
import { JobStore } from "../src/store.js";
import { startWebServer } from "../src/web-server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `ESC/POS network printer emulator

Usage
  escpos-emulator start   [--config printers.json] [--printer key=val,…]… [--http host:port]
  escpos-emulator render  <file.bin> [--paper 80] [--type thermal|dot] [--profile id] [--json]
  escpos-emulator send    <file.bin> <host[:port]>
  escpos-emulator profiles

start     Listen as every configured printer and open the live viewer.
          --printer may repeat; keys: name host port paper type profile
          kanjiDefault cutterOffsetMm rasterHonoursAlign
render    Interpret a captured job offline and print the text rendition.
send      Send a file to a printer over raw TCP, exactly as QZ Tray does.

Examples
  escpos-emulator start --printer name=Kitchen,host=127.0.0.21 --printer name=Bar,host=127.0.0.22,paper=58
  escpos-emulator send samples/test-print-80.bin 127.0.0.21
`;

function log(msg) {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

async function start(values) {
  // A --config path is relative to the shell; everything else (printers.json,
  // dataDir) to the project.
  const configPath = values.config ? resolve(values.config) : undefined;
  process.chdir(ROOT);
  const [httpHost, httpPort] = values.http ? values.http.split(":") : [];
  const config = loadConfig({
    configPath,
    printerSpecs: values.printer ?? [],
    http: values.http ? { host: httpHost || "127.0.0.1", port: Number(httpPort || 9180) } : undefined,
  });

  const store = new JobStore(config.dataDir);
  const printers = config.printers.map((p) => new EmulatedPrinter(p, { idleMs: config.idleMs }));

  await Promise.all(printers.map((p) => p.start()));

  for (const p of printers) {
    p.on("job", (job) => {
      const tickets = job.tickets.length;
      log(`${p.name}: job from ${job.from} — ${job.bytes} bytes, ${tickets} ticket${tickets === 1 ? "" : "s"}${job.warnings.length ? `, ${job.warnings.length} warning(s)` : ""}`);
      for (const w of job.warnings) log(`   ⚠ ${w}`);
    });
    p.on("probe", (probe) => log(`${p.name}: ${probe.kind === "status" ? "status query" : "connection test"} from ${probe.from}`));
  }

  await startWebServer({ ...config.http, printers, store, log });

  console.log("");
  console.log(`  Config:  ${config.path ?? "(none — using --printer flags / defaults)"}`);
  console.log(`  Viewer:  http://${config.http.host}:${config.http.port}`);
  console.log("");
  for (const p of printers) {
    const s = p.summary();
    const state = s.listening ? "listening" : "NOT LISTENING";
    console.log(`  ${s.name.padEnd(18)} ${`${s.host}:${s.port}`.padEnd(22)} ${s.profile.id.padEnd(12)} ${state}`);
    if (s.error) console.log(`     ↳ ${s.error}`);
  }
  console.log("");
  console.log("  In RestroX: Settings → Printers → set the printer's IP to the address above.");
  console.log("");

  const shutdown = async () => {
    await Promise.all(printers.map((p) => p.stop()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function render(file, values) {
  const profile = resolveProfile({ profile: values.profile, paper: values.paper, type: values.type });
  const printer = new EscPosPrinter(profile, {
    respond: (b) => console.error(`(status reply ${[...b].map((x) => x.toString(16)).join(" ")})`),
  });
  printer.beginJob();
  printer.write(readFileSync(file));
  const job = printer.endJob();
  if (values.json) {
    console.log(JSON.stringify({ ...job, profile }, null, 2));
    return;
  }
  const width = Math.round(profile.widthUnits / profile.fonts.A.w);
  console.log(`┌${"─".repeat(width + 2)}┐  ${profile.id}`);
  for (const line of job.text.split("\n")) console.log(`│ ${line.padEnd(width)} │`);
  console.log(`└${"─".repeat(width + 2)}┘`);
  for (const ev of job.events) console.log(`  event: ${ev.type} ${JSON.stringify({ ...ev, type: undefined, y: undefined })}`);
  for (const w of job.warnings) console.log(`  ⚠ ${w}`);
}

function send(file, target) {
  const [host, port = "9100"] = target.split(":");
  const data = readFileSync(file);
  return new Promise((resolveSend, reject) => {
    const socket = connect(Number(port), host, () => {
      socket.end(data, () => log(`sent ${data.length} bytes to ${host}:${port}`));
    });
    socket.on("data", (b) => log(`printer replied: ${[...b].map((x) => x.toString(16).padStart(2, "0")).join(" ")}`));
    socket.on("close", resolveSend);
    socket.on("error", reject);
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      printer: { type: "string", short: "p", multiple: true },
      http: { type: "string" },
      paper: { type: "string" },
      type: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command = "start", ...args] = positionals;

  if (values.help || command === "help") return console.log(HELP);
  if (command === "start") return start(values);
  if (command === "render") {
    if (!args[0]) throw new Error("render needs a file");
    return render(args[0], values);
  }
  if (command === "send") {
    if (!args[1]) throw new Error("send needs <file> <host[:port]>");
    return send(args[0], args[1]);
  }
  if (command === "profiles") {
    for (const [id, p] of Object.entries(PROFILES)) {
      console.log(`${id.padEnd(12)} ${p.kind.padEnd(8)} ${p.paperMm}mm paper, ${Math.round(p.widthUnits)} units, Font A ${Math.round(p.widthUnits / p.fonts.A.w)} cpl`);
    }
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});

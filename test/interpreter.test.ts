import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { test } from "node:test";

import type { AddressInfo } from "node:net";

import { EscPosPrinter, type PrinterOptions } from "../src/core/interpreter.js";
import { resolveProfile, type ProfileSelector } from "../src/core/profiles.js";
import type { Job, Probe, TextElement } from "../src/core/types.js";
import { EmulatedPrinter } from "../src/server/printer-server.js";

const sample = (name: string) => readFileSync(new URL(`../samples/${name}`, import.meta.url));

function run(bytes: Iterable<number>, opts: PrinterOptions & { profile?: ProfileSelector } = {}) {
  const replies: number[] = [];
  const printer = new EscPosPrinter(resolveProfile(opts.profile ?? { paper: 80 }), {
    respond: (b) => replies.push(...b),
    ...opts,
  });
  printer.beginJob();
  printer.write(Buffer.from([...bytes]));
  return { job: printer.endJob(), replies, printer };
}

const ESC = 0x1b;
const GS = 0x1d;
const text = (s: string) => [...Buffer.from(s, "latin1")];

test("test page renders title, rows and a full cut", () => {
  const { job } = run(sample("test-print-80.bin"));
  assert.match(job.text, /P r i n t e r {3}T e s t/); // double width
  assert.match(job.text, /Status\s+:\s+Ready/);
  assert.match(job.text, /CP1252\s+:\s+€ £ é ü ñ/);
  assert.equal(job.tickets.length, 1);
  assert.equal(job.tickets[0].cut, "full");
  assert.deepEqual(job.warnings, []);
  assert.ok(job.events.some((e) => e.type === "beep" && e.count === 4));
});

test("thermal receipt: raster logo, QR, CODE128 and bit image all print", () => {
  const { job } = run(sample("receipt-80.bin"));
  assert.equal(job.tickets.length, 1);
  assert.equal(job.tickets[0]!.cut, "partial");
  const kinds = job.tickets[0]!.elements.map((e) => e.t);
  assert.ok(kinds.includes("bits"));
  assert.ok(kinds.includes("bars"));
  assert.match(job.text, /\[QR M: https:\/\/example\.com\/r\/INV-0042\]/);
  assert.match(job.text, /\[CODE128: INV-0042\]/);
  assert.match(job.text, /C A F É/);
  assert.match(job.text, /\$ 2 7 \. 4 0/);
  assert.ok(job.events.some((e) => e.type === "drawer"));
  assert.deepEqual(job.warnings, []);
});

test("a dot-matrix head prints GS ( k QR data as characters", () => {
  const { job } = run(sample("order-impact.bin"), { profile: { type: "dot matrix" } });
  assert.match(job.text, /this is garbage on an impact head/);
  assert.ok(job.warnings.some((w) => w.startsWith("GS ( k")));
});

test("dot matrix honours the paper width: 58mm is 32 columns, 76mm is 48", () => {
  const line = [...text("x".repeat(40)), 0x0a];
  const narrow = run(line, { profile: { type: "dot matrix", paper: 58 } }).job;
  assert.deepEqual(narrow.text.split("\n"), ["x".repeat(32), "x".repeat(8)]);
  const wide = run(line, { profile: { type: "dot matrix" } }).job;
  assert.deepEqual(wide.text.split("\n"), ["x".repeat(40)]);
  assert.equal(resolveProfile({ type: "dot matrix", paper: 58 }).id, "impact-58");
  assert.equal(resolveProfile({ type: "dot matrix", paper: 80 }).id, "impact-76");
});

test("centre alignment is latched by the first character on the line", () => {
  const { job } = run([ESC, 0x61, 1, ...text("AB"), ESC, 0x61, 0, 0x0a]);
  const el = job.tickets[0]!.elements[0]!;
  assert.equal(el.x, Math.floor((576 - 24) / 2));
});

test("GS ! 0x11 doubles both axes", () => {
  const { job } = run([GS, 0x21, 0x11, ...text("X"), 0x0a]);
  const el = job.tickets[0]!.elements[0] as TextElement;
  assert.equal(el.adv, 24);
  assert.equal(el.h, 48);
});

test("text past the print area wraps onto the next line", () => {
  const { job } = run([...text("x".repeat(50)), 0x0a]);
  assert.deepEqual(job.text.split("\n"), ["x".repeat(48), "xx"]);
});

test("code page 16 decodes CP1252, code page 0 CP437", () => {
  assert.match(run([ESC, 0x74, 16, 0x80, 0x0a]).job.text, /€/);
  assert.match(run([ESC, 0x74, 0, 0x80, 0x0a]).job.text, /Ç/);
});

test("Kanji mode reads GBK pairs; FS . turns it off", () => {
  assert.match(run([0x1c, 0x26, 0xc4, 0xe3, 0x0a]).job.text, /你/);
  assert.doesNotMatch(run([0x1c, 0x2e, 0xc4, 0xe3, 0x0a]).job.text, /你/);
});

test("DLE EOT answers with an online status byte, paper out sets bits", () => {
  const { replies, printer } = run([0x10, 0x04, 0x01]);
  assert.deepEqual(replies, [0x12]);
  printer.status.paperOut = true;
  assert.equal(printer.realtimeStatus(4), 0x72);
});

test("a command split across TCP chunks is reassembled", () => {
  const printer = new EscPosPrinter(resolveProfile({ paper: 80 }));
  printer.beginJob();
  const bytes = Buffer.from([GS, 0x76, 0x30, 0, 1, 0, 2, 0, 0xff, 0x81]);
  for (const b of bytes) printer.write(Buffer.from([b]));
  const job = printer.endJob();
  const el = job.tickets[0]!.elements[0]!;
  assert.ok(el.t === "bits");
  assert.equal(el.bw, 8);
  assert.equal(el.bh, 2);
  assert.deepEqual(job.warnings.filter((w) => !w.includes("without a cut")), []);
});

test("data without a trailing LF waits for the next job", () => {
  const printer = new EscPosPrinter(resolveProfile({ paper: 80 }));
  printer.beginJob();
  printer.write(Buffer.from("pending"));
  const first = printer.endJob();
  assert.equal(first.tickets.length, 0);
  assert.ok(first.warnings.some((w) => w.includes("print buffer")));
  printer.beginJob();
  printer.write(Buffer.from([0x0a]));
  assert.match(printer.endJob().text, /pending/);
});

test("content between blade and head rides on to the next ticket", () => {
  // One line, no feed, cut: the line sits below the blade.
  const { job } = run([...text("tail"), 0x0a, GS, 0x56, 0x00, ...text("next"), 0x0a]);
  assert.equal(job.tickets.length, 2);
  assert.ok(job.tickets[1]!.elements.some((e) => e.t === "text" && e.chars === "tail"));
});

test("TCP: a probe is not a job; bytes become one job", async () => {
  const printer = new EmulatedPrinter({ id: "t", name: "t", host: "127.0.0.1", port: 0, paper: 80 }, { idleMs: 200 });
  // Port 0 → let the OS choose, then read it back.
  await printer.start();
  const port = (printer.server!.address() as AddressInfo).port;
  const probes: Probe[] = [];
  const jobs: Job[] = [];
  printer.on("probe", (p) => probes.push(p));
  printer.on("job", (j) => jobs.push(j));

  const send = (data?: Buffer) =>
    new Promise((r) => {
      const socket = connect(port, "127.0.0.1", () => (data ? socket.end(data) : socket.end()));
      socket.on("close", r);
    });
  await send();
  await send(Buffer.from("hello\n"));
  await new Promise((r) => setTimeout(r, 50));
  await printer.stop();

  assert.equal(probes.length, 1);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0]!.text, /hello/);
});

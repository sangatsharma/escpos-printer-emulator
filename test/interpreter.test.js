import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { test } from "node:test";

import { EscPosPrinter } from "../src/interpreter.js";
import { EmulatedPrinter } from "../src/printer-server.js";
import { resolveProfile } from "../src/profiles.js";

const sample = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url));

function run(bytes, opts = {}) {
  const replies = [];
  const printer = new EscPosPrinter(resolveProfile(opts.profile ?? { paper: 80 }), {
    respond: (b) => replies.push(...b),
    ...opts,
  });
  printer.beginJob();
  printer.write(Buffer.from(bytes));
  return { job: printer.endJob(), replies, printer };
}

const ESC = 0x1b;
const GS = 0x1d;
const text = (s) => [...Buffer.from(s, "latin1")];

test("RestroX test print renders title, rows and a full cut", () => {
  const { job } = run(sample("test-print-80.bin"));
  assert.match(job.text, /P r i n t e r {3}T e s t/); // double width
  assert.match(job.text, /Status\s+: Connected & Working/);
  assert.equal(job.tickets.length, 1);
  assert.equal(job.tickets[0].cut, "full");
  assert.deepEqual(job.warnings, []);
  assert.ok(job.events.some((e) => e.type === "beep" && e.count === 4));
});

test("thermal receipt: raster logo, QR, CODE128 and bit image all print", () => {
  const { job } = run(sample("fixture-receipt-80.bin"));
  const kinds = job.tickets[0].elements.map((e) => e.t);
  assert.ok(kinds.includes("bits"));
  assert.ok(kinds.includes("bars"));
  assert.match(job.text, /\[QR M: https:\/\/restrox\.app\/pay\/INV-0042\]/);
  assert.match(job.text, /\[CODE128: INV-0042\]/);
  assert.match(job.text, /Rs 1,370\.00|R s {3}1 , 3 7 0/);
  assert.deepEqual(job.warnings, []);
});

test("a dot-matrix head prints GS ( k QR data as characters", () => {
  const { job } = run(sample("fixture-kot-impact.bin"), { profile: { type: "Dot Matrix" } });
  assert.match(job.text, /this is garbage on an impact head/);
  assert.ok(job.warnings.some((w) => w.startsWith("GS ( k")));
});

test("centre alignment is latched by the first character on the line", () => {
  const { job } = run([ESC, 0x61, 1, ...text("AB"), ESC, 0x61, 0, 0x0a]);
  const el = job.tickets[0].elements[0];
  assert.equal(el.x, Math.floor((576 - 24) / 2));
});

test("GS ! 0x11 doubles both axes", () => {
  const { job } = run([GS, 0x21, 0x11, ...text("X"), 0x0a]);
  const el = job.tickets[0].elements[0];
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
  const el = job.tickets[0].elements[0];
  assert.equal(el.t, "bits");
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
  assert.ok(job.tickets[1].elements.some((e) => e.chars === "tail"));
});

test("TCP: a probe is not a job; bytes become one job", async () => {
  const printer = new EmulatedPrinter({ id: "t", host: "127.0.0.1", port: 0, paper: 80 }, { idleMs: 200 });
  // Port 0 → let the OS choose, then read it back.
  await printer.start();
  const port = printer.server.address().port;
  const probes = [];
  const jobs = [];
  printer.on("probe", (p) => probes.push(p));
  printer.on("job", (j) => jobs.push(j));

  await new Promise((r) => connect(port, "127.0.0.1", function () { this.end(); }).on("close", r));
  await new Promise((r) => connect(port, "127.0.0.1", function () { this.end(Buffer.from("hello\n")); }).on("close", r));
  await new Promise((r) => setTimeout(r, 50));
  await printer.stop();

  assert.equal(probes.length, 1);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text, /hello/);
});

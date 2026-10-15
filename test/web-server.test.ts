import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { JobSummary, PrinterSummary, StoredJob } from "../src/core/types.js";
import { EmulatedPrinter } from "../src/server/printer-server.js";
import { JobStore } from "../src/server/store.js";
import { startWebServer } from "../src/server/web-server.js";

const dataDir = mkdtempSync(join(tmpdir(), "escpos-emu-"));
const printer = new EmulatedPrinter({ id: "desk", name: "Desk", host: "127.0.0.1", port: 0, paper: 80 });
let base = "";
let close = () => {};

before(async () => {
  const server = await startWebServer({ host: "127.0.0.1", port: 0, printers: [printer], store: new JobStore(dataDir) });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("HTTP: print, list, fetch, download and delete a job", async () => {
  const printers = (await (await fetch(`${base}/api/printers`)).json()) as PrinterSummary[];
  assert.equal(printers[0]!.id, "desk");

  const bytes = readFileSync(new URL("../samples/receipt-80.bin", import.meta.url));
  const res = await fetch(`${base}/api/printers/desk/print`, { method: "POST", body: bytes });
  assert.equal(res.status, 200);
  const { id } = (await res.json()) as { id: string };

  const list = (await (await fetch(`${base}/api/jobs`)).json()) as JobSummary[];
  assert.equal(list[0]!.id, id);
  assert.equal(list[0]!.trace, undefined);

  const full = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as StoredJob;
  assert.ok(full.trace.length > 0);
  assert.equal(full.rawSize, bytes.length);

  const raw = Buffer.from(await (await fetch(`${base}/api/jobs/${id}/raw`)).arrayBuffer());
  assert.deepEqual(raw, bytes);

  assert.equal((await fetch(`${base}/api/jobs/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${id}`)).status, 404);
});

test("HTTP: printer mode and status flags", async () => {
  const bad = await fetch(`${base}/api/printers/desk/mode`, { method: "POST", body: '{"mode":"broken"}' });
  assert.equal(bad.status, 400);

  const res = await fetch(`${base}/api/printers/desk/status`, { method: "POST", body: '{"paperOut":true}' });
  const summary = (await res.json()) as PrinterSummary;
  assert.equal(summary.status.paperOut, true);

  assert.equal((await fetch(`${base}/api/printers/nope`)).status, 404);
});

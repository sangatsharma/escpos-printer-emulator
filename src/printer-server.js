import { EventEmitter } from "node:events";
import { createServer } from "node:net";

import { EscPosPrinter } from "./interpreter.js";
import { resolveProfile } from "./profiles.js";

/**
 * One emulated network printer: a raw TCP listener on the printer's IP and
 * port (QZ Tray's `{ host, port }` config opens exactly this: connect, write
 * bytes, close).
 *
 * Like the hardware, it serves one connection at a time and queues the rest,
 * and its interpreter state carries over from job to job.
 *
 * Emits:
 *   "job"        a finished job (display list + raw bytes)
 *   "probe"      a connection that closed without sending anything — the
 *                "is the printer reachable?" check RestroX runs through
 *                `qz.socket.open/close`
 *   "change"     listening state, mode or status flags changed
 */
export class EmulatedPrinter extends EventEmitter {
  constructor(config, { idleMs = 1500 } = {}) {
    super();
    this.config = config;
    this.id = config.id;
    this.name = config.name ?? config.id;
    this.host = config.host ?? "127.0.0.1";
    this.port = Number(config.port ?? 9100);
    this.profile = resolveProfile(config);
    this.idleMs = config.idleMs ?? idleMs;
    this.mode = "online"; // online | offline | hang
    this.listening = false;
    this.error = null;
    this.queue = [];
    this.active = null;
    this.jobSeq = 0;

    this.printer = new EscPosPrinter(this.profile, {
      kanjiDefault: config.kanjiDefault,
      rasterHonoursAlign: config.rasterHonoursAlign,
      cutterOffsetMm: config.cutterOffsetMm,
      respond: (bytes) => this.reply(bytes),
    });
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      host: this.host,
      port: this.port,
      profile: {
        id: this.profile.id,
        kind: this.profile.kind,
        paperMm: this.profile.paperMm,
        printableMm: this.profile.printableMm,
        widthUnits: this.profile.widthUnits,
        unitMm: this.profile.unitMm,
      },
      mode: this.mode,
      listening: this.listening,
      error: this.error,
      status: { ...this.printer.status },
      queued: this.queue.length,
      busy: !!this.active,
    };
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      server.on("error", (error) => {
        this.listening = false;
        this.server = null;
        this.error =
          error.code === "EADDRNOTAVAIL"
            ? `${this.host} is not an address on this machine. Add it first: sudo ip addr add ${this.host}/32 dev lo  (or use 127.0.0.x, which needs no setup)`
            : error.code === "EADDRINUSE"
              ? `${this.address} is already in use (a real printer driver or another emulator?)`
              : error.code === "EACCES"
                ? `No permission to listen on ${this.address}; ports below 1024 need root.`
                : error.message;
        this.emit("change");
        resolve();
      });
      server.listen(this.port, this.host, () => {
        this.listening = true;
        this.error = null;
        this.emit("change");
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      this.listening = false;
      for (const s of [this.active?.socket, ...this.queue].filter(Boolean)) s.destroy();
      this.queue = [];
      server.close(() => resolve());
      this.emit("change");
    });
  }

  /** online: normal. offline: connection refused. hang: accept but never read. */
  async setMode(mode) {
    if (!["online", "offline", "hang"].includes(mode)) throw new Error(`Unknown mode ${mode}`);
    this.mode = mode;
    if (mode === "offline") await this.stop();
    else await this.start();
    if (mode === "online") this.next();
    this.emit("change");
  }

  setStatus(flags) {
    for (const key of Object.keys(this.printer.status)) {
      if (key in flags) this.printer.status[key] = !!flags[key];
    }
    this.printer.statusChanged();
    this.emit("change");
  }

  accept(socket) {
    socket.setNoDelay(true);
    socket.pause();
    socket.on("error", () => {});
    if (this.mode === "hang") {
      // Holds the connection open and never drains it: a jammed printer.
      this.emit("change");
      return;
    }
    this.queue.push(socket);
    this.emit("change");
    this.next();
  }

  /** Serve the next queued connection once the current one is done. */
  next() {
    if (this.active || this.mode !== "online") return;
    const socket = this.queue.shift();
    if (!socket) return;
    if (socket.destroyed) return this.next();

    const from = `${socket.remoteAddress?.replace(/^::ffff:/, "")}:${socket.remotePort}`;
    const conn = { socket, from, chunks: [], openedAt: Date.now(), timer: null, sentAny: false };
    this.active = conn;
    this.emit("change");

    const finish = () => {
      clearTimeout(conn.timer);
      if (conn.chunks.length) this.flushJob(conn);
      else if (!conn.sentAny) {
        this.emit("probe", { printerId: this.id, from, at: new Date().toISOString(), ms: Date.now() - conn.openedAt });
      }
      if (this.active === conn) this.active = null;
      this.emit("change");
      this.next();
    };

    socket.on("data", (chunk) => {
      if (!conn.chunks.length) this.printer.beginJob();
      conn.chunks.push(chunk);
      conn.sentAny = true;
      this.printer.write(chunk);
      // Some hosts keep the socket open between jobs; treat a pause as the end.
      clearTimeout(conn.timer);
      conn.timer = setTimeout(() => this.flushJob(conn), this.idleMs);
    });
    socket.on("end", () => socket.end());
    socket.on("close", finish);
    socket.resume();
  }

  reply(bytes) {
    const socket = this.active?.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write(bytes);
  }

  flushJob(conn) {
    clearTimeout(conn.timer);
    if (!conn.chunks.length) return;
    const raw = Buffer.concat(conn.chunks);
    conn.chunks = [];
    const result = this.printer.endJob();
    // Status polls (DLE EOT, GS r…) print nothing; log them like a probe
    // instead of filling the feed with empty jobs.
    if (!result.tickets.length && !result.events.length && !result.warnings.length) {
      this.emit("probe", { printerId: this.id, from: conn.from, at: new Date().toISOString(), kind: "status", bytes: raw.length });
      return;
    }
    this.emit("job", this.packJob(result, raw, conn.from));
  }

  packJob(result, raw, from) {
    this.jobSeq += 1;
    return {
      ...result,
      id: `${Date.now().toString(36)}-${this.id}-${this.jobSeq}`,
      printerId: this.id,
      printerName: this.name,
      address: this.address,
      from,
      profile: this.summary().profile,
      raw,
    };
  }

  /** Run bytes through the printer as if a client had sent them (HTTP upload, replay). */
  inject(raw, from = "upload") {
    if (this.active) throw new Error(`${this.name} is busy with a network job`);
    this.printer.beginJob();
    this.printer.write(raw);
    const job = this.packJob(this.printer.endJob(), raw, from);
    this.emit("job", job);
    return job;
  }
}

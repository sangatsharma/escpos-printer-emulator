import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";

import { EscPosPrinter } from "../core/interpreter.js";
import { resolveProfile } from "../core/profiles.js";
import type { Job, JobResult, PrinterMode, PrinterStatus, PrinterSummary, Probe, Profile } from "../core/types.js";
import type { ResolvedPrinterConfig } from "./config.js";

interface Connection {
  socket: Socket;
  from: string;
  chunks: Buffer[];
  openedAt: number;
  timer: NodeJS.Timeout | undefined;
  sentAny: boolean;
}

interface PrinterEvents {
  job: [Job];
  probe: [Probe];
  change: [];
}

const MODES: readonly PrinterMode[] = ["online", "offline", "hang"];

/**
 * One emulated network printer: a raw TCP listener on the printer's IP and
 * port, the "RAW / JetDirect / port 9100" protocol every POS app, print
 * spooler and ESC/POS library speaks: connect, write bytes, close.
 *
 * Like the hardware, it serves one connection at a time and queues the rest,
 * and its interpreter state carries over from job to job.
 *
 * Emits:
 *   "job"        a finished job (display list + raw bytes)
 *   "probe"      a connection that printed nothing: a reachability check
 *                (connect and close) or a status-only poll
 *   "change"     listening state, mode or status flags changed
 */
export class EmulatedPrinter extends EventEmitter<PrinterEvents> {
  readonly config: ResolvedPrinterConfig;
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly profile: Profile;
  readonly printer: EscPosPrinter;
  server: Server | null = null;
  mode: PrinterMode = "online";
  listening = false;
  error: string | null = null;
  private idleMs: number;
  private queue: Socket[] = [];
  private active: Connection | null = null;
  private jobSeq = 0;

  constructor(config: ResolvedPrinterConfig, { idleMs = 1500 }: { idleMs?: number } = {}) {
    super();
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.host = config.host;
    this.port = Number(config.port);
    this.profile = resolveProfile({ profile: config.profile, paper: config.paper, type: config.type });
    this.idleMs = config.idleMs ?? idleMs;

    this.printer = new EscPosPrinter(this.profile, {
      kanjiDefault: config.kanjiDefault,
      rasterHonoursAlign: config.rasterHonoursAlign,
      cutterOffsetMm: config.cutterOffsetMm,
      respond: (bytes) => this.reply(bytes),
    });
  }

  get address(): string {
    return `${this.host}:${this.port}`;
  }

  summary(): PrinterSummary {
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

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      server.on("error", (error: NodeJS.ErrnoException) => {
        this.listening = false;
        this.server = null;
        this.error =
          error.code === "EADDRNOTAVAIL"
            ? `${this.host} is not an address on this machine. Add it first: scripts/ip-alias.sh add ${this.host}  (or use 127.0.0.x, which needs no setup on Linux)`
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

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      this.listening = false;
      for (const s of [this.active?.socket, ...this.queue]) s?.destroy();
      this.queue = [];
      server.close(() => resolve());
      this.emit("change");
    });
  }

  /** online: normal. offline: connection refused. hang: accept but never read. */
  async setMode(mode: string): Promise<void> {
    if (!MODES.includes(mode as PrinterMode)) throw new Error(`Unknown mode ${mode}`);
    this.mode = mode as PrinterMode;
    if (mode === "offline") await this.stop();
    else await this.start();
    if (mode === "online") this.next();
    this.emit("change");
  }

  setStatus(flags: Partial<Record<keyof PrinterStatus, unknown>>): void {
    const status = this.printer.status;
    for (const key of Object.keys(status) as (keyof PrinterStatus)[]) {
      if (key in flags) status[key] = !!flags[key];
    }
    this.printer.statusChanged();
    this.emit("change");
  }

  private accept(socket: Socket): void {
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
  private next(): void {
    if (this.active || this.mode !== "online") return;
    const socket = this.queue.shift();
    if (!socket) return;
    if (socket.destroyed) return this.next();

    const from = `${socket.remoteAddress?.replace(/^::ffff:/, "")}:${socket.remotePort}`;
    const conn: Connection = { socket, from, chunks: [], openedAt: Date.now(), timer: undefined, sentAny: false };
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

    socket.on("data", (chunk: Buffer) => {
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

  private reply(bytes: Buffer): void {
    const socket = this.active?.socket;
    if (socket && !socket.destroyed && socket.writable) socket.write(bytes);
  }

  private flushJob(conn: Connection): void {
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

  private packJob(result: JobResult, raw: Buffer, from: string): Job {
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
  inject(raw: Buffer, from = "upload"): Job {
    if (this.active) throw new Error(`${this.name} is busy with a network job`);
    this.printer.beginJob();
    this.printer.write(raw);
    const job = this.packJob(this.printer.endJob(), raw, from);
    this.emit("job", job);
    return job;
  }
}

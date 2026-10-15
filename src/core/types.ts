/**
 * Types shared by the interpreter, the server and the web viewer. This file
 * must stay free of runtime imports so the browser bundle can use it.
 */

// ───────────────────────────── profiles ─────────────────────────────

export type ProfileKind = "thermal" | "impact";

export type FontName = "A" | "B" | "C";

export interface Cell {
  w: number;
  h: number;
}

/** `ESC * m` → [x units per column, y units per pin, pins per column]. */
export type BitImageSpec = readonly [number, number, number];

export interface ProfileDefinition {
  kind: ProfileKind;
  paperMm: number;
  printableMm: number;
  /** Width of the print area in profile units. */
  widthUnits: number;
  /** Size of one profile unit on paper. */
  unitMm: { x: number; y: number };
  fonts: Record<FontName, Cell>;
  kanji: Cell;
  defaultLineSpacing: number;
  lineSpacingUnit: number;
  feedUnit: number;
  motionUnitX: number;
  bitImage: Record<number, BitImageSpec>;
  supports: {
    raster: boolean;
    qr: boolean;
    barcode: boolean;
    cutter: boolean;
  };
}

export interface Profile extends ProfileDefinition {
  id: string;
}

/** The part of a profile the viewer needs to draw a ticket. */
export interface ProfileSummary {
  id: string;
  kind: ProfileKind;
  paperMm: number;
  printableMm: number;
  widthUnits: number;
  unitMm: { x: number; y: number };
}

// ───────────────────────────── display list ─────────────────────────────

interface Positioned {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A run of same-style characters. */
export interface TextElement extends Positioned {
  t: "text";
  chars: string;
  n: number;
  /** Font A/B/C, or K for Kanji. */
  font: FontName | "K";
  gw: number;
  gh: number;
  adv: number;
  bold: boolean;
  ul: number;
  rev: boolean;
  rot: boolean;
  red: boolean;
  up?: boolean;
}

/** A 1-bit bitmap: images, QR and other 2D symbols, user-defined characters. */
export interface BitsElement extends Positioned {
  t: "bits";
  bw: number;
  bh: number;
  sx: number;
  sy: number;
  /** Base64, MSB-first rows of ceil(bw / 8) bytes. */
  data: string;
  red: boolean;
  up?: boolean;
}

/** A linear barcode as bar/space module widths, starting with a bar. */
export interface BarsElement extends Positioned {
  t: "bars";
  mw: number;
  sbs: number[];
}

/** A placeholder for something only real hardware has (NV logos by key). */
export interface BoxElement extends Positioned {
  t: "box";
  label: string;
}

export type Element = TextElement | BitsElement | BarsElement | BoxElement;

export type CutKind = "full" | "partial";

/** The paper between two cuts. */
export interface Ticket {
  elements: Element[];
  height: number;
  cut: CutKind | null;
}

// ───────────────────────────── jobs ─────────────────────────────

export type JobEvent =
  | { type: "cut"; kind: CutKind; y: number }
  | { type: "beep"; count: number; durationMs: number; y: number }
  | { type: "drawer"; pin: number; onMs: number; offMs: number; y: number }
  | { type: "selftest"; y: number };

/** One decoded command: byte offset, command name, detail. */
export interface TraceEntry {
  o: number;
  c: string;
  d: string;
}

/** What the interpreter produces for one job. */
export interface JobResult {
  startedAt: string;
  endedAt: string;
  bytes: number;
  tickets: Ticket[];
  events: JobEvent[];
  warnings: string[];
  trace: TraceEntry[];
  /** Plain-text rendition, one line per printed line. */
  text: string;
}

/** A finished job as the printer server emits it. */
export interface Job extends JobResult {
  id: string;
  printerId: string;
  printerName: string;
  address: string;
  from: string;
  profile: ProfileSummary;
  raw: Uint8Array;
}

/** A stored job (raw bytes kept on disk). */
export interface StoredJob extends Omit<Job, "raw"> {
  rawSize: number;
}

/** A job as listed: without the bulky trace. */
export type JobSummary = Omit<StoredJob, "trace"> & { trace?: undefined };

// ───────────────────────────── printers ─────────────────────────────

export type PrinterMode = "online" | "offline" | "hang";

export interface PrinterStatus {
  offline: boolean;
  coverOpen: boolean;
  paperOut: boolean;
  paperNearEnd: boolean;
  drawerOpen: boolean;
}

export interface PrinterSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  profile: ProfileSummary;
  mode: PrinterMode;
  listening: boolean;
  error: string | null;
  status: PrinterStatus;
  queued: number;
  busy: boolean;
}

/**
 * A connection that printed nothing: either a reachability check (connect and
 * close) or a status-only poll.
 */
export interface Probe {
  printerId: string;
  from: string;
  at: string;
  kind?: "status";
  ms?: number;
  bytes?: number;
}

// ───────────────────────────── viewer events ─────────────────────────────

/** Server-sent events pushed to the viewer on `/events`. */
export interface ServerEvents {
  printer: PrinterSummary;
  job: JobSummary;
  probe: Probe;
  removed: { id: string };
  cleared: { printerId: string | null };
}

import { codePageName, decodeByte, decodeGbk, isKnownCodePage } from "./codepages.js";
import { encode2d, encodeBarcode, encodeQr } from "./symbols.js";

/**
 * An ESC/POS printer: a byte-stream interpreter with the state a real printer
 * keeps (styles, code page, margins, NV images…) and a print head that lays
 * the result out in dots, line by line, the way firmware does.
 *
 * State lives on the instance and outlives a connection, as on hardware: a job
 * that skips `ESC @` inherits whatever the previous job left behind, and bytes
 * left in the line buffer without a terminating LF are printed by the next job.
 *
 * Output per job is a list of tickets (paper between cuts) holding positioned
 * elements in profile units; see README "Display list".
 */

const NUL = 0x00;
const HT = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const DLE = 0x10;
const CAN = 0x18;
const ESC = 0x1b;
const FS = 0x1c;
const GS = 0x1d;

/** Returned by a handler when the command's bytes have not all arrived yet. */
const MORE = -1;

const TRACE_LIMIT = 4000;

/** International character sets (`ESC R n`) we substitute; others warn. */
const INTERNATIONAL = {
  1: { 0x23: "#", 0x24: "$", 0x40: "à", 0x5b: "°", 0x5c: "ç", 0x5d: "§", 0x5e: "^", 0x60: "`", 0x7b: "é", 0x7c: "ù", 0x7d: "è", 0x7e: "¨" }, // France
  2: { 0x23: "#", 0x24: "$", 0x40: "§", 0x5b: "Ä", 0x5c: "Ö", 0x5d: "Ü", 0x5e: "^", 0x60: "`", 0x7b: "ä", 0x7c: "ö", 0x7d: "ü", 0x7e: "ß" }, // Germany
  3: { 0x23: "£" }, // UK
};

function hex(b) {
  return `0x${b.toString(16).padStart(2, "0")}`;
}

/** Packs a `get(x, y)` matrix into MSB-first rows. */
function packRows(cols, rows, get) {
  const rowBytes = Math.ceil(cols / 8);
  const out = Buffer.alloc(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (get(x, y)) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out.toString("base64");
}

/** Column-format bitmap (ESC *, GS *, FS q, ESC &) → MSB-first rows. */
function columnsToRows(data, cols, bytesPerCol) {
  const pins = bytesPerCol * 8;
  return packRows(cols, pins, (x, y) => {
    const byte = data[x * bytesPerCol + (y >> 3)] ?? 0;
    return (byte & (0x80 >> (y & 7))) !== 0;
  });
}

export class EscPosPrinter {
  /**
   * @param {object} profile  from profiles.js
   * @param {object} [opts]
   * @param {(bytes: Buffer) => void} [opts.respond]  reply channel for status requests
   * @param {boolean} [opts.kanjiDefault]  Chinese-market firmware boots in Kanji mode
   * @param {boolean} [opts.rasterHonoursAlign]  Xprinter applies ESC a to GS v 0; ZKTeco does not
   * @param {number} [opts.cutterOffsetMm]  head-to-cutter distance
   */
  constructor(profile, opts = {}) {
    this.profile = profile;
    this.respond = opts.respond ?? (() => {});
    this.kanjiDefault = !!opts.kanjiDefault;
    this.rasterHonoursAlign = opts.rasterHonoursAlign ?? true;
    this.cutterOffset = Math.round(
      (opts.cutterOffsetMm ?? (profile.kind === "impact" ? 15 : 10)) /
        profile.unitMm.y,
    );

    // Survives ESC @, like flash memory.
    this.nvImages = {};
    this.status = {
      offline: false,
      coverOpen: false,
      paperOut: false,
      paperNearEnd: false,
      drawerOpen: false,
    };

    this.pending = Buffer.alloc(0);
    this.carryY = this.cutterOffset;
    this.initialise();
    this.line = this.newLine();
    this.job = null;
  }

  // ───────────────────────────── state ─────────────────────────────

  initialise() {
    const p = this.profile;
    this.s = {
      font: "A",
      bold: false,
      underline: 0,
      reverse: false,
      rotate: false,
      upsideDown: false,
      red: false,
      sx: 1,
      sy: 1,
      charSpacing: 0,
      align: "left",
      codePage: 0,
      intl: 0,
      kanji: this.kanjiDefault,
      kanjiDW: false,
      kanjiDH: false,
      kanjiUnderline: 0,
      kanjiSpacingL: 0,
      kanjiSpacingR: 0,
      userChars: false,
    };
    this.lineSpacing = p.defaultLineSpacing;
    this.leftMargin = 0;
    this.areaWidth = p.widthUnits;
    this.tabs = null; // null → every 8 characters
    this.userCharDefs = {};
    this.downloaded = null; // GS *
    this.graphics = null; // GS ( L store
    this.hri = { pos: 0, font: "A" };
    this.barcodeHeight = 162;
    this.barcodeModule = 3;
    this.qr = { model: 50, size: 3, ec: 48, data: null };
    this.sym2d = {};
    this.disabled = false;
    this.page = null;
    this.asb = 0;
  }

  newLine() {
    return { items: [], x: 0, hasData: false, align: null, upsideDown: false };
  }

  // ───────────────────────────── jobs ─────────────────────────────

  beginJob(meta = {}) {
    this.job = {
      ...meta,
      startedAt: new Date().toISOString(),
      bytes: 0,
      tickets: [],
      events: [],
      warnings: [],
      trace: [],
      text: [],
      _warned: new Set(),
    };
    this.ticket = this.newTicket();
    // Paper between the blade and the head after the last cut is the top of
    // this ticket.
    this.y = this.carryY;
    this.ticket.height = this.y;
    this.bufBase = 0;
    // Anything waiting in the line buffer from the previous job prints here.
    if (this.line.hasData) {
      this.warn(
        "The previous job left data in the print buffer without a line feed; it prints at the top of this job.",
      );
    }
  }

  newTicket() {
    return { elements: [], height: 0, cut: null };
  }

  write(chunk) {
    if (!this.job) this.beginJob();
    this.job.bytes += chunk.length;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let pos = 0;
    while (pos < buf.length) {
      const next = this.step(buf, pos);
      if (next === MORE) break;
      pos = next;
    }
    this.pending = buf.subarray(pos);
    this.bufBase = (this.bufBase ?? 0) + pos;
  }

  /** Close the job. Returns its output and leaves printer state for the next one. */
  endJob() {
    const job = this.job ?? (this.beginJob(), this.job);
    if (this.pending.length) {
      const cmd = this.describeBytes(this.pending.subarray(0, 4));
      this.warn(
        `Job ended inside a command (${cmd}…, ${this.pending.length} bytes); the printer is still waiting for the rest.`,
      );
      // A real printer would block here until the rest arrived. Drop it so one
      // bad job doesn't poison every following one.
      this.pending = Buffer.alloc(0);
    }
    if (this.line.hasData) {
      this.warn(
        "Data is still in the print buffer — nothing prints it until the next LF (the next job will).",
      );
    }
    if (this.page) this.warn("Job ended in page mode without FF; the page was not printed.");

    this.ticket.height = Math.max(this.ticket.height, this.y);
    if (this.ticket.elements.length) {
      job.tickets.push(this.ticket);
      this.carryY = 0;
    } else {
      // Only blank feed since the last cut: it stays on the roll.
      this.carryY = this.y;
    }
    const last = job.tickets[job.tickets.length - 1];
    if (last && !last.cut) {
      this.warn(
        "The job ends without a cut; on paper the next job continues on this same strip.",
      );
    }

    job.endedAt = new Date().toISOString();
    job.text = job.text.join("\n");
    delete job._warned;
    this.job = null;
    this.bufBase = 0;
    return job;
  }

  warn(message) {
    if (!this.job || this.job._warned.has(message)) return;
    this.job._warned.add(message);
    this.job.warnings.push(message);
  }

  event(type, detail = {}) {
    this.job?.events.push({ type, ...detail, y: this.y });
  }

  trace(offset, name, detail = "") {
    const t = this.job?.trace;
    if (!t || t.length >= TRACE_LIMIT) return;
    t.push({ o: offset, c: name, d: detail });
  }

  traceText(offset, text) {
    const t = this.job?.trace;
    if (!t) return;
    const last = t[t.length - 1];
    if (last && last.c === "TEXT") {
      if (last.d.length < 400) last.d += text;
      return;
    }
    this.trace(offset, "TEXT", text);
  }

  describeBytes(bytes) {
    const names = { 0x1b: "ESC", 0x1d: "GS", 0x1c: "FS", 0x10: "DLE" };
    return [...bytes]
      .map((b, i) =>
        names[b] && i === 0
          ? names[b]
          : b >= 0x20 && b < 0x7f
            ? String.fromCharCode(b)
            : hex(b),
      )
      .join(" ");
  }

  // ───────────────────────────── parser ─────────────────────────────

  /** Handles the command at `i`; returns the index after it, or MORE. */
  step(buf, i) {
    const b = buf[i];
    const off = (this.bufBase ?? 0) + i;

    // ESC = 0 deselects the printer: everything but ESC = and real-time
    // commands is ignored until it is selected again.
    if (this.disabled && !(b === ESC && buf[i + 1] === 0x3d) && b !== DLE) {
      if (i + 1 >= buf.length && b === ESC) return MORE;
      return i + 1;
    }

    switch (b) {
      case ESC:
        return this.esc(buf, i, off);
      case GS:
        return this.gs(buf, i, off);
      case FS:
        return this.fs(buf, i, off);
      case DLE:
        return this.dle(buf, i, off);
      case LF:
        this.trace(off, "LF");
        this.lineFeed();
        return i + 1;
      case CR:
        // Ignored while auto line feed is off, which is the default.
        this.trace(off, "CR");
        return i + 1;
      case HT:
        this.trace(off, "HT");
        this.tab();
        return i + 1;
      case FF:
        this.trace(off, "FF");
        if (this.page) this.printPage(true);
        return i + 1;
      case CAN:
        this.trace(off, "CAN");
        if (this.page) this.page.elements = [];
        return i + 1;
      default:
        break;
    }

    if (b < 0x20 || b === 0x7f) return i + 1;

    if (this.s.kanji && b >= 0x81 && b <= 0xfe) {
      if (i + 1 >= buf.length) return MORE;
      const ch = decodeGbk(b, buf[i + 1]);
      this.traceText(off, ch);
      this.addChar(ch, { kanji: true });
      return i + 2;
    }

    const ch = INTERNATIONAL[this.s.intl]?.[b] ?? decodeByte(b, this.s.codePage);
    this.traceText(off, ch);
    this.addChar(ch, { byte: b });
    return i + 1;
  }

  /** Bytes `i + 1 … i + n` available? */
  has(buf, i, n) {
    return i + n < buf.length;
  }

  /** The firmware drops an unsupported command's introducer and prints the rest as text. */
  unsupported(off, name, skip, why) {
    this.trace(off, name, `UNSUPPORTED on ${this.profile.id}`);
    this.warn(`${name}: ${why} — the head drops the command and prints its parameters and data as characters.`);
    return skip;
  }

  esc(buf, i, off) {
    if (!this.has(buf, i, 1)) return MORE;
    const c = buf[i + 1];
    const n = buf[i + 2];
    const s = this.s;
    const need = (k) => this.has(buf, i, k);
    const name = `ESC ${c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : hex(c)}`;

    switch (c) {
      case 0x40: // @
        this.trace(off, "ESC @", "initialise");
        this.discardLine();
        this.initialise();
        return i + 2;

      case 0x21: {
        // ! n
        if (!need(2)) return MORE;
        s.font = n & 1 ? "B" : "A";
        s.bold = !!(n & 0x08);
        s.sy = n & 0x10 ? 2 : 1;
        s.sx = n & 0x20 ? 2 : 1;
        s.underline = n & 0x80 ? 1 : 0;
        this.trace(off, "ESC !", `print mode ${hex(n)}`);
        return i + 3;
      }

      case 0x20: // SP n
        if (!need(2)) return MORE;
        s.charSpacing = n;
        this.trace(off, "ESC SP", `right spacing ${n}`);
        return i + 3;

      case 0x24: {
        // $ nL nH
        if (!need(3)) return MORE;
        const pos = (n + buf[i + 3] * 256) * this.profile.motionUnitX;
        if (pos <= this.areaWidth) this.line.x = pos;
        this.trace(off, "ESC $", `absolute position ${pos}`);
        return i + 4;
      }

      case 0x5c: {
        // \ nL nH (signed)
        if (!need(3)) return MORE;
        let rel = n + buf[i + 3] * 256;
        if (rel > 32767) rel -= 65536;
        const pos = this.line.x + rel * this.profile.motionUnitX;
        if (pos >= 0 && pos <= this.areaWidth) this.line.x = pos;
        this.trace(off, "ESC \\", `relative position ${rel}`);
        return i + 4;
      }

      case 0x25: // % n
        if (!need(2)) return MORE;
        s.userChars = !!(n & 1);
        this.trace(off, "ESC %", `user-defined chars ${s.userChars ? "on" : "off"}`);
        return i + 3;

      case 0x26: {
        // & y c1 c2 [x d1…d(y·x)]…
        if (!need(4)) return MORE;
        const y = n;
        const c1 = buf[i + 3];
        const c2 = buf[i + 4];
        let p = i + 5;
        const defs = [];
        for (let code = c1; code <= c2; code++) {
          if (p >= buf.length) return MORE;
          const x = buf[p];
          const len = x * y;
          if (p + len >= buf.length + (len === 0 ? 1 : 0)) return MORE;
          defs.push([code, x, buf.subarray(p + 1, p + 1 + len)]);
          p += 1 + len;
        }
        const table = (this.userCharDefs[s.font] ??= {});
        for (const [code, x, data] of defs) {
          table[code] = { cols: x, bytesPerCol: y, data: Buffer.from(data) };
        }
        this.trace(off, "ESC &", `define user chars ${hex(c1)}-${hex(c2)}`);
        return p;
      }

      case 0x3f: // ? n
        if (!need(2)) return MORE;
        for (const f of Object.values(this.userCharDefs)) delete f[n];
        this.trace(off, "ESC ?", `cancel user char ${hex(n)}`);
        return i + 3;

      case 0x2a: {
        // * m nL nH d1…dk
        if (!need(3)) return MORE;
        const m = n;
        const spec = this.profile.bitImage[m];
        if (!spec) {
          return this.unsupported(off, `ESC * ${m}`, i + 3, `bit image mode ${m} does not exist on this head`);
        }
        const cols = buf[i + 3] + buf[i + 4] * 256;
        const bytesPerCol = spec[2] / 8;
        const len = cols * bytesPerCol;
        if (!this.has(buf, i, 4 + len)) return MORE;
        const data = buf.subarray(i + 5, i + 5 + len);
        this.addBitImage(data, cols, bytesPerCol, spec[0], spec[1]);
        this.trace(off, "ESC *", `bit image m=${m} ${cols}×${spec[2]}`);
        return i + 5 + len;
      }

      case 0x2d: // - n
        if (!need(2)) return MORE;
        s.underline = n === 1 || n === 0x31 ? 1 : n === 2 || n === 0x32 ? 2 : 0;
        this.trace(off, "ESC -", `underline ${s.underline}`);
        return i + 3;

      case 0x32: // 2
        this.lineSpacing = this.profile.defaultLineSpacing;
        this.trace(off, "ESC 2", "default line spacing");
        return i + 2;

      case 0x33: // 3 n
        if (!need(2)) return MORE;
        this.lineSpacing = n * this.profile.lineSpacingUnit;
        this.trace(off, "ESC 3", `line spacing ${n}`);
        return i + 3;

      case 0x3d: // = n
        if (!need(2)) return MORE;
        this.disabled = !(n & 1);
        this.trace(off, "ESC =", this.disabled ? "printer deselected" : "printer selected");
        if (this.disabled) this.warn("ESC = 0 deselected the printer; data is ignored until ESC = 1.");
        return i + 3;

      case 0x44: {
        // D n1…nk NUL
        let p = i + 2;
        const stops = [];
        while (p < buf.length && buf[p] !== NUL) {
          if (stops.length < 32) stops.push(buf[p]);
          p++;
        }
        if (p >= buf.length) return MORE;
        const cell = this.cellFor(false);
        this.tabs = stops.map((k) => k * (cell.w * s.sx + s.charSpacing));
        this.trace(off, "ESC D", `tab stops ${stops.join(",") || "cleared"}`);
        return p + 1;
      }

      case 0x45: // E n
      case 0x47: // G n (double-strike prints as emphasised)
        if (!need(2)) return MORE;
        s.bold = !!(n & 1);
        this.trace(off, name, `bold ${s.bold ? "on" : "off"}`);
        return i + 3;

      case 0x4a: {
        // J n
        if (!need(2)) return MORE;
        this.printLine();
        this.y += n * this.profile.feedUnit;
        this.trace(off, "ESC J", `print and feed ${n} dots`);
        return i + 3;
      }

      case 0x4b: // K n (reverse feed, some models)
      case 0x65: {
        // e n
        if (!need(2)) return MORE;
        this.printLine();
        this.y = Math.max(0, this.y - n * this.lineSpacing);
        this.trace(off, name, `reverse feed ${n} lines`);
        this.warn("Reverse feed: most thermal heads cannot feed backwards and ignore this.");
        return i + 3;
      }

      case 0x4c: // L page mode
        this.trace(off, "ESC L", "page mode");
        this.enterPageMode();
        return i + 2;

      case 0x53: // S standard mode
        this.trace(off, "ESC S", "standard mode");
        if (this.page) this.leavePageMode();
        return i + 2;

      case 0x0c: // ESC FF: print page, stay in page mode
        this.trace(off, "ESC FF", "print page");
        if (this.page) this.printPage(false);
        return i + 2;

      case 0x57: {
        // W xL xH yL yH dxL dxH dyL dyH
        if (!need(9)) return MORE;
        const v = (k) => buf[i + 2 + k] + buf[i + 3 + k] * 256;
        const area = { x: v(0), y: v(2), w: v(4), h: v(6) };
        if (this.page) this.page.area = area;
        this.trace(off, "ESC W", `page area ${area.x},${area.y} ${area.w}×${area.h}`);
        return i + 10;
      }

      case 0x54: // T n
        if (!need(2)) return MORE;
        if (n & 3) this.warn("ESC T: page-mode print direction other than left→right is not emulated.");
        this.trace(off, "ESC T", `page direction ${n & 3}`);
        return i + 3;

      case 0x4d: // M n
        if (!need(2)) return MORE;
        s.font = n === 1 || n === 0x31 ? "B" : n === 2 || n === 0x32 ? "C" : "A";
        this.trace(off, "ESC M", `font ${s.font}`);
        return i + 3;

      case 0x52: // R n
        if (!need(2)) return MORE;
        s.intl = n;
        if (n && !INTERNATIONAL[n]) this.warn(`ESC R ${n}: international character set substitutions not emulated; showing USA.`);
        this.trace(off, "ESC R", `international set ${n}`);
        return i + 3;

      case 0x56: // V n
        if (!need(2)) return MORE;
        s.rotate = n === 1 || n === 2 || n === 0x31 || n === 0x32;
        this.trace(off, "ESC V", `90° rotation ${s.rotate ? "on" : "off"}`);
        return i + 3;

      case 0x61: // a n
        if (!need(2)) return MORE;
        s.align = { 0: "left", 0x30: "left", 1: "center", 0x31: "center", 2: "right", 0x32: "right" }[n] ?? s.align;
        this.trace(off, "ESC a", s.align);
        return i + 3;

      case 0x63: // c 3 n / c 4 n / c 5 n
        if (!need(3)) return MORE;
        this.trace(off, `ESC c ${String.fromCharCode(n)}`, `sensor/panel setting ${buf[i + 3]}`);
        return i + 4;

      case 0x64: {
        // d n
        if (!need(2)) return MORE;
        const h = this.printLine();
        this.y += Math.max(h, n * this.lineSpacing);
        this.trace(off, "ESC d", `print and feed ${n} lines`);
        return i + 3;
      }

      case 0x69: // i
      case 0x6d: // m
        this.trace(off, name, "partial cut");
        this.cut("partial", 0);
        return i + 2;

      case 0x70: {
        // p m t1 t2
        if (!need(4)) return MORE;
        const pin = n === 1 || n === 0x31 ? 5 : 2;
        const on = buf[i + 3] * 2;
        const offMs = buf[i + 4] * 2;
        this.event("drawer", { pin, onMs: on, offMs });
        this.status.drawerOpen = true;
        this.trace(off, "ESC p", `cash drawer pin ${pin} (${on}ms on, ${offMs}ms off)`);
        return i + 5;
      }

      case 0x72: // r n
        if (!need(2)) return MORE;
        s.red = n === 1 || n === 0x31;
        this.trace(off, "ESC r", s.red ? "second colour (red)" : "black");
        return i + 3;

      case 0x74: // t n
        if (!need(2)) return MORE;
        s.codePage = n;
        if (!isKnownCodePage(n)) this.warn(`ESC t ${n}: code page ${codePageName(n)} is not available; characters above 0x7F show as CP437.`);
        this.trace(off, "ESC t", `code page ${n} (${codePageName(n)})`);
        return i + 3;

      case 0x75: // u n
        if (!need(2)) return MORE;
        this.respond(Buffer.from([this.status.drawerOpen ? 0x01 : 0x00]));
        this.trace(off, "ESC u", "peripheral status → replied");
        return i + 3;

      case 0x76: // v
        this.respond(Buffer.from([this.status.paperOut ? 0x0c : this.status.paperNearEnd ? 0x03 : 0x00]));
        this.trace(off, "ESC v", "paper status → replied");
        return i + 2;

      case 0x7b: // { n
        if (!need(2)) return MORE;
        s.upsideDown = !!(n & 1);
        this.trace(off, "ESC {", `upside-down ${s.upsideDown ? "on" : "off"}`);
        return i + 3;

      case 0x42: {
        // B n t — beeper on Xprinter/Bixolon clones (what the generator sends)
        if (!need(3)) return MORE;
        this.event("beep", { count: n, durationMs: buf[i + 3] * 50 });
        this.trace(off, "ESC B", `beep ×${n}, ${buf[i + 3] * 50}ms`);
        return i + 4;
      }

      case 0x28: {
        // ESC ( A pL pH … (Epson beeper) and other length-prefixed functions
        if (!need(4)) return MORE;
        const len = buf[i + 3] + buf[i + 4] * 256;
        if (!this.has(buf, i, 4 + len)) return MORE;
        if (n === 0x41) this.event("beep", { count: buf[i + 7] ?? 1, durationMs: (buf[i + 8] ?? 0) * 100 });
        this.trace(off, `ESC ( ${String.fromCharCode(n)}`, `${len} bytes`);
        return i + 5 + len;
      }

      case 0x3c: // < return home (impact)
      case 0x55: // U n unidirectional
        if (c === 0x3c) {
          this.trace(off, name);
          return i + 2;
        }
        if (!need(2)) return MORE;
        this.trace(off, name, `${n}`);
        return i + 3;

      default:
        this.trace(off, name, "unknown");
        this.warn(`Unknown command ${name} (${hex(c)}); skipped 2 bytes. Any parameters it had print as text.`);
        return i + 2;
    }
  }

  gs(buf, i, off) {
    if (!this.has(buf, i, 1)) return MORE;
    const c = buf[i + 1];
    const n = buf[i + 2];
    const s = this.s;
    const need = (k) => this.has(buf, i, k);
    const name = `GS ${c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : hex(c)}`;
    const sup = this.profile.supports;

    switch (c) {
      case 0x21: {
        // ! n
        if (!need(2)) return MORE;
        const w = ((n >> 4) & 7) + 1;
        const h = (n & 7) + 1;
        s.sx = w;
        s.sy = h;
        this.trace(off, "GS !", `size ${w}×${h}`);
        return i + 3;
      }

      case 0x42: // B n
        if (!need(2)) return MORE;
        s.reverse = !!(n & 1);
        this.trace(off, "GS B", `reverse ${s.reverse ? "on" : "off"}`);
        return i + 3;

      case 0x24: {
        // $ nL nH (page mode vertical position)
        if (!need(3)) return MORE;
        const v = n + buf[i + 3] * 256;
        if (this.page) {
          this.printLine();
          this.y = v;
        }
        this.trace(off, "GS $", `vertical position ${v}`);
        return i + 4;
      }

      case 0x5c: {
        // \ nL nH
        if (!need(3)) return MORE;
        let v = n + buf[i + 3] * 256;
        if (v > 32767) v -= 65536;
        if (this.page) {
          this.printLine();
          this.y = Math.max(0, this.y + v);
        }
        this.trace(off, "GS \\", `relative vertical ${v}`);
        return i + 4;
      }

      case 0x28: {
        // ( x pL pH …
        if (!need(4)) return MORE;
        const fnc = n;
        const len = buf[i + 3] + buf[i + 4] * 256;
        if (fnc === 0x6b && !sup.qr) {
          return this.unsupported(off, "GS ( k", i + 3, "this head has no 2D symbol support");
        }
        if (fnc === 0x4c && !sup.raster) {
          return this.unsupported(off, "GS ( L", i + 3, "this head has no raster graphics");
        }
        if (!this.has(buf, i, 4 + len)) return MORE;
        const payload = buf.subarray(i + 5, i + 5 + len);
        if (fnc === 0x6b) this.symbol(payload, off);
        else if (fnc === 0x4c) this.graphicsCmd(payload, off, "GS ( L");
        else if (fnc === 0x41) {
          this.event("selftest", {});
          this.trace(off, "GS ( A", "test print");
          this.warn("GS ( A: self-test print requested (not rendered).");
        } else {
          this.trace(off, `GS ( ${String.fromCharCode(fnc)}`, `${len} bytes (ignored)`);
        }
        return i + 5 + len;
      }

      case 0x38: {
        // 8 L p1 p2 p3 p4 … (GS ( L with a 32-bit length)
        if (!need(6)) return MORE;
        if (n !== 0x4c) {
          this.trace(off, `GS 8 ${String.fromCharCode(n)}`, "unknown");
          return i + 3;
        }
        if (!sup.raster) return this.unsupported(off, "GS 8 L", i + 3, "this head has no raster graphics");
        const len = buf[i + 3] + buf[i + 4] * 256 + buf[i + 5] * 65536 + buf[i + 6] * 16777216;
        if (!this.has(buf, i, 6 + len)) return MORE;
        this.graphicsCmd(buf.subarray(i + 7, i + 7 + len), off, "GS 8 L");
        return i + 7 + len;
      }

      case 0x2a: {
        // * x y d1…d(x·y·8)
        if (!need(3)) return MORE;
        const x = n;
        const y = buf[i + 3];
        const len = x * y * 8;
        if (!this.has(buf, i, 3 + len)) return MORE;
        this.downloaded = { cols: x * 8, bytesPerCol: y, data: Buffer.from(buf.subarray(i + 4, i + 4 + len)) };
        this.trace(off, "GS *", `define downloaded image ${x * 8}×${y * 8}`);
        return i + 4 + len;
      }

      case 0x2f: {
        // / m
        if (!need(2)) return MORE;
        if (this.downloaded) {
          const d = this.downloaded;
          this.printBlockBitmap(d.cols, d.bytesPerCol * 8, columnsToRows(d.data, d.cols, d.bytesPerCol), n & 1 ? 2 : 1, n & 2 ? 2 : 1, true);
        } else this.warn("GS /: no downloaded bit image is defined.");
        this.trace(off, "GS /", "print downloaded image");
        return i + 3;
      }

      case 0x76: {
        // v 0 m xL xH yL yH d…
        if (!need(7)) return MORE;
        if (n !== 0x30) {
          this.trace(off, `GS v ${hex(n)}`, "unknown");
          return i + 3;
        }
        if (!sup.raster) return this.unsupported(off, "GS v 0", i + 2, "this head has no raster bit image");
        const m = buf[i + 3];
        const xb = buf[i + 4] + buf[i + 5] * 256;
        const rows = buf[i + 6] + buf[i + 7] * 256;
        const len = xb * rows;
        if (!this.has(buf, i, 7 + len)) return MORE;
        const data = buf.subarray(i + 8, i + 8 + len);
        if (this.line.hasData) {
          this.warn("GS v 0 arrived with data in the print buffer; Epson firmware ignores the raster in that case, clones print the buffer first.");
        }
        this.printBlockBitmap(xb * 8, rows, Buffer.from(data).toString("base64"), m & 1 ? 2 : 1, m & 2 ? 2 : 1, this.rasterHonoursAlign);
        this.trace(off, "GS v 0", `raster ${xb * 8}×${rows}${m ? ` mode ${m}` : ""}`);
        return i + 8 + len;
      }

      case 0x56: {
        // V m [n]
        if (!need(2)) return MORE;
        const m = n;
        if ([0, 0x30, 1, 0x31].includes(m)) {
          const kind = m === 0 || m === 0x30 ? "full" : "partial";
          this.trace(off, "GS V", `${kind} cut`);
          this.cut(kind, 0);
          return i + 3;
        }
        if (!need(3)) return MORE;
        const feed = buf[i + 3];
        const kind = m === 65 || m === 97 || m === 103 ? "full" : "partial";
        // 65/66: feed to the cutter plus n, then cut. 97/98: feed n, then cut.
        const extra = m === 65 || m === 66 || m === 103 || m === 104 ? this.cutterOffset : 0;
        this.trace(off, "GS V", `feed ${feed} and ${kind} cut (m=${m})`);
        this.cut(kind, extra + feed * this.profile.feedUnit);
        return i + 4;
      }

      case 0x4c: {
        // L nL nH
        if (!need(3)) return MORE;
        const v = (n + buf[i + 3] * 256) * this.profile.motionUnitX;
        this.leftMargin = Math.min(v, this.profile.widthUnits);
        this.areaWidth = Math.min(this.areaWidth, this.profile.widthUnits - this.leftMargin);
        this.trace(off, "GS L", `left margin ${v}`);
        return i + 4;
      }

      case 0x57: {
        // W nL nH
        if (!need(3)) return MORE;
        const v = (n + buf[i + 3] * 256) * this.profile.motionUnitX;
        this.areaWidth = Math.max(1, Math.min(v, this.profile.widthUnits - this.leftMargin));
        this.trace(off, "GS W", `print area width ${v}`);
        return i + 4;
      }

      case 0x50: // P x y
        if (!need(3)) return MORE;
        this.trace(off, "GS P", `motion units ${n},${buf[i + 3]} (layout stays in dots)`);
        return i + 4;

      case 0x48: // H n
        if (!need(2)) return MORE;
        this.hri.pos = n & 3;
        this.trace(off, "GS H", `HRI position ${["none", "above", "below", "both"][n & 3]}`);
        return i + 3;

      case 0x66: // f n
        if (!need(2)) return MORE;
        this.hri.font = n === 1 || n === 0x31 ? "B" : "A";
        this.trace(off, "GS f", `HRI font ${this.hri.font}`);
        return i + 3;

      case 0x68: // h n
        if (!need(2)) return MORE;
        this.barcodeHeight = Math.max(1, n);
        this.trace(off, "GS h", `barcode height ${n}`);
        return i + 3;

      case 0x77: // w n
        if (!need(2)) return MORE;
        if (n >= 1 && n <= 6) this.barcodeModule = n;
        this.trace(off, "GS w", `barcode module ${n}`);
        return i + 3;

      case 0x6b: {
        // k m …
        if (!need(2)) return MORE;
        if (!sup.barcode) return this.unsupported(off, "GS k", i + 2, "this head has no barcode support");
        const m = n;
        let data;
        let end;
        if (m <= 6) {
          const nul = buf.indexOf(NUL, i + 3);
          if (nul === -1) return MORE;
          data = buf.subarray(i + 3, nul);
          end = nul + 1;
        } else {
          if (!need(3)) return MORE;
          const len = buf[i + 3];
          if (!this.has(buf, i, 3 + len)) return MORE;
          data = buf.subarray(i + 4, i + 4 + len);
          end = i + 4 + len;
        }
        this.barcode(m, [...data], off);
        return end;
      }

      case 0x49: {
        // I n
        if (!need(2)) return MORE;
        const ids = {
          1: [0x20],
          0x31: [0x20],
          2: [0x02],
          0x32: [0x02],
          3: [0x10],
          0x33: [0x10],
        };
        const strs = { 65: "1.00 EMU", 66: "RESTROX-EMULATOR", 67: `ESC/POS ${this.profile.id}`, 68: "EMU00001" };
        if (ids[n]) this.respond(Buffer.from(ids[n]));
        else if (strs[n]) this.respond(Buffer.concat([Buffer.from([0x5f]), Buffer.from(strs[n], "latin1"), Buffer.from([0])]));
        this.trace(off, "GS I", `printer ID ${n} → replied`);
        return i + 3;
      }

      case 0x72: {
        // r n
        if (!need(2)) return MORE;
        const st = this.status;
        let byte = 0;
        if (n === 1 || n === 0x31) byte = (st.paperNearEnd ? 0x03 : 0) | (st.paperOut ? 0x0c : 0);
        else if (n === 2 || n === 0x32) byte = st.drawerOpen ? 0x01 : 0;
        this.respond(Buffer.from([byte]));
        this.trace(off, "GS r", `status ${n} → ${hex(byte)}`);
        return i + 3;
      }

      case 0x61: // a n (automatic status back)
        if (!need(2)) return MORE;
        this.asb = n;
        if (n) this.respond(this.asbBytes());
        this.trace(off, "GS a", `ASB ${hex(n)}`);
        return i + 3;

      case 0x62: // b n smoothing
      case 0x6a: // j n
        if (!need(2)) return MORE;
        this.trace(off, name, `${n}`);
        return i + 3;

      case 0x3a: // : macro start/end
        this.trace(off, "GS :", "macro definition (not emulated)");
        this.warn("GS : macros are not emulated; the macro body prints as normal data.");
        return i + 2;

      case 0x5e: // ^ r t m
        if (!need(4)) return MORE;
        this.trace(off, "GS ^", "execute macro (not emulated)");
        return i + 5;

      case 0x7a: // z 0 n
        if (!need(3)) return MORE;
        this.trace(off, "GS z", "online recovery wait");
        return i + 4;

      case 0x67: {
        // g 0 m nL nH / g 2 m nL nH
        if (!need(5)) return MORE;
        this.trace(off, `GS g ${n}`, "maintenance counter");
        if (n === 0x32) this.respond(Buffer.from("_0\0", "latin1"));
        return i + 6;
      }

      case 0x63: // c (print counter)
        this.trace(off, "GS c", "print counter");
        return i + 2;

      case 0x54: // T n
        if (!need(2)) return MORE;
        this.trace(off, "GS T", "print position to line start");
        if (!this.line.hasData) this.line.x = 0;
        return i + 3;

      default:
        this.trace(off, name, "unknown");
        this.warn(`Unknown command ${name} (${hex(c)}); skipped 2 bytes. Any parameters it had print as text.`);
        return i + 2;
    }
  }

  fs(buf, i, off) {
    if (!this.has(buf, i, 1)) return MORE;
    const c = buf[i + 1];
    const n = buf[i + 2];
    const s = this.s;
    const need = (k) => this.has(buf, i, k);
    const name = `FS ${c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : hex(c)}`;

    switch (c) {
      case 0x26: // &
        s.kanji = true;
        this.trace(off, "FS &", "Kanji (GBK) mode on");
        return i + 2;

      case 0x2e: // .
        s.kanji = false;
        this.trace(off, "FS .", "Kanji mode off");
        return i + 2;

      case 0x21: // ! n
        if (!need(2)) return MORE;
        s.kanjiDW = !!(n & 0x04);
        s.kanjiDH = !!(n & 0x08);
        s.kanjiUnderline = n & 0x80 ? 1 : 0;
        this.trace(off, "FS !", `Kanji print mode ${hex(n)}`);
        return i + 3;

      case 0x2d: // - n
        if (!need(2)) return MORE;
        s.kanjiUnderline = n === 1 || n === 0x31 ? 1 : n === 2 || n === 0x32 ? 2 : 0;
        this.trace(off, "FS -", `Kanji underline ${s.kanjiUnderline}`);
        return i + 3;

      case 0x53: // S n1 n2
        if (!need(3)) return MORE;
        s.kanjiSpacingL = n;
        s.kanjiSpacingR = buf[i + 3];
        this.trace(off, "FS S", `Kanji spacing ${n},${buf[i + 3]}`);
        return i + 4;

      case 0x57: // W n
        if (!need(2)) return MORE;
        s.kanjiDW = s.kanjiDH = !!(n & 1);
        this.trace(off, "FS W", `Kanji quadruple ${s.kanjiDW ? "on" : "off"}`);
        return i + 3;

      case 0x43: // C n
        if (!need(2)) return MORE;
        this.trace(off, "FS C", `Kanji code system ${n} (decoded as GBK)`);
        return i + 3;

      case 0x32: // 2 c1 c2 d1…d72
        if (!need(75)) return MORE;
        this.trace(off, "FS 2", "define Kanji user char (not emulated)");
        return i + 76;

      case 0x3f: // ? c1 c2
        if (!need(3)) return MORE;
        this.trace(off, "FS ?", "cancel Kanji user char");
        return i + 4;

      case 0x70: {
        // p n m
        if (!need(3)) return MORE;
        const m = buf[i + 3];
        const img = this.nvImages[n];
        if (img) {
          this.printBlockBitmap(img.cols, img.bytesPerCol * 8, columnsToRows(img.data, img.cols, img.bytesPerCol), m & 1 ? 2 : 1, m & 2 ? 2 : 1, true);
        } else {
          this.printPlaceholder(`NV bit image #${n}`, Math.round(this.areaWidth * 0.6), 96);
          this.warn(`FS p ${n}: NV image #${n} was never stored with FS q in this session; a real printer prints its stored logo (or nothing).`);
        }
        this.trace(off, "FS p", `print NV image #${n}`);
        return i + 4;
      }

      case 0x71: {
        // q n [xL xH yL yH d1…dk]…
        if (!need(2)) return MORE;
        let p = i + 3;
        const images = [];
        for (let k = 0; k < n; k++) {
          if (p + 3 >= buf.length) return MORE;
          const x = buf[p] + buf[p + 1] * 256;
          const y = buf[p + 2] + buf[p + 3] * 256;
          const len = x * y * 8;
          if (p + 4 + len > buf.length) return MORE;
          images.push({ cols: x * 8, bytesPerCol: y, data: Buffer.from(buf.subarray(p + 4, p + 4 + len)) });
          p += 4 + len;
        }
        this.nvImages = {};
        images.forEach((img, k) => (this.nvImages[k + 1] = img));
        this.trace(off, "FS q", `store ${n} NV image(s)`);
        return p;
      }

      case 0x67: {
        // g 1 m a1 a2 a3 a4 nL nH d… / g 2 …
        if (!need(9)) return MORE;
        const len = n === 0x31 ? buf[i + 8] + buf[i + 9] * 256 : 0;
        if (!this.has(buf, i, 9 + len)) return MORE;
        this.trace(off, `FS g ${n}`, "NV user memory (ignored)");
        return i + 10 + len;
      }

      case 0x28: {
        // ( x pL pH …
        if (!need(4)) return MORE;
        const len = buf[i + 3] + buf[i + 4] * 256;
        if (!this.has(buf, i, 4 + len)) return MORE;
        this.trace(off, `FS ( ${String.fromCharCode(n)}`, `${len} bytes (ignored)`);
        return i + 5 + len;
      }

      default:
        this.trace(off, name, "unknown");
        this.warn(`Unknown command ${name} (${hex(c)}); skipped 2 bytes.`);
        return i + 2;
    }
  }

  dle(buf, i, off) {
    if (!this.has(buf, i, 1)) return MORE;
    const c = buf[i + 1];
    const need = (k) => this.has(buf, i, k);

    if (c === 0x04) {
      // EOT n
      if (!need(2)) return MORE;
      const n = buf[i + 2];
      if (n === 7 || n === 8) {
        if (!need(3)) return MORE;
        this.respond(Buffer.from([0x12]));
        return i + 4;
      }
      const reply = this.realtimeStatus(n);
      this.respond(Buffer.from([reply]));
      this.trace(off, "DLE EOT", `status ${n} → ${hex(reply)}`);
      return i + 3;
    }
    if (c === 0x05) {
      // ENQ n
      if (!need(2)) return MORE;
      this.trace(off, "DLE ENQ", `real-time request ${buf[i + 2]}`);
      return i + 3;
    }
    if (c === 0x14) {
      // DC4 fn …
      if (!need(2)) return MORE;
      const fn = buf[i + 2];
      const size = fn === 7 ? 4 : fn === 8 ? 10 : 5;
      if (!this.has(buf, i, size - 1)) return MORE;
      if (fn === 1) {
        const pin = buf[i + 3] === 1 ? 5 : 2;
        this.event("drawer", { pin, onMs: buf[i + 4] * 100, offMs: buf[i + 4] * 100 });
        this.status.drawerOpen = true;
        this.trace(off, "DLE DC4 1", `real-time drawer pulse pin ${pin}`);
      } else if (fn === 8) {
        this.discardLine();
        this.trace(off, "DLE DC4 8", "clear buffers");
      } else {
        this.trace(off, `DLE DC4 ${fn}`, "real-time request");
      }
      return i + size;
    }
    // A bare DLE is just a byte.
    return i + 1;
  }

  realtimeStatus(n) {
    const st = this.status;
    switch (n) {
      case 1:
        return 0x12 | (st.drawerOpen ? 0x04 : 0) | (st.offline || st.paperOut || st.coverOpen ? 0x08 : 0);
      case 2:
        return 0x12 | (st.coverOpen ? 0x04 : 0) | (st.paperOut ? 0x20 : 0) | (st.offline ? 0x40 : 0);
      case 3:
        return 0x12;
      case 4:
        return 0x12 | (st.paperNearEnd ? 0x0c : 0) | (st.paperOut ? 0x60 : 0);
      default:
        return 0x12;
    }
  }

  asbBytes() {
    const st = this.status;
    return Buffer.from([
      0x10 | (st.drawerOpen ? 0x04 : 0) | (st.offline ? 0x08 : 0) | (st.coverOpen ? 0x20 : 0),
      0x00,
      (st.paperNearEnd ? 0x03 : 0) | (st.paperOut ? 0x0c : 0),
      0x0f,
    ]);
  }

  /** Replays a status change to a host that asked for ASB. */
  statusChanged() {
    if (this.asb) this.respond(this.asbBytes());
  }

  // ───────────────────────────── layout ─────────────────────────────

  cellFor(kanji) {
    return kanji ? this.profile.kanji : this.profile.fonts[this.s.font] ?? this.profile.fonts.A;
  }

  /** Puts one character into the line buffer, wrapping as the firmware does. */
  addChar(ch, { kanji = false, byte } = {}) {
    const s = this.s;
    const cell = this.cellFor(kanji);
    const sx = s.sx * (kanji && s.kanjiDW ? 2 : 1);
    const sy = s.sy * (kanji && s.kanjiDH ? 2 : 1);
    const spacing = (kanji ? s.kanjiSpacingL + s.kanjiSpacingR : s.charSpacing) * sx;

    // 90° rotation turns the cell, so width and height multipliers swap axes.
    const glyphW = s.rotate ? cell.h * sy : cell.w * sx;
    const glyphH = s.rotate ? cell.w * sx : cell.h * sy;
    const adv = glyphW + spacing;

    if (this.line.x + glyphW > this.areaWidth + 0.01) {
      if (!this.line.hasData) return; // wider than the whole line
      this.lineFeed();
    }

    this.latch();
    const userDef = !kanji && s.userChars ? this.userCharDefs[s.font]?.[byte] : null;
    if (userDef) {
      this.line.items.push({
        t: "bits",
        x: this.line.x,
        w: adv,
        h: glyphH,
        bw: userDef.cols,
        bh: userDef.bytesPerCol * 8,
        sx,
        sy,
        data: columnsToRows(userDef.data, userDef.cols, userDef.bytesPerCol),
        red: s.red,
      });
      this.line.x += adv;
      return;
    }

    const underline = s.rotate ? 0 : kanji ? s.kanjiUnderline || s.underline : s.underline;
    const style = {
      font: kanji ? "K" : s.font,
      gw: glyphW,
      gh: glyphH,
      adv,
      bold: s.bold,
      ul: underline,
      rev: s.reverse,
      rot: s.rotate,
      red: s.red,
    };
    const items = this.line.items;
    const last = items[items.length - 1];
    if (
      last &&
      last.t === "text" &&
      Math.abs(last.x + last.adv * last.n - this.line.x) < 0.01 &&
      last.font === style.font &&
      last.adv === adv &&
      last.gh === glyphH &&
      last.bold === style.bold &&
      last.ul === style.ul &&
      last.rev === style.rev &&
      last.rot === style.rot &&
      last.red === style.red
    ) {
      last.chars += ch;
      last.n += 1;
      last.w = last.adv * last.n;
    } else {
      items.push({ t: "text", x: this.line.x, h: glyphH, chars: ch, n: 1, w: adv, ...style });
    }
    this.line.x += adv;
  }

  /** ESC * data sits in the line buffer next to text. */
  addBitImage(data, cols, bytesPerCol, sx, sy) {
    let usable = cols;
    const room = Math.floor((this.areaWidth - this.line.x) / sx);
    if (usable > room) {
      this.warn(`ESC * image is ${cols * sx} dots wide but only ${room * sx} fit on the line; the rest is cut off.`);
      usable = Math.max(0, room);
    }
    if (!usable) return;
    this.latch();
    const rows = columnsToRows(data.subarray(0, usable * bytesPerCol), usable, bytesPerCol);
    this.line.items.push({
      t: "bits",
      x: this.line.x,
      w: usable * sx,
      h: bytesPerCol * 8 * sy,
      bw: usable,
      bh: bytesPerCol * 8,
      sx,
      sy,
      data: rows,
      red: this.s.red,
    });
    this.line.x += usable * sx;
  }

  /** Alignment and orientation are fixed by the first data on a line. */
  latch() {
    if (this.line.hasData) return;
    this.line.hasData = true;
    this.line.align = this.s.align;
    this.line.upsideDown = this.s.upsideDown;
  }

  tab() {
    const s = this.s;
    const cell = this.cellFor(false);
    const stops =
      this.tabs ??
      Array.from({ length: 32 }, (_, k) => (k + 1) * 8 * (cell.w * s.sx + s.charSpacing));
    const next = stops.find((p) => p > this.line.x + 0.01 && p <= this.areaWidth);
    if (next !== undefined) {
      this.latch();
      this.line.x = next;
    }
  }

  alignOffset(align, width) {
    const free = Math.max(0, this.areaWidth - width);
    if (align === "center") return Math.floor(free / 2);
    if (align === "right") return free;
    return 0;
  }

  /** Prints the line buffer without feeding. Returns its content height. */
  printLine() {
    const line = this.line;
    this.line = this.newLine();
    if (!line.items.length) return 0;

    const contentH = Math.max(...line.items.map((it) => it.h));
    const extent = Math.max(...line.items.map((it) => it.x + it.w));
    const offset = this.alignOffset(line.align, extent);

    for (const it of line.items) {
      let x = offset + it.x;
      if (line.upsideDown) x = this.areaWidth - x - it.w;
      const el = { ...it, x: this.leftMargin + x, y: this.y + (contentH - it.h) };
      if (line.upsideDown) el.up = true;
      this.place(el);
    }
    this.recordText(line.items, offset);
    return contentH;
  }

  lineFeed() {
    const h = this.printLine();
    this.y += Math.max(this.lineSpacing, h);
  }

  discardLine() {
    this.line = this.newLine();
  }

  /** A plain-text rendition of the line for logs and the Text tab. */
  recordText(items, offset) {
    if (!this.job) return;
    const unit = this.profile.fonts.A.w;
    let out = "";
    for (const it of items) {
      const col = Math.round((offset + it.x) / unit);
      if (out.length < col) out = out.padEnd(col, " ");
      if (it.t === "text") {
        const repeat = Math.max(1, Math.round(it.adv / unit));
        const text = repeat > 1 ? [...it.chars].map((c) => c + " ".repeat(repeat - 1)).join("") : it.chars;
        out = out.slice(0, col) + text + out.slice(col + text.length);
      } else {
        const w = Math.max(1, Math.round(it.w / unit));
        out = out.slice(0, col) + "▒".repeat(w) + out.slice(col + w);
      }
    }
    this.job.text.push(out.replace(/\s+$/, ""));
  }

  place(el) {
    if (this.page) {
      el.x += this.page.area.x;
      el.y += this.page.area.y;
      this.page.elements.push(el);
      this.page.bottom = Math.max(this.page.bottom, el.y + el.h);
      return;
    }
    this.ticket.elements.push(el);
    this.ticket.height = Math.max(this.ticket.height, el.y + el.h);
  }

  /** A raster/graphics/downloaded image, printed as its own block. */
  printBlockBitmap(bw, bh, data, sx, sy, honourAlign) {
    if (this.line.hasData) this.lineFeed();
    const w = bw * sx;
    const h = bh * sy;
    if (w > this.areaWidth) {
      this.warn(`An image ${w} dots wide exceeds the ${this.areaWidth}-dot print area; the right side is clipped.`);
    }
    const x = this.leftMargin + (honourAlign ? this.alignOffset(this.s.align, w) : 0);
    this.place({ t: "bits", x, y: this.y, w: Math.min(w, this.areaWidth), h, bw, bh, sx, sy, data, red: this.s.red });
    this.job?.text.push(`[image ${w}×${h}]`);
    this.y += h;
  }

  printPlaceholder(label, w, h) {
    if (this.line.hasData) this.lineFeed();
    const x = this.leftMargin + this.alignOffset(this.s.align, w);
    this.place({ t: "box", x, y: this.y, w, h, label });
    this.job?.text.push(`[${label}]`);
    this.y += h;
  }

  /** Paper between the last cut and the cutter blade becomes this ticket. */
  cut(kind, feed) {
    if (!this.profile.supports.cutter) return;
    this.printLine();
    this.y += feed;
    this.event("cut", { kind });

    const cutY = Math.max(0, this.y - this.cutterOffset);
    const current = this.ticket;
    current.height = Math.max(cutY, 1);
    current.cut = kind;
    // Whatever is between the blade and the head rides on to the next ticket.
    const carried = current.elements
      .filter((el) => el.y + el.h > cutY)
      .map((el) => ({ ...el, y: el.y - cutY }));
    current.elements = current.elements.filter((el) => el.y < cutY);
    this.job?.tickets.push(current);

    this.ticket = this.newTicket();
    this.ticket.elements = carried;
    this.y -= cutY;
    this.ticket.height = this.y;
    this.job?.text.push(kind === "full" ? "✂ ─── full cut ───" : "✂ ┄┄┄ partial cut ┄┄┄");
  }

  // ───────────────────────────── page mode ─────────────────────────────

  enterPageMode() {
    if (this.page) return;
    this.printLine();
    this.page = {
      area: { x: 0, y: 0, w: this.profile.widthUnits, h: 0 },
      elements: [],
      bottom: 0,
      savedY: this.y,
      savedArea: this.areaWidth,
    };
    this.y = 0;
  }

  printPage(leave) {
    const page = this.page;
    this.printLine();
    const height = Math.max(page.area.h, page.bottom);
    const top = page.savedY;
    this.page = null;
    for (const el of page.elements) this.place({ ...el, y: el.y + top });
    if (leave) {
      this.areaWidth = page.savedArea;
      this.y = top + height;
    } else {
      this.page = { ...page, elements: [], bottom: 0, savedY: top + height };
      this.y = 0;
    }
  }

  leavePageMode() {
    // ESC S discards unprinted page data.
    this.areaWidth = this.page.savedArea;
    this.y = this.page.savedY;
    this.page = null;
    this.discardLine();
  }

  // ───────────────────────────── symbols ─────────────────────────────

  /** `GS ( k` payload: cn fn params… */
  symbol(p, off) {
    const cn = p[0];
    const fn = p[1];
    if (cn === 0x31) {
      // QR
      switch (fn) {
        case 0x41:
          this.qr.model = p[2];
          this.trace(off, "GS ( k QR", `model ${p[2] - 48}`);
          return;
        case 0x43:
          this.qr.size = p[2];
          this.trace(off, "GS ( k QR", `module size ${p[2]}`);
          return;
        case 0x45:
          this.qr.ec = p[2];
          this.trace(off, "GS ( k QR", `error correction ${"LMQH"[p[2] - 48] ?? p[2]}`);
          return;
        case 0x50:
          this.qr.data = Buffer.from(p.subarray(3));
          this.trace(off, "GS ( k QR", `store ${this.qr.data.length} bytes: ${this.qr.data.toString("latin1").slice(0, 80)}`);
          return;
        case 0x51:
          this.trace(off, "GS ( k QR", "print");
          this.printQr();
          return;
        case 0x52:
          this.trace(off, "GS ( k QR", "transmit size information");
          return;
        default:
          this.trace(off, "GS ( k QR", `fn ${fn}`);
          return;
      }
    }

    if ([0x30, 0x32, 0x35, 0x36].includes(cn)) {
      const st = (this.sym2d[cn] ??= { module: 3, data: null });
      const label = { 0x30: "PDF417", 0x32: "MaxiCode", 0x35: "Aztec", 0x36: "DataMatrix" }[cn];
      if (fn === 0x50) {
        st.data = Buffer.from(p.subarray(3));
        this.trace(off, `GS ( k ${label}`, `store ${st.data.length} bytes`);
      } else if (fn === 0x51) {
        this.trace(off, `GS ( k ${label}`, "print");
        this.print2d(cn, label, st);
      } else {
        if (fn === 0x43) st.module = p[2] || st.module;
        if (cn === 0x30 && fn === 0x44) st.rowHeight = p[2];
        this.trace(off, `GS ( k ${label}`, `fn ${fn} = ${p[2]}`);
      }
      return;
    }

    this.trace(off, "GS ( k", `symbol cn=${cn} fn=${fn} (not emulated)`);
    this.warn(`GS ( k cn=${cn}: this 2D symbol type is not emulated.`);
  }

  printQr() {
    const qr = this.qr;
    if (!qr.data?.length) {
      this.warn("GS ( k QR print with no stored data; the printer prints nothing.");
      return;
    }
    let sym;
    try {
      sym = encodeQr(qr.data, qr.ec);
    } catch (error) {
      this.warn(`QR data could not be encoded (${error.message}); the printer prints nothing.`);
      return;
    }
    const module = Math.max(1, Math.min(16, qr.size));
    if (sym.cols * module > this.areaWidth) {
      this.warn(`QR is ${sym.cols * module} dots wide, more than the ${this.areaWidth}-dot area; the printer prints nothing.`);
      return;
    }
    this.printBlockBitmap(sym.cols, sym.rows, packRows(sym.cols, sym.rows, sym.get), module, module, true);
    this.job.text[this.job.text.length - 1] = `[QR ${sym.ec}: ${qr.data.toString("latin1")}]`;
  }

  print2d(cn, label, st) {
    if (!st.data?.length) {
      this.warn(`${label} print with no stored data.`);
      return;
    }
    let sym;
    try {
      sym = encode2d(cn, st.data);
    } catch (error) {
      this.warn(`${label} could not be encoded (${error.message}).`);
      return;
    }
    const mx = st.module;
    const my = cn === 0x30 ? (st.rowHeight || 3) * mx : mx;
    this.printBlockBitmap(sym.cols, sym.rows, packRows(sym.cols, sym.rows, sym.get), mx, my, true);
    this.job.text[this.job.text.length - 1] = `[${label}: ${st.data.toString("latin1")}]`;
  }

  barcode(m, data, off) {
    const warnings = [];
    let enc;
    try {
      enc = encodeBarcode(m, data, warnings);
    } catch (error) {
      this.trace(off, "GS k", `barcode m=${m} REJECTED`);
      this.warn(`GS k m=${m}: ${error.message.split("\n")[0]} — the printer rejects this barcode and prints nothing.`);
      return;
    }
    warnings.forEach((w) => this.warn(w));
    this.trace(off, "GS k", `${enc.name} "${enc.hri}"`);

    const mw = this.barcodeModule;
    const width = enc.sbs.reduce((a, b) => a + b, 0) * mw;
    if (width > this.areaWidth) {
      this.warn(`${enc.name} is ${width} dots wide with module width ${mw}; it does not fit the ${this.areaWidth}-dot area, so the printer skips it.`);
      return;
    }
    if (this.line.hasData) this.lineFeed();

    const x = this.leftMargin + this.alignOffset(this.s.align, width);
    const cell = this.profile.fonts[this.hri.font];
    const hriRow = (y) => {
      const w = enc.hri.length * cell.w;
      this.place({
        t: "text",
        x: this.leftMargin + this.alignOffset(this.s.align, width) + Math.max(0, (width - w) / 2),
        y,
        h: cell.h,
        chars: enc.hri,
        n: enc.hri.length,
        w,
        font: this.hri.font,
        gw: cell.w,
        gh: cell.h,
        adv: cell.w,
        bold: false,
        ul: 0,
        rev: false,
        rot: false,
        red: false,
      });
    };

    if (this.hri.pos & 1) {
      hriRow(this.y);
      this.y += cell.h;
    }
    this.place({ t: "bars", x, y: this.y, w: width, h: this.barcodeHeight, mw, sbs: enc.sbs });
    this.y += this.barcodeHeight;
    if (this.hri.pos & 2) {
      hriRow(this.y);
      this.y += cell.h;
    }
    this.job?.text.push(`[${enc.name}: ${enc.hri}]`);
  }

  // ───────────────────────────── graphics ─────────────────────────────

  /** `GS ( L` / `GS 8 L` payload: m fn … */
  graphicsCmd(p, off, label) {
    const fn = p[1];
    if (fn === 0x70 || fn === 112) {
      // m fn a bx by c xL xH yL yH d…
      const tone = p[2];
      const bx = p[3];
      const by = p[4];
      const cols = p[6] + p[7] * 256;
      const rows = p[8] + p[9] * 256;
      const rowBytes = Math.ceil(cols / 8);
      const data = Buffer.from(p.subarray(10, 10 + rowBytes * rows));
      if (tone === 0x34) this.warn(`${label}: multi-tone graphics shown as the first plane only.`);
      this.graphics = { cols, rows, sx: bx === 2 ? 2 : 1, sy: by === 2 ? 2 : 1, data: data.toString("base64") };
      this.trace(off, label, `store graphics ${cols}×${rows}`);
      return;
    }
    if (fn === 0x32 || fn === 2) {
      if (this.graphics) {
        const g = this.graphics;
        this.printBlockBitmap(g.cols, g.rows, g.data, g.sx, g.sy, true);
      } else this.warn(`${label}: print graphics with nothing stored.`);
      this.graphics = null;
      this.trace(off, label, "print stored graphics");
      return;
    }
    if (fn === 0x45 || fn === 69 || fn === 0x55 || fn === 85) {
      this.printPlaceholder("NV / download graphic (key)", Math.round(this.areaWidth * 0.6), 96);
      this.warn(`${label} fn ${fn}: printing a stored graphic by key code is shown as a placeholder.`);
    }
    this.trace(off, label, `fn ${fn} (${p.length} bytes)`);
  }
}

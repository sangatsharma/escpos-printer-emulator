import iconv from "iconv-lite";

/**
 * A small ESC/POS byte builder for the sample jobs. It emits what common
 * drivers and libraries send (Epson command set, CP1252 via `ESC t 16`), so
 * the samples exercise the same paths real apps do.
 */

export type Align = "left" | "center" | "right";

export interface Bitmap {
  width: number;
  height: number;
  get(x: number, y: number): boolean;
}

export interface Column {
  text: string;
  /** Share of the line, out of 12. */
  width: number;
  align?: Align;
}

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

const ALIGN: Record<Align, number> = { left: 0, center: 1, right: 2 };

export class EscPosBuilder {
  private out: number[] = [];
  private scale = 1;

  /** @param cpl Font A characters per line (48 on 80mm, 32 on 58mm). */
  constructor(readonly cpl: number) {}

  raw(...bytes: number[]): this {
    this.out.push(...bytes);
    return this;
  }

  /** ESC @, then CP1252 and Kanji off so Chinese-market firmware does not read GBK. */
  init(): this {
    return this.raw(ESC, 0x40, ESC, 0x74, 16, FS, 0x2e);
  }

  text(s: string): this {
    this.out.push(...iconv.encode(s, "cp1252"));
    return this;
  }

  line(s = ""): this {
    return this.text(s).raw(LF);
  }

  align(a: Align): this {
    return this.raw(ESC, 0x61, ALIGN[a]);
  }

  bold(on = true): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  underline(dots: 0 | 1 | 2 = 1): this {
    return this.raw(ESC, 0x2d, dots);
  }

  reverse(on = true): this {
    return this.raw(GS, 0x42, on ? 1 : 0);
  }

  font(f: "A" | "B"): this {
    return this.raw(ESC, 0x4d, f === "B" ? 1 : 0);
  }

  /** GS ! — 1–8× in each direction. */
  size(w: number, h = w): this {
    this.scale = w;
    return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }

  feed(lines: number): this {
    return this.raw(ESC, 0x64, lines);
  }

  hr(ch = "-"): this {
    return this.line(ch.repeat(Math.floor(this.cpl / this.scale)));
  }

  /** Fixed-width columns; text that does not fit wraps inside its column. */
  row(cols: Column[]): this {
    const total = Math.floor(this.cpl / this.scale);
    const widths = cols.map((c) => Math.floor((total * c.width) / 12));
    const chunks = cols.map((c, i) => {
      const w = widths[i]!;
      const parts: string[] = [];
      for (let k = 0; k < Math.max(1, c.text.length); k += w) parts.push(c.text.slice(k, k + w));
      return parts;
    });
    const lines = Math.max(...chunks.map((c) => c.length));
    for (let l = 0; l < lines; l++) {
      let out = "";
      cols.forEach((c, i) => {
        const w = widths[i]!;
        const s = chunks[i]![l] ?? "";
        out += c.align === "right" ? s.padStart(w) : c.align === "center" ? s.padStart((w + s.length) >> 1).padEnd(w) : s.padEnd(w);
      });
      this.line(out);
    }
    return this;
  }

  /** GS v 0 raster, MSB-first rows. */
  raster(img: Bitmap): this {
    const xb = Math.ceil(img.width / 8);
    this.raw(GS, 0x76, 0x30, 0, xb & 0xff, xb >> 8, img.height & 0xff, img.height >> 8);
    for (let y = 0; y < img.height; y++) {
      for (let bx = 0; bx < xb; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < img.width && img.get(x, y)) byte |= 0x80 >> bit;
        }
        this.out.push(byte);
      }
    }
    return this;
  }

  /**
   * ESC * column-format bands: m = 33 (24-dot double density) for thermal
   * heads, m = 0 (8-dot single density) for impact heads. Line spacing is set
   * so the bands touch.
   */
  bitImage(img: Bitmap, m: 0 | 33, bandSpacing: number): this {
    const pins = m === 33 ? 24 : 8;
    const bytesPerCol = pins / 8;
    this.raw(ESC, 0x33, bandSpacing);
    for (let top = 0; top < img.height; top += pins) {
      this.raw(ESC, 0x2a, m, img.width & 0xff, img.width >> 8);
      for (let x = 0; x < img.width; x++) {
        for (let b = 0; b < bytesPerCol; b++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const y = top + b * 8 + bit;
            if (y < img.height && img.get(x, y)) byte |= 0x80 >> bit;
          }
          this.out.push(byte);
        }
      }
      this.raw(LF);
    }
    return this.raw(ESC, 0x32);
  }

  /** GS ( k QR: model 2, module size, error correction, store, print. */
  qr(data: string, { size = 6, ec = "M" }: { size?: number; ec?: "L" | "M" | "Q" | "H" } = {}): this {
    const bytes = [...iconv.encode(data, "cp1252")];
    const len = bytes.length + 3;
    return this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 48 + "LMQH".indexOf(ec))
      .raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...bytes)
      .raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
  }

  /** GS k 73 CODE128 with HRI below. `data` includes the code set, e.g. "{BINV-0042". */
  code128(data: string, { height = 60, width = 2 }: { height?: number; width?: number } = {}): this {
    const bytes = [...Buffer.from(data, "latin1")];
    return this.raw(GS, 0x68, height, GS, 0x77, width, GS, 0x48, 2, GS, 0x6b, 73, bytes.length, ...bytes);
  }

  /** ESC B n t — the beeper on most Epson-compatible clones. */
  beep(times: number, units = 2): this {
    return this.raw(ESC, 0x42, times, units);
  }

  /** ESC p — kick the cash drawer on pin 2. */
  drawer(): this {
    return this.raw(ESC, 0x70, 0, 25, 250);
  }

  /** GS V 65/66 n — feed the paper to the cutter, then cut. */
  cut(kind: "full" | "partial" = "full", extraFeed = 0): this {
    return this.raw(GS, 0x56, kind === "full" ? 65 : 66, extraFeed);
  }

  build(): Buffer {
    return Buffer.from(this.out);
  }
}

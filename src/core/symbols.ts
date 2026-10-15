import bwipjs from "bwip-js";
import QRCode from "qrcode";

/**
 * Barcode and 2D-symbol encoders. Each returns plain geometry (bar widths or a
 * module matrix) that the interpreter scales into dots, so the viewer never
 * needs to know a symbology.
 */

export interface Matrix {
  cols: number;
  rows: number;
  get(x: number, y: number): boolean;
}

type EcLevel = "L" | "M" | "Q" | "H";

const QR_EC: Record<number, EcLevel> = { 48: "L", 49: "M", 50: "Q", 51: "H" };

/**
 * `GS ( k` QR. The printer stores the payload as bytes, so encode it in byte
 * mode rather than letting the library re-guess from a decoded string.
 */
export function encodeQr(bytes: Uint8Array, ecByte: number): Matrix & { ec: EcLevel } {
  const ec = QR_EC[ecByte] ?? "L";
  const qr = QRCode.create([{ data: Uint8Array.from(bytes), mode: "byte" }], {
    errorCorrectionLevel: ec,
  });
  const { size, data } = qr.modules;
  return { cols: size, rows: size, get: (x, y) => !!data[y * size + x], ec };
}

const BWIP_2D: Record<number, string> = {
  48: "pdf417",
  50: "maxicode",
  53: "azteccode",
  54: "datamatrix",
};

interface RawPixels {
  pixs: number[];
  pixx: number;
  pixy: number;
}

interface RawBars {
  sbs: number[];
}

/** PDF417 / MaxiCode / Aztec / DataMatrix (`GS ( k` cn 48, 50, 53, 54). */
export function encode2d(cn: number, bytes: Uint8Array): Matrix & { bcid: string } {
  const bcid = BWIP_2D[cn];
  if (!bcid) throw new Error(`2D symbol cn=${cn} is not supported`);
  const text = Buffer.from(bytes).toString("latin1");
  const [sym] = bwipjs.raw(bcid, text, {}) as RawPixels[];
  const { pixs, pixx, pixy } = sym!;
  return {
    cols: pixx,
    rows: pixy,
    get: (x, y) => !!pixs[y * pixx + x],
    bcid,
  };
}

/** `GS k` m → bwip-js symbology. Both the NUL-terminated (0-6) and counted (65-73) forms. */
const BARCODE_TYPES: Record<number, string> = {
  0: "upca",
  65: "upca",
  1: "upce",
  66: "upce",
  2: "ean13",
  67: "ean13",
  3: "ean8",
  68: "ean8",
  4: "code39",
  69: "code39",
  5: "interleaved2of5",
  70: "interleaved2of5",
  6: "rationalizedCodabar",
  71: "rationalizedCodabar",
  72: "code93",
  73: "code128",
};

export const BARCODE_NAMES: Record<string, string> = {
  upca: "UPC-A",
  upce: "UPC-E",
  ean13: "EAN-13",
  ean8: "EAN-8",
  code39: "CODE39",
  interleaved2of5: "ITF",
  rationalizedCodabar: "CODABAR",
  code93: "CODE93",
  code128: "CODE128",
};

/**
 * ESC/POS CODE128 data carries its own code-set switches: `{A` `{B` `{C`,
 * `{S` (shift), `{1`-`{4` (FNC) and `{{` (a literal brace). In set C each byte
 * is a value 0-99, not two ASCII digits. Returns the text bwip-js should encode
 * plus the human-readable string the printer would print.
 */
function parseCode128(bytes: number[], warnings: string[]): { text: string; hri: string } {
  if (bytes[0] !== 0x7b || ![0x41, 0x42, 0x43].includes(bytes[1]!)) {
    warnings.push(
      "CODE128 data must start with a code set ({A, {B or {C). Epson firmware rejects this barcode; some clones print it as {B.",
    );
    bytes = [0x7b, 0x42, ...bytes];
  }

  let set = "B";
  let text = "";
  let hri = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x7b && i + 1 < bytes.length) {
      const next = bytes[++i]!;
      if (next === 0x41 || next === 0x42 || next === 0x43) {
        set = String.fromCharCode(next);
      } else if (next >= 0x31 && next <= 0x34) {
        text += `^FNC${next - 0x30}`;
      } else if (next === 0x7b) {
        text += "{";
        hri += "{";
      }
      // `{S` shifts one character to the other set; the encoded value is the
      // same character, so just keep going.
      continue;
    }
    if (set === "C") {
      const pair = String(b).padStart(2, "0");
      text += pair;
      hri += pair;
    } else {
      const ch = String.fromCharCode(b);
      text += ch === "^" ? "^094" : ch;
      hri += b >= 0x20 && b < 0x7f ? ch : " ";
    }
  }
  return { text, hri };
}

export interface EncodedBarcode {
  /** Bar/space widths in modules, starting with a bar. */
  sbs: number[];
  hri: string;
  name: string;
}

/** Encodes `GS k` data, or throws when the printer would refuse it. */
export function encodeBarcode(m: number, bytes: number[], warnings: string[]): EncodedBarcode {
  const bcid = BARCODE_TYPES[m];
  if (!bcid) throw new Error(`Unknown barcode system m=${m}`);

  let text = Buffer.from(bytes).toString("latin1");
  let hri = text;
  const opts: Record<string, boolean> = {};

  if (bcid === "code128") {
    ({ text, hri } = parseCode128(bytes, warnings));
    opts.parsefnc = true;
  } else if (bcid === "code39") {
    // The printer adds the `*` start/stop itself when they are missing.
    text = text.replace(/^\*|\*$/g, "");
    hri = `*${text}*`;
  } else if (bcid === "upce" && text.length === 6) {
    text = `0${text}`;
  }

  const [sym] = bwipjs.raw(bcid, text, opts) as RawBars[];
  if (!sym?.sbs?.length) throw new Error("Encoder produced no bars");
  return { sbs: sym.sbs, hri, name: BARCODE_NAMES[bcid]! };
}

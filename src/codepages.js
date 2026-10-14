import iconv from "iconv-lite";

/**
 * `ESC t n` → code page, as the RestroX generator's "default" capability
 * profile numbers them (apps/web/src/utils/esc-pos/resources/capabilities.json).
 * The generator sends `ESC t 16` for CP1252; a printer with a different table
 * would print what this map says, which is the point of emulating it.
 */
const CODE_PAGES = {
  0: "CP437",
  1: "CP932",
  2: "CP850",
  3: "CP860",
  4: "CP863",
  5: "CP865",
  11: "CP851",
  12: "CP853",
  13: "CP857",
  14: "CP737",
  15: "ISO-8859-7",
  16: "CP1252",
  17: "CP866",
  18: "CP852",
  19: "CP858",
  21: "CP874",
  32: "CP720",
  33: "CP775",
  34: "CP855",
  35: "CP861",
  36: "CP862",
  37: "CP864",
  38: "CP869",
  39: "ISO-8859-2",
  40: "ISO-8859-15",
  44: "CP1125",
  45: "CP1250",
  46: "CP1251",
  47: "CP1253",
  48: "CP1254",
  49: "CP1255",
  50: "CP1256",
  51: "CP1257",
  52: "CP1258",
  53: "RK1048",
};

export function codePageName(n) {
  return CODE_PAGES[n] ?? `Unknown(${n})`;
}

/** Whether we can decode the table; unknown ones fall back to CP437. */
export function isKnownCodePage(n) {
  const name = CODE_PAGES[n];
  return !!name && iconv.encodingExists(name.toLowerCase());
}

const cache = new Map();

/** Unicode for one byte under code page `n`. */
export function decodeByte(byte, n) {
  const key = `${n}:${byte}`;
  let ch = cache.get(key);
  if (ch !== undefined) return ch;

  const name = isKnownCodePage(n) ? CODE_PAGES[n].toLowerCase() : "cp437";
  ch = iconv.decode(Buffer.from([byte]), name);
  // CP437's 0x00-0x1F are glyphs on a printer, but they never reach here: the
  // interpreter consumes control codes first.
  cache.set(key, ch);
  return ch;
}

/** A GBK double-byte character (Kanji mode, `FS &`). */
export function decodeGbk(b1, b2) {
  return iconv.decode(Buffer.from([b1, b2]), "gbk");
}

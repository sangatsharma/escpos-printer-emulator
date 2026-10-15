/**
 * Writes samples/*.bin: a printer test page, a receipt using every common
 * feature, and an order ticket encoded for a dot-matrix head.
 *
 *   npm run samples [-- out-dir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Bitmap, EscPosBuilder } from "./escpos-builder.js";

const outDir = process.argv[2] ?? "samples";
mkdirSync(outDir, { recursive: true });

/** A 120×60 test logo: a ring and a bar. */
const logo: Bitmap = {
  width: 120,
  height: 60,
  get(x, y) {
    const r = Math.hypot(x - 30, y - 30);
    return (r > 18 && r < 27) || (x > 66 && x < 116 && y > 22 && y < 38) || (x > 66 && x < 72 && y > 5 && y < 55);
  },
};

function write(name: string, bytes: Buffer): void {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${String(bytes.length).padStart(6)} bytes → ${join(outDir, name)}`);
}

function testPage(paper: 58 | 80): Buffer {
  const b = new EscPosBuilder(paper === 80 ? 48 : 32);
  b.init().align("center").bold().size(2, 1).line("Printer Test").size(1).bold(false).hr();
  b.align("left");
  for (const [k, v] of [
    ["Status", "Ready"],
    ["Paper width", `${paper}mm`],
    ["Interface", "Raw TCP"],
    ["CP1252", "€ £ é ü ñ"],
  ] as const) {
    b.row([
      { text: k, width: 5 },
      { text: ":", width: 1 },
      { text: v, width: 6 },
    ]);
  }
  b.hr().align("center").line("ESC/POS Printer Emulator").feed(2);
  return b.beep(4, 1).cut("full").build();
}

function receipt(paper: 58 | 80): Buffer {
  const b = new EscPosBuilder(paper === 80 ? 48 : 32);
  b.init().align("left").raster(logo);
  b.align("center").bold().size(2).line("THE CORNER CAFÉ").size(1).bold(false);
  b.line("12 Example Street · Springfield").line("Tax ID 123456789");
  b.bold().reverse().line(" TAX INVOICE ").reverse(false).bold(false);
  b.align("left").hr();
  b.bold().row([
    { text: "Item", width: 6 },
    { text: "Qty", width: 2, align: "right" },
    { text: "Amount", width: 4, align: "right" },
  ]).bold(false);
  for (const [item, qty, amount] of [
    ["Chicken Dumplings (steamed) with extra sauce", "2", "12.80"],
    ["Masala Tea", "3", "6.00"],
    ["Vegetable Set Meal", "1", "8.60"],
  ] as const) {
    b.row([
      { text: item, width: 6 },
      { text: qty, width: 2, align: "right" },
      { text: amount, width: 4, align: "right" },
    ]);
  }
  b.hr("=");
  b.bold().size(2).row([
    { text: "TOTAL", width: 6 },
    { text: "$27.40", width: 6, align: "right" },
  ]).size(1).bold(false);
  b.underline().line("Underlined note").underline(0);
  b.font("B").line("Font B small print: thank you for visiting, please come again!").font("A");
  b.feed(1).align("center").qr("https://example.com/r/INV-0042", { size: 6, ec: "M" }).raw(0x0a);
  b.code128("{BINV-0042", { height: 60, width: 2 }).feed(1);
  // Column-format bands, as older drivers send images.
  b.bitImage(logo, 33, 24);
  return b.drawer().cut("partial").beep(2).build();
}

function impactOrder(): Buffer {
  const b = new EscPosBuilder(48);
  b.init().align("center").bitImage(logo, 0, 16);
  b.bold().size(2).line("ORDER #17  Table 4").size(1).bold(false).align("left").hr();
  b.row([
    { text: "2 x Chicken Dumplings", width: 9 },
    { text: "Main", width: 3, align: "right" },
  ]);
  b.line();
  // A thermal-only command: an impact head prints its parameters as text.
  b.qr("this is garbage on an impact head", { size: 4 }).line();
  return b.feed(3).cut("full").build();
}

for (const paper of [80, 58] as const) {
  write(`test-print-${paper}.bin`, testPage(paper));
  write(`receipt-${paper}.bin`, receipt(paper));
}
write("order-impact.bin", impactOrder());

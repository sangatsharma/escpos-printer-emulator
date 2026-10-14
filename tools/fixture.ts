import { writeFileSync } from "node:fs";

import { Barcode, CapabilityProfile, Generator, PaperSize, PosAlign, PosColumn, PosCutMode, PosFontType, PosStyles, PosTextSize } from "@/utils/esc-pos";
import { QRCorrection, QRSize } from "@/utils/esc-pos/qrcode";

/** A 120×60 test logo: ring + bar, as RGBA. */
function logo(w = 120, h = 60) {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x - 30, dy = y - 30, r = Math.sqrt(dx * dx + dy * dy);
      const on = (r > 18 && r < 27) || (x > 66 && x < 116 && y > 22 && y < 38) || (x > 66 && x < 72 && y > 5 && y < 55);
      if (on) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    }
  return { width: w, height: h, data };
}

function toBytes(data: any[]) {
  const out: number[] = [];
  for (const item of data) {
    if (typeof item === "string") out.push(...Buffer.from(item, "latin1"));
    else if (item.flavor === "base64") out.push(...Buffer.from(item.data, "base64"));
  }
  return Buffer.from(out);
}

const [dir, paperArg = "80"] = process.argv.slice(2);
const paper = paperArg === "58" ? PaperSize.mm58 : PaperSize.mm80;
const g = new Generator(paper, CapabilityProfile.load("default"), { spaceBetweenRows: 0 });
g.reset();
g.setGlobalCodeTable("CP1252");

// Raster logo the way rasterise.ts sends it for thermal heads.
g.rawBytes([0x1b, 0x61, 0x00], true);
g.imageRaster(logo(), { align: PosAlign.left });
g.setStyles(new PosStyles({ align: PosAlign.center }));
g.text("THE RESTRO CAFÉ", { styles: new PosStyles({ bold: true, align: PosAlign.center, height: PosTextSize.size2, width: PosTextSize.size2 }) });
g.text("Lakeside, Pokhara · PAN 123456789", { styles: new PosStyles({ align: PosAlign.center }) });
g.text("TAX INVOICE", { styles: new PosStyles({ align: PosAlign.center, reverse: true, bold: true }) });
g.hr();
g.row([
  new PosColumn({ text: "Item", width: 6, styles: new PosStyles({ bold: true }) }),
  new PosColumn({ text: "Qty", width: 2, styles: new PosStyles({ bold: true, align: PosAlign.right }) }),
  new PosColumn({ text: "Amount", width: 4, styles: new PosStyles({ bold: true, align: PosAlign.right }) }),
]);
for (const [name, q, amt] of [["Chicken Momo (Steam) with extra achar", "2", "640.00"], ["Masala Tea", "3", "180.00"], ["Veg Thakali Set", "1", "550.00"]]) {
  g.row([new PosColumn({ text: name, width: 6 }), new PosColumn({ text: q, width: 2, styles: new PosStyles({ align: PosAlign.right }) }), new PosColumn({ text: amt, width: 4, styles: new PosStyles({ align: PosAlign.right }) })]);
}
g.hr({ ch: "=" });
g.row([
  new PosColumn({ text: "TOTAL", width: 6, styles: new PosStyles({ bold: true, height: PosTextSize.size2, width: PosTextSize.size2 }) }),
  new PosColumn({ text: "Rs 1,370.00", width: 6, styles: new PosStyles({ bold: true, align: PosAlign.right, height: PosTextSize.size2, width: PosTextSize.size2 }) }),
]);
g.text("Underlined note", { styles: new PosStyles({ underline: true }) });
g.text("Font B small print: thank you for dining with us, please visit again!", { styles: new PosStyles({ fontType: PosFontType.fontB }) });
g.feed(1);
g.qrcode("https://restrox.app/pay/INV-0042", { align: PosAlign.center, size: QRSize.size6, cor: QRCorrection.M });
g.emptyLines(1);
g.barcode(Barcode.code128("{BINV-0042".split("")), { height: 60, width: 2 });
g.emptyLines(1);
// Column-format bands, double density (thermal) then single (what impact heads get).
g.image(logo(), { align: PosAlign.center, isDoubleDensity: true });
g.cut({ mode: PosCutMode.partial });
g.beep({ n: 2 });
writeFileSync(`${dir}/fixture-receipt-${paperArg}.bin`, toBytes(g.build()));

// Impact: what rasterise.ts produces for a Dot Matrix printer.
const d = new Generator(PaperSize.mm80, CapabilityProfile.load("default"));
d.reset();
d.setGlobalCodeTable("CP1252");
d.image(logo(), { align: PosAlign.center, isDoubleDensity: false });
d.text("KOT #17  Table 4", { styles: new PosStyles({ bold: true, align: PosAlign.center, height: PosTextSize.size2, width: PosTextSize.size2 }) });
d.hr();
d.row([new PosColumn({ text: "2 x Chicken Momo", width: 9 }), new PosColumn({ text: "Main", width: 3, styles: new PosStyles({ align: PosAlign.right }) })]);
d.qrcode("this is garbage on an impact head", { size: QRSize.size4 });
d.text("");
d.cut();
writeFileSync(`${dir}/fixture-kot-impact.bin`, toBytes(d.build()));
console.log("fixtures written");

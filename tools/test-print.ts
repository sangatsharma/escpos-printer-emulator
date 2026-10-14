import { getTestPrintTemplate } from "@/print/testPrint";
import { writeFileSync } from "node:fs";

const out = process.argv[2]!;
const paper = Number(process.argv[3] ?? 80);
const data = getTestPrintTemplate(
  { name: "Kitchen", ipAddress: "127.0.0.21", paperWidth: paper, printerType: "Thermal", kotTypes: [{ name: "Main" }, { name: "Bar" }], autoprintBill: true, autoprintFullKOT: false, autoprintOrderSlip: true } as any,
  paper as any,
  "sangat",
);
const bytes: number[] = [];
for (const item of data as any[]) {
  if (typeof item === "string") bytes.push(...Buffer.from(item, "latin1"));
  else if (item.flavor === "base64") bytes.push(...Buffer.from(item.data, "base64"));
  else console.error("skipping non-byte payload", item.format, item.flavor);
}
writeFileSync(out, Buffer.from(bytes));
console.log(`${bytes.length} bytes → ${out}`);

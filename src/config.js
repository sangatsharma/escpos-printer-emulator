import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_HTTP = { host: "127.0.0.1", port: 9180 };

/**
 * `--printer name=Kitchen,host=127.0.0.21,port=9100,paper=80,type=thermal`
 * Keys match a printers.json entry.
 */
export function parsePrinterSpec(spec) {
  const out = {};
  for (const pair of spec.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (!k || !rest.length) throw new Error(`Bad --printer value "${spec}" (expected key=value,…)`);
    const v = rest.join("=").trim();
    out[k.trim()] = /^(true|false)$/.test(v) ? v === "true" : /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "printer";
}

export function loadConfig({ configPath, printerSpecs = [], http }) {
  let file = {};
  const path = configPath ? resolve(configPath) : resolve("printers.json");
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8"));
  } else if (configPath) {
    throw new Error(`Config file not found: ${path}`);
  }

  let printers = printerSpecs.length ? printerSpecs.map(parsePrinterSpec) : (file.printers ?? []);
  if (!printers.length) {
    printers = [{ name: "Emulated Printer", host: "127.0.0.1", port: 9100, paper: 80, type: "Thermal" }];
  }

  const seen = new Set();
  printers = printers.map((p, i) => {
    let id = p.id ?? slug(p.name ?? `printer-${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...p, id, name: p.name ?? id, host: p.host ?? "127.0.0.1", port: p.port ?? 9100 };
  });

  const addresses = new Map();
  for (const p of printers) {
    const key = `${p.host}:${p.port}`;
    if (addresses.has(key)) {
      throw new Error(`${addresses.get(key)} and ${p.name} both use ${key}; give each printer its own IP (RestroX always uses port 9100).`);
    }
    addresses.set(key, p.name);
  }

  return {
    path: existsSync(path) ? path : null,
    http: { ...DEFAULT_HTTP, ...(file.http ?? {}), ...(http ?? {}) },
    dataDir: resolve(file.dataDir ?? "data"),
    idleMs: file.idleMs ?? 1500,
    printers,
  };
}

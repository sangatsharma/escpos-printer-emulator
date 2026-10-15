import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_HTTP = { host: "127.0.0.1", port: 9180 };
export const DEFAULT_PRINTER_PORT = 9100;

/** One printer as written in printers.json or on the command line. */
export interface PrinterConfig {
  id?: string;
  name?: string;
  host?: string;
  port?: number;
  /** Paper width in mm: 58, 72 or 80 for thermal; 58 or 76 for dot matrix. */
  paper?: number;
  /** "thermal" (default) or "dot matrix" / "impact". */
  type?: string;
  /** A profile id; wins over `paper` and `type`. */
  profile?: string;
  cutterOffsetMm?: number;
  kanjiDefault?: boolean;
  rasterHonoursAlign?: boolean;
  idleMs?: number;
}

/** A printer after defaults are filled in. */
export interface ResolvedPrinterConfig extends PrinterConfig {
  id: string;
  name: string;
  host: string;
  port: number;
}

export interface ConfigFile {
  http?: Partial<typeof DEFAULT_HTTP>;
  dataDir?: string;
  idleMs?: number;
  printers?: PrinterConfig[];
}

export interface Config {
  path: string | null;
  http: typeof DEFAULT_HTTP;
  dataDir: string;
  idleMs: number;
  printers: ResolvedPrinterConfig[];
}

/**
 * `--printer name=Kitchen,host=127.0.0.21,port=9100,paper=80,type=thermal`
 * Keys match a printers.json entry.
 */
export function parsePrinterSpec(spec: string): PrinterConfig {
  const out: Record<string, string | number | boolean> = {};
  for (const pair of spec.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (!k || !rest.length) throw new Error(`Bad --printer value "${spec}" (expected key=value,…)`);
    const v = rest.join("=").trim();
    out[k.trim()] = /^(true|false)$/.test(v) ? v === "true" : /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out as PrinterConfig;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "printer";
}

export interface LoadConfigOptions {
  /** Explicit config file; it must exist. Without it, ./printers.json is used if present. */
  configPath?: string;
  /** `--printer` specs; they replace the file's printers. */
  printerSpecs?: string[];
  http?: Partial<typeof DEFAULT_HTTP>;
}

/** Paths in the config resolve against the current working directory. */
export function loadConfig({ configPath, printerSpecs = [], http }: LoadConfigOptions = {}): Config {
  let file: ConfigFile = {};
  const path = configPath ? resolve(configPath) : resolve("printers.json");
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } else if (configPath) {
    throw new Error(`Config file not found: ${path}`);
  }

  let printers = printerSpecs.length ? printerSpecs.map(parsePrinterSpec) : (file.printers ?? []);
  if (!printers.length) {
    printers = [{ name: "Emulated Printer", host: "127.0.0.1", port: DEFAULT_PRINTER_PORT, paper: 80, type: "thermal" }];
  }

  const seen = new Set<string>();
  const resolved = printers.map((p, i): ResolvedPrinterConfig => {
    let id = p.id ?? slug(p.name ?? `printer-${i + 1}`);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { ...p, id, name: p.name ?? id, host: p.host ?? "127.0.0.1", port: p.port ?? DEFAULT_PRINTER_PORT };
  });

  const addresses = new Map<string, string>();
  for (const p of resolved) {
    const key = `${p.host}:${p.port}`;
    if (addresses.has(key)) {
      throw new Error(
        `${addresses.get(key)} and ${p.name} both use ${key}; give each printer its own IP or port.`,
      );
    }
    addresses.set(key, p.name);
  }

  return {
    path: existsSync(path) ? path : null,
    http: { ...DEFAULT_HTTP, ...(file.http ?? {}), ...(http ?? {}) },
    dataDir: resolve(file.dataDir ?? "data"),
    idleMs: file.idleMs ?? 1500,
    printers: resolved,
  };
}

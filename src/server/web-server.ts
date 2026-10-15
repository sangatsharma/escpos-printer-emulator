import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerEvents } from "../core/types.js";
import type { EmulatedPrinter } from "./printer-server.js";
import type { JobStore } from "./store.js";

/**
 * The built viewer. From both src/server (tsx) and dist/server (compiled) this
 * is <project>/dist/web.
 */
const WEB_ROOT = fileURLToPath(new URL("../../dist/web/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Printer Emulator</title>
<body style="font:15px system-ui;max-width:40em;margin:3em auto;padding:0 1em">
<h1>The viewer is not built</h1>
<p>The emulator and its API are running, but <code>dist/web</code> does not exist.</p>
<p>Run <code>npm run build</code>, or use <code>npm run dev</code> and open the Vite URL it prints.</p>`;

export interface WebServerOptions {
  host: string;
  port: number;
  printers: EmulatedPrinter[];
  store: JobStore;
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The viewer: the built React app, a small JSON API, and a server-sent event
 * stream that pushes each job the moment the printer finishes it.
 */
export function startWebServer({ host, port, printers, store, log }: WebServerOptions): Promise<Server> {
  const clients = new Set<ServerResponse>();
  const byId = new Map(printers.map((p) => [p.id, p]));

  const broadcast = <K extends keyof ServerEvents>(type: K, data: ServerEvents[K]) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  for (const printer of printers) {
    printer.on("change", () => broadcast("printer", printer.summary()));
    printer.on("probe", (probe) => broadcast("probe", probe));
    printer.on("job", (job) => {
      const { trace: _trace, ...meta } = store.add(job);
      broadcast("job", meta);
    });
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const readJson = async <T>(req: IncomingMessage): Promise<T> => {
    const text = (await readBody(req)).toString() || "{}";
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(400, "Body is not valid JSON");
    }
  };

  const serveStatic = async (pathname: string, res: ServerResponse) => {
    if (!existsSync(WEB_ROOT)) {
      res.writeHead(200, { "content-type": TYPES[".html"] });
      return res.end(NOT_BUILT);
    }
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    let file = normalize(join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT)) throw new HttpError(403, "Forbidden");
    // Unknown paths without an extension get the app shell (client-side routes).
    if (!existsSync(file) && !extname(file)) file = join(WEB_ROOT, "index.html");
    const body = await readFile(file);
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => {
    // GET /api/printers
    if (parts[1] === "printers" && parts.length === 2) {
      return json(res, 200, printers.map((p) => p.summary()));
    }

    if (parts[1] === "printers" && parts[2]) {
      const printer = byId.get(parts[2]);
      if (!printer) throw new HttpError(404, "No such printer");

      // POST /api/printers/:id/mode {"mode":"offline"}
      if (parts[3] === "mode" && req.method === "POST") {
        const { mode } = await readJson<{ mode?: string }>(req);
        await printer.setMode(String(mode)).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        return json(res, 200, printer.summary());
      }
      // POST /api/printers/:id/status {"paperOut":true}
      if (parts[3] === "status" && req.method === "POST") {
        printer.setStatus(await readJson(req));
        return json(res, 200, printer.summary());
      }
      // POST /api/printers/:id/print  (raw ESC/POS body)
      if (parts[3] === "print" && req.method === "POST") {
        const body = await readBody(req);
        const job = inject(printer, body, "http upload");
        return json(res, 200, { id: job.id, warnings: job.warnings, text: job.text });
      }
      if (!parts[3]) return json(res, 200, printer.summary());
    }

    // GET|DELETE /api/jobs?printer=id
    if (parts[1] === "jobs" && parts.length === 2) {
      const printerId = url.searchParams.get("printer") || undefined;
      if (req.method === "DELETE") {
        store.clear(printerId);
        broadcast("cleared", { printerId: printerId ?? null });
        return json(res, 200, { ok: true });
      }
      return json(res, 200, store.list(printerId));
    }

    if (parts[1] === "jobs" && parts[2]) {
      const job = store.get(parts[2]);
      if (!job) throw new HttpError(404, "No such job");

      // GET /api/jobs/:id/raw → the exact bytes received
      if (parts[3] === "raw") {
        const raw = store.raw(job.id);
        if (!raw) throw new HttpError(404, "Raw bytes for this job are missing");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${job.id}.bin"`,
        });
        return res.end(raw);
      }
      // POST /api/jobs/:id/replay → print the same bytes again
      if (parts[3] === "replay" && req.method === "POST") {
        const raw = store.raw(job.id);
        if (!raw) throw new HttpError(404, "Raw bytes for this job are missing");
        const printer = byId.get(job.printerId) ?? printers[0]!;
        const again = inject(printer, raw, `replay of ${job.id}`);
        return json(res, 200, { id: again.id });
      }
      if (req.method === "DELETE") {
        store.remove(job.id);
        broadcast("removed", { id: job.id });
        return json(res, 200, { ok: true });
      }
      return json(res, 200, job);
    }
    throw new HttpError(404, "Not found");
  };

  const inject = (printer: EmulatedPrinter, raw: Buffer, from: string) => {
    try {
      return printer.inject(raw, from);
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (parts[0] === "api") return await handleApi(req, res, url, parts);
      await serveStatic(url.pathname, res);
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(res, 404, { error: "Not found" });
      log?.(`http error: ${(error as Error).message}`);
      json(res, 500, { error: (error as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

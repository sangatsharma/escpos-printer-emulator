import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * The viewer: static UI, a small JSON API, and a server-sent event stream that
 * pushes each job the moment the printer finishes it.
 */
export function startWebServer({ host, port, printers, store, log }) {
  const clients = new Set();
  const byId = new Map(printers.map((p) => [p.id, p]));

  const broadcast = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  for (const printer of printers) {
    printer.on("change", () => broadcast("printer", printer.summary()));
    printer.on("probe", (probe) => broadcast("probe", probe));
    printer.on("job", (job) => {
      const meta = store.add(job);
      broadcast("job", { ...meta, trace: undefined });
    });
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
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

      if (parts[0] === "api") {
        // GET /api/printers
        if (parts[1] === "printers" && parts.length === 2) {
          return json(res, 200, printers.map((p) => p.summary()));
        }

        if (parts[1] === "printers" && parts[2]) {
          const printer = byId.get(parts[2]);
          if (!printer) return json(res, 404, { error: "No such printer" });

          // POST /api/printers/:id/mode {"mode":"offline"}
          if (parts[3] === "mode" && req.method === "POST") {
            const { mode } = JSON.parse((await readBody(req)).toString() || "{}");
            await printer.setMode(mode);
            return json(res, 200, printer.summary());
          }
          // POST /api/printers/:id/status {"paperOut":true}
          if (parts[3] === "status" && req.method === "POST") {
            printer.setStatus(JSON.parse((await readBody(req)).toString() || "{}"));
            return json(res, 200, printer.summary());
          }
          // POST /api/printers/:id/print  (raw ESC/POS body)
          if (parts[3] === "print" && req.method === "POST") {
            const job = printer.inject(await readBody(req), "http upload");
            return json(res, 200, { id: job.id, warnings: job.warnings, text: job.text });
          }
        }

        // GET /api/jobs?printer=id
        if (parts[1] === "jobs" && parts.length === 2) {
          if (req.method === "DELETE") {
            store.clear(url.searchParams.get("printer") || undefined);
            broadcast("cleared", { printerId: url.searchParams.get("printer") });
            return json(res, 200, { ok: true });
          }
          return json(res, 200, store.list(url.searchParams.get("printer") || undefined));
        }

        if (parts[1] === "jobs" && parts[2]) {
          const job = store.get(parts[2]);
          if (!job) return json(res, 404, { error: "No such job" });

          // GET /api/jobs/:id/raw → the exact bytes received
          if (parts[3] === "raw") {
            const raw = store.raw(job.id);
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${job.id}.bin"`,
            });
            return res.end(raw);
          }
          // POST /api/jobs/:id/replay → print the same bytes again
          if (parts[3] === "replay" && req.method === "POST") {
            const printer = byId.get(job.printerId) ?? printers[0];
            const again = printer.inject(store.raw(job.id), `replay of ${job.id}`);
            return json(res, 200, { id: again.id });
          }
          if (req.method === "DELETE") {
            store.remove(job.id);
            broadcast("removed", { id: job.id });
            return json(res, 200, { ok: true });
          }
          return json(res, 200, job);
        }
        return json(res, 404, { error: "Not found" });
      }

      // Static files
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = normalize(join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch (error) {
      if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
      log?.(`http error: ${error.message}`);
      json(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

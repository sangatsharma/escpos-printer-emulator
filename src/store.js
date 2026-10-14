import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Job history: kept in memory for the viewer and written to `<dataDir>/jobs`
 * so it survives a restart. Each job is `<id>.json` (the rendered result) plus
 * `<id>.bin` (the exact bytes received, for replay or a bug report).
 */
export class JobStore {
  constructor(dataDir, { limit = 300 } = {}) {
    this.dir = join(dataDir, "jobs");
    this.limit = limit;
    this.jobs = [];
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  load() {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files.slice(-this.limit)) {
      try {
        this.jobs.push(JSON.parse(readFileSync(join(this.dir, file), "utf8")));
      } catch {
        // A half-written file from a crash; skip it.
      }
    }
  }

  add(job) {
    const { raw, ...meta } = job;
    meta.rawSize = raw.length;
    writeFileSync(join(this.dir, `${meta.id}.bin`), raw);
    writeFileSync(join(this.dir, `${meta.id}.json`), JSON.stringify(meta));
    this.jobs.push(meta);
    while (this.jobs.length > this.limit) this.remove(this.jobs[0].id);
    return meta;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id);
  }

  raw(id) {
    const file = join(this.dir, `${id}.bin`);
    return existsSync(file) ? readFileSync(file) : null;
  }

  remove(id) {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    for (const ext of [".json", ".bin"]) rmSync(join(this.dir, `${id}${ext}`), { force: true });
  }

  clear(printerId) {
    for (const job of [...this.jobs]) {
      if (!printerId || job.printerId === printerId) this.remove(job.id);
    }
  }

  /** Newest first, without the bulky trace. */
  list(printerId) {
    return this.jobs
      .filter((j) => !printerId || j.printerId === printerId)
      .slice()
      .reverse()
      .map(({ trace, ...rest }) => rest);
  }
}

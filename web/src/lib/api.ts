import type { JobSummary, PrinterMode, PrinterStatus, PrinterSummary, StoredJob } from "../types";

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res;
}

const post = (path: string, body?: BodyInit) => request(path, { method: "POST", body });

export const api = {
  printers: async () => (await request("/api/printers")).json() as Promise<PrinterSummary[]>,
  jobs: async () => (await request("/api/jobs")).json() as Promise<JobSummary[]>,
  /** The full job, including the command trace. */
  job: async (id: string) => (await request(`/api/jobs/${encodeURIComponent(id)}`)).json() as Promise<StoredJob>,
  raw: async (id: string) => new Uint8Array(await (await request(rawUrl(id))).arrayBuffer()),

  setMode: (printerId: string, mode: PrinterMode) =>
    post(`/api/printers/${encodeURIComponent(printerId)}/mode`, JSON.stringify({ mode })),
  setStatus: (printerId: string, flags: Partial<PrinterStatus>) =>
    post(`/api/printers/${encodeURIComponent(printerId)}/status`, JSON.stringify(flags)),
  print: (printerId: string, bytes: ArrayBuffer) => post(`/api/printers/${encodeURIComponent(printerId)}/print`, bytes),

  replay: (id: string) => post(`/api/jobs/${encodeURIComponent(id)}/replay`),
  remove: (id: string) => request(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  clear: (printerId?: string | null) =>
    request(`/api/jobs${printerId ? `?printer=${encodeURIComponent(printerId)}` : ""}`, { method: "DELETE" }),
};

export function rawUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/raw`;
}

export function alertError(error: unknown): void {
  alert(error instanceof Error ? error.message : String(error));
}

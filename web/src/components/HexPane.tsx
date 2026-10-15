import { useEffect, useState } from "react";

import { api } from "../lib/api";

const LIMIT = 16384;

function hexDump(buf: Uint8Array): string {
  const limit = Math.min(buf.length, LIMIT);
  const lines: string[] = [];
  for (let i = 0; i < limit; i += 16) {
    const row = [...buf.subarray(i, Math.min(i + 16, limit))];
    const hex = row.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > limit) lines.push(`… ${buf.length - limit} more bytes (download the .bin for all of it)`);
  return lines.join("\n");
}

/** The raw bytes received. Loaded on first view. */
export function HexPane({ jobId }: { jobId: string }) {
  const [dump, setDump] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .raw(jobId)
      .then((buf) => !cancelled && setDump(hexDump(buf)))
      .catch((e: Error) => !cancelled && setDump(`(${e.message})`));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return <pre>{dump ?? "loading…"}</pre>;
}

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { TraceEntry } from "../types";

const TRACE_LIMIT = 4000;

/** Every decoded command with its byte offset. Loaded on first view. */
export function TracePane({ jobId }: { jobId: string }) {
  const [trace, setTrace] = useState<TraceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .job(jobId)
      .then((job) => !cancelled && setTrace(job.trace ?? []))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (error) return <p className="p-error">{error}</p>;
  if (!trace) return <p className="muted">loading…</p>;
  return (
    <div className="trace">
      {trace.map((t, i) => {
        const isText = t.c === "TEXT";
        const warn = /UNSUPPORTED|unknown|REJECTED/.test(t.d);
        return (
          <div className="trace-row" key={i}>
            <span className="o">{t.o.toString(16).padStart(5, "0")}</span>
            <span className="c">{t.c}</span>
            <span className={`d${isText ? " txt" : ""}${warn ? " warn" : ""}`}>{isText ? JSON.stringify(t.d) : t.d}</span>
          </div>
        );
      })}
      {trace.length >= TRACE_LIMIT && <span className="muted">… trace truncated</span>}
    </div>
  );
}

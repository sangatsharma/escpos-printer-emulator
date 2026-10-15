import { memo, useState } from "react";

import { alertError, api, rawUrl } from "../lib/api";
import { download } from "../lib/effects";
import { renderJobStrip } from "../lib/render";
import type { JobEvent, JobSummary } from "../types";
import { HexPane } from "./HexPane";
import { PaperPane } from "./PaperPane";
import { TracePane } from "./TracePane";

const TABS = [
  ["paper", "Receipt"],
  ["text", "Text"],
  ["trace", "Commands"],
  ["hex", "Hex"],
] as const;

type Tab = (typeof TABS)[number][0];

function badge(ev: JobEvent): { label: string; className?: string } {
  switch (ev.type) {
    case "cut":
      return { label: ev.kind === "full" ? "✂ full cut" : "✂ partial cut", className: "cut" };
    case "beep":
      return { label: `🔔 beep ×${ev.count}` };
    case "drawer":
      return { label: `💰 drawer kick (pin ${ev.pin})` };
    case "selftest":
      return { label: "self-test" };
  }
}

interface Props {
  job: JobSummary;
  fresh: boolean;
  zoom: number;
  crisp: boolean;
}

export const JobCard = memo(function JobCard({ job, fresh, zoom, crisp }: Props) {
  const [tab, setTab] = useState<Tab>("paper");
  // Trace and hex are fetched on first view, then kept mounted.
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set(["paper"]));

  const started = new Date(job.startedAt);
  const ms = new Date(job.endedAt).getTime() - started.getTime();
  const tickets = job.tickets.length;

  const show = (t: Tab) => {
    setTab(t);
    setOpened((o) => (o.has(t) ? o : new Set(o).add(t)));
  };

  return (
    <article className={`job${fresh ? " fresh" : ""}`}>
      <header className="job-head">
        <div className="job-title">
          <strong>{job.printerName}</strong>
          <span className="muted">
            {started.toLocaleTimeString()} · {job.bytes.toLocaleString()} bytes · {ms} ms · from {job.from}
          </span>
        </div>
        <div className="job-actions">
          <button
            className="btn small"
            type="button"
            onClick={() => renderJobStrip(job, { crisp }).toBlob((blob) => blob && download(blob, `${job.id}.png`))}
          >
            PNG
          </button>
          <a className="btn small" href={rawUrl(job.id)} download={`${job.id}.bin`}>
            .bin
          </a>
          <button className="btn small" type="button" onClick={() => api.replay(job.id).catch(alertError)}>
            Replay
          </button>
          <button
            className="btn small ghost"
            type="button"
            aria-label="Delete job"
            onClick={() => api.remove(job.id).catch(alertError)}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="j-badges">
        <span className="badge">
          {tickets} ticket{tickets === 1 ? "" : "s"}
        </span>
        {job.events.map((ev, i) => {
          const b = badge(ev);
          return (
            <span key={i} className={`badge ${b.className ?? ""}`}>
              {b.label}
            </span>
          );
        })}
      </div>

      {job.warnings.length > 0 && (
        <ul className="j-warnings">
          {job.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={`tab${tab === id ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => show(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className="pane" hidden={tab !== "paper"}>
        <PaperPane job={job} zoom={zoom} crisp={crisp} />
      </section>
      <section className="pane" hidden={tab !== "text"}>
        <pre>{job.text || "(no text)"}</pre>
      </section>
      <section className="pane" hidden={tab !== "trace"}>
        {opened.has("trace") && <TracePane jobId={job.id} />}
      </section>
      <section className="pane" hidden={tab !== "hex"}>
        {opened.has("hex") && <HexPane jobId={job.id} />}
      </section>
    </article>
  );
});

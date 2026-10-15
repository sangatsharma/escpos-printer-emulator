import { useCallback, useMemo, useRef, useState } from "react";

import { DropZone } from "./components/DropZone";
import { JobCard } from "./components/JobCard";
import { PrinterCard } from "./components/PrinterCard";
import { ProbeList } from "./components/ProbeList";
import { TopBar } from "./components/TopBar";
import { useEmulator } from "./hooks/useEmulator";
import { usePrefs } from "./hooks/usePrefs";
import { alertError, api } from "./lib/api";
import { beep } from "./lib/effects";
import type { JobSummary } from "./types";

/** Rendering every receipt is costly; older jobs stay in the API. */
const MAX_VISIBLE = 60;

export function App() {
  const [prefs, setPrefs] = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);

  const sound = useRef(prefs.sound);
  sound.current = prefs.sound;
  const onJob = useCallback((job: JobSummary) => {
    if (!sound.current) return;
    for (const ev of job.events) if (ev.type === "beep") beep(ev.count, ev.durationMs);
  }, []);

  const { printers, jobs, probes, fresh, live, loaded } = useEmulator(onJob);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of jobs) m.set(j.printerId, (m.get(j.printerId) ?? 0) + 1);
    return m;
  }, [jobs]);

  const visible = useMemo(() => jobs.filter((j) => !selected || j.printerId === selected), [jobs, selected]);
  const selectedPrinter = printers.find((p) => p.id === selected);
  const target = selectedPrinter ?? printers[0];

  const clear = () => {
    if (confirm(selected ? "Clear this printer's jobs?" : "Clear all jobs?")) api.clear(selected).catch(alertError);
  };

  const printFile = async (file: File) => {
    if (!target) return;
    await api.print(target.id, await file.arrayBuffer()).catch(alertError);
  };

  return (
    <>
      <TopBar prefs={prefs} onPrefs={setPrefs} live={live} onClear={clear} />

      <div className="layout">
        <aside className="sidebar">
          <h2>Printers</h2>
          {printers.map((p) => (
            <PrinterCard
              key={p.id}
              printer={p}
              jobCount={counts.get(p.id) ?? 0}
              selected={selected === p.id}
              onSelect={() => setSelected((s) => (s === p.id ? null : p.id))}
            />
          ))}
          <DropZone target={target?.name} onFile={printFile} />
          <ProbeList probes={probes} printers={printers} />
        </aside>

        <main className="feed">
          <div className="feed-head">
            <h2>{selectedPrinter ? `Jobs on ${selectedPrinter.name}` : "All jobs"}</h2>
            {visible.length > 0 && (
              <span className="muted">
                {visible.length} job{visible.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {visible.slice(0, MAX_VISIBLE).map((job) => (
            <JobCard key={job.id} job={job} fresh={fresh.has(job.id)} zoom={prefs.zoom} crisp={prefs.crisp} />
          ))}

          {loaded && !visible.length && (
            <div className="empty">
              <p>
                <strong>No print jobs yet.</strong>
              </p>
              <p>
                Point your app's network (raw TCP) printer at one of the addresses on the left and print, or send a
                sample:
              </p>
              <pre>
                npx escpos-emulator send samples/receipt-80.bin {target ? `${target.host}:${target.port}` : "127.0.0.1"}
              </pre>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

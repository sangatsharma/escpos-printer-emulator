import { alertError, api } from "../lib/api";
import type { PrinterMode, PrinterStatus, PrinterSummary } from "../types";

const MODES: Record<PrinterMode, string> = {
  online: "Online",
  offline: "Offline (refuse)",
  hang: "Jammed (hang)",
};

const FLAGS: [keyof PrinterStatus, string][] = [
  ["paperOut", "Paper out"],
  ["paperNearEnd", "Near end"],
  ["coverOpen", "Cover open"],
  ["drawerOpen", "Drawer open"],
];

interface Props {
  printer: PrinterSummary;
  jobCount: number;
  selected: boolean;
  onSelect: () => void;
}

export function PrinterCard({ printer: p, jobCount, selected, onSelect }: Props) {
  const dot = p.error ? "error" : p.mode !== "online" ? p.mode : p.listening ? "online" : "offline";
  const impact = p.profile.kind === "impact";

  return (
    <div
      className={`printer${selected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="p-head">
        <span className="p-name">
          <span className={`dot ${dot}`} />
          {p.name}
        </span>
        <span className="muted">
          {jobCount} job{jobCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="p-addr">
        {p.host}:{p.port}
      </div>
      <div className="p-profile">
        {impact ? "Dot matrix" : "Thermal"} · {p.profile.paperMm}mm paper · {Math.round(p.profile.widthUnits)}{" "}
        {impact ? "half-dots" : "dots"}
      </div>
      {p.busy && <div className="p-busy">printing…{p.queued ? ` (${p.queued} queued)` : ""}</div>}
      {p.error && <div className="p-error">{p.error}</div>}
      {/* Controls don't toggle the selection. */}
      <div className="p-controls" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <select
          aria-label="Printer mode"
          value={p.mode}
          onChange={(e) => api.setMode(p.id, e.target.value as PrinterMode).catch(alertError)}
        >
          {Object.entries(MODES).map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
        {FLAGS.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={p.status[key]}
              onChange={(e) => api.setStatus(p.id, { [key]: e.target.checked }).catch(alertError)}
            />{" "}
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}

import type { Prefs } from "../hooks/usePrefs";

interface Props {
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  live: boolean;
  onClear: () => void;
}

export function TopBar({ prefs, onPrefs, live, onClear }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <h1>ESC/POS Printer Emulator</h1>
          <p className="sub">Raw TCP network printers · renders what the head would print</p>
        </div>
      </div>
      <div className="top-actions">
        <label className="ctl">
          Zoom
          <input
            type="range"
            min={40}
            max={200}
            step={10}
            value={prefs.zoom}
            onChange={(e) => onPrefs({ zoom: Number(e.target.value) })}
          />
          <output>{prefs.zoom}%</output>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={prefs.crisp} onChange={(e) => onPrefs({ crisp: e.target.checked })} /> 1-bit
          dots
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={prefs.sound} onChange={(e) => onPrefs({ sound: e.target.checked })} /> Beep
          sound
        </label>
        <button className="btn ghost" type="button" onClick={onClear}>
          Clear jobs
        </button>
        <span className={`live${live ? " on" : ""}`} title="Live connection to the emulator">
          {live ? "live" : "connecting…"}
        </span>
      </div>
    </header>
  );
}

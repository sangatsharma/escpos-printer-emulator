import { useEffect, useState } from "react";

export interface Prefs {
  /** Receipt zoom, percent. */
  zoom: number;
  /** Threshold receipts to 1-bit ink. */
  crisp: boolean;
  /** Play the beeper. */
  sound: boolean;
}

const KEY = "escpos-emulator";
const DEFAULTS: Prefs = { zoom: 70, crisp: true, sound: true };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

/** Viewer preferences, remembered per browser. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // Private mode: preferences just don't persist.
    }
  }, [prefs]);
  const update = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  return [prefs, update] as const;
}

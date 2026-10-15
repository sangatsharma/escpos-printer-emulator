import { useEffect, useReducer, useRef } from "react";

import { alertError, api } from "../lib/api";
import type { JobSummary, PrinterSummary, Probe, ServerEvents } from "../types";

export interface EmulatorState {
  printers: PrinterSummary[];
  /** Newest first. */
  jobs: JobSummary[];
  probes: Probe[];
  /** Jobs that arrived while the page was open; they flash once. */
  fresh: Set<string>;
  live: boolean;
  loaded: boolean;
}

type Action =
  | { type: "loaded"; printers: PrinterSummary[]; jobs: JobSummary[] }
  | { type: "live"; live: boolean }
  | { type: "printer"; printer: PrinterSummary }
  | { type: "job"; job: JobSummary }
  | { type: "probe"; probe: Probe }
  | { type: "removed"; id: string }
  | { type: "cleared"; printerId: string | null };

const MAX_PROBES = 5;

const initial: EmulatorState = { printers: [], jobs: [], probes: [], fresh: new Set(), live: false, loaded: false };

function reducer(state: EmulatorState, action: Action): EmulatorState {
  switch (action.type) {
    case "loaded":
      return { ...state, printers: action.printers, jobs: action.jobs, loaded: true };
    case "live":
      return { ...state, live: action.live };
    case "printer": {
      const exists = state.printers.some((p) => p.id === action.printer.id);
      return {
        ...state,
        printers: exists
          ? state.printers.map((p) => (p.id === action.printer.id ? action.printer : p))
          : [...state.printers, action.printer],
      };
    }
    case "job":
      if (state.jobs.some((j) => j.id === action.job.id)) return state;
      return { ...state, jobs: [action.job, ...state.jobs], fresh: new Set(state.fresh).add(action.job.id) };
    case "probe":
      return { ...state, probes: [action.probe, ...state.probes].slice(0, MAX_PROBES) };
    case "removed":
      return { ...state, jobs: state.jobs.filter((j) => j.id !== action.id) };
    case "cleared":
      return {
        ...state,
        jobs: action.printerId ? state.jobs.filter((j) => j.printerId !== action.printerId) : [],
      };
  }
}

/**
 * Printers and jobs, kept current by the server's event stream.
 * `onJob` fires for each job that arrives live (not for history).
 */
export function useEmulator(onJob?: (job: JobSummary) => void): EmulatorState {
  const [state, dispatch] = useReducer(reducer, initial);
  const onJobRef = useRef(onJob);
  onJobRef.current = onJob;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | undefined;

    Promise.all([api.printers(), api.jobs()])
      .then(([printers, jobs]) => {
        if (cancelled) return;
        dispatch({ type: "loaded", printers, jobs });

        // Subscribe after the snapshot so nothing is applied twice.
        es = new EventSource("/events");
        const on = <K extends keyof ServerEvents>(type: K, handle: (data: ServerEvents[K]) => void) =>
          es!.addEventListener(type, (e) => handle(JSON.parse((e as MessageEvent<string>).data) as ServerEvents[K]));

        es.onopen = () => dispatch({ type: "live", live: true });
        es.onerror = () => dispatch({ type: "live", live: false });
        on("printer", (printer) => dispatch({ type: "printer", printer }));
        on("job", (job) => {
          dispatch({ type: "job", job });
          onJobRef.current?.(job);
        });
        on("probe", (probe) => dispatch({ type: "probe", probe }));
        on("removed", ({ id }) => dispatch({ type: "removed", id }));
        on("cleared", ({ printerId }) => dispatch({ type: "cleared", printerId }));
      })
      .catch(alertError);

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  return state;
}

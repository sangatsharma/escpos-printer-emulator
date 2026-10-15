import type { PrinterSummary, Probe } from "../types";

interface Props {
  probes: Probe[];
  printers: PrinterSummary[];
}

/** Connections that printed nothing: reachability checks and status polls. */
export function ProbeList({ probes, printers }: Props) {
  if (!probes.length) return null;
  return (
    <div className="probes">
      {probes.map((probe, i) => {
        const name = printers.find((p) => p.id === probe.printerId)?.name ?? probe.printerId;
        const what = probe.kind === "status" ? `status query (${probe.bytes} bytes)` : "connection test";
        return (
          <div className="probe" key={`${probe.at}-${i}`}>
            {new Date(probe.at).toLocaleTimeString()} · {what} from {probe.from} → {name}
          </div>
        );
      })}
    </div>
  );
}

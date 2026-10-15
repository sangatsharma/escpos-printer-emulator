import { useEffect, useMemo, useRef } from "react";

import { renderTicket } from "../lib/render";
import type { JobSummary } from "../types";

interface Props {
  job: JobSummary;
  zoom: number;
  crisp: boolean;
}

/** Mounts a canvas drawn outside React. */
function CanvasView({ canvas, zoom }: { canvas: HTMLCanvasElement; zoom: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.replaceChildren(canvas);
  }, [canvas]);
  canvas.style.width = `${(canvas.width * zoom) / 100}px`;
  // Enlarged, keep hard dot edges. Shrunk, nearest-neighbour would drop whole
  // rows and columns of dots (and with them the thin strokes of small fonts),
  // so let the browser average them instead.
  const devicePxPerDot = (zoom / 100) * (window.devicePixelRatio || 1);
  canvas.style.imageRendering = devicePxPerDot >= 1 ? "pixelated" : "auto";
  return <div ref={host} className="canvas-host" />;
}

/** The job as paper: one strip per ticket, with its cut edge. */
export function PaperPane({ job, zoom, crisp }: Props) {
  // Drawing is the expensive part; zoom only rescales the finished canvases.
  const canvases = useMemo(() => job.tickets.map((t) => renderTicket(t, job.profile, { crisp })), [job, crisp]);

  if (!job.tickets.length) {
    return <p className="muted">Nothing printed — the job had no printable output.</p>;
  }
  return (
    <div className="paper-roll">
      {job.tickets.map((ticket, i) => (
        <div key={i}>
          {job.tickets.length > 1 && <p className="ticket-label">Ticket {i + 1}</p>}
          <div className={`ticket ${ticket.cut ? `cut-${ticket.cut}` : "uncut"}`}>
            <CanvasView canvas={canvases[i]!} zoom={zoom} />
          </div>
        </div>
      ))}
    </div>
  );
}

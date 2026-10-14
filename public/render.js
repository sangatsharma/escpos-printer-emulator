/**
 * Draws one ticket (paper between two cuts) from the interpreter's display
 * list onto a canvas at the head's own resolution, then thresholds it to ink
 * and paper so it reads like a thermal print rather than a web page.
 */

const PX_PER_MM = 8; // ≈ 203 dpi, so a thermal dot is one pixel
const INK = [24, 24, 24];
const RED = [198, 40, 40];
const PAPER = [253, 252, 247];
const FONT_STACK = "'DejaVu Sans Mono', 'Liberation Mono', 'Menlo', 'Consolas', monospace";

const bitmapCache = new Map();

function decodeBits(el) {
  const key = el.data;
  let canvas = bitmapCache.get(key);
  if (canvas) return canvas;

  const bin = atob(el.data);
  const rowBytes = Math.ceil(el.bw / 8);
  canvas = document.createElement("canvas");
  canvas.width = el.bw;
  canvas.height = el.bh;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(el.bw, el.bh);
  for (let y = 0; y < el.bh; y++) {
    for (let x = 0; x < el.bw; x++) {
      const byte = bin.charCodeAt(y * rowBytes + (x >> 3));
      if (byte & (0x80 >> (x & 7))) img.data[(y * el.bw + x) * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (bitmapCache.size > 400) bitmapCache.clear();
  bitmapCache.set(key, canvas);
  return canvas;
}

/** Natural advance of the stack's monospace glyph at 100px, for horizontal scaling. */
let monoAdvance = null;
function glyphAdvance(ctx) {
  if (monoAdvance) return monoAdvance;
  ctx.save();
  ctx.font = `100px ${FONT_STACK}`;
  monoAdvance = ctx.measureText("M").width / 100;
  ctx.restore();
  return monoAdvance;
}

function drawGlyph(ctx, ch, x, y, w, h, bold, color) {
  // Fill the cell the way a bitmap font does: full height, stretched to width.
  const size = h * 0.98;
  ctx.font = `${bold ? 700 : 500} ${size}px ${FONT_STACK}`;
  const natural = glyphAdvance(ctx) * size;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w / natural, 1);
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(ch, 0, h * 0.8);
  // Emphasised mode on a thermal head is a double strike one dot over.
  if (bold) ctx.fillText(ch, Math.max(0.6, natural * 0.04), h * 0.8);
  ctx.restore();
}

function drawText(ctx, el, kx, ky) {
  const color = el.red ? "rgb(198,40,40)" : "#000";
  const chars = [...el.chars];
  const cellW = el.gw * kx;
  const cellH = el.gh * ky;

  if (el.rev) {
    ctx.fillStyle = color;
    ctx.fillRect(el.x * kx, el.y * ky, el.adv * chars.length * kx, cellH);
  }
  const ink = el.rev ? "#fff" : color;

  chars.forEach((ch, i) => {
    const x = (el.x + i * el.adv) * kx;
    const y = el.y * ky;
    if (ch === " ") return;
    if (el.rot || el.up) {
      ctx.save();
      if (el.up) {
        ctx.translate(x + cellW, y + cellH);
        ctx.rotate(Math.PI);
        if (el.rot) {
          ctx.translate(cellW, 0);
          ctx.rotate(Math.PI / 2);
          drawGlyph(ctx, ch, 0, 0, cellH, cellW, el.bold, ink);
        } else drawGlyph(ctx, ch, 0, 0, cellW, cellH, el.bold, ink);
      } else {
        // 90° clockwise: the glyph's width runs down the paper.
        ctx.translate(x + cellW, y);
        ctx.rotate(Math.PI / 2);
        drawGlyph(ctx, ch, 0, 0, cellH, cellW, el.bold, ink);
      }
      ctx.restore();
    } else {
      drawGlyph(ctx, ch, x, y, cellW, cellH, el.bold, ink);
    }
  });

  if (el.ul) {
    ctx.fillStyle = color;
    const t = el.ul * ky;
    ctx.fillRect(el.x * kx, el.y * ky + cellH - t, el.adv * chars.length * kx, t);
  }
}

function drawBits(ctx, el, kx, ky) {
  const src = decodeBits(el);
  const fullW = el.bw * el.sx;
  const clipW = Math.min(el.w, fullW);
  ctx.save();
  ctx.beginPath();
  ctx.rect(el.x * kx, el.y * ky, clipW * kx, el.h * ky);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  if (el.red) {
    // Tint: draw the mask, then colour it in.
    const tmp = document.createElement("canvas");
    tmp.width = src.width;
    tmp.height = src.height;
    const t = tmp.getContext("2d");
    t.drawImage(src, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = "rgb(198,40,40)";
    t.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(tmp, el.x * kx, el.y * ky, fullW * kx, el.bh * el.sy * ky);
  } else {
    ctx.drawImage(src, el.x * kx, el.y * ky, fullW * kx, el.bh * el.sy * ky);
  }
  ctx.restore();
}

function drawBars(ctx, el, kx, ky) {
  ctx.fillStyle = "#000";
  let pos = 0;
  el.sbs.forEach((w, i) => {
    if (i % 2 === 0) ctx.fillRect((el.x + pos * el.mw) * kx, el.y * ky, w * el.mw * kx, el.h * ky);
    pos += w;
  });
}

function drawBox(ctx, el, kx, ky) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(el.x * kx + 1, el.y * ky + 1, el.w * kx - 2, el.h * ky - 2);
  ctx.font = `600 18px ${FONT_STACK}`;
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(el.label, (el.x + el.w / 2) * kx, (el.y + el.h / 2) * ky);
  ctx.restore();
}

/** Snap every pixel to ink, red ink or paper. */
function threshold(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    // Composite over white first: text antialiasing arrives as partial alpha.
    const r = d[i] * a + 255 * (1 - a);
    const g = d[i + 1] * a + 255 * (1 - a);
    const b = d[i + 2] * a + 255 * (1 - a);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let c = PAPER;
    if (lum < 150) c = r - g > 70 ? RED : INK;
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * @returns {HTMLCanvasElement} paper-width canvas, 1 px ≈ 1/8 mm
 */
export function renderTicket(ticket, profile, { crisp = true } = {}) {
  const kx = profile.unitMm.x * PX_PER_MM;
  const ky = profile.unitMm.y * PX_PER_MM;
  const margin = Math.round(((profile.paperMm - profile.printableMm) / 2) * PX_PER_MM);
  const printableW = Math.round(profile.widthUnits * kx);
  const width = printableW + margin * 2;
  const height = Math.max(8, Math.ceil(ticket.height * ky));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(margin, 0);

  for (const el of ticket.elements) {
    if (el.t === "text") drawText(ctx, el, kx, ky);
    else if (el.t === "bits") drawBits(ctx, el, kx, ky);
    else if (el.t === "bars") drawBars(ctx, el, kx, ky);
    else if (el.t === "box") drawBox(ctx, el, kx, ky);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (crisp) threshold(ctx, width, height);
  return canvas;
}

/** All tickets of a job stacked into one PNG-ready canvas, with cut marks. */
export function renderJobStrip(job, opts) {
  const parts = job.tickets.map((t) => renderTicket(t, job.profile, opts));
  const gap = 24;
  const width = Math.max(1, ...parts.map((c) => c.width));
  const height = parts.reduce((h, c) => h + c.height + gap, 0);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = Math.max(1, height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#e8e6e1";
  ctx.fillRect(0, 0, width, out.height);
  let y = 0;
  parts.forEach((c, i) => {
    ctx.drawImage(c, 0, y);
    y += c.height;
    const cut = job.tickets[i].cut;
    if (cut) {
      ctx.strokeStyle = "#888";
      ctx.setLineDash(cut === "partial" ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(0, y + gap / 2);
      ctx.lineTo(width, y + gap / 2);
      ctx.stroke();
    }
    y += gap;
  });
  return out;
}

import { renderJobStrip, renderTicket } from "./render.js";

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  printers: new Map(),
  jobs: [],
  selected: null, // printer id filter
  zoom: 70,
  crisp: true,
  sound: true,
};

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem("escpos-emulator") || "{}");
  } catch {
    return {};
  }
})();
Object.assign(state, { zoom: prefs.zoom ?? 70, crisp: prefs.crisp ?? true, sound: prefs.sound ?? true });
function savePrefs() {
  try {
    localStorage.setItem("escpos-emulator", JSON.stringify({ zoom: state.zoom, crisp: state.crisp, sound: state.sound }));
  } catch {
    // Private mode: preferences just don't persist.
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res;
}

// ───────────────────────────── printers ─────────────────────────────

function renderPrinters() {
  const host = $("#printers");
  host.innerHTML = "";
  for (const p of state.printers.values()) {
    const el = document.createElement("div");
    el.className = `printer${state.selected === p.id ? " selected" : ""}`;
    const dotClass = p.error ? "error" : p.mode !== "online" ? p.mode : p.listening ? "online" : "offline";
    const count = state.jobs.filter((j) => j.printerId === p.id).length;
    el.innerHTML = `
      <div class="p-head">
        <span class="p-name"><span class="dot ${dotClass}"></span>${escapeHtml(p.name)}</span>
        <span class="muted">${count} job${count === 1 ? "" : "s"}</span>
      </div>
      <div class="p-addr">${p.host}:${p.port}</div>
      <div class="p-profile">${p.profile.kind === "impact" ? "Dot matrix" : "Thermal"} · ${p.profile.paperMm}mm paper · ${Math.round(p.profile.widthUnits)} ${p.profile.kind === "impact" ? "half-dots" : "dots"}</div>
      ${p.busy ? `<div class="p-busy">printing…${p.queued ? ` (${p.queued} queued)` : ""}</div>` : ""}
      ${p.error ? `<div class="p-error">${escapeHtml(p.error)}</div>` : ""}
      <div class="p-controls">
        <select data-mode aria-label="Printer mode">
          ${["online", "offline", "hang"].map((m) => `<option value="${m}"${p.mode === m ? " selected" : ""}>${{ online: "Online", offline: "Offline (refuse)", hang: "Jammed (hang)" }[m]}</option>`).join("")}
        </select>
        ${[
          ["paperOut", "Paper out"],
          ["paperNearEnd", "Near end"],
          ["coverOpen", "Cover open"],
          ["drawerOpen", "Drawer open"],
        ]
          .map(([k, label]) => `<label><input type="checkbox" data-status="${k}"${p.status[k] ? " checked" : ""}/> ${label}</label>`)
          .join("")}
      </div>`;

    el.addEventListener("click", (e) => {
      if (e.target.closest(".p-controls")) return;
      state.selected = state.selected === p.id ? null : p.id;
      renderPrinters();
      renderJobs();
    });
    $("[data-mode]", el).addEventListener("change", (e) =>
      api(`/api/printers/${p.id}/mode`, { method: "POST", body: JSON.stringify({ mode: e.target.value }) }).catch(alertError),
    );
    el.querySelectorAll("[data-status]").forEach((box) =>
      box.addEventListener("change", () =>
        api(`/api/printers/${p.id}/status`, {
          method: "POST",
          body: JSON.stringify({ [box.dataset.status]: box.checked }),
        }).catch(alertError),
      ),
    );
    host.append(el);
  }
}

// ───────────────────────────── jobs ─────────────────────────────

function visibleJobs() {
  return state.jobs.filter((j) => !state.selected || j.printerId === state.selected);
}

function renderJobs() {
  const host = $("#jobs");
  host.innerHTML = "";
  const jobs = visibleJobs();
  const printer = state.selected && state.printers.get(state.selected);
  $("#feed-title").textContent = printer ? `Jobs on ${printer.name}` : "All jobs";
  $("#count").textContent = jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "";
  $("#empty").hidden = jobs.length > 0;
  for (const job of jobs.slice(0, 60)) host.append(jobCard(job));
}

function jobCard(job, fresh = false) {
  const card = $("#job-tpl").content.firstElementChild.cloneNode(true);
  card.dataset.id = job.id;
  if (fresh) card.classList.add("fresh");

  const started = new Date(job.startedAt);
  const ms = new Date(job.endedAt) - started;
  $(".j-printer", card).textContent = job.printerName;
  $(".j-meta", card).textContent = `${started.toLocaleTimeString()} · ${job.bytes.toLocaleString()} bytes · ${ms} ms · from ${job.from}`;

  const badges = $(".j-badges", card);
  const add = (text, cls = "") => {
    const b = document.createElement("span");
    b.className = `badge ${cls}`;
    b.textContent = text;
    badges.append(b);
  };
  add(`${job.tickets.length} ticket${job.tickets.length === 1 ? "" : "s"}`);
  for (const ev of job.events) {
    if (ev.type === "cut") add(ev.kind === "full" ? "✂ full cut" : "✂ partial cut", "cut");
    if (ev.type === "beep") add(`🔔 beep ×${ev.count}`);
    if (ev.type === "drawer") add(`💰 drawer kick (pin ${ev.pin})`);
    if (ev.type === "selftest") add("self-test");
  }

  const warnings = $(".j-warnings", card);
  for (const w of job.warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    warnings.append(li);
  }

  drawPaper(card, job);
  $(".pane-text pre", card).textContent = job.text || "(no text)";

  card.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      card.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      card.querySelectorAll(".pane").forEach((p) => (p.hidden = !p.classList.contains(`pane-${tab.dataset.tab}`)));
      if (tab.dataset.tab === "trace") loadTrace(card, job);
      if (tab.dataset.tab === "hex") loadHex(card, job);
    }),
  );

  card.querySelector("[data-act=png]").addEventListener("click", () => {
    renderJobStrip(job, { crisp: state.crisp }).toBlob((blob) => download(blob, `${job.id}.png`));
  });
  card.querySelector("[data-act=bin]").addEventListener("click", () => {
    location.href = `/api/jobs/${job.id}/raw`;
  });
  card.querySelector("[data-act=replay]").addEventListener("click", () =>
    api(`/api/jobs/${job.id}/replay`, { method: "POST" }).catch(alertError),
  );
  card.querySelector("[data-act=delete]").addEventListener("click", () =>
    api(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(alertError),
  );
  return card;
}

function drawPaper(card, job) {
  const pane = $(".pane-paper", card);
  pane.innerHTML = "";
  if (!job.tickets.length) {
    pane.innerHTML = `<p class="muted">Nothing printed — the job had no printable output.</p>`;
    return;
  }
  const roll = document.createElement("div");
  roll.className = "paper-roll";
  job.tickets.forEach((ticket, i) => {
    const canvas = renderTicket(ticket, job.profile, { crisp: state.crisp });
    canvas.style.width = `${(canvas.width * state.zoom) / 100}px`;
    const wrap = document.createElement("div");
    wrap.className = `ticket ${ticket.cut ? `cut-${ticket.cut}` : "uncut"}`;
    wrap.append(canvas);
    if (job.tickets.length > 1) {
      const label = document.createElement("p");
      label.className = "ticket-label";
      label.textContent = `Ticket ${i + 1}`;
      roll.append(label);
    }
    roll.append(wrap);
  });
  pane.append(roll);
}

async function loadTrace(card, job) {
  const host = $(".trace", card);
  if (host.dataset.loaded) return;
  host.dataset.loaded = "1";
  host.textContent = "loading…";
  const full = await (await api(`/api/jobs/${job.id}`)).json();
  host.textContent = "";
  for (const t of full.trace ?? []) {
    const o = document.createElement("span");
    o.className = "o";
    o.textContent = t.o.toString(16).padStart(5, "0");
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = t.c;
    const d = document.createElement("span");
    d.className = `d${t.c === "TEXT" ? " txt" : ""}${/UNSUPPORTED|unknown|REJECTED/.test(t.d) ? " warn" : ""}`;
    d.textContent = t.c === "TEXT" ? JSON.stringify(t.d) : t.d;
    host.append(o, c, d);
  }
  if ((full.trace ?? []).length >= 4000) host.append(Object.assign(document.createElement("span"), { textContent: "… trace truncated" }));
}

async function loadHex(card, job) {
  const pre = $(".pane-hex pre", card);
  if (pre.dataset.loaded) return;
  pre.dataset.loaded = "1";
  const buf = new Uint8Array(await (await api(`/api/jobs/${job.id}/raw`)).arrayBuffer());
  const limit = Math.min(buf.length, 16384);
  const lines = [];
  for (let i = 0; i < limit; i += 16) {
    const row = buf.subarray(i, Math.min(i + 16, limit));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > limit) lines.push(`… ${buf.length - limit} more bytes (download the .bin for all of it)`);
  pre.textContent = lines.join("\n");
}

// ───────────────────────────── effects ─────────────────────────────

let audio;
function beep(count, durationMs) {
  if (!state.sound) return;
  try {
    audio ??= new AudioContext();
    const dur = Math.max(0.05, Math.min(0.5, durationMs / 1000));
    for (let i = 0; i < Math.min(count, 9); i++) {
      const t = audio.currentTime + i * (dur + 0.08);
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 2700;
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.setValueAtTime(0, t + dur);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur);
    }
  } catch {
    // No audio device or autoplay blocked: the badge still shows the beep.
  }
}

function showProbe(probe) {
  const printer = state.printers.get(probe.printerId);
  const el = document.createElement("div");
  el.className = "probe";
  el.textContent = `${new Date(probe.at).toLocaleTimeString()} · ${probe.kind === "status" ? `status query (${probe.bytes} bytes)` : "connection test"} from ${probe.from} → ${printer?.name ?? probe.printerId}`;
  const host = $("#probes");
  host.prepend(el);
  while (host.children.length > 5) host.lastChild.remove();
}

// ───────────────────────────── wiring ─────────────────────────────

function connect() {
  const es = new EventSource("/events");
  const live = $("#live");
  es.onopen = () => {
    live.textContent = "live";
    live.classList.add("on");
  };
  es.onerror = () => {
    live.textContent = "reconnecting…";
    live.classList.remove("on");
  };
  es.addEventListener("printer", (e) => {
    const p = JSON.parse(e.data);
    state.printers.set(p.id, p);
    renderPrinters();
  });
  es.addEventListener("job", (e) => {
    const job = JSON.parse(e.data);
    state.jobs.unshift(job);
    for (const ev of job.events) if (ev.type === "beep") beep(ev.count, ev.durationMs);
    if (!state.selected || state.selected === job.printerId) {
      $("#empty").hidden = true;
      $("#jobs").prepend(jobCard(job, true));
      const jobs = visibleJobs();
      $("#count").textContent = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
    }
    renderPrinters();
  });
  es.addEventListener("probe", (e) => showProbe(JSON.parse(e.data)));
  es.addEventListener("removed", (e) => {
    const { id } = JSON.parse(e.data);
    state.jobs = state.jobs.filter((j) => j.id !== id);
    document.querySelector(`.job[data-id="${CSS.escape(id)}"]`)?.remove();
    renderPrinters();
  });
  es.addEventListener("cleared", (e) => {
    const { printerId } = JSON.parse(e.data);
    state.jobs = printerId ? state.jobs.filter((j) => j.printerId !== printerId) : [];
    renderJobs();
    renderPrinters();
  });
}

function setupControls() {
  const zoom = $("#zoom");
  zoom.value = state.zoom;
  $("#zoom-out").textContent = `${state.zoom}%`;
  zoom.addEventListener("input", () => {
    state.zoom = Number(zoom.value);
    $("#zoom-out").textContent = `${state.zoom}%`;
    document.querySelectorAll(".ticket canvas").forEach((c) => (c.style.width = `${(c.width * state.zoom) / 100}px`));
    savePrefs();
  });
  const crisp = $("#crisp");
  crisp.checked = state.crisp;
  crisp.addEventListener("change", () => {
    state.crisp = crisp.checked;
    savePrefs();
    renderJobs();
  });
  const sound = $("#sound");
  sound.checked = state.sound;
  sound.addEventListener("change", () => {
    state.sound = sound.checked;
    savePrefs();
  });
  $("#clear").addEventListener("click", () => {
    const q = state.selected ? `?printer=${encodeURIComponent(state.selected)}` : "";
    if (confirm(state.selected ? "Clear this printer's jobs?" : "Clear all jobs?")) api(`/api/jobs${q}`, { method: "DELETE" }).catch(alertError);
  });

  const drop = $("#drop");
  const file = $("#file");
  const send = async (f) => {
    const target = state.selected ?? [...state.printers.keys()][0];
    if (!target) return;
    await api(`/api/printers/${target}/print`, { method: "POST", body: await f.arrayBuffer() }).catch(alertError);
  };
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => file.files[0] && send(file.files[0]));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) send(f);
  });
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function alertError(error) {
  alert(error.message);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function init() {
  setupControls();
  const [printers, jobs] = await Promise.all([
    api("/api/printers").then((r) => r.json()),
    api("/api/jobs").then((r) => r.json()),
  ]);
  for (const p of printers) state.printers.set(p.id, p);
  state.jobs = jobs;
  renderPrinters();
  renderJobs();
  connect();
}

init().catch(alertError);

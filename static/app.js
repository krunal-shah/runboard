/* runboard frontend.
 *
 * Colors: the 8-slot validated categorical palette (light+dark steps).
 * Slots are assigned to runs in selection order (lowest free slot) and are
 * sticky while the run stays selected — deselecting other runs never
 * repaints survivors. Runs 9..16 reuse the palette with a dash pattern
 * (composite encoding), so identity is never carried by hue alone.
 */
(() => {
"use strict";

// ------------------------------------------------------------------ consts

const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark:  ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const CHROME = {
  light: { muted: "#898781", grid: "#e1e0d9", ink2: "#52514e" },
  dark:  { muted: "#898781", grid: "#2c2c2a", ink2: "#c3c2b7" },
};
const LS_KEY = "runboard:v1";
const REFRESH_MS = 30_000;
const MAX_CARDS = 400;
const MAX_LIST_ROWS = 600;
const MAX_SELECT_VISIBLE = 30;
const LIVE_WINDOW_S = 15 * 60;
const CHART_H = { s: 170, m: 240, l: 340 };
const CARD_MIN = { s: 330, m: 430, l: 580 };
const FETCH_POINTS = 1200;

// ------------------------------------------------------------------ state

const state = {
  theme: "system",        // system | light | dark
  selected: [],           // ordered run ids
  slots: {},              // runId -> palette slot index (may exceed 7)
  aliases: {},            // runId -> display alias
  pins: [],               // ordered pinned tag names
  collapsed: {},          // group -> true
  logTags: {},            // tag -> true
  smoothing: 0,
  xmode: "step",          // step | rel | wall
  chartSize: "m",
  linkZoom: true,
  autoRefresh: true,
};

let runs = [];                    // /api/runs order (mtime desc)
let runIndex = new Map();         // id -> info
let serverClockSkew = 0;          // server now - client now
let tagsByRun = new Map();        // runId -> Set(tag)
let runVersions = new Map();      // runId -> last seen server version
let charts = new Map();           // tag -> ChartCard
let runSearch = "", tagFilter = "";
let hoveredChart = null;
let applyingZoom = false;
let tagsFetchSeq = 0;

// ------------------------------------------------------------------ utils

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function saveState() {
  clearTimeout(saveState._t);
  saveState._t = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }, 250);
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    for (const k of Object.keys(state)) if (k in s) state[k] = s[k];
  } catch (e) {}
}

function effTheme() {
  if (state.theme !== "system") return state.theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function runColor(runId) {
  const slot = state.slots[runId] ?? 0;
  return PALETTE[effTheme()][slot % 8];
}
function runDashed(runId) { return (state.slots[runId] ?? 0) >= 8; }
function runName(runId) { return state.aliases[runId] || runId; }

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function matcher(query) {
  const q = query.trim();
  if (!q) return () => true;
  const m = q.match(/^\/(.*)\/$/);
  if (m) {
    try { const re = new RegExp(m[1], "i"); return (s) => re.test(s); }
    catch (e) { return () => true; }
  }
  const toks = q.toLowerCase().split(/\s+/);
  return (s) => { const l = s.toLowerCase(); return toks.every((t) => l.includes(t)); };
}

function fmtSI(v) {
  if (v == null || !isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e12) return trim(v / 1e12) + "T";
  if (a >= 1e9) return trim(v / 1e9) + "G";
  if (a >= 1e6) return trim(v / 1e6) + "M";
  if (a >= 1e3) return trim(v / 1e3) + "k";
  if (a >= 1 || a === 0) return trim(v);
  if (a >= 1e-3) return trim(v);
  return v.toExponential(1);
  function trim(x) { return String(parseFloat(x.toPrecision(3))); }
}
function fmtVal(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(4);
  return String(parseFloat(v.toPrecision(5)));
}
function fmtAgo(sec) {
  if (sec < 90) return "now";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  if (sec < 86400) return Math.round(sec / 3600) + "h";
  return Math.round(sec / 86400) + "d";
}

// TB-style debiased EMA.
function ema(vals, a) {
  const out = new Array(vals.length);
  let s = 0, n = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) { out[i] = null; continue; }
    s = a * s + (1 - a) * v;
    n++;
    out[i] = s / (1 - Math.pow(a, n));
  }
  return out;
}

// ------------------------------------------------------------------ slots

function assignSlot(runId) {
  if (runId in state.slots) return;
  const used = new Set(state.selected.map((r) => state.slots[r]).filter((s) => s != null));
  let s = 0;
  while (used.has(s)) s++;
  state.slots[runId] = s;
}

function toggleRun(runId) {
  const i = state.selected.indexOf(runId);
  if (i >= 0) {
    state.selected.splice(i, 1);
    delete state.slots[runId];
  } else {
    state.selected.push(runId);
    assignSlot(runId);
  }
  saveState();
  renderSidebar();
  onSelectionChange();
}

// ------------------------------------------------------------------ api

async function api(path, body) {
  const opts = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function fetchRuns(force) {
  const d = await api("/api/runs" + (force ? "?refresh=1" : ""));
  runs = d.runs;
  runIndex = new Map(runs.map((r) => [r.id, r]));
  serverClockSkew = d.now - Date.now() / 1000;
  $("scan-status").textContent = d.scanning ? "scanning…" : `${runs.length}`;
  renderSidebar();
}

async function fetchTags() {
  const sel = state.selected.filter((r) => runIndex.has(r));
  const seq = ++tagsFetchSeq;
  if (!sel.length) { tagsByRun = new Map(); rebuildStructure(); return; }
  $("scan-status").textContent = "loading tags…";
  try {
    const d = await api("/api/tags", { runs: sel });
    if (seq !== tagsFetchSeq) return; // superseded by a newer selection
    for (const [rid, info] of Object.entries(d.runs)) {
      tagsByRun.set(rid, new Set((info.tags || []).map((t) => t[0])));
      runVersions.set(rid, info.version);
    }
    for (const rid of [...tagsByRun.keys()]) if (!state.selected.includes(rid)) tagsByRun.delete(rid);
  } finally {
    $("scan-status").textContent = `${runs.length}`;
  }
  rebuildStructure();
}

// Batched scalar fetching with a short debounce.
const pendingFetch = new Map(); // "run\x00tag" -> {run, tag, version?}
function enqueueFetch(run, tag, version) {
  pendingFetch.set(run + "\x00" + tag, { run, tag, version });
  clearTimeout(enqueueFetch._t);
  enqueueFetch._t = setTimeout(flushFetch, 150);
}
async function flushFetch() {
  if (!pendingFetch.size) return;
  const series = [...pendingFetch.values()].slice(0, 512);
  for (const s of series) pendingFetch.delete(s.run + "\x00" + s.tag);
  let d;
  try {
    d = await api("/api/scalars", { series, points: FETCH_POINTS });
  } catch (e) {
    console.error(e);
    return;
  }
  for (const [rid, v] of Object.entries(d.versions || {})) runVersions.set(rid, v);
  const touched = new Set();
  for (const s of d.series || []) {
    const chart = charts.get(s.tag);
    if (!chart) continue;
    chart.data.set(s.run, s.empty
      ? { empty: true, version: s.version }
      : { step: s.step, wall: s.wall, value: s.value, version: s.version, n: s.n });
    touched.add(chart);
  }
  // series the server skipped (already current) still clear the loading state
  for (const s of series) {
    const chart = charts.get(s.tag);
    if (chart) touched.add(chart);
  }
  for (const chart of touched) chart.render();
  if (pendingFetch.size) flushFetch();
}

// ------------------------------------------------------------------ sidebar

function renderSidebar() {
  renderSelectedList();
  renderRunList();
}

function renderSelectedList() {
  const box = $("selected-list");
  box.textContent = "";
  $("selected-count").textContent = state.selected.length ? `(${state.selected.length})` : "";
  for (const rid of state.selected) {
    const info = runIndex.get(rid);
    const row = el("div", "run-row");
    const chip = el("span", "chip" + (runDashed(rid) ? " dashed" : ""));
    chip.style.setProperty("--chip-color", runColor(rid));
    chip.style.background = runDashed(rid) ? "" : runColor(rid);
    if (runDashed(rid)) chip.style.setProperty("background-color", runColor(rid));
    row.appendChild(chip);
    const name = el("span", "name");
    name.textContent = runName(rid);
    name.title = rid + (info ? "\n" + info.path : " (not found in current scan)");
    if (!info) name.style.opacity = 0.45;
    row.appendChild(name);
    if (isLive(info)) row.appendChild(liveDot());
    const ren = el("button", "icon-btn", "✎");
    ren.title = "rename (client-side only)";
    ren.onclick = (e) => { e.stopPropagation(); startRename(row, name, rid); };
    row.appendChild(ren);
    const x = el("button", "icon-btn", "✕");
    x.title = "deselect";
    x.onclick = (e) => { e.stopPropagation(); toggleRun(rid); };
    x.style.visibility = "visible";
    row.appendChild(x);
    row.onclick = () => {};
    box.appendChild(row);
  }
}

function isLive(info) {
  if (!info) return false;
  return (Date.now() / 1000 + serverClockSkew) - info.mtime < LIVE_WINDOW_S;
}
function liveDot() {
  const d = el("span", "live-dot");
  d.title = "active: new events in the last 15 min";
  return d;
}

function startRename(row, nameEl, rid) {
  const inp = el("input", "rename-input");
  inp.value = state.aliases[rid] || "";
  inp.placeholder = rid.split("/").pop();
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v) state.aliases[rid] = v; else delete state.aliases[rid];
    saveState();
    renderSidebar();
    for (const c of charts.values()) if (c.u) c.render();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") inp.blur();
    if (e.key === "Escape") { inp.oninput = inp.onblur = null; renderSidebar(); }
  };
  inp.onblur = commit;
  inp.onclick = (e) => e.stopPropagation();
}

function renderRunList() {
  const box = $("run-list");
  box.textContent = "";
  const match = matcher(runSearch);
  const shown = runs.filter((r) => match(runName(r.id)) || match(r.id));
  $("run-count").textContent = `${shown.length}/${runs.length}`;
  const now = Date.now() / 1000 + serverClockSkew;
  const selSet = new Set(state.selected);
  for (const r of shown.slice(0, MAX_LIST_ROWS)) {
    const row = el("div", "run-row");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selSet.has(r.id);
    cb.onclick = (e) => { e.stopPropagation(); toggleRun(r.id); };
    row.appendChild(cb);
    if (selSet.has(r.id)) {
      const chip = el("span", "chip" + (runDashed(r.id) ? " dashed" : ""));
      chip.style.setProperty("--chip-color", runColor(r.id));
      if (!runDashed(r.id)) chip.style.background = runColor(r.id);
      row.appendChild(chip);
    }
    const name = el("span", "name");
    if (state.aliases[r.id]) {
      name.appendChild(el("span", "", state.aliases[r.id] + " "));
      name.appendChild(el("span", "orig", r.id));
    } else {
      name.textContent = r.id;
    }
    name.title = r.id + "\n" + r.path;
    row.appendChild(name);
    if (now - r.mtime < LIVE_WINDOW_S) row.appendChild(liveDot());
    const ren = el("button", "icon-btn", "✎");
    ren.title = "rename (client-side only)";
    ren.onclick = (e) => { e.stopPropagation(); startRename(row, name, r.id); };
    row.appendChild(ren);
    row.appendChild(el("span", "mtime", fmtAgo(now - r.mtime)));
    row.onclick = () => toggleRun(r.id);
    box.appendChild(row);
  }
  if (shown.length > MAX_LIST_ROWS) {
    box.appendChild(el("div", "run-row", `… ${shown.length - MAX_LIST_ROWS} more — narrow the search`));
  }
}

// ------------------------------------------------------------------ charts

function allSelectedTags() {
  const s = new Set();
  for (const rid of state.selected) {
    const t = tagsByRun.get(rid);
    if (t) for (const tag of t) s.add(tag);
  }
  return s;
}

function groupOf(tag) {
  const i = tag.indexOf("/");
  return i > 0 ? tag.slice(0, i) : "(other)";
}

class ChartCard {
  constructor(tag) {
    this.tag = tag;
    this.data = new Map();   // runId -> {step, wall, value, version, n} | {empty}
    this.u = null;
    this.seriesMeta = [];    // uPlot series idx-1 aligned: {run, kind}
    this.seriesKey = "";
    this.visible = false;
    this.zoomed = false;
    this.savedXRange = null;

    const card = this.el = el("div", "card");
    card.dataset.tag = tag;
    const head = el("div", "card-head");
    this.handle = el("span", "icon-btn drag-handle hidden", "⠿");
    this.handle.title = "drag to reorder";
    head.appendChild(this.handle);
    const nm = el("span", "tag-name", tag);
    nm.title = tag;
    head.appendChild(nm);
    this.logBtn = el("button", "icon-btn" + (state.logTags[tag] ? " on" : ""), "log");
    this.logBtn.title = "log-scale y axis";
    this.logBtn.onclick = () => {
      if (state.logTags[tag]) delete state.logTags[tag]; else state.logTags[tag] = true;
      this.logBtn.classList.toggle("on", !!state.logTags[tag]);
      saveState();
      this.render(true);
    };
    head.appendChild(this.logBtn);
    this.pinBtn = el("button", "icon-btn", "📌");
    this.pinBtn.title = "pin to top";
    this.pinBtn.onclick = () => togglePin(tag);
    head.appendChild(this.pinBtn);
    card.appendChild(head);
    this.plotEl = el("div", "plot");
    this.loadingEl = el("div", "loading", "…");
    this.plotEl.appendChild(this.loadingEl);
    card.appendChild(this.plotEl);
    this.plotEl.style.height = CHART_H[state.chartSize] + "px";

    this.plotEl.addEventListener("mouseenter", () => { hoveredChart = this; });
    this.plotEl.addEventListener("mouseleave", () => {
      if (hoveredChart === this) hoveredChart = null;
      hideTooltip();
    });
    setupCardDrag(this);
    observer.observe(card);
  }

  setPinned(p) {
    this.pinBtn.classList.toggle("on", p);
    this.pinBtn.textContent = p ? "📌" : "📌";
    this.pinBtn.title = p ? "unpin" : "pin to top";
    this.handle.classList.toggle("hidden", !p);
    this.el.draggable = false;
  }

  wanted() {
    // (run, version) pairs this chart needs fetched
    const out = [];
    for (const rid of state.selected) {
      const tags = tagsByRun.get(rid);
      if (!tags || !tags.has(this.tag)) continue;
      const d = this.data.get(rid);
      const cur = runVersions.get(rid);
      if (!d || (cur != null && d.version !== cur)) {
        out.push({ run: rid, version: d ? d.version : undefined });
      }
    }
    return out;
  }

  ensureData() {
    const w = this.wanted();
    for (const p of w) enqueueFetch(p.run, this.tag, p.version);
    if (w.length) this.loadingEl.classList.remove("hidden");
    if (!this.u) this.render();
  }

  // Build aligned uPlot data for current xmode/smoothing.
  buildData() {
    const perRun = [];
    for (const rid of state.selected) {
      const d = this.data.get(rid);
      if (!d || d.empty || !d.step || !d.step.length) continue;
      let xs;
      if (state.xmode === "step") xs = d.step;
      else if (state.xmode === "wall") xs = d.wall;
      else {
        const w0 = d.wall[0];
        xs = d.wall.map((w) => (w - w0) / 3600);
      }
      perRun.push({ rid, xs, ys: d.value });
    }
    if (!perRun.length) return null;

    // union of x values
    const seen = new Set();
    const xu = [];
    for (const s of perRun) for (const x of s.xs) if (!seen.has(x)) { seen.add(x); xu.push(x); }
    xu.sort((a, b) => a - b);
    const xpos = new Map(xu.map((x, i) => [x, i]));

    const log = !!state.logTags[this.tag];
    const cols = [];
    const meta = [];
    const sm = state.smoothing;
    for (const s of perRun) {
      const raw = new Array(xu.length).fill(null);
      for (let i = 0; i < s.xs.length; i++) {
        let v = s.ys[i];
        if (v != null && log && v <= 0) v = null;
        raw[xpos.get(s.xs[i])] = v;
      }
      if (sm > 0) {
        // smooth over the run's own points, then scatter into the union grid
        const own = [];
        for (let i = 0; i < s.xs.length; i++) own.push(s.ys[i]);
        const smoothed = ema(own, sm);
        const smCol = new Array(xu.length).fill(null);
        for (let i = 0; i < s.xs.length; i++) {
          let v = smoothed[i];
          if (v != null && log && v <= 0) v = null;
          smCol[xpos.get(s.xs[i])] = v;
        }
        cols.push(raw); meta.push({ run: s.rid, kind: "raw" });
        cols.push(smCol); meta.push({ run: s.rid, kind: "smooth" });
      } else {
        cols.push(raw); meta.push({ run: s.rid, kind: "main" });
      }
    }
    return { data: [xu, ...cols], meta };
  }

  render(force) {
    const built = this.buildData();
    if (!built) {
      if (this.u) { this.u.destroy(); this.u = null; }
      this.loadingEl.classList.remove("hidden");
      this.loadingEl.textContent = this.wanted().length ? "…" : "no data for selection";
      return;
    }
    this.loadingEl.classList.add("hidden");
    const key = JSON.stringify([built.meta, state.xmode, state.smoothing > 0 ? state.smoothing : 0,
      !!state.logTags[this.tag], effTheme(), state.chartSize,
      built.meta.map((m) => [runColor(m.run), runDashed(m.run)])]);
    if (this.u && key === this.seriesKey && !force) {
      this.u.setData(built.data, !this.zoomed);
      return;
    }
    this.seriesKey = key;
    this.seriesMeta = built.meta;
    if (this.u) {
      if (this.zoomed) {
        const sx = this.u.scales.x;
        this.savedXRange = [sx.min, sx.max];
      }
      this.u.destroy();
      this.u = null;
    }
    this.plotEl.style.height = CHART_H[state.chartSize] + "px";
    const w = this.plotEl.clientWidth || 400;
    this.u = new uPlot(this.opts(built.meta, w, CHART_H[state.chartSize]), built.data, this.plotEl);
    if (this.zoomed && this.savedXRange) {
      this.u.setScale("x", { min: this.savedXRange[0], max: this.savedXRange[1] });
    }
  }

  opts(meta, width, height) {
    const th = effTheme();
    const C = CHROME[th];
    const log = !!state.logTags[this.tag];
    const self = this;
    const series = [{}];
    for (const m of meta) {
      const color = runColor(m.run);
      const dashed = runDashed(m.run);
      if (m.kind === "raw") {
        series.push({
          stroke: hexToRgba(color, 0.25), width: 1.25, spanGaps: true,
          dash: dashed ? [6, 6] : undefined, points: { show: false },
        });
      } else {
        series.push({
          stroke: color, width: 2, spanGaps: true,
          dash: dashed ? [6, 6] : undefined, points: { show: false },
        });
      }
    }
    const axes = [
      {
        stroke: C.muted, font: "11px system-ui",
        grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.grid, width: 1, size: 6 },
        values: state.xmode === "wall" ? undefined
          : (u, vs) => vs.map((v) => state.xmode === "rel" ? fmtSI(v) + "h" : fmtSI(v)),
      },
      {
        stroke: C.muted, font: "11px system-ui", size: 56,
        grid: { stroke: C.grid, width: 1 }, ticks: { show: false },
        values: (u, vs) => vs.map(fmtSI),
      },
    ];
    return {
      width, height,
      scales: {
        x: { time: state.xmode === "wall" },
        y: log ? { distr: 3, log: 10 } : {},
      },
      axes, series,
      legend: { show: false },
      cursor: {
        sync: { key: "rb", setSeries: false },
        drag: { x: true, y: false, setScale: true },
        points: { size: 7 },
        dataIdx: (u, sidx, idx) => {
          const ys = u.data[sidx];
          if (!ys || ys[idx] != null) return idx;
          let l = idx - 1, r = idx + 1;
          while (l >= 0 || r < ys.length) {
            if (l >= 0 && ys[l] != null) return l;
            if (r < ys.length && ys[r] != null) return r;
            l--; r++;
          }
          return idx;
        },
      },
      hooks: {
        setCursor: [(u) => { if (hoveredChart === self) renderTooltip(self, u); }],
        setSelect: [(u) => {
          if (applyingZoom || !u.select || u.select.width <= 0) { self.zoomed = true; return; }
          self.zoomed = true;
          if (!state.linkZoom) return;
          const min = u.posToVal(u.select.left, "x");
          const max = u.posToVal(u.select.left + u.select.width, "x");
          applyingZoom = true;
          for (const c of charts.values()) {
            if (c !== self && c.u) { c.zoomed = true; c.u.setScale("x", { min, max }); }
          }
          applyingZoom = false;
        }],
      },
    };
  }

  resetZoom() {
    this.zoomed = false;
    this.savedXRange = null;
    if (this.u) this.u.setData(this.u.data, true);
  }

  resize() {
    this.plotEl.style.height = CHART_H[state.chartSize] + "px";
    if (this.u) this.u.setSize({ width: this.plotEl.clientWidth || 400, height: CHART_H[state.chartSize] });
  }

  destroy() {
    observer.unobserve(this.el);
    if (this.u) { this.u.destroy(); this.u = null; }
    this.el.remove();
  }
}

// double-click anywhere on a plot resets zoom (all charts when linked)
document.addEventListener("dblclick", (e) => {
  const card = e.target.closest && e.target.closest(".card");
  if (!card) return;
  const chart = charts.get(card.dataset.tag);
  if (!chart) return;
  if (state.linkZoom) for (const c of charts.values()) c.resetZoom();
  else chart.resetZoom();
});

// ------------------------------------------------------------------ tooltip

const tooltipEl = $("tooltip");
function hideTooltip() { tooltipEl.classList.add("hidden"); }

function renderTooltip(chart, u) {
  const idx = u.cursor.idx;
  if (idx == null || u.cursor.left < 0) { hideTooltip(); return; }
  const wantKind = state.smoothing > 0 ? "smooth" : "main";
  const rows = [];
  for (let si = 1; si < u.data.length; si++) {
    const m = chart.seriesMeta[si - 1];
    if (!m || (m.kind !== wantKind && m.kind !== "main")) continue;
    const di = (u.cursor.idxs && u.cursor.idxs[si] != null) ? u.cursor.idxs[si] : idx;
    const v = u.data[si][di];
    if (v == null) continue;
    rows.push({ run: m.run, v, py: u.valToPos(v, "y") });
  }
  if (!rows.length) { hideTooltip(); return; }
  rows.sort((a, b) => b.v - a.v);
  let nearest = null, best = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.py - u.cursor.top);
    if (d < best) { best = d; nearest = r; }
  }
  tooltipEl.textContent = "";
  const xv = u.data[0][idx];
  let xlabel;
  if (state.xmode === "step") xlabel = "step " + xv.toLocaleString();
  else if (state.xmode === "rel") xlabel = xv.toFixed(2) + " h";
  else xlabel = new Date(xv * 1000).toLocaleString();
  tooltipEl.appendChild(el("div", "tt-x", xlabel));
  for (const r of rows.slice(0, 14)) {
    const row = el("div", "tt-row" + (r === nearest ? " near" : ""));
    const chip = el("span", "chip");
    chip.style.background = runColor(r.run);
    if (runDashed(r.run)) chip.style.background =
      `repeating-linear-gradient(45deg, ${runColor(r.run)} 0 2px, transparent 2px 4px)`;
    row.appendChild(chip);
    row.appendChild(el("span", "nm", runName(r.run)));
    row.appendChild(el("span", "val", fmtVal(r.v)));
    tooltipEl.appendChild(row);
  }
  if (rows.length > 14) tooltipEl.appendChild(el("div", "tt-x", `+${rows.length - 14} more`));

  const rect = u.over.getBoundingClientRect();
  let x = rect.left + u.cursor.left + 14;
  let y = rect.top + u.cursor.top + 14;
  tooltipEl.classList.remove("hidden");
  const tw = tooltipEl.offsetWidth, thh = tooltipEl.offsetHeight;
  if (x + tw > innerWidth - 8) x = rect.left + u.cursor.left - tw - 14;
  if (y + thh > innerHeight - 8) y = innerHeight - thh - 8;
  tooltipEl.style.left = Math.max(4, x) + "px";
  tooltipEl.style.top = Math.max(4, y) + "px";
}

// ------------------------------------------------------------------ pinning

function togglePin(tag) {
  const i = state.pins.indexOf(tag);
  if (i >= 0) state.pins.splice(i, 1);
  else state.pins.push(tag);
  saveState();
  rebuildStructure();
}

function setupCardDrag(chart) {
  const card = chart.el;
  chart.handle.addEventListener("mousedown", () => { card.draggable = true; });
  card.addEventListener("dragstart", (e) => {
    if (!state.pins.includes(chart.tag)) { e.preventDefault(); return; }
    e.dataTransfer.setData("text/runboard-tag", chart.tag);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    card.draggable = false;
    card.classList.remove("dragging");
    clearDropMarks();
  });
  card.addEventListener("dragover", (e) => {
    if (!state.pins.includes(chart.tag)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const r = card.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    card.classList.add(before ? "drop-before" : "drop-after");
  });
  card.addEventListener("drop", (e) => {
    const tag = e.dataTransfer.getData("text/runboard-tag");
    if (!tag || tag === chart.tag) { clearDropMarks(); return; }
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    const from = state.pins.indexOf(tag);
    if (from < 0) return;
    state.pins.splice(from, 1);
    let to = state.pins.indexOf(chart.tag);
    if (!before) to += 1;
    state.pins.splice(to, 0, tag);
    saveState();
    clearDropMarks();
    rebuildStructure();
  });
}
function clearDropMarks() {
  for (const c of document.querySelectorAll(".drop-before,.drop-after"))
    c.classList.remove("drop-before", "drop-after");
}

// ------------------------------------------------------------------ layout

const observer = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const chart = charts.get(en.target.dataset.tag);
    if (!chart) continue;
    chart.visible = en.isIntersecting;
    if (en.isIntersecting) chart.ensureData();
  }
}, { root: null, rootMargin: "500px" });

function rebuildStructure() {
  const tagSet = allSelectedTags();
  const match = matcher(tagFilter);
  const shown = [...tagSet].filter((t) => match(t)).sort();
  const pinned = state.pins.filter((t) => tagSet.has(t));
  const pinnedSet = new Set(pinned);

  $("empty-hint").classList.toggle("hidden", state.selected.length > 0);

  // drop charts whose tag left the visible universe
  for (const [tag, chart] of [...charts.entries()]) {
    if (!tagSet.has(tag)) { chart.destroy(); charts.delete(tag); }
  }

  const getChart = (tag) => {
    let c = charts.get(tag);
    if (!c) { c = new ChartCard(tag); charts.set(tag, c); }
    return c;
  };

  // pinned section
  const pinGrid = $("pinned-grid");
  pinGrid.textContent = "";
  $("pinned-section").classList.toggle("hidden", pinned.length === 0);
  let budget = MAX_CARDS;
  for (const tag of pinned) {
    const c = getChart(tag);
    c.setPinned(true);
    pinGrid.appendChild(c.el);
    budget--;
  }

  // groups
  const groupsEl = $("groups");
  groupsEl.textContent = "";
  const groups = new Map();
  for (const tag of shown) {
    if (pinnedSet.has(tag)) continue;
    const g = groupOf(tag);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(tag);
  }
  let truncated = 0;
  for (const [g, tags] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sec = el("section", "group" + (state.collapsed[g] ? " collapsed" : ""));
    const head = el("div", "section-head");
    head.appendChild(el("span", "tri", "▾"));
    head.appendChild(el("span", "", g));
    head.appendChild(el("span", "hint", `${tags.length}`));
    head.onclick = () => {
      if (state.collapsed[g]) delete state.collapsed[g]; else state.collapsed[g] = true;
      saveState();
      rebuildStructure();
    };
    sec.appendChild(head);
    const grid = el("div", "chart-grid");
    sec.appendChild(grid);
    if (!state.collapsed[g]) {
      for (const tag of tags) {
        if (budget <= 0) { truncated += 1; continue; }
        budget--;
        const c = getChart(tag);
        c.setPinned(false);
        grid.appendChild(c.el);
      }
    } else {
      // collapsed: detach any existing cards so they stop observing viewport
      for (const tag of tags) {
        const c = charts.get(tag);
        if (c) c.el.remove();
      }
    }
    groupsEl.appendChild(sec);
  }
  if (truncated > 0) {
    groupsEl.appendChild(el("div", "section-head",
      `⚠ ${truncated} more charts not shown (cap ${MAX_CARDS}) — filter tags or collapse groups`));
  }

  // cards already on screen get no new IntersectionObserver event, so a
  // selection change must re-check their data needs explicitly
  for (const c of charts.values()) if (c.visible) c.ensureData();
}

function onSelectionChange() {
  fetchTags();
  // charts re-render with new series set once tag data arrives; also refresh
  // already-built charts immediately (color slots may have shifted)
  for (const c of charts.values()) c.render();
}

// ------------------------------------------------------------------ refresh

async function refreshTick() {
  if (!state.autoRefresh) return;
  try {
    await fetchRuns(false);
    const before = new Map(runVersions);
    for (const c of charts.values()) {
      if (!c.visible) continue;
      for (const rid of state.selected) {
        const tags = tagsByRun.get(rid);
        if (!tags || !tags.has(c.tag)) continue;
        const d = c.data.get(rid);
        enqueueFetch(rid, c.tag, d ? d.version : undefined);
      }
    }
    // if any selected run is live, re-pull its tag list occasionally so new
    // tags appear (cheap relative to scalars)
    const liveSel = state.selected.filter((r) => isLive(runIndex.get(r)));
    if (liveSel.length && (refreshTick._n = (refreshTick._n || 0) + 1) % 4 === 0) {
      await fetchTags();
    }
    void before;
  } catch (e) { console.error(e); }
}

// ------------------------------------------------------------------ topbar

function bindControls() {
  const smooth = $("smoothing");
  smooth.value = state.smoothing;
  $("smoothing-val").textContent = state.smoothing;
  smooth.oninput = () => {
    state.smoothing = parseFloat(smooth.value);
    $("smoothing-val").textContent = state.smoothing;
    saveState();
    clearTimeout(bindControls._st);
    bindControls._st = setTimeout(() => { for (const c of charts.values()) if (c.visible) c.render(); }, 120);
  };

  const xmode = $("xmode");
  xmode.value = state.xmode;
  xmode.onchange = () => {
    state.xmode = xmode.value;
    saveState();
    for (const c of charts.values()) { c.zoomed = false; c.savedXRange = null; if (c.visible) c.render(); }
  };

  const size = $("chart-size");
  size.value = state.chartSize;
  size.onchange = () => {
    state.chartSize = size.value;
    saveState();
    document.documentElement.style.setProperty("--card-min", CARD_MIN[state.chartSize] + "px");
    for (const c of charts.values()) c.resize();
  };
  document.documentElement.style.setProperty("--card-min", CARD_MIN[state.chartSize] + "px");

  const lz = $("link-zoom");
  lz.classList.toggle("on", state.linkZoom);
  lz.onclick = () => {
    state.linkZoom = !state.linkZoom;
    lz.classList.toggle("on", state.linkZoom);
    saveState();
  };

  const ar = $("auto-refresh");
  ar.classList.toggle("on", state.autoRefresh);
  ar.onclick = () => {
    state.autoRefresh = !state.autoRefresh;
    ar.classList.toggle("on", state.autoRefresh);
    saveState();
  };

  $("refresh-now").onclick = async () => {
    await fetchRuns(true);
    await fetchTags();
    for (const c of charts.values()) if (c.visible) c.ensureData();
  };

  const themeBtn = $("theme-btn");
  const applyTheme = () => {
    if (state.theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = state.theme;
    themeBtn.textContent = { system: "◐", light: "☀", dark: "☾" }[state.theme];
    themeBtn.title = "theme: " + state.theme;
    renderSidebar();
    for (const c of charts.values()) if (c.u) c.render(true);
  };
  themeBtn.onclick = () => {
    state.theme = { system: "light", light: "dark", dark: "system" }[state.theme];
    saveState();
    applyTheme();
  };
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  const tagF = $("tag-filter");
  tagF.oninput = () => {
    clearTimeout(bindControls._tf);
    bindControls._tf = setTimeout(() => { tagFilter = tagF.value; rebuildStructure(); }, 250);
  };

  const runS = $("run-search");
  runS.oninput = () => {
    clearTimeout(bindControls._rs);
    bindControls._rs = setTimeout(() => { runSearch = runS.value; renderRunList(); }, 200);
  };

  $("select-visible").onclick = () => {
    const match = matcher(runSearch);
    const vis = runs.filter((r) => match(runName(r.id)) || match(r.id));
    const room = MAX_SELECT_VISIBLE - state.selected.length;
    if (vis.length > room) alert(`Selecting the first ${Math.max(0, room)} of ${vis.length} matches (cap ${MAX_SELECT_VISIBLE} selected runs).`);
    for (const r of vis) {
      if (state.selected.length >= MAX_SELECT_VISIBLE) break;
      if (!state.selected.includes(r.id)) {
        state.selected.push(r.id);
        assignSlot(r.id);
      }
    }
    saveState();
    renderSidebar();
    onSelectionChange();
  };

  $("clear-selection").onclick = () => {
    state.selected = [];
    state.slots = {};
    saveState();
    renderSidebar();
    onSelectionChange();
  };

  $("export-state").onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "runboard-state.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("import-state").onclick = () => $("import-file").click();
  $("import-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      for (const k of Object.keys(state)) if (k in s) state[k] = s[k];
      saveState();
      location.reload();
    } catch (err) { alert("Could not parse state file: " + err); }
  };

  window.addEventListener("resize", () => {
    clearTimeout(bindControls._rz);
    bindControls._rz = setTimeout(() => { for (const c of charts.values()) c.resize(); }, 150);
  });
}

// ------------------------------------------------------------------ init

async function init() {
  loadState();
  bindControls();
  await fetchRuns(false);
  if (state.selected.length) await fetchTags();
  else rebuildStructure();
  setInterval(refreshTick, REFRESH_MS);
}

init();

// debugging/testing handle
window.__rb = { state, charts: () => charts, runs: () => runs };

})();

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
// hard cap on selected runs: 8 palette slots x 4 line patterns stays
// distinguishable; also keeps every selection under the server's 64-run cap
const MAX_SELECTED = 30;
const DASH_CYCLES = [null, [6, 6], [2, 4], [12, 3, 3, 3]];
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

function saveStateNow() {
  clearTimeout(saveState._t);
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
function saveState() {
  clearTimeout(saveState._t);
  saveState._t = setTimeout(saveStateNow, 250);
}
// a pending debounced write must not be lost to navigation/close
window.addEventListener("beforeunload", saveStateNow);

// Every externally-sourced state blob (localStorage or an imported file)
// passes through the same validators — a malformed field falls back to the
// default instead of breaking init, and content is pruned per-entry.
const isPlainObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const STATE_VALIDATORS = {
  theme: (v) => ["system", "light", "dark"].includes(v),
  selected: Array.isArray,
  slots: isPlainObj,
  aliases: isPlainObj,
  pins: Array.isArray,
  collapsed: isPlainObj,
  logTags: isPlainObj,
  smoothing: (v) => typeof v === "number" && isFinite(v) && v >= 0 && v < 1,
  xmode: (v) => ["step", "rel", "wall"].includes(v),
  chartSize: (v) => ["s", "m", "l"].includes(v),
  linkZoom: (v) => typeof v === "boolean",
  autoRefresh: (v) => typeof v === "boolean",
};

function applyState(s) {
  if (!isPlainObj(s)) return false;
  for (const k of Object.keys(state)) {
    if (k in s && STATE_VALIDATORS[k] && STATE_VALIDATORS[k](s[k])) state[k] = s[k];
  }
  state.selected = state.selected.filter((x) => typeof x === "string");
  state.pins = state.pins.filter((x) => typeof x === "string");
  for (const [k, v] of Object.entries(state.slots)) {
    if (typeof v !== "number" || !isFinite(v) || v < 0) delete state.slots[k];
  }
  for (const [k, v] of Object.entries(state.aliases)) {
    if (typeof v !== "string" || !v) delete state.aliases[k];
  }
  for (const obj of [state.collapsed, state.logTags]) {
    for (const [k, v] of Object.entries(obj)) if (v !== true) delete obj[k];
  }
  // persisted/imported state honors the same cap as interactive selection —
  // the server truncates at 64 and 65+ would silently drop runs
  if (state.selected.length > MAX_SELECTED) {
    for (const rid of state.selected.slice(MAX_SELECTED)) delete state.slots[rid];
    state.selected = state.selected.slice(0, MAX_SELECTED);
  }
  return true;
}

function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) {}
  applyState(s);
}

function effTheme() {
  if (state.theme !== "system") return state.theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function runColor(runId) {
  const slot = state.slots[runId] ?? 0;
  return PALETTE[effTheme()][slot % 8];
}
function runDash(runId) {
  return DASH_CYCLES[Math.floor((state.slots[runId] ?? 0) / 8) % DASH_CYCLES.length];
}
function runDashed(runId) { return runDash(runId) != null; }

// Legend/tooltip chip that shows the run's ACTUAL line style: a solid square
// for cycle 0, otherwise a line sample drawn with the same dash pattern —
// so slots 8/16/24 are distinguishable in the legend, not just on the plot.
function chipEl(runId) {
  const color = runColor(runId);
  const dash = runDash(runId);
  if (!dash) {
    const c = el("span", "chip");
    c.style.background = color;
    return c;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 10");
  svg.classList.add("chip", "chip-line");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", "0"); line.setAttribute("x2", "16");
  line.setAttribute("y1", "5"); line.setAttribute("y2", "5");
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "3");
  line.setAttribute("stroke-dasharray", dash.map((v) => Math.max(1, Math.round(v / 2))).join(" "));
  svg.appendChild(line);
  return svg;
}
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
    if (state.selected.length >= MAX_SELECTED) {
      alert(`Selection cap is ${MAX_SELECTED} runs — deselect something first.`);
      renderSidebar(); // undo the checkbox tick
      return;
    }
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
  migrateSelectedIds();
  $("scan-status").textContent = d.scanning ? "scanning…" : `${runs.length}`;
  renderSidebar();
}

// A run's chosen id can migrate between scans (a shallower symlink appears,
// or a resume alias was selected in an older session). Remap selected ids
// that are now aliases onto the chosen id, carrying slot + rename along —
// otherwise the runIndex filter drops them before the server ever sees them.
function migrateSelectedIds() {
  const aliasToChosen = new Map();
  for (const r of runs) for (const a of (r.aliases || [])) aliasToChosen.set(a, r.id);
  let changed = false;
  state.selected = state.selected.map((rid) => {
    if (runIndex.has(rid)) return rid;
    const chosen = aliasToChosen.get(rid);
    if (!chosen) return rid; // genuinely gone: keep, rendered dimmed
    changed = true;
    if (rid in state.slots) {
      if (!(chosen in state.slots)) state.slots[chosen] = state.slots[rid];
      delete state.slots[rid];
    }
    if (state.aliases[rid] && !state.aliases[chosen]) {
      state.aliases[chosen] = state.aliases[rid];
      delete state.aliases[rid];
    }
    return chosen;
  });
  if (!changed) return;
  const seen = new Set();
  state.selected = state.selected.filter((rid) => !seen.has(rid) && seen.add(rid));
  saveState();
  onSelectionChange();
}

async function fetchTags(force) {
  const sel = state.selected.filter((r) => runIndex.has(r));
  const seq = ++tagsFetchSeq;
  if (!sel.length) { tagsByRun = new Map(); rebuildStructure(); return; }
  $("scan-status").textContent = "loading tags…";
  try {
    const d = await api("/api/tags", { runs: sel, force: !!force });
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
let forceNextFetch = false;     // set by "refresh now" to bypass the stat throttle
function enqueueFetch(run, tag, version) {
  pendingFetch.set(run + "\x00" + tag, { run, tag, version });
  clearTimeout(enqueueFetch._t);
  enqueueFetch._t = setTimeout(flushFetch, 150);
}
async function flushFetch() {
  if (!pendingFetch.size) return;
  const series = [...pendingFetch.values()].slice(0, 512);
  for (const s of series) pendingFetch.delete(s.run + "\x00" + s.tag);
  const smoothing = state.smoothing > 0 ? state.smoothing : 0;
  const force = forceNextFetch;
  forceNextFetch = false;
  let d;
  try {
    d = await api("/api/scalars", { series, points: FETCH_POINTS, smoothing, force });
  } catch (e) {
    console.error(e);
    return;
  }
  // the slider may have moved while this batch was in flight: a response
  // computed with a stale alpha must be dropped, not displayed, and the
  // affected charts re-requested under the current alpha
  const curSmoothing = state.smoothing > 0 ? state.smoothing : 0;
  if (smoothing !== curSmoothing) {
    for (const s of series) {
      const chart = charts.get(s.tag);
      if (chart && chart.visible) chart.ensureData();
    }
    return;
  }
  // responses can arrive out of order (a held-up batch landing after a
  // fresher one) — version bookkeeping and cached data must never regress
  for (const [rid, v] of Object.entries(d.versions || {})) {
    const cur = runVersions.get(rid);
    if (cur == null || v > cur) runVersions.set(rid, v);
  }
  const touched = new Set();
  for (const s of d.series || []) {
    const chart = charts.get(s.tag);
    if (!chart) continue;
    const prev = chart.data.get(s.run);
    if (prev && prev.smoothing === smoothing && prev.version >= s.version) continue;
    chart.data.set(s.run, s.empty
      ? { empty: true, version: s.version, smoothing }
      : { step: s.step, wall: s.wall, value: s.value, smooth: s.smooth,
          version: s.version, n: s.n, smoothing });
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
    row.appendChild(chipEl(rid));
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

function matchesRun(match, r) {
  // searchable surface: chosen id, client alias, and every symlink alias the
  // scanner found (e.g. a resume job id pointing at the same run dir)
  return match(r.id) || match(runName(r.id)) || (r.aliases || []).some(match);
}

function renderRunList() {
  const box = $("run-list");
  box.textContent = "";
  const match = matcher(runSearch);
  const shown = runs.filter((r) => matchesRun(match, r));
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
    if (selSet.has(r.id)) row.appendChild(chipEl(r.id));
    const name = el("span", "name");
    if (state.aliases[r.id]) {
      name.appendChild(el("span", "", state.aliases[r.id] + " "));
      name.appendChild(el("span", "orig", r.id));
    } else {
      name.textContent = r.id;
    }
    name.title = r.id + "\n" + r.path +
      ((r.aliases || []).length ? "\nalso: " + r.aliases.join("\n      ") : "");
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
    const sm = state.smoothing > 0 ? state.smoothing : 0;
    for (const rid of state.selected) {
      const tags = tagsByRun.get(rid);
      if (!tags || !tags.has(this.tag)) continue;
      const d = this.data.get(rid);
      const cur = runVersions.get(rid);
      const versionStale = !d || (cur != null && d.version !== cur);
      // smoothing is computed server-side over full-resolution data, so
      // cached entries built with a different alpha must be refetched —
      // without a version (a matching version would make the server skip)
      const smoothStale = d && sm > 0 && d.smoothing !== sm;
      if (versionStale || smoothStale) {
        out.push({ run: rid, version: smoothStale ? undefined : (d ? d.version : undefined) });
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
      perRun.push({ rid, xs, ys: d.value, smooth: d.smooth });
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
      // smoothed values come from the server (computed pre-downsampling);
      // until the refetch for a new alpha lands, render raw only
      if (sm > 0 && s.smooth) {
        const smCol = new Array(xu.length).fill(null);
        for (let i = 0; i < s.xs.length; i++) {
          let v = s.smooth[i];
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
      built.meta.map((m) => [runColor(m.run), runDash(m.run)])]);
    if (this.u && key === this.seriesKey && !force) {
      this.u.setData(built.data, !this.zoomed);
      return;
    }
    this.seriesKey = key;
    this.seriesMeta = built.meta;
    let savedCursor = null;
    if (this.u) {
      if (this.zoomed) {
        const sx = this.u.scales.x;
        this.savedXRange = [sx.min, sx.max];
      }
      // a recreate under the pointer (e.g. data landing mid-hover) would
      // otherwise kill the crosshair until the mouse moves again
      if (hoveredChart === this && this.u.cursor.left >= 0) {
        savedCursor = { left: this.u.cursor.left, top: this.u.cursor.top };
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
    if (savedCursor) this.u.setCursor(savedCursor);
  }

  opts(meta, width, height) {
    const th = effTheme();
    const C = CHROME[th];
    const log = !!state.logTags[this.tag];
    const self = this;
    const series = [{}];
    for (const m of meta) {
      const color = runColor(m.run);
      const dash = runDash(m.run) || undefined;
      if (m.kind === "raw") {
        series.push({
          stroke: hexToRgba(color, 0.25), width: 1.25, spanGaps: true,
          dash, points: { show: false },
        });
      } else {
        series.push({
          stroke: color, width: 2, spanGaps: true,
          dash, points: { show: false },
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
  const xv = u.data[0][idx];
  const rows = [];
  for (let si = 1; si < u.data.length; si++) {
    const m = chart.seriesMeta[si - 1];
    if (!m || (m.kind !== wantKind && m.kind !== "main")) continue;
    // cursor idxs are snapped to each series' nearest non-null point, which
    // can sit at a different x than the shared cursor — record the actual x
    // so runs with different logging cadences are never mislabeled
    const di = (u.cursor.idxs && u.cursor.idxs[si] != null) ? u.cursor.idxs[si] : idx;
    const v = u.data[si][di];
    if (v == null) continue;
    rows.push({ run: m.run, v, x: u.data[0][di], py: u.valToPos(v, "y") });
  }
  if (!rows.length) { hideTooltip(); return; }
  rows.sort((a, b) => b.v - a.v);
  let nearest = null, best = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.py - u.cursor.top);
    if (d < best) { best = d; nearest = r; }
  }
  tooltipEl.textContent = "";
  const fmtX = (x) => {
    if (state.xmode === "step") return "step " + x.toLocaleString();
    if (state.xmode === "rel") return x.toFixed(2) + " h";
    return new Date(x * 1000).toLocaleString();
  };
  tooltipEl.appendChild(el("div", "tt-x", fmtX(xv)));
  for (const r of rows.slice(0, 14)) {
    const row = el("div", "tt-row" + (r === nearest ? " near" : ""));
    row.appendChild(chipEl(r.run));
    row.appendChild(el("span", "nm", runName(r.run)));
    if (r.x !== xv) row.appendChild(el("span", "at", "@ " + fmtX(r.x)));
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

  const rendered = new Set();
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
  let truncated = 0;
  for (const tag of pinned) {
    if (budget <= 0) { truncated += 1; continue; } // pins honor the cap too
    const c = getChart(tag);
    c.setPinned(true);
    pinGrid.appendChild(c.el);
    rendered.add(tag);
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
        rendered.add(tag);
      }
    }
    groupsEl.appendChild(sec);
  }
  if (truncated > 0) {
    groupsEl.appendChild(el("div", "section-head",
      `⚠ ${truncated} more charts not shown (cap ${MAX_CARDS}) — filter tags or collapse groups`));
  }

  // destroy every chart not rendered this pass (filtered out, collapsed, or
  // its tag left the selection) — otherwise the map grows unboundedly across
  // filter changes; re-showing one is a cheap warm-cache refetch
  for (const [tag, chart] of [...charts.entries()]) {
    if (!rendered.has(tag)) { chart.destroy(); charts.delete(tag); }
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
    // smoothing is server-computed over full-resolution data, so a new alpha
    // means a refetch for visible charts (wanted() flags the mismatch)
    bindControls._st = setTimeout(() => {
      for (const c of charts.values()) if (c.visible) { c.ensureData(); c.render(); }
    }, 300);
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
    await fetchTags(true); // force=true bypasses the server's stat throttle
    forceNextFetch = true; // ...and so does the next scalar batch
    for (const c of charts.values()) {
      if (!c.visible) continue;
      for (const rid of state.selected) {
        const t = tagsByRun.get(rid);
        if (t && t.has(c.tag)) {
          const d = c.data.get(rid);
          enqueueFetch(rid, c.tag, d ? d.version : undefined);
        }
      }
    }
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
    const vis = runs.filter((r) => matchesRun(match, r));
    const room = MAX_SELECTED - state.selected.length;
    if (vis.length > room) alert(`Selecting the first ${Math.max(0, room)} of ${vis.length} matches (cap ${MAX_SELECTED} selected runs).`);
    for (const r of vis) {
      if (state.selected.length >= MAX_SELECTED) break;
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
      if (!applyState(s)) throw new Error("not a runboard state object");
      saveStateNow(); // synchronous — the debounced write would be lost to the reload
      location.reload();
    } catch (err) { alert("Could not import state file: " + err); }
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
window.__rb = { state, charts: () => charts, runs: () => runs,
                rebuild: rebuildStructure, renderSidebar };

})();

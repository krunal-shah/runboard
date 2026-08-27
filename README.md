# runboard

A fast, opinionated viewer for TensorBoard event files. Training keeps writing
normal `events.out.tfevents.*` files; runboard reads the same files but serves
a UI built for experiment comparison instead of TensorBoard's.

Built 2026-08-27 to fix five specific TensorBoard pains:

1. **Run selection** — sidebar with search (`words` or `/regex/`), one-click
   checkboxes, `+ visible` / `clear`, and a pinned "selected" section at the
   top that doubles as the global legend. Search also matches symlink aliases
   (e.g. a resume job id pointing at the same run dir).
2. **Pinning that works** — the 📌 on any chart moves it to a Pinned section at
   the top of the page. Persisted in the browser.
3. **Rearranging** — drag pinned cards by the ⠿ handle to reorder. Persisted.
4. **Renaming** — ✎ on any run renames it client-side (localStorage; the event
   files are never touched). The original id stays visible dimmed + on hover.
5. **Automatic colors** — runs get colors from a fixed 8-slot palette validated
   for contrast + color-blind separation in light and dark mode (see
   `docs/palette.md` note below). Slots are assigned in selection order and
   sticky — deselecting a run never recolors the others. Runs 9+ reuse the
   palette with distinct dash patterns (selection is capped at 30 runs so
   every combination stays distinguishable).

Also: TB-style debiased EMA smoothing, computed **server-side over the
full-resolution series** before downsampling so alpha means the same thing at
every zoom level (raw curve stays visible underneath),
log-scale per chart, x-axis as step / relative hours / wall clock, linked
drag-zoom across all charts (double-click resets), live-run indicators, 30 s
auto-refresh with **incremental** event-file parsing (only new bytes are read),
min/max-preserving downsampling (spikes survive), tag search, collapsible tag
groups, and export/import of the whole UI state as JSON.

## Run it

```bash
~/GitHub/runboard/run.sh            # 127.0.0.1:8898
```

From your laptop:

```bash
ssh -L 8898:localhost:8898 <login-node>
# then open http://localhost:8898
```

Flags: `--logdir` (default `/data/shared/tensorboard`), `--port` (8898),
`--host` (127.0.0.1 — keep it loopback on the shared login node; there is no
auth), `--scan-interval` (120 s), `--max-depth` (8).

Dependencies (all already in the `training` conda env): fastapi, uvicorn,
numpy, tensorboard (only for the `Event` protobuf).

## How it works

- **Discovery**: a background thread walks `--logdir` (following symlinks,
  deduping by realpath — the shared root is mostly symlinks) for directories
  containing `*.tfevents.*` files. ~1 000 runs scan in a few seconds on NFS.
- **Parsing**: event files are read as raw tfrecord framing + the `Event`
  proto — no `EventAccumulator`, no reservoir sampling. The 122 MB worst-case
  file in the shared root parses in ~4 s; after that only appended bytes are
  parsed (offset tracked per file), so live-following is cheap. Runs are
  parsed lazily on first selection and LRU-evicted above ~30 M points.
- **Resume semantics**: duplicate steps (crash → resume from an earlier
  checkpoint) resolve last-write-wins after a stable sort by step. A replaced,
  truncated, or deleted event file triggers a full reparse of that run so no
  stale points linger.
- **Tooltips are honest about cadence**: each series snaps to its own nearest
  point, and when that point's x differs from the cursor the row shows
  `@ step N` — runs logged at different cadences are never mislabeled.
- **Downsampling**: per-bucket min+max (~1 200 points per series), so spikes
  are never smoothed away by decimation.
- **Client state** (selection, aliases, pins, order, log toggles, theme) lives
  in `localStorage` under `runboard:v1`; the ⤓/⤒ topbar buttons export/import
  it as JSON to move between browsers.

## Tests

```bash
tests/run_all.sh        # backend + headless-Chromium UI suite, hermetic
```

Both suites build their own synthetic event-file corpus in a tempdir
(`tests/synthdata.py`) — no dependency on the shared logs. `test_backend.py`
covers parsing (incremental tail, resume last-wins, replace/truncate reparse,
stat throttle vs force), full-resolution EMA, spike-preserving downsampling,
and scanner alias handling. `test_ui.py` starts its own server on a free port
and drives selection, multi-run charts, rename, pin + drag-reorder, linked
zoom, log scale, persistence, chart-map GC, the pin/card cap, cadence-honest
tooltips, the stale-smoothing-response race (via a delayed intercepted
response), the persisted-selection cap, alias-id migration, and legend chip
patterns. Run them in the `training` conda env after any change.

## Palette provenance

The categorical colors and light/dark chrome are the reference dataviz palette
(8 slots, both modes), used verbatim in its documented slot order — that order
is validated for adjacent-pair color-blind separation (worst CVD ΔE 9.1 light /
8.4 dark) and normal-vision separation (19.6 / 19.3). Don't reorder the slots
casually; the ordering is the safety mechanism.

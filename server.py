#!/usr/bin/env python3
"""runboard — a fast, opinionated viewer for TensorBoard event files.

Reads the same events.out.tfevents.* files TensorBoard does, but serves a UI
built for experiment comparison: easy run selection, working chart pinning
with drag-reorder, client-side run renaming, and automatic contrast-safe
color assignment.

Run inside the `training` conda env (needs: fastapi, uvicorn, numpy,
tensorboard for the Event proto):

    python server.py --logdir /data/shared/tensorboard --port 8898
"""

import argparse
import json
import math
import os
import struct
import threading
import time
from pathlib import Path

import numpy as np
from array import array

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from tensorboard.compat.proto.event_pb2 import Event

STATIC_DIR = Path(__file__).resolve().parent / "static"

# ---------------------------------------------------------------- discovery

class Scanner:
    """Walks the log root for directories containing event files.

    Follows symlinks (the shared root is mostly symlinks into per-user
    trees) and dedupes by realpath, preferring the shallowest/shortest id.
    """

    def __init__(self, root: str, max_depth: int = 8, interval: float = 120.0):
        self.root = os.path.abspath(root)
        self.max_depth = max_depth
        self.interval = interval
        self.lock = threading.Lock()
        self.runs = {}          # id -> {id, path, mtime, size, nfiles, aliases}
        self.alias_index = {}   # alias id -> chosen id
        self.scanned_at = 0.0
        self.scanning = False
        self._wake = threading.Event()

    def start(self):
        t = threading.Thread(target=self._loop, daemon=True, name="scanner")
        t.start()

    def force(self):
        self._wake.set()

    def _loop(self):
        while True:
            try:
                self._scan()
            except Exception as e:  # keep the thread alive on NFS hiccups
                print(f"[scanner] scan failed: {e!r}")
            self._wake.wait(timeout=self.interval)
            self._wake.clear()

    def _scan(self):
        self.scanning = True
        t0 = time.time()
        found = {}      # realpath -> best (shallowest/shortest id) info
        alias_ids = {}  # realpath -> every id that reaches this run
        visited = set()

        def register(real: str, rel: str, entries):
            ev_files = [e for e in entries
                        if e.is_file(follow_symlinks=True) and ".tfevents." in e.name]
            if not ev_files:
                return
            size = mtime = 0
            for e in ev_files:
                try:
                    st = e.stat(follow_symlinks=True)
                    size += st.st_size
                    mtime = max(mtime, st.st_mtime)
                except OSError:
                    pass
            rid = rel if rel else "(root)"
            alias_ids.setdefault(real, set()).add(rid)
            prev = found.get(real)
            # prefer fewer path components, then shorter name
            if prev is None or (rid.count("/"), len(rid)) < (prev["id"].count("/"), len(prev["id"])):
                found[real] = {"id": rid, "path": real, "mtime": mtime,
                               "size": size, "nfiles": len(ev_files)}

        def walk(dirpath: str, rel: str, depth: int):
            try:
                real = os.path.realpath(dirpath)
                entries = list(os.scandir(dirpath))
            except OSError:
                return
            # every alias registers (id preference + searchability), but a
            # realpath's children are walked only once (cycle protection)
            register(real, rel, entries)
            if real in visited:
                return
            visited.add(real)
            if depth >= self.max_depth:
                return
            for e in entries:
                if e.name.startswith("."):
                    continue
                try:
                    if e.is_dir(follow_symlinks=True):
                        walk(e.path, f"{rel}/{e.name}" if rel else e.name, depth + 1)
                except OSError:
                    continue

        walk(self.root, "", 0)
        runs = {}
        alias_index = {}
        for real, info in found.items():
            info["aliases"] = sorted(alias_ids[real] - {info["id"]})
            runs[info["id"]] = info
            for a in info["aliases"]:
                alias_index[a] = info["id"]
        with self.lock:
            self.runs = runs
            self.alias_index = alias_index
            self.scanned_at = time.time()
            self.scanning = False
        print(f"[scanner] {len(runs)} runs in {time.time()-t0:.1f}s", flush=True)

    def snapshot(self):
        with self.lock:
            return dict(self.runs), self.scanned_at, self.scanning

    def resolve(self, run_id: str):
        with self.lock:
            info = self.runs.get(run_id)
            if info is None:
                # ids can migrate when a shallower symlink appears; keep old
                # selections working via the alias index
                chosen = getattr(self, "alias_index", {}).get(run_id)
                if chosen is not None:
                    info = self.runs.get(chosen)
            return info


# ---------------------------------------------------------------- parsing

class _FileState:
    __slots__ = ("offset", "size", "ino")

    def __init__(self):
        self.offset = 0
        self.size = 0
        self.ino = 0


class RunData:
    """Incrementally parsed scalar data for one run directory.

    Event files are append-only tfrecord streams; we remember the byte
    offset per file and only parse the tail on refresh. Truncated tail
    records (writer mid-flush) are left for the next refresh.
    """

    STAT_THROTTLE = 5.0

    def __init__(self, dirpath: str):
        self.dir = dirpath
        self.lock = threading.Lock()
        self.files = {}      # path -> _FileState
        self.tags = {}       # tag -> [array('q') steps, array('d') walls, array('d') vals]
        self.version = 0
        self.points = 0
        self.last_stat = 0.0
        self.last_access = 0.0

    def refresh(self, force: bool = False):
        with self.lock:
            now = time.time()
            if not force and now - self.last_stat < self.STAT_THROTTLE:
                return
            self.last_stat = now
            try:
                names = sorted(n for n in os.listdir(self.dir) if ".tfevents." in n)
            except OSError:
                return
            stats = {}
            for name in names:
                path = os.path.join(self.dir, name)
                try:
                    stats[path] = os.stat(path)
                except OSError:
                    continue
            # a replaced/truncated/deleted file invalidates points already
            # parsed from it, and points are not attributed per-file — so any
            # such change means a full reparse of the run
            reset = any(p not in stats for p in self.files)
            for path, st in stats.items():
                fs = self.files.get(path)
                if fs is not None and (st.st_ino != fs.ino or st.st_size < fs.offset):
                    reset = True
            if reset:
                self.files = {}
                self.tags = {}
                self.points = 0
            changed = reset
            for path, st in stats.items():
                fs = self.files.get(path)
                if fs is None:
                    fs = self.files[path] = _FileState()
                    fs.ino = st.st_ino
                if st.st_size > fs.offset:
                    changed |= self._parse_tail(path, fs)
                fs.size = st.st_size
            if changed:
                self.version += 1

    def _parse_tail(self, path: str, fs: _FileState) -> bool:
        try:
            with open(path, "rb") as f:
                f.seek(fs.offset)
                data = f.read()
        except OSError:
            return False
        off = 0
        L = len(data)
        tags = self.tags
        added = 0
        while off + 12 <= L:
            (length,) = struct.unpack_from("<Q", data, off)
            rec_start = off + 12
            rec_end = rec_start + length
            if rec_end + 4 > L:
                break  # incomplete tail record; retry next refresh
            ev = Event()
            try:
                ev.ParseFromString(data[rec_start:rec_end])
            except Exception:
                off = rec_end + 4
                continue
            if ev.HasField("summary"):
                step = ev.step
                wall = ev.wall_time
                for v in ev.summary.value:
                    val = None
                    if v.HasField("simple_value"):
                        val = v.simple_value
                    elif v.HasField("tensor"):
                        t = v.tensor
                        if len(t.float_val) == 1:
                            val = t.float_val[0]
                        elif len(t.double_val) == 1:
                            val = t.double_val[0]
                        elif t.dtype == 1 and len(t.tensor_content) == 4:
                            val = struct.unpack("<f", t.tensor_content)[0]
                    if val is None:
                        continue
                    tri = tags.get(v.tag)
                    if tri is None:
                        tri = tags[v.tag] = [array("q"), array("d"), array("d")]
                    tri[0].append(step)
                    tri[1].append(wall)
                    tri[2].append(val)
                    added += 1
            off = rec_end + 4
        fs.offset += off
        self.points += added
        return added > 0

    def tag_list(self):
        with self.lock:
            return [(t, len(tri[0])) for t, tri in self.tags.items()]

    def series(self, tag: str):
        """Return (steps, walls, vals) sorted by step, duplicate steps
        resolved last-write-wins (resume-from-checkpoint semantics)."""
        with self.lock:
            tri = self.tags.get(tag)
            if tri is None or len(tri[0]) == 0:
                return None
            steps = np.frombuffer(tri[0], dtype=np.int64).copy()
            walls = np.frombuffer(tri[1], dtype=np.float64).copy()
            vals = np.frombuffer(tri[2], dtype=np.float64).copy()
        order = np.argsort(steps, kind="stable")
        s = steps[order]
        keep = np.empty(len(s), dtype=bool)
        keep[:-1] = s[1:] != s[:-1]
        keep[-1] = True
        idx = order[keep]
        return s[keep], walls[idx], vals[idx]

    def drop(self):
        with self.lock:
            self.files = {}
            self.tags = {}
            self.points = 0
            self.version += 1


class Store:
    """RunData registry with a total-points LRU cap."""

    def __init__(self, max_points: int = 30_000_000):
        self.max_points = max_points
        self.lock = threading.Lock()
        self.data = {}  # realpath -> RunData

    def get(self, dirpath: str) -> RunData:
        with self.lock:
            rd = self.data.get(dirpath)
            if rd is None:
                rd = self.data[dirpath] = RunData(dirpath)
            rd.last_access = time.time()
        self._evict()
        return rd

    def _evict(self):
        with self.lock:
            total = sum(rd.points for rd in self.data.values())
            if total <= self.max_points:
                return
            by_age = sorted(self.data.values(), key=lambda r: r.last_access)
            for rd in by_age:
                if total <= self.max_points:
                    break
                if time.time() - rd.last_access < 60:
                    continue
                total -= rd.points
                rd.drop()


# ---------------------------------------------------------------- transforms

def downsample_idx(vals, target: int):
    """Indices for min/max-preserving decimation (spikes survive), or None
    to keep every point. Same indices are applied to raw and smoothed
    columns so they stay aligned."""
    n = len(vals)
    if n <= target:
        return None
    nb = max(1, target // 2)
    bounds = np.linspace(0, n, nb + 1).astype(np.int64)
    sel = {0, n - 1}
    for i in range(nb):
        a, b = int(bounds[i]), int(bounds[i + 1])
        if a >= b:
            continue
        seg = vals[a:b]
        if np.all(np.isnan(seg)):
            sel.add(a)
            continue
        sel.add(a + int(np.nanargmin(seg)))
        sel.add(a + int(np.nanargmax(seg)))
    return np.fromiter(sorted(sel), dtype=np.int64)


def ema_debiased(vals, alpha: float):
    """TB-style debiased EMA over the FULL-resolution series (smoothing must
    happen before downsampling or its strength depends on decimation).
    Non-finite values pass through untouched and don't advance the state."""
    out = np.full(len(vals), np.nan)
    m = np.isfinite(vals)
    v = vals[m]
    if len(v) == 0:
        return out
    try:
        from scipy.signal import lfilter
        s = lfilter([1.0 - alpha], [1.0, -alpha], v)
    except ImportError:
        s = np.empty(len(v))
        acc = 0.0
        for i in range(len(v)):
            acc = alpha * acc + (1.0 - alpha) * v[i]
            s[i] = acc
    debias = 1.0 - np.power(alpha, np.arange(1, len(v) + 1))
    out[m] = s / debias
    return out


def _jsonable_vals(vals):
    return [v if math.isfinite(v) else None for v in vals.tolist()]


# ---------------------------------------------------------------- app

app = FastAPI(title="runboard")
app.add_middleware(GZipMiddleware, minimum_size=1024)

scanner: Scanner = None  # initialized in main()
store = Store()


@app.get("/api/runs")
def api_runs(refresh: int = 0):
    if refresh:
        scanner.force()
        # small grace so a manual refresh usually returns fresh data
        deadline = time.time() + 15
        before = scanner.snapshot()[1]
        while time.time() < deadline:
            time.sleep(0.3)
            if scanner.snapshot()[1] != before:
                break
    runs, scanned_at, scanning = scanner.snapshot()
    out = sorted(runs.values(), key=lambda r: -r["mtime"])
    return {"runs": out, "scanned_at": scanned_at, "scanning": scanning,
            "root": scanner.root, "now": time.time()}


@app.post("/api/tags")
def api_tags(body: dict):
    run_ids = body.get("runs", [])[:64]
    force = bool(body.get("force"))
    out = {}
    for rid in run_ids:
        info = scanner.resolve(rid)
        if info is None:
            out[rid] = {"error": "unknown run", "version": 0, "tags": []}
            continue
        rd = store.get(info["path"])
        rd.refresh(force=force)
        out[rid] = {"version": rd.version,
                    "tags": [[t, c] for t, c in sorted(rd.tag_list())]}
    return {"runs": out}


@app.post("/api/scalars")
def api_scalars(body: dict):
    reqs = body.get("series", [])[:512]
    points = min(int(body.get("points", 1200)), 8000)
    force = bool(body.get("force"))
    smoothing = float(body.get("smoothing") or 0.0)
    if not (0.0 < smoothing < 1.0):
        smoothing = 0.0
    out = []
    versions = {}
    for req in reqs:
        rid, tag = req.get("run"), req.get("tag")
        info = scanner.resolve(rid)
        if info is None or tag is None:
            continue
        rd = store.get(info["path"])
        rd.refresh(force=force)
        versions[rid] = rd.version
        if req.get("version") == rd.version:
            continue  # client already has current data for this run
        tri = rd.series(tag)
        if tri is None:
            out.append({"run": rid, "tag": tag, "version": rd.version, "empty": True})
            continue
        steps, walls, vals = tri
        smooth = ema_debiased(vals, smoothing) if smoothing else None
        idx = downsample_idx(vals, points)
        if idx is not None:
            steps, walls, vals = steps[idx], walls[idx], vals[idx]
            if smooth is not None:
                smooth = smooth[idx]
        entry = {
            "run": rid, "tag": tag, "version": rd.version,
            "step": steps.tolist(),
            "wall": [round(w, 3) for w in walls.tolist()],
            "value": _jsonable_vals(vals),
            "n": len(tri[0]),
        }
        if smooth is not None:
            entry["smooth"] = _jsonable_vals(smooth)
        out.append(entry)
    return {"series": out, "versions": versions}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def main():
    global scanner
    ap = argparse.ArgumentParser(description="runboard server")
    ap.add_argument("--logdir", default="/data/shared/tensorboard")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8898)
    ap.add_argument("--scan-interval", type=float, default=120.0)
    ap.add_argument("--max-depth", type=int, default=8)
    args = ap.parse_args()

    scanner = Scanner(args.logdir, max_depth=args.max_depth,
                      interval=args.scan_interval)
    scanner.start()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

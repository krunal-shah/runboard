#!/usr/bin/env python3
"""Backend regression tests for runboard. Hermetic (tempdirs only).

Run inside the `training` conda env:  python tests/test_backend.py
"""

import os
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import RunData, Scanner, downsample_idx, ema_debiased  # noqa: E402

from torch.utils.tensorboard import SummaryWriter  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail)
    if not cond:
        FAILURES.append(name)


def test_incremental_and_resume():
    d = tempfile.mkdtemp()
    try:
        w = SummaryWriter(d, flush_secs=1000)
        for i in range(5):
            w.add_scalar("loss", 1.0 / (i + 1), i)
        w.flush()
        rd = RunData(d)
        rd.refresh(force=True)
        check("initial parse", rd.points == 5 and rd.version == 1)
        off1 = sum(f.offset for f in rd.files.values())

        for i in range(5, 10):
            w.add_scalar("loss", 1.0 / (i + 1), i)
        # resume semantics: steps 8,9 rewritten -> last write wins
        for i in range(8, 10):
            w.add_scalar("loss", 42.0 + i, i)
        w.flush()
        rd.refresh(force=True)
        off2 = sum(f.offset for f in rd.files.values())
        s, _, v = rd.series("loss")
        check("incremental append", rd.points == 12 and off2 > off1)
        check("sorted deduped steps", s.tolist() == list(range(10)))
        check("last-wins on duplicate steps", v[-2] == 50.0 and v[-1] == 51.0)
        w.close()
    finally:
        shutil.rmtree(d)


def test_ema_full_resolution():
    vals = np.arange(50_000, dtype=float)
    alpha = 0.9
    s = 0.0
    for v in vals:
        s = alpha * s + (1 - alpha) * v
    ref_last = s / (1 - alpha ** len(vals))
    sm = ema_debiased(vals, alpha)
    check("ema matches loop reference", abs(sm[-1] - ref_last) < 1e-6,
          f"{sm[-1]:.3f} vs {ref_last:.3f}")
    idx = downsample_idx(vals, 1200)
    check("downsampling preserves full-res smoothing",
          abs(sm[idx][-1] - ref_last) < 1e-6,
          "(EMA-after-downsample regression: was 49604.395 on this input)")
    v2 = vals.copy()
    v2[100:200] = np.nan
    sm2 = ema_debiased(v2, alpha)
    check("ema NaN passthrough", np.isnan(sm2[150]) and np.isfinite(sm2[300]))


def test_downsample_spike():
    n = 50_000
    steps = np.arange(n)
    walls = steps * 0.5
    vals = np.sin(steps / 500.0).astype(float)
    vals[1234] = 99.0
    vals[100:200] = np.nan
    idx = downsample_idx(vals, 1200)
    s, v = steps[idx], vals[idx]
    check("downsample keeps spike + stays sorted",
          99.0 in v.tolist() and bool(np.all(np.diff(s) > 0)) and len(s) <= 1200,
          f"out={len(s)}")
    void = walls  # unused
    del void


def test_replace_and_throttle():
    d = tempfile.mkdtemp()
    try:
        w = SummaryWriter(d, flush_secs=1000)
        for i in range(10):
            w.add_scalar("loss", float(i), i)
        w.close()
        rd = RunData(d)
        rd.refresh(force=True)
        v_before = rd.version
        check("pre-replace parse", rd.points == 10)

        # replace the event file entirely: old points must vanish
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        w = SummaryWriter(d, flush_secs=1000)
        for i in range(3):
            w.add_scalar("loss", float(i) * 100, i)
        w.close()
        rd.refresh(force=True)
        s, _, v = rd.series("loss")
        check("replace triggers full reparse",
              rd.points == 3 and len(s) == 3 and v[2] == 200.0,
              f"points={rd.points} steps={s.tolist()}")
        check("replace bumps version", rd.version > v_before)

        # stat throttle: unforced refresh right after is a no-op; force sees data
        w = SummaryWriter(d, flush_secs=1000)
        w.add_scalar("loss", 999.0, 50)
        w.flush()
        rd.refresh(force=False)
        n_throttled = rd.points
        rd.refresh(force=True)
        check("throttle holds without force", n_throttled == 3)
        check("force bypasses throttle", rd.points == 4)
        w.close()
    finally:
        shutil.rmtree(d)


def test_scanner_aliases():
    root = tempfile.mkdtemp()
    try:
        import synthdata
        synthdata.build(root, many_tags=3)
        sc = Scanner(root)
        sc._scan()
        runs, _, _ = sc.snapshot()
        check("dedupes aliases to one run",
              sum(1 for r in runs.values() if "real-run" in r["path"]) == 1)
        info = next(r for r in runs.values() if "real-run" in r["path"])
        check("shallowest id chosen", "/" not in info["id"], info["id"])
        check("both other aliases exposed",
              len(info["aliases"]) == 2
              and any(a.startswith("deep/") for a in info["aliases"]),
              str(info["aliases"]))
        check("resolve follows alias ids",
              sc.resolve("0002_alias_resume") is not None
              and sc.resolve("deep/nested/real-run") is not None)
        check("plain runs also discovered", "run-00" in runs and "manytags" in runs)
    finally:
        shutil.rmtree(root)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    test_incremental_and_resume()
    test_ema_full_resolution()
    test_downsample_spike()
    test_replace_and_throttle()
    test_scanner_aliases()
    print("ALL PASS" if not FAILURES else f"FAILED: {FAILURES}")
    sys.exit(1 if FAILURES else 0)

"""Synthetic event-file corpus for runboard tests (hermetic — no shared logs).

Layout written under `root`:
  run-00/            tag "loss" at steps 0,10,..,90 (value step/10); "acc/top1"
  run-01/            tag "loss" at steps 100,110,..,190 (value step/10 + 1)
  run-02/            tag "loss", 500 points with one big spike at step 123
  manytags/          460 tags x 2 points (chart-cap tests)
  deep/nested/real-run/          tag "loss" (alias-migration tests)
  0001_alias_short   -> deep/nested/real-run
  0002_alias_resume  -> deep/nested/real-run
"""

import math
import os

from torch.utils.tensorboard import SummaryWriter


def build(root: str, many_tags: int = 460):
    def writer(*parts):
        return SummaryWriter(os.path.join(root, *parts), flush_secs=1000)

    w = writer("run-00")
    for s in range(0, 100, 10):
        w.add_scalar("loss", s / 10.0, s)
        w.add_scalar("acc/top1", 0.5 + s / 1000.0, s)
    w.close()

    w = writer("run-01")
    for s in range(100, 200, 10):
        w.add_scalar("loss", s / 10.0 + 1.0, s)
        w.add_scalar("acc/top1", 0.4 + s / 1000.0, s)
    w.close()

    w = writer("run-02")
    for s in range(500):
        v = math.sin(s / 25.0)
        if s == 123:
            v = 99.0  # spike that downsampling must preserve
        w.add_scalar("loss", v, s)
    w.close()

    w = writer("manytags")
    for i in range(many_tags):
        for s in (0, 1):
            w.add_scalar(f"grp{i % 8}/metric_{i:04d}", float(i + s), s)
    w.close()

    real = os.path.join(root, "deep", "nested", "real-run")
    w = SummaryWriter(real, flush_secs=1000)
    for s in range(0, 50, 10):
        w.add_scalar("loss", float(s), s)
    w.close()
    os.symlink(real, os.path.join(root, "0001_alias_short"))
    os.symlink(real, os.path.join(root, "0002_alias_resume"))


if __name__ == "__main__":
    import sys
    build(sys.argv[1])
    print("synthetic corpus written to", sys.argv[1])

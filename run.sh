#!/usr/bin/env bash
# Start runboard inside the `training` conda env.
#   ./run.sh                          # 127.0.0.1:8898, logdir /data/shared/tensorboard
#   ./run.sh --port 9000 --logdir /some/where
set -euo pipefail
source ~/miniconda3/etc/profile.d/conda.sh
conda activate training
exec python "$(dirname "$(readlink -f "$0")")/server.py" "$@"

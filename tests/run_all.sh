#!/usr/bin/env bash
# Run the full runboard regression suite (backend + headless-browser UI).
# Needs the `training` conda env (numpy, torch, fastapi, uvicorn, playwright).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
source ~/miniconda3/etc/profile.d/conda.sh
conda activate training
python test_backend.py
python test_ui.py
echo "runboard test suite: ALL GREEN"

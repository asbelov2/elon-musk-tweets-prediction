#!/usr/bin/env bash
set -eu
export PIP_CACHE_DIR=/tmp/tweetscope-pip-cache
cd "$(dirname "$0")/.."
python3 -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.lock --disable-pip-version-check --cache-dir /tmp/tweetscope-pip-cache
.venv/bin/python -m pip check
.venv/bin/python -m unittest discover -s tests -q

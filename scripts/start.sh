#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
exec .venv/bin/python -m uvicorn app.main:app --host "${TWEETSCOPE_HOST:-127.0.0.1}" --port "${PORT:-8000}"

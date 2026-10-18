#!/usr/bin/env bash
set -eu
export npm_config_cache="${npm_config_cache:-/tmp/tweetscope-npm-cache}"
cd "$(dirname "$0")/.."
npm ci --include=dev
npm run check

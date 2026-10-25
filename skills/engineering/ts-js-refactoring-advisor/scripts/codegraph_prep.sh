#!/usr/bin/env bash
# Detect CodeGraph, sync its index if present, and print one status line the
# review workflow can act on.
#
# Usage: codegraph_prep.sh <repo-root>
#
# Output (last line) is one of:
#   CODEGRAPH=ready        installed, index exists, sync succeeded
#   CODEGRAPH=no-index     installed but the repo has no .codegraph/ index
#   CODEGRAPH=missing      CLI not installed (fall back to scan.py + grep)
#   CODEGRAPH=sync-failed  installed and indexed, but sync errored
#
# Sync is incremental and only touches .codegraph/. This script never runs
# `codegraph init` or `codegraph install`: those change the user's repo or
# agent config, so the reviewer should ask first.

set -u
ROOT="${1:-.}"
cd "$ROOT" 2>/dev/null || {
  echo "Cannot cd to $ROOT"
  echo "CODEGRAPH=missing"
  exit 0
}

CG=""
if command -v codegraph >/dev/null 2>&1; then
  CG="codegraph"
elif [ -x "./node_modules/.bin/codegraph" ]; then
  CG="./node_modules/.bin/codegraph"
fi

if [ -z "$CG" ]; then
  echo "codegraph CLI not found on PATH or in node_modules/.bin"
  echo "CODEGRAPH=missing"
  exit 0
fi

if [ ! -d ".codegraph" ]; then
  echo "codegraph is installed but this repo has no .codegraph/ index"
  echo "CODEGRAPH=no-index"
  exit 0
fi

echo "Syncing CodeGraph index..."
if timeout 120 "$CG" sync . 2>&1; then
  "$CG" status . 2>&1 | head -30
  echo "CODEGRAPH=ready"
else
  echo "codegraph sync failed or timed out; index may be stale"
  echo "CODEGRAPH=sync-failed"
fi

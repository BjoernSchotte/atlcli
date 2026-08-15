#!/usr/bin/env bash
set -euo pipefail

for attempt in 1 2 3; do
  if bun install --frozen-lockfile; then
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    exit 1
  fi
  sleep "$((attempt * 5))"
done

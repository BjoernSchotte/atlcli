#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../packages/export"

if ! command -v uv &> /dev/null; then
  echo "uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

echo "Installing dependencies with uv..."
uv sync

echo "Done. Run tests with: uv run pytest tests/ -v"

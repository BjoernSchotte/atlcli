#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="${ROOT_DIR}/packages/export"
VENV_DIR="${EXPORT_DIR}/.venv"

if [[ ! -d "${EXPORT_DIR}" ]]; then
  echo "Missing export package at ${EXPORT_DIR}" >&2
  exit 1
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Creating venv at ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
else
  echo "Using existing venv at ${VENV_DIR}"
fi

PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"

if [[ ! -x "${PYTHON}" ]]; then
  echo "Python not found in venv at ${PYTHON}" >&2
  exit 1
fi

echo "Installing atlcli-export with dev dependencies"
"${PIP}" install -e "${EXPORT_DIR}[dev]"

echo "Venv ready. Run tests with:"
echo "  ${PYTHON} -m pytest ${EXPORT_DIR}/tests/test_docx_renderer.py"

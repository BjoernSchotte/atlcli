# atlcli-export (Python)

This package powers DOCX exports for atlcli via a Python subprocess.

## Requirements

- Python 3.12+

## Local setup (recommended)

Create a virtual environment in `packages/export/.venv` so the CLI can
auto-detect it (`apps/cli/src/commands/export.ts` prefers this path).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Or run the helper script from repo root:

```bash
./scripts/setup-export-venv.sh
```

## Run tests

```bash
python -m pytest tests/test_docx_renderer.py
```

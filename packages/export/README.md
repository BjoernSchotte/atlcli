# atlcli-export (Python)

This package powers DOCX exports for atlcli via a Python subprocess.

## Requirements

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) for dependency management

## Local setup

```bash
# Install uv (if not installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies and create venv
cd packages/export
uv sync

# Run tests
uv run pytest tests/ -v
```

Or run the helper script from repo root:

```bash
./scripts/setup-export-venv.sh
```

## Run tests

```bash
uv run pytest tests/ -v
```

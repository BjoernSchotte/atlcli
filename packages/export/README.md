# atlcli-export (deprecated Python package)

This package is retained temporarily for removal/migration work only. Ordinary
DOCX and PDF exports do not invoke it: DOCX uses the TypeScript
`@atlcli/docx` engine and PDF uses the Typst/WASM pipeline. Do not add new
callers or features here.

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

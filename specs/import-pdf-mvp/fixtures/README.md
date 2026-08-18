# PDF-00 neutral fixture corpus

Every PDF in this directory is generated from `generate.py`, contains only
synthetic AtlCLI test content, and is licensed under the repository's
Apache-2.0 license. `truth.json` records the expected semantic facts, split
boundaries, byte sizes, and SHA-256 digests.

Regenerate in an isolated Python environment with the exact probe-only pins:

```bash
python3 -m venv .tmp/import-pdf-fixtures-venv
.tmp/import-pdf-fixtures-venv/bin/pip install \
  -r specs/import-pdf-mvp/fixtures/requirements.txt
.tmp/import-pdf-fixtures-venv/bin/python \
  specs/import-pdf-mvp/fixtures/generate.py
```

The encrypted negative fixture uses the public test password
`neutral-fixture`. It exists only to prove fail-closed classification and must
never be accepted by the V1 importer. Its encryption salt is intentionally
random, so the committed PDF and `truth.json` digest are authoritative; an
intentional regeneration updates both together after review.

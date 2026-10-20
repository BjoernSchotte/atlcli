# PDF-00 neutral fixture corpus

Every PDF in this directory is a frozen, synthetic AtlCLI test input licensed
under the repository's Apache-2.0 license. `truth.json` records the expected
semantic facts, split boundaries, byte sizes, and SHA-256 digests; tests read
only the committed bytes.

The corpus was generated with ReportLab, Pillow, and pypdf. That Python
generator was removed on 2026-10-20 because nothing regenerates the corpus;
its last version is `git show b0bc2218:specs/import-pdf-mvp/fixtures/generate.py`.
New or changed fixtures follow the TypeScript pattern of
`specs/pdf-import-quality/fixtures/generate-core.ts` and must update
`truth.json` in the same change.

The encrypted negative fixture uses the public test password
`neutral-fixture`. It exists only to prove fail-closed classification and must
never be accepted by the V1 importer. Its encryption salt is intentionally
random, so the committed PDF and `truth.json` digest are authoritative; an
intentional regeneration updates both together after review.

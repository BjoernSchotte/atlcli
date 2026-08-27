# PDF import quality drift record

**Task:** PIQ-00

**Checked:** 2026-08-27

**Architecture baseline:** `cb981dea1f83d4dd5e17932239e42f99a1a607c7`

**Plan commit:** `e126b453b1060779bf9cf896046d300505afc388`

**Implementation starting HEAD:** `e126b453b1060779bf9cf896046d300505afc388`

## Result

The mandatory in-scope drift command was empty. Between the architecture
baseline and the implementation starting point, only
`specs/pdf-import-quality/PLAN.md` was added; no PDF importer, Confluence
publisher, CLI E2E, quality script, existing PDF specification, documentation,
manifest, or lockfile behavior changed.

```text
git diff --stat cb981dea1f83d4dd5e17932239e42f99a1a607c7..HEAD -- <planned in-scope paths>
# empty
```

## V1 consumer audit

The required symbol search found `PdfFactsV1`, `PDF_FACTS_SCHEMA_V1`, and
`PdfFactsAdapter` only in:

- the current `@atlcli/import-pdf` implementation and tests; and
- public consumer compile-smoke scripts that assert the exported V1 surface.

No repository consumer persists V1 facts or semantic results outside the
current in-memory analysis/review/publication flow. PIQ-02 may therefore add V2
facts and keep V1 exports for the public deprecation window without a persisted
facts migration. The compile-smoke consumers must be extended to cover V2 while
their V1 compatibility assertions remain.

## Privacy boundary

Implementation and committed proof use neutral synthetic or independently
authored fixtures only. Private PDFs may be used transiently for authorized
local/LIVE acceptance, but neither their bytes nor any derived text, image,
metadata, digest, identifier, URL, receipt, or capture may enter Git, CI output,
commits, or pull-request communication.

No STOP condition was reached.

## PIQ-01 plan reconciliation

The implementation audit found that switching the production adapter to V2 in
PIQ-02 would make the existing V1 semantic pipeline and public factory contract
incoherent before the shared assembler exists. The plan now keeps PIQ-02
additive: it introduces V2 facts/factories plus an internal V2-to-V1 projection
while preserving V1 behavior and digests. PIQ-04 owns the atomic production,
policy, semantic-schema, and dependent-digest cutover.

The audit also added an explicit unresolved structure-kid variant, the V2
analysis-policy revision, reachable-closure regeneration, and the real browser
harness parity gates. No source implementation changed as part of this plan
reconciliation.

## PIQ-02 compatibility review

PIQ-02 remains additive as reconciled above. The existing production factory
still returns V1 facts, revision literals are unchanged, and two pinned neutral
V1 facts digests plus their options digest remain exact. A targeted review also
found and closed a potential canonical-size-budget drift: internal V2 evidence
is no longer allowed to reject a V1 result that remains within the caller's V1
budget. The public V2 surface is covered by built Node/browser parity and the
regenerated API report and reachable closure.

# Plan 002: Preserve numbered Word headings as explicit import semantics

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P1** · Effort: **M** · Risk: **MEDIUM**

Depends on: `specs/import-docx-mvp/PLAN.md` completed with evidence

Unblocks: `specs/009-import-docx/PLAN.md` (DOCX → page tree)

> **Executor instructions:** Read this file and the completed MVP plan/evidence before editing code. Run each verification gate and record commands, fixture digests, output snapshots, Cloud page IDs, and cleanup in `specs/002-import-docx/EVIDENCE.md`. A checkbox means the evidence exists. STOP rather than inventing a numbering rule or target macro.

---

## 1. Outcome and JTBD

Word headings whose visible number is generated from OOXML numbering (`w:numPr`) must not lose labels such as `1`, `1.1`, `1.1.1`, `A`, or `IV` when converted to Confluence. The import preview, semantic digest, page body, report, later page-tree titles, and safe DOCX roundtrip all use the same resolved heading-numbering model.

JTBD: **migrate a regulated handbook/specification while retaining the section identifiers people cite in meetings, contracts, tickets, and cross-references**.

Research basis:

- A December 2025 user with 200+ documents reports loss of multilevel heading numbering: https://community.atlassian.com/forums/Confluence-questions/Import-Word-documents-to-create-Confluence-pages/qaq-p/3166787
- Atlassian's unresolved multilevel-list issue shows that list numbering cannot be delegated blindly to the native importer: https://jira.atlassian.com/browse/CONFCLOUD-70686
- A January 2026 migration report also identifies heading/TOC classification as a source of manual cleanup: https://community.atlassian.com/forums/Confluence-questions/Confluence-Cloud-Not-Datacenter-Enhanced-flexible-version-of/qaq-p/3176430

These are qualitative signals, not population statistics. They justify an explicit semantic contract, not a claim that every Word numbering dialect can be rendered natively.

---

## 2. Scope

In scope:

- parse numbering definitions referenced by heading paragraphs;
- distinguish generated numbering from literal text that merely looks numbered;
- resolve level, start/restart, format, prefix/suffix, and the visible label deterministically;
- render an edition-neutral visible prefix by default;
- preserve enough provenance to prevent double numbering on reimport/export;
- include numbering in preview, issue reporting, semantic readback, and future page-tree title input;
- Cloud live proof in `mayflower`/`DOCSY`; DC Storage/REST contract proof.

Out of scope:

- installing or depending on a Marketplace numbered-headings macro;
- arbitrary raw ADF/Storage macro configuration;
- changing Confluence's editor numbering behavior;
- visual parity for custom Word fonts/indents/tab stops;
- page-tree creation itself — owned by Plan 009.

---

## 3. Baseline and dependency gate

The completed MVP must provide `ImportDocument`, heading nodes, list normalization, target encoders, `DocxImportPlanV1`, semantic readback, preview/report infrastructure, and the comment/export provenance seam described in `specs/import-docx-mvp/PLAN.md`.

Before implementation:

- [ ] Run `git diff --stat 18f6f1e..HEAD -- packages/import-docx packages/confluence packages/docx apps/cli` and reconcile actual baseline paths/types with this plan.
- [ ] Confirm `specs/import-docx-mvp/EVIDENCE.md` marks the MVP complete.
- [ ] Capture the exact parser output for numbered-heading fixtures produced by Word, LibreOffice, and Google Docs export.
- [ ] If the baseline parser irreversibly materializes numbering into text without exposing `numId`/level relations, STOP and revise the adapter plan; do not guess from a leading-number regex.

---

## 4. Architecture and contracts

Add a neutral model; raw parser types remain behind the adapter:

```ts
export type HeadingNumberFormat =
  | "decimal"
  | "lower-letter"
  | "upper-letter"
  | "lower-roman"
  | "upper-roman"
  | "bullet"
  | "ordinal"
  | "cardinal-text"
  | "unknown";

export interface HeadingNumbering {
  sourceNumId: string;
  sourceAbstractNumId?: string;
  level: number;
  format: HeadingNumberFormat;
  levelText: string;
  start: number;
  restartAfterLevel?: number;
  resolvedCounters: number[];
  resolvedLabel: string;
  separatorAfter: string;
  evidence: "ooxml" | "parser-plus-ooxml";
}

export type HeadingNumberingPolicy =
  | "preserve-as-text"
  | "target-numbering"
  | "report";
```

Rules:

1. Default policy is `preserve-as-text`: insert the computed label once into the visible heading while retaining structural provenance separately.
2. Literal source text is authoritative. If Word already materialized the label as characters, mark `materializedInSource: true` and never prepend it again.
3. `target-numbering` is capability-gated and must have a native, app-independent Cloud/DC mapping with readback proof. Until then it resolves to `preserve-as-text` with a named approximation; it must not emit an arbitrary macro.
4. `report` keeps heading text unmodified but produces `heading-numbering-reported`; strict mode blocks.
5. Counter resolution follows OOXML numbering definitions and document order, not CSS or English style names. Unknown formats preserve the cached/literal label when present or report a stable degradation.
6. `DocxImportPlanV1`, preview nodes, and semantic digest include the resolved label and policy. `--from-plan` becomes stale when either changes.
7. Store a bounded heading-numbering provenance manifest with source block ID, rendered prefix, numbering definition digest, and body digest. The exporter may reconstruct `w:numPr` only when provenance is valid and body text still matches; otherwise it exports literal visible text and reports the loss instead of stripping user content.
8. Plan 009 consumes a typed `HeadingTitleProjection` containing plain heading text, resolved prefix, and recommended page title. It must not reparse labels.

Proposed files:

```text
packages/import-docx/src/model.ts
packages/import-docx/src/normalize/heading-numbering.ts
packages/import-docx/src/ooxml/numbering.ts
packages/import-docx/src/options.ts
packages/import-docx/src/import-plan.ts
packages/import-docx/src/preview-model.ts
packages/import-docx/src/encode/adf.ts
packages/import-docx/src/encode/storage.ts
packages/import-docx/src/encode/semantic-digest.ts
packages/confluence/src/semantic-readback.ts
packages/docx/src/heading-numbering.ts
apps/cli/src/commands/import.ts
```

No new external dependency is expected. If one is proposed, exact-pin it and apply the MVP dependency/license/browser gates.

---

## 5. CLI and UX

Add:

```text
--heading-numbering <mode>  preserve-as-text|target-numbering|report
                            default preserve-as-text
```

Preview must show an outline with source heading text, resolved visible label, policy/outcome, and collisions caused by equal rendered headings. JSON/report output records counts by `native|approximated|reported` and stable issue codes including:

- `heading-numbering-unknown-format`
- `heading-numbering-definition-missing`
- `heading-numbering-already-materialized`
- `heading-numbering-target-fallback`
- `heading-numbering-roundtrip-provenance-stale`

---

## 6. Implementation tasks

### Task 0 — Build the numbering corpus and settle the contract

- [ ] Create redistributable fixtures for decimal, legal multilevel, letters, Roman numerals, restarts, skipped levels, custom separators, duplicate visible labels, literal prefixes, headings mixed with ordinary lists, and malformed/missing numbering definitions.
- [ ] Produce fixtures from Word, LibreOffice, and Google Docs export where possible and record producer/version/hash.
- [ ] Inspect `word/numbering.xml`, paragraph properties, styles, and parser output; document exact evidence used by the adapter.
- [ ] Decide which OOXML formats can be computed without locale-dependent Word behavior; unsupported ones get named fallback fixtures.

Acceptance:

- [ ] Corpus manifest maps every fixture to expected counters/labels and license/provenance.
- [ ] No expected label was inferred only from screenshot or filename.

### Task 1 — Normalize heading numbering

- [ ] Add the neutral types and supplemental OOXML parser.
- [ ] Resolve counters in one deterministic document-order pass with explicit restart state.
- [ ] Detect already materialized prefixes structurally/literally without broad regex deletion.
- [ ] Preserve unknown definitions as reportable source metadata.

Acceptance/tests:

- [ ] Golden tests assert exact label/counter output for every corpus case.
- [ ] Property tests prove deterministic output, no duplicate labels inserted into text, bounded state, and no crashes on malformed numbering graphs.
- [ ] Node 22, Node 24, Bun, and browser Worker produce the same numbering digest.

### Task 2 — Encode, preview, and read back

- [ ] Apply policy before target encoding so ADF and Storage consume identical resolved heading text.
- [ ] Add outline/issue/report fields and canonical serialization.
- [ ] Extend semantic readback to compare heading level plus visible label.
- [ ] Make numbering policy/provenance part of plan and saved-plan digests.

Acceptance/tests:

- [ ] ADF and Storage goldens contain one and only one visible prefix.
- [ ] Preview outline and actual target body share the same projection digest.
- [ ] A heading label missing or duplicated during readback is a core semantic mismatch and triggers rollback.

### Task 3 — Add guarded DOCX export provenance

- [ ] Persist the bounded provenance manifest through the existing import property/manifest seam.
- [ ] Teach the DOCX exporter to reconstruct numbering only on valid provenance/body evidence.
- [ ] On stale or missing evidence, export literal visible heading text and issue a warning; never delete a prefix heuristically.

Acceptance/tests:

- [ ] Import → simulated Confluence → DOCX export → reimport preserves heading text, level, and numbering label.
- [ ] Editing the Confluence heading invalidates structural reconstruction but preserves visible user text.
- [ ] Removing the provenance manifest yields a documented fidelity warning, not data loss.

### Task 4 — CLI, Cloud live proof, and DC contract proof

- [ ] Add flag parsing/help/examples and stable JSON fields.
- [ ] Import a numbered-heading feature fixture into `mayflower`/`DOCSY`, read back ADF, export DOCX, reimport, and clean all resources in `finally`.
- [ ] Run the same semantic path against the deterministic DC Storage contract server.

Acceptance/tests:

- [ ] Built CLI Cloud roundtrip preserves the expected numbering digest.
- [ ] DC contract output matches except for named target-specific approximation.
- [ ] `--strict --heading-numbering report` blocks before mutation.

---

## 7. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx packages/confluence packages/docx apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run docs:check
bun run docs:build
git diff --check
```

All must exit 0. The built CLI E2E uses profile `mayflower`, space `DOCSY`, records page IDs/digests, and proves cleanup.

---

## 8. Definition of Done

- [ ] Every heading-numbering fixture has an explicit outcome and stable issue behavior.
- [ ] Literal and generated numbers are never duplicated or silently removed.
- [ ] Preview, ADF, Storage, readback, report, and roundtrip use one numbering projection.
- [ ] Policy and resolved label are digest-bound and replay-safe.
- [ ] Plan 009 can consume `HeadingTitleProjection` without OOXML knowledge.
- [ ] Cloud is live-proven; DC is contract-tested and not mislabeled live-certified.
- [ ] `specs/002-import-docx/EVIDENCE.md` contains current proof.

## 9. STOP conditions

STOP and update this plan if the parser/OOXML evidence cannot distinguish generated numbering from literal text, locale-specific formats would require Word automation, target-native numbering requires a tenant app, or roundtrip reconstruction would require deleting visible user text heuristically.

## 10. DAG and parallel execution

After the MVP, Plans 002–008 may run in parallel. This plan blocks only Plan 009. Plan 010 later depends on 009, 003, and 005. No executor may import types from a sibling follow-on plan; shared contracts land in the baseline-owned packages.


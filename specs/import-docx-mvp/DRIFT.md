# Drift reconciliation — plan `63b02aca` → main `690a3974`

Date: 2026-08-15. This file executes the mandatory drift check from
`PLAN.md` §3.2. The plan was written against `63b02aca` (2026-07-20); `main`
has since advanced ~600 commits, mostly the `specs/export-expansion` series.
Where this file and the original plan text disagree, **this file wins**.

## 1. Findings

### 1.1 A hardened, browser-safe DOCX read path now exists in-repo

The plan assumed DOCX parsing required a new external dependency
(`@office-open/docx`, §2.3) and a from-scratch ZIP/XML preflight (Task 2).
Both assumptions are stale:

| Capability planned | Now exists at | Consequence |
|---|---|---|
| ZIP central-directory preflight, zip-bomb budgets, entry-name safety, active-content rejection (Task 2) | `packages/docx/src/scan.ts` (`unzipDocx`, `ArchiveBudget`, `assertArchiveBudget`, `assertNoActiveContent`) | Task 2 shrinks to: reuse `unzipDocx` with an import-owned `ArchiveBudget`; keep only import-specific adversarial fixtures. |
| Streaming XML parsing without DOM | `packages/docx-template-intake/src/streaming.ts` (vendored saxes runtime) | No new XML dependency needed. |
| OPC part/relationship model with typed diagnostics | `packages/docx-template-intake/src/opc.ts` (`DocxOpcFactsV1`) | Relationship traversal (images, numbering, styles, comments parts) follows this pattern. |
| Style/theme/section resolution incl. `w:numPr` basis | `packages/docx-template-intake/src/{style,theme,section}-resolution.ts` | Heading/style mapping starts from these facts instead of a parser library's opinion. |
| Privacy/diagnostic message registry | `packages/docx-template-intake/src/messages.ts` + `@atlcli/pdf-template-authoring` validators | Import issues reuse the registry pattern (§7.4) rather than inventing a new one. |

**Revised parser decision:** no external parser dependency. `@atlcli/import-docx`
implements its own `document.xml` body walk (paragraphs, runs, tables, lists,
hyperlinks, comment ranges) on top of `unzipDocx` + the vendored saxes runtime,
consuming intake facts for styles/numbering/sections. `@office-open/docx` and
Mammoth are dropped from the plan entirely; the Task 0 dependency-evidence
checklist items for them are void. §2.3 of `PLAN.md` is superseded by this
section.

Rationale: the external library's two selling points (structured JSON, comment
range markers) are outweighed by owning the hardened archive boundary, zero new
supply-chain surface, guaranteed browser portability under the existing
`check-browser-build` gate, and the fact that comment thread metadata was going
to require hand-parsing `commentsExtended.xml` anyway.

### 1.2 Package/quality gates assumed by Task 1 still hold

API reports/closure classification, publish-classification map, pack checks,
`development`-condition consumer smokes, `check-browser-build`, and the browser
conformance registry (`apps/browser-export-harness/src/conformance-registry.ts`)
all still exist and have gained a precedent user: `@atlcli/docx-template-intake`
is a browser-safe 0.x package wired through every one of these gates, including
its own conformance case. `@atlcli/import-docx` copies that wiring verbatim.

### 1.3 Spec numbering collided and was renamed

`main` now contains `specs/002-extension-workspace`, `specs/005-docx-image-module`,
etc. The nine follow-up plans moved from `specs/00N-import-docx/` to a dedicated
namespace; all cross-references in the plan files were rewritten:

| Old path | New path |
|---|---|
| `specs/002-import-docx/` | `specs/import-docx/002-heading-numbering/` |
| `specs/003-import-docx/` | `specs/import-docx/003-editability-budgets/` |
| `specs/004-import-docx/` | `specs/import-docx/004-attachment-source/` |
| `specs/005-import-docx/` | `specs/import-docx/005-destination-governance/` |
| `specs/006-import-docx/` | `specs/import-docx/006-inplace-update/` |
| `specs/007-import-docx/` | `specs/import-docx/007-import-recipes/` |
| `specs/008-import-docx/` | `specs/import-docx/008-equations/` |
| `specs/009-import-docx/` | `specs/import-docx/009-page-tree-split/` |
| `specs/010-import-docx/` | `specs/import-docx/010-batch-import/` |

`specs/import-docx-mvp/` keeps its path; it is referenced by every follow-up.

### 1.4 Seam updates versus §3.1

- `packages/confluence/src/client.ts` has grown substantially (hierarchy
  export fixes through #188); line references in §3.1 are stale. The
  *contracts* in §3.1 (storage/v1-only page writes, v2-only comments,
  `DeploymentType = "cloud" | "data-center"`) were re-verified on `main`
  and still hold.
- `packages/export/` exists as a new (currently untracked-on-main) workspace
  area; the §6.2 forbidden edge "import IR -> `ExportBlock`" extends to it.

## 2. Execution reconciliation

- **Task 0** is reduced to the three architecture-blocking gates, proven live
  first: (a) parser decision — resolved above, internal; (b) Cloud ADF page
  create via REST v2 + `atlas_doc_format` readback; (c) Cloud media identity
  (attachment upload → `fileId` → `mediaSingle` finalize → readback).
  The remaining Task 0 items (TOC macro, comment properties, DC fixtures,
  title-conflict probing) move to the task that first needs them; they do not
  block the architecture. Evidence lands in `EVIDENCE.md` as specified.
- **Delivery order** changes from "Task 1 complete before parser code" to a
  thin vertical slice: DOCX → headings/paragraphs/lists/tables/links → ADF →
  one reviewed Cloud page behind `wiki import` with preview and `--confirm`.
  Package-gate wiring (API report, pins checker, consumer smokes) attaches to
  the slice as it stabilizes, before any 0.x publish classification flips.
  All §5 invariants (no silent loss, review-first, rollback, no secrets in
  artifacts) bind the slice from the first commit.

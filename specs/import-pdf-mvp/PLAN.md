# PDF import MVP - semantic PDF to Confluence Cloud/Data Center

Status: **Planned**

Planned at: `b6826af5489ca08db6dea0e1ca384323c0d1c59f` (`feat(import-docx): semantic DOCX import - full Cloud feature set + DC contract track (#61)`), 2026-08-17

Spec ID: `import-pdf-mvp`

Priority: **P1**

Estimated effort: **XL / 9-13 implementation weeks for the digital-PDF MVP; OCR is a separately gated follow-up**

Risk: **HIGH** - untrusted PDF execution surfaces, lossy semantic reconstruction, reading-order ambiguity, raster/vector extraction, two Confluence body models, and multi-step publication

> **Executor instructions:** Read this plan completely before changing code. Execute the mandatory drift check and Task PDF-00 before extracting shared abstractions or committing an implementation shape. Follow tasks in dependency order. A checked box means the named proof passed and its exact command, version, fixture digest, metric, live page title, and cleanup result is recorded in `specs/import-pdf-mvp/EVIDENCE.md`; it is not an estimate. Stop on every STOP condition and revise this plan instead of improvising. Never commit customer documents, customer-derived text/images, tenant identifiers, or live artifacts.

---

## 1. Outcome

AtlCLI shall import a local digital PDF as native, editable Confluence content where the source provides enough evidence, and shall visibly preserve or report every region that cannot be reconstructed safely.

The public command extends the existing importer rather than creating a parallel CLI:

```bash
atlcli wiki import ./handbook.pdf \
  --format pdf \
  --profile mayflower \
  --space DOCSY \
  --parent 123456 \
  --unsupported report
```

Without `--confirm`, the command produces the same review-first boundary as DOCX import: an offline plan, semantic preview, attachment list, issue list, confidence summary, and digest of the exact target plan. `--confirm` publishes only after all hard blockers pass.

The MVP is successful only when all of the following are true:

1. Tagged and conservatively reconstructable born-digital PDFs are classified and analyzed from `Uint8Array` bytes without network access or active-content execution.
2. Text, reading order, headings, paragraphs, lists, tables, safe links, and figures are mapped to the existing target-neutral import semantics only when their evidence meets the feature's release threshold.
3. Every page and every recognized source region ends in exactly one recorded outcome: `native`, `approximated`, `attached`, `reported`, or `rejected`. Empty success and silent page loss are impossible.
4. The plan carries stable page/bounding-box provenance, extraction basis, confidence, and diagnostics independently of the Confluence body.
5. Cloud publishes ADF through the already live-proven v2 page/media path. Data Center publishes Storage through the already contract-tested v1 path and remains explicitly not project-live-certified.
6. Extracted raster figures and bounded rendered fallbacks are uploaded through the existing attachment transaction; vector compositions are not falsely described as editable vectors.
7. Preview and publication are digest-bound. The source digest, analyzer version/options, target capability digest, semantic plan digest, body digest, and asset digests are reported.
8. Title preflight, exact owned-resource rollback, readback, destination labels/restrictions/properties selected for the MVP, and cleanup retain the DOCX import safety semantics.
9. Existing DOCX commands, output digests, Cloud behavior, DC contract behavior, and update baselines do not regress when source-neutral seams are extracted.
10. The built CLI passes an automated neutral live E2E in `mayflower` / `DOCSY`, reads back text/table/media semantics, and deletes every owned resource in `finally` cleanup.
11. The digital-PDF release does not claim OCR support. Scanned or mixed pages are explicitly classified and blocked or preserved as reviewed image fallbacks according to policy. OCR ships only after the separate gate in Section 19.1 passes.

This plan does not promise pixel-identical conversion. PDF is a final-layout format; the product promise is evidence-backed semantic reconstruction with explicit fidelity fallbacks.

---

## 2. Product decisions

### 2.1 MVP source classes

The analyzer classifies the document and every page independently:

| Class | Definition | MVP behavior |
|---|---|---|
| `tagged-digital` | usable structure tree correlated with visible text/figures | primary native lane |
| `untagged-digital` | extractable text/operators but no usable structure tree | conservative geometry lane; review required |
| `scan` | page is predominantly raster with no trustworthy native text | no OCR claim; reviewed page-image fallback or blocker |
| `mixed` | native text and raster/hidden OCR layers coexist | native regions plus explicit fallback; duplicate-text gate |
| `encrypted` | password or permission gate prevents bounded analysis | rejected in MVP |
| `malformed` | parser, object graph, or resource limits fail | rejected before publication |

Document-level classification is a summary, never a substitute for page-level evidence. A 100-page PDF with one scan page is `mixed`; it must not silently drop that page.

### 2.2 MVP scope is digital first

The release supports tagged PDFs and a conservative subset of untagged born-digital PDFs. OCR is not folded into the first release merely to make scans appear supported. Task PDF-00 measures a local OCR option, but any engine/model/language packs require their own exact pins, licenses, runtime budgets, accuracy corpus, browser/package proof, and product disclosure.

If OCR feasibility later passes, it plugs into the same evidence model as an extraction source named `ocr`; it does not bypass confidence, duplicate suppression, review, or no-silent-loss accounting.

### 2.3 Reuse the merged DOCX importer, not its historical plan assumptions

Commit `b6826af5489ca08db6dea0e1ca384323c0d1c59f` and PR #61 are the implementation baseline. The current DOCX importer is real and includes preview/confirm, Cloud ADF, DC Storage, images, split trees, batch/checkpoint flows, in-place update baselines, governance, recipes, comments, and rollback.

The historical `specs/import-docx-mvp/PLAN.md` contains earlier create-only and browser aspirations that no longer describe the complete implementation. Current code, `DRIFT.md`, tests, docs, and `EVIDENCE.md` win.

PDF does not copy `@atlcli/import-docx` or alias a PDF model to Word types. Task PDF-00 first proves the PDF facts required by a shared semantic target. Only then may Task PDF-01 extract the minimal source-neutral model/encoder contract with DOCX behavior-lock tests.

### 2.4 No silent loss

Every source construct or region has one outcome:

```text
native       represented as an editable target feature with passing evidence
approximated represented editably with a named, reviewable semantic compromise
attached     preserved as an extracted asset or bounded rendered fallback
reported     omitted from the page but present in the report with a source locator
rejected     blocks publication because safe handling is impossible
```

`native` is a claim and requires a proof threshold. A nearby cluster of glyphs is not automatically a table, a large font is not automatically a heading, and an image XObject is not automatically the visible figure.

### 2.5 Original PDF retention is explicit

The byte-identical source PDF may be uploaded only with `--attach-source`. Default is off because a PDF may contain hidden text, metadata, attachments, signatures, or content not represented in the visible wiki page.

The original source attachment:

- has its own role and digest, separate from content figures and page fallbacks;
- is included in preview and the transaction plan;
- is never treated as an import-owned figure during update reconciliation;
- is uploaded only after any requested restriction has been applied and read back;
- is downloaded/read back for byte-digest verification when the target contract permits;
- is never required for semantic import success unless the user selected a policy that requires it.

### 2.6 Target editions and evidence labels

| Target | Body | MVP status | Required evidence |
|---|---|---|---|
| Confluence Cloud | ADF via REST v2 | implemented, live-certified | local/unit/package/browser gates plus built-CLI DOCSY E2E |
| Confluence Data Center | Storage XHTML via REST v1 | implemented, contract-tested, not project-live-certified | deterministic HTTP/context-path/auth/attachment/readback/rollback suite |
| Confluence Server | none | unsupported | no claim |

The profile's typed deployment decides the target once. A 404 or normalized response must not silently switch body formats.

### 2.7 Review and confirmation

| Invocation | Required behavior |
|---|---|
| TTY without `--confirm` | render local review; no remote write |
| `--dry-run` | render/report only; never prompt or write |
| `--confirm` | plan and publish without bypassing hard blockers |
| non-TTY without `--dry-run` or `--confirm` | fail with usage guidance; never hang |
| any hard blocker | stop before first write |

The current DOCX command previews by default rather than prompting. PDF retains that shipped behavior in the MVP. An interactive approval prompt is not introduced by this plan.

---

## 3. Current repository state and planning evidence

### 3.1 Current code anchors at `b6826af5`

| Fact | Current seam | Consequence for this plan |
|---|---|---|
| DOCX bytes become a parser/target-neutral block model | `packages/import-docx/src/model.ts`, `parse.ts` | behavior to preserve; not a PDF parser contract |
| Deterministic placeholder ADF and offline digest | `packages/import-docx/src/adf.ts`, `preview.ts` | extract only after PDF-00 proves the shared model |
| Independent DC Storage encoder | `packages/import-docx/src/storage.ts` | retain separate ADF/Storage implementations |
| Editability budgets | `packages/import-docx/src/assess.ts` | reuse for target payload; add source-analysis budgets separately |
| Baseline/diff/update safety | `packages/import-docx/src/baseline.ts`, `diff.ts`; `apps/cli/src/commands/wiki-import.ts` | preserve existing schema readers and divergence guard |
| Cloud ADF create/update/readback | `packages/confluence/src/client.ts` `createPageAdf`, `updatePageAdf`, `getPageAdf` | reuse public target client methods |
| Cloud/DC attachment routing | `packages/confluence/src/client.ts`, `attachment-delivery.ts` | reuse upload identity and exact-name conflict handling |
| Publication transaction is CLI-owned and DOCX-shaped | `apps/cli/src/commands/wiki-import.ts` `publishOnePage`, `finalizePageContent`, `publishOnePageDc`, `publishTree` | factor only proven identical steps; strengthen readback |
| Current ADF readback verifies mainly top-level block types | `verifyPageContent` in `wiki-import.ts` | insufficient for PDF fidelity; add canonical semantic verification |
| CLI dispatch and help are DOCX-only | `apps/cli/src/commands/wiki.ts`, `wiki-import.ts` | add format routing without breaking existing invocations |
| PDF.js is extension-only | `apps/extension/package.json` | importer owns an exact dependency/runtime contract |
| Existing PDF viewer renders only | `apps/extension/utils/pdf/viewer.ts` | do not import the viewer into the analyzer |

### 3.2 Actual DOCX coverage to compare

The merged implementation currently supports:

- Heading 1-6, paragraphs, bold/italic/code marks, safe links;
- nested ordered/bullet lists and header tables;
- PNG/JPEG/GIF/WebP/SVG attachments as media;
- blockquotes, code blocks, footnotes, content controls, cached field text;
- Word comments/replies/resolution and tracked-change policy;
- import from a Confluence attachment, page-tree split, batches/manifests/resume;
- in-place updates with divergence baseline and asset reconciliation;
- destination restrictions, staging, labels, page properties, recipes/overrides;
- live-certified Cloud publication and contract-tested DC single-page publication.

PDF parity is explicit in Section 5; it is never inferred from a shared CLI flag.

### 3.3 Planning probe from a representative private PDF

A transient, non-committed 13-page Word-produced PDF was inspected during planning. It was tagged, contained native text on every page, exposed 3 H1, 19 H2, 3 tables, 10 figures, and no document outline. PDF.js correlated structure roles and marked content, while public structure nodes exposed only a limited subset of authoring semantics; figure bounding boxes were present, but author-provided alternative text and table span attributes were not proven through that public surface.

This establishes three design facts only:

1. Structure tags can provide high-value evidence but cannot be the sole extraction contract.
2. Document outline/bookmarks cannot be required for heading recovery.
3. Figure/table semantics need correlation and fallback proof beyond raw object extraction.

The private PDF, its text, images, metadata, path, and customer names must never enter Git, fixtures, evidence, tests, snapshots, commit messages, PR text, or documentation.

### 3.4 PDF.js is a primitive provider, not an importer

The checked `pdfjs-dist` public API provides text items with transforms and direction, marked-content identifiers, page structure roles, outline/destinations, annotations, metadata/mark info, operator lists, and page rendering. It does not by itself decide paragraph boundaries, reading order, headings, tables, captions, repeated headers, or visible-figure composition.

Planning also proved that a raw PDF.js import is not automatically a Bun/Node contract: DOM/canvas ownership and exact workspace resolution must be explicit. Task PDF-00 must pass source, built CLI, packed Node, Bun, and browser-worker probes before the adapter is accepted.

### 3.5 Mandatory drift check

Before implementation:

```bash
git status --short --branch
git rev-parse HEAD
git diff --stat b6826af5489ca08db6dea0e1ca384323c0d1c59f..HEAD -- \
  packages/import-docx packages/confluence apps/cli/src/commands/wiki-import.ts \
  apps/extension/utils/pdf apps/browser-export-harness package.json bun.lock
```

Record the result in `specs/import-pdf-mvp/DRIFT.md`. STOP and reconcile if another change has introduced a PDF analyzer, a generic import IR/publisher, a new baseline schema, changed ADF media identity, changed attachment conflict semantics, or altered `wiki import` routing. Do not duplicate a merged seam.

---

## 4. Scope

### 4.1 In scope for the digital-PDF MVP

- local `.pdf` bytes and `--from-page <id> --attachment <name.pdf>` acquisition;
- exact extension/format routing and byte-signature validation;
- document/page classification from Section 2.1;
- tagged structure correlation and conservative untagged geometry analysis;
- Unicode text, bidi direction, paragraphs, headings, lists, simple tables, safe links;
- raster figures plus bounded rendered-region/page fallback;
- page labels, crop/media-box normalization, rotation, source coordinates;
- repeated header/footer/page-number detection with reviewable decisions;
- target-neutral semantic projection with PDF evidence sidecar;
- local terminal and JSON preview, deterministic plan/body/asset digests;
- create one page; optional Cloud page-tree split only from qualifying headings;
- Cloud ADF and DC Storage single-page publication;
- title preflight, destination governance already proven by the shared publisher;
- optional byte-identical source attachment, default off;
- `--unsupported report|fail`, strict hard blockers, readback, rollback, evidence;
- neutral fixtures, browser-worker analysis proof, built CLI live Cloud E2E, DC contract suite.

### 4.2 Deferred from this MVP

- OCR publication support for scans/mixed pages;
- password/encrypted PDF input;
- PDF annotations/highlights/notes as Confluence comments;
- in-place PDF reimport/update and PDF-specific baseline reconciliation;
- PDF directory/ZIP/manifest batch import and checkpoint/resume;
- PDF recipes/catalogs beyond a single explicit override file;
- arbitrary multi-column magazines, scientific papers, forms, portfolios, 3D, video, audio, RichMedia;
- editable vector/chart reconstruction, equations as native math, font-faithful typography;
- arbitrary nested/rotated/continued table reconstruction;
- browser-extension UI, Forge UI, remote staged preview;
- auto-creating one child page per PDF page;
- automatic remote OCR, AI captioning, or AI layout inference.

### 4.3 Non-goals

- converting PDF to Markdown as an intermediate truth;
- reverse-engineering a DOCX from the PDF before import;
- pixel-identical Confluence pages;
- executing JavaScript, actions, forms, embedded files, or external URLs;
- calling PDF.js private/core modules to avoid a public-API limitation;
- claiming a rendered crop is native/editable content;
- using the export-side `ExportBlock` decoder as import truth.

---

## 5. DOCX functionality comparison and PDF MVP decision

| Shipped DOCX capability | PDF MVP | Decision |
|---|---|---|
| review-first preview and `--confirm` | reuse | same command boundary and digest contract |
| local file and Confluence attachment source | reuse | route by validated bytes/format |
| headings/paragraphs/lists/tables/links | adapt | PDF evidence and confidence required |
| embedded images as attachments | adapt | visible composition, crop, masks, vectors, and dedupe differ |
| Cloud ADF / DC Storage | reuse | shared target projection after behavior-lock extraction |
| title preflight and rename policy | reuse | no format-specific behavior |
| restrictions/staging/labels/properties | reuse | target-side behavior only |
| split page tree | limited | Cloud only; only qualifying recovered headings; never per-page automatically |
| editability assessment | reuse and extend | target payload plus PDF analysis/fallback budgets |
| source attachment input | reuse | exact PDF attachment name/version provenance |
| retain original source as attachment | add | explicit PDF opt-in, digest/readback, hidden-content disclosure |
| update existing import | defer | needs PDF locator/baseline and fallback asset reconciliation |
| directory/ZIP/manifest batch | defer | first prove one PDF transaction and stable plan |
| recipes and style mappings | replace/defer | Word styles do not exist; PDF needs region/reading-order overrides |
| tracked revisions | not applicable | PDF has no equivalent authored revision model |
| Word comments/replies | defer PDF annotations | do not treat annotations as equivalent without an actor/anchor plan |
| bookmarks/cross-file DOCX links | adapt/defer | safe PDF outline/dest links may guide navigation; cross-file links deferred |
| footnotes from OOXML | heuristic/report | no native PDF footnote relation; do not claim native without evidence |
| DC single-page contract | reuse | no DC split/update/governance parity claim beyond current target support |

---

## 6. Non-negotiable invariants

1. **Bytes only.** Core analysis accepts `Uint8Array`; filesystem, stdin, and Confluence download belong to hosts.
2. **No network.** The analyzer and preview make zero outbound requests. All workers, CMaps, fonts, WASM, and optional models are local, pinned assets.
3. **No active content.** JavaScript, actions, XFA, forms, RichMedia, launch actions, and embedded files are never executed or opened.
4. **No silent page loss.** `pageOutcomes.length === sourcePageCount` is a hard invariant.
5. **No false native claim.** Below-threshold semantics become fallback/report/blocker, never optimistic native output.
6. **Source evidence is separate from target body.** ADF/Storage never becomes the provenance store.
7. **Preview equals publication plan.** Publication substitutes only proven remote media identities and destination URLs into reviewed placeholders.
8. **Mutations are owned and reversible.** Every created page/attachment is tracked by returned identity before the next operation.
9. **Restriction first.** When a restriction is requested, it is applied and read back before source/content bytes upload.
10. **Existing DOCX behavior is locked.** Shared refactors require identical DOCX semantic snapshots, plan/body digests, tests, and live transaction behavior.
11. **Cloud and DC encoders stay independent.** Neither is generated by converting the other's body.
12. **Customer data stays transient.** Only synthetic or redistributable neutral fixtures enter the repository.
13. **Public parser APIs only.** A missing public PDF.js capability triggers fallback, another audited adapter, or a STOP; never a private import.
14. **Deterministic decisions.** Same bytes, analyzer/version/options, override, and target capabilities produce the same canonical plan.
15. **Source attachment is not content.** It is off by default and never deleted as a superseded figure.

---

## 7. Target architecture

### 7.1 Flow

```text
CLI file/stdin or Confluence attachment
                  |
                  v
             Uint8Array + source descriptor
                  |
                  v
       @atlcli/import-pdf safe document adapter
       classify -> public PDF.js facts -> page evidence
                  |
        +---------+----------+
        |                    |
        v                    v
 tagged correlation   conservative geometry
        |                    |
        +---------+----------+
                  v
          PdfAnalysisV1 (loss ledger,
          page/bbox evidence, confidence,
          raw assets/render fallback plan)
                  |
                  v
       explicit projection after PDF-00
                  |
                  v
       @atlcli/import-core ImportDocumentV2
       + PdfEvidenceMapV1 sidecar
                  |
        +---------+----------+
        |                    |
        v                    v
    Cloud ADF           DC Storage
        |                    |
        +---------+----------+
                  v
        PreparedConfluenceImportV1
        preview/digest -> --confirm
                  |
                  v
       shared publication transaction
 preflight -> shell -> restriction -> source/assets
 -> final body -> metadata -> semantic readback -> report
                  |
                  v
          rollback exact owned IDs on failure
```

### 7.2 Package ownership

Proposed dependency shape after Task PDF-00:

```text
@atlcli/import-pdf ------> @atlcli/import-core <------ @atlcli/import-docx
                                   ^             ^
                                   |             |
                         @atlcli/import-confluence ----> @atlcli/confluence
                                   ^
                                   |
                              @atlcli/cli
                         (also owns source routing)
```

The exact split is conditional on PDF-00. The acceptable minimum is:

- `@atlcli/import-pdf`: source-specific safe parsing, facts, classification, semantics, evidence, overrides;
- `@atlcli/import-core`: only structures and pure target projections proven identical for DOCX and PDF;
- `@atlcli/import-confluence`: only target capability/planning/publication primitives proven identical across sources;
- CLI: acquisition, profile resolution, command UX, output, and orchestration.

If extracting `@atlcli/import-confluence` creates a broad unstable abstraction, keep the publisher in the CLI for the first vertical slice and extract smaller pure functions. Do not duplicate a second full transaction.

Forbidden edges:

- import packages to `apps/cli`, `apps/extension`, WXT/Chrome, filesystem, `process`, or live credentials;
- `@atlcli/confluence` to source import packages;
- PDF analyzer to `@atlcli/import-docx`, export decoders, or PDF viewer UI;
- Cloud encoder to DC encoder or reverse;
- browser entry to Node/Bun/native-canvas modules;
- target body fragments supplied by user overrides;
- external OCR/network services in the digital MVP.

### 7.3 Proposed files

```text
packages/import-pdf/
  package.json
  tsconfig.build.json
  README.md
  etc/import-pdf.api.md
  src/
    index.ts
    index.browser.ts
    contracts.ts
    adapter/pdfjs.ts
    classify.ts
    text.ts
    structure.ts
    reading-order.ts
    headings.ts
    lists.ts
    tables.ts
    figures.ts
    links.ts
    repeated-regions.ts
    fallbacks.ts
    normalize.ts
    issues.ts
    overrides.ts
    canonical.ts
    budgets.ts
  testdata/                 # generated/licensed neutral corpus only

packages/import-core/       # created only after PDF-00 proves the boundary
  src/model.ts
  src/adf.ts
  src/storage.ts
  src/preview.ts
  src/assess.ts
  src/canonical.ts

packages/import-confluence/ # conditional narrow extraction
  src/contracts.ts
  src/publish-cloud.ts
  src/publish-dc.ts
  src/readback.ts
  src/rollback.ts

apps/cli/src/commands/
  wiki-import.ts            # format router/common validation
  wiki-import-docx.ts       # existing source flow after extraction
  wiki-import-pdf.ts        # PDF planning/options

apps/browser-export-harness/src/
  pdf-import-case.ts

src/content/docs/confluence/
  import-pdf.md

specs/import-pdf-mvp/
  PLAN.md
  DRIFT.md                  # implementation-time drift result
  EVIDENCE.md               # implementation evidence only
```

This list is an ownership map, not permission for broad rewrites. Each task below names its allowed files.

---

## 8. Normative contracts

### 8.1 Source and classification

```ts
type PdfPageClass =
  | "tagged-digital"
  | "untagged-digital"
  | "scan"
  | "mixed"
  | "encrypted"
  | "malformed";

interface PdfSourceV1 {
  schema: "atlcli.pdf-source/1";
  sha256: string;
  byteLength: number;
  fileName?: string;
  origin:
    | { kind: "local" }
    | { kind: "stdin" }
    | { kind: "confluence-attachment"; pageId: string; attachmentId: string; version: number };
}

interface PdfPageSummaryV1 {
  pageIndex: number;
  pageLabel?: string;
  classification: PdfPageClass;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  outcomes: Record<ImportOutcome, number>;
  blockerCodes: string[];
}
```

No source descriptor includes absolute local paths in a serialized plan/report.

### 8.2 Stable source locators and evidence

```ts
interface PdfSourceLocatorV1 {
  pageIndex: number;
  pageLabel?: string;
  bbox?: { x: number; y: number; width: number; height: number; space: "crop-box-normalized" };
  structurePath?: string;
  markedContentIds?: string[];
  annotationId?: string;
  objectFingerprint?: string;
}

type PdfEvidenceBasis =
  | "structure-tree"
  | "marked-content"
  | "outline"
  | "text-geometry"
  | "font-evidence"
  | "annotation"
  | "image-object"
  | "operator-list"
  | "rendered-region"
  | "ocr";

interface PdfDecisionEvidenceV1 {
  sourceId: string;
  locator: PdfSourceLocatorV1;
  basis: PdfEvidenceBasis[];
  confidence: number; // finite 0..1; thresholds are versioned policy, not hidden magic
  decisionCode: string;
  outcome: ImportOutcome;
  analyzerRevision: string;
}
```

Coordinates are normalized after crop box and rotation. Raw PDF user-space values may be retained in debug-only in-memory facts but not used as the stable plan locator.

### 8.3 PDF analysis and target-neutral projection

```ts
interface PdfAnalysisV1 {
  schema: "atlcli.pdf-analysis/1";
  source: PdfSourceV1;
  analyzer: {
    pdfjsVersion: string;
    adapterRevision: string;
    policyRevision: string;
    optionsDigest: string;
  };
  documentClass: PdfPageClass;
  pages: PdfPageSummaryV1[];
  nodes: PdfSemanticNodeV1[];
  assets: PdfAssetV1[];
  evidence: PdfDecisionEvidenceV1[];
  issues: PdfImportIssueV1[];
  completeness: {
    sourcePages: number;
    accountedPages: number;
    unaccountedRegions: number;
  };
}
```

`PdfAnalysisV1` remains richer than the shared target IR. Projection produces editable blocks and assets plus a sidecar reference from every target block/asset to one or more `sourceId` values. ADF and Storage do not contain confidence scores.

### 8.4 Shared semantic extensions required by PDF

After PDF-00, Task PDF-01 may add these source-neutral capabilities to the current block model:

- stable `id` on blocks/assets;
- optional source-reference IDs, with the evidence stored outside the body;
- `rowspan` and `colspan` on table cells;
- figure placement separated from deduplicated asset bytes;
- optional caption relationship;
- explicit page/region fallback image block;
- issue outcomes expanded to all five values and severity expanded to `error`;
- page-break/page-boundary hint that encoders may ignore but split/preview can use.

Every change needs DOCX compatibility tests. Word-specific comments, style IDs, revision policy, bookmark links, and batch file links remain in `@atlcli/import-docx` extensions rather than polluting the shared core.

### 8.5 Canonicalization and digest binding

`PdfImportPlanV1` pins:

- source SHA-256 and byte length;
- PDF.js exact version and safe option set;
- adapter/heuristic/policy revisions;
- override digest;
- target deployment/capability/destination digest;
- semantic projection digest;
- placeholder-form ADF or Storage digest;
- every extracted/rendered/source attachment digest;
- issue/evidence digest and page-completeness counts.

Maps and object keys are sorted; floating coordinates are normalized to a documented precision; non-finite numbers are rejected; runtime-specific object IDs, absolute paths, timestamps, and locale formatting are excluded. Repeat analysis in Bun, Node, and the browser worker must produce the same semantic/evidence digest. Rendered-image bytes may use platform-specific evidence only if the renderer is not claimed portable; the MVP should prefer one frozen renderer path for publication assets.

### 8.6 Issue schema

Every issue has:

- stable code under `pdf-import/...`;
- severity `info | warning | error`;
- one of the five outcomes;
- source locator and source ID when applicable;
- sanitized context containing counts/enums/dimensions only, never document text;
- occurrence count after deterministic deduplication;
- a user action or explanation when actionable.

Examples include `page-scan-no-ocr`, `reading-order-ambiguous`, `table-grid-low-confidence`, `figure-rendered-fallback`, `unsafe-link-reported`, `embedded-file-ignored`, `javascript-action-rejected`, and `page-resource-budget-exceeded`.

---

## 9. Extraction and mapping rules

### 9.1 Text and reading order

1. Correlated structure-tree/marked-content order is primary when tag integrity passes.
2. The outline provides navigation/title evidence but never supplies missing body text. A PDF with no outline remains importable.
3. Untagged pages use deterministic geometry: line clustering, column segmentation, direction, spacing, and overlap suppression.
4. `dir` is preserved for RTL/vertical text decisions. Mixed direction, rotated text, and CJK require fixtures.
5. Unicode normalization, ligature expansion, soft-hyphen handling, and line-end dehyphenation are distinct versioned decisions with raw-text evidence.
6. Invisible/overlapping text layers are detected. Native text and OCR-like hidden text must not both publish.
7. Repeated headers, footers, and page numbers are detected across pages; removal requires corroboration and remains reviewable.
8. Ambiguous multi-column or interleaved reading order becomes a fallback/report/blocker, not guessed silently.

### 9.2 Headings, paragraphs, lists, and code

- `H1`-`H6` structure roles are native when correlated with visible text.
- Untagged heading inference uses typography, whitespace, numbering, and neighboring structure together; font size alone is insufficient.
- Levels must form a repairable hierarchy. A gap may be approximated with an issue; unstable hierarchy blocks `--split`.
- Lists use structure roles first, then repeated label/indent geometry. Labels remain literal when numbering reconstruction is uncertain.
- Monospace text may suggest code but cannot become a code block without line/group evidence; otherwise it remains paragraph text with an issue.
- Footnote-like regions remain paragraphs/reported relationships in the MVP; no native footnote relation is claimed.

### 9.3 Tables

Native table output requires all of:

- stable row and cell order;
- non-overlapping grid geometry;
- every visible cell text assigned once;
- header/cell role or a documented header inference;
- row/column span mapping when present;
- no unexplained content crossing cell boundaries.

Tagged tables use `Table/THead/TBody/TR/TH/TD` correlation first. Untagged geometry is permitted only for simple rectangular grids that pass the goldset threshold. Complex, rotated, nested, or continued tables use a rendered crop or conservative linearization with an explicit outcome. A fallback image is never called a native table.

### 9.4 Figures and graphics

- An image XObject is an extraction fact, not a visible figure. Tiles, masks, transforms, clipping, transparency, and overlays must be correlated.
- Original raster extraction is preferred only when one object maps cleanly to one visible figure.
- Vector paths/charts and composite figures render through a bounded page/region renderer to a PNG fallback.
- Figure bounding boxes come from validated tags or visible operator/render correlation; never from an unbounded full-page guess.
- Asset bytes deduplicate by content digest; placements retain independent source locators/captions/sizes.
- Captions are linked only by tag relationship or strong bounded layout evidence and remain editable text.
- Author-provided alt text and generated descriptions are distinct. The MVP never invents author alt text; missing alt text is reported and may be supplied by an explicit override.
- Active SVG is not passed through from untrusted input. Rasterize or sanitize through an independently proven path.

### 9.5 Links, annotations, actions, and attachments

- Only `https`, `http`, and `mailto` external targets may become links after canonical validation.
- Internal destinations may become same-page/page-tree links only when target resolution is deterministic.
- `javascript:`, `file:`, `data:`, launch, submit, remote-go-to, and unknown actions never become clickable output.
- PDF annotations are enumerated for safety and reporting. Importing notes/highlights as comments is deferred.
- Embedded files are never extracted or uploaded by default; their presence is reported.
- AcroForm/XFA values, JavaScript actions, multimedia, and open actions are not executed.

### 9.6 Scans, mixed pages, and fallbacks

The digital MVP offers `--scan-policy fail|page-image|report`, default `fail` for confirmed publication:

- `fail`: a scan/mixed page without trustworthy native coverage is a blocker;
- `page-image`: render the page under the fixed pixel budget, attach it, and insert a clearly reported image fallback;
- `report`: omit the page body but retain the issue; allowed only in preview unless `--unsupported report` and explicit `--accept-reported-pages` are both present.

There is no implicit OCR. The preview shows page number, class, outcome, fallback asset, and accessible-text limitation.

---

## 10. CLI and preview contract

### 10.1 Command shape

```text
atlcli wiki import <file.docx|file.pdf> [options]
atlcli wiki import --from-page <id> --attachment <name.docx|name.pdf> [options]
```

Routing rules:

- explicit `--format docx|pdf` wins only when it agrees with byte validation;
- otherwise a single local/attachment suffix selects the candidate format and magic bytes confirm it;
- stdin requires `--format`;
- a mismatch is rejected, never parsed by the requested adapter anyway;
- existing DOCX invocations and flags keep their behavior.

PDF-specific flags:

```text
--format pdf
--scan-policy fail|page-image|report       default fail
--accept-reported-pages                    explicit lossy-page acknowledgement
--reading-order auto|tags|geometry         default auto
--attach-source                            default off
--overrides <pdf-overrides.yaml|json>
--unsupported report|fail                  existing policy
--split <1..6>                             Cloud only; qualifying headings only
```

DOCX-only flags such as `--map-style`, `--revisions`, `--comments`, and DOCX recipes fail with a format-specific message for PDF rather than being ignored.

### 10.2 Preview content

Human and JSON preview include:

- source digest, page count/classification, analyzer versions/options;
- target space/parent/title/deployment/evidence label;
- block counts and recovered outline;
- per-page native/approximated/attached/reported/rejected counts;
- low-confidence/ambiguous regions with page/bbox locator;
- tables: native/fallback/linearized counts and span warnings;
- figures: original-raster/rendered-fallback counts and asset digests;
- source attachment choice and hidden-content disclosure;
- editability assessment for each planned page;
- all issues and hard blockers;
- semantic/evidence/body/asset digests;
- exact publication state plan and rollback scope.

Terminal output never prints document body text inside diagnostics. JSON may contain the planned page body only under an explicit existing full-output mode; standard JSON diagnostics retain structured locators and counts.

### 10.3 Overrides

The MVP override schema is `atlcli.pdf-import-overrides/1`. It may express only deterministic semantic decisions such as:

- reorder specific source IDs;
- map a source region to paragraph/heading/list/code;
- keep/drop a repeated region;
- force a table to fallback/linearize, never raw ADF;
- set figure crop/alt text/caption relation;
- choose page fallback for named pages;
- set a title from selected extracted text.

Overrides cannot inject ADF, Storage, HTML, scripts, URLs outside link policy, OCR text, arbitrary filesystem paths, or remote assets. Unknown/stale IDs and overlapping contradictory decisions fail before publication. YAML parsing follows the hardened DOCX recipe precedent: exact pin, duplicate-key/prototype/alias/tag rejection, bounded bytes/depth/items.

### 10.4 Page-tree split

`--split` is off by default. It is available only on Cloud and only when each splitting heading has qualifying evidence and produces unique, non-empty sections. The existing two-phase shell creation/link finalization and child-first rollback semantics are reused. A page boundary is not a heading; one child per PDF page is explicitly not implemented.

---

## 11. Publication, readback, and recovery

### 11.1 Prepared plan

No host publishes a raw `PdfAnalysisV1`. It publishes a validated `PreparedConfluenceImportV1` containing:

- immutable target identity/capability digest;
- final title/page-tree plan after conflict preflight;
- ADF or Storage bodies with asset placeholders;
- content-asset upload plan;
- optional source-attachment upload plan;
- restriction and metadata plan;
- semantic readback expectation;
- rollback ownership list initially empty;
- all source/evidence/body/asset digests.

Any change to source bytes, options, overrides, target deployment, space/parent, title resolution, capability set, or analyzer revision invalidates the prepared plan and requires a new preview.

### 11.2 Cloud transaction

```text
planned
  -> target/title preflight
  -> shell created (record page id immediately)
  -> requested restriction applied + read back
  -> optional source PDF uploaded + digest verified
  -> content/fallback assets uploaded + media identities recorded
  -> final ADF generated by placeholder substitution only
  -> final body written
  -> labels/properties applied + read back
  -> semantic body/media readback verified
  -> report/baseline metadata sealed
  -> complete
```

On failure after the shell exists, rollback children before parents using only returned owned IDs. Report cleanup failures prominently and preserve enough sanitized identity for manual cleanup. Never search/delete by title as rollback authority.

### 11.3 Data Center transaction

The DC MVP reuses the current single-page v1 sequence:

```text
title preflight -> shell -> attachments -> Storage version 2
-> structural + semantic readback -> labels/readback -> complete
```

PDF `--split`, restrictions/staging, content properties, and any capability not already proven for the current DC publisher fail closed with the exact unsupported flag list. Contract-tested remains the product label.

### 11.4 Stronger semantic readback

The current DOCX Cloud check compares mainly top-level ADF node types. PDF release proof requires a source-neutral canonical readback summary covering:

- ordered block types and heading levels;
- normalized text digest per block and for the full page;
- list nesting and ordered/bullet shape;
- table row/cell/header/span shape plus cell text digests;
- media node count and authoritative attachment/file identities;
- page-tree parent/title/link relationships when split;
- expected labels/properties/restrictions when selected.

Cloud normalization that preserves semantics is canonicalized; missing or changed core semantics rolls back. DC uses a Storage parser/fingerprint strong enough to check the same supported subset rather than regex tag sequence alone. Strengthening the shared readback must include DOCX regressions and may not reject currently accepted harmless normalization.

### 11.5 Update baseline policy

PDF in-place update is deferred. Shared refactoring must still preserve `atlcli.docx-page-baseline/1` reads and all current DOCX update behavior. Do not silently rewrite existing page properties during the PDF MVP.

If a format-neutral successor schema is necessary for shared publication metadata, introduce `atlcli.import-page-baseline/2` with:

- source kind and schema;
- a read-only compatibility path for v1 DOCX baselines;
- all new writes in v2 only after a live DOCX update E2E;
- a documented one-way migration on the next verified DOCX update;
- no permanent dual-write.

Otherwise keep baseline changes out of this MVP.

---

## 12. Security and resource budgets

### 12.1 Safe PDF.js option contract

The importer owns one frozen adapter configuration:

- byte `data`, never URL/range transport;
- `isEvalSupported: false`;
- `enableXfa: false`;
- no remote CMap, standard-font, ICC, or WASM URLs;
- no external resource fetch;
- rendering only through the owned bounded canvas/worker adapter;
- worker/document/page destruction in `finally` and on cancellation;
- JavaScript/actions/attachments inspected as inert metadata only.

The existing extension viewer is a security precedent, not a reusable analyzer. Importer code must not pull Vite `?url&no-inline` viewer assets or extension globals into the CLI package.

### 12.2 Initial hard budgets

Task PDF-00 must validate or tighten these conservative release ceilings and record the reference hardware. Raising them requires new evidence.

| Budget | Initial ceiling | Failure behavior |
|---|---:|---|
| input bytes | 100 MiB | reject before parser |
| pages | 500 | reject before page loop |
| total analysis wall time, digital | 120 s | cancel/destroy/reject |
| per-page analysis time | 10 s | page rejected; whole publish blocked |
| concurrent pages | 2 | bounded scheduler |
| text items | 2,000,000 total / 100,000 page | reject page/document |
| operator entries | 5,000,000 total / 250,000 page | reject page/document |
| structure nodes | 2,000,000 total / 100,000 page | reject page/document |
| extracted assets | 5,000 total / 500 page | reject page/document |
| decoded pixels | 400 MP total / 80 MP asset | fallback/reject before allocation |
| rendered pixels | 200 MP total / 40 MP page or region | reject fallback |
| output asset bytes | 250 MiB total / 25 MiB asset | block publication |
| canonical plan JSON | 50 MiB | reject before serialization |
| issue/evidence entries | 250,000 | deterministic aggregation or reject |
| peak RSS, 100-page digital benchmark | 750 MiB | release gate fails |

Limits are enforced before expensive decode/render where metadata permits, during streaming/iteration where it does not, and again on accumulated totals. An override cannot disable a security budget.

### 12.3 Adversarial corpus

Fixtures cover:

- malformed xref/object streams, recursion/cycles, truncated streams;
- oversized dimensions, decompression bombs, repeated image masks/tiles;
- huge operator/text/structure counts and deeply nested tags;
- JavaScript/OpenAction/Launch/URI/GoToR/SubmitForm/RichMedia;
- embedded files/portfolios, AcroForm/XFA, optional content layers;
- encrypted/password PDFs;
- hostile link schemes and Unicode control characters;
- active SVG-like content and malformed image profiles;
- cancellation at document open, page facts, text, operator, render, and finalization.

Every case proves bounded exit, stable issue/error code, no network request, and cleanup of worker/page/document/canvas resources.

### 12.4 Dependency and supply-chain rules

- Every new direct dependency is exact-pinned; no caret, tilde, wildcard, `latest`, unpinned Git/URL, or CDN.
- Task PDF-00 records exact version, upstream tag/commit, license and transitives, provenance/integrity, install scripts/native binaries, unpacked/bundle size, vulnerabilities, maintenance, and supported runtimes.
- The importer may reuse the checked `pdfjs-dist` version only after it passes the import adapter gates. If it changes, centralize or pin deliberately and rerun extension viewer/output tests.
- Optional native canvas packages and platform binaries require macOS/Linux/Windows and Node/Bun pack evidence; a missing optional binary cannot produce an empty import.
- Browser assets are emitted locally and checksum/provenance tested. No runtime downloads.

---

## 13. Fixture, quality, and performance strategy

### 13.1 Neutral goldset

All committed fixtures are generated, authored for AtlCLI, or redistributable with recorded license/provenance. Required families:

1. Tagged PDFs from Word, LibreOffice, browser print, and one independent tagged generator.
2. Untagged single-column, two-column, sidebar, and mixed-font documents.
3. German/English text, umlauts, ligatures, soft hyphens, bidi/RTL, CJK, vertical/rotated text.
4. H1-H6 hierarchy, numbered headings, lists/nesting, code-like text, footnotes.
5. Tagged and untagged tables: header, spans, borderless, multi-page, nested/rotated negative cases.
6. Raster figures, repeated assets, masks/transparency, clipped tiles, vector charts, captions, alt/no-alt.
7. Safe/unsafe links, internal destinations, outline present/absent.
8. Repeated header/footer/page number, crop/media boxes, rotation.
9. Scan, mixed hidden OCR layer, blank page, image-only page.
10. Every adversarial class in Section 12.3.

Fixtures include authoring source where practical, a ground-truth manifest, expected source regions, expected outcome, and deterministic digest. Private customer documents are prohibited.

### 13.2 Quality metrics and release gates

| Metric | Tagged-digital release gate | Untagged-digital release gate |
|---|---:|---:|
| accounted pages | 100% | 100% |
| unreported loss | 0 | 0 |
| false `native` outcomes on negative fixtures | 0 | 0 |
| normalized character recall | >= 99.5% | >= 98.0% single-column; otherwise fallback |
| duplicate visible text | 0 | 0 |
| reading-order exact block pairs | >= 99.0% | >= 96.0% on qualified layouts |
| heading precision / recall | >= 0.99 / 0.99 | >= 0.95 / 0.95 |
| heading-level accuracy | >= 99% | >= 95% |
| list item/nesting F1 | >= 0.99 | >= 0.95 |
| native table cell-text F1 | >= 0.99 | >= 0.95 for qualifying simple grids |
| native table row/column span F1 | 1.00 | 1.00 or fallback |
| visible figure recall | >= 0.99 | >= 0.98 |
| duplicate figure placements/assets | 0 unintended | 0 unintended |
| unsafe link promoted | 0 | 0 |

No aggregate score can hide a page loss or a false-native critical feature. Each fixture family and critical feature passes separately.

### 13.3 Determinism and parity

- three repeated runs in each runtime produce equal semantic/evidence digests;
- Bun source CLI, built Bun CLI, packed Node consumer, and browser worker agree;
- Cloud ADF and DC Storage project the same supported semantic digest;
- current DOCX corpus produces unchanged semantic snapshots and preview digests after shared extraction;
- asset placeholder substitution changes only media identities and target URLs.

### 13.4 Performance gates

Task PDF-00 records cold/warm p50/p95 on named hardware. Before release:

- first progress event <= 500 ms for a local 25 MiB digital PDF;
- 100 pages / 25 MiB digital fixture p95 <= 30 s, peak RSS <= 750 MiB;
- cancellation observed <= 1 s and memory returns within the measured tolerance;
- page concurrency remains bounded and output order deterministic;
- adding preview/evidence does not duplicate full decoded page/asset buffers;
- renderer fallbacks have separate page/pixel/time counts in the report.

OCR time is excluded because OCR is not a digital-MVP capability.

### 13.5 Evidence ledger

Implementation creates `specs/import-pdf-mvp/EVIDENCE.md` containing:

- drift result and exact implementation SHA;
- dependency/runtime/provenance decisions;
- fixture manifests and digests without private data;
- metric tables and benchmark environment;
- security/no-network/cancellation results;
- DOCX behavior-lock results;
- source, built, packed, browser, Cloud, and DC commands/results;
- live page titles/IDs only in the local transient run log, with sanitized evidence in Git;
- exact ownership-checked cleanup results;
- every deviation from this plan and its approved rationale.

---

## 14. Implementation task DAG

```text
PDF-00 feasibility and corpus
  |
  +--> PDF-01 proven shared semantic core + DOCX lock
  |      |
  |      +--> PDF-02 safe PDF adapter/classifier
  |              |
  |              +--> PDF-03 tagged text/structure
  |              |      |
  |              |      +--> PDF-05 tables
  |              |      +--> PDF-06 figures/fallbacks
  |              |
  |              +--> PDF-04 untagged reading order
  |                     |
  |                     +--> PDF-05 / PDF-06
  |
  +--> PDF-07 preview/overrides/CLI vertical slice
           |
           +--> PDF-08 shared publisher/readback hardening
                    |
                    +--> PDF-09 split/governance/source attachment
                              |
                              +--> PDF-10 runtime/security/performance/docs
                                        |
                                        +--> PDF-11 Cloud live + DC contract evidence
```

Tasks remain unchecked until evidence exists.

### Task PDF-00 - Prove feasibility before hardening architecture

**Depends on:** nothing.

**Files:** `specs/import-pdf-mvp/DRIFT.md`, `EVIDENCE.md`, temporary neutral probes/fixtures only; no production code.

**Work:**

- [ ] Execute Section 3.5 drift check against `b6826af5`.
- [ ] Inventory actual DOCX source/target/publisher contracts and lock current fixture digests.
- [ ] Build neutral tagged/untagged/scan/mixed/table/figure probes.
- [ ] Prove public PDF.js correlation among structure IDs, text items, operator/image facts, annotations, destinations, and page rendering.
- [ ] Prove whether public APIs expose enough table spans, figure bounds, alternative text, and visible asset data; define fallback for each gap.
- [ ] Prove exact dependency/runtime shape in Bun source, built Bun, Node 20/22/24, and Chromium worker with local assets and zero network.
- [ ] Benchmark classification, text/order, table/figure facts, memory, cancellation, and render bounds.
- [ ] Run an OCR bake-off only as research; record GO/NO-GO against Section 19.1 without adding OCR to MVP scope.
- [ ] Freeze initial analyzer, policy, and budget revisions.

**Verify:**

```bash
bun run test packages/import-docx apps/cli/src/commands/wiki-import.test.ts
bun run typecheck
bun run check:browser
```

**Expected:** current DOCX baseline is green; all PDF gaps have measured public-API/fallback decisions; no production dependency or shared abstraction is committed.

**STOP if:** tags cannot correlate to text; a required lane needs PDF.js private modules/eval/network; Bun/Node/browser ownership cannot be made deterministic; or the digital goldset cannot meet the planned gates.

**Suggested commit:** `docs(import-pdf): record feasibility and drift evidence`

### Task PDF-01 - Extract only the proven source-neutral semantic core

**Depends on:** PDF-00.

**Files:** new `packages/import-core/**`; scoped moves from `packages/import-docx/src/{model,adf,storage,preview,assess,canonical}.ts`; package manifests/lock/API reports/tests.

**Work:**

- [ ] Define `ImportDocumentV2`, blocks, assets, outcomes, IDs, table spans, and target projection contracts proven by both sources.
- [ ] Move pure ADF/Storage/preview/editability/canonical functions; retain Word-specific extensions in `@atlcli/import-docx`.
- [ ] Update DOCX parser/split/baseline/publisher callers in one atomic cutover; no permanent re-export compatibility layer unless a packed external consumer is proven.
- [ ] Preserve current DOCX output snapshots/digests or document an unavoidable schema-versioned change with migration proof.
- [ ] Add dependency-boundary, API report/closure, source/dist/pack, Node/Bun/browser-entry gates.

**Verify:**

```bash
bun run test packages/import-core packages/import-docx apps/cli/src/commands/wiki-import.test.ts
bun run typecheck
bun run build
bun run check:browser
bun install --frozen-lockfile
```

**Expected:** all DOCX semantic snapshots and transactions remain equivalent; new core has no source-format, CLI, filesystem, browser-host, or live-client dependency.

**STOP if:** a neutral type requires PDF geometry/confidence inside ADF, or extraction would break current baseline/update/comment semantics. Narrow the boundary instead.

**Suggested commit:** `refactor(import): extract proven semantic core`

### Task PDF-02 - Implement safe PDF adapter and page classification

**Depends on:** PDF-00 and PDF-01 contracts.

**Files:** `packages/import-pdf/package.json`, build config, `src/{index,index.browser,contracts,budgets,classify,issues,canonical}.ts`, `src/adapter/pdfjs.ts`, safe/adversarial tests.

**Work:**

- [ ] Accept bytes only; validate signature, encryption, page count, safe options, deadlines, and cancellation.
- [ ] Expose only owned normalized facts; no PDF.js object leaks into public contracts.
- [ ] Collect page boxes/rotation/labels, mark info, outline, inert action/attachment presence, text/structure/operator summaries.
- [ ] Classify every page/document and enforce completeness accounting.
- [ ] Add deterministic progress events and cleanup in `finally`.

**Verify:**

```bash
bun run test packages/import-pdf
bun run typecheck
bun run check:browser
```

**Expected:** all source classes receive stable results/codes; adversarial inputs remain bounded; no network or active execution occurs.

**Suggested commit:** `feat(import-pdf): add safe PDF facts and classification`

### Task PDF-03 - Tagged semantic extraction

**Depends on:** PDF-02.

**Files:** `packages/import-pdf/src/{structure,text,headings,lists,links,normalize}.ts` and tagged goldens/tests.

**Work:**

- [ ] Correlate structure content IDs with marked text and normalized source locators.
- [ ] Implement text normalization, bidi/rotation, heading hierarchy, paragraphs, lists, and safe links.
- [ ] Detect tag corruption/incompleteness and demote to geometry/fallback rather than trusting `Marked=true`.
- [ ] Emit evidence/issue/outcome for every projected node and repeated region.

**Verify:**

```bash
bun run test packages/import-pdf --test-name-pattern tagged
bun run typecheck
```

**Expected:** tagged metrics in Section 13.2 pass per family; outline absence does not reduce correct heading extraction.

**Suggested commit:** `feat(import-pdf): extract tagged document semantics`

### Task PDF-04 - Conservative untagged reading order

**Depends on:** PDF-02; integrates with PDF-03 normalization.

**Files:** `reading-order.ts`, `repeated-regions.ts`, untagged/RTL/columns/rotation fixtures and tests.

**Work:**

- [ ] Implement deterministic lines/blocks/columns, overlap suppression, repeated-region detection, and heading/list evidence.
- [ ] Qualify only layouts that meet thresholds; ambiguous layouts use fallback/report/blocker.
- [ ] Make every heuristic revision explicit in the canonical plan.

**Verify:**

```bash
bun run test packages/import-pdf --test-name-pattern untagged
bun run typecheck
```

**Expected:** qualified untagged fixtures pass gates; negative layouts have zero false-native outcomes.

**Suggested commit:** `feat(import-pdf): add conservative geometry reading order`

### Task PDF-05 - Tables and spans

**Depends on:** PDF-03 and PDF-04.

**Files:** `tables.ts`, shared table-span encoders/tests, table corpus.

**Work:**

- [ ] Reconstruct tagged rows/cells/headers/spans only from correlated evidence.
- [ ] Support simple untagged rectangular grids under strict qualification.
- [ ] Implement linearized/rendered fallback policies for complex tables.
- [ ] Prove ADF/Storage spans and semantic readback; regression-test DOCX tables.

**Verify:**

```bash
bun run test packages/import-pdf packages/import-core packages/import-docx --test-name-pattern table
bun run typecheck
```

**Expected:** native cell/span metrics pass; every negative table becomes an explicit fallback with no duplicated/lost cell text.

**Suggested commit:** `feat(import-pdf): reconstruct qualified tables`

### Task PDF-06 - Figures, extraction, and bounded rendered fallback

**Depends on:** PDF-02 plus structure/geometry locators from PDF-03/PDF-04.

**Files:** `figures.ts`, `fallbacks.ts`, renderer adapter/assets, figure corpus/tests.

**Work:**

- [ ] Correlate figure tags/bounds/operator objects with visible output.
- [ ] Extract one-to-one rasters; render composite/vector/clipped regions under budgets.
- [ ] Dedupe bytes while preserving placements/captions; report missing author alt text.
- [ ] Prove deterministic asset MIME/name/digest, Cloud media and DC filename projection.
- [ ] Prove cancellation and canvas/resource cleanup.

**Verify:**

```bash
bun run test packages/import-pdf packages/import-core --test-name-pattern figure
bun run check:browser
bun run typecheck
```

**Expected:** figure recall/duplicate gates pass; composites are visually preserved as reported fallbacks, never false native vectors.

**Suggested commit:** `feat(import-pdf): preserve figures with bounded fallbacks`

### Task PDF-07 - Review, overrides, and CLI PDF vertical slice

**Depends on:** PDF-03 through PDF-06.

**Files:** PDF preview/overrides; `apps/cli/src/commands/{wiki-import,wiki-import-docx,wiki-import-pdf}.ts`; CLI tests/help.

**Work:**

- [ ] Add format routing/magic validation while preserving existing DOCX syntax.
- [ ] Implement PDF flags, standard JSON report, terminal preview, issue/confidence/page summaries, and digest binding.
- [ ] Implement hardened `atlcli.pdf-import-overrides/1`.
- [ ] Produce a single-page create plan with title resolution and target capability summary.
- [ ] Reject DOCX-only/PDF-only flags on the wrong source.

**Verify:**

```bash
bun run test packages/import-pdf apps/cli/src/commands/wiki-import.test.ts apps/cli/src/commands/wiki-import-pdf.test.ts
bun --conditions=development run --cwd apps/cli src/index.ts wiki import ./packages/import-pdf/testdata/feature-zoo.pdf --format pdf --space DOCSY
bun run typecheck
```

**Expected:** default run is offline/no-write preview; non-TTY and confirm rules pass; source/plan digests repeat; DOCX CLI snapshots remain unchanged.

**Suggested commit:** `feat(import-pdf): add review-first CLI planning`

### Task PDF-08 - Factor publication seam and strengthen readback

**Depends on:** PDF-07.

**Files:** conditional `packages/import-confluence/**`; scoped publisher extraction from `wiki-import.ts`; Confluence readback helpers/tests/API reports.

**Work:**

- [ ] Extract the smallest shared prepared-plan/publish/rollback contract proven by DOCX and PDF.
- [ ] Keep source-specific comments, updates, recipes, and batch logic out of the shared publisher.
- [ ] Add Section 11.4 semantic readback for Cloud and supported DC subset.
- [ ] Prove exact owned-ID rollback at every transaction failure point.
- [ ] Behavior-lock DOCX create/image/split/update/comment/DC flows.

**Verify:**

```bash
bun run test packages/import-confluence packages/import-docx packages/import-pdf packages/confluence apps/cli/src/commands/wiki-import.test.ts apps/cli/src/commands/wiki-import-dc.contract.test.ts
bun run typecheck
bun run build
```

**Expected:** both sources publish through one proven transaction seam; readback detects text/table/media loss; current DOCX flows remain green.

**STOP if:** a generic publisher needs source-specific policy branches or weakens DOCX update/comment rollback. Keep a narrower shared transaction kernel.

**Suggested commit:** `refactor(import): share verified Confluence publication`

### Task PDF-09 - Destination safety, source retention, and qualified split

**Depends on:** PDF-08.

**Files:** PDF/CLI planning, shared publisher, source attachment/split tests.

**Work:**

- [ ] Reuse title conflict preflight and supported governance/metadata options.
- [ ] Implement opt-in source PDF attachment after restriction proof with byte digest readback.
- [ ] Implement Cloud `--split 1..6` only for qualifying heading plans.
- [ ] Prove multi-page shell/link/finalize/child-first rollback.
- [ ] Keep DC unsupported combinations fail-closed and explicit.

**Verify:**

```bash
bun run test packages/import-pdf packages/import-confluence apps/cli/src/commands/wiki-import-pdf.test.ts
bun run typecheck
```

**Expected:** sensitive bytes never precede a requested restriction; source attachment is distinct from figures; split titles/body/assets are exact.

**Suggested commit:** `feat(import-pdf): add destination-safe source retention and split`

### Task PDF-10 - Packaging, browser, security, performance, and docs

**Depends on:** PDF-02 through PDF-09.

**Files:** package exports/reports; browser harness case/registry; scripts/workflows only as needed; `src/content/docs/confluence/import-pdf.md`, sidebar/help.

**Work:**

- [ ] Add source/dist/packed Node/Bun/browser-worker conformance using the exact shipped artifact.
- [ ] Run adversarial/no-network/cancellation/resource suites and performance gates.
- [ ] Verify exact dependency pins, local assets, API report/closure, pack/install matrix, license/provenance.
- [ ] Document supported source/feature matrices, confidence/fallback language, all options, security/privacy, Cloud/DC evidence labels, troubleshooting, and related topics.
- [ ] Add minimal and realistic examples without customer data.

**Verify:**

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
bun run check:browser
bun run check:browser-export-harness
bun run test:browser-export-harness
bun run docs:check
bun run docs:build
git diff --check
```

**Expected:** all gates pass from clean source and built artifacts; docs make no OCR, browser UI, or DC live-certification overclaim.

**Suggested commit:** `docs(import-pdf): complete security and operations guide`

### Task PDF-11 - Live Cloud and deterministic DC proof

**Depends on:** PDF-10; no release before this task.

**Files:** E2E/contract tests and sanitized `EVIDENCE.md`; no private live output in Git.

**Work:**

- [ ] Build the CLI and run neutral tagged, qualified untagged, table, figure/fallback, restricted/source-attachment, and split cases in `mayflower` / `DOCSY`.
- [ ] Independently read back ADF text/table/media/tree/metadata and attachment digests.
- [ ] Inject failures after shell, restriction, source upload, asset upload, body update, metadata, and readback; prove exact rollback.
- [ ] Delete every page/attachment in `finally`, verify 404/current-state absence, and search for zero test-title leftovers.
- [ ] Run the DC contract server for context path, PAT auth, v1 Storage, filename media, retries, errors, readback, labels, and rollback.
- [ ] Run the existing neutral DOCX built-CLI E2E after shared refactors.

**Verify:** use the checked-in E2E commands created by this task, plus:

```bash
bun run typecheck
bun run build
git diff --check
```

**Expected:** Cloud is live-certified with owned cleanup; DC is implemented/contract-tested/not project-live-certified; DOCX remains live-proven.

**Suggested commit:** `test(import-pdf): record Cloud and DC evidence`

---

## 15. Verification matrix

| Layer | Required proof |
|---|---|
| pure contracts | canonical schemas, locators, outcomes, confidence, digests |
| parser adapter | public API only, safe options, bytes-only, destroy/cancel |
| semantic goldens | per-family metrics, no page loss, no false native |
| security | adversarial inputs, no network/active content, hard budgets |
| shared core | DOCX behavior/digest locks, independent ADF/Storage |
| CLI | routing, flags, offline preview, non-TTY, blockers, JSON/help |
| publisher | exact state order, media resolution, semantic readback, rollback |
| packaging | source/dist/built/pack, Node LTS, Bun, browser worker |
| Cloud | built CLI DOCSY live create/readback/failure/cleanup |
| Data Center | deterministic v1/Storage/context-path/auth contract server |
| docs | links/build, coverage/options/troubleshooting/privacy/evidence labels |

The root test command is always `bun run test`, never bare `bun test`.

---

## 16. Git and delivery workflow

- Start implementation on `codex/import-pdf-mvp` from the then-current `main` after the drift check.
- Preserve unrelated worktree changes; never reset/clean them.
- Work in dependency order and keep implementation uncommitted until the relevant neutral live E2E exists, because repository policy requires E2E before each logical commit.
- Suggested commits are boundaries, not permission to commit a red task.
- Use Conventional Commits.
- Run the relevant built-CLI DOCSY E2E and verified cleanup before every logical commit, including plan/docs-only checkpoints, as required by repository policy. Once PDF publication exists, include its neutral case; until then, run the existing neutral DOCX E2E.
- Run `bun run typecheck` before any push.
- Do not push, open a PR, release, or run a release command unless explicitly requested.
- If release is later requested, dry-run first according to repository policy; release is outside this plan.

---

## 17. Definition of Done

- [ ] Drift reconciliation is complete against the implementation base.
- [ ] Digital tagged/qualified-untagged scope and scan/OCR non-support are exact in CLI/docs.
- [ ] Every page and recognized region has one outcome and source locator.
- [ ] Quality gates pass per family with zero unreported loss and zero false-native critical cases.
- [ ] Figures/tables use native output only under threshold; all fallbacks are visible and digest-bound.
- [ ] Source PDF attachment is opt-in, restriction-safe, byte-verified, and separate from content assets.
- [ ] Preview, body, evidence, source, options, target, and asset digests bind review to publication.
- [ ] Semantic readback proves text/list/table/media survival and rolls back on mismatch.
- [ ] Existing DOCX source/built/live behavior and baselines remain compatible.
- [ ] Source, built, packed Node/Bun, and browser-worker gates pass with zero network.
- [ ] Security budgets, cancellation, and cleanup pass the adversarial corpus.
- [ ] Cloud built-CLI E2E passes in DOCSY and every owned resource is deleted/verified.
- [ ] DC contract suite passes and all surfaces say not project-live-certified.
- [ ] Docs build and include minimal/advanced examples, coverage, limitations, privacy, troubleshooting, and related topics.
- [ ] `bun install --frozen-lockfile`, `bun run test`, `bun run typecheck`, `bun run build`, docs/browser gates, and `git diff --check` pass.

---

## 18. STOP conditions

Stop and revise this plan if:

- tagged structure cannot be deterministically correlated with marked text/visible regions;
- qualified untagged reading order misses its release gate or produces any false-native critical fixture;
- native table/figure false-positive or loss rates exceed Section 13.2;
- a required implementation needs PDF.js private/core imports, `eval`, remote assets, CDN models, or external fetch;
- PDF.js/runtime/canvas assets cannot be exact-pinned, licensed, packaged, and proven in built Bun/Node/browser outputs;
- cancellation cannot bound CPU/RSS or cannot reliably destroy worker/document/page/canvas resources;
- active content, embedded files, XFA/forms, or unsafe links would need execution/passthrough;
- encrypted input would require passwords in argv, logs, plans, evidence, or diagnostics;
- a page/region can disappear without an outcome/source locator;
- preview/publication digests cannot bind all semantic and asset substitutions;
- Cloud media identity or target-safe source attachment links/digests cannot be proven via public APIs;
- ADF/DC mappings require undocumented payloads or silent body-format fallback;
- semantic readback cannot prove core text/table/media survival;
- shared extraction changes current DOCX semantics, baselines, comments, updates, DC contracts, or live transactions without a compatible migration;
- rollback/cleanup ownership cannot be proven at every failure point;
- a customer PDF, tenant-derived content/IDs, or private artifact would need to enter Git/evidence to pass;
- any gate can pass only by raising/turning off a security budget without new evidence.

Do not replace a STOP with a warning code.

---

## 19. Deferred follow-ups and their entry gates

### 19.1 OCR/scanned PDF import

Create a separate plan only when Task PDF-00 identifies an engine/model set that:

- is local/offline, exact-pinned, licensed, auditable, and packageable;
- supports the declared languages with frozen model digests;
- reaches <= 2% CER on clean German/English scans and <= 8% on the qualified degraded set;
- reaches heading F1 >= 0.90 and produces zero duplicate native/OCR text;
- reports word/line boxes and confidence into `PdfEvidenceMapV1`;
- meets explicit time/RSS/cancellation budgets in Bun/Node and any claimed browser runtime;
- never sends document content to a remote service;
- keeps `--ocr off|auto|required` explicit and previewed.

Failure means scans remain page-image fallback/blocker; it does not weaken the digital MVP.

### 19.2 In-place PDF update

Requires a PDF-origin baseline schema, stable source locators across regenerated PDFs, semantic diff, fallback asset reconciliation, anchor/comment policy, and restore-on-failed-verification. There is no force override for target divergence.

### 19.3 Batch/manifests/resume

Generalize the current DOCX manifest/checkpoint only after one-PDF plan identity is stable. Define mixed-format manifests explicitly; never make a `.docx` manifest silently accept PDFs.

### 19.4 PDF annotations/comments

Requires annotation subtype/anchor/author/date/reply semantics, actor-versus-attribution policy, highlight-text correlation, update reconciliation, and Cloud/DC evidence. Unsupported annotations continue to be reported.

### 19.5 Advanced layout and graphics

Separate evidence tracks for complex multi-column reading order, continued/nested tables, equations, charts, editable vectors, forms, portfolios, and native accessibility remediation.

### 19.6 Browser extension and Forge

The neutral browser-worker case proves portability only. UI, file acquisition, session auth, target locking, durable jobs, CSP, upload, progress, accessibility, and rollback require host-specific plans and E2E.

---

## 20. Risks and mitigations

| Risk | Failure signal | Mitigation / gate |
|---|---|---|
| Tags exist but are wrong/incomplete | missing/reordered content | correlation integrity test; demote to geometry/fallback |
| Geometry invents semantics | false heading/table/order | per-feature thresholds; negative fixtures; zero false-native gate |
| Hidden OCR duplicates native text | repeated paragraphs | overlap/text-layer suppression; zero duplicate gate |
| Image object differs from visible figure | tiles/masks/crops missing | visible correlation; bounded rendered fallback |
| Vector fallback is blurry/huge | unreadable or oversized page | pixel/DPI/bbox budgets, preview dimensions, asset cap |
| Public PDF.js surface lacks semantic metadata | spans/alt unavailable | report/manual override/fallback; alternate audited adapter or STOP |
| PDF.js caret/runtime drifts | different API/output/binary | exact importer pin, frozen lock, packed runtime parity |
| Native canvas missing on one platform | CLI crash or empty images | optional-binary matrix, explicit capability failure, no empty success |
| Preview differs from published media | user approves different result | placeholders + asset digests + semantic readback |
| Source PDF exposes hidden data | unexpected attachment disclosure | default off, review disclosure, restriction-first, byte digest |
| Shared refactor breaks DOCX | changed digests/comments/updates | behavior locks and neutral DOCX live E2E before commit |
| Cloud normalizes ADF | false failure or lost semantics | canonical semantic readback, not raw JSON equality |
| DC gets Cloud calls | 404/405/context-path error | typed deployment dispatch and deterministic contract server |
| Partial import remains | orphan shell/assets | returned-ID ownership, state machine, injected failure tests |
| Private data enters fixtures/evidence | confidentiality breach | neutral corpus only, staged-diff scan, explicit STOP |

---

## 21. Recommended defaults and unresolved questions

Decisions fixed by this plan:

1. Command: extend `atlcli wiki import`; do not add `wiki import pdf` as a separate product.
2. First release: tagged plus qualified born-digital untagged PDFs; no OCR claim.
3. Scan policy: confirmed publication defaults to `fail`; page-image fallback is explicit.
4. Original PDF attachment: opt-in and off by default.
5. Cloud: ADF/live-certified. DC: Storage/contract-tested/not project-live-certified.
6. First release: new-page import with optional qualifying Cloud split; update and batch are deferred.
7. PDF annotations are reported, not imported as comments.
8. Only source-neutral contracts proven by both importers are extracted; PDF evidence remains source-specific.

Evidence questions owned by PDF-00, not choices to guess:

1. Which exact PDF.js version/entry/worker/canvas combination passes all claimed runtimes?
2. Can public APIs expose or reliably correlate table spans, author alt text, and visible raster bytes for the required fixtures?
3. Which rendered-region implementation is deterministic and packageable across the claimed hosts?
4. Which untagged layout families qualify for native output under the fixed metrics?
5. Does any local OCR engine meet the separate entry gate without unacceptable license, model, runtime, or bundle cost?

If an answer changes scope or dependencies, update this plan and evidence before implementation continues.

---

## 22. Authoritative references

- Merged DOCX reference implementation: <https://github.com/BjoernSchotte/atlcli/commit/b6826af5489ca08db6dea0e1ca384323c0d1c59f>
- DOCX implementation PR and functional overview: <https://github.com/BjoernSchotte/atlcli/pull/61>
- Current DOCX contracts and implementation evidence: `packages/import-docx/**`, `apps/cli/src/commands/wiki-import*.ts`, `src/content/docs/confluence/import-docx.md`, `specs/import-docx-mvp/{DRIFT,EVIDENCE}.md`
- Current Confluence clients/attachment contracts: `packages/confluence/src/client.ts`, `packages/confluence/src/attachment-delivery.ts`, `packages/confluence/src/page-body.ts`
- Current PDF.js viewer/security precedent: `apps/extension/utils/pdf/viewer.ts`, `apps/extension/utils/pdf/pdfjs-assets.ts`, `apps/extension/scripts/check-output-build.ts`
- Checked PDF.js public type surface: `node_modules/pdfjs-dist/types/src/display/api.d.ts` at the implementation baseline; reverify from the exact selected upstream release during PDF-00
- PDF.js project/API: <https://github.com/mozilla/pdf.js>, <https://mozilla.github.io/pdf.js/api/>
- Atlassian Cloud page REST v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/>
- Atlassian Document Format: <https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/>
- Confluence Data Center REST: <https://developer.atlassian.com/server/confluence/confluence-server-rest-api/>

---

## 23. Maintenance notes

- Any PDF.js, canvas, renderer, OCR, model, or language-pack upgrade is an evidence change: update exact pins, provenance, fixtures, semantic digests, security corpus, runtime/pack matrix, and Cloud/DC proof as applicable.
- Heuristic thresholds/revisions are versioned product behavior. Do not tune them from a private document or silently change them in a dependency bump.
- Add every newly supported PDF producer/layout family to the goldset before changing documentation from fallback/report to native.
- Track fallback rate, page-loss blockers, analysis time/RSS, render pixels/bytes, and issue codes in sanitized local/live receipts; never persist document content.
- Keep the digital MVP honest if OCR remains unavailable. Page-image preservation is fidelity fallback, not semantic import.

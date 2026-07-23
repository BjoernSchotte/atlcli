# ADF-primary export source migration plan

Status: active implementation baseline

Plan date: 2026-07-22

Local implementation baseline: `75b7379` (`main` at implementation-branch start)

Gap baseline: [`GAP-ANALYSIS.md`](./GAP-ANALYSIS.md)

Parallel work reviewed: isomorphic export-jobs and CLI runtime contract snapshot on 2026-07-22; PR numbers are intentionally not pinned because the stack is still moving

## 1. Outcome

Make Confluence Cloud exports consume `atlas_doc_format` as their primary page-body representation while retaining Storage XHTML as an explicit compatibility sidecar and fallback.

The migration ends at the existing neutral export boundary:

```text
Confluence Cloud page
        |
        |-- atlas_doc_format ------------------------ primary
        |-- body.storage ---------------------------- compatibility sidecar
        v
ExportPageSource
        v
validateAdfDocument() / storageToBlocks()
        v
pageBodyToBlocks()
        v
ExportBlock[] + ExportNote[]
        |
        |-- mention, macro, link, and asset resolution
        |-- tree composition
        v
existing DOCX and PDF engines
```

This is an additive source migration, not a rewrite of the DOCX/OOXML or Typst/PDF engines. The initial production slice must:

- read ADF through the official Confluence Cloud v2 page API;
- validate and resource-bound untrusted ADF before walking it;
- decode every currently representable semantic into the existing neutral model;
- preserve visible child content and emit bounded diagnostics for unsupported nodes, marks, and attributes;
- keep Storage available for Data Center, legacy content, definitions, Page Properties, includes, and macro/export-view compatibility;
- use the same source adapter in CLI and browser/background hosts;
- make every representation fallback visible in the export report;
- avoid putting page bodies into logs, durable job requests, events, or progress messages.

## 2. Source and compatibility baseline

The plan is grounded in these contracts:

- Confluence REST v2 exposes `GET /api/v2/pages/{id}?body-format=atlas_doc_format`; `body.atlas_doc_format.value` is a JSON string.
- The pinned stable-schema baseline in the gap analysis is
  `@atlaskit/adf-schema@56.1.15`, containing 43 semantic nodes and 17 marks;
  the same verified package's exact `multiBodiedExtension` and
  `extensionFrame` definitions are pinned separately from `stage-0.json`.
- `packages/confluence/src/export-blocks.ts` owns the shared `ExportBlock`, `InlineNode`, `ExportNote`, and Storage walker contracts.
- DOCX and PDF already consume `ExportBlock[]`. They must not learn how to fetch or parse ADF.
- `ConfluencePageDetails.storage` is a public cross-cutting contract used outside export. It remains source-compatible in this wave.
- Data Center remains Storage-primary. ADF is a Cloud source adapter, not a universal replacement.
- A normal ADF page read does not contain computed third-party macro output or embedded asset bytes. Existing macro and asset resolution remains necessary.

Official references:

- [Confluence REST v2 Page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [ADF document structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [Canonical ADF JSON schema](https://go.atlassian.com/adf-json-schema)
- [ADF media node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/media/)
- [Confluence REST v2 Attachment API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/)
- [Confluence macro-body API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---macro-body/)
- [Forge macro `adfExport`](https://developer.atlassian.com/platform/forge/manifest-reference/modules/macro/)
- [Confluence Cloud changelog](https://developer.atlassian.com/cloud/confluence/changelog/)
- [Atlassian developer changelog](https://developer.atlassian.com/changelog/)

## 3. Scope

### In scope

- Cloud page ADF reads for page, tree, and space export scopes.
- An isomorphic, bounded ADF parser/validator and `adfToBlocks()` adapter.
- A representation-neutral `pageBodyToBlocks()` dispatcher.
- Paired ADF/Storage fixtures and a schema-derived coverage manifest.
- Native or semantically equivalent decoding for features already expressible by `ExportBlock` and `InlineNode`.
- Visible, typed degradation for the remaining schema surface.
- Source-version consistency between discovery, metadata, ADF, and Storage sidecar reads.
- CLI TypeScript DOCX and Typst/PDF source wiring.
- Representation-neutral tree fetching and include-page decoding.
- A background-job integration seam compatible with the parallel PDF job-executor and later production host-routing slices.
- Browser, package, API-report, differential, and live Confluence conformance gates.

### Out of scope for this first migration

- Removing `storageToBlocks()` or `ConfluencePageDetails.storage`.
- Converting sync, import, Markdown preview, or Storage-to-Markdown flows to ADF.
- The retired Python/docxtpl DOCX engine. It is not a product export path and is
  not an implementation target or acceptance gate for this migration.
- Native visual implementation of every missing ADF feature from the gap matrix.
- Reproducing interactive Confluence behavior in a static file.
- Changing the durable export-job request v1 schema to carry a body representation or page content.
- Storing raw full-tree ADF in IndexedDB job rows or request/event payloads.
- Treating raw editor shorthand such as `:name:` or backticks as syntax during export.

## 4. Architectural decisions

### 4.1 Add an export-specific page read

Do not repurpose `getPage()` or `getPageDetails()`. Introduce an additive export contract:

```ts
export type PageBody =
  | { representation: "atlas_doc_format"; value: string }
  | { representation: "storage"; value: string };

export type ExportSourceFallbackReason =
  | "data-center"
  | "adf-representation-unavailable";

export interface ExportPageSource {
  primary: PageBody;
  storageSidecar?: string;
  sourceVersion?: number;
  fallbackReason?: ExportSourceFallbackReason;
}

export interface ConfluenceExportPageDetails extends ConfluencePageDetails {
  exportSource: ExportPageSource;
}
```

Initial correctness-first behavior:

- Cloud: fetch existing v1 page details/Storage and v2 ADF concurrently; ADF is `primary`, Storage is `storageSidecar`.
- Data Center: do not probe the Cloud v2 ADF path; Storage is `primary` with reason `data-center`.
- Require the same page version across reads. A mismatch is a page-version race, never a merge of two versions.
- After parity is established, optimize Storage to an on-demand sidecar for pages that require definitions or legacy fallback. That optimization is not allowed to change the public source contract.

The initial dual read is intentionally explicit: it preserves existing template, Page Properties, include/excerpt, and macro behavior while the ADF path becomes measurable. Tree benchmarks and request counts gate the default rollout.

### 4.2 Separate runtime safety from schema coverage

Runtime validation protects availability and gives the decoder trustworthy shapes. Schema conformance proves coverage against the pinned Atlassian contract. They are related but separate:

- Runtime uses a small isomorphic structural validator with an iterative walk and explicit resource budgets. It must not use runtime code generation, `eval`, `new Function`, Node built-ins, or a remote schema fetch.
- Tests use a pinned schema snapshot and schema-derived node/mark manifest. Normal PR/release CI is offline and fails if the pinned schema set, coverage manifest, fixtures, or generated metadata diverge.
- A separate weekly online watchguard checks whether Atlassian's mutable canonical reference, published package metadata, human node/mark index, or Confluence REST contract has changed upstream. This scheduled workflow never supplies a build input and never updates the pin automatically.
- Known nodes and marks are shape-validated before decoding.
- Unknown node or mark names are schema/product drift, not malformed JSON. Their visible content is preserved where possible and a typed note is emitted.
- Invalid root/version/shape and budget exhaustion throw a typed `AdfParseError`; they do not silently invoke the Storage walker.

The canonical `go.atlassian.com/adf-json-schema` URL is a mutable discovery reference, not a reproducible dependency. Store the reviewed versioned URL, package version, raw SHA-256, canonicalized JSON SHA-256, package integrity value, node/mark inventories, and per-definition semantic hashes in a committed baseline. A change in only one upstream channel is reported as a propagation mismatch and rechecked; it is never silently accepted as the new baseline.

Suggested contracts:

```ts
export interface AdfParseBudget {
  maxInputBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxTextLength: number;
  maxAttributes: number;
  maxDiagnostics: number;
}

export type AdfParseErrorKind =
  | "input-too-large"
  | "invalid-json"
  | "invalid-root"
  | "unsupported-version"
  | "too-many-nodes"
  | "too-deep"
  | "text-too-long"
  | "too-many-attributes"
  | "invalid-node";

export class AdfParseError extends Error {
  readonly kind: AdfParseErrorKind;
  readonly path?: string;
}
```

Default limits must be derived from accepted Confluence pages and the synthetic stress corpus. Do not copy Storage node-density numbers without measuring the JSON representation.

### 4.3 One decoder result contract

Keep the current public name for compatibility and add a neutral name:

```ts
export interface BlocksResult {
  blocks: ExportBlock[];
  notes: ExportNote[];
  representation?: "atlas_doc_format" | "storage";
  degraded?: boolean;
}

export type StorageToBlocksResult = BlocksResult;
```

`representation` and `degraded` are upstream composition metadata. They must not alter renderer behavior or be serialized into job requests.

The dispatcher owns representation choice only:

```ts
export function pageBodyToBlocks(
  source: ExportPageSource,
  options?: PageBodyToBlocksOptions,
): BlocksResult;
```

It must never catch `AdfParseError` and retry the whole page through Storage. Capability fallback is decided when constructing `ExportPageSource`, not after decoder failure.

### 4.4 Preserve unsupported semantics visibly

The first wave cannot render all 43 nodes and 17 marks natively. It must still classify all of them.

For unsupported structures, choose one of these explicit outcomes per coverage-manifest row:

1. map to an existing typed `ExportBlock`/`InlineNode` with documented approximation;
2. preserve visible children/text and emit a degradation note;
3. add a neutral unsupported block/inline variant with bounded, sanitized metadata and deterministic DOCX/PDF fallback;
4. emit a visible placeholder when no meaningful child/text fallback exists.

No raw attributes may flow into OOXML or Typst. If generic unsupported variants are added, they contain only:

- source node/mark name;
- bounded JSON-safe attributes selected by an allowlist;
- recursively decoded child content;
- source block path/page provenance;
- deterministic visible fallback.

Adding public unsupported variants is a reviewed API change. It requires exhaustive-switch, package API-report, closure, DOCX, PDF, mention traversal, macro traversal, and conformance updates in the same slice.

### 4.5 Keep fallback policy narrow and observable

Storage becomes the primary representation only when:

- the deployment is Data Center; or
- a Cloud endpoint proves that `atlas_doc_format` is unavailable for that capability after a successful page identity/permission read.

Storage must not hide:

- malformed ADF;
- an unknown ADF node or mark;
- a decoder bug;
- authentication or authorization failure;
- rate limiting, 5xx, timeout, or cancellation;
- a page-version mismatch.

Per-subtree or per-macro compatibility is preferred to whole-page fallback. The report must distinguish source fallback from semantic degradation.

Proposed note codes, subject to the repository-wide note-code review:

- `adf-storage-fallback`
- `adf-node-degraded`
- `adf-mark-degraded`
- `adf-attribute-dropped`
- `adf-sidecar-correlation-failed`
- `adf-media-unresolved`

All codes must be registered in `EXPORT_NOTE_CODES`, emitted by at least one test, and included in the existing export-note registry gate. Emissions are capped and summarized after `maxDiagnostics`; an adversarial page must not create an unbounded report.

### 4.6 Do not log page bodies

`ConfluenceClient.requestV2()` currently logs successful response bodies. Before the first ADF read lands, give it the same `logBody: "meta-only"` behavior as the v1 request helper and use it for every ADF/body endpoint.

Tests must assert that distinctive fixture text is absent from:

- request/response logs;
- errors and retry messages;
- job requests and snapshots;
- progress details and events;
- checkpoint metadata and digests.

Digests, byte lengths, schema/version, node/mark counts, page ID, and representation are allowed metadata. Raw page text and raw ADF are not.

## 5. Initial decoder coverage

The coverage source of truth remains the complete matrices in `GAP-ANALYSIS.md`. This wave establishes direct ADF input for the following categories.

### 5.1 Map to existing neutral semantics

- Root/basic: `doc`, `paragraph`, `heading`, `text`, `hardBreak`, `rule`, `blockquote`, `codeBlock`.
- Lists/tasks: `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem` using the existing static checklist representation.
- Tables: `table`, `tableRow`, `tableHeader`, `tableCell` for attributes already represented by the current table model.
- Containers: `panel`; `expand`/`nestedExpand` as a recursive neutral
  disclosure retaining title, identity, body ownership, and nested context,
  with an explicitly open static target projection.
- Inline: `date`, `status`, and `placeholder` as typed semantic nodes;
  `emoji` and `mention` with deterministic visible fallbacks for unresolved
  external data.
- Cards: `inlineCard`, `blockCard`, and `embedCard` now use a typed Smart Card
  contract with complete pinned attributes, safe targets, deterministic static
  rendering, and reuse of the existing datasource live-resolution chain.
- Extensions: `extension`, `inlineExtension`, `bodiedExtension` projected into the existing macro-resolution contract when identity correlation is proven.
- Media: the complete pinned `media`, `mediaGroup`, and `mediaSingle` block
  contracts retain Media Services/local identity, attachment metadata,
  file/link/external variants, authored geometry/layout, grouping, captions,
  safe links, annotations, and borders. Correlated images enter the bounded
  asset pipeline; correlated non-images become named clickable static
  attachment cards; unresolved identities remain visible without guessing.
  DOCX projects wrap layouts as native anchored drawings. Because the selected
  Typst engine supports only top/bottom floats and no contour wrapping, PDF
  uses a source-ordered authored-width grid with the directly following
  paragraph, or the requested side alignment when no paragraph follows.
  `mediaInline` retains the same typed identity. Correlated image bytes render
  as a paragraph-local DOCX drawing run and a baseline-aligned Typst inline
  image, while file/link/unresolved variants retain the deterministic chip
  floor and shared diagnostics.
- Existing marks: `strong`, `em`, `underline`, `strike`, `code`, `subsup`,
  `textColor`, `backgroundColor`, `link`, and media `border`.

### 5.2 Explicitly classify, preserve, and defer native rendering

The remaining schema rows—including generic extension output, unsupported
wrappers, and externally resolved custom emoji—must retain
a coverage-manifest status and deterministic fallback.
Decisions, block tasks, layouts, native captions, block-media geometry and
grouping, media borders, fragment provenance, alignment, indentation, and the
schema-defined small paragraph font size, and annotation comment-resource
projection now have completed contracts recorded in the gap analysis.

The ADF adapter must never infer semantics from raw text. Literal `:warning:`, backticks, `[]`, `<>`, and slash-command text remain literal unless Confluence stored a typed ADF node or mark.

## 6. Correlation spike before production default

Use dedicated synthetic test pages in the configured test space to establish four live contracts:

1. exact v2 ADF response shape and page version;
2. ADF `localId`/extension identity to Storage `ac:macro-id` and macro-body lookup;
3. ADF Media Services ID/collection/local ID to Confluence attachment ID/filename/download URL;
4. ADF and Storage projections for modern editor, legacy-content, Page Properties, excerpt/include, and Forge/Connect macro cases.

Rules:

- Fixtures committed to the repository must be synthetic and sanitized.
- Record Confluence observation date, editor generation, ADF hash, Storage hash, and source feature—not credentials or page content from unrelated pages.
- Delete ordinary temporary live test pages/resources after E2E runs.
- One dedicated persistent feature-tree fixture may remain for repeatable CLI
  subtree DOCX/PDF conformance. Its profile, tenant, space, page IDs, URLs, and
  titles are runtime-only inputs: never commit them, copy them into this plan or
  the gap analysis, mention them in commit/PR text, or publish them as CI
  artifacts. Give the tree an unmistakable test-only title in Confluence and
  mutate it only through an explicit fixture-maintenance run.
- Never correlate by document position such as “the nth macro” or “the nth image”.
- If a stable identity mapping cannot be proven, keep that feature behind a visible fallback and do not enable its ADF-native resolver by default.

Exit criteria:

- ADF and metadata/Storage version equality is verified or a typed race is returned.
- Macro identity is either deterministic or explicitly unsupported.
- Media identity is either deterministic or represented by a new neutral source variant supported by both engines.
- No test uses a customer document as a fixture.

## 7. Implementation work packages

Progress bookkeeping is part of every work package, not a later documentation
cleanup. In the same commit that proves a slice, update the affected node/mark
matrix rows, the prioritized checklist, the phase checklist, and the
closed/missing-gate inventory in `GAP-ANALYSIS.md`. Mark `[x]` only when every
applicable definition-of-done gate has evidence; otherwise keep `[ ]`, label
the item **Open**, and state the exact residual gap. Use **Partial** only when a
named external contract or parallel work package actually blocks closure; it
is not an acceptable resting state for work that can be completed here.

### WP0 — Baseline and export-jobs workstream coordination

Files:

- `specs/export-gap-analysis-adf-notation/GAP-ANALYSIS.md`
- `specs/export-gap-analysis-adf-notation/PLAN.md`
- current export-jobs changed-file and contract baseline, resolved when implementation starts

Tasks:

- [x] Resolve the currently active export-jobs PR stack, but branch this work from `main` so the moving production-runtime branch cannot rewrite or block WP1–WP4; synchronize before CLI/background integration and before final API/closure or browser-harness snapshots.
- [x] Pin the exact ADF schema snapshot/hash used by fixtures and the coverage manifest.
- [x] Record the live-correlation results from section 6 without including unrelated page content.
- [x] Confirm WP1–WP4 start on a main-based branch in parallel with production CLI routing; WP5–WP9 must re-resolve and synchronize the then-current runtime contracts before touching their integration seams.

Exit:

- The source/API boundaries and current workstream ownership are agreed before public types are changed.

### WP1 — Body contracts and safe v2 reads

Production files:

- new `packages/confluence/src/page-body.ts`
- `packages/confluence/src/client.ts`
- `packages/confluence/src/index.browser.ts`
- generated `packages/confluence/etc/confluence.api.md`
- generated `packages/confluence/etc/confluence.closure.md`

Tasks:

- [x] Add `PageBody`, `ExportPageSource`, `ConfluenceExportPageDetails`, `BlocksResult`, and options types.
- [x] Keep `ConfluencePageDetails.storage` unchanged.
- [x] Add `logBody: "meta-only"` to `requestV2()` and use it for ADF reads.
- [x] Add `getPageAdf(id, {signal})` using `body-format=atlas_doc_format`.
- [x] Add `getExportPageDetails(id, {signal})` with parallel Cloud dual-read and explicit Data Center Storage-primary behavior.
- [x] Validate response representation/value/version without `any`-casting it into a trusted document.
- [x] Require version equality across ADF and v1 details/Storage.
- [x] Classify only proven capability absence as `adf-representation-unavailable`.
- [x] Thread cancellation into both reads and cancel the sibling operation after terminal failure.
- [x] Cache deployment capability by normalized site origin; never cache auth or page-level denial as a platform capability.

Tests:

- `packages/confluence/src/client.test.ts`
- new focused export-read tests if the client suite becomes too broad

Required cases:

- [x] correct Cloud v2 path and query;
- [x] ADF value preserved as an opaque string until validation;
- [x] wrong/missing response representation or value;
- [x] matching and mismatching versions;
- [x] AbortSignal and sibling cancellation;
- [x] 401/403/429/5xx/login-page behavior without fallback;
- [x] explicit Data Center path with zero v2 ADF calls;
- [x] capability cache isolation by origin;
- [x] logs contain metadata but not distinctive ADF text.

Exit:

- The client can produce an export-specific dual source without affecting existing client consumers or leaking body content.

Evidence recorded on 2026-07-22: focused ADF/Storage tests, existing client regressions, public API/closure guards, full typecheck, browser-isomorphism check, full build, and an anonymized read-only Cloud contract probe all passed. The live probe emitted only representation and structural booleans; it emitted no environment or content identifiers.

### WP2 — Runtime validator, schema coverage baseline, and drift watchguard

Production files:

- new `packages/confluence/src/adf-types.ts`
- new `packages/confluence/src/adf-validate.ts`
- new `packages/confluence/src/adf-coverage.ts`

Test/build files:

- new `packages/confluence/src/adf-validate.test.ts`
- new synthetic fixtures under `packages/confluence/test-fixtures/adf/`
- pinned schema snapshot plus `packages/confluence/test-fixtures/adf/upstream-baseline.json`
- new `scripts/adf-drift.ts` and `scripts/adf-drift.test.ts`
- new `.github/workflows/adf-drift-watch.yml`

Tasks:

- [x] Check UTF-8/input byte length before `JSON.parse`.
- [x] Validate `type: "doc"`, supported ADF document version, and root content.
- [x] Walk nodes/marks iteratively and enforce all `AdfParseBudget` dimensions.
- [x] Reject dangerous/non-plain attribute structures and prototype-polluting keys.
- [x] Validate known node/mark shapes needed by the decoder.
- [x] Preserve unknown type names as drift while rejecting malformed shapes.
- [x] Generate or verify a coverage row for every pinned-schema node and mark.
- [x] Distinguish `schema-only`, `observed-cloud`, and `legacy-observed` fixture provenance.
- [x] Benchmark realistic and adversarial documents before fixing default budgets.
- [x] Store the reviewed schema's versioned URL, package version, npm integrity, raw/canonical hashes, node/mark inventories, and per-definition hashes in `upstream-baseline.json`.
- [x] Make the ordinary PR/release check consume only committed snapshots and baselines; it must make zero network calls.
- [x] Implement `adf-drift.ts check-pinned` for the deterministic offline relation: snapshot -> hashes/inventory -> coverage manifest -> fixtures.
- [x] Implement `adf-drift.ts check-upstream` for the online watchguard without mutating tracked files.
- [x] Make candidate baseline/schema updates an explicit local `update-candidate` operation whose diff must be reviewed and committed by a developer.

Required tests:

- [x] minimal valid document;
- [x] invalid JSON/root/version/node/mark shapes;
- [x] max input, node, depth, text, attribute, and diagnostic budgets;
- [x] deeply nested document without call-stack overflow;
- [x] unknown node, mark, and attribute drift;
- [x] `__proto__`, `constructor`, cycles supplied as object input, and non-finite numbers;
- [x] all pinned 43 nodes and 17 marks classified exactly once;
- [x] schema update produces a failing coverage diff.
- [x] raw formatting-only schema changes are distinguished from canonical semantic changes;
- [x] modified definitions/constraints are detected even when node and mark counts stay unchanged;
- [x] redirect/package/CDN disagreement is reported as propagation mismatch;
- [x] the online checker cannot write a new baseline or tracked schema snapshot.

#### Weekly online watchguard

Add a dedicated `ADF Drift Watch` workflow with this topology:

```yaml
on:
  schedule:
    # Monday 05:23 UTC, off the hour and early in the working week.
    - cron: "23 5 * * 1"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: adf-drift-watch
  cancel-in-progress: true
```

The workflow is intentionally absent from `push`, `pull_request`, release-workflow `needs`, and required branch-protection checks. It may fail visibly without blocking a PR, tag, package publication, or release. Do not add job-level `continue-on-error`: a red scheduled run is the watchdog signal. A newly published version or persistent redirect-target change also fails the watch run even when its canonical semantic hash is unchanged, but the report classifies that separately from semantic drift. Network/CDN unavailability, confirmed semantic drift, integrity mismatch, and an unreadable official contract use distinct result classifications in the report.

The public, secret-free job must:

1. resolve the canonical Atlassian schema link with bounded redirects, HTTPS-only transport, an approved-host policy, response-size limits, and retries;
2. record every redirect and final versioned URL;
3. compare canonical-link target, package latest metadata, exact-version metadata, and package integrity;
4. download/verify the exact package artifact before extracting `dist/json-schema/v1/full.json`;
5. calculate raw and canonical JSON hashes;
6. compare node names, mark names, definition names, required fields, enums, allowed content/marks, attribute shapes, and per-definition hashes—not only total counts;
7. validate the committed fixture corpus against both the pinned and candidate schema;
8. semantically extract documented node/mark link slugs rather than hashing Atlassian's complete HTML/navigation shell;
9. verify from the official Confluence REST/OpenAPI surface that page reads still expose `body-format=atlas_doc_format` and the expected body representation;
10. emit `adf-drift-report.json` and `adf-drift-report.md`, write the Markdown summary to `$GITHUB_STEP_SUMMARY`, and upload both as retained workflow artifacts;
11. make no repository, dependency, baseline, issue, or fixture update by itself.

Classify findings at least as:

- `no-drift`;
- `new-upstream-version`;
- `node-added` / `node-removed`;
- `mark-added` / `mark-removed`;
- `definition-changed` / `constraint-tightened` / `constraint-relaxed`;
- `reference-index-drift`;
- `rest-contract-drift`;
- `integrity-mismatch`;
- `propagation-mismatch`;
- `watch-unavailable`.

For mutable upstream sources, retry and compare results within the same run before declaring drift. A version/redirect mismatch that converges is recorded as transient; a mismatch that persists becomes a visible failed watch run. The committed pin remains unchanged in every case.

Add an optional authenticated `observed-cloud` job, still weekly and read-only, using dedicated synthetic retained fixture pages. It inventories only structural signatures—node/mark names, attribute-key sets, extension/media shape categories, page version, and hashes—and never uploads raw ADF or page text. This catches product rollout drift that may precede or differ from the global schema. Missing credentials skip this job with an explicit summary; configured credentials that stop working produce `watch-unavailable`.

The retained fixture set is configured only through repository secrets: `ADF_WATCH_PAGE_IDS` contains a comma-separated, bounded list of page references, while the singular `ADF_WATCH_PAGE_ID` remains a backwards-compatible fallback. Neither references, tenant origin, credentials, raw ADF, nor page text may enter the JSON/Markdown report. The job aggregates signatures and sorted page versions across the set, validates every observed document against both the committed pin and the schema discovered during the same run, and reports only counts, booleans, structural names/categories, package version, and a canonical structural hash.

Alerting v1 is the failed scheduled Actions run plus its job summary/artifacts. A deduplicated GitHub issue may be added later behind an explicit repository decision; the schema monitor itself starts with `contents: read` only.

Exit:

- Untrusted ADF cannot reach recursive decoders without bounded, validated structure; pinned-schema inconsistency cannot pass normal CI; and new upstream or observed-Cloud drift produces a weekly actionable report without blocking delivery.

Evidence recorded on 2026-07-22: the offline pin check verified 43 nodes, 17 marks, 84 per-definition hashes, Draft-04 fixture expectations, coverage, and all three fixture provenance classes without network access. The complete repository suite passed with 4,724 tests, 13 intentional skips, and zero failures; full typecheck and the 20-entrypoint browser-isomorphism gate passed as well. A public read-only online run reported `no-drift` after resolving the canonical redirect, reconciling npm latest/exact metadata, verifying the SHA-512 package artifact, comparing package/CDN schema bytes, extracting reference slugs, and checking the Confluence page-read contract. The explicit candidate operation reproduced the pin in a temporary directory without touching tracked files. On Bun 1.3.14, the benchmark accepted 30,001 rich nodes in about 30 ms, 80,001 wide nodes in about 60 ms, and depth 128 in under 1 ms; depth 129 and an input one byte over 8 MiB failed at their intended budgets.

### WP3 — ADF-to-neutral decoder and diagnostics

Production files:

- new `packages/confluence/src/adf-to-blocks.ts`
- `packages/confluence/src/export-blocks.ts`
- `packages/confluence/src/resolve-mentions.ts` if new generic inline/block variants require traversal
- `packages/confluence/src/compose-document.ts` if new variants carry children or anchors
- DOCX/PDF serializers only when a reviewed neutral fallback variant requires an exhaustive case

Tests:

- new `packages/confluence/src/adf-to-blocks.test.ts`
- existing `packages/confluence/src/export-blocks.test.ts`
- focused DOCX/PDF fallback tests if model variants change
- `scripts/export-note-codes.test.ts`

Tasks:

- [x] Implement `adfToBlocks(raw, options)` on validated ADF.
- [x] Preserve `exporter`, `exportControls`, `pageContext`, source paths, and notes behavior from the Storage adapter.
- [x] Implement the mappings in section 5.1.
- [x] Preserve visible child content for unsupported block and inline nodes.
- [x] Add reviewed generic unsupported variants only if an existing type cannot express a safe visible fallback.
- [x] Sanitize links through the existing central safe-link policy.
- [x] Normalize marks deterministically; mark-array order must not change output semantics.
- [x] Keep literal editor shorthand as ordinary text.
- [x] Map ADF extensions to existing `unknown` macro blocks with structured parameters, recursive body, `sourcePage`, and identity fields only after correlation is proven.
- [x] Map media to the existing attachment source only after stable ID-to-attachment resolution; otherwise emit a visible fallback.
- [x] Cap, deduplicate, and summarize degradation diagnostics.
- [x] Add note codes and cross-engine traversal/report coverage.

Required semantic cases:

- [x] nested marks, code identifiers, whitespace, punctuation, and final newline;
- [x] H1–H6, mixed/nested lists, task state, and non-1 ordered-list approximation note;
- [x] paragraph/heading logical alignment and bounded indentation through composition and both renderers;
- [x] schema-defined small paragraph text through validation, composition, and both renderers;
- [x] tables including spans, background, exact per-cell width vectors, pinned
  presentation/identity attributes, numbered rows, and vertical alignment;
- [x] safe/unsafe external, page, attachment, anchor, and card links;
- [x] Unicode emoji, missing text, custom emoji, and literal colon text;
- [x] user/collection/unresolved mentions;
- [x] known, unknown, bodied, and inline extensions;
- [x] media with correlated and uncorrelated IDs;
- [x] unknown block/inline/mark with visible fallback and provenance;
- [x] deterministic output independent of object key order.

Exit:

- A valid ADF document always produces typed blocks or an explicit visible degradation; no schema row silently disappears.

Evidence recorded on 2026-07-22: `adfToBlocks()` decodes the pinned schema-valid feature fixture and has an exhaustive implementation mode for all 43 nodes and 17 marks. Focused tests cover native mappings, visible fallbacks, marks, source paths, Storage-compatible export controls, links, tables, emoji, mentions, extensions, correlated/unresolved media, deterministic ordering, and diagnostic caps. The complete repository suite passed with 4,740 tests, 13 intentional skips, and zero failures; public API/closure guards, pinned-coverage guard, existing Storage walker/composition/mention regressions, full typecheck, browser-isomorphism, and the full build passed as well. An anonymized live create/read/decode/cleanup probe confirmed ADF-primary input, literal colon-text preservation, inline-code marks, and complete cleanup; the live creation route did not materialize a standalone emoji node, so that node remains proven by the pinned schema-valid fixture rather than the live probe.

Block-presentation follow-on evidence recorded on 2026-07-23: ADF `alignment` (`center`/`end`) and `indentation` (levels 1–6) now enter a target-neutral `BlockPresentation` on paragraphs and headings. The runtime validator enforces the pinned schema values, composition preserves the presentation while rebasing headings and links, DOCX emits logical paragraph justification plus bounded `w:start`, and PDF emits design-token-driven Typst alignment/inset. Focused decoder/composition/serializer tests and the packed fixture cover both targets; the real DOCX/LibreOffice and Typst/PDF render goldens visibly prove centering and indentation.

Font-size follow-on evidence recorded on 2026-07-23: the pinned ADF schema exposes only the paragraph mark `fontSize: "small"`, so the neutral model preserves that bounded semantic rather than accepting arbitrary measures. Validation rejects every other value. DOCX applies explicit 9 pt sizing to the actual paragraph runs so template inheritance cannot erase it; PDF uses the template's bounded `adfSmallText` typography role with a 9 pt compatibility fallback. Shared browser fixtures, target serializers, and real LibreOffice/Typst render goldens visibly distinguish the small paragraph from normal body text.

### WP4 — Common dispatcher and differential fixtures

Production files:

- `packages/confluence/src/page-body.ts`
- new `packages/confluence/src/page-body-to-blocks.ts`
- `packages/confluence/src/index.browser.ts`

Tests/fixtures:

- new `packages/confluence/src/page-body.test.ts`
- paired ADF/Storage fixtures under `packages/export-fixtures/` or the Confluence package fixture directory

Tasks:

- [x] Implement exhaustive `pageBodyToBlocks()` dispatch.
- [x] Pass representation-specific budgets and common walker options correctly.
- [x] Preserve the existing Storage output byte-for-byte/structurally for unchanged fixtures.
- [x] Attach fallback notes only when the source was explicitly constructed as Storage-primary due to capability/deployment.
- [x] Compare paired ADF and Storage projections at `ExportBlock`/note/provenance level.
- [x] Keep an allowlist of intentional representation differences linked to exact gap-analysis rows.

Exit:

- Hosts no longer choose a parser directly; they provide an `ExportPageSource` and receive one neutral result contract.

Evidence recorded on 2026-07-22: the dispatcher has exhaustive ADF/Storage selection, independent parse budgets, common exporter/page options, impossible-state rejection, and no error-triggered ADF-to-Storage retry. A committed synthetic ADF/Storage pair produces identical block trees; the sole note difference is allowlisted to the exact `orderedList.order` gap and retains page/path provenance. Direct Storage output remains structurally unchanged, and fallback notes appear only for explicit deployment/capability reasons. The complete repository suite passed with 4,747 tests, 13 intentional skips, and zero failures; focused decoder/client/dispatcher, note-registry, API/closure, full typecheck, browser-isomorphism, and full-build gates passed as well. An anonymized live create/read/dispatch/cleanup probe selected ADF as primary, produced two neutral blocks without a fallback note, and removed its sole synthetic page.

### WP5 — Representation-neutral tree/source orchestration

Production files:

- `packages/confluence/src/tree-fetch.ts`
- extension/CLI tree adapters only as needed to satisfy the compatible port

Tasks:

- [x] Extend `TreeSourcePage` additively to accept `ExportPageSource` while retaining a Storage-only compatibility form during migration.
- [x] Change the single body-walk site from `storageToBlocks(page.storage)` to `pageBodyToBlocks(source)`.
- [x] Generalize Storage-specific result/error names at the orchestration boundary without removing the Storage error types.
- [x] Route `AdfValidationError` through the same strict/partial completeness policy as Storage parse-budget failure.
- [x] Keep discovery, ordering, concurrency, labels, version checks, progress, cancellation, and composition unchanged.
- [x] Aggregate representation counts/degradations without retaining raw bodies.
- [x] Ensure a page-version change between discovery and ADF read produces the existing page-version failure.
- [x] Bound simultaneous ADF + Storage sidecar reads under the existing page concurrency limit.

Tests in `packages/confluence/src/tree-fetch.test.ts`:

- [x] ADF-only, Storage-only, and mixed representation sources;
- [x] ADF strict/partial invalid and budget failures;
- [x] page-version race;
- [x] abort during ADF/sidecar read;
- [x] deterministic preorder despite parallel dual reads;
- [x] old Storage-only test sources remain valid during the compatibility window;
- [x] page provenance survives notes, unknown extensions, images, and links;
- [x] no body text appears in progress details.

Exit:

- Tree and space exports are source-representation-neutral without changing their ordering/completeness semantics.

Evidence recorded on 2026-07-22: `fetchExportTree()` now accepts the additive ADF/Storage source union and invokes only `pageBodyToBlocks()`; the Node adapter prefers the version-bound export read while legacy Storage-only ports remain valid. The current panel-owned browser host stays explicitly on that compatibility member until WP8 moves the complete dual-read lifecycle into the background resolver; it still compiles against and exercises the same browser-safe neutral port and dispatcher types. Focused tests prove ADF-only, Storage-only and mixed trees, body-free representation/degradation aggregation, strict and partial malformed/over-budget ADF behavior, source-version races, bounded concurrency, abort propagation, deterministic preorder, and provenance through notes, unknown extensions, images and typed page links. The unchanged Storage suite and the real `Response`-backed extension session-port suite pass, as do the reviewed API/closure reports, full typecheck, and production builds for the CLI, extension and browser harness. An anonymized live test created a two-page hierarchy, fetched both pages as ADF through the shared bounded tree pipeline, produced two ordered nodes, and removed both temporary pages successfully. The unrestricted complete repository suite passed with 4,756 tests, 13 intentional skips, and zero failures across 304 files.

### WP6 — CLI PDF and TypeScript DOCX

PDF production files:

- `apps/cli/src/commands/export-pdf.ts`

DOCX production files:

- `apps/cli/src/commands/export.ts`
- `apps/cli/src/commands/export-internals.ts`
- `packages/docx/src/export.ts`
- include-page loader/wiring in CLI and shared DOCX dependencies

Tasks:

- [x] Use `getExportPageDetails()` and `pageBodyToBlocks()` for single-page PDF.
- [x] Receive ADF automatically for tree/space PDF through the shared tree source.
- [x] Use the same export-specific read and dispatcher for the CLI TypeScript DOCX prewalk.
- [x] Continue passing precomposed blocks into `runExport()` so the engine does not re-walk Storage.
- [x] Keep the engine-internal Storage fallback for external `@atlcli/docx` consumers.
- [x] Convert include-page fetch/cache/walk to `ExportPageSource`/`BlocksResult`.
- [x] Make include budgets representation-neutral and add a separate bounded sidecar allowance.
- [x] Keep root/homepage Storage available for existing Page Properties/template resolvers in this wave.
- [x] Replace raw-Storage Mermaid/image heuristics with block-derived inspection where practical; otherwise document their temporary sidecar dependency.
- [x] Make no changes to the retired Python/docxtpl path and do not use it as
  implementation or acceptance evidence.
- [x] Preserve mention, macro, asset, report, strict-mode, and output behavior after the parser boundary.

Tests:

- [x] existing CLI engine parity tests with paired ADF input;
- [x] CLI PDF page/tree/space integration tests;
- [x] DOCX export/include/resolver/macro-wiring tests;
- [x] `--keep-ignored`, strict/partial, mention, image, and macro cases;
- [x] assertions that precomposed ADF blocks bypass the DOCX engine Storage walker;
- [x] report assertions for fallback/degradation and page provenance.

Exit:

- Cloud CLI TypeScript DOCX and PDF are ADF-primary with no regression in the
  supported Storage/Data Center paths.

Evidence recorded on 2026-07-22: single-page and tree/space CLI paths now select the version-bound export source and decode it before either renderer; the TypeScript DOCX engine receives precomposed blocks, while its public Storage fallback remains unchanged. Include-page lookup now carries the additive export source, caches neutral `BlocksResult` values, and accounts for primary-body and Storage-sidecar bytes independently. Focused tests prove ADF-primary PDF and DOCX source selection, ADF export-control passthrough, poisoned-sidecar avoidance, representation-neutral includes and budgets, report provenance, and existing macro/mention/image/strict-mode parity. Public API and closure reports show the additive include type with no reachable-but-unexported gaps. Full typecheck, the production build for all 16 packages, and the unrestricted complete TypeScript repository suite passed; the latter covered 4,762 tests with 13 intentional skips and zero failures across 305 files. An anonymized live create/export/cleanup test confirmed a real ADF source with an inline-code mark, ADF-primary CLI DOCX and PDF without a Storage fallback note, DOCX monospace styling, a tagged PDF with embedded fonts, and complete cleanup of its sole temporary page. The retired Python engine is excluded from these claims and gates.

### WP7 — Macro, media, card, emoji, and link parity gates

Production areas:

- `packages/export-macros/`
- `packages/export-wiring/src/ports.ts`
- CLI/extension macro and asset ports
- Confluence attachment and macro-body client methods

Tasks:

- [x] Preserve `localId`, extension key, parameters, body, and source page separately; do not overload unproven IDs.
- [x] Prove macro-body/export-view lookup from ADF identity before enabling it. The available contract does not prove that ADF `localId` is a Storage `ac:macro-id`, so lookup remains deliberately disabled and regression-tested.
- [x] Keep Storage-backed include/excerpt/multiexcerpt/Page Properties ports as sidecar consumers.
- [x] Avoid whole-page Storage parsing for one unresolved extension.
- [x] Resolve Media ID/collection to attachment metadata through a bounded, page-cached lookup.
- [x] If filename mapping is not reliable, add an `ImageSource` Media-ID variant and update both asset pipelines before defaulting ADF media. Correlation was proven as ADF `attrs.id` to v2 attachment `fileId`, whose record supplies the current filename and page ID, so no wider source union was necessary.
- [x] Normalize ADF page links into typed `LinkTarget.page` so composed in-document links still become chapter anchors.
- [x] Preserve card URLs and visible titles without requiring remote Smart Link metadata.
- [x] Use ADF emoji `text` first; unresolved/custom emoji receives deterministic text/short-name fallback and a note.

Exit:

- Existing live macro and asset features do not regress merely because the page body source changed.

Evidence recorded on 2026-07-22: ADF block and inline extensions now retain their editor identity, structured parameters, visible body and source-page provenance without copying `localId` into the Storage macro-ID field. The macro resolver carries that identity but does not invoke macro-body/export-view with it; a regression test proves the unverified route remains closed. Media-bearing ADF pages lazily fetch a bounded, cursor-loop-guarded v2 attachment index with metadata-only logging, correlate only exact `fileId` values, and pass the resulting page/filename reference through the same neutral image source consumed by DOCX and PDF. Media-free pages make no attachment request, pagination/caps report incomplete results, and filename guessing is forbidden. Existing typed page links, emoji fallbacks and Storage sidecar consumers remain covered; Smart Links additionally preserve local JSON-LD titles without a remote metadata request. Focused client, decoder, tree, macro, CLI, DOCX and PDF tests passed, as did public API/closure checks, pinned-ADF coverage, full typecheck, the 20-entrypoint browser-isomorphism gate, extension/browser output checks and the full production build. The unrestricted complete repository suite passed with 4,771 tests, 13 intentional skips and zero failures across 305 files. An anonymized live create/upload/read/export/cleanup test proved ADF-primary `fileId` correlation, an embedded media part in the DOCX archive, an embedded image in the valid tagged/font-embedded PDF, no unresolved-media diagnostics, and complete cleanup of the sole temporary page.

### WP8 — Background-job/extension integration

This work package is sequenced with the production host-routing slice after the host-neutral PDF job executor contract has landed. It must not create a second long-lived panel-owned ADF pipeline.

Target boundary from the reviewed PDF job-executor contract:

```ts
createPdfExportJobExecutor({
  async resolveInput(request, context) {
    // Fetch ADF/sidecars, validate, decode, compose, resolve notes/assets.
    return {
      input: {
        blocks,
        sourceNotes,
        complete,
        metadata,
        filename,
        settings,
      },
      env,
    };
  },
  // ready-to-render and result stores remain representation-agnostic
});
```

Tasks:

- [ ] Persist/claim the durable job before the first ADF or Storage network read.
- [x] Keep `ExportJobRequestV1.source` as locator/scope/version metadata only; do not add `bodyFormat`, raw ADF, or Storage.
- [x] Make ADF-primary a resolver policy selected by deployment capability, not a user-controlled request-v1 field.
- [ ] Run fetch, validation, decode, sidecar reads, tree composition, mention/macro resolution, and asset preparation inside background `resolveInput`.
- [ ] Use the ordered source/checkpoint pipeline for tree/space pages rather than buffering raw full-tree ADF.
- [x] Pin/verify page versions so pre-checkpoint retry cannot silently export newer content.
- [x] Ensure the ready-to-render checkpoint contains prepared engine state and diagnostics, not the original page body.
- [x] On ready-to-render recovery, perform zero ADF/Storage refetches.
- [ ] Thread job cancellation through every ADF, sidecar, macro, attachment, and identity request.
- [ ] Preserve ADF degradation notes and `complete=false` through preparation, checkpoint fingerprinting, report staging, and final activity UI.
- [ ] Keep page content out of job progress/events and error summaries.
- [x] Reuse the same shared composition helper in direct and background paths; no extension-only ADF decoder.

Required job tests:

- [ ] job row exists before first ADF GET;
- [x] cancellation during ADF and sidecar reads aborts all outstanding requests;
- [x] crash before ready-to-render refetches only version-pinned source;
- [x] crash/recovery after ready-to-render performs no source reads;
- [x] direct-vs-job blocks/notes/completeness and final PDF/DOCX report parity;
- [ ] panel closure/navigation does not abort the job;
- [x] malformed ADF fails or becomes a partial page according to completeness mode, never Storage-hidden success;
- [x] bounded page pipeline does not retain complete raw tree bodies;
- [x] packed browser consumer imports the ADF adapter without Node/Bun/dynamic-code leakage.

Incremental WP8 evidence recorded on 2026-07-23: `@atlcli/export-wiring/jobs` now exposes one browser-safe, engine-neutral Confluence source resolver over the durable locator/scope contract. Its host port owns authentication and representation policy, so request v1 remains unchanged and cannot select ADF versus Storage. Page/content/space locators map to the shared `TreeSource` walk; optional durable page-version pins are verified before the first body read and the same snapshot is reused for the body-version race check. Both renderer adapters can consume the exact same blocks, notes, completeness verdict, root metadata and chapter-anchor map. Resolver progress contains counts only, resolver errors are sanitized before the durable boundary, malformed ADF never succeeds through its Storage sidecar, and the cancellation signal reaches all in-flight page reads. The tree fetch no longer retains complete `TreeSourcePage` objects after decoding: only version/labels/space metadata survives in the ordered settled slots, so raw ADF and sidecars leave the bounded decode slot promptly. Focused resolver/tree/executor tests, API and closure guards, full typecheck, the production build, and all 20 browser-isomorphism entrypoints passed. A read-only live run returned one ADF-primary page with a complete result through the new resolver while emitting aggregate counters only. The remaining unchecked items are production host routing, source checkpoints/recovery, macro/asset preparation inside the claimed job, and end-to-end direct/background artifact-report parity.

Executor-adapter evidence recorded on 2026-07-23: format-specific factories now bind that shared resolver directly to the existing PDF and TypeScript-DOCX `resolveInput()` contracts. They force the canonical blocks, notes, completeness verdict and root identity into both engines; the DOCX adapter synthesizes body-free root details (`storage: ""`) because precomposed blocks make the legacy body fallback unreachable. PDF and DOCX recovery tests deliberately lose the first render attempt after committing `ready-to-render`, then prove the second lease performs zero source reads, creates no second prepared checkpoint, retains ADF degradation notes and contains no Storage sidecar. The browser bundle gate imports the published jobs entrypoint without Node/Bun or dynamic-code leakage. A read-only live comparison returned equal PDF/DOCX source shapes and a zero-byte DOCX root body while emitting aggregate counters only.

Pre-body tree-plan evidence recorded on 2026-07-23: `fetchExportTree()` now exposes a validated, browser-safe `atlcli.export-tree-plan/1` snapshot after traversal and label filtering but before its first ADF/Storage body read. The bounded plan contains only scope, ordering, identifiers/titles, version pins and diagnostics; it rejects foreign scopes/roots, policy mismatches, invalid nodes/notes, count-limit violations and a configurable serialized-byte budget before body IO. A recovered plan skips homepage, child, page-version and label discovery, fetches only its planned bodies and fails through the existing completeness contract when a body no longer matches its pin. Durable planning refuses the legacy body-reading label fallback when no metadata-only label port exists, so the pre-body checkpoint boundary cannot be bypassed. Focused plan/tree/API tests, full typecheck, production build, public API/closure guards and all 20 browser-isomorphism entrypoints passed; the complete repository suite passed with 4,863 tests, 15 intentional skips and zero failures. An anonymized read-only live plan/recovery comparison produced semantically equal ADF-primary nodes, a body-free plan and zero discovery calls on recovery. The next slice must persist/load this plan through the claimed job's host-owned checkpoint store; until then the production routing and crash-before-ready checklist items remain deliberately unchecked.

Persisted source-plan evidence recorded on 2026-07-23: the shared PDF and TypeScript-DOCX `resolveInput()` adapters now bind a host-owned source-plan store to the claimed job ID, request idempotency key, representation-policy identity and fenced lease epoch. A fresh lease atomically commits and publishes the opaque body-free plan ref before its first page body read; a later lease validates the stored identity, scope, policy, root and plan limits before republishing the same ref and reading only the version-pinned bodies. Recovery no longer repeats content-key, homepage, child, label or page-version discovery, including when the durable locator omitted an explicit version. Cancellation after store commit stops before publication or body IO, and malformed/foreign checkpoints fail through the sanitized source boundary. Executor-level loss-before-ready tests pass for both formats and prove a single discovery snapshot, no prepared checkpoint on the failed attempt, no raw ADF/Storage in the source plan, and successful second-lease rendering from the original pins. The focused 54-test recovery set, full typecheck, 16-task production build, public API/closure guards and all 20 browser-isomorphism entrypoints passed. An anonymized read-only live run produced equal PDF/DOCX blocks and notes, equal fresh/recovered results, complete outputs, body-free checkpoints and zero recovery discovery reads. Production job creation/claim ordering and extension activity routing remain owned by the host-integration slice.

Packed ADF job-parity evidence recorded on 2026-07-23: the browser conformance case now starts with the committed raw ADF fixture, resolves it once through the shared direct source boundary and independently through each format-specific job adapter, and fails unless blocks, degradation notes, completeness, root/page metadata and aggregate source diagnostics are identical. The resulting direct and background PDF bytes and stable report projection are exact matches; the DOCX comparison requires the same decompressed part set, byte-identical part content and the same stable report projection while explicitly allowing this unresolved-media fixture to remain media-free. The reusable PDF/DOCX parity harnesses retain their stronger real-media default for their existing fixtures. Browser-harness typecheck, 74 focused unit tests, production build/output policy, the 15-case manifest guard and the complete packed Chromium conformance run passed without foreign requests or console/page errors.

Cancellation and progress-privacy evidence recorded on 2026-07-23: both job adapters already pass one claimed-job `AbortSignal` into the shared source resolver; an integrated dual-read test now models ADF and Storage-sidecar requests inside the host port and proves one job cancellation aborts both outstanding branches before either renderer builder can run. DOCX preparation no longer forwards source-derived engine detail strings into durable progress, preventing attachment names and output filenames from escaping through that channel while retaining stage and aggregate count updates. The focused 38-test adapter/PDF/DOCX executor set passed, including cancellation, asset/raster signal propagation, recovery and sanitized-progress assertions. Runtime-owned macro/attachment/identity ports and durable error summaries remain part of the production host-integration gate.

Host-preparation privacy evidence recorded on 2026-07-23: the PDF and TypeScript-DOCX resolver adapters now place their host-owned `build()` phase behind one content-free durable error boundary. Macro, attachment, identity and asset failures can no longer copy source text, URLs or filenames into the outer job error message; the original transient error is not attached as a durable cause. Version-drift errors likewise retain typed in-memory identity fields while their message no longer includes a page identifier. An integrated preparation test starts concurrent macro, attachment and identity branches from the claimed-job context and proves that the same cancellation signal stops all three. The focused 50-test resolver/adapter/executor set and the export-wiring production build passed; production routing and its final host-level error classifier remain separate.

Current sequencing status (2026-07-23): WP8 is now in progress on this main-based branch without copying the moving background-runtime implementation. The shared source boundary is ready for that runtime to consume; durable extension host routing and its recovery/activity integration remain deliberately separate until their owning branch is synchronized.

Exit:

- The background host owns the complete source-to-artifact lifecycle, while the job executor and render engines remain ADF-agnostic.

### WP9 — Conformance, rollout, and default switch

Tasks:

- [x] Add one browser conformance case that begins with real ADF, not hand-built blocks.
- [x] Run paired ADF/Storage semantic differential tests for the feature zoo.
- [x] Run the weekly read-only observed-Cloud structural inventory against retained synthetic feature-zoo pages and compare it with both the pinned and currently discovered schema.
- [x] Add DOCX OOXML and PDF/Typst assertions where source fidelity affects output.
- [x] Add rendered goldens for inline code, emoji/custom emoji fallback, tables, native layout columns with page-bounded breakout, cards, media, and extensions where applicable.
- [x] Run the live Cloud E2E for PDF and TypeScript DOCX and clean up test resources.
- [x] Run Data Center/Storage regression coverage or the available Storage compatibility harness.
- [x] Measure requests/page, wall time, peak memory, block count, note count, and artifact parity on page/tree/space fixtures.
- [x] Ship ADF-primary behind one export-source feature flag until the gates below pass.
- [x] Make rollback switch representation choice at the source adapter; do not fork render engines.
- [ ] After one stable release window, plan lazy Storage-sidecar reads as a separate optimization.

WP9 browser evidence recorded on 2026-07-22: the packed browser harness now owns a real ADF-primary case that invokes the production representation dispatcher before either renderer. It proves target-neutral blocks and diagnostics, then structurally asserts DOCX inline-code font treatment, Unicode emoji, tables, local Smart Link title/target, extension body, and visible unresolved-media content; the PDF output passes tagged-document validation. The production browser build, output-integrity check, manifest drift guard, focused fixture test, browser-harness typecheck, and the complete 15-case Playwright conformance run passed.

Rollout evidence recorded on 2026-07-22: `ATLCLI_EXPORT_SOURCE` is parsed once into a host-owned source policy and is not part of the durable request model. Cloud defaults to `adf`; `storage` performs only the versioned Storage read and emits the existing `adf-storage-fallback` diagnostic before entering the unchanged neutral dispatcher/renderers. Invalid values fail closed. Client, dispatcher and CLI source tests, public API/closure checks, full typecheck, the 20-entrypoint isomorphism gate, documentation validation, and the production build passed. An anonymized live create/export/cleanup run proved the same rollback flag through real TypeScript DOCX and tagged-PDF artifacts, visible fallback diagnostics in both reports, and complete cleanup.

The unrestricted full regression suite then passed with 4,774 tests, 13 intentional skips and zero failures across 306 files. This includes the dedicated Data Center no-v2-read contract and the complete existing Storage walker, renderer, scope, macro, include, asset and report corpus.

Direct-coverage evidence recorded on 2026-07-22: an exhaustive compile-time fixture map now has one real ADF document per pinned node and mark row. Child-only nodes are exercised in their smallest meaningful parent context; every case passes through the production validator/decoder, must produce visible blocks, and every `visible-fallback` mapping must emit a diagnostic with page/path provenance. The guard covers exactly 43 nodes and 17 marks, so adding or removing an upstream classification fails until the direct fixture set changes deliberately. All 61 direct-fixture assertions passed.

Differential evidence recorded on 2026-07-22: the paired ADF/Storage semantic feature zoo covers headings, inline bold/code/line-break/emoji semantics, blockquotes, bullet and ordered lists, task state, table spans/background, panels, status and rules. Both source adapters produce byte-for-byte equal neutral block trees with the expected ten-block shape. The only note difference is explicitly allowlisted to ADF's observable non-default ordered-list start, with page and block-path provenance.

Observed-Cloud evidence recorded on 2026-07-22: the weekly optional job now accepts up to 16 retained feature-zoo pages through a secret-only list, aggregates their structural signatures, and fully validates each ADF document against both the committed schema pin and the package schema discovered in that run. Focused tests proved multi-page aggregation, independent current-schema constraint drift, bounded configuration, backwards-compatible skip behavior, and absence of raw content, page references, credentials, and tenant origin from reports. A sanitized live run created one marked temporary feature-zoo page, observed 11 node types and two mark types with `no-drift`, passed both schema validators, and deleted the page with zero cleanup failures. Full build, typecheck, docs, API/closure, browser-isomorphism, browser-output and offline pin gates passed; the complete repository suite passed with 4,838 tests, 13 intentional skips and zero failures across 307 files.

Rendered-golden evidence recorded on 2026-07-22: one synthetic ADF feature zoo now renders through the production decoder and both real export engines, then through LibreOffice/Poppler rasterization. The reviewed references initially covered inline code, Unicode and unresolved custom emoji, a panel, table, linearized layout content, local card link, expand, extension fallback/body, and media fallback/caption; the layout reference is superseded by the native-column follow-on below. A source hash prevents fixture changes from silently reusing old references; PNG hashes, required extracted text, page counts, normalized pixel difference, and content-bound overlap guard every rerender. The review exposed and fixed a real PDF missing-glyph defect by adding a pinned, checksummed OFL symbol fallback to every Typst text role and both curated template font contracts. The canonical DOCX renderer and all five reference pages were inspected with no clipping, overlap, tofu glyphs, or hidden fallback text. CLI, packed harness, and extension asset-parity gates proved that the font is present in every runtime, while the complete browser conformance run and an anonymized live ADF-primary DOCX/PDF create-export-cleanup run proved both engines end to end.

Rollout-benchmark evidence recorded on 2026-07-22: a deterministic paired ADF/Storage corpus now exercises page, 25-page tree, and 25-page space scopes through the production source dispatcher, tree orchestration, composition, DOCX, and Typst/WASM PDF. Logical request accounting mirrors the production adapter and proved the correctness-first dual read adds exactly one body request per page: page 2.00 to 3.00 requests/page, tree 3.04 to 4.04, and space 3.08 to 4.08. The synthetic body transfer rose from 869 to 3,392 bytes/page because the 2,523-byte ADF body accompanies the Storage sidecar. With five in-process source samples inside each of three complete process samples, median local source/decode/compose time on Bun 1.3.14 arm64 was 0.2 to 0.3 ms for page, 1.7 to 2.4 ms for tree, and 1.6 to 2.1 ms for space. Median whole-process BSD-time peak RSS, including both render engines, compiler, fonts, and fixture setup, was effectively flat: 377/377 MiB, 491/497 MiB, and 490/494 MiB respectively. Raw blocks stayed 10/page, the expected observable ordered-list diagnostic was 1/page only on ADF, normalized DOCX part hashes matched in every process sample, and PDF bytes matched exactly for every scope. The fail-closed guard now requires exact +1 request/page, exact block/artifact and expected-note parity, ADF source wall time no greater than `2 × Storage + 1 ms`, and no more than 32 MiB added median peak RSS when the platform exposes RSS.

Default-enable gates:

- [x] all 43 nodes and 17 marks classified in the coverage manifest;
- [x] every mapped row has a direct ADF fixture;
- [x] no silent node/mark/attribute drops;
- [x] no silent whole-page decoder fallback;
- [x] macro and media correlation gates pass or remain visibly degraded;
- [x] direct and background report parity passes;
- [ ] source bodies are absent from logs/job records/events;
- [x] browser, Node/Bun, package, API, closure, and packed-consumer gates pass;
- [x] Cloud live E2E passes for both target formats;
- [x] Storage/Data Center regressions pass;
- [x] dual-read request/latency overhead remains within the first-rollout budget above.

## 8. Interaction with the parallel export-jobs workstream

PR numbers are deliberately absent from the normative plan. The stack may be reordered, split, or renumbered without changing this architecture. At the start of WP0 and again before WP8, resolve the then-current PRs/branches that own the contracts and files below. Record those volatile references in the implementation task or PR description, not as dependencies in this plan.

If a current branch no longer exposes the named contract, stop and update this section before implementing against a guessed replacement.

### 8.1 Reviewed job-executor capability snapshot

The reviewed current workstream baseline:

- provides host-neutral PDF and TypeScript-DOCX job executors with fail-closed request validation;
- splits preparation from render and checkpoints ready-to-render state for both formats;
- fingerprints prepared state, report, and artifact metadata;
- routes ordinary CLI DOCX and PDF exports through durable exact-ID jobs before the first Confluence API read;
- preserves host-owned `resolveInput()` seams for both formats and proves their runtime behavior;
- does not route the production extension/background export yet;
- changes CLI and export-job/wiring production files, but does not introduce ADF or change `packages/confluence` source contracts.

The key contracts are favorable: `createPdfExportJobExecutor()` and `createTypescriptDocxExportJobExecutor()` accept host-owned `resolveInput()` callbacks that return normal engine inputs containing neutral blocks and report state. ADF belongs inside those host-owned resolution steps. The durable request, executor, ready-to-render store, renderer/compiler, and artifact staging do not need an ADF concept.

### 8.2 Direct overlap matrix

| Area | Parallel export-jobs workstream | This plan | Conflict risk | Resolution |
|---|---|---|---|---|
| `packages/confluence` client/decoder/tree | None | Primary implementation area | Low | Develop independently. |
| CLI DOCX/PDF source wiring | Durable production routing and both `resolveInput()` seams are present | Change source composition inside the existing resolvers | Medium | Preserve request/runtime ownership; put ADF fetch/decode only inside host resolution. |
| Extension production source wiring | Owned by a later host-routing slice | Deferred to background `resolveInput` | Medium with that slice | Integrate once in the background host, not first in React and then again in jobs. |
| `packages/pdf/src/run-export.ts` | Prepare/render split | Should remain unchanged | Low | Feed blocks through existing input; do not add ADF there. |
| `packages/export-wiring/src/jobs/*-job-executor.ts` | PDF and TypeScript-DOCX executors | Consumed only | Low | Do not change unless a proven neutral input field is missing. |
| Export-job request/validation | Closed v1 request | Must remain locator-only | Low if unchanged; high if `bodyFormat` added | Keep representation out of request v1. |
| Browser conformance manifest/registry | Modified by the executor/conformance slice | Adds later ADF case | High textual, low architectural | Rebase after the owning slice, then add the case. |
| Generated PDF/API/closure reports | Modified by executor and packaging slices | May change through public `ExportBlock` variants | Medium textual | Regenerate only after rebasing on the current stack. |
| Future ordered source/checkpoint host | Foundation in job stack | ADF page processing consumer | Medium architectural | Decode one page at a time; checkpoint neutral results/refs, not raw full-tree ADF. |

### 8.3 Sequencing

Recommended landing order:

1. Keep WP1–WP4 main-compatible while the durable CLI runtime evolves in parallel; treat its host-owned resolution contracts as the later integration target, not as this branch's base.
2. Land WP1–WP4: safe client read, ADF validator/decoder, dispatcher, and differential fixtures.
3. Land WP5–WP7: representation-neutral tree plus CLI `resolveInput()` integration and compatibility gates.
4. Re-resolve the current export-jobs stack, then rebase/regenerate API, closure, and browser-harness artifacts after any newer slices that own those files.
5. Integrate WP8 with the production background host-routing slice; ADF starts inside its `resolveInput()`.
6. Run WP9 and enable ADF-primary independently for CLI and background extension after their own parity gates.

If implementation overlaps the export-jobs stack, avoid editing these likely hot files until the owning slice is identified and the branch is rebased:

- `apps/browser-export-harness/src/conformance-manifest.ts`
- `apps/browser-export-harness/src/conformance-registry.ts`
- `apps/browser-export-harness/tests/exports.e2e.ts`
- `packages/pdf/etc/pdf.api.md`
- `packages/pdf/etc/pdf.closure.md`
- `packages/export-wiring/etc/export-wiring.api.md`
- `packages/export-wiring/etc/export-wiring.closure.md`

### 8.4 Job invariants imposed on the ADF work

- The job is durable before any source read.
- A job request identifies source and version; it does not contain a fetched representation.
- Fetch/decode is restartable before ready-to-render and forbidden after ready-to-render recovery.
- Source version drift fails visibly.
- ADF/Storage content never appears in job metadata or progress.
- Diagnostics and completeness are part of prepared/fingerprinted output, so a retry cannot erase ADF degradation.
- The source pipeline remains bounded per page/result slot.

Therefore the export-jobs workstream and this plan are complementary. The main coordination risk is not a particular PR number; it is placing ADF fetch/decode in the temporary panel path and then moving it again. This plan avoids that duplication.

## 9. Validation matrix

### Focused gates during implementation

```bash
bun run test packages/confluence/src/adf-validate.test.ts
bun run test packages/confluence/src/adf-to-blocks.test.ts
bun run test packages/confluence/src/page-body.test.ts
bun run test packages/confluence/src/client.test.ts
bun run test packages/confluence/src/tree-fetch.test.ts
bun run test scripts/adf-drift.test.ts
bun scripts/adf-drift.ts check-pinned
bun run test scripts/adf-rendered-goldens.test.ts
bun run check:adf-rendered-goldens
bun run test scripts/bench/generate-adf-source-fixture.test.ts scripts/bench/run-adf-source-bench.test.ts
bun run bench:adf-source --pages 25 --repeat 5 --process-repeat 3
bun run test scripts/export-note-codes.test.ts
bun run test scripts/api-report.test.ts
```

Add focused CLI, DOCX, PDF, macro, and extension/job test paths as their work packages land. Always run them through `bun run test`, never bare `bun test`.

### Required integration gates before merge of behavior changes

```bash
bun run typecheck
bun run check:browser
bun scripts/api-closure.ts
bun run build
bun run test
```

When browser-host work lands:

```bash
bun run assert:conformance-cases
bun run check:browser-export-harness
bun run test:browser-export-harness
bun run check:extension-output
```

Before any commit that changes production behavior, run the proportionate live
E2E against the configured test environment. Remove ordinary temporary
pages/attachments afterwards. The one persistent feature-tree fixture from
section 6 is the explicit exception: reuse it for CLI subtree DOCX/PDF
conformance and keep every live identifier out of repository files, commit/PR
text, logs selected for publication, and CI artifacts. Documentation-only plan
changes require `git diff --check`; they do not claim runtime test coverage.

The weekly online check is invoked only by `.github/workflows/adf-drift-watch.yml` or explicit `workflow_dispatch`:

```bash
bun scripts/adf-drift.ts check-upstream --out artifacts/adf-drift
```

It is not added to PR or release commands.

### Differential acceptance dimensions

Paired ADF/Storage fixtures compare:

- block type and order;
- exact text and line breaks;
- marks and colors;
- list/task state and nesting;
- table shape, spans, widths, and background;
- safe link target identity;
- mention account/collection identity;
- macro identity, parameters, body, and source page;
- image/media source identity and alt text;
- source note code, level, message category, and provenance;
- completeness and fallback/degradation counts.

Artifact byte identity is required only where the resulting neutral blocks, notes, metadata, and deterministic clock are equal. Otherwise the intentional difference must be linked to a gap row and covered by target-specific assertions.

## 10. Rollout and observability

Use one source-selection flag shared by CLI and extension host adapters, with independent default enablement:

- `storage`: compatibility/rollback mode;
- `adf-primary`: Cloud ADF with explicit Storage sidecar;
- no automatic `auto` mode whose behavior cannot be reported.

At export completion, aggregate without body content:

- pages read as ADF;
- pages read as Storage-primary and reason;
- pages using a Storage sidecar;
- unsupported node/mark/attribute counts by type;
- unresolved macro/media/card/emoji counts;
- ADF parse/budget/version errors;
- request count and total body bytes by representation;
- complete/partial result.

These aggregates may enter reports or local diagnostics according to existing privacy policy. Raw attributes, text, URLs containing secrets, and page bodies must not.

Rollback switches only the source adapter to Storage-primary. It must not bypass version checks, macro/asset security policy, completeness rules, or report generation.

## 11. Definition of done for the first migration

- [x] Cloud export-specific reads request and validate ADF without leaking it to logs.
- [x] Data Center remains Storage-based; the retired Python engine is outside
  this migration's implementation and acceptance scope.
- [x] ADF and Storage version races fail visibly.
- [x] Runtime validator is bounded, iterative, isomorphic, and adversarially tested.
- [x] Pinned schema/coverage CI classifies all 43 nodes and 17 marks.
- [x] Weekly online schema/reference/REST drift watch runs independently of PR and release gates and produces JSON/Markdown evidence.
- [x] Optional weekly observed-Cloud inventory uses synthetic read-only fixtures and publishes no page content.
- [x] `adfToBlocks()` covers all semantics already representable by the neutral model.
- [x] Unsupported semantics preserve visible content or a visible placeholder and emit bounded notes.
- [x] `pageBodyToBlocks()` is the only representation dispatch used by new export hosts.
- [x] Tree/page/space orchestration accepts mixed representation sources without ordering changes.
- [x] CLI TypeScript DOCX and PDF are ADF-primary under the rollout flag.
- [x] Includes, Page Properties, excerpts, and live macro/export-view behavior retain their Storage sidecar path.
- [x] Macro and media identity is correlation-proven or visibly degraded.
- [ ] Background integration starts inside the durable job's `resolveInput()` and does not change request v1.
- [x] Ready-to-render recovery performs no source refetch.
- [x] Direct/background notes, completeness, report, and artifact parity gates pass.
- [x] Browser/package/API/closure/full-suite/live-E2E gates pass.
- [x] Ordinary temporary E2E resources are deleted; the explicitly designated
  persistent feature-tree fixture follows the runtime-only privacy and
  maintenance contract in section 6.
- [x] Coverage and user documentation are updated with the source flag, fallback policy, and known limitations.

## 12. Risks and mitigations

| Risk | Mitigation / blocking gate |
|---|---|
| ADF and Storage/metadata come from different versions | Compare versions and surface the existing page-version-changed semantics; never merge. |
| Dual reads increase latency and rate-limit pressure | Run under bounded concurrency, cache capability, measure requests/page, then add lazy sidecars after parity. |
| v2 response logging exposes page content | Add and test `meta-only` logging before the ADF method lands. |
| Runtime JSON/schema validator bloats or violates MV3 | Use a small iterative runtime validator; keep full schema work in deterministic test/build tooling; run browser closure/output gates. |
| Unknown schema members disappear | Coverage manifest plus visible generic degradation and bounded notes. |
| Atlassian changes the mutable schema reference without a dependency update | Weekly canonical-link/package/hash/definition watchguard; never use the mutable URL as build input. |
| Redirect, package metadata, and CDN propagate at different times | Retry in-run, classify `propagation-mismatch`, preserve the committed pin, require human review. |
| Weekly upstream network failure creates noise | Separate `watch-unavailable` from semantic drift, use bounded retries, keep the workflow outside delivery gates. |
| Global schema and Confluence production diverge | Separate read-only observed-Cloud structural inventory from the global schema monitor. |
| Deep/wide JSON exhausts memory or stack | Pre-parse byte cap, iterative walk, measured node/depth/text/attribute budgets. |
| Media ID cannot map to current filename asset seam | Correlation spike; add a neutral Media-ID source variant supported by both engines before enabling. |
| ADF extension ID does not match macro-body ID | Keep identities separate; enable resolver only after live proof; retain visible fallback and Storage sidecar. |
| Whole-page Storage fallback hides decoder gaps | Only capability/deployment fallback constructs Storage-primary; decoder failures never redispatch. |
| Reports become unbounded on unknown content | Per-document diagnostic budget, deduplication, summary note, aggregate counts. |
| Existing Page Properties/include/excerpt behavior regresses | Keep Storage sidecar and current ports until ADF-native definition indexes are a separate completed migration. |
| Public unsupported variants widen every consumer | Treat as reviewed API work with exhaustive switches, API reports, both serializers, and conformance in one slice. |
| Moving export-jobs PR stack causes merge conflicts | Resolve ownership by contract/file at WP start; keep ADF upstream; defer harness/generated-file regeneration and production extension wiring until after rebase. |
| ADF is decoded in React before durable job creation | Job E2E asserts first network read occurs only inside background `resolveInput()` after persistence/claim. |
| Recovery exports a newer page version | Pin/compare versions and checkpoint neutral prepared state; fail on drift before ready-to-render. |

## 13. Follow-on work, deliberately not hidden in this plan

Completed follow-on evidence recorded on 2026-07-23: inline code now has deterministic DOCX run shading and a theme-colored PDF inline chip with bounded inset/radius. Exact synthetic underscore tokens remain unchanged, explicit DOCX source shading wins over the default, and block-code styling remains separate. Focused DOCX/PDF semantic tests passed. The ADF feature zoo was regenerated through the real DOCX/LibreOffice and Typst/PDF/Poppler stacks; one DOCX page and all four PDF pages were visually inspected without clipping, overlap, broken wrapping or missing glyphs. PDF uses the bundled mono font; embedding or otherwise guaranteeing the DOCX mono font remains an explicit residual gap.

Completed follow-on evidence recorded on 2026-07-23: ordered-list starts now survive both ADF `order` and Storage `<ol start>` in the shared neutral model. DOCX allocates a self-contained single-level numbering definition per ordered-list node, with its authored start and nesting indent; PDF emits the native Typst `enum(start:)` contract. Focused tests cover top-level and nested non-default starts, ADF/Storage differential equality, and default restart behavior. The rendered-golden gate extracts both outputs and requires the visible `3.` and nested `8.` markers, preventing a structurally valid but visually missing-number regression. The reviewed offline coverage baseline now records `orderedList` as native, so the pinned-contract gate detects any later unreviewed classification change.

Completed follow-on evidence recorded on 2026-07-23: ADF block `alignment` (`center`/`end`) and `indentation` (levels 1–6) now survive validation, decoding, tree composition, DOCX, and PDF through the shared `BlockPresentation` contract. DOCX uses logical paragraph justification and bounded start indentation; PDF uses Typst alignment and a template-design indentation step. The shared ADF browser fixture asserts the neutral shape and DOCX OOXML, while real LibreOffice and Typst/Poppler goldens visibly prove centered and indented paragraphs. Both mark rows are pinned as native.

Completed follow-on evidence recorded on 2026-07-23: ADF paragraph `fontSize: "small"` now survives validation, decoding, composition, DOCX, and PDF through the shared `BlockPresentation` contract. Arbitrary size values fail validation. DOCX writes explicit 18-half-point run sizes; PDF resolves the template-owned `adfSmallText` role with a bounded 9 pt fallback. The packed source fixture and real render goldens prove visibly smaller text in both formats, and the mark row is pinned as native.

Completed follow-on evidence recorded on 2026-07-23: ADF `success` and `error` panels now survive as distinct neutral callout kinds and render with explicit semantic palettes in TypeScript DOCX and Typst/PDF. Validation accepts exactly the seven panel types in the pinned schema and rejects missing or unknown types. At this checkpoint custom panels remained a visible generic panel with an explicit degradation note; the later custom-panel follow-on below closes that residual. Existing PDF template-v1 manifests stay compatible by inheriting the `tip` palette for success and `warning` for error when the new optional roles are absent. Focused decoder/renderer tests, the hardcoding ledger, full typecheck, the production browser build and packed 15-case Chromium conformance run passed. Real LibreOffice and Typst/Poppler goldens visibly prove blue information, green success and red error panels without overlap or clipping; a deterministic rerender produced zero pixel difference.

Completed follow-on evidence recorded on 2026-07-23: ADF and Storage emoji now retain one target-neutral `EmojiSemantics` record containing the required short name, optional service id, exact optional source text (including an empty string), and the selected visible fallback. Missing/empty Unicode text and colon-shaped non-standard text emit the stable cross-representation `emoji-text-fallback` warning with source provenance; arbitrary stored `:syntax:` remains literal text with no emoji metadata. Both TypeScript renderers consume the same visible run, while the packed browser case proves direct/background artifact and report parity. This deliberately does not invent a custom-emoji network route: Atlassian's current Forge ADF renderer also documents custom user-provided emoji as unsupported, so a future asset resolver remains gated on a documented, authorized platform contract.

Completed follow-on evidence recorded on 2026-07-23: pinned-schema task and decision semantics now survive validation, ADF/Storage decoding where each representation exposes them, document composition, TypeScript DOCX, and Typst/PDF. The neutral list contract retains list/item kind, required local identities, exact state, inline-versus-block task shape, checkbox compatibility, and nested task ownership. Task state remains strictly `TODO`/`DONE`; decision state remains the schema-defined product string and nonstandard values are visibly labeled instead of being collapsed. DOCX emits distinct open/done task glyphs and filled/hollow decision markers without native numbering; PDF emits aligned semantic grids using the active design tokens and bundled symbol fallback. The synthetic ADF feature zoo, paired ADF/Storage task fixture, focused validator/decoder/composition/serializer tests, full typecheck and production build, public API/closure gates, 20-entrypoint browser-isomorphism gate, packed 15-case Chromium conformance run, and exact direct/background artifact-report parity passed. Real LibreOffice and Typst/Poppler goldens visibly prove inline tasks, block tasks, nested tasks, and decisions without overlap, clipping, or missing glyphs; the deterministic rerender produced zero pixel difference.

Completed follow-on evidence recorded on 2026-07-23: nested list ownership is now explicit and differential across direct ADF and the `body.storage` compatibility adapter. Paired fixtures cover bullet-in-bullet, ordered-in-ordered with independent authored starts, and task-in-task using each representation's native shape; both adapters produce the same neutral tree with the child list inside its owning item. DOCX tests cover mixed ordered/unordered nesting, numbering-instance isolation, per-level indentation, and nested task glyphs without accidental numbering. PDF tests cover nested bullet/task emission and the exact nested source-map path; this work fixed a real provenance bug where a list item's tail blocks were incorrectly indexed from zero after its leading paragraph. The packed browser source case asserts the numbered starts, bullet level, task hierarchy, and direct/background parity. Real LibreOffice and Typst/Poppler goldens visibly prove all three nested forms without overlap, clipping, or flattened ownership.

Completed annotation/fragment identity-preservation sub-slice recorded on 2026-07-23: the bounded validator now enforces the pinned annotation and fragment attribute contracts, including exact `inlineComment`, schema-valid empty annotation IDs, non-empty fragment local IDs, and exact optional fragment names (including an empty string). The neutral model retains annotation identities on text and resolved/unresolved media, and fragment identities on inline/block/bodied extensions and tables. Decoder, direct-schema, composition, target-neutral fixture, production-browser, and direct/background source-resolution gates prove that these identities survive the TypeScript pipeline while both renderers deliberately leave visible output unchanged. Applying a block export-control deliberately consumes its marked extension wrapper; that exceptional residual now emits a degradation note instead of silently attaching the fragment to an arbitrary child, while inline export-controls retain it on their visible text. At this checkpoint native Word comments/PDF notes still required separately fetched inline-comment resources and a product policy; the later fragment-provenance follow-on closes the fragment row with a documented non-visual static policy instead of inventing bookmark semantics.

Completed table-attribute follow-on evidence recorded on 2026-07-23: the
bounded validator now enforces the complete pinned `table`, `tableRow`,
`tableHeader`, and `tableCell` attribute shapes. The neutral table contract
retains exact optional source identity, layout, authored pixel width, display
mode, explicit numbered-column state, per-cell `colwidth` vectors (including
zero/unfixed tracks), and vertical alignment. Storage tables retain the
equivalent local identity, layout, and cell vertical alignment when those
attributes are present. One shared materializer gives DOCX and PDF identical
1-based visible row numbering. DOCX emits bounded dxa width, logical
justification, fixed layout, and `w:vAlign`; Typst/PDF emits bounded point width,
logical alignment, and per-cell vertical alignment. Focused validation,
decoder, Storage, composition, DOCX, PDF, and fixture tests pass. The packed
browser fixture carries the same attributes through direct and background
source resolution, and the real LibreOffice/Typst render baseline visibly
shows the narrow numbered column and right-aligned table. Oversized
`wide`/`full-width` geometry remains bounded by the physical output page, and
responsive screen shrinking has no dynamic meaning in a static artifact; both
are explicit renderer policies rather than silent notation loss. A
schema-valid non-positive width remains in the neutral model but emits a
source-located degradation note before both renderers select their safe
portable fallback.

Completed layout-column follow-on evidence recorded on 2026-07-23: the pinned
ADF validator now enforces exact `layoutSection`, `layoutColumn`, and `breakout`
attributes. The neutral model retains section/column local identity, required
column proportions, top/middle/bottom alignment, nested content ownership, and
layout-section breakout mode/width. The `body.storage` adapter independently
maps Confluence's documented `single`, `two_*`, and `three_*` layout-section
types to the same neutral columns; missing or structurally mismatched geometry
uses deterministic equal tracks with a source-located report note. Composition,
anchor/heading processing, mention resolution, macro resolution, image/diagram
preparation, and host asset counting all recurse through columns without
flattening them. DOCX emits a borderless fixed table with proportional dxa
tracks and cell vertical alignment; Typst/PDF emits a semantic-free grid with
proportional fractional tracks, gutter, and cell alignment. Schema-valid zero
widths receive an explicit source note and a positive minimum track in both
targets. The browser ADF fixture proves direct/background block, report, and
artifact parity. Real render goldens replace the old flattened-layout reference
with visible 30/70 columns in both formats. `wide`/`full-width` remains an
explicit page-bounded approximation; the later breakout follow-on closes every
other pinned placement under the same static-artifact policy.

Completed caption/disclosure follow-on evidence recorded on 2026-07-23: the
pinned validator now enforces the actual direct-inline ADF `caption` shape and
the required non-empty `expand`/`nestedExpand` bodies, including exact optional
titles/local identities and the nested node's required attributes. Native ADF
captions stay attached to resolved images or to a typed, non-fetching media
fallback that retains the original media identity; both targets number the
caption normally instead of emitting detached prose. ADF `expand` and
`nestedExpand` plus Storage `expand` now share a recursive neutral disclosure
block. Storage preserves macro/local identity and marks an expand inside a
table cell or another expand as nested, while a differential fixture proves
the same recursive tree as ADF. Composition, heading/anchor discovery, mention and caption-link
resolution, macro resolution, asset traversal, CLI and extension PDF
preparation all recurse through the disclosure boundary. TypeScript DOCX and
Typst/PDF render a deterministic visibly open panel and report `expand-static`
because an interactive collapsed state cannot survive a static file. The
packed ADF browser fixture proves direct/background block, report, and artifact
parity. Reviewed LibreOffice and Typst/Poppler references visibly contain the
outer and nested titles/bodies plus a numbered unresolved-media caption without
clipping, overlap, or detached content. The slice passed 546 focused tests with
one intentional skip, the reviewed 43-node/17-mark offline pin, public API and
closure generation, full workspace/browser typecheck, the 16-task production
build, all 20 browser-isomorphism entrypoints, the 15-case manifest guard, and
the complete packed Chromium conformance run. The deterministic golden check
reproduced one DOCX and four PDF pages with zero pixel difference and content
bounds IoU 1. The unrestricted suite remains the remote-CI gate.

Completed date/status/placeholder follow-on evidence recorded on 2026-07-23:
the bounded validator and both source adapters now preserve pinned ADF date,
status, and template-placeholder semantics in the shared neutral model. Dates
remain exact epoch-millisecond strings, are formatted in UTC using the document
locale, and never guess seconds or locale-shaped Storage input; malformed values
stay visible with a source-located `date-invalid` note. Statuses retain exact
color, local identity, and optional style, including Confluence-compatible
`mixedCase` casing. DOCX and PDF use explicit neutral/purple palettes, with a
compatibility fallback for older PDF template-v1 manifests that do not define
those roles. Template placeholders retain editor identity while intentionally
emitting no visible published-output text, matching Confluence's static-view
contract. Paired ADF/Storage fixtures, focused validation/decoder/composition/
TOC/DOCX/PDF tests, packed direct/background browser conformance, and real
LibreOffice plus Typst/Poppler goldens prove the semantic and visual contract.

Completed core block-identity follow-on evidence recorded on 2026-07-23:
paragraph, heading, and ordinary list-item `localId` attributes now pass through
bounded validation, direct ADF decoding, available `body.storage` equivalents,
the shared neutral model, document composition, and both renderer input trees.
Exact optional values, including an explicitly empty string, remain non-visual
metadata and therefore do not invent bookmarks or alter DOCX/PDF appearance.
Paired ADF/Storage fixtures, the modern Cloud `<p local-id>` regression,
composition tests, the target-neutral browser fixture, and packed
direct/background source parity guard the contract.

Completed code-block follow-on evidence recorded on 2026-07-23: the bounded
validator now enforces every pinned `codeBlock` attribute type, unmarked-text
content, and the root-only breakout exception. The shared block retains exact
code (including an empty final line), optional language values, tri-state
`wrap`, normalized line-number policy, `localId`, and `uniqueId`; Storage
`pre`/`code`/`noformat` uses its own no-gutter default and additionally retains
legacy `linenumbers`, `firstline`, and macro local identity. DOCX emits a muted
line-number gutter with a hanging continuation indent and syntax-colored runs.
PDF uses a scoped Typst `raw.line` projection with a fixed gutter and a
breakable code track. Both targets therefore keep long lines visible on bounded
pages; an explicit ADF no-wrap preference remains in the neutral model and
emits the cross-engine `code-nowrap-page-bounded` fact instead of clipping
silently. Composition, direct/background browser resolution, artifact/report
parity, final-newline numbering, and real LibreOffice/Typst-Poppler render
goldens guard the contract. Legacy Storage-only code-macro title/collapse is
recorded as a separate open compatibility gap, not as a partial ADF row.
The shared Shiki adapter also restores trailing empty source lines when the
CSP-safe JavaScript engine omits them, so the packed browser/extension and
Oniguruma CLI hosts produce the same numbered source text despite different
syntax-token boundaries.

The completed slice passed 440 focused validator/decoder/Storage/composition/
DOCX/PDF/browser tests, the generated public API and closure guards, the
offline 43-node/17-mark pin check, full typecheck, the 16-task production build,
all 20 browser-isomorphism entrypoints, output integrity, the 15-case manifest
guard, the complete packed Chromium harness, and direct/background byte/report
parity. The real LibreOffice and Typst/Poppler references remain one DOCX page
and four PDF pages; the deterministic rerender produced zero pixel difference
and content bounds IoU 1. No unrestricted local suite or private Confluence
environment was used; the remote CI remains the complete-suite gate for this
work package.

Completed custom-panel follow-on evidence recorded on 2026-07-23: every pinned
panel attribute now passes through bounded validation, ADF decoding, the shared
neutral model, composition, and both TypeScript renderers. Portable long and
short hex colors are canonicalized, then rendered as the authored accent with
a contrast-safe tinted background. Static targets prefer exact visible icon
text and retain the emoji short name plus custom-emoji identity for future
authorized resolvers. Non-portable colors and ID-only custom emoji remain
visible with exact source metadata and source-located degradation diagnostics.
The packed browser fixture checks target-neutral semantics plus DOCX
presentation; reviewed LibreOffice and Typst/Poppler references visibly contain
the custom icon, color, and body without clipping or overlap. This closes the
custom-panel row rather than leaving a locally actionable partial.
The slice passed 268 focused tests with one intentional rendered-golden skip,
the six-test public API/closure guard with zero reachable-but-unexported gaps,
the offline 43-node/17-mark/84-definition pin, full typecheck, the 16-task
production build, all 20 browser-isomorphism entrypoints, browser/extension
output integrity, the 15-case manifest, the complete packed Chromium run, and
direct/background byte/report parity. The deterministic real-render check
reproduced one DOCX and four PDF pages within the reviewed visual budgets
(maximum mean pixel difference 0.0063; minimum content-bounds IoU 0.9868).
At that checkpoint the matrix recorded 54 of 84 rows closed and 30 open; the
unrestricted suite remained the remote-CI gate.

Completed mention follow-on evidence recorded on 2026-07-23: the bounded
validator now enforces the complete pinned mention contract. The shared inline
model retains the exact account-or-collection ID, optional source text
including an empty string, local identity, access level, and exact
`DEFAULT`/`SPECIAL`/`APP` user type. Source text or the existing host resolver
provides the visible name without replacing source metadata. When lookup is
unavailable, empty, or represents a deactivated identity, both TypeScript
targets render deterministic `Unknown user`/`Unknown app` labels and never
publish the raw technical ID. No profile hyperlink is invented because the
pinned node contains no profile URL. Composition, nested/caption resolver
traversal, packed direct/background browser parity, and reviewed real DOCX/PDF
goldens retain the full contract. This closes both the ADF node and editor `@`
rows. The slice passed 258 focused tests with one intentional rendered-golden
skip, the six-test public API/closure guard with zero
reachable-but-unexported gaps, the offline 43-node/17-mark/84-definition pin,
full typecheck, the 16-task production build, all 20 browser-isomorphism
entrypoints, browser/extension output integrity, the 15-case manifest, the
complete packed Chromium run, and direct/background byte/report parity. The
deterministic real-render check reproduced one DOCX and four PDF pages with
zero pixel difference and content-bounds IoU 1. The matrix now records 56 of
84 rows closed and 28 open; the unrestricted suite remains the remote-CI gate.

Completed progress-register hardening recorded on 2026-07-23:
`scripts/adf-gap-register.test.ts` discovers every table headed by `Done`,
requires a checkbox on every data row, reconciles the declared closed/open
orientation with the actual 84 rows, and permits an unchecked `Partial` row
only when that row names an external contract or parallel dependency. This
turns the review convention into an executable consistency guard. It does not
change the separate weekly upstream-drift watch's intentionally non-blocking
status.

Completed portable-code-font follow-on evidence recorded on 2026-07-23: ADF
`code` marks and Storage `<code>` now render with the committed OFL JetBrains
Mono face in every TypeScript DOCX host. The exporter validates the sfnt and its
OS/2 embedding rights, verifies the exact committed face against a pinned
SHA-256 digest, applies ECMA-376's deterministic first-32-byte obfuscation, and
owns the font part, content type, font table, and relationship chain. The
mutation is idempotent and occurs only when inline or block code is present;
corrupt, restricted, bitmap-only, or substituted fonts fail before archive
mutation. The Node package loader, browser `new URL` asset, bundled CLI bridge,
and compiled single-binary bridge all supply the same committed bytes. PDF
retains its already-bundled code face.

The pinned source fixture combines code with annotation metadata and surrounding
ordinary text, so the mark slice proves exact underscores, adjacency,
source-highlight precedence, and coexistence. The later annotation follow-on
also correlates and renders its synthetic comment resource. The production
browser bundle contains no Node
builtin, direct and background DOCX jobs compare the complete decompressed
archive including the font binary, and the packed Vite consumer requires the
hashed font asset. A real LibreOffice conversion on a host without the system
face carried JetBrains Mono into the resulting PDF as an embedded font; the
reviewed one-page DOCX reference changed accordingly, and a deterministic
rerender reproduced one DOCX and four PDF pages with zero pixel difference and
content-bounds IoU 1.

An anonymized live run created and intentionally retained one synthetic
two-page conformance tree for reuse by later feature slices. ADF-primary CLI
tree export preserved root and child inline-code tokens in DOCX and PDF without
a Storage-fallback diagnostic; the DOCX contained the complete embedded font
chain and the PDF used its embedded code face. No environment or content
identifier is stored in the repository or this plan.

The slice passed the focused engine/API/render/build-mode suites, the public API
and closure guard with zero reachable-but-unexported gaps, full workspace and
browser-harness typecheck, the production build, all browser-isomorphism
entrypoints, extension/browser output integrity, the complete feature manifest
and packed Chromium run, direct/background archive/report parity, the package
tarball gate, and real Bun/filesystem-link/plain-Node packed-consumer exports.
The matrix now records 58 of 84 rows closed and 26 open; the unrestricted suite
remains the remote-CI gate.

Completed link-mark follow-on evidence recorded on 2026-07-23: the complete
pinned ADF `link` attribute set (`href`, optional `title`, `id`, `collection`,
and `occurrenceKey`) now survives the neutral model and composition. Safe page
and attachment links retain their exact source href as the single-page or
out-of-scope fallback while composed in-scope pages still prefer collision-safe
internal anchors. Text, resolved images, unresolved media labels, inline media
labels, and `mediaSingle` container links are clickable in both DOCX and PDF;
DOCX additionally projects `title` as a ScreenTip. Unsafe schemes remain visible
plain content with the shared warning policy. Smart-card appearance/enrichment
is deliberately not claimed by this mark-level slice and remains in the three
separate card rows. The matrix now records 59 of 84 rows closed and 25 open.

Completed Smart Card follow-on evidence recorded on 2026-07-23: `inlineCard`,
`blockCard`, and `embedCard` now decode into a public target-neutral Smart Card
contract rather than ordinary links or paragraphs. The bounded validator
accepts and checks every pinned union variant, including strict datasource
envelopes and embed layout/geometry. Exact URL, local identity, schema-opaque
`data`/`datasource` JSON, layout, width, and original dimensions survive;
visible titles are derived only from retained data fields already present in
ADF. Safe targets use the shared scheme policy and composition registry, while
unsafe URLs remain visible metadata without becoming clickable.

DOCX renders inline cards as link chips and block/embed cards as bordered
static panels; Typst/PDF provides the corresponding inline chip and bordered
block projection. Supported datasource providers enter the existing bounded
macro-resolution chain and retain the full static card as their offline,
disabled, or failed-resolution body. Unknown providers stay as typed static
cards with the existing datasource diagnostic. No renderer executes opaque
provider data or invents thumbnail/icon fetches absent from the pinned schema.
Direct validation/decoder/composition and both renderer suites cover all
variants, and the packed browser fixture carries inline, block, datasource,
and embed semantics through direct/background parity. The focused slice ran
322 tests with zero failures, followed by full workspace/browser typecheck,
the 16-package production build, all 20 browser-isomorphism entrypoints,
extension/harness output integrity, the 15-case manifest, packed Chromium E2E,
direct/background parity, public API/closure checks with zero reachable gaps,
pack inspection, and real tarball/filesystem-link/plain-Node/Vite consumers.
The reviewed render baseline contains one DOCX and five PDF pages; a second
render reproduced it with zero mean pixel difference and content-bounds IoU 1.
The retained anonymized two-page live tree also re-exported through the built
CLI to DOCX and PDF with both source pages, no Storage fallback, a packaged
DOCX code font, and a structurally valid multipage PDF. No live identifier is
stored in the repository. The matrix now records 63 of 84 rows closed and 21
open; the unrestricted suite remains the remote-CI gate.

Completed block-media follow-on evidence recorded on 2026-07-23: the pinned
`media`, `mediaGroup`, `mediaSingle`, and `border` contracts now retain their
exact file/link/external union, Media Services and local identity, opaque data,
alt text, intrinsic dimensions, annotations, authored layout/width/width type,
captions, safe links, borders, and group position. The bounded Confluence v2
attachment index carries exact `fileId`, filename, MIME type, UI link, and
download link metadata. Correlated images enter the existing asset pipeline;
correlated non-images—including audio/video—become named clickable static
attachment cards; unresolved identities remain visible and never trigger
filename/content-ID guessing. The pinned schema and official media contract
contain no crop attribute, so no exporter-side crop syntax is invented.

DOCX uses authored dimensions and native inline or anchored square-wrap
drawings. PDF uses authored sizing/alignment and, for wrap-left/right plus a
directly following paragraph, a source-ordered side-by-side grid. This is the
strongest deterministic projection supported by the selected Typst engine,
whose placement contract has top/bottom floats but no contour text wrapping;
a visually rejected float implementation was removed because it could move
media ahead of earlier headings. Block/group/single/border semantics are
therefore closed.

The slice passed the 456-test focused validator/decoder/composition/CLI/DOCX/PDF
set, the exact progress-register guard, fresh public API and closure generation
with zero reachable-but-unexported gaps, full workspace/browser typecheck, the
16-task production build, all 20 browser-isomorphism entrypoints, extension and
harness output checks, the 15-case manifest, packed Chromium E2E, and exact
direct/background report and artifact parity. Pack inspection plus Bun
tarball/filesystem-link, plain-Node/npm, and Vite consumers passed. The reviewed
real-render baseline contains one DOCX and five PDF pages; the repeat render
has zero mean pixel difference and content-bounds IoU 1, and visual inspection
confirms source order, bounded wrap approximation, borders, group boundaries,
captions, file/link fallbacks, and inline chips. The retained persistent live
tree re-exported through the built TypeScript CLI to structurally valid DOCX
and tagged PDF; temporary artifacts were removed and no environment identifier
was emitted or stored. The matrix then recorded 67 of 84 rows closed and 17 open;
the unrestricted suite remains the remote-CI gate.

Completed inline-media follow-on evidence recorded on 2026-07-23: correlated
ADF `mediaInline` images now reuse the bounded, deduplicated image resolver in
both TypeScript engines. DOCX emits a drawing run inside the surrounding
paragraph, including authored dimensions, alt text, safe hyperlink, and
picture-shape border/alpha; raster and SVG-plus-PNG-fallback paths are both
covered. PDF preparation resolves inline assets recursively in paragraphs,
links, and captions, shares byte deduplication and budgets with block images,
and serializes a baseline-aligned Typst box/image at the exact inline position.
Fetch/decode failures retain the typed bordered chip and shared diagnostic.

Focused renderer/export tests, full workspace typecheck, the production browser
build, exact direct/background PDF and DOCX artifact/report parity, and packed
Chromium E2E passed. A persistent runtime-only live page with a real uploaded
attachment and materialized `mediaInline` ADF exported through the TypeScript
CLI to both formats; DOCX inspection proved inline drawing geometry and border,
and the PDF was structurally valid. The live resource remains in the existing
test tree, while temporary local artifacts were removed and no environment
identifier was stored. The matrix now records 69 of 84 rows closed and 15 open;
the unrestricted local suite passed after the earlier code-block slice's
compiler assertion and intentional PDF digest were brought in sync with its
scoped `raw.line` output. The opt-in registry-backed consumer/install matrix
remains a remote-CI gate.

Completed data-consumer follow-on evidence recorded on 2026-07-23: the pinned
`dataConsumer` mark is now validated only as its exact non-empty ordered
string-array contract and retained, without flattening mark boundaries, on the
shared media identity consumed by CLI and browser hosts. The mark is permitted
only on its schema-defined `media` and `mediaInline` placements. DOCX and PDF
deliberately publish neither the product-internal binding nor its opaque source
IDs; a bounded source-located degradation note explains that policy without
echoing identifiers.

Direct schema/decoder fixtures, composition-preserving model shapes, DOCX and
PDF non-publication assertions, ADF browser direct/background parity, and the
packed Chromium case cover the contract. Re-rendering the one-page DOCX and
five-page PDF golden corpus produced zero mean pixel difference and
content-bounds IoU 1, proving the newly retained non-visual provenance did not
alter published content. The matrix now records 70 of 84 rows closed and 14
open.

Completed synced-content follow-on evidence recorded on 2026-07-23: the pinned
reference-only `syncBlock` and embedded `bodiedSyncBlock` contracts now validate
their required resource/local identities, exact child rules, and schema-valid
breakout mark. The neutral model retains those opaque IDs, the static projection
kind, embedded snapshot blocks where available, and breakout intent through
composition and direct/background source resolution. A bodied node exports its
embedded ADF snapshot in a labeled callout; a reference-only node exports a
deterministic unavailable-content callout because neither the pinned document
nor the official public ADF structure contract provides a synchronization
resolver. Neither TypeScript target publishes the opaque identifiers.

Focused validator/decoder/composition/DOCX/PDF tests, full typecheck, the
production build, public API/closure generation, browser unit/output/manifest
gates, exact CLI/browser direct/background parity, and packed Chromium E2E
passed. The reviewed real-render baseline contains two DOCX and five PDF pages:
the added DOCX page keeps the two sync projections together instead of splitting
the preceding code block, while the PDF keeps both page-bounded callouts after
the code. A second LibreOffice and Typst/Poppler render reproduced every page
with zero mean pixel difference and content-bounds IoU 1. The unrestricted
workspace suite then passed with 5,016 tests, 13 intentional skips, and zero
failures. The matrix now records 72 of 84 rows closed and 12 open.

Completed breakout follow-on evidence recorded on 2026-07-23: the validator and
decoder now cover every placement admitted by the pinned schema—root
`codeBlock`, root `expand`, `layoutSection`, `syncBlock`, and
`bodiedSyncBlock`—with exact `wide`/`full-width` mode and optional numeric
width. The neutral blocks retain that intent through composition and identical
CLI/browser direct/background shapes. DOCX and PDF keep all visible content
inside their physical page instead of pretending to reproduce a wider editor
viewport, and a source-located `adf-mark-degraded` fact makes that target-owned
constraint explicit. Focused validator/decoder/composition/renderer tests,
typecheck, build, API/closure checks, browser gates, packed Chromium E2E, and
repeat-rendered goldens prove the complete static projection. Both reviewed
DOCX pages and all five reviewed PDF pages reproduced with zero mean pixel
difference and content-bounds IoU 1. The unrestricted workspace suite passed
5,020 tests with 13 intentional skips and zero failures. The matrix now records
73 of 84 rows closed and 11 open.

Completed fragment-provenance follow-on evidence recorded on 2026-07-23: every
pinned fragment placement now retains its exact ordered mark array, including
duplicates, required non-empty local identities, and exact optional names.
Inline, block, and bodied extensions plus tables preserve that product-owned
identity through decoding, composition, full PDF preparation, and identical
CLI/browser direct/background shapes. This slice exposed and fixed a real
PDF-preparation loss: unknown extension preparation previously retained only
visible body data and discarded neutral extension metadata.

The complete static policy is deliberately non-visual. The public ADF contract
does not declare fragment marks as user-authored hyperlinks or bookmarks, so
DOCX/PDF publish neither opaque IDs nor invented navigation. Instead, every
projection is source-located in the shared report; a consumed export-control
wrapper is reported explicitly rather than reassigning its fragment to an
unrelated child. Focused decoder/DOCX/PDF tests, typecheck, build, API/closure
checks, 74 browser unit cases, output/manifest gates, packed Chromium E2E,
exact artifact/report parity, and two repeat-rendered DOCX plus five PDF pages
passed. Both renders reproduced with zero mean pixel difference and
content-bounds IoU 1. The unrestricted workspace suite passed 5,022 tests with
13 intentional skips and zero failures. The matrix now records 74 of 84 rows
closed and 10 open.

Completed unsupported-ADF fallback follow-on evidence recorded on 2026-07-23:
direct `unsupportedBlock`/`unsupportedInline` nodes and legacy Storage
`ac:adf-node` wrappers now retain a typed source-representation record with
their exact node type, ordered structured attributes, and direct-ADF marks.
Block wrappers reuse the body-bearing neutral fallback without being treated as
macros; inline wrappers attach their ordered provenance stack to the first
owned text leaf so child marks and links remain intact. Empty or non-text
wrappers receive an explicit visible label.

Both TypeScript targets show the same unsupported-ADF label plus retained
content while keeping opaque attributes non-visual. The macro resolver
explicitly excludes these wrappers from live registry lookup. Focused ADF,
Storage, macro-resolution, DOCX, and PDF tests passed; full typecheck, 74
browser unit cases, production browser build/output/manifest gates, packed
Chromium E2E, and exact direct/background artifact/report parity passed. Two
DOCX and five PDF pages were visually reviewed without clipping, overlap, or
missing content; a repeat render produced zero mean pixel difference and
content-bounds IoU 1. The unrestricted workspace suite passed 5,027 tests with
13 intentional skips and zero failures. The matrix now records 75 of 84 rows
closed and 9 open.

Completed block/bodied-extension follow-on evidence recorded on 2026-07-23:
the implementation now applies Confluence's documented Forge identity mapping
at the narrow live-export boundary: ADF `localId` stays distinct from Storage
`macroId` in the neutral model, but the export-view port uses it as the Forge
macro ID. The previous WP6 conservative non-use of `localId` is thereby
superseded by current official REST documentation. Both direct `extension` and
`bodiedExtension` fixtures resolve Confluence's platform-rendered
`adfExport`/`export_view` result through the existing bounded HTML-to-block
converter. Successful resolution replaces the source fallback and reconciles
the pending diagnostic; missing, offline, unauthorized, or empty output keeps a
typed note and an explicit `[Extension: key]` label, followed by the preserved
rich/plain body where present. IDs and parameters remain non-visual.

CLI and browser now implement the same two-stage platform path: one memoized
page-level `export_view` batch first, then the documented versioned
single-macro conversion when that batch has no matching fragment. The resolver
passes the owning extension's source-page version through the shared port, so
included/child-page extensions cannot accidentally use the root version. Tests
pin both the exact CLI client delegation and the browser session adapter,
including precedence of resolver provenance over the browser host's version
lookup fallback. A failed single-macro conversion retains its detailed
degradation note as the sole terminal outcome; the placeholder floor no longer
duplicates that report entry.

Focused decoder, resolver, fixture, DOCX, and PDF tests passed, along with full
typecheck, production browser build/output/manifest gates, packed Chromium E2E,
and exact CLI/browser artifact/report parity. Two DOCX and five PDF pages were
visually reviewed without clipping, overlap, or missing content; a repeat
render produced zero mean pixel difference and content-bounds IoU 1. The
unrestricted workspace suite passed 5,034 tests with 13 intentional skips and
zero failures across 317 files. The matrix now records 78 of 84 rows closed and
6 open. Live paragraph-local
`inlineExtension` replacement remains a separate open slice because its async
result must not split the owning paragraph.

Completed inline-extension follow-on evidence recorded on 2026-07-23:
`resolveMacroBlocks()` now performs a second, paragraph-local resolution pass
after block macros settle. This ordering resolves inline extensions inside
visible retained macro bodies without calling the platform for body content
that a successful block renderer superseded. The pass uses only the registry's
platform catch-all, the documented Forge `localId`, and the exact owning
source-page version. It accepts only one non-empty paragraph with visible text;
multi-paragraph/block/empty output cannot split or reorder its owner and
therefore retains the exact authored text or deterministic label with one
source-located terminal note. Successful output replaces only the inline run,
keeps surrounding runs in the same paragraph, and transfers fragment
provenance to the first returned text leaf.

The shared deterministic conformance fixture now carries block, bodied, and
inline Forge extensions through both engines and both Bun/CLI and packed-browser
execution. It fails on a wrong page version, proves the inline fallback is gone,
and asserts that the DOCX keeps before/output/after in one paragraph; the same
resolved blocks compile to a tagged PDF and remain under byte/report parity.
The integrated 50-page M1 corpus was advanced to version 2 so this richer
fixture is part of its pinned product story; its block count, structural digest,
and explicit inline-output assertion now guard that intentional change. Focused
decoder/resolver/fixture/M1 tests, typecheck, production build, all 20 browser
entrypoints, extension/harness output gates, packed Chromium E2E, exact
artifact/report parity, pinned-schema consistency, and repeat-rendered DOCX/PDF
goldens passed. The unrestricted workspace suite passed 5,039 tests with 13
intentional skips and zero failures across 317 files.
Completed annotation-output follow-on evidence recorded on 2026-07-23:
ADF annotation IDs are now joined to Confluence v2 inline-comment resources
only through the documented `properties.inlineMarkerRef`. The export-specific
sidecar paginates roots and replies under explicit item/request budgets, carries
abort signals, and uses metadata-only API logging so comment bodies never enter
request logs. The neutral model retains body text, resolution status, creation
date, and replies while omitting author account IDs, comment resource IDs, and
opaque marker IDs from visible output.

TypeScript DOCX emits native, contiguous Word comment ranges, a deduplicated
`word/comments.xml`, and the required content-type and document relationship;
included pages share the same export-wide registry. Typst/PDF emits a numbered
range marker and deterministic static comments appendix. This is the complete
portable projection for the selected PDF engine: its public PDF API documents
PDF metadata/tagging/attachment capabilities but no text-comment annotation
primitive, so the static note is an intentional target contract rather than a
Partial. Missing correlation and truncated sidecars remain visible through
stable typed diagnostics.

Focused client privacy/pagination, decoder, DOCX archive, PDF source, real
Typst compiler, shared fixture, and packed-browser assertions cover this
contract. CLI page reads, tree/space walks, include-page decoding, browser
source resolution, and both output engines use the same resolver seam.
The unrestricted workspace suite passed 5,050 tests with 13 intentional skips
and zero failures across 317 files. The matrix at that checkpoint recorded
80 of 84 rows closed and 4 open.

Completed Stage-0 multi-bodied extension follow-on recorded on 2026-07-23:
the weekly watchguard detected `@atlaskit/adf-schema@56.1.15`; reviewed package
artifacts proved its stable `full.json` is semantically byte-identical to the
previous pin while `stage-0.json` contains exact `multiBodiedExtension` and
`extensionFrame` definitions linked by the official ADF structure index. The
pin now records and independently drift-checks those two definitions without
inflating the 43-node stable inventory.

The bounded validator enforces root/parent placement, exact attributes, marks,
and child families. The neutral model retains ordered frame boundaries,
extension identity, parameters, fragment/data-consumer provenance, body-local
diagnostics, and complete visible bodies. Macro renderers receive a flattened
compatibility body in source order; unresolved DOCX and PDF projections retain
explicit `Frame N` boundaries without publishing opaque identifiers. Direct
decoder, macro resolver, DOCX, PDF, packed-browser direct/background, real
Typst, and rendered-golden gates cover the same contract.
The unrestricted workspace suite passed 5,056 tests with 13 intentional skips
and zero failures across 317 files; the production Chromium conformance case,
all 20 browser-isomorphism entrypoints, full typecheck, and the complete
workspace build also passed.

The matrix now records 82 of 84 rows closed and 2 open. Both remaining rows
share one external dependency: custom-emoji assets and complete emoji glyph
coverage require a documented, authorized Atlassian resolver contract.

## 14. Resolved rollout decisions and unresolved question

Resolved in the implementation:

- CLI ADF-primary enablement is independent from the background host and is already guarded by its own live, browser, renderer, Storage-regression, and rollback gates.
- The correctness-first ADF plus Storage-sidecar dual read is accepted for the first rollout under the measured request, wall-time, memory, diagnostic, and artifact budgets; lazy sidecars remain a post-stable-release optimization.
- Unsupported ADF variants remain visible fallbacks plus bounded notes. Public
  neutral-model variants are added only for pinned, target-relevant semantics;
  Smart Cards are the first completed example after the initial decoder wave.
- The profile's explicit deployment type is authoritative for Data Center, which never probes the Cloud ADF endpoint.
- `ATLCLI_EXPORT_SOURCE` is an operational host/deployment rollback variable, not a durable request-v1 field or renderer fork.

Still unresolved for review:

1. Should confirmed semantic drift additionally create/update one deduplicated `adf-schema-drift` issue, or are the failed scheduled run, Actions notification, job summary, and retained artifacts sufficient for the first version?

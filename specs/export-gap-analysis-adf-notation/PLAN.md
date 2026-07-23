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
- The pinned schema baseline in the gap analysis is `@atlaskit/adf-schema@56.1.13`, containing 43 semantic nodes and 17 marks.
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
- Converting the legacy Python/docxtpl DOCX engine; it remains Storage-based.
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
- Containers: `panel`; `expand`/`nestedExpand` with visible title/body approximation where the existing model permits it.
- Inline: `date`, `emoji`, `mention`, `status` with deterministic visible fallbacks for unresolved external data.
- Cards: `inlineCard`, `blockCard`, `embedCard` as safe clickable URL/title fallbacks until native card appearance is modeled.
- Extensions: `extension`, `inlineExtension`, `bodiedExtension` projected into the existing macro-resolution contract when identity correlation is proven.
- Media: `mediaSingle`, `mediaGroup`, and `media` only after Media-ID/attachment correlation is proven; otherwise visible fallback plus `adf-media-unresolved`.
- Existing marks: `strong`, `em`, `underline`, `strike`, `code`, `subsup`, `textColor`, `backgroundColor`, and `link`.

### 5.2 Explicitly classify, preserve, and defer native rendering

The remaining schema rows—including decisions, block tasks, layouts, native captions, advanced media, sync content, placeholders, annotation, alignment, indentation, breakout, border, data-consumer, fragment, and font-size semantics—must receive a coverage-manifest status and deterministic fallback. Native fidelity work remains in the prioritized backlog in the gap analysis.

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
- Delete live test pages/resources after E2E runs.
- Never correlate by document position such as “the nth macro” or “the nth image”.
- If a stable identity mapping cannot be proven, keep that feature behind a visible fallback and do not enable its ADF-native resolver by default.

Exit criteria:

- ADF and metadata/Storage version equality is verified or a typed race is returned.
- Macro identity is either deterministic or explicitly unsupported.
- Media identity is either deterministic or represented by a new neutral source variant supported by both engines.
- No test uses a customer document as a fixture.

## 7. Implementation work packages

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
- [x] tables including spans, background, widths, and dropped ADF-only attributes;
- [x] safe/unsafe external, page, attachment, anchor, and card links;
- [x] Unicode emoji, missing text, custom emoji, and literal colon text;
- [x] user/team/unresolved mentions;
- [x] known, unknown, bodied, and inline extensions;
- [x] media with correlated and uncorrelated IDs;
- [x] unknown block/inline/mark with visible fallback and provenance;
- [x] deterministic output independent of object key order.

Exit:

- A valid ADF document always produces typed blocks or an explicit visible degradation; no schema row silently disappears.

Evidence recorded on 2026-07-22: `adfToBlocks()` decodes the pinned schema-valid feature fixture and has an exhaustive implementation mode for all 43 nodes and 17 marks. Focused tests cover native mappings, visible fallbacks, marks, source paths, Storage-compatible export controls, links, tables, emoji, mentions, extensions, correlated/unresolved media, deterministic ordering, and diagnostic caps. The complete repository suite passed with 4,740 tests, 13 intentional skips, and zero failures; public API/closure guards, pinned-coverage guard, existing Storage walker/composition/mention regressions, full typecheck, browser-isomorphism, and the full build passed as well. An anonymized live create/read/decode/cleanup probe confirmed ADF-primary input, literal colon-text preservation, inline-code marks, and complete cleanup; the live creation route did not materialize a standalone emoji node, so that node remains proven by the pinned schema-valid fixture rather than the live probe.

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
- [x] Leave the Python/docxtpl path explicitly on `storageToMarkdown()`.
- [x] Preserve mention, macro, asset, report, strict-mode, and output behavior after the parser boundary.

Tests:

- [x] existing CLI engine parity tests with paired ADF input;
- [x] CLI PDF page/tree/space integration tests;
- [x] DOCX export/include/resolver/macro-wiring tests;
- [x] `--keep-ignored`, strict/partial, mention, image, and macro cases;
- [x] assertions that precomposed ADF blocks bypass the DOCX engine Storage walker;
- [x] report assertions for fallback/degradation and page provenance.

Exit:

- Cloud CLI TypeScript DOCX and PDF are ADF-primary with no regression in Storage/Data Center or the legacy Python path.

Evidence recorded on 2026-07-22: single-page and tree/space CLI paths now select the version-bound export source and decode it before either renderer; the TypeScript DOCX engine receives precomposed blocks, while its public Storage fallback and the legacy Python path remain unchanged. Include-page lookup now carries the additive export source, caches neutral `BlocksResult` values, and accounts for primary-body and Storage-sidecar bytes independently. Focused tests prove ADF-primary PDF and DOCX source selection, ADF export-control passthrough, poisoned-sidecar avoidance, representation-neutral includes and budgets, report provenance, and existing macro/mention/image/strict-mode parity. Public API and closure reports show the additive include type with no reachable-but-unexported gaps. Full typecheck, the production build for all 16 packages, and the unrestricted complete repository suite passed; the latter covered 4,762 tests with 13 intentional skips and zero failures across 305 files. An anonymized live create/export/cleanup test confirmed a real ADF source with an inline-code mark, ADF-primary CLI DOCX and PDF without a Storage fallback note, DOCX monospace styling, a tagged PDF with embedded fonts, and complete cleanup of its sole temporary page.

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
- [ ] Keep `ExportJobRequestV1.source` as locator/scope/version metadata only; do not add `bodyFormat`, raw ADF, or Storage.
- [ ] Make ADF-primary a resolver policy selected by deployment capability, not a user-controlled request-v1 field.
- [ ] Run fetch, validation, decode, sidecar reads, tree composition, mention/macro resolution, and asset preparation inside background `resolveInput`.
- [ ] Use the ordered source/checkpoint pipeline for tree/space pages rather than buffering raw full-tree ADF.
- [ ] Pin/verify page versions so pre-checkpoint retry cannot silently export newer content.
- [ ] Ensure the ready-to-render checkpoint contains prepared engine state and diagnostics, not the original page body.
- [ ] On ready-to-render recovery, perform zero ADF/Storage refetches.
- [ ] Thread job cancellation through every ADF, sidecar, macro, attachment, and identity request.
- [ ] Preserve ADF degradation notes and `complete=false` through preparation, checkpoint fingerprinting, report staging, and final activity UI.
- [ ] Keep page content out of job progress/events and error summaries.
- [ ] Reuse the same shared composition helper in direct and background paths; no extension-only ADF decoder.

Required job tests:

- [ ] job row exists before first ADF GET;
- [ ] cancellation during ADF and sidecar reads aborts all outstanding requests;
- [ ] crash before ready-to-render refetches only version-pinned source;
- [ ] crash/recovery after ready-to-render performs no source reads;
- [ ] direct-vs-job blocks/notes/completeness and final PDF/DOCX report parity;
- [ ] panel closure/navigation does not abort the job;
- [ ] malformed ADF fails or becomes a partial page according to completeness mode, never Storage-hidden success;
- [ ] bounded page pipeline does not retain complete raw tree bodies;
- [ ] packed browser consumer imports the ADF adapter without Node/Bun/dynamic-code leakage.

Current sequencing status (2026-07-22): WP8 remains intentionally open until the evolving background-export branch is synchronized onto this source boundary. This main-based branch does not duplicate, amend, or guess that runtime's durable request, checkpoint, executor, or activity contracts. All ADF work upstream of `resolveInput()` and all direct CLI/browser renderer gates are complete; the unchecked tasks in this WP are the remaining integration contract.

Exit:

- The background host owns the complete source-to-artifact lifecycle, while the job executor and render engines remain ADF-agnostic.

### WP9 — Conformance, rollout, and default switch

Tasks:

- [x] Add one browser conformance case that begins with real ADF, not hand-built blocks.
- [x] Run paired ADF/Storage semantic differential tests for the feature zoo.
- [x] Run the weekly read-only observed-Cloud structural inventory against retained synthetic feature-zoo pages and compare it with both the pinned and currently discovered schema.
- [x] Add DOCX OOXML and PDF/Typst assertions where source fidelity affects output.
- [x] Add rendered goldens for inline code, emoji/custom emoji fallback, tables, layout degradation, cards, media, and extensions where applicable.
- [x] Run the live Cloud E2E for PDF and TypeScript DOCX and clean up test resources.
- [x] Run Data Center/Storage regression coverage or the available Storage compatibility harness.
- [x] Measure requests/page, wall time, peak memory, block count, note count, and artifact parity on page/tree/space fixtures.
- [x] Ship ADF-primary behind one export-source feature flag until the gates below pass.
- [x] Make rollback switch representation choice at the source adapter; do not fork render engines.
- [ ] After one stable release window, plan lazy Storage-sidecar reads as a separate optimization.

Partial WP9 evidence recorded on 2026-07-22: the packed browser harness now owns a real ADF-primary case that invokes the production representation dispatcher before either renderer. It proves target-neutral blocks and diagnostics, then structurally asserts DOCX inline-code font treatment, Unicode emoji, tables, local Smart Link title/target, extension body, and visible unresolved-media content; the PDF output passes tagged-document validation. The production browser build, output-integrity check, manifest drift guard, focused fixture test, browser-harness typecheck, and the complete 15-case Playwright conformance run passed.

Rollout evidence recorded on 2026-07-22: `ATLCLI_EXPORT_SOURCE` is parsed once into a host-owned source policy and is not part of the durable request model. Cloud defaults to `adf`; `storage` performs only the versioned Storage read and emits the existing `adf-storage-fallback` diagnostic before entering the unchanged neutral dispatcher/renderers. Invalid values fail closed. Client, dispatcher and CLI source tests, public API/closure checks, full typecheck, the 20-entrypoint isomorphism gate, documentation validation, and the production build passed. An anonymized live create/export/cleanup run proved the same rollback flag through real TypeScript DOCX and tagged-PDF artifacts, visible fallback diagnostics in both reports, and complete cleanup.

The unrestricted full regression suite then passed with 4,774 tests, 13 intentional skips and zero failures across 306 files. This includes the dedicated Data Center no-v2-read contract and the complete existing Storage walker, renderer, scope, macro, include, asset and report corpus.

Direct-coverage evidence recorded on 2026-07-22: an exhaustive compile-time fixture map now has one real ADF document per pinned node and mark row. Child-only nodes are exercised in their smallest meaningful parent context; every case passes through the production validator/decoder, must produce visible blocks, and every `visible-fallback` mapping must emit a diagnostic with page/path provenance. The guard covers exactly 43 nodes and 17 marks, so adding or removing an upstream classification fails until the direct fixture set changes deliberately. All 61 direct-fixture assertions passed.

Differential evidence recorded on 2026-07-22: the paired ADF/Storage semantic feature zoo covers headings, inline bold/code/line-break/emoji semantics, blockquotes, bullet and ordered lists, task state, table spans/background, panels, status and rules. Both source adapters produce byte-for-byte equal neutral block trees with the expected ten-block shape. The only note difference is explicitly allowlisted to ADF's observable non-default ordered-list start, with page and block-path provenance.

Observed-Cloud evidence recorded on 2026-07-22: the weekly optional job now accepts up to 16 retained feature-zoo pages through a secret-only list, aggregates their structural signatures, and fully validates each ADF document against both the committed schema pin and the package schema discovered in that run. Focused tests proved multi-page aggregation, independent current-schema constraint drift, bounded configuration, backwards-compatible skip behavior, and absence of raw content, page references, credentials, and tenant origin from reports. A sanitized live run created one marked temporary feature-zoo page, observed 11 node types and two mark types with `no-drift`, passed both schema validators, and deleted the page with zero cleanup failures. Full build, typecheck, docs, API/closure, browser-isomorphism, browser-output and offline pin gates passed; the complete repository suite passed with 4,838 tests, 13 intentional skips and zero failures across 307 files.

Rendered-golden evidence recorded on 2026-07-22: one synthetic ADF feature zoo now renders through the production decoder and both real export engines, then through LibreOffice/Poppler rasterization. The reviewed references cover inline code, Unicode and unresolved custom emoji, a panel, table, flattened layout, local card link, expand, extension fallback/body, and media fallback/caption. A source hash prevents fixture changes from silently reusing old references; PNG hashes, required extracted text, page counts, normalized pixel difference, and content-bound overlap guard every rerender. The review exposed and fixed a real PDF missing-glyph defect by adding a pinned, checksummed OFL symbol fallback to every Typst text role and both curated template font contracts. The canonical DOCX renderer and all five reference pages were inspected with no clipping, overlap, tofu glyphs, or hidden fallback text. CLI, packed harness, and extension asset-parity gates proved that the font is present in every runtime, while the complete browser conformance run and an anonymized live ADF-primary DOCX/PDF create-export-cleanup run proved both engines end to end.

Rollout-benchmark evidence recorded on 2026-07-22: a deterministic paired ADF/Storage corpus now exercises page, 25-page tree, and 25-page space scopes through the production source dispatcher, tree orchestration, composition, DOCX, and Typst/WASM PDF. Logical request accounting mirrors the production adapter and proved the correctness-first dual read adds exactly one body request per page: page 2.00 to 3.00 requests/page, tree 3.04 to 4.04, and space 3.08 to 4.08. The synthetic body transfer rose from 869 to 3,392 bytes/page because the 2,523-byte ADF body accompanies the Storage sidecar. With five in-process source samples inside each of three complete process samples, median local source/decode/compose time on Bun 1.3.14 arm64 was 0.2 to 0.3 ms for page, 1.7 to 2.4 ms for tree, and 1.6 to 2.1 ms for space. Median whole-process BSD-time peak RSS, including both render engines, compiler, fonts, and fixture setup, was effectively flat: 377/377 MiB, 491/497 MiB, and 490/494 MiB respectively. Raw blocks stayed 10/page, the expected observable ordered-list diagnostic was 1/page only on ADF, normalized DOCX part hashes matched in every process sample, and PDF bytes matched exactly for every scope. The fail-closed guard now requires exact +1 request/page, exact block/artifact and expected-note parity, ADF source wall time no greater than `2 × Storage + 1 ms`, and no more than 32 MiB added median peak RSS when the platform exposes RSS.

Default-enable gates:

- [x] all 43 nodes and 17 marks classified in the coverage manifest;
- [x] every mapped row has a direct ADF fixture;
- [x] no silent node/mark/attribute drops;
- [x] no silent whole-page decoder fallback;
- [x] macro and media correlation gates pass or remain visibly degraded;
- [ ] direct and background report parity passes;
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

Before any commit that changes production behavior, run the repository-required live E2E against the configured test profile/space and remove created pages/attachments afterwards. Documentation-only plan changes require `git diff --check`; they do not claim runtime test coverage.

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
- mention account/team identity;
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
- [x] Data Center and legacy/Python paths remain Storage-based.
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
- [ ] Ready-to-render recovery performs no source refetch.
- [ ] Direct/background notes, completeness, report, and artifact parity gates pass.
- [x] Browser/package/API/closure/full-suite/live-E2E gates pass.
- [x] Created E2E resources are deleted.
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

After this migration proves the source boundary, close the gap-analysis backlog in separate feature slices:

1. inline-code visual treatment and emoji/custom-emoji assets;
2. paragraph alignment, indentation, font size, annotation, and fragment marks;
3. decisions, block tasks, ordered-list starts, and richer task metadata;
4. table layout/display/number-column/vertical-alignment attributes;
5. layout columns, breakout, captions, and nested expands;
6. full card/embed/media family;
7. ADF-native definitions for excerpts/Page Properties and removal of their Storage sidecar;
8. advanced extensions, Forge `adfExport` ingestion policy, and synced-content snapshots;
9. lazy sidecar reads and eventual Storage removal from Cloud export only after every dependency is retired.

## 14. Resolved rollout decisions and unresolved question

Resolved in the implementation:

- CLI ADF-primary enablement is independent from the background host and is already guarded by its own live, browser, renderer, Storage-regression, and rollback gates.
- The correctness-first ADF plus Storage-sidecar dual read is accepted for the first rollout under the measured request, wall-time, memory, diagnostic, and artifact budgets; lazy sidecars remain a post-stable-release optimization.
- Unsupported ADF variants remain visible fallbacks plus bounded notes in this wave; no speculative public neutral-model variants were added.
- The profile's explicit deployment type is authoritative for Data Center, which never probes the Cloud ADF endpoint.
- `ATLCLI_EXPORT_SOURCE` is an operational host/deployment rollback variable, not a durable request-v1 field or renderer fork.

Still unresolved for review:

1. Should confirmed semantic drift additionally create/update one deduplicated `adf-schema-drift` issue, or are the failed scheduled run, Actions notification, job summary, and retained artifacts sufficient for the first version?

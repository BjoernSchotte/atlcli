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
- [ ] Pin the exact ADF schema snapshot/hash used by fixtures and the coverage manifest.
- [ ] Record the live-correlation results from section 6 without including unrelated page content.
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

- [ ] Check UTF-8/input byte length before `JSON.parse`.
- [ ] Validate `type: "doc"`, supported ADF document version, and root content.
- [ ] Walk nodes/marks iteratively and enforce all `AdfParseBudget` dimensions.
- [ ] Reject dangerous/non-plain attribute structures and prototype-polluting keys.
- [ ] Validate known node/mark shapes needed by the decoder.
- [ ] Preserve unknown type names as drift while rejecting malformed shapes.
- [ ] Generate or verify a coverage row for every pinned-schema node and mark.
- [ ] Distinguish `schema-only`, `observed-cloud`, and `legacy-observed` fixture provenance.
- [ ] Benchmark realistic and adversarial documents before fixing default budgets.
- [ ] Store the reviewed schema's versioned URL, package version, npm integrity, raw/canonical hashes, node/mark inventories, and per-definition hashes in `upstream-baseline.json`.
- [ ] Make the ordinary PR/release check consume only committed snapshots and baselines; it must make zero network calls.
- [ ] Implement `adf-drift.ts check-pinned` for the deterministic offline relation: snapshot -> hashes/inventory -> coverage manifest -> fixtures.
- [ ] Implement `adf-drift.ts check-upstream` for the online watchguard without mutating tracked files.
- [ ] Make candidate baseline/schema updates an explicit local `update-candidate` operation whose diff must be reviewed and committed by a developer.

Required tests:

- [ ] minimal valid document;
- [ ] invalid JSON/root/version/node/mark shapes;
- [ ] max input, node, depth, text, attribute, and diagnostic budgets;
- [ ] deeply nested document without call-stack overflow;
- [ ] unknown node, mark, and attribute drift;
- [ ] `__proto__`, `constructor`, cycles supplied as object input, and non-finite numbers;
- [ ] all pinned 43 nodes and 17 marks classified exactly once;
- [ ] schema update produces a failing coverage diff.
- [ ] raw formatting-only schema changes are distinguished from canonical semantic changes;
- [ ] modified definitions/constraints are detected even when node and mark counts stay unchanged;
- [ ] redirect/package/CDN disagreement is reported as propagation mismatch;
- [ ] the online checker cannot write a new baseline or tracked schema snapshot.

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

Alerting v1 is the failed scheduled Actions run plus its job summary/artifacts. A deduplicated GitHub issue may be added later behind an explicit repository decision; the schema monitor itself starts with `contents: read` only.

Exit:

- Untrusted ADF cannot reach recursive decoders without bounded, validated structure; pinned-schema inconsistency cannot pass normal CI; and new upstream or observed-Cloud drift produces a weekly actionable report without blocking delivery.

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

- [ ] Implement `adfToBlocks(raw, options)` on validated ADF.
- [ ] Preserve `exporter`, `exportControls`, `pageContext`, source paths, and notes behavior from the Storage adapter.
- [ ] Implement the mappings in section 5.1.
- [ ] Preserve visible child content for unsupported block and inline nodes.
- [ ] Add reviewed generic unsupported variants only if an existing type cannot express a safe visible fallback.
- [ ] Sanitize links through the existing central safe-link policy.
- [ ] Normalize marks deterministically; mark-array order must not change output semantics.
- [ ] Keep literal editor shorthand as ordinary text.
- [ ] Map ADF extensions to existing `unknown` macro blocks with structured parameters, recursive body, `sourcePage`, and identity fields only after correlation is proven.
- [ ] Map media to the existing attachment source only after stable ID-to-attachment resolution; otherwise emit a visible fallback.
- [ ] Cap, deduplicate, and summarize degradation diagnostics.
- [ ] Add note codes and cross-engine traversal/report coverage.

Required semantic cases:

- [ ] nested marks, code identifiers, whitespace, punctuation, and final newline;
- [ ] H1–H6, mixed/nested lists, task state, and non-1 ordered-list approximation note;
- [ ] tables including spans, background, widths, and dropped ADF-only attributes;
- [ ] safe/unsafe external, page, attachment, anchor, and card links;
- [ ] Unicode emoji, missing text, custom emoji, and literal colon text;
- [ ] user/team/unresolved mentions;
- [ ] known, unknown, bodied, and inline extensions;
- [ ] media with correlated and uncorrelated IDs;
- [ ] unknown block/inline/mark with visible fallback and provenance;
- [ ] deterministic output independent of object key order.

Exit:

- A valid ADF document always produces typed blocks or an explicit visible degradation; no schema row silently disappears.

### WP4 — Common dispatcher and differential fixtures

Production files:

- `packages/confluence/src/page-body.ts`
- `packages/confluence/src/index.browser.ts`

Tests/fixtures:

- new `packages/confluence/src/page-body.test.ts`
- paired ADF/Storage fixtures under `packages/export-fixtures/` or the Confluence package fixture directory

Tasks:

- [ ] Implement exhaustive `pageBodyToBlocks()` dispatch.
- [ ] Pass representation-specific budgets and common walker options correctly.
- [ ] Preserve the existing Storage output byte-for-byte/structurally for unchanged fixtures.
- [ ] Attach fallback notes only when the source was explicitly constructed as Storage-primary due to capability/deployment.
- [ ] Compare paired ADF and Storage projections at `ExportBlock`/note/provenance level.
- [ ] Keep an allowlist of intentional representation differences linked to exact gap-analysis rows.

Exit:

- Hosts no longer choose a parser directly; they provide an `ExportPageSource` and receive one neutral result contract.

### WP5 — Representation-neutral tree/source orchestration

Production files:

- `packages/confluence/src/tree-fetch.ts`
- extension/CLI tree adapters only as needed to satisfy the compatible port

Tasks:

- [ ] Extend `TreeSourcePage` additively to accept `ExportPageSource` while retaining a Storage-only compatibility form during migration.
- [ ] Change the single body-walk site from `storageToBlocks(page.storage)` to `pageBodyToBlocks(source)`.
- [ ] Generalize Storage-specific result/error names at the orchestration boundary without removing the Storage error types.
- [ ] Route `AdfParseError` through the same strict/partial completeness policy as Storage parse-budget failure.
- [ ] Keep discovery, ordering, concurrency, labels, version checks, progress, cancellation, and composition unchanged.
- [ ] Aggregate representation counts/degradations without retaining raw bodies.
- [ ] Ensure a page-version change between discovery and ADF read produces the existing page-version failure.
- [ ] Bound simultaneous ADF + Storage sidecar reads under the existing page concurrency limit.

Tests in `packages/confluence/src/tree-fetch.test.ts`:

- [ ] ADF-only, Storage-only, and mixed representation sources;
- [ ] ADF strict/partial invalid and budget failures;
- [ ] page-version race;
- [ ] abort during ADF/sidecar read;
- [ ] deterministic preorder despite parallel dual reads;
- [ ] old Storage-only test sources remain valid during the compatibility window;
- [ ] page provenance survives notes, unknown extensions, images, and links;
- [ ] no body text appears in progress details.

Exit:

- Tree and space exports are source-representation-neutral without changing their ordering/completeness semantics.

### WP6 — CLI PDF and TypeScript DOCX

PDF production files:

- `apps/cli/src/commands/export-pdf.ts`

DOCX production files:

- `apps/cli/src/commands/export.ts`
- `apps/cli/src/commands/export-internals.ts`
- `packages/docx/src/export.ts`
- include-page loader/wiring in CLI and shared DOCX dependencies

Tasks:

- [ ] Use `getExportPageDetails()` and `pageBodyToBlocks()` for single-page PDF.
- [ ] Receive ADF automatically for tree/space PDF through the shared tree source.
- [ ] Use the same export-specific read and dispatcher for the CLI TypeScript DOCX prewalk.
- [ ] Continue passing precomposed blocks into `runExport()` so the engine does not re-walk Storage.
- [ ] Keep the engine-internal Storage fallback for external `@atlcli/docx` consumers.
- [ ] Convert include-page fetch/cache/walk to `ExportPageSource`/`BlocksResult`.
- [ ] Make include budgets representation-neutral and add a separate bounded sidecar allowance.
- [ ] Keep root/homepage Storage available for existing Page Properties/template resolvers in this wave.
- [ ] Replace raw-Storage Mermaid/image heuristics with block-derived inspection where practical; otherwise document their temporary sidecar dependency.
- [ ] Leave the Python/docxtpl path explicitly on `storageToMarkdown()`.
- [ ] Preserve mention, macro, asset, report, strict-mode, and output behavior after the parser boundary.

Tests:

- existing CLI engine parity tests with paired ADF input;
- CLI PDF page/tree/space integration tests;
- DOCX export/include/resolver/macro-wiring tests;
- `--keep-ignored`, strict/partial, mention, image, and macro cases;
- assertions that precomposed ADF blocks bypass the DOCX engine Storage walker;
- report assertions for fallback/degradation and page provenance.

Exit:

- Cloud CLI TypeScript DOCX and PDF are ADF-primary with no regression in Storage/Data Center or the legacy Python path.

### WP7 — Macro, media, card, emoji, and link parity gates

Production areas:

- `packages/export-macros/`
- `packages/export-wiring/src/ports.ts`
- CLI/extension macro and asset ports
- Confluence attachment and macro-body client methods

Tasks:

- [ ] Preserve `localId`, extension key, parameters, body, and source page separately; do not overload unproven IDs.
- [ ] Prove macro-body/export-view lookup from ADF identity before enabling it.
- [ ] Keep Storage-backed include/excerpt/multiexcerpt/Page Properties ports as sidecar consumers.
- [ ] Avoid whole-page Storage parsing for one unresolved extension.
- [ ] Resolve Media ID/collection to attachment metadata through a bounded, page-cached lookup.
- [ ] If filename mapping is not reliable, add an `ImageSource` Media-ID variant and update both asset pipelines before defaulting ADF media.
- [ ] Normalize ADF page links into typed `LinkTarget.page` so composed in-document links still become chapter anchors.
- [ ] Preserve card URLs and visible titles without requiring remote Smart Link metadata.
- [ ] Use ADF emoji `text` first; unresolved/custom emoji receives deterministic text/short-name fallback and a note.

Exit:

- Existing live macro and asset features do not regress merely because the page body source changed.

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

Exit:

- The background host owns the complete source-to-artifact lifecycle, while the job executor and render engines remain ADF-agnostic.

### WP9 — Conformance, rollout, and default switch

Tasks:

- [ ] Add one browser conformance case that begins with real ADF, not hand-built blocks.
- [ ] Run paired ADF/Storage semantic differential tests for the feature zoo.
- [ ] Run the weekly read-only observed-Cloud structural inventory against retained synthetic feature-zoo pages and compare it with both the pinned and currently discovered schema.
- [ ] Add DOCX OOXML and PDF/Typst assertions where source fidelity affects output.
- [ ] Add rendered goldens for inline code, emoji/custom emoji fallback, tables, layout degradation, cards, media, and extensions where applicable.
- [ ] Run the live Cloud E2E for PDF and TypeScript DOCX and clean up test resources.
- [ ] Run Data Center/Storage regression coverage or the available Storage compatibility harness.
- [ ] Measure requests/page, wall time, peak memory, block count, note count, and artifact parity on page/tree/space fixtures.
- [ ] Ship ADF-primary behind one export-source feature flag until the gates below pass.
- [ ] Make rollback switch representation choice at the source adapter; do not fork render engines.
- [ ] After one stable release window, plan lazy Storage-sidecar reads as a separate optimization.

Default-enable gates:

- [ ] all 43 nodes and 17 marks classified in the coverage manifest;
- [ ] every mapped row has a direct ADF fixture;
- [ ] no silent node/mark/attribute drops;
- [ ] no silent whole-page decoder fallback;
- [ ] macro and media correlation gates pass or remain visibly degraded;
- [ ] direct and background report parity passes;
- [ ] source bodies are absent from logs/job records/events;
- [ ] browser, Node/Bun, package, API, closure, and packed-consumer gates pass;
- [ ] Cloud live E2E passes for both target formats;
- [ ] Storage/Data Center regressions pass;
- [ ] dual-read request/latency overhead remains within the agreed budget.

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

- [ ] Cloud export-specific reads request and validate ADF without leaking it to logs.
- [ ] Data Center and legacy/Python paths remain Storage-based.
- [ ] ADF and Storage version races fail visibly.
- [ ] Runtime validator is bounded, iterative, isomorphic, and adversarially tested.
- [ ] Pinned schema/coverage CI classifies all 43 nodes and 17 marks.
- [ ] Weekly online schema/reference/REST drift watch runs independently of PR and release gates and produces JSON/Markdown evidence.
- [ ] Optional weekly observed-Cloud inventory uses synthetic read-only fixtures and publishes no page content.
- [ ] `adfToBlocks()` covers all semantics already representable by the neutral model.
- [ ] Unsupported semantics preserve visible content or a visible placeholder and emit bounded notes.
- [ ] `pageBodyToBlocks()` is the only representation dispatch used by new export hosts.
- [ ] Tree/page/space orchestration accepts mixed representation sources without ordering changes.
- [ ] CLI TypeScript DOCX and PDF are ADF-primary under the rollout flag.
- [ ] Includes, Page Properties, excerpts, and live macro/export-view behavior retain their Storage sidecar path.
- [ ] Macro and media identity is correlation-proven or visibly degraded.
- [ ] Background integration starts inside the durable job's `resolveInput()` and does not change request v1.
- [ ] Ready-to-render recovery performs no source refetch.
- [ ] Direct/background notes, completeness, report, and artifact parity gates pass.
- [ ] Browser/package/API/closure/full-suite/live-E2E gates pass.
- [ ] Created E2E resources are deleted.
- [ ] Coverage and user documentation are updated with the source flag, fallback policy, and known limitations.

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

## 14. Unresolved questions for review

1. Should the first production default enable ADF-primary for CLI before the extension background host, or must both switch in one release?
2. Is the initial correctness-first two-body-read policy acceptable for tree/space exports, provided request-count and latency gates are met, or must lazy Storage sidecars be part of the first release?
3. Should generic unsupported ADF block/inline variants become public `ExportBlock`/`InlineNode` members in this wave, or should the first adapter use existing visible fallback blocks plus notes and add public variants in the next model slice?
4. Which Data Center capability signal is authoritative in the current profile model, so the client can avoid probing a Cloud-only endpoint?
5. What quantitative rollout budgets should gate the default: maximum added requests/page, wall-time regression, peak memory, and diagnostic count?
6. Is a source-selection CLI/debug flag user-facing, or an internal rollout flag until ADF-primary becomes stable?
7. Should confirmed semantic drift additionally create/update one deduplicated `adf-schema-drift` issue, or are the failed scheduled run, Actions notification, job summary, and retained artifacts sufficient for the first version?

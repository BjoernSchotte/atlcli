# PDF Export — typst.ts in the Offscreen Document, atlcli Standard Template

Status: **Planned — implementation-ready after feasibility gates**

Spec ID: `007-pdf-export`
Depends on:

- `002-extension-workspace` Task 5 (offscreen WASM proof)
- `003-page-detection-read-path`
- `004-docx-export` (shared `ExportBlock` model, report and download lessons)
- `005-docx-image-module` (authenticated attachment pipeline)
- `005a-mermaid-diagrams` (`@atlcli/diagram` SVG renderer)
- `006-isomorphic-export-fup` (browser-safe walker and reusable export engine)

Handoff to: `008-export-poc-validation` (final cross-format quality and performance verdict)

Related strategy: FAHRPLAN Phase 1 Task 1.4 · `TYPST-EXPORT-ANGLE.md` §1b, §5.2, §7.5 Schritt 4 · `EXPORT-QUALITY-ANGLE.md` §3–§5, §7 (quality proofs 1+3)
Origin: FAHRPLAN Phase 1 — "PDF-Export"

---

## 1. Current baseline and objective

The DOCX path, authenticated image embedding, Mermaid-to-SVG rendering and the
isomorphic export engine are implemented. This spec adds the next output adapter; it
does not rebuild those capabilities.

PDF is the secondary export path, but the one with **visible world-class potential**:
compile the detected page via a pinned `typst.ts` browser compiler running outside the
panel thread, using an **atlcli-owned standard Typst template** with embedded open fonts.
PDF deliberately remains a standard-template path rather than a customer-template path.

The cheap-but-decisive quality proofs ship inside this spec:

- Mermaid diagrams embedded as native vector SVG through `@atlcli/diagram`;
- native Typst code highlighting without an additional highlighter;
- tagged, semantic PDF by default;
- one separately selected and independently validated PDF/UA-1 reference export, if the
  pinned browser compiler exposes the required standard option.

### Goals

- **Export as PDF** in the side panel: page → `ExportBlock[]` → prepared assets and
  Typst source → offscreen compiler worker → downloaded PDF.
- One atlcli `tech-doc` template: cover, TOC with computed page numbers, numbered
  headings, running chapter header, page-number footer, PDF outline/bookmarks and
  internal links.
- Preserve the existing export model: paragraphs, text marks, links, mentions,
  callouts, statuses, code, nested lists, task state, tables, images, blockquotes,
  dividers and documented fallback behavior for unsupported content.
- Bundle and embed pinned **Inter** 400/500/600 and **JetBrains Mono** 400/700 files.
  No system-font lookup and no runtime font, compiler or package download.
- Keep the panel responsive and expose job phases, diagnostics and a useful export
  report.
- Produce reproducible output from fixed inputs. Compiler, WASM, template, diagram
  renderer, fonts, locale, metadata and clock are explicit inputs.

### Non-goals

- No customer `.docx` or `.typ` template support and no PDF template upload.
- No corporate font upload or template/theme marketplace.
- No PDF/A claim or archival-conformance claim in this spec.
- No PDF-standard selection UI. Standard tagged output is the user path; PDF/UA-1 is a
  reference-validation mode.
- No multi-page/page-tree export and no PlantUML, draw.io or Gliffy embedding.
- No server or companion compiler and no CLI command in this spec. The serializer stays
  host-neutral so a CLI adapter can follow without redesign.

---

## 2. Fixed architecture decisions

### 2.1 Ownership boundaries

- New browser-safe workspace package: `packages/pdf` / `@atlcli/pdf`.
- `@atlcli/pdf` owns the PDF preparation types, Typst serializer, semantic template
  contract, source-map model and PDF-specific report model.
- `@atlcli/pdf` depends only on browser-safe packages, including `@atlcli/confluence`
  and `@atlcli/diagram`. `packages/confluence` does not gain presentation-format code.
- The extension owns authenticated asset resolution, job storage, compiler lifecycle,
  offscreen/worker integration and the browser download adapter.
- Fonts have one canonical, format-neutral repository location. Task 0 moves or exposes
  the already pinned files without duplicating them in DOCX and extension source trees;
  DOCX must remain green after the move.

### 2.2 Process and transport topology

```text
side panel                    service worker                 offscreen document
──────────                    ──────────────                 ──────────────────
walk page + prepare assets ─▶ create job in shared store ─▶ compiler host
send { jobId, inputKey }      route JSON control message     dedicated worker + WASM
receive phase updates     ◀── small JSON messages        ◀── init / compile / reset
read PDF Blob by resultKey ◀─ { jobId, resultKey, report }  write result to job store
download application/pdf
```

`chrome.runtime.sendMessage` is the **control plane only**. Runtime messages contain
JSON-safe, bounded values such as `jobId`, keys, phases, progress, diagnostics and
report summaries. They never contain `Map`, fonts, image bytes, source bundles or PDF
bytes.

Large inputs and outputs use a same-origin, job-scoped store accessible by the extension
contexts (IndexedDB is the default; Cache Storage is allowed only if Task 1 proves a
clearer lifecycle). Every record is keyed by an unguessable `jobId`, has a byte count and
creation time, and is deleted in `finally`, on timeout and by stale-job cleanup at
startup. The store defines per-file, per-job and total quotas and turns quota failures
into readable errors.

Static WASM, fonts and `atlcli.typ` load directly from packaged extension URLs inside the
offscreen context. They are initialized once and never copied through runtime messages.

### 2.3 Compiler lifecycle

The offscreen document is a lifecycle host. A locally bundled Dedicated Worker owns the
compiler and mutable virtual filesystem.

States: `closed → initializing → ready → running → resetting → ready`; any fatal init,
timeout or compiler failure transitions through `failed → closed` before retry.

Rules:

- Compiler initialization is single-flight.
- Compile jobs are FIFO with exactly one active job per worker until concurrency is
  explicitly proven safe.
- Fonts and compiler core initialize once; job sources and assets are mapped per job.
- Job shadows are reset before a job and in `finally`; one export cannot observe files
  from another export.
- A 60-second timeout terminates the worker, rejects the job, clears cached readiness
  state and creates a fresh worker for the next attempt. A Promise timeout alone is not
  considered cancellation.
- Idle teardown never closes an active or resetting job. Late responses are ignored by
  `jobId` and their stored results are deleted.
- Panel navigation or page changes invalidate the visible job without leaking its
  eventual result into the newly loaded page.

### 2.4 Network and privacy contract

Allowed during export:

- the active Atlassian tenant under `*.atlassian.net`;
- `https://api.media.atlassian.com/*` for authenticated attachment redirects already
  required by the working image pipeline.

Disallowed:

- compiler, WASM, font, template or package-registry downloads;
- Typst default-font/default-package loaders that fetch remote assets;
- external image hosts unless a later spec adds explicit host permissions.

The compiler adapter disables default remote asset resolution and exposes only packaged
fonts, template files and the current job VFS.

---

## 3. PDF content contract

### 3.1 Preparation and serialization API

The asynchronous preparation step resolves assets and renders diagrams; the serializer
itself remains pure:

```ts
preparePdfDocument(
  blocks: ExportBlock[],
  context: PdfExportContext,
  resolver: PdfAssetResolver,
): Promise<PreparedPdfDocument>

serializePdfDocument(
  document: PreparedPdfDocument,
  options: PdfSerializeOptions,
): PdfSourceBundle
```

`PdfSourceBundle` contains `main.typ`, deterministic job-local asset names, a structured
source map and preparation notes. It is an internal value written to the job store, not
a runtime-message payload.

Both `ExportBlock` and `InlineNode` mappings are exhaustive TypeScript switches with a
`never` guard. Adding a model variant must fail typecheck until its PDF behavior is
chosen.

### 3.2 Normative block mapping

| `ExportBlock` | Typst behavior |
|---|---|
| heading | semantic `heading`; document-wide promotion of the shallowest source heading to level 1, matching the established DOCX fixture behavior |
| paragraph | semantic paragraph with serialized inline children |
| callout | semantic content inside a styled `callout` container; title and kind preserved |
| codeBlock | safe raw-code representation with language metadata and native highlighting |
| ordered/unordered/task list | semantic nested `enum`/`list`; checked state rendered visibly and announced in text |
| table | semantic `table`; spans preserved where valid, leading complete header rows emitted as `table.header` |
| image attachment | semantic figure/image using resolved job asset; caption and alternative description remain separate |
| image external | skipped with a stable report note unless already available through an approved resolver |
| blockquote | semantic quote styling without flattening child content |
| divider | thematic visual separator with no misleading text |
| unknown | omitted or readable text fallback according to the shared export policy; never raw storage XML |

Table policy additionally defines mixed header cells, invalid span grids, repeated
headers, very wide tables and rows crossing page boundaries. Invalid grids degrade to a
readable table or linearized content with a report note; they never create invalid Typst.

### 3.3 Normative inline mapping

| `InlineNode` | Typst behavior |
|---|---|
| text | literal content with bold, italic, underline, strike, code and supported color marks composed deterministically |
| link | external, page, attachment and anchor targets resolved separately; unsafe or unresolved schemes become text plus a note |
| mention | visible display name; link only when the model contains an approved target |
| status | styled inline badge preserving label and color category |
| lineBreak | explicit line break |

Internal heading labels are deterministic and collision-safe. Duplicate or punctuation-
only headings receive stable suffixes derived from document order. TOC entries, outline
bookmarks and internal links use the same promoted hierarchy and label registry.

### 3.4 Escaping and hostile input

There is no universal escape helper. The serializer defines separate, unit-tested
encoders for:

- Typst content;
- string literals and URLs;
- labels/identifiers;
- raw code bodies.

Raw-code fences are chosen longer than every matching backtick run in the source, or use
an equivalently safe function form. Hostile fixtures cover Typst punctuation, embedded
fences, Unicode, RTL text, long unbroken strings, malicious-looking URLs and content that
resembles template calls. The acceptance test compiles the result and confirms the text
is represented literally.

### 3.5 Semantic template and accessibility

`atlcli.typ` supplies cover, outline, heading numbering, running header, footer, callout
styling, status styling, code styling, table defaults and figure styling through semantic
Typst elements and show rules. Styling must not replace headings, paragraphs, lists,
tables or figures with layout-only boxes.

Document language, title, author and a caller-supplied export timestamp are set before
content. Tests inject locale and time; production supplies the current user and clock.

Caption and alternative description are distinct:

- meaningful source alt text is attached to the image;
- a filename is only a technical fallback in standard tagged mode and produces a report
  warning;
- the PDF/UA-1 reference mode fails when meaningful alternative text is required but
  unavailable;
- Mermaid source code is not automatically treated as a useful description. Missing
  diagram descriptions are reported and block the UA reference mode;
- decorative treatment requires an explicit semantic decision, not an empty string by
  accident.

### 3.6 PDF profiles and claims

- **Standard mode:** tagged PDF using the pinned compiler's default tagging support.
- **UA reference mode:** explicitly requests PDF/UA-1 only if Task 1 proves that the
  pinned browser compiler API exposes it.
- Compiler success is necessary but not sufficient for a PDF/UA claim. The archived
  reference requires an external validator report and a manual accessibility checklist.
- This spec makes no PDF/A or archival-conformance claim.

If the pinned browser compiler cannot select PDF/UA-1, standard tagged export continues,
and UA mode becomes a clearly blocked follow-up. Vendoring or forking the compiler is a
new scope decision rather than an implicit Task 1 workaround.

---

## 4. Asset pipeline

The PDF path reuses/generalizes the authenticated resolver proven by DOCX and 005:

- page ID plus attachment filename resolve to the canonical Confluence download URL;
- redirects to Atlassian Media preserve the established credential policy;
- fetches have bounded concurrency, cancellation, deduplication and deterministic order;
- each response is checked for status, declared MIME, magic bytes and size;
- corrupt, missing or unsupported files generate one stable note and no empty VFS file;
- deterministic collision-free VFS names do not expose tenant URLs or credentials;
- repeated references reuse one stored asset;
- per-file and total byte caps fail or skip according to an explicit policy;
- SVG remains vector after sanitation; raster formats retain original bytes when safe;
- `@atlcli/diagram` is the only Mermaid renderer. Supported diagrams become sanitized
  vector SVG; unsupported diagrams remain readable code with a note.

The compiler adapter maps binary files and registers fonts through the exact API of the
pinned compiler version. Merely placing TTF files in a VFS is not accepted as proof that
the compiler uses them.

---

## 5. Diagnostics, report and UI contract

### 5.1 Diagnostics

Serializer source mapping records generated file, start/end lines and a structured block
path such as `blocks[4].table.rows[2].cells[1].children[0]`. Full compiler diagnostics
(severity, path, range and message) map through it.

Diagnostics originating in `atlcli.typ`, the compiler or a generated asset remain
separate from content diagnostics. The panel shows a concise user-facing error and keeps
the detailed diagnostic in the report/debug view.

### 5.2 PDF report

`PdfExportReport` is PDF-specific and maps to a small shared presentation model rather
than reusing the DOCX template report type directly. It includes:

- page identity, filename and selected PDF profile;
- compiler wrapper, WASM/Typst engine and template versions;
- fetch, preparation, queue, compile, download and total durations;
- embedded, deduplicated, skipped and failed images;
- rendered and degraded diagrams;
- warning/note counts with stable ordering;
- page count, embedded-font result, tagging result and validator result when available;
- timeout, cancellation and cleanup outcome.

### 5.3 Panel and download flow

- PDF receives its own export action outside the DOCX template-upload controls.
- Phases: `preparing → fetching assets → queued → compiling → validating → downloading → done`.
- Busy, cancel, timeout, retry and stale-page states are explicit.
- The download sink is generalized to accept MIME type and extension; PDF uses
  `application/pdf` and the established filename sanitizer with a parameterized suffix.
- The report shown after completion is tied to the source page and `jobId`.

---

## 6. Task breakdown

### Task 0 — Refresh contracts and shared assets

- [ ] Add `@atlcli/pdf` with browser-safe package boundaries and explicit exports.
- [ ] Establish one canonical font source and keep DOCX tests/output green after the
  asset-path change.
- [ ] Pin wrapper, web compiler/WASM, embedded Typst engine, diagram renderer, template
  and fonts; record source URL, version, checksum and license.
- [ ] Update `NOTICE` and ensure licenses ship in the extension artifact.
- [ ] Add the decisions in §2 and §3 to code-facing types before integration work.

### Task 1 — Browser compiler feasibility gate

- [ ] In the built WXT extension, initialize the exact pinned compiler and produce a
  valid hello-world PDF from packaged WASM with network access denied.
- [ ] Prove font registration with Inter and JetBrains Mono and prove that an unknown
  font fails rather than silently resolving from the environment.
- [ ] Record whether and how the browser API selects tagged default and PDF/UA-1 output.
  If UA selection is unavailable, record the follow-up boundary before template work.
- [ ] Return a complete syntax diagnostic from a broken source.
- [ ] Record compressed/uncompressed artifact size and cold/warm initialization time.
- [ ] Add a load-unpacked Chromium smoke test; source snapshots alone do not satisfy this
  gate.

### Task 2 — Job store and compiler lifecycle

- [ ] Implement JSON-only control messages and job-scoped binary storage per §2.2.
- [ ] Enforce quotas, startup cleanup, `finally` cleanup and inaccessible/expired-job
  behavior.
- [ ] Implement the worker state machine, FIFO queue, single-flight initialization,
  timeout termination, retry and idle-close rules from §2.3.
- [ ] Test a payload above 10 MB, quota failure, two concurrent requests, navigation
  invalidation, late completion, init failure/retry and a failed job between two
  successful jobs.
- [ ] Prove that job B cannot read job A's sources or assets.

### Task 3 — Semantic template

- [ ] Implement `atlcli.typ` following §3.5 with cover, TOC, numbered headings, running
  header, footer, semantic callout/status/code/table/figure styling and metadata.
- [ ] Add a standalone demo document and deterministic injected metadata/clock.
- [ ] Test heading promotion, duplicate labels, outline/bookmarks, internal links,
  repeated table headers and multi-page layout.
- [ ] Keep default tagged and UA reference modes explicit and separate.

### Task 4 — Preparation and exhaustive serializer

- [ ] Implement both APIs from §3.1 in `@atlcli/pdf`.
- [ ] Cover every `ExportBlock` and `InlineNode` variant with exhaustive switches and at
  least one test, including nesting combinations.
- [ ] Implement the context-specific encoders and hostile compile fixture from §3.4.
- [ ] Emit structured source-map entries and map nested compiler diagnostics.
- [ ] Render Mermaid only through `@atlcli/diagram`; test supported, unsupported and
  renderer-failure paths.
- [ ] Snapshot source only as a readable supplement; successful real compilation is the
  correctness gate.

### Task 5 — Authenticated asset integration

- [ ] Reuse/generalize the working DOCX session resolver and canonical attachment path.
- [ ] Implement redirect, cancellation, concurrency, byte limits, deduplication, content
  validation, deterministic naming and failure notes from §4.
- [ ] Test raster images, sanitized SVG, missing/corrupt assets, duplicate references,
  external URLs, redirects and total-size exhaustion.
- [ ] Verify the compiler performs no runtime requests outside the two allowed Atlassian
  host classes.

### Task 6 — Panel, report and download

- [ ] Add the separate **Export as PDF** action with the phase and stale-page behavior in
  §5.3.
- [ ] Add `PdfExportReport` and the shared report presentation mapping.
- [ ] Generalize the download adapter and download a sanitized `<page-title>.pdf` with
  `application/pdf`.
- [ ] Resolve cover metadata explicitly: page title, space name/key, current exporter,
  document version, locale and injected export time.
- [ ] Test busy, cancel, timeout, retry, error, success and navigation-during-export UI
  states.

### Task 7 — Automated PDF verification

- [ ] CI compiles the demo and shared feature-zoo source through the real compiler. If
  Bun cannot host the compiler, run the built offscreen path in Chromium; compile testing
  never becomes manual-only.
- [ ] Pin a PDF inspector and assert valid parse, page count, metadata, outline,
  internal/external links, embedded fonts and tag presence.
- [ ] Run the same fixed input twice after cold and warm initialization. Require
  byte-identical output, or document and normalize specific compiler-owned volatile
  fields before asserting structural identity.
- [ ] Extend the extension-output check to require expected WASM, fonts, template,
  licenses and hashes and to reject remote loader URLs.
- [ ] Run repo tests, typecheck, `check:browser`, extension build/output checks and the
  new Chromium smoke.

### Task 8 — Quality proof and manual E2E **[E2E: user]**

Use the standing DOCSY feature-zoo page retained by 004. Do not delete or materially
mutate it in this spec; final cleanup belongs to 008.

- [ ] Cover, TOC page numbers, outline/bookmarks and internal TOC links are correct.
- [ ] Promoted headings, callouts, badges, nested lists, tasks, blockquotes and dividers
  remain semantically and visually clear.
- [ ] Tables repeat headers and remain readable across page breaks; merges degrade only
  according to the documented policy.
- [ ] Code highlights correctly and Mermaid remains crisp at 400% zoom.
- [ ] Attachments embed through the real authenticated/redirect flow; missing assets
  produce readable notes.
- [ ] Fonts are embedded and only the pinned families are used.
- [ ] Standard output is confirmed tagged.
- [ ] If UA reference mode passed Task 1, archive the anonymized PDF, external validator
  report and manual checklist for reading order, outline, links, tables, language and alt
  descriptions. Compiler success alone does not pass this item.
- [ ] Record cold compile, warm compile, total duration, peak memory and PDF size for the
  approximately 2,000-word fixture.

### Task 9 — Documentation and handoff

- [ ] Update `src/content/docs/confluence/export.md` with the PDF UI path, support matrix,
  tagged-versus-UA explanation, network/privacy contract, limits, fallbacks and
  troubleshooting.
- [ ] Record exact compiler/assets matrix and bundle-size result in this spec.
- [ ] Update `008-export-poc-validation` to consume output from 007 and use the corrected
  Atlassian plus Media network allowlist.
- [ ] Hand performance and quality evidence to 008; do not make the final DOCX-versus-PDF
  product verdict here.

---

## 7. Test matrix

### Unit

- Every block and inline variant, nesting, heading promotion and duplicate labels.
- Context-specific escaping, code fences, unsafe links and Unicode/RTL fixtures.
- Source mapping for nested table/list/callout diagnostics.
- Stable report notes and deterministic asset naming.

### Integration

- Authenticated asset resolution, Atlassian Media redirect and credential policy.
- Job store quotas, cleanup and isolation.
- Queue, cancellation, worker timeout/restart and idle lifecycle.
- Panel phases, stale navigation, report mapping and generic download sink.

### Built-runtime and compile

- Load-unpacked Chromium smoke against the built extension.
- Cold/warm real compilation and broken-source diagnostics.
- No compiler/font/CDN/package-network access.
- Packaged WASM/font/template/license/hash verification.
- PDF structural inspection and deterministic repeat compile.

### Manual E2E and accessibility

- Visual and semantic review of the standing feature-zoo fixture.
- Performance and memory capture.
- External PDF/UA validator plus manual checklist for the optional reference mode.

---

## 8. Definition of done

- Tasks 0–9 are complete and all mandatory gates are automated except the named visual
  and accessibility checks.
- The built Chrome extension exports the standing page to a valid, tagged PDF without
  blocking the panel.
- No export job leaks VFS state, stored bytes or results into another job or page.
- Runtime network access is limited to the active Atlassian tenant and the established
  Atlassian Media redirect host; compiler and presentation assets are fully local.
- The generated PDF passes structural inspection, embeds only the pinned fonts and
  preserves the supported `ExportBlock`/`InlineNode` contract.
- Fixed-input repeatability is proven under the documented determinism definition.
- PDF/UA-1 is claimed only when the pinned compiler exposes the profile and the archived
  result passes independent validation plus manual review.
- Cold/warm performance, peak memory, output size and bundle size are recorded for 008.
- Repository tests, typecheck, browser/isomorphism checks, extension build and built
  runtime smoke are green.
- User documentation and the 008 handoff are updated in the same change set.

---

## 9. Risks and escalation points

1. **Browser PDF-standard API:** Task 1 may prove tagged output but not PDF/UA-1
   selection. Standard export remains viable; a compiler fork or version change requires
   a separate scope decision.
2. **WASM and font size:** record the actual shipped size early. Optimization or
   subsetting follows only after correctness and licensing are proven.
3. **Long-running WASM:** hard cancellation requires worker termination and clean
   reinitialization; a rejected Promise is not sufficient.
4. **Large jobs and browser quota:** explicit limits and readable failure are required;
   silently dropping assets is not acceptable.
5. **Table pagination and spans:** complex grids may require a documented degradation
   rather than visually incorrect output.
6. **Meaningful alternative text:** technical fallbacks can keep standard export useful
   but cannot establish accessibility quality or UA conformance.

### Decisions log

- **F1 — serializer location:** ✅ `packages/pdf` / `@atlcli/pdf`; host-neutral and
  browser-safe. Extension owns only browser adapters and compiler hosting.
- **F2 — bundled font set:** ✅ Inter 400/500/600 + JetBrains Mono 400/700, full Phase 1
  character sets, exact files/versions/checksums/licenses pinned, no system fallback.
- **F3 — binary transport:** ✅ JSON control messages plus job-scoped same-origin binary
  storage; no `Map`/`ArrayBuffer` payloads through runtime messaging.
- **F4 — compiler concurrency:** ✅ one active compile per worker with FIFO queue until a
  later benchmark proves safe parallelism.
- **F5 — PDF profiles:** ✅ tagged standard mode; separately selected and independently
  validated PDF/UA-1 reference mode; no PDF/A claim.
- **F6 — heading hierarchy:** ✅ promote the shallowest document heading to level 1,
  preserving relative depth and using the same hierarchy for visual headings, TOC,
  outline and anchors.
- **F7 — shared fixture:** ✅ retain the standing 004 feature-zoo page through 007;
  cleanup remains in 008.

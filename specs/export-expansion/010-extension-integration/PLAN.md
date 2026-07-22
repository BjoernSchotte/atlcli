# 010 — Extension integration (scope UI, template library, preview)

Status: Plan, 2026-07-19. Track 1 of `specs/export-expansion/UMSETZUNGSPLAN.md`
(T5.1–T5.5, **plus T5.6 added here**). Design details for the underlying engine capabilities live in
`specs/export-expansion/BASELINE-DESIGN.md` (clusters A, B, E — host-wiring
notes referenced per task below).

## Reference

- Plan of record: `specs/export-expansion/UMSETZUNGSPLAN.md` — Track 1
  ("CLI + Browser-Extension, heutiges Produkt"), tasks T5.1–T5.5. The CLI and
  the extension are one product on one release train: same engines
  (`@atlcli/confluence` → `ExportBlock[]` → `@atlcli/docx` / `@atlcli/pdf`),
  same report vocabulary, shipped together.
- Design source: `specs/export-expansion/BASELINE-DESIGN.md` — Cluster A
  (`ExportScope`, `fetchExportTree`, `composeChapters`, `TreeSource` port,
  `onProgress`/`AbortSignal`), Cluster B (B2 template library +
  `resolveTemplate`, B8/B10 settings + manifest-driven settings form),
  Cluster E (macro renderer registry, `JiraIssuePort`, `ExportViewPort`).
- Current extension host code (all verified on branch `export-expansion`):
  - Panel UI: `apps/extension/entrypoints/sidepanel/App.tsx`,
    `PdfSection.tsx`, `TemplateSection.tsx`
  - PDF pipeline: `apps/extension/utils/pdf/run-export.ts` (extension wrapper
    over the neutral `runPdfExport` from `@atlcli/pdf/browser`; phases
    `preparing | fetching | queued | compiling | validating | downloading`,
    `AbortSignal` threading via `throwIfAborted`),
    `apps/extension/utils/pdf/compile-port.ts` (`extensionPdfCompilePort`:
    job-store handoff + `pdf:compile`/`pdf:cancel` messages),
    `apps/extension/utils/pdf/job-store.ts` (IndexedDB `atlcli-pdf` v1, store
    `jobs`, `PDF_JOB_MAX_BYTES` = 64 MiB/job, `PDF_STORE_MAX_BYTES` = 128 MiB
    total, 24 h cleanup),
    `apps/extension/utils/pdf/compiler-host.ts` (`PdfCompilerHost`:
    single-worker FIFO, worker instance kept alive across jobs, 60 s timeout),
    `apps/extension/workers/pdf-compiler.ts` (`compilerPromise` memoization —
    wasm + fonts initialize once per worker lifetime; warm repeat compiles are
    byte-identical, pinned in `apps/extension/tests/pdf/compiler.test.ts`)
  - DOCX pipeline: `apps/extension/utils/docx/env.ts` (`idbTemplateSource`,
    `sessionAssetFetcher` with versioned-URL cache, `canvasSvgRasterizer`,
    `downloadOutputSink`), `apps/extension/utils/docx/template-store.ts`
    (IndexedDB `atlcli-docx` v1, store `templates`, single `"current"` slot,
    scan re-derived from bytes — never persisted),
    `apps/extension/utils/docx/session-cache.ts` (TTL cache)
  - Shell: `apps/extension/wxt.config.ts` (MV3, host permissions
    `*://*.atlassian.net/*` + `https://api.media.atlassian.com/*`, CSP
    `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`),
    `apps/extension/entrypoints/background.ts` (offscreen idle timer),
    `apps/extension/entrypoints/offscreen/main.ts`
  - Build gates **this folder modifies** (not just consumes):
    `apps/extension/scripts/check-output-build.ts` — post-build text scan over
    `.output/chrome-mv3` asserting zero `node:`/`bun:` specifiers, zero remote
    script origins, zero node globals, **zero string-to-code constructors**
    (`DYNAMIC_CODE_RES`, `check-output-build.ts:48-52`), and a complete set of
    sha256-pinned local PDF artifacts (`REQUIRED_PDF_ARTIFACTS`,
    `check-output-build.ts:61`). T5.3 touches both of the last two — see
    Architecture point 8. `apps/extension/wxt.config.ts` is touched only if the
    new viewer page needs a WXT entrypoint declaration (no new permissions, no
    CSP relaxation — asserted by `tests/manifest.test.ts`).
- New vendored runtime dependency (T5.3): `pdfjs-dist` (Mozilla PDF.js,
  Apache-2.0 — compatible with this repo's Apache-2.0 licensing). Bundled
  locally, never from a CDN: MV3 forbids remotely hosted extension code, and
  `check-output-build.ts`'s remote-origin scan enforces it mechanically.
- Docs: `src/content/docs/` (docs standards in `CLAUDE.md`). Release:
  `scripts/release.ts` (`--dry-run` first), `CHANGELOG.md`.

## Goal & user value

After M1 the engines can do tree/space exports with label filters, a template
library with settings, and live macro rendering — but only the CLI exposes
them. This folder makes the extension a first-class front end for the same
baseline, because the panel is where non-CI users live:

- **Export a whole handbook from the panel** (T5.1): page / page + children /
  entire space, curated with label include/exclude, with honest progress
  ("Page 37/210: <title>") and a working Cancel — instead of today's
  single-page-only button in `PdfSection.tsx`.
- **Manage templates like a library** (T5.2): multiple named templates,
  global vs. space scope with the same `resolveTemplate` precedence the CLI
  uses, and a settings form generated from the template manifest — instead of
  today's single anonymous `"current"` slot.
- **See the PDF before downloading it** (T5.3): a debounced preview rendered by
  a locally bundled PDF.js viewer over the *same* bytes the download produces,
  powered by the already-warm compiler worker — full document for single-page
  scope, budget-truncated for tree/space. Hybrid UX: a compact page preview in
  the 400 px panel plus a "Open large preview" full viewer in its own extension
  page. For DOCX the honest story stays the scan report — we do not fake a
  Word rendering we cannot produce.

  **Motivation and honest product boundary.** The user-facing problem is
  [CONFCLOUD-84742](https://jira.atlassian.com/browse/CONFCLOUD-84742): users
  export the same report 5–10 times, tweaking spacing and tables each round,
  because Confluence Cloud offers no PDF preview. This folder removes the
  *export-and-open* half of that loop, not all of it: the extension's read path
  is `getPageDetails()` (`apps/extension/utils/read-path.ts:148`), which returns
  the **last published version — never the open editor draft**. The iteration
  loop therefore becomes `edit → publish → preview` instead of
  `edit → publish → export → open file`. That is a large win over the status
  quo and must be stated in the panel copy and the docs, not discovered by the
  user. A true draft preview would depend on undocumented Confluence-internal
  APIs or unstable editor DOM and is explicitly **not** in this folder (see
  Open questions).
- **Pages with live macros export like the page looks** (T5.4): Jira issue
  tables and third-party macro output rendered through the user's own browser
  session — no tokens to configure, which is precisely the extension's edge
  over the CLI.
- **A long export survives navigating away** (T5.6): exports become durable
  background jobs the panel re-attaches to, with status surfaced in the panel
  and a toolbar badge when one finishes while the panel is closed — instead of
  today's silent abort on page navigation
  (`PdfSection.tsx:30-37`). Motivation:
  [CONFCLOUD-83694](https://jira.atlassian.com/browse/CONFCLOUD-83694), where
  Confluence Cloud's own space export fails if the user leaves the export page.
  Includes the byte-handling and memory prerequisites this makes unavoidable
  (Architecture points 9 and 10).
- **Documented and released as one product** (T5.5): docs/ updated in the same
  release, CHANGELOG, release checklist.

**Task-numbering divergence (crossPlanImpact).** `UMSETZUNGSPLAN.md` lists this
track as T5.1–T5.5. **T5.6 is introduced by this folder** in response to
CONFCLOUD-83694 and the byte-flow findings in Architecture point 9, and must be
reflected back into `UMSETZUNGSPLAN.md`'s Track 1 table when this plan is
accepted — otherwise the plan of record and this folder disagree on scope. T5.6
also deliberately takes on a bounded set of `packages/pdf` changes, which
stretches this folder past pure host integration; the reasoning and the limits
are in Architecture point 9 ("Scope honesty").

## Dependencies (M1 folders 002–004, 007–008)

This folder starts after milestone M1 (UMSETZUNGSPLAN "Baseline richtig gut")
and consumes only published seams of sibling folders (of which `003-content-features`
already exists on disk; the others land with their lanes). **Folder numbers below
match the actual `specs/export-expansion/NNN-slug/` directories and the
UMSETZUNGSPLAN.md folder table** — a prior draft of this table misattributed
scope orchestration to "001" (which is actually `001-exportblock-model`, T0.1/T0.2)
and CLI/PDF work to "002" (which is actually `002-scope-orchestration`); every
in-body reference below ("folder NNN lands …") has been corrected to match:

| Folder | Provides (consumed here) |
|---|---|
| 002 (`002-scope-orchestration`, scope & orchestration, Lane A / T1.1–T1.3) | `ExportScope`, `LabelFilter`, `TreeSource` port, `fetchExportTree` (with `signal`, `onProgress`, `maxPages`), `composeChapters` in `packages/confluence/src/{export-scope,tree-fetch,compose-document}.ts` — the `unknown` block's `sourcePage?: { id; version?; spaceKey? }` field that 004 requested from 002 as a cross-plan sync point (`004-macro-renderer/PLAN.md:163-181`, "not a file this plan owns") is now **planned** (002's post-hardening `PLAN.md` §"Model + fetch", the `unknown.sourcePage` cross-plan-sync-point task, explicitly cites this plan as one of the two requesters), so this is no longer an open prerequisite at the plan level — it remains a landing-order dependency: T5.4 must still verify the field actually exists in `export-blocks.ts` when its implementation starts, since a plan task is not yet merged code (see Architecture point 6 and crossPlanImpacts) |
| 003 (content features, Lane C — `specs/export-expansion/003-content-features/`) | compatibility-macro rendering (`pageBreak`, `orientation`, captions) that must survive unchanged through the panel path |
| 004 (macro renderers, Lane E / T1.7–T1.10) | `MacroRenderer` registry + `resolveMacroBlocks` in `packages/export-macros`, ports `JiraIssuePort`, `ExportViewPort`, fallback chain incl. `export_view`; the resolver hook-in runs **once, on the composed multi-page tree**, and derives each macro's page context via `contextFor(block.sourcePage ?? ctx.page)` (`004-macro-renderer/PLAN.md:399-412`) — T5.4 must wire `contextFor` through, not assume a single root `ctx.page` (see Architecture point 6) |
| 007 (`007-pdf-template-settings`, template library, Lane P / T2.1–T2.4) | `TemplateLibrary`/`TemplateLibraryEntry` + pure `resolveTemplate(entries, id, spaceKey)` in `packages/core/src/template-library.ts`, `settings` threading (`RunPdfExportInput.settings`) — **PDF only**: 007 explicitly states "`packages/docx` is not modified here" and defers B10 (template settings/timezone/presets) as "recorded, not implemented" (`007-pdf-template-settings/PLAN.md:98-102`, `:373`); there is today no folder that owns a DOCX-side `ExportInput.settings` seam — resolved here by scoping T5.2's `SettingsForm.tsx` to PDF settings for v1 (see T5.2 task); also **PDF-Level-B only**: `serializePdfDocument` always emits `createAtlcliTypstTemplate(...)` (`packages/pdf/src/serialize.ts:864`) — 007's `TemplateLibraryEntry.engine: "typst"` prepares storage for custom Typst templates but no render path consumes them yet (007 Goal item 1: "imported Level-B packages **later**"); `PdfSection.tsx` already says "No template upload required" (`apps/extension/entrypoints/sidepanel/PdfSection.tsx:78`) and T5.2 keeps it that way for v1 (see T5.2 task) |
| 008 (`008-pdf-cli`, CLI scope & PDF commands, Lane K / T3.1–T3.4) | CLI parity + the DOCSY E2E coverage of engine behavior this folder's tests lean on |

Hard rule inherited from the baseline: **no extension-only engine logic.** If a
behavior is not reachable from the CLI, it does not belong in
`apps/extension/` — the panel only contributes host adapters (session fetch,
IndexedDB, download, worker) and UI.

## Architecture

**One new host adapter per port, everything else is UI.** The extension keeps
its "functional core, imperative shell" split: pure state machines and
resolvers live in `apps/extension/utils/` and are unit-tested; DOM/`chrome`/IDB
wiring stays in thin components and entrypoints.

1. **Scope orchestration (T5.1).** A new `utils/confluence/tree-source.ts`
   implements the folder-001 `TreeSource` port over the ambient session
   (pattern: `sessionAssetFetcher` in `utils/docx/env.ts`, profile via
   `utils/profile.ts#profileFromTabUrl`). `utils/pdf/run-export.ts` grows a
   scope-aware entry: `scope: ExportScope` + `labels?: LabelFilter` replace the
   implicit single page; it calls `fetchExportTree` → `composeChapters` and
   hands the composed blocks to the unchanged neutral `runPdfExport`. The DOCX
   path gets the same treatment in `TemplateSection`'s export handler (blocks
   in, `ExportInput.details` stays the root page, per BASELINE-DESIGN A1). The
   per-page asset problem (attachment refs carry only `filename`) is solved
   with the baseline-recommended `ImageSource.pageId` — the extension's
   resolvers (`pageResolver` in `utils/pdf/run-export.ts`, the attachment path
   in `utils/docx/env.ts`) key their download URL on `ref.pageId ?? rootPageId`.
   Progress and abort reuse the existing seams: `AbortController` in
   `PdfSection.tsx`, `onPhase` mapping in `run-export.ts`, extended by an
   `onProgress` detail channel ("Page n/total: title").
2. **Job-store budgets for multi-page bundles (T5.1).** `putPdfJob` rejects
   bundles > 64 MiB and stores > 128 MiB (`utils/pdf/job-store.ts`). A
   50-page, image-heavy tree can plausibly hit both. Strategy: keep the caps
   (they protect the profile's IndexedDB quota), add (a) a pre-flight size
   estimate with a friendly, named-offender error before any job is stored —
   **built on the exact-byte dedupe `preparePdfDocument` already does**
   (`packages/pdf/src/prepare.ts:144-189`: `assetKey`/`sameBytes` dedupe
   identical asset bytes to one canonical `assets/…` path *before* the
   `PDF_MAX_TOTAL_ASSET_BYTES` check, and every reference is rewritten to
   that canonical path) — job-store therefore measures and caps the
   already-deduped canonical bundle it receives, it does **not** run a
   second, independent dedupe pass of its own: a job-store-level sha256
   dedupe would either find nothing left to remove or, if it tried anyway,
   risk dropping bytes without the reference-rewrite `prepare.ts` already
   did, breaking the compiler VFS (dangling asset paths); (b) a page-count
   confirmation for `space` scope (baseline A2 UX), and (c) a compile timeout
   in `PdfCompilerHost` that scales with page count instead of the flat 60 s.
3. **Durable jobs across service-worker restarts (T5.1).** `extensionPdfCompilePort`
   holds one `await chrome.runtime.sendMessage(...)` open for the whole
   compile (`utils/pdf/compile-port.ts:65`), and `background.ts#activePdfJobs`
   is a plain in-memory `let` (`entrypoints/background.ts:49`) that resets to
   `0` on every service-worker restart. Chrome may terminate an MV3 service
   worker mid-request (5-minute cap on a single event, or an unrelated idle
   teardown) regardless of in-flight work; the scaled timeout in point 2(c)
   makes this *more* likely to matter for large space exports, not less. A
   terminated SW drops the open `sendMessage` promise with no response, so
   the panel sees an uncorrelated hang even though the job record survives
   in `atlcli-pdf` (job-store is durable; the message channel is not).
   Mitigation: treat the job record in IndexedDB as the source of truth —
   the panel polls/re-subscribes for `job.status` instead of relying solely
   on the `sendMessage` response reaching it, and reconnecting after a SW
   restart resumes watching an already-running or already-finished job
   instead of erroring or silently re-queuing a duplicate compile.

   **Two concrete defects this point previously under-stated** (both are
   [CONFCLOUD-83694](https://jira.atlassian.com/browse/CONFCLOUD-83694)
   reproduced in our own code, not hypothetical):

   **(a) The panel aborts its own export on navigation.**
   `PdfSection.tsx:30-37` holds `identity = pageUrl|id|version` and aborts the
   active export whenever that identity changes. Navigating to another
   Confluence page therefore **kills a running export** — precisely the
   behavior the ticket complains about, by design, in our panel. It is
   invisible today because single-page exports take seconds; T5.1's tree/space
   exports make it the normal case. The Chrome side panel survives tab
   navigation on its own, so this is our decision, not a platform limit. Fix:
   identity change stops *watching* a job, never aborts it — abort stays bound
   to the explicit Cancel button.

   **(b) The idle timer can tear down an offscreen document that is still
   compiling.** `runPdfCompile` correctly does `activePdfJobs += 1;
   offscreenIdle.stop()` (`background.ts:74-75`), but `activePdfJobs` is a
   volatile `let` (`background.ts:49`). After a SW restart it reads `0` while a
   job is still running in the offscreen document. A *second* job started
   afterwards then completes, its `finally` runs `activePdfJobs` 1 → 0 →
   `offscreenIdle.reset()` (`background.ts:87-88`), and five minutes later
   `closeOffscreen()` fires — **killing the first, still-running compile**. The
   record is left `compiling` forever and the panel never sees a result. The
   same volatile-counter path also arms the timer via `runWasmSmoke`
   (`background.ts:58`). Fix: derive in-flight state from the durable job
   records (`status: "queued" | "compiling"` in `atlcli-pdf`), not from an
   in-memory counter, before arming the idle timer.

   **Cleanup ownership must move out of the panel.** `deletePdfJob` runs from
   `compile-port.ts:90`'s `finally` — in the *panel*, i.e. exactly the context
   that disappears in a background job. `cancelPdfJob` (`job-store.ts:244-250`)
   only sets a status and deletes nothing. Together these leave orphan records
   carrying a **full bundle** (up to `PDF_JOB_MAX_BYTES`, 64 MiB) until the 24 h
   `cleanupPdfJobs` sweep. For background jobs that is the normal path, not an
   edge case, and it competes directly with `PDF_STORE_MAX_BYTES`. Terminal-state
   cleanup therefore belongs to the SW/offscreen side, which outlives the panel;
   the panel may only delete a job it is actively watching *and* has consumed.

   **What "background" does and does not mean.** In an MV3 extension a
   background export survives page navigation, panel close, and service-worker
   restart. It does **not** survive closing the browser. CONFCLOUD-83694 asks
   Atlassian for server-side durability; we cannot match that and must not
   imply it. The workflow the ticket actually describes — "navigate away, come
   back, find the export" — is fully coverable, and that is what the panel copy
   and docs promise. Nothing more.

   The good news is that the expensive half already works: bytes travel through
   IndexedDB, never through `sendMessage` (verified: `compile-port.ts:64`,
   `background.ts:78`, `compiler-host.ts:89` all carry `{ kind, jobId }` only,
   `messages.ts:44-45,72-78`). If the panel closes mid-compile, the offscreen
   worker keeps running and `completePdfJob` still writes the PDF to
   `atlcli-pdf`. **The result already survives.** What is missing is
   re-attachment, cleanup ownership, and surfacing — not persistence.
4. **Template library (T5.2) — DOCX template swapping + PDF settings-on-built-in,
   not PDF template swapping.** `utils/docx/template-store.ts` migrates
   IndexedDB `atlcli-docx` v1 → v2 (multi-slot records + indexes, migration
   plan in the task list). A new `utils/templates/library.ts` adapts the v2
   store to the folder-007 `TemplateLibrary` interface; selection resolution is
   the **pure, shared** `resolveTemplate` from `@atlcli/core` — the panel must
   not grow its own precedence rules. The settings form is one generic
   renderer (`SettingsForm.tsx`) over the manifest schema, the same widget
   vocabulary the CLI documents for `--set key=value`, and feeds
   `RunPdfExportInput.settings` for PDF. **What this folder does not deliver**:
   an importable/swappable PDF (Typst) template. `serializePdfDocument` always
   emits `createAtlcliTypstTemplate(...)` (`packages/pdf/src/serialize.ts:864`)
   — 007 defers actual custom-Typst rendering as "Level-B packages later"
   (007 Goal item 1) and `packages/docx` is explicitly out of 007's scope for
   settings. So the v2 library stores and swaps **DOCX** template bytes (as
   today, just multi-slot) and carries **PDF settings** (Level-A: page size,
   orientation, cover/outline toggles, watermark, header/footer text) applied
   to the one built-in Typst template — `PdfSection.tsx`'s existing copy "Uses
   the built-in atlcli document design. No template upload required." stays
   true for v1; do not add PDF template upload/swap UI here (opens only when
   007 ships a Level-B render path — track as a follow-up, not a T5.2 task).
   DOCX settings threading has the identical gap on the engine side: today's
   `ExportInput` (`packages/docx/src/export.ts:112-140`) has no `settings`
   field and no folder currently adds one (see Dependencies). `SettingsForm.tsx`
   therefore ships for **PDF only** in v1; its DOCX branch is a documented
   follow-up, not silently dropped (see T5.2 task and Definition of Done).
   **Key model**: the v2 `templates` store keeps `keyPath: "id"` as its
   IndexedDB primary key (one row per physical upload), but `id` is *also*
   the value `resolveTemplate(entries, id, spaceKey)` matches on to decide
   "space beats global" — two different concepts sharing one field. Since
   `keyPath: "id"` forces every row to have a distinct id, a literal global
   entry and its space-scoped override can never coexist under 007's
   `resolveTemplate` semantics: inserting the second with the same `id`
   overwrites the first (a `put()` on the primary key replaces the row). The
   store therefore needs two fields: a storage-unique `recordKey` (IDB
   `keyPath`, e.g. `siteOrigin|engine|templateId|scope|spaceKey` so two
   Atlassian sites that happen to share a space key, e.g. staging/prod both
   using `DOCSY`, never collide — the existing `spaceInfoCache` in
   `TemplateSection.tsx:56-66` already keys on `${site}|${key}` for exactly
   this reason) and a separate `templateId` (the logical id `resolveTemplate`
   matches on, stable across a global entry and its space override of "the
   same" template). `template-prefs`'s active-selection key gets the same
   `siteOrigin` prefix. See T5.2 task and Tests.
5. **Preview (T5.3) — scheduling contract, not just warm-worker reuse.** No
   second compiler: the preview path reuses `extensionPdfCompilePort` →
   offscreen `PdfCompilerHost` → memoized `compilerPromise` in
   `workers/pdf-compiler.ts`, so the first preview pays wasm+font init once
   and every subsequent preview is a warm compile — **but only if nothing
   cancels the in-flight compile**. `PdfCompilerHost` is a strict
   single-worker FIFO (`utils/pdf/compiler-host.ts:83` `pump()`), and
   `cancel()` on the *active* job calls `destroyWorker()`
   (`compiler-host.ts:52-67`), which drops the memoized `compilerPromise`
   with it — the next compile (preview or export) pays a full cold wasm+font
   init again. Combined with FIFO, an in-flight preview compile also
   physically blocks the primary export click until it either finishes or is
   cancelled (which then also kills the warm worker) — the opposite of "Preview
   never blocks export" (Definition of Done). T5.3 therefore adds a job-kind
   contract on top of the existing host, not just a truncated-input compile:
   `preview | export` job kinds, previews coalesce (a new preview supersedes
   an unfinished one) and are cooperatively abandoned (result discarded, no
   `destroyWorker()`) rather than cancelled through the worker-killing path
   when superseded by a settings change or an export click; an export request
   always takes the front of the queue ahead of any queued preview.

   **Renderer: locally bundled PDF.js, not `<embed>`.** Output goes to a
   capture sink (bytes, not a download) and is handed to PDF.js as a
   ~~`Uint8Array` via `getDocument({ data })` — no intermediate `blob:` URL~~.

   **Corrected during implementation (T5.3):** it is the other way round —
   PDF.js gets a `blob:` URL, and `data` is only the copy-based fallback for a
   runtime without `URL.createObjectURL`. `getDocument({ data })` may transfer
   (and thereby detach) the buffer it is given, and since T5.6 the bytes are a
   `PdfBytesHandle` whose `asUint8Array()` hands out its *borrowed* backing
   array — so `data` would have left Download with a zero-length view. See the
   T5.3 task and `apps/extension/utils/pdf/viewer.ts:26-35`. None of the
   positive rationale below depends on this: the viewer is still a `<canvas>`
   under `script-src 'self'`, and no `object-src`/`<embed>` question arises
   either way.

   **Decision record (2026-07-20).** Earlier drafts of this plan justified the
   choice negatively, by asserting that a `blob:`-sourced
   `<embed type="application/pdf">` is *blocked* by this extension's
   `object-src 'self'` — read off the CSP spec and the manifest, never
   reproduced in a running build. That empirical verification was **explicitly
   dropped by the plan owner**: PDF.js is the choice regardless of how the
   `<embed>` test would have come out, so paying for the experiment bought
   nothing. The unverified claim is therefore **removed rather than carried**,
   and the rationale below stands on its own — none of it depends on what
   `object-src` does to `<embed>`.

   The positive reasons: PDF.js renders into a `<canvas>` under `script-src
   'self'`, which the existing CSP already allows, so the viewer never raises
   an `object-src` question at all. It also buys what the built-in viewer
   cannot: a reduced, controllable surface, page navigation, zoom and
   fit-width, later text selection/search/thumbnails/outline, and identical
   behavior across Chrome and Firefox. The cost is accepted knowingly and is
   tracked in Risks (bundle weight next to the ≥ 20 MB Typst WASM artifact, a
   new upstream to watch for advisories; note that the `DYNAMIC_CODE_RES`
   exemption Architecture point 8 originally planned turned out to be
   unnecessary — see that point).

   **Truncation is scope-dependent.** For `scope: page` — the case
   CONFCLOUD-84742 actually describes — the preview compiles the **whole**
   document: a partial preview of a single page would not answer "does my
   report look right?", which is the entire point. For `tree`/`space` scope the
   cost ceiling from T5.1 still applies: compile a truncated composition (first
   N **chapters** of the composed block list), not a post-processed PDF — no
   new PDF-slicing dependency. **Honesty note (tree/space branch only)**:
   "first N pages" is only true when every source page compiles to roughly one
   PDF page. `RunPdfExportInput.blocks` only carries block-level structure;
   actual `pageCount` is known only after compile + `validatePdfOutput`
   (`packages/pdf/src/run-export.ts:161,178` — `inspection.pageCount` is read
   post-compile). A single dense chapter (large table, many images) can compile
   to far more than N PDF pages on its own. The panel therefore labels the
   truncated case "Preview — first N chapters" (never "pages"), and the
   truncation carries a block-count/asset-byte backstop so one pathological
   chapter still bounds preview compile time (see T5.3 task).

   **Preview bytes are cached and reused by Download — conditionally.** A
   successful preview stores its bytes keyed on `sourceIdentity` (the
   scope+filter discriminator T5.1 defines) **plus a hash of the resolved
   settings**, so a settings tweak that did not yet trigger a recompile can
   never serve stale bytes as "what you previewed". Clicking Download on a
   cache hit emits exactly those bytes — no second compile, and
   "what you preview is what you download" is then literally true. **The cache
   record carries a `truncated: boolean` flag and Download must refuse to reuse
   a truncated entry**: for tree/space previews the cached bytes are a *prefix
   of the document, not the document*, and silently downloading them would ship
   a cut-off PDF that looks complete. Truncated entries serve the viewer only;
   Download falls through to a full compile. Cache entries follow the existing
   job lifecycle (deleted in `finally`, subject to the same store budget) so
   preview traffic cannot grow the IndexedDB footprint unboundedly.

   Settings/scope changes are debounced; each new preview supersedes the
   previous one per the coalescing rule above, not via `pdf:cancel` when a
   compile is still active. The background idle timer
   (`entrypoints/background.ts#offscreenIdle`) must treat preview traffic as
   activity so the offscreen document (and with it the warm worker) survives a
   debounce pause.

   **Hybrid layout for a 400 px panel — expressed through Phase 0's screen
   model, not as a special case.** The panel is constrained to `maxWidth: 400`
   (`entrypoints/sidepanel/App.tsx:171`), enough for a scaled page plus controls
   but not for reading a dense report. Preview is therefore **one screen mounted
   by two host shells** (Phase 0): the sidebar shell renders it compactly
   (current page, forward/back, fit-width) with an "Open large preview" action;
   a dedicated WXT extension page mounts the same screen full-size in a tab over
   the same cached bytes. One viewer component, no second compile path. The same
   mechanism is what lets a Forge host mount the export screen in a
   content-action modal without a sidebar at all — the shell varies, the screen
   does not. If preview ends up needing shell-specific forks, that is a defect
   in the Phase 0 screen model, to be fixed there rather than worked around
   here.
6. **Macro renderers (T5.4).** New `utils/macros/session-ports.ts` implements
   the folder-004 ports by **adapting the existing session-capable clients**,
   not a fresh raw-`fetch` reimplementation: `JiraClient`
   (`packages/jira/src/client.ts`, already `BROWSER_ENTRYPOINTS`-gated and
   already supports `profile.auth.type === "session"` — `client.ts:57`) for
   `JiraIssuePort`, and `ConfluenceClient` (`@atlcli/confluence/browser`,
   the same class `TemplateSection.tsx` already constructs via
   `profileFromTabUrl`) for `ExportViewPort`, both against `<site>/…` (Jira:
   `/rest/api/3`, covered by the existing `*://*.atlassian.net/*` host
   permission — same origin as Confluence Cloud). Reusing the clients is not
   just DRY: both already implement `assertNotAuthRedirect` (manual-redirect
   / opaque-redirect classification, `client.ts:198-217`) and 429
   `Retry-After` exponential backoff (`client.ts:299-318`) that a hand-rolled
   session-fetch adapter would otherwise have to reinvent — session macro
   fetches inherit login-expiry and rate-limit handling for free instead of
   only mapping 403/404 → `skip`. The registry is passed through the existing
   env seams (`ExportEnv.macros` / `PdfExportEnv.macros`); without the ports
   the chain degrades exactly as in the CLI (placeholder + report note —
   "never silently drop"). **Per-source-page context**: 004's resolver hooks
   in once on the already-composed multi-page tree and resolves each macro's
   context via `contextFor(block.sourcePage ?? ctx.page)`
   (`004-macro-renderer/PLAN.md:399-412`), where `unknown.sourcePage` is a
   field 004 has already requested from 002 as a cross-plan sync point
   (`004-macro-renderer/PLAN.md:163-181`) and which `002-scope-orchestration/PLAN.md`
   now plans as its own task (see Dependencies) — still a landing-order
   dependency, not yet merged code. T5.4's registry construction must
   pass `contextFor` through unchanged from `packages/export-macros`, not
   default every macro to the root page's id — landing T5.4 against a build
   of 002 that predates `sourcePage` (e.g. an earlier commit on the same
   branch, or 002 having been implemented before this hardening round's
   plan update) would silently resolve every child-page
   Jira/`export_view` macro (attachment lookups, diagram previews) against
   the wrong page in tree/space exports. Gate T5.4 on 002's `sourcePage`
   task actually being merged, not just planned (flagged under
   crossPlanImpacts). **Browser-safe
   `htmlToExportBlocks`** (resolved by 004, verify only here): the
   `export_view` fallback renderer needs it (004's
   `exportViewFallbackRenderer(deps: { htmlToExportBlocks })`); 004's current
   plan now exports `html-to-blocks.ts` from `packages/confluence/src/index.browser.ts`
   itself, as its own T1.10 task (`004-macro-renderer/PLAN.md:415-450,1053-1054`
   — a prior draft of 004 deliberately excluded it and claimed "T5.4 needs no
   package changes", which this folder's earlier draft correctly flagged as
   contradictory; 004 has since fixed this at the source rather than leaving
   it for T5.4). Only remaining work here: add the barrel export to
   `BROWSER_ENTRYPOINTS` in `scripts/check-browser-build.ts` if 004's task
   doesn't already cover that check, then inject `htmlToExportBlocks` into
   `defaultRegistry` from `apps/extension/utils/macros/session-ports.ts` the
   same way the CLI does from `apps/cli/src/commands/export-internals.ts`.
   **External-asset security boundary**: 004 defines an `ExternalAssetPolicy` port
   (`allow(url): boolean`) specifically for `export_view`-sourced images
   (`004-macro-renderer/PLAN.md:552-560`), but this PLAN previously never
   wired it, leaving the two engines inconsistent — the PDF asset resolver
   throws for every `external` image source outright
   (`utils/pdf/run-export.ts:126`: `"External image hosts are not fetched by
   the PDF exporter."`), which would silently degrade every export_view-sourced
   image once T5.4 lands macro rendering, while the DOCX
   `sessionAssetFetcher` fetches **any** absolute URL with
   `credentials: "include"` and no origin allowlist
   (`utils/docx/env.ts:77-100`). T5.4 implements `ExternalAssetPolicy` once
   (site origin + explicitly allowed Atlassian media origins, reject
   redirects off-allowlist, size-cap the stream) and wires it into **both**
   engines' resolvers so `export_view` images either render identically in
   both formats or degrade identically with a visible placeholder + report
   note — never a silent PDF omission next to a DOCX fetch of an
   unauthenticated third-party URL.
7. **Panel layout.** `App.tsx` gains a shared `ScopeSection` above the two
   engine sections so DOCX and PDF export the same scope; advanced inputs
   (label filters, depth, dynamic-macro toggle) sit behind progressive
   disclosure (`<details>`), defaults stay "current page, no filters" — the
   panel must not get harder for the 90 % single-page case.
8. **Vendored viewer & the build gate (T5.3) — a security gate is deliberately
   loosened here.** This point exists as its own architecture item, not as a
   footnote to the preview task, because it is the one place in this folder
   where a hard build gate is relaxed and therefore needs explicit review
   attention.

   **SUPERSEDED BY MEASUREMENT (2026-07-21). No exemption was added, and none
   is needed.** This point was written on the assumption that PDF.js ships
   string-to-code constructors. That assumption was **measured against the
   actual dependency and is false** for `pdfjs-dist@6.1.200` (Apache-2.0), the
   version this folder vendors:

   - `new Function(` / `Function("` / `eval(` in `build/pdf.min.mjs` and
     `build/pdf.worker.min.mjs`: **zero occurrences** (verified by scanning the
     emitted artifacts, and independently re-verified by the orchestrator).
   - The `isEvalSupported` option **no longer exists** in v6 — 0 occurrences in
     `pdf.mjs`/`pdf.worker.mjs`. v6 replaced the `Function`-based PostScript
     evaluator with a WebAssembly one (`buildPostScriptWasmFunction`).

   So the premise below ("PDF.js ships those tokens") described PDF.js v3/v4,
   not the vendored version. **Adding a path-scoped exemption would have
   loosened a security gate for a threat that does not exist**, and asserting
   `isEvalSupported: false` as the compensating control would have asserted a
   no-op. Neither was done. `DYNAMIC_CODE_RES` remains unchanged and applies to
   every file in `.output/chrome-mv3`, PDF.js included.

   **The gate was instead STRENGTHENED, because the audit found a real hole:**
   - The scan walked only `.js`/`.html`. The vendored `.mjs` artifacts were
     therefore **invisible to every rule** — not just this one. `.mjs` is now
     scanned.
   - Both PDF.js artifacts are added to `REQUIRED_PDF_ARTIFACTS`, sha256-pinned.
     This is only meaningful because they are vendored with `?url&no-inline`
     (emitted verbatim, not bundled): a rolldown chunk hash changes on every
     unrelated edit, and worse, a path rule over a *chunk* name could silently
     start covering our own code if the chunker merges modules.
   - A scope test seeds `new Function(` into the real emitted PDF.js artifact
     and asserts the real CLI **fails** — proving the path is not exempt — and
     a second seeding elsewhere proves `.mjs` is not a way around the gate.
     Adding a simulated exemption turns those tests red, so one cannot be
     slipped in later without the suite noticing.
   - `isEvalSupported: false` is still passed at the construction site,
     documented as **inert in v6**, with a test that fails if PDF.js
     reintroduces the option — so the situation is re-read rather than assumed.

   What is load-bearing at the construction site today: `enableXfa: false`,
   `useSystemFonts: false`, and the deliberate absence of
   `wasmUrl`/`cMapUrl`/`standardFontDataUrl` (nothing is fetched at runtime).

   ~~Original contract, retained for review history:~~
   - ~~**Path-scoped exemption only.** `DYNAMIC_CODE_RES` gains an exemption
     keyed on the vendored PDF.js chunk's emitted path pattern.~~
   - ~~**Runtime assertion, not just a comment.** The viewer constructs PDF.js
     with `isEvalSupported: false` and a unit test asserts that option is set
     at the single construction site.~~
   - ~~**The exemption is itself tested.** A gate test fails if the exemption
     matches any path outside the PDF.js chunk.~~
   - ~~**Rationale is documented in the module.** `check-output-build.ts`'s
     docstring records *why* one dependency is exempt and what compensates
     for it.~~ *(Superseded: the docstring instead records the measurement and
     what would reopen the question — there is no exemption to justify.)*

   Conversely the gate also *helps* here: `REQUIRED_PDF_ARTIFACTS`
   (`check-output-build.ts:61`) pins required local artifacts by path pattern
   and sha256. The PDF.js viewer and worker chunks are added to that list, which
   turns "PDF.js must be bundled locally, never a CDN" from a convention into a
   mechanically enforced build assertion — the same guarantee the Typst WASM
   and the ten fonts already get. Both viewer and worker are **lazy-loaded**
   (dynamic `import()`, mirroring `PdfSection.tsx:49`'s existing lazy
   `run-export` import) so a panel that never opens the preview never pays the
   parse cost — relevant because the bundle already carries a ≥ 20 MB Typst
   WASM artifact.
9. **Byte handling & memory (T5.6) — measure first, then change.** Three
   features in this folder multiply how many PDF/asset byte copies are alive at
   once: tree/space bundles (T5.1), a preview cache (T5.3), and retained
   background-job records (T5.6). A code-level trace of the byte path found the
   following. **None of it is measured** — there is no memory benchmark for the
   PDF path in this repo — so the *first* task under T5.6 is a heap snapshot of
   a real image-heavy DOCSY export. Nothing below gets optimized on suspicion.

   **The transport is already right and must stay that way**: zero bytes cross
   `chrome.runtime.sendMessage`; IndexedDB is the byte channel (verified —
   `compile-port.ts:64`, `background.ts:78`, `compiler-host.ts:89` carry
   `{ kind, jobId }` only, typed in `messages.ts:44-45,72-78`). Any future
   change that puts bytes in a message is a regression, not a shortcut.

   Findings, worst first:
   - **`store.getAll()` as a quota check.** `putPdfJob` (`job-store.ts:118`) and
     `completePdfJob` (`job-store.ts:200`) deserialize the **entire store** —
     every bundle, every asset, every finished PDF — to compute a sum against
     `PDF_STORE_MAX_BYTES`, when `storedJobBytes` (`job-store.ts:50-52`) needs
     two numbers. The guard meant to protect memory is the largest allocator in
     the store. Fix: maintain size metadata separately (index or a small meta
     record) and never materialize records to add numbers. This is a
     **prerequisite** for T5.6, not an optimization: background jobs retain more
     records for longer by design, so the feature makes this path worse.
   - **`validatePdfOutput` decodes the whole PDF to a string**
     (`packages/pdf/src/validate.ts:48`, `TextDecoder("latin1").decode(bytes)`).
     JS strings are UTF-16, so a 64 MiB PDF — the maximum `job-store.ts:194`
     permits — produces a ~128 MiB string on top of the original bytes, followed
     by `.match(/…/g)` arrays materializing every hit. Fix: chunked scanning
     with overlap at chunk boundaries.
   - **A status update rewrites the whole bundle.** `claimPdfJob` →
     `updateExisting` (`job-store.ts:152-181`) reads the record and `put()`s it
     back — all asset bytes re-serialized to disk — to set
     `status: "compiling"`. `completePdfJob` does it a third time. Fix: split
     the volatile status/progress record from the immutable payload record.
   - **Panel-side retention.** `prepared` and `bundle`
     (`packages/pdf/src/run-export.ts:241-242`) stay in scope through compile,
     validate *and* download, though they are dead after `putPdfJob`. Fix:
     release explicitly once the job is stored.
   - Minor: the FNV-1a byte scan runs twice per asset (`prepare.ts:177` and
     again inside `budget.account` → `asset-budget.ts:83-91`); `download.ts:19`
     copies the PDF once more into the Blob store.

   **Seam: `PdfBytesHandle` instead of raw `Uint8Array`.** The cross-layer
   contract stops passing byte arrays and passes a handle (`size`, `asBlob()`,
   `asUint8Array()`, `objectUrl()`). Chrome stores IndexedDB `Blob` values
   out-of-line rather than structured-cloning them into the JS heap, so a
   handle-shaped cache costs almost no heap, survives a panel close, and makes
   `URL.createObjectURL()` O(1) — exactly what both the preview cache (T5.3)
   and retained background jobs (T5.6) need, and it removes the extra copy
   `download.ts:19` makes today. **Two assumptions here are unverified and gate
   the design**: (i) that Chrome IDB Blobs really behave out-of-heap under this
   access pattern, and (ii) that PDF.js range-/chunk-loads from a `blob:` URL
   rather than buffering it whole. Both are measured in T5.6's first task; if
   either fails, the handle seam still stands but the storage format decision
   reverts to `Uint8Array` and is recorded as such.

   **Scope honesty:** several of these live in `packages/pdf`, not
   `apps/extension/`. That stretches this folder beyond pure host integration.
   It is deliberate — the fixes are prerequisites for T5.3/T5.6 in this same
   folder, and splitting them out would put the seam and its only consumer on
   separate review cycles. The folder's standing rule is unchanged and still
   binding: **no extension-only engine logic** — every change here is made in
   the shared engine so the CLI benefits too, never as a panel-local
   workaround.
10. **Track 2 / Forge constraints on the seam (informative, not implemented
    here).** The `PdfBytesHandle` seam is designed against a second host that
    does not exist yet, so its limits belong on record now. Published Forge
    limits: frontend→backend invocation payload **500 KB**, backend→frontend
    response **5 MB**, KVS value **240 KiB** with the docs explicitly advising
    against storing files, function memory 1024 MB (legacy runtime 128 MB),
    sync timeout 25 s / async 900 s. **Consequence: a PDF cannot flow through a
    Forge backend resolver at all** — not "slowly", but structurally: the 5 MB
    response ceiling and the absent blob store rule it out. A Forge app must
    therefore compile in the user's browser (Custom UI), exactly as the
    extension does — which is precisely why the shared engine and this seam are
    the right investment. Two questions gate that and should be answered
    **before** any Track 2 architecture is planned, not after: (i) does the
    Forge Custom UI CSP permit `wasm-unsafe-eval`, and (ii) does a ≥ 20 MB
    Typst WASM artifact fit the Custom UI static-resource bundle limits? If
    either is no, the only remaining path is Forge Remote (an operated backend)
    with entirely different cost and data-protection implications. Note also
    that the Chrome side panel survives Confluence navigation whereas a Custom
    UI iframe does not — CONFCLOUD-83694 is *harder* on Forge than in the
    extension, and T5.6's solution does not port. Nothing here is implemented
    in this folder.

## Tasks

### Phase 0 — App-layer extraction & UI foundation (blocks T5.1–T5.6)

**Landing order is normative.** T5.1–T5.6 add five new components
(`ScopeSection`, `SettingsForm`, `PdfPreview`, `JobsSection`, plus the
`TemplateSection` rebuild). Written before Phase 0 they land in the panel shape
and are rewritten afterwards. Phase 0 therefore ships first, on its own PR.

**Goal:** the side panel stops being a dev PoC and becomes an application whose
logic is host-neutral — the same layer a Forge app can host without Chrome APIs.

**What the code already gives us.** The `utils/` layer is effectively
chrome-free already: of 13 files matching `chrome.`, all but one are comments
or doc strings; the single runtime call
(`utils/pdf/compile-port.ts:35` `sendMessage`) is already an injectable
default. The contamination is concentrated in `entrypoints/sidepanel/App.tsx`,
which calls `chrome.runtime.getManifest()` at **module scope** (`App.tsx:33`) —
making the module unimportable outside an extension. That is why no test
imports `App`, `PdfSection` or `TemplateSection`, while the presentational
sub-components (`PdfReportView`, `ScanView`, `ReportView`) *are* tested. The
portable/non-portable line already exists empirically; Phase 0 makes it
explicit and moves it up.

**Seams are adopted, not invented.** `~/code/rovo-skills/forge-export-app/SPIKE.md`
already names them: `ConfluenceExportReader` (`getPage`, `getAttachment`,
optional `getSpace`/`getCurrentUser`/`getPageOwner`), a `compile(bundle, signal)`
compiler contract, and `ExportRequestV1`/`ExportJobV1`/`JobState`/`JobStage`.
`@atlcli/docx` already exposes `TemplateSource`/`AssetFetcher`/`SvgRasterizer`/
`OutputSink`. **Caveat: none of that research was ever spiked** ("kein
implementierter Nachweis") — the seams are adopted as naming and shape, not as
proven contracts.

**Acceptance criterion** (= SPIKE.md hypothesis H4, operationalized): the whole
app renders and completes an export in a happy-dom test **with `chrome`
undefined**. If that is green, the Forge port is mechanical; if it is not, no
amount of abstraction helps.

- [x] **UI foundation.** Tailwind in the WXT/Vite build, shadcn/ui
      (`components.json`, path aliases, `globals.css` with the CSS-variable
      theme), `lucide-react`. Dark mode comes from shadcn's variable theming —
      it closes the PoC gap at no extra cost. Components live in
      `apps/extension/` and are **host code**: per `PRODUCT-SHAPE.md` the Forge
      app's surfaces are content action / byline modal / global page, never a
      sidebar, so there is **no shared UI package** — sharing happens at the
      contract layer. Verify Radix/Tailwind output does not trip
      `check-output-build.ts`'s `DYNAMIC_CODE_RES`; if it does, question the
      dependency before relaxing the gate (Architecture point 8 — note the
      gate ended up **not** being relaxed at all, so there is no existing
      exemption to widen; any relaxation would be the first).
      *(Shipped: `apps/extension/components.json` — shadcn `new-york`,
      `cssVariables: true`, `iconLibrary: "lucide"`, css `assets/globals.css`;
      `tailwindcss` + `@tailwindcss/postcss` ^4.3.3 and `lucide-react` in
      `apps/extension/package.json`; `components/ui/{button,card,alert,field}.tsx`.
      `DYNAMIC_CODE_RES` is untouched — `scripts/check-output-build.ts:87`.)*
- [x] **i18n from the first component**, DE + EN. A typed message dictionary
      plus React context — deliberately **not** `chrome.i18n`, which would not
      port. Retrofitting i18n later would touch every component; the design's
      settings screen has a language selector, so it is a requirement, not a
      nice-to-have.
      *(`apps/extension/utils/i18n/messages.ts` — `LOCALES = ["en", "de"]`,
      `MessageKey` derived from the `en` catalogue; `utils/i18n/context.tsx`
      (`useT`); `tests/i18n.test.ts` — "`de` has exactly the English key set —
      no missing, no stale". Language selector: `components/screens/SettingsScreen.tsx`,
      asserted by `tests/app-portability.test.tsx` — "switching the language
      preference re-renders the whole app".)*
- [x] `PageContextSource` port (new): "which page am I on?" — the one genuinely
      new seam. The extension implements it over `tab-observer.ts` /
      `detection-pull.ts` / `chrome.windows.getCurrent`; a Forge host would
      receive the page from the platform instead of discovering it. This is
      what removes detection logic from the view layer.

      **Shipped, but not as a named port.** There is no `PageContextSource`
      interface: the seam is the single method `AppPorts.watchPageContext`
      (`apps/extension/utils/ports/index.ts:64`, `PageContext` = the existing
      `EntityDetection` minus `windowId`), implemented for Chrome by
      `entrypoints/sidepanel/ports/page-context.ts#watchChromePageContext`
      (`chrome.windows.getCurrent` + the tab observer's `seq`, plus a
      focus/visibility re-pull). The reasoning is recorded at
      `utils/ports/index.ts:24-29`: URL → entity is already
      `extractEntityFromUrl` and URL → profile is already `profileFromTabUrl`,
      so only the *subscription* was missing. The effect the task asked for —
      no detection logic in the view layer — holds either way.
- [x] ~~`ConfluenceExportReader` port (adopt SPIKE.md's shape): the portable read
      seam. The extension implements it over `ConfluenceClient`; a Forge host
      would implement it over its own transport.~~ **Deliberately NOT declared —
      superseded by an audit of the isomorphic base.**
      `utils/ports/index.ts:8-22` records the finding: every
      read this port would have carried already has a seam —
      `getSpace`/`getCurrentUser`/`getPageOwner` are `ResolveDeps`
      (`packages/docx/src/resolver.ts`), attachment bytes are `AssetFetcher` /
      `PdfAssetResolver`, attachment metadata is `AttachmentLookupPort`
      (`@atlcli/export-macros`), tree reads are `TreeSource`
      (`@atlcli/confluence`). The only uncovered slot was loading the root page
      for the panel, which shipped as the single function `AppPorts.loadPage`
      (`utils/ports/index.ts:75`), following the base's own idiom of a
      structural type next to the consumer rather than a named interface. The
      *property* the task was for still holds: the portable cut sits above
      `ConfluenceClient`, and the Chrome binding lives in
      `entrypoints/sidepanel/ports/index.ts`. The caveat below stands unchanged
      — T5.4 does wire macro ports directly onto
      `ConfluenceClient`/`JiraClient`, which is correct for the extension and
      does not port. Original wording, retained for review history:
      **`packages/confluence/src/client.ts`
      is explicitly "nicht direkt verwenden" for Forge** (profile + session
      cookies), so the portable cut must sit *above* the client — note that
      T5.4 wires macro ports directly onto `ConfluenceClient`/`JiraClient`,
      which is correct for the extension but does not port.
- [x] **Naming collision to resolve:** `PdfCompilerHost` already exists as the
      Chrome worker FIFO class (`utils/pdf/compiler-host.ts:30`), while
      SPIKE.md uses the same name for the abstract `compile(bundle, signal)`
      contract. These are different things at different layers. Decide once:
      either rename the existing class to its adapter role
      (e.g. `ChromeWorkerCompilerHost`) and let the seam take the generic name,
      or give the seam a distinct name. Do not ship both meanings.
      *(Resolved the first way: the class is `ChromeWorkerCompilerHost`
      (`apps/extension/utils/pdf/compiler-host.ts:134`, rename recorded at
      `:89-90`), constructed in `entrypoints/offscreen/main.ts:13`; no
      `PdfCompilerHost` identifier survives anywhere in the repo, so the seam
      name is free.)*
- [x] **Keep DOCX and PDF independently swappable.** SPIKE.md documents a
      conditional GO where PDF-WASM fails in Forge while DOCX works, leaving
      "Browserbasis nur DOCX". The port boundary must therefore not force a
      shared path between the two engines.
      *(`AppPorts.pdf: PdfExportPort | null` / `AppPorts.docx: DocxExportPort | null`
      — `utils/ports/index.ts:78-80` — plus the `"pdf-export"` / `"docx-export"`
      entries of `HostCapability` (`utils/ports/host.ts:20-22`). Asserted by
      `tests/app-portability.test.tsx` — "keeps the two engines independently
      swappable" and "hides the Word panel for a host with no template storage".)*
- [x] `App.tsx` split: a portable `<ExportApp ports={…} />` plus a thin
      sidepanel shell that wires the Chrome adapters. `getManifest()` moves out
      of module scope and becomes an injected value.
      *(`entrypoints/sidepanel/App.tsx` is now 21 lines —
      `const [ports] = useState(createChromePorts)` → `<ExportApp ports={ports} />`;
      the app lives in `components/app/ExportApp.tsx` + `AppShell.tsx`. The
      manifest read is injected as `HostInfo.name`/`HostInfo.version`
      (`utils/ports/host.ts:40-43`), built inside `createChromePorts`
      (`entrypoints/sidepanel/ports/index.ts`).)*
- [x] `PdfSection.tsx` / `TemplateSection.tsx`: from effect owners to port
      consumers. Their presentational parts are already separated and tested —
      keep those tests green through the move.
      *(Both files are now compatibility re-exports only —
      `entrypoints/sidepanel/PdfSection.tsx` (14 lines) re-exports
      `components/export/PdfReportView.tsx`, `TemplateSection.tsx` (21 lines)
      the DOCX views — so `tests/pdf/report-view.test.tsx` and
      `tests/docx/{scan-view,report-view}.test.tsx` kept passing unchanged. The
      rendering moved to `components/export/{PdfExportPanel,DocxExportPanel}.tsx`;
      the effects moved to `entrypoints/sidepanel/ports/{pdf,docx}.ts` and
      `components/app/export-runs.tsx`.)*
- [x] **Screen registry — the actual Phase 0 deliverable.** The design
      screenshots are **orientation, not specification**. What must be right is
      the *shell model*: adding a screen is a registry entry, never an edit to
      the shell. Each screen declares `id`, label key (i18n), icon
      (lucide), component, and its **requirements** — does it need a loaded
      page? does it need a host capability (e.g. durable jobs)? The nav renders
      from the registry; screens whose requirements are unmet are hidden or
      disabled with a reason, not silently broken.

      This is also the portability seam that matters most: **screens are
      portable units, the shell that arranges them is host code.** The
      extension arranges them as a sidebar with BEREICHE navigation; a Forge
      host mounts a subset — likely only Export — inside a content-action
      modal or global page, with no nav at all. Same screens, different shell.
      It is what makes `PRODUCT-SHAPE.md`'s "no sidebar in Forge" a
      non-event instead of a rewrite.

      It also gives T5.3's preview a home without special-casing: the inline
      preview is a screen, and the "large preview" tab page
      (`entrypoints/preview/`) is the *same screen* mounted by a different host
      shell — not a second implementation.
      *(`apps/extension/utils/screens/registry.ts` — `ScreenDefinition`
      (`id`, `labelKey`, `icon`, `component`, `requirements`, `whenUnmet`),
      pure `resolveScreens` / `pickActiveScreen` / `requirementReasonKey`.
      `components/app/ExportApp.tsx:118-125` resolves the registry and
      `components/app/AppShell.tsx` renders the nav from `ResolvedScreen[]`
      alone — it imports no screen and knows no screen id (`AppShell.tsx:4-10`,
      `:16`). Covered by
      `tests/screens.test.ts` ("disables — but keeps visible — a screen whose
      capability is missing") and `tests/app-portability.test.tsx` ("renders one
      nav entry per visible screen and opens the requested one", "mounts only
      the screens a host registers").)*
- [x] **Screens shipped in Phase 0:** **Export** (today's functionality,
      rebuilt) and **Einstellungen**. Registered-but-empty routes for
      Template-Sets, Aktivitäten, Über so the registry is exercised by more
      than one real screen. **Chat is out of scope** — it is not planned for
      the extension sidebar for now; the registry must simply not make it
      awkward to add later. Preview joins as a screen in T5.3.
      *(`components/screens/index.ts` registers export / preview / templates /
      activity / settings / about; `tests/screens.test.ts` — "registers Export,
      Preview, Templates, Activity, Settings and About". **Diverges upward**:
      the three placeholder routes are no longer empty — Templates is the real
      T5.2 library (`TemplatesScreen.tsx`), Activity is the real T5.6
      `JobsScreen.tsx`, and Preview is the real T5.3 screen. Chat is absent, as
      planned.)*
- [x] **Debug UI leaves the main surface.** `DebugSection`
      (`App.tsx:390-448`, Ping / WASM smoke) and the "Markdown preview (debug)"
      dump (`App.tsx:311-329`) are removed from the export surface. The Ping and
      WASM round-trips are already covered by `tests/wasm-smoke.test.ts`,
      `tests/router.test.ts` and `tests/listeners.test.ts`, so the buttons are
      redundant with automated coverage rather than load-bearing. A later Labs
      screen (the design reveals developer flags after five clicks on the
      version) is the eventual home for anything that must come back — it is
      **not** a Phase 0 screen, so nothing here depends on it existing.
      *(No `DebugSection` identifier survives in `apps/extension/`; the
      markdown dump's removal is recorded at
      `components/export/PageSummary.tsx:4`. Asserted by
      `tests/app-portability.test.tsx` — "the debug surface is gone > renders no
      Ping / WASM-smoke buttons and no markdown dump".)*
- [x] **The gate test:** `apps/extension/tests/app-portability.test.tsx` (new)
      — render the app and drive an export to completion under happy-dom with
      `globalThis.chrome` deleted, using fake ports. This is the Definition of
      Done for Phase 0 and the standing regression against re-coupling.
      *(Shipped at exactly that path: "renders the whole app with
      globalThis.chrome deleted", "drives a PDF export to completion and shows
      the report", "drives a DOCX export to completion over the stored
      template". The deletion is re-asserted after the export, so a test that
      restores the global cannot pass silently.)*

**Open in Phase 0:** Tailwind v3 vs v4 — the design preview will be integrated
later and should decide it; v4 (CSS-first config) is the working assumption and
is a single-file change if the preview turns out to be v3.
*(Settled as v4: `tailwindcss` and `@tailwindcss/postcss` are both `^4.3.3` in
`apps/extension/package.json`, and `components.json` carries an empty
`tailwind.config` — the CSS-first setup.)*

### Scope UI (T5.1)

- [x] `apps/extension/utils/confluence/tree-source.ts` (new): session-backed
      `TreeSource` adapter (`getPage`, `getChildren` in UI order,
      `getSpaceHomepageId`, `searchPages` for CQL label batches), built on
      `profileFromTabUrl` + `ConfluenceClient` from `@atlcli/confluence/browser`
      (pattern: `utils/read-path.ts`). Every method takes the export
      `AbortSignal`.
      *(Shipped at that path — `sessionTreeSource` / `sessionTreeSourceForProfile`
      / `combineAbortSignals`, wrapping folder 002's own
      `confluenceTreeSource(client)` rather than redeclaring the port. Covered
      by `tests/confluence/tree-source.test.ts`: "produces UI order end-to-end
      through fetchExportTree", "rejects every method on an already-aborted
      export signal, without any request", "classifies an expired session's
      login bounce instead of following it".)*
- [x] `apps/extension/utils/scope-state.ts` (new): pure reducer for the scope
      form (kind page/tree/space, `maxDepth`, include-root, label include/
      exclude chips, parse/normalize of comma-separated label input) —
      testable without DOM, mirroring `utils/panel-state.ts`.
      *(Shipped at that path — `reduceScope`, `parseLabelInput`, `clampDepth`,
      `toExportScope`, `toLabelFilter`, `scopeIdentity`; `tests/scope-state.test.ts`
      ("is identity-preserving for a no-op transition", "produces exactly what
      the shared normalizer produces").)*
- [x] `apps/extension/entrypoints/sidepanel/ScopeSection.tsx` (new): scope
      radio (Current page / Page + children / Entire space — space option
      enabled when `LoadedPage.details.spaceKey` is present), depth selector,
      and an "Advanced" `<details>` with two label tag inputs
      (include/exclude, OR semantics, `excludeMode` default `prune-subtree` —
      copy explains "excluded pages take their children with them"). Renders a
      page-count confirmation ("212 pages, continue?") before space exports.
      *(**Path moved by Phase 0**: screens are portable units, so this is
      `apps/extension/components/export/ScopeSection.tsx`, with the
      confirmation split out as `components/export/SpaceExportConfirm.tsx` over
      the optional `AppPorts.countScopePages`. Covered by
      `tests/scope-section.test.tsx`: "starts on 'Current page' with the
      Advanced disclosure closed", "disables it — with a reason — when the page
      reports no space", "turns label input into a normalized OR filter with
      the prune-subtree default", "asks before a space export and names the
      page count", "still asks — with count-free wording — when the host cannot
      count".)*
- [x] `apps/extension/utils/pdf/run-export.ts`: accept
      `scope: ExportScope` + `labels?: LabelFilter`; call `fetchExportTree` →
      `composeChapters`; extend `sourceIdentity` with a scope+filter
      discriminator (today `pageUrl|id|version` — a tree export must never
      reuse a single-page cache identity); forward `onProgress`
      (`{ fetched, total, currentTitle }`) alongside the existing `onPhase`.
      *(`utils/pdf/run-export.ts` — `RunPdfExportInput.scope`/`.labels`/`.onProgress`,
      `pdfSourceIdentity` folding in `exportScopeIdentity`. The
      `fetchExportTree` → `composeChapters` call itself was factored into
      `utils/confluence/export-composition.ts` so the PDF and DOCX hosts cannot
      drift apart — a **divergence from the task's single-file wording**, taken
      deliberately (module docstring, `export-composition.ts:1-26`). Covered by
      `tests/pdf/run-export-scope.test.ts`: "hands the COMPOSED chapters to the
      neutral engine, in document order", "differs between a page export and a
      tree export of the SAME root", "forwards onProgress in document order,
      one tick per fetched body".)*
- [x] `apps/extension/utils/pdf/run-export.ts` + `apps/extension/utils/docx/env.ts`:
      key attachment fetches on `ref.pageId ?? rootPageId` once folder 002
      lands `ImageSource.pageId` (BASELINE-DESIGN A1, recommended variant).
      *(PDF half is where the task said: `utils/pdf/run-export.ts:318`
      (`const pageId = ref.pageId ?? rootPageId`). **The DOCX half landed in the
      shared engine instead of `utils/docx/env.ts`** —
      `packages/docx/src/export.ts:1755-1765` `assetRefFor`
      (`block.source.pageId ?? pageId`) — which is the folder's own "no
      extension-only engine logic" rule applied: the CLI needed the identical
      fix. `utils/docx/env.ts` only resolves the relative URL against the wiki
      base. Covered by `packages/docx/src/env.test.ts` (deep page → `/download/
      attachments/424242/`, root page → `/1/`) and
      `tests/pdf/run-export-scope.test.ts` — "an attachment without a page id
      falls back to the export root".)*
- [x] `apps/extension/entrypoints/sidepanel/PdfSection.tsx` +
      `TemplateSection.tsx`: consume the shared scope; progress line
      "Page 37/210: <title>" during `fetching`; Cancel keeps working mid-walk
      (signal reaches `fetchExportTree`, not only the compile — verify the
      `pdf:cancel` path still tears down queued jobs).
      *(Same Phase 0 path move: the consumers are
      `components/export/{PdfExportPanel,DocxExportPanel}.tsx` under one
      `ScopeSection`, driven by `components/app/export-runs.tsx`. Progress line:
      `tests/scope-section.test.tsx` — 'renders "Page n/total: title" while the
      walk reports progress'; one scope for both engines: "hands the identical
      scope to the PDF and the Word panel". Cancel reaching the walk:
      `tests/pdf/run-export-scope.test.ts` — "aborting mid-walk stops fetching
      and never reaches the compile port".)*
- [x] `apps/extension/utils/pdf/job-store.ts` budget hardening for multi-page
      bundles: pre-flight estimate, computed from `preparePdfDocument`'s
      already-deduped asset list (`packages/pdf/src/prepare.ts` — do **not**
      re-implement dedupe in the job store, see Architecture point 2), with
      an error that names the largest assets and suggests `maxDepth`/label
      filters instead of failing after a long fetch; keep
      `PDF_JOB_MAX_BYTES`/`PDF_STORE_MAX_BYTES` values (document why in the
      module comment).

      **Two of the three clauses shipped where planned; the third moved.**
      Caps kept and justified in the module comment
      (`utils/pdf/job-store.ts:39-47`, "Why the cap VALUES did not change") and
      the no-second-dedupe rule is stated (`:48-56`) *and* asserted
      (`tests/pdf/job-store.test.ts` — "never runs a second dedupe pass over the
      bundle it is handed"); rejection happens before any IDB write
      (`putPdfJob`, `job-store.ts:461`; test "rejects oversized input before
      writing"). ~~pre-flight estimate … instead of failing after a long
      fetch~~ — **there is no job-store-level pre-flight**. The
      offender-naming error is the shared engine's
      `AssetBudgetExceededError` (`packages/confluence/src/asset-budget.ts:62-80`
      — offenders sorted largest-first, message names the top five with their
      page ids and suggests `--max-depth` / a label filter / `--no-images`),
      raised from `AssetBudget.account` inside `preparePdfDocument`, i.e. still
      *after* the fetch, not before it. Both engines surface it identically
      (`packages/pdf/src/asset-budget-parity.test.ts`). The user-facing
      "don't spend minutes to then fail" property the clause asked for is
      therefore **not** delivered; the actionable error is.
- [x] `apps/extension/utils/pdf/compiler-host.ts`: make `timeoutMs` scale with
      job size (e.g. base 60 s + per-page increment carried in the job
      record) so a 200-page space compile is not killed as a hang.
      *(`utils/pdf/compiler-host.ts:69-73` — `PDF_COMPILE_BASE_TIMEOUT_MS`
      60 s, `PDF_COMPILE_PER_PAGE_TIMEOUT_MS` 1.5 s, `PDF_COMPILE_MAX_TIMEOUT_MS`
      15 min, applied by `timeoutFor(pages)`; the page count rides the job
      record. Tests: `tests/pdf/compiler-host.test.ts` — "scales with source
      pages from the documented base", "treats missing/absurd page counts as
      one page and clamps the ceiling", "arms the scaled timeout for the job
      actually being compiled".)*
- [x] Durable job survival across service-worker restarts (Architecture
      point 3): the panel's export flow re-attaches to a running/finished job
      by reading `job.status` from `atlcli-pdf` (`utils/pdf/job-store.ts`)
      instead of depending solely on the open `chrome.runtime.sendMessage`
      response reaching it; `background.ts` rebuilds any in-memory tracking
      (`activePdfJobs` and equivalents) from persisted job records on
      startup rather than assuming a fresh `0`; a job whose worker never
      reports back within its timeout is marked `failed` with a
      recoverable error, never left `queued`/`compiling` forever.
      *(`utils/jobs/watch.ts#watchPdfJob` polls the record
      (`PDF_JOB_POLL_MS` 750) instead of trusting the `sendMessage` reply;
      `utils/jobs/idle-gate.ts#createDurableIdleGate` +
      `job-store.ts#countInFlightPdfJobs` rebuild in-flight state from the
      records (wired at `entrypoints/background.ts:79-84`);
      `job-store.ts#failPdfJob` closes a past-deadline record. Tests:
      `tests/pdf/job-durability.test.ts` — "is still findable, and still
      finishes, after the in-memory state is rebuilt", "returns the compiled
      result even though the compile message is never answered", "ends the job
      failed at its deadline instead of leaving it compiling forever".)*

### Template library UI & migration (T5.2)

- [x] `apps/extension/utils/docx/template-store.ts` — **DB migration v1→v2**
      (`DB_NAME "atlcli-docx"`, `DB_VERSION` 1 → 2), split into two phases so
      no `await` ever happens inside the `onupgradeneeded` version-change
      transaction (IndexedDB auto-commits a `versionchange` transaction once
      control returns to the event loop with no pending request on it — an
      `await crypto.subtle.digest(...)` inside the handler, which is exactly
      what 007's planned `sha256Hex` helper is
      (`007-pdf-template-settings/PLAN.md:282-292`, wraps
      `crypto.subtle.digest`), would let the transaction go inactive mid-await
      and turn the follow-up `objectStore.put()` into a
      `TransactionInactiveError`):
      1. **Synchronous phase, inside `onupgradeneeded`** (no async calls):
         keep object store `templates` (keyPath `recordKey` — see
         Architecture point 4 for why `id`-as-primary-key doesn't work);
         read the legacy `"current"` record (if present) and rewrite it as a
         library entry with a placeholder `sha256: null, size: bytes.byteLength`
         and a `migrationPending: 1` marker: `{ recordKey:
         "<site>|docx|<templateId>|global", templateId: crypto.randomUUID(),
         displayName: name, engine: "docx", scope: "global", name, bytes,
         uploadedAt, sha256: null, size, migrationPending: 1 }` (v1 only
         ever stored DOCX templates, so `engine: "docx"` is safe; `<site>` is
         read from the ambient session profile at migration time, not from
         the record — see Open questions if no site is resolvable); delete
         key `"current"`; create indexes `engine`, `scope`, `spaceKey`,
         `migrationPending`; create object store `template-prefs` (keyPath
         `recordKey`, e.g. `<site>|<engine>|<spaceKey>`) for the active
         selection and per-template settings values.
      2. **Async backfill, after the upgrade transaction commits** (normal
         `readwrite` transaction, opened once the `onupgradeneeded`/`onsuccess`
         handler returns): for every record with `migrationPending: 1`,
         compute `sha256Hex(bytes)` and `size`, `put()` the completed record,
         clear the marker. Resumable by construction: if the panel is closed
         mid-backfill, the next open finds `migrationPending` records via the
         index and finishes them — no partial-hash record is ever presented
         as migrated.

         **Why `1` and not `true` (corrected 2026-07-20 — earlier drafts of
         this plan said `true`, which is a defect).** Booleans are **not valid
         IndexedDB keys**, and an index whose key path evaluates to an invalid
         key *silently skips the record* rather than erroring. An index over
         `migrationPending: true` would therefore always be empty, the
         interrupted-backfill lookup would find nothing, and the
         "resumable by construction" guarantee above would quietly not exist —
         while every test that seeds and reads records directly still passed.
         Use `1`/absent, never `true`/`false`.
      3. No data leaves IndexedDB — scan verdicts stay derived-on-read
         (existing invariant in the module docstring stays true for v2).
      4. Idempotent: opening at `DB_VERSION` 2 a second time (schema already
         current, no `migrationPending` records left) is a no-op.

      *(Shipped exactly as specified — `utils/docx/template-store.ts`:
      `DB_VERSION = 2`, `MIGRATION_PENDING = 1` (`:90`, with the
      invalid-key reasoning at `:66-68`), synchronous `upgradeSync` creating
      `templates` (keyPath `recordKey`) + the four indexes + `template-prefs`,
      and the post-commit backfill reading through `s.index("migrationPending")`
      (`:573`). Covered by `tests/docx/template-store-migration.test.ts`:
      phase-1 placeholder, phase-2 backfill, "resumes an interrupted backfill",
      "is a no-op on a second open at v2", "migrates an empty v1 database
      cleanly". Went **beyond** the plan: a slow-backfill/newer-upload race,
      two concurrent backfills, a blocked upgrade, and a site-agnostic sentinel
      when no session origin is resolvable are all covered too.)*
- [x] `apps/extension/utils/templates/library.ts` (new): adapt the v2 store to
      the folder-007 `TemplateLibrary` interface (`list(engine, spaceKey)`,
      sha256-verified `getBytes(entry)`); the store's IDB primary key is
      `recordKey` (`<site>|<engine>|<templateId>|<scope>|<spaceKey?>`, unique
      per physical upload — never reused across sites, so two Atlassian
      sites sharing a space key like `DOCSY` never collide, matching the
      `${site}|${key}` pattern `TemplateSection.tsx:56-66` already uses for
      its session cache); `resolveTemplate` from
      `packages/core/src/template-library.ts` matches on the separate
      `templateId` field (not `recordKey`) — a global entry and its
      space-scoped override of "the same" template share `templateId` but
      have distinct `recordKey`s, so both persist simultaneously and
      `resolveTemplate` picks the space one, identical to the CLI
      (`~/.atlcli/templates/` global vs. sync-dir space templates). "Assign
      to current space" creates a **new** entry carrying the source entry's
      `templateId` with `scope: "space"`/`spaceKey` set (never mutates the
      global entry's `scope` in place) so deleting the space override leaves
      the global entry intact for `resolveTemplate` to fall back to.
      *(`utils/templates/library.ts#idbTemplateLibrary` — `list`, sha256-verified
      `getBytes` (throws `TemplateIntegrityError`), `resolve` delegating to
      `resolveTemplate` from `@atlcli/core` (`:408`), `assignToSpace` creating a
      new row. Covered by `tests/templates/library.test.ts`: "keeps a global
      entry and its space override as two rows and resolves the space one",
      "leaves the global entry resolvable after the space override is deleted",
      "keeps two sites that share a space key completely independent".)*
- [x] `apps/extension/entrypoints/sidepanel/TemplateSection.tsx`: replace the
      single-slot UI with a library list (name, scope badge Global/Space,
      uploaded date, scan verdict re-derived on read), actions upload / set
      active / assign to current space / delete; sha256 mismatch on
      `getBytes` is a hard "template was modified — re-upload" error, never a
      silent fallback (BASELINE-DESIGN B2 UX). **Scope**: DOCX template bytes
      only (upload/swap) — this is the "library" the folder's Goal section
      promises. PDF keeps `PdfSection.tsx`'s existing "no template upload
      required" copy; do not add a PDF template upload control (see
      Architecture point 4 and Dependencies — 007's Level-B render path for
      custom Typst templates does not exist yet).
      *(**Path moved by Phase 0**: the list is
      `components/export/TemplateLibraryPanel.tsx`, hosted by
      `components/screens/TemplatesScreen.tsx`;
      `entrypoints/sidepanel/TemplateSection.tsx` is now a 21-line
      compatibility re-export. Covered by `tests/template-library.test.tsx`:
      "lists name, scope badge and upload date, and marks the active entry",
      "classifies the stored bytes on demand" (verdict re-derived, never
      persisted), "refuses the bytes and tells the user to re-upload" (sha256
      mismatch), "keeps the global row untouched and lets the override win,
      then fall back", "offers no PDF template upload — only .docx".)*
- [x] `apps/extension/entrypoints/sidepanel/SettingsForm.tsx` (new): generic
      form renderer over the template-manifest settings schema
      (`text | boolean | choice | color | number | asset` — folder 007 / B10);
      values persisted per template in `template-prefs`; feeds
      `RunPdfExportInput.settings` (**PDF only for v1** — folder 007 threads
      `settings` through `packages/pdf`; no folder threads an equivalent
      `ExportInput.settings` through `packages/docx`, see Dependencies). The
      DOCX branch of this task (settings defaults applied to `ExportInput`)
      is **out of scope until a DOCX-side settings seam lands** — track as a
      prerequisite folder/task under crossPlanImpacts rather than building
      `as any`-typed wiring against a field `ExportInput` doesn't have; ship
      the PDF form and leave the DOCX template's manifest settings
      (if any) informational-only in the panel for v1. Presets are out of
      scope here (folder 007 owns preset storage semantics — Open questions).
      *(**Path moved by Phase 0**: `components/export/SettingsForm.tsx`, with
      the schema projection in `components/export/settings-schema.ts` and the
      engine hand-off in `components/export/pdf-settings.ts#toPdfSettings`.
      "Informational-only for DOCX" shipped concretely as a `readOnly` render
      plus the message `settingsForm.readOnly` ("…the Word engine cannot apply
      them yet — shown for information only"), so a DOCX manifest's settings are
      visible but not editable. Covered by `tests/settings-form.test.tsx`:
      "declares exactly one widget of every supported type", "renders text,
      boolean, choice, color, number and asset controls", "readOnly disables
      every control and says why — the DOCX branch", "hands the resolved
      settings to the PDF export request", "**never writes `settings` onto a
      DOCX export request**", "round-trips values through the real
      template-prefs store". No preset UI, as planned.)*
- [x] `apps/extension/utils/docx/env.ts`: `idbTemplateSource` resolves through
      the library (active entry for engine+space, via `template-prefs`'s
      `recordKey`) instead of the literal `"current"` slot; keep
      `memoryTemplateSource` re-export untouched.
      *(`utils/docx/env.ts:63-90` — `idbTemplateSource` builds
      `idbTemplateLibrary({ factory, siteOrigin })`, falls back to
      `getActiveTemplateId(engine, spaceKey)` for an empty id or the retired
      `"current"` name, then `library.resolve(...)` → `library.getBytes(entry)`;
      `memoryTemplateSource` untouched. Covered by `tests/docx/env.test.ts`:
      "resolves the active selection when no explicit id is given", "lets a
      space-scoped override beat the global entry of the same templateId",
      "rejects when the requested templateId is not in the library".)*

### PDF preview (T5.3)

- [x] `apps/extension/utils/pdf/compiler-host.ts`: add a `kind: "preview" |
      "export"` tag to queued/active jobs. Export always jumps ahead of any
      queued preview in `pump()`. A superseded/obsolete **preview** is
      abandoned cooperatively (its promise resolves with a
      "superseded" result once the in-flight compile finishes; the result is
      discarded by the caller) rather than cancelled through the
      worker-terminating path — `cancel()`'s `destroyWorker()` branch
      (`compiler-host.ts:52-67`) is reserved for a **user-initiated export
      cancel**, never fired by preview churn, so `compilerPromise`
      (`workers/pdf-compiler.ts`) survives every debounced preview and the
      export that follows it stays warm. Test: rapid preview→preview→export
      sequence creates exactly one worker instance.
      *(`utils/pdf/compiler-host.ts` — `PdfCompileJobOptions.kind` (default
      `"export"`), `takeNext()` picking the first queued export (`:251-256`),
      `supersedePreviews()` never touching the worker (`:226-239`),
      `PREVIEW_SUPERSEDED_ERROR` / `isPreviewSupersededError` (`:27-33`); the
      contract is written out at `:97-123`. Tests, all in
      `tests/pdf/compiler-host.test.ts`: "creates exactly ONE worker across a
      rapid preview → preview → export sequence", "lets an export queued behind
      an in-flight preview jump ahead of a queued preview", "cancelling an
      active preview does NOT terminate the worker", "cancelling an active
      EXPORT still terminates the worker (user-initiated abort)", "defaults an
      untagged compile to `export` so it is never superseded".)*
- [x] ~~**First task, blocking the viewer choice — verify the CSP claim
      empirically.**~~ **Dropped by the plan owner, 2026-07-20.** The experiment
      would have decided nothing: PDF.js is the choice either way (zoom /
      fit-width, cross-browser parity, controllable surface). Rather than leave
      an unverified factual claim standing as the stated rationale, the claim
      itself was **removed** from Architecture point 5, which now argues
      positively and no longer depends on `<embed>`/`object-src` behavior at
      all. Consequence for implementers: **do not** build an `<embed>` fallback
      path, and do not re-introduce the "blocked by `object-src 'self'`"
      assertion into docs or code comments — it is unverified.
- [x] `apps/extension/utils/pdf/preview.ts` (new): `runPdfPreview(input, deps)`
      — same pipeline as `runPdfExport` but (a) **scope-dependent truncation**:
      `scope: page` compiles the full document (the CONFCLOUD-84742 case — a
      partial preview of one page defeats the purpose); `tree`/`space` truncate
      to a first-N-**chapters** budget (slice of the composed chapter list, N
      default 5, labelled honestly in the UI as "Preview — first N chapters" —
      not "pages": a single source page can compile to many PDF pages, and
      `pageCount` is only known post-compile via `validatePdfOutput`
      (`packages/pdf/src/run-export.ts:161,178`), so the panel cannot promise
      an actual page count before compiling), with an additional block-count
      and asset-byte ceiling on the truncated slice so one pathological
      chapter (huge table, many images) still bounds preview compile time
      even though it counts as "1" against the chapter budget; (b) `output`
      is a capture sink returning bytes instead of `downloadBytes`, (c)
      reuses `extensionPdfCompilePort`/`kind: "preview"` so the compile rides
      the warm worker per the coalescing contract above; (d) the result
      carries `truncated: boolean` so the cache and Download can act on it.
      *(Shipped at that path as scope-specific entry points:
      `runPagePdfPreview` (never truncated), `runScopedPdfPreview` (threads the
      Studio's selected scope/labels through the real extension export host and
      selects the bounded node prefix only after the shared tree walk), and
      `runComposedPdfPreview` (takes a `PreviewTruncationPlan`). A regression
      found on 2026-07-22 had left `PreviewScreen` hard-wired to page scope even
      though the form held a tree scope; the screen now calls the scoped entry
      point, and the large tab reads the exact current single-slot bytes instead
      of reconstructing the transient sidebar scope. Truncation is the pure
      `planPreviewTruncation` over `DEFAULT_PREVIEW_BUDGET`
      (chapters + `maxBlocks` + `maxAssetBytes` backstops, `:72-102`); capture
      sink is `capturePdfOutput` (`:298`); the result carries `truncated`,
      `includedChapters`, `totalChapters`, `reason`. Tests in
      `tests/pdf/preview.test.ts`: "compiles the WHOLE document for scope: page
      — the CONFCLOUD-84742 case", "stops on the block backstop before the
      chapter budget is reached", "stops on the asset-byte backstop", "always
      keeps the first chapter, even when it alone busts every backstop", "keeps
      the handle instead of downloading it", "runs the REAL export pipeline with
      a capture sink and a preview-tagged port", and "threads Page + children
      into the preview request instead of falling back to the root".)*
- [x] `apps/extension/utils/pdf/preview-cache.ts` (new): stores the most recent
      successful preview's bytes keyed on `sourceIdentity` + a hash of the
      resolved settings, with the `truncated` flag alongside. `getReusableBytes`
      returns bytes **only** for a non-truncated entry whose key matches the
      current export request exactly — a truncated entry is viewer-only and
      Download must fall through to a full compile (Architecture point 5).
      Entries follow the existing job lifecycle (`finally` deletion, same store
      budget) so preview traffic cannot grow the IndexedDB footprint.
      *(`utils/pdf/preview-cache.ts` — key is
      `sourceIdentity · settingsHash · treeVersionHash` (`previewCacheKey`,
      `:152`), single-slot store `atlcli-pdf-preview`;
      `getReusableExportBytes` returns `undefined` for a truncated entry
      (`:313`) while `getPreviewEntry` still serves the viewer.
      **Beyond plan**: a third key component, `treeVersionHash`, was added
      because `sourceIdentity` carries only the *root* page's version, so a
      changed child page would otherwise have served stale bytes (`:21-31`).
      Tests in `tests/pdf/preview-cache.test.ts`: "Download must NOT reuse a
      truncated entry, but the viewer may read it", "changes the tree hash when
      a CHILD page's version changes", "hashes different settings to different
      keys", "expires an entry older than the job horizon and drops it from
      storage".)*
- [x] **Preview is a screen, registered in Phase 0's screen registry** — not a
      panel-local component and not two implementations. `utils/pdf/viewer.ts`
      (new) holds the PDF.js viewer over the captured `Uint8Array` via
      ~~`getDocument({ data })` — no `blob:` URL~~. Constructed **once** with
      `isEvalSupported: false` (asserted by test, Architecture point 8) and a
      locally bundled `GlobalWorkerOptions.workerSrc`; both viewer and worker
      behind a dynamic `import()` so a session that never opens the preview
      never parses them. Renders only visible pages and caps canvas resolution
      (device-pixel-ratio ceiling) so a dense page cannot blow up memory.
      Compile diagnostics render inline on failure. The screen declares its
      requirement (a compiled or cached preview result) so the registry can
      surface it correctly when unmet.

      **The `data`-not-`blob:` clause was inverted during implementation, and
      the plan was wrong.** `getDocument({ data })` may **transfer** the passed
      buffer to the PDF.js worker, detaching it. Since T5.6 the bytes arrive as
      a `PdfBytesHandle` whose `asUint8Array()` returns the handle's *borrowed*
      backing array, so handing it to `data` would leave the handle — and
      therefore Download — holding a zero-length view. `pdfjsSourceFor`
      (`utils/pdf/viewer.ts:221`) therefore hands PDF.js a `blob:` URL, which
      PDF.js fetches and never detaches, and falls back to `data` **with an
      explicit copy** only when the runtime has no `URL.createObjectURL` (a
      non-browser test host). Nothing about the CSP rationale changes: the
      viewer is still `<canvas>` under `script-src 'self'`, and no `<embed>` /
      `object-src` question arises. Pinned by `tests/pdf/viewer.test.ts` —
      "hands PDF.js a blob: URL, never the borrowed array" and "falls back to a
      COPY — never the borrowed array — without createObjectURL". *(The rest as
      specified: single options site `PDFJS_DOCUMENT_OPTIONS` (`viewer.ts:103`,
      `isEvalSupported`/`enableXfa`/`useSystemFonts` all `false`, no
      `wasmUrl`/`cMapUrl`/`standardFontDataUrl`); `loadPdfjs` behind a dynamic
      `import()` of `utils/pdf/pdfjs-assets.ts` (`:176-180`);
      `MAX_DEVICE_PIXEL_RATIO` 2 and `MAX_CANVAS_PIXELS` ≈ 4096² (`:110-112`);
      the screen is `components/screens/PreviewScreen.tsx` with
      `previewScreenDefinition` declaring the `pdf-preview` capability and a
      loaded page — `tests/screens.test.ts`, "keeps Preview unavailable without
      a loaded page even with the capability".)*
- [x] The **same** preview screen is mounted by two host shells: the sidebar
      shell renders it compactly (current page, forward/back, fit-width, zoom)
      behind a "Preview" toggle so the common export click never pays a preview
      compile; a new `apps/extension/entrypoints/preview/` WXT page mounts it
      full-size in a tab as the "Open large preview" target, over the same
      cached bytes (`preview-cache.ts`). **No second compile path, no second
      viewer implementation, no new host permission** (asserted by
      `tests/manifest.test.ts`). If this task needs to fork the component per
      shell, the Phase 0 screen model is wrong and should be fixed there
      instead.
      *(`entrypoints/preview/{main.tsx,App.tsx}` mounts the very same
      `PreviewScreen` with a one-element `screens` array and a
      `PreviewShellContext` of `{ layout: "full", openLargePreview: null }`.
      Tests in `tests/preview-screen.test.tsx`: "offers 'open large preview' in
      the compact shell", "hides it in the full shell — that shell IS the large
      preview", "**both shells mount the very same component**", "opens the
      cached preview without compiling". No new permission —
      `tests/manifest.test.ts` still pins `permissions` to exactly
      `sidePanel, offscreen, storage, tabs`. **Divergence in the compact
      shell**: the gate is not a "Preview" toggle but an explicit "Generate
      preview" button plus an off-by-default "Update automatically" switch — see
      the debounce task below.)*
- [x] `apps/extension/scripts/check-output-build.ts` (build gate, Architecture
      point 8): **no exemption added — the premise was measured and is false.**
      `pdfjs-dist@6.1.200` contains zero `eval`/`new Function` tokens (v6 uses a
      WebAssembly PostScript evaluator) and no longer offers `isEvalSupported`,
      so an exemption would have loosened the gate against a threat that does
      not exist. Delivered instead: `.mjs` added to the scanned extensions (the
      vendored artifacts were previously invisible to **every** rule — a real
      pre-existing hole), both PDF.js artifacts sha256-pinned in
      `REQUIRED_PDF_ARTIFACTS`, vendored with `?url&no-inline` so the pins are
      stable and no rolldown chunk name is ever pattern-matched, and the module
      docstring records the measurement plus what would reopen the question.
      *(Verified: `scripts/check-output-build.ts:314`
      `SCANNED_EXTENSIONS = [".js", ".mjs", ".html"]`, `:294` `.mjs` joins the
      hashed set, `:117-126` both `pdf.min-*.mjs` / `pdf.worker.min-*.mjs`
      entries in `REQUIRED_PDF_ARTIFACTS`, `:87` `DYNAMIC_CODE_RES` carrying no
      exemption, measurement recorded at `:29-46`. Vendoring:
      `utils/pdf/pdfjs-assets.ts` imports both with `?url&no-inline`.)*
- [x] Debounce + coalescing: settings-form and scope changes trigger a
      preview recompile after ~400 ms of quiet; each new trigger supersedes
      the in-flight preview per the `kind: "preview"` coalescing rule above
      (**not** `pdf:cancel` → `PdfCompilerHost.cancel` — that path terminates
      the worker); preview jobs use the normal job store and are deleted in
      `finally` like export jobs (no budget creep). A user-initiated export
      click still goes through the real `AbortController` → `pdf:cancel` path
      when the user explicitly cancels an export.

      **Shipped, but auto-recompile is opt-in, not the default.** The debouncer
      exists and behaves as specified — `createPreviewScheduler` /
      `PREVIEW_DEBOUNCE_MS = 400` (`utils/pdf/preview.ts:500-512`), tests
      "coalesces a burst into one run after the quiet period", "cancel() drops
      the pending run entirely", "flush() runs the pending request immediately"
      — but `PreviewScreen.tsx:205` starts with `auto = false`, so nothing
      recompiles until the user turns "Update automatically" on or presses
      "Generate preview". That is stricter than the plan asked for and is what
      makes "the common export click never pays a preview compile" literally
      true (`tests/preview-screen.test.tsx` — "compiles nothing until the user
      asks"). Consequence for Open question 10: the "manual Refresh preview
      button instead of debounced auto-recompile" fallback is already the
      shipped default. Supersession never routes through `destroyWorker`
      (`compiler-host.ts:190-193`); preview jobs are deleted in
      `compile-port.ts:245`'s `finally` regardless of consumption.
- [x] `apps/extension/entrypoints/background.ts`: count `pdf:compile` traffic
      from previews as offscreen activity (reset `offscreenIdle`) so the warm
      worker is not torn down between debounced previews; verify the idle
      close still happens after the panel goes quiet.
      *(`utils/pdf/offscreen-activity.ts#createOffscreenActivityTracker`, wired
      at `entrypoints/background.ts:84` and used at `:151` (`touch()`),
      `:170`/`:186` (`begin()`/`end()` around a compile). Tests in
      `tests/pdf/offscreen-activity.test.ts`: "counts a preview compile as
      activity and re-arms the idle close afterwards", "survives a debounce
      pause: back-to-back previews never leave the timer armed while
      compiling", "does not re-arm under an overlapping job" — the second and
      third are the "idle close still happens" half.)*
- [x] Honest DOCX story: no fake Word preview. `TemplateSection.tsx` keeps the
      scan report (placeholder verdicts) as the DOCX "preview"; add one line
      of copy explaining why ("Word rendering happens in Word — the scan
      shows exactly what will be filled in"). No task may add an HTML
      approximation of the DOCX output.

      *(Implemented in `components/export/ScanView.tsx` behind the explicit
      `explainWordRendering` presentation flag, enabled only by
      `components/export/DocxExportPanel.tsx`. The English/German
      `docx.scan.previewExplanation` copy states that Word creates the final
      rendering and the scan reports which fields will be populated; compact
      template-library scans do not repeat it. Regression coverage:
      `tests/docx/scan-view.test.tsx` — "explains in English that the scan is not
      a simulated Word rendering", "ships the same explanation in German",
      "does not repeat the explanation in compact scan-only contexts". The
      actual panel connection is pinned by `tests/docx/export-panel.test.tsx` —
      "places the Word-rendering explanation beside the persisted template
      scan". The PDF-only `previewScreenDefinition` remains unchanged and no
      HTML DOCX approximation was added.)*

### Macro renderer wiring (T5.4)

- [x] **Prerequisite (owned by 004, verify only)**: 004's T1.10 now exports
      `packages/confluence/src/html-to-blocks.ts` from
      `packages/confluence/src/index.browser.ts` itself
      (`004-macro-renderer/PLAN.md:415-450,1053-1054`) — do not re-add it
      here, that would duplicate 004's own task. Verify, once 004 lands,
      that `html-to-blocks.ts` is on `BROWSER_ENTRYPOINTS` in
      `scripts/check-browser-build.ts` (add it here only if 004's task
      missed that specific check file) before wiring it into
      `defaultRegistry` below.
      *(Verified, and nothing had to be added here.
      `packages/confluence/src/index.browser.ts:25` —
      `export * from "./html-to-blocks.js"`. It is **covered transitively**
      rather than listed in its own right: `BROWSER_ENTRYPOINTS`
      (`scripts/check-browser-build.ts:68-87`) names
      `packages/confluence/src/index.browser.ts`, and the checker walks the
      import graph from each entrypoint, so the barrel drags `html-to-blocks.ts`
      into the gate. The extension consumes it through
      `@atlcli/export-wiring`'s `createMacroRegistry`, not a local
      `defaultRegistry`.)*
- [x] `apps/extension/utils/macros/session-ports.ts` (new): `JiraIssuePort`
      and `ExportViewPort` implementations built by **adapting
      `JiraClient`/`ConfluenceClient` constructed with a session profile**
      (`profileFromTabUrl`, the pattern `TemplateSection.tsx` already uses
      for `ConfluenceClient`) — not a raw `fetch()` reimplementation — so
      login-redirect detection (`assertNotAuthRedirect`,
      `packages/confluence/src/client.ts:198-217`, mirrored in
      `packages/jira/src/client.ts`) and 429 `Retry-After` exponential
      backoff (`client.ts:299-318`) are inherited rather than re-specified.
      `JiraIssuePort.getIssue`/`searchJql` call `JiraClient` against
      `<profile.baseUrl>/rest/api/3`; `ExportViewPort.renderMacroHtml(pageId,
      macroId)` calls `ConfluenceClient`'s v1 macro-body +
      contentbody-convert endpoints (BASELINE-DESIGN E1/E2). Both honor the
      export `AbortSignal`. Response taxonomy beyond the two clients'
      built-in handling: 403 → chain `skip` (permission note); 404 → chain
      `skip` (not-found note); 401 / auth-redirect (surfaced by
      `assertNotAuthRedirect` as a thrown error) → abort the live-macro
      resolution pass with a distinct "session expired — sign in again" note
      rather than degrading silently to placeholders page after page; 429
      after the client's own retries are exhausted, and 5xx → typed
      `degraded` note, chain continues to the next macro instance (never
      aborts the whole export for one flaky third-party app).
      *(Shipped at that path — `sessionJiraIssuePort` (`:333`),
      `sessionExportViewPort` (`:393`), `createSessionMacroPorts` (`:600`)
      building `new ConfluenceClient(profile)` / `new JiraClient(profile)` from
      `profileFromTabUrl`; `classifySessionPortError` (`:251`) holds the
      taxonomy and `createSessionMacroState` (`:149`) the session-expiry latch.
      Adapter-not-reimplementation is pinned structurally at `:118`
      (`const _jiraClientSatisfiesPort: JiraClientLike = {} as JiraClient`).
      Tests in `tests/macros/session-ports.test.ts`: "403 → chain skip with a
      permission note, export continues", "404 → chain skip with a not-found
      note", "429 exhausting the client's own retries → degraded note, chain
      continues", "5xx after the client's retries → degraded note, chain
      continues", "an opaque redirect stops further port calls and surfaces one
      distinct note", "the latch is emitted exactly once across many macros",
      "maps an issue through the client and issues no HTTP of its own".
      **Beyond plan**: the Jira half of `assertNotAuthRedirect` did not exist
      yet and was built here — `packages/jira/src/auth-redirect.ts` plus the
      shared `packages/core/src/session-redirect.ts` (see "shipped beyond
      plan"); and `ExportViewPort` batches every macro on a page into one
      request (`tests/…` — "batches every macro on a page into ONE export_view
      request") with a per-macro v1 fallback.)*
- [x] Per-source-page macro context: wire `packages/export-macros`'s
      `contextFor(block.sourcePage ?? ctx.page)` through unchanged when
      constructing the registry (see Architecture point 6) so a macro on a
      child page in a tree/space export resolves `ExportViewPort`/
      `AttachmentLookupPort` calls against *that* page's id, not the export
      root's. `002-scope-orchestration` now plans `unknown.sourcePage` (see
      Dependencies, crossPlanImpacts) — T5.4 is still gated on that task
      actually merging, not just being planned; do not default `contextFor` to
      the root page id as a stand-in; fail the task loudly (compile error or
      explicit `TODO` gate) if `sourcePage` is still absent when T5.4 starts,
      rather than shipping a version that silently mis-resolves child-page
      macros. Regression test: a tree/space export with a Jira/`export_view`
      macro on a **non-root** page renders against that page's id/space in
      both CLI and extension output (same assertion, two hosts).
      *(`unknown.sourcePage` did land, so no `TODO` gate was needed.
      `contextFor` is passed through unchanged in
      `utils/macros/session-ports.ts:683-710`
      (`buildSessionMacroResolutionOptions`), over the shared
      `@atlcli/export-wiring#buildMacroResolutionOptions`; the reasoning is at
      `session-ports.ts:667-669`. Tests: `tests/macros/session-ports.test.ts` —
      "resolves a child page's macro against THAT page, never the export root",
      "contextFor returns the page it was handed, verbatim"; and end to end in
      `tests/pdf/run-export-scope.test.ts` — "uses the macro's OWN page id,
      never the export root's", "the rendered body is the CHILD page's, and it
      reaches the compiler". The CLI half of the "two hosts" assertion is
      `apps/cli/src/commands/engine-parity.test.ts`; the DOCSY E2E half is
      **not** run — see the unticked E2E items below.)*
- [x] `ExternalAssetPolicy` wiring (Architecture point 6): implement the
      port once in `apps/extension/utils/macros/` — allow the active site's
      own origin plus explicitly configured Atlassian media origins, reject
      redirects to a disallowed origin and loopback/private/link-local
      targets, cap the fetched byte stream. Wire it into **both** asset
      resolvers: `utils/pdf/run-export.ts#pageResolver` currently throws
      unconditionally for `ref.kind === "external"`
      (`run-export.ts:126`) — replace the throw with an
      `ExternalAssetPolicy.allow()` check that degrades to a placeholder +
      report note on rejection instead of failing the whole export; and
      `utils/docx/env.ts#sessionAssetFetcher`, which today fetches any
      absolute URL with `credentials: "include"` and no allowlist
      (`env.ts:77-100`) — gate it the same way. Both engines must reach the
      same allow/reject decision for the same URL (shared policy fixtures in
      Tests).
      *(Implemented once, but **one level lower than planned**: the policy
      itself is the shared `packages/export-wiring/src/asset-policy.ts`, and
      `apps/extension/utils/macros/external-asset-policy.ts` is the thin
      extension binding (`ATLASSIAN_MEDIA_ORIGINS`,
      `extensionAssetPolicyFromPageUrl`, re-exporting the shared fetcher). That
      is the "no extension-only engine logic" rule again — the CLI needed the
      same policy. Wired into both resolvers:
      `utils/pdf/run-export.ts:338`/`:47-60` and `utils/docx/env.ts:21-26,266`.
      Parity is asserted over one shared fixture set
      (`packages/export-wiring/src/fixtures.ts`) from both sides —
      `tests/macros/external-asset-policy.test.ts` ("cross-host parity — the
      shared fixtures through the extension's policy", "the SSRF guard the
      extension uses is the shared predicate") and
      `tests/pdf/run-export-scope.test.ts` ("cross-engine policy parity over the
      shared fixtures", plus guard-the-guard cases proving an unwrapped resolver
      *fails* the assertion).)*
- [x] Wire the registry through the existing env seams: `ExportEnv.macros` in
      the DOCX path (`apps/extension/entrypoints/sidepanel/TemplateSection.tsx`
      export handler via `utils/docx/export-deps.ts`) and `PdfExportEnv`
      (`apps/extension/utils/pdf/run-export.ts`), with the renderer set from
      `packages/export-macros` (jira, diagram preview-PNG, `export_view`
      fallback) — one registry construction site per engine path, no
      extension-local renderer logic.
      *(One construction site per engine, as required, but the **DOCX site
      moved with Phase 0**: it is `entrypoints/sidepanel/ports/docx.ts:196-200`
      (`buildSessionMacroResolutionOptions` → `env.macros`, `:249`), not
      `TemplateSection.tsx`/`export-deps.ts`. PDF is where planned —
      `utils/pdf/run-export.ts:231,517,560`. Renderers come from
      `@atlcli/export-wiring#createMacroRegistry` over `@atlcli/export-macros`;
      no renderer logic lives in `apps/extension/`. Asserted by
      `tests/pdf/run-export-scope.test.ts` — "no PDF env construction site
      bypasses the router > runPdfExport is only ever handed extensionPdfAssets",
      "the PDF env resolves macros, through the session builder", "the DOCX host
      does the same, with its own router".)*
- [x] Progressive-disclosure toggle "Resolve dynamic macros (contacts
      Jira/Confluence)" in `ScopeSection.tsx`'s Advanced block, default ON;
      OFF yields deterministic exports (chain stops at native conversion +
      placeholder, report note `skipped-by-config`).
      *(`components/export/ScopeSection.tsx:249-256`
      (`data-testid="scope-resolve-macros"`), threaded as
      `resolveMacros === false → macros: { live: false }` in
      `entrypoints/sidepanel/ports/pdf.ts:52` and `ports/docx.ts:200`. Tests:
      `tests/scope-section.test.tsx` — "defaults the dynamic-macro toggle to
      ON", "turns macro resolution off, which is what makes an export
      deterministic"; `tests/macros/session-ports.test.ts` — "emits
      skipped-by-config without a single port call";
      `tests/pdf/run-export-scope.test.ts` — "`resolveMacros: false` makes no
      port call at all".)*
- [x] Report surfacing: `PdfReportView` (`PdfSection.tsx`) and the DOCX report
      view group the new note classes (`rendered-via`, `degraded`,
      `skipped-by-config`) so "3 macros rendered live, 1 degraded" is visible
      without expanding all notes.

      *(Implemented once in
      `components/export/MacroOutcomeSummary.tsx#summarizeMacroOutcomes` from
      the three exported canonical codes. Both `PdfReportView` and
      `DocxReportView` render the same compact, always-visible non-zero outcome
      counts above their retained detail notes. The labels deliberately count
      rendering outcomes rather than claiming unique macro instances because a
      renderer may emit more than one terminal note. Regression coverage:
      `tests/macro-outcome-summary.test.tsx`,
      `tests/pdf/report-view.test.tsx` — "surfaces macro outcomes before the
      collapsed detail notes", and `tests/docx/report-view.test.tsx` — "shows
      the same macro outcome summary while retaining level groups".)*
- [x] Verify `apps/extension/wxt.config.ts` host permissions cover the Jira
      REST calls on Cloud sites (`*://*.atlassian.net/*` — same origin) and
      assert it in `apps/extension/tests/manifest.test.ts`; no new
      permissions expected, fail the task if one becomes necessary (that is a
      review-worthy scope change).
      *(No new permission was needed: Jira Cloud REST is served from the same
      `*.atlassian.net` origin the manifest already grants
      (`wxt.config.ts:44-45`, unchanged host list), and
      `session-ports.ts:607-619` builds the `JiraClient` from the same tab
      profile as the `ConfluenceClient`. `tests/manifest.test.ts` pins both
      lists as exact sets — "declares the normative permissions"
      (`sidePanel, offscreen, storage, tabs`) and "declares atlassian.net +
      media-CDN host permissions" — so any addition fails the suite. **One
      manifest change did land**, and it is a *key*, not a permission:
      `action: {}`, required by T5.6's `chrome.action.setBadgeText`
      (`wxt.config.ts:36-41`).)*

### Durable background jobs & byte handling (T5.6)

Ordered: the measurement gates the storage decision, the two defect fixes are
independent of it, and the size-metadata split blocks the retention UI.

- [ ] **Measurement first (blocks the rest of T5.6).** Heap snapshot of a real
      image-heavy DOCSY tree export in the panel and the offscreen worker at
      the four suspected peaks (`job-store.ts:118` / `:200` `getAll`,
      `validate.ts:48` decode, `compiler.ts:60-63` VFS handoff,
      `download.ts:19` blob copy). Record actual numbers in this PLAN.
      Additionally verify the two assumptions Architecture point 9 flags: does
      a Chrome IDB `Blob` stay out-of-heap on `get()`, and does PDF.js
      chunk-load from a `blob:` URL? **If the numbers do not justify a change,
      write that down and drop the corresponding fix** — this task exists to
      prevent optimizing on suspicion.

      **Left unticked: a benchmark shipped, the measurement this task asks for
      did not.** What exists is `packages/pdf/scripts/bytes-memory.bench.ts` — a
      re-runnable harness covering all four suspected peaks as named scenarios
      (`validate-32`/`validate-64`/`live-whole`/`live-chunked`, `getall`,
      `status`, `blob`, `hash`), sampling `bun:jsc`'s `heapStats()` with a
      forced `Bun.gc(true)` because `process.memoryUsage().heapUsed` reports
      +0.0 MiB for a 64 MiB string under Bun. Three gaps against the task as
      written:
      1. **It runs under Bun/JavaScriptCore, not Chrome/V8**, and it is a
         synthetic PDF, not "a real image-heavy DOCSY tree export in the panel
         and the offscreen worker". The script says so itself (`:18-24`).
      2. **No numbers are recorded in this PLAN.** The harness prints them; the
         plan still has no figures to cite, so nothing here can be quoted as
         measured.
      3. **Both gating assumptions remain UNVERIFIED**, and the script states
         that explicitly rather than faking a result (`:485-497`):
         `fake-indexeddb` has no out-of-line blob store, so a Chrome IDB `Blob`
         round-trip cannot be measured there; PDF.js is not loaded, and a
         `blob:` URL supports no HTTP Range requests anyway. Per Architecture
         point 9 the consequence was taken correctly — the seam stands and **the
         storage format reverted to `Uint8Array`** — but that is reasoning from
         the spec, not the measurement the task ordered.
      Closing this needs a DevTools heap snapshot against a real Chrome
      profile; it is the same work as the "Memory sanity (T5.6 measurement
      task)" item in the manual release protocol below.
- [x] `apps/extension/entrypoints/sidepanel/PdfSection.tsx`: identity change
      **stops watching**, never aborts (defect (a), Architecture point 3).
      `AbortController` stays bound to the explicit Cancel button only.
      Regression test: a simulated page navigation mid-export leaves the job
      `compiling` and the record intact.
      *(**Path moved by Phase 0**: the run state left `PdfSection.tsx` for
      `components/app/export-runs.tsx`, where the identity effect now detaches
      the PDF run instead of aborting it (`:96-111`, reasoning at `:11-16`).
      Tests in `tests/pdf/section-navigation.test.tsx`: "stops watching without
      aborting — the export and its record survive", "still aborts on the
      explicit Cancel button", "does not abort when the panel itself goes away",
      "starts a fresh export on the new page rather than reusing the detached
      one". **Scope note the plan did not state**: this is PDF-only —
      `export-runs.tsx:113-114` still aborts a running **DOCX** export on
      identity change, deliberately, because DOCX has no durable job record to
      re-attach to (comment at `:112`). CONFCLOUD-83694 is therefore fixed for
      PDF and still open for Word.)*
- [x] `apps/extension/entrypoints/background.ts`: derive in-flight state from
      durable job records (`status: "queued" | "compiling"`), not from the
      volatile `activePdfJobs` counter (`background.ts:49`), before arming
      `offscreenIdle` — at both call sites (`:58` `runWasmSmoke`, `:87-88`
      `runPdfCompile`'s `finally`). Fixes defect (b): an offscreen document
      torn down while a compile from before a SW restart is still running.
      *(`utils/jobs/idle-gate.ts#createDurableIdleGate` wraps the timer and asks
      `countInFlightPdfJobs()` (over the durable meta records) before arming;
      both former call sites funnel through it via
      `createOffscreenActivityTracker(durableIdle)` —
      `entrypoints/background.ts:79-84`, noted at `:74-78`. Tests:
      `tests/jobs/idle-gate.test.ts` — "does not arm the timer after a restart
      while an older compile is still running", "arms the timer once the older
      compile also finishes", "fails open when the record store cannot be read";
      end to end in `tests/pdf/job-durability.test.ts` — "does not arm the
      offscreen idle timer while a pre-restart compile is still running".)*
- [x] Cleanup ownership moves out of the panel: terminal-state deletion is
      driven by the SW/offscreen side, which outlives the panel;
      `compile-port.ts:90`'s `finally` may only delete a job this panel is
      actively watching *and* has consumed. `cancelPdfJob`
      (`job-store.ts:244-250`) must release the bundle, not only set a status.
      Regression test: closing the panel mid-export leaves no orphan record
      holding a full bundle.
      *(`utils/pdf/compile-port.ts:240-247` — the `finally` deletes only when
      `consumed || kind === "preview"`, and marks the record consumed through
      `markPdfJobConsumed` otherwise (rationale at `:17-20`);
      `job-store.ts#cancelPdfJob` (`:867`) drops both payloads and keeps only
      the meta record for the re-attach UI (`:858-866`), with
      `releasePdfJobBundle` (`:682`) for the ordinary terminal path. Tests in
      `tests/pdf/job-durability.test.ts`: "releases the source bundle at every
      terminal state", "removes a cancelled preview entirely — nobody
      re-attaches to one", "keeps a consumed record only until the sweep runs";
      and `tests/pdf/job-store.test.ts` — "cancelPdfJob releases the bundle, not
      only the status", "deleting a job leaves no orphan payload behind".)*
- [x] `apps/extension/utils/pdf/job-store.ts`: size metadata split out of the
      payload so `PDF_STORE_MAX_BYTES` is enforced **without** `getAll()`
      (Architecture point 9). Also split the volatile status/progress record
      from the immutable payload record so `claimPdfJob`/`completePdfJob` stop
      rewriting every asset byte for a status field
      (`job-store.ts:152-181`). Keep the cap *values*; change only how they are
      computed and stored.
      *(Store v2: one `jobs` meta store (numbers + short strings, `inputBytes`
      / `outputBytes`, `storedJobBytes` at `:252`) plus two separate payload
      stores; quota reads meta only (`putPdfJob` `:487`, `completePdfJob`
      `:724`), never a payload. Invariant stated at `job-store.ts:36-37`, cap
      values unchanged and justified at `:39-47`. Tests in
      `tests/pdf/job-store.test.ts`: "enforces PDF_STORE_MAX_BYTES without
      opening a payload store", "computes the quota from meta records even when
      every payload is unreadable", "does not rewrite the payload record on a
      status transition", "claims without putting the bundle back".)*
- [x] `packages/pdf/src/validate.ts`: chunked scanning with boundary overlap
      instead of `TextDecoder("latin1").decode(bytes)` over the whole PDF
      (`validate.ts:48`). Shared-engine change — the CLI gets the same benefit.
      Test: identical verdicts to the current implementation across the
      existing fixtures, including a marker deliberately straddling a chunk
      boundary.
      *(`packages/pdf/src/validate.ts:44` `CHUNK_BYTES` = 1 MiB (exported as
      `PDF_SCAN_CHUNK_BYTES` so the boundary tests cannot hard-code 1 MiB),
      tiling scan at `:165-166` with the "where the window must stop" rule at
      `:108-114`. Tests in `packages/pdf/src/validate.test.ts` — "agrees with
      the whole-file scan on every existing fixture", "joins a /Type at
      BOUNDARY-1 to a /Page thousands of spaces later", "finds a catalog /Lang
      whose enclosing object spans the chunk boundary", "reports untagged when
      the only /StructTreeRoot is a near-miss at the boundary".)*
- [x] `packages/pdf/src/run-export.ts`: release `prepared`/`bundle`
      (`:241-242`) once the job is stored, so they are not retained through
      compile, validate and download.
      *(`packages/pdf/src/run-export.ts:249-260` — both are declared
      `| undefined` and nulled once the last consumer has taken what it needs;
      the two facts the report still needs (`counts`, `bundle.notes`) are
      hoisted out first. Rationale in the comment at `:251-258`.)*
- [x] `PdfBytesHandle` seam (`packages/pdf`): replace raw `Uint8Array` in the
      cross-layer output contract with a handle (`size`, `asBlob()`,
      `asUint8Array()`, `objectUrl()`). Storage format for the extension host
      is decided by the measurement task, not assumed. `PdfOutputSink`
      (`packages/pdf/src/run-export.ts:25`) and the preview cache (T5.3) both
      consume the handle; `download.ts` uses `asBlob()` and drops its own copy.
      **Do not** land this before the measurement task reports.
      *(`packages/pdf/src/bytes-handle.ts` — `PdfBytesHandle`,
      `pdfBytesFromUint8Array`, `pdfBytesFromBlob`, `isPdfBytesHandle`,
      exported from `index.browser.ts:25-26`. `PdfOutputSink.emit` now takes a
      handle (`run-export.ts:36`); consumers adapted across
      `apps/extension/utils/download.ts` (`asBlob()`, own copy dropped),
      `utils/pdf/preview-cache.ts`, `apps/cli/src/commands/export-pdf-sink.ts`,
      `packages/export-node/src/pdf-env.ts`,
      `apps/browser-export-harness/src/memory-output.ts`. Tests:
      `packages/pdf/src/bytes-handle.test.ts`, `tests/pdf/download.test.ts`
      ("PdfBytesHandle (spec 010, T5.6)"). **Storage format: reverted to
      `Uint8Array`**, which is the branch Architecture point 9 prescribes when
      the two IDB-Blob assumptions are unverified — and they are (see the
      measurement item above). The seam itself stands, as designed.)*
- [x] `apps/extension/entrypoints/sidepanel/JobsSection.tsx` (new): the
      re-attach UI — running/finished jobs for this site with scope, progress
      ("Page 37/210"), age, and actions (show result / download / cancel /
      dismiss). On panel mount it reads `atlcli-pdf` and re-attaches to
      anything still `queued`/`compiling`; a finished job offers its download.
      Collapsed when there are no jobs, so the 90 % single-page case sees no
      new UI.
      *(**Path moved by Phase 0** — it is a registered screen, not a panel
      section: `components/screens/JobsScreen.tsx` (`JOBS_SCREEN_ID =
      "activity"`, `jobsScreenDefinition` requiring the `durable-jobs`
      capability), over `utils/jobs/store.ts#createDurableJobsStore` and
      `utils/jobs/context.tsx`. Tests in `tests/pdf/jobs-section.test.tsx`:
      "renders no list at all when there are no jobs", "re-attaches on mount to
      a job that is still compiling, with its progress", "offers the download
      for a finished job, and consumes it when taken", "cancels a running job
      through the compiler, not only in the record", "does not list a job from
      another site", "never lists a preview job".)*
- [x] Notification: in-panel status plus `chrome.action.setBadgeText` when a
      job finishes while the panel is closed. **Deliberately not**
      `chrome.notifications` — that needs a new manifest permission, and this
      folder's rule is no new permissions (asserted by
      `tests/manifest.test.ts`). Badge clears when the panel is opened.
      *(`utils/jobs/model.ts#jobBadgeText` (`:222`) over the count of finished
      but unconsumed records; set at `entrypoints/background.ts:117` and
      cleared at `:124`. `chrome.notifications` is absent and the permission
      list is unchanged — the only manifest addition is the `action: {}` key
      the badge API requires (`wxt.config.ts:36-41`), which
      `tests/manifest.test.ts` treats correctly because it pins `permissions`,
      not the whole manifest.)*
- [x] Shared store budget: the preview cache (T5.3) and retained background
      jobs (T5.6) compete for the same `PDF_STORE_MAX_BYTES`. Design one
      eviction policy over both — previews are evictable at any time, a
      finished-but-unconsumed export job is not — rather than two features
      independently filling one store. Document the policy in the job-store
      module comment.
      *(One policy in `utils/jobs/model.ts` (`BudgetTenant`, `BudgetEntry`,
      `planStoreEviction`), with the preview cache registered as the second
      tenant through `utils/jobs/preview-tenant.ts#previewCacheTenant` /
      `job-store.ts#setSharedBudgetTenants` (`:287`). Documented in the
      job-store module comment at `:58-70` ("One budget, one eviction policy
      (T5.6)", cheapest-loss-first ordering). Tests in
      `tests/jobs/shared-budget.test.ts`: "sees the preview cache as an occupant
      of the same budget", "evicts the preview cache — and not the finished
      export — to admit a new job", "refuses a new job rather than dropping a
      finished export", "does drop a finished export once the user has collected
      it".)*
- [x] Copy + docs honesty: the panel states that a background export survives
      navigation, panel close and extension restart, but **not** closing the
      browser (Architecture point 3). No wording implies server-side
      durability.

      *(Both halves now shipped. **Panel:** `jobs.durability` in
      `apps/extension/utils/i18n/messages.ts:171` (EN) / `:415` (DE) — "Exports
      keep running while you browse and survive closing this panel — but not
      closing the browser." — with the no-server-side rule recorded at `:163`
      and asserted by `tests/pdf/jobs-section.test.tsx`, "says exactly what
      background means, and promises nothing server-side". **Docs:** the same
      sentence is quoted verbatim as a blockquote in
      `src/content/docs/extension/export.md` § "Background exports", followed by
      the explicit enumeration of what is and is not covered ("navigating to
      another page, closing the side panel, and Chrome restarting the
      extension's service worker … It does **not** cover quitting Chrome: there
      is no server side to this extension"). `src/content/docs/extension/index.md`
      § "Where your data goes" makes the same claim from the other direction.
      Troubleshooting carries "**My export disappeared**" with browser-close and
      the 24-hour retention window as its two causes.)*

### Docs & release (T5.5)

Docs are first-class (CLAUDE.md): same PR as the features, per-page template
(intro → prerequisites → steps → options → examples → troubleshooting →
related topics), UI-first (panel) and config-first (CLI) paths clearly
labelled, ≥ 1 minimal + 1 advanced example per feature.

**Status check, this pass: the docs shipped.** `src/content/docs/extension/`,
`confluence/export-templates.md` and `confluence/macro-compatibility.md` all
exist, the site builds (75 pages), and a new link gate
(`scripts/docs-links.test.ts`) proves every internal link and heading anchor
across the corpus resolves. The screenshot clause was explicitly waived as a
product/documentation decision; only the release itself stays open here (never
automatic).

- [x] `src/content/docs/confluence/export.md`: extend with scope selection
      (tree/space), label filters, and settings — CLI flags (config-first)
      and panel steps (UI-first) side by side; troubleshooting for the new
      failure shapes (page limit, asset budget with named offenders, label
      filter produced empty document).

      *(Scope and label flags were already documented — § "Tree and space
      export" and § "Scope options". **Added this pass:** § "Document settings
      are not CLI flags (yet)", which is the config-first/UI-first split the
      item asks for and had to be written as a **negative**: `apps/cli` contains
      no occurrence of `settings` in `commands/export.ts`, so the panel exposes
      every Level-A setting and the CLI exposes none. The three troubleshooting
      shapes are all present with their real messages, exit codes and report
      fields: "exceeds the maximum of N pages" (exit 5, `fetch`,
      `details.limit`), "No page matched the include label filter" (exit 5,
      `empty-include-result`), and "Export aborted: embedded images total N MB"
      (exit 5, `prepare`, `details.offenders[]` with a `jq` recipe). Also
      **corrected two stale claims** that this branch's own caption fix
      (`5666d6e`) invalidated: the field-update table said `SEQ` always prompts
      because "every caption is written with a cached number of 1", and
      `--no-field-update-prompt` said "captions all read 1". Both now point at
      the new § "Caption numbering". The missing flags `--format`,
      `--keep-ignored`, `--no-live-macros` and `--json` were added to the
      Options table.)*
- [x] `src/content/docs/confluence/export-templates.md` (new): template
      library concept (global vs. space, `resolveTemplate` precedence), CLI
      directories (`~/.atlcli/templates/`, sync-dir space templates) and panel
      library management, manifest settings reference table (each setting:
      type, default, required/optional, constraints) per the docs reference
      standard.

      **Divergence, deliberate: "sync-dir space templates" do not exist.**
      The item assumed one library model across hosts. In reality there are
      two, and the page says so in a § "Two resolution models" comparison
      rather than implying a parity: the CLI resolves `--template` through
      four-level **path precedence** (`resolveTemplatePath`,
      `apps/cli/src/commands/export.ts:819`) with no space dimension, while the
      **panel** implements the global/space two-level model through the
      host-neutral `resolveTemplate` (`packages/core/src/template-library.ts`).
      `apps/cli` has no reference to `resolveTemplate` or `TemplateLibrary` at
      all. The precedence, conflict (`TemplateResolutionConflictError`),
      not-found and integrity (`TemplateIntegrityError`) rules are documented
      with their real messages. The settings table is the **widget vocabulary**
      (`text | boolean | choice | color | number | asset` with the constraints
      each honours, from `components/export/settings-schema.ts`) rather than a
      copy of the fixed Level-A list, which already has a reference page.
- [x] `src/content/docs/confluence/macro-compatibility.md` (new):
      compatibility matrix of supported compatibility macros by their storage
      names (`scroll-pagebreak`, `scroll-landscape`, `scroll-portrait`,
      `scroll-only`, `scroll-ignore`, `scroll-title`, …) and dynamic macros
      (jira, drawio/gliffy, `export_view` fallback) with per-engine behavior
      and degradation notes. Macro identifiers only — no third-party product
      or vendor names.

      *(Three matrices — compatibility, structural, dynamic — each split
      **PDF / DOCX `ts` / DOCX `python`**, plus a note-code index, the fallback
      chain, and the CLI-vs-panel control differences. Macro identifiers only,
      as required.*

      *The per-engine column surfaced a **behavioural difference nothing
      documented**: `scroll-*` macros are handled exclusively in
      `packages/confluence/src/export-blocks.ts`, i.e. the PDF/`ts` pipeline.
      `--engine python` converts through `storageToMarkdown` first, where —
      measured directly — every `scroll-*` macro becomes a `*[scroll-N macro]*`
      placeholder **and takes its body with it**: a table wrapped in
      `scroll-title` for its caption is absent from a python-engine export
      entirely. That is now a callout on both this page and
      `scroll-macros.md`, whose "Engines: DOCX, PDF" column was misleading and
      now reads "DOCX `ts`, PDF".)*
- [x] `src/content/docs/extension/` (new section): `index.md` (install/load,
      what the panel can do) and `export.md` (scope UI, template library,
      preview walkthrough with captioned screenshots per docs media standard);
      cross-link with the Confluence guides ("Related topics"). The preview
      section states plainly, in a callout, that the preview renders the last
      **published** version — not unpublished editor changes — and describes
      the `edit → publish → preview` loop as the supported workflow; the
      troubleshooting block covers "my change isn't in the preview" with that
      as the first cause. A **background exports** section documents that a
      long export keeps running when you navigate away or close the panel, how
      to find it again, and — stated plainly, not buried — that closing the
      browser ends it. Troubleshooting covers "my export disappeared" with
      browser-close and the retention window (Open question 11) as the causes.

      **Completed with an explicit media-scope decision (2026-07-22): no
      documentation screenshots will be produced for 010.** Everything else
      in this item shipped. `src/content/docs/extension/index.md` covers
      install/load (Chrome ≥ 140, `Load unpacked` from
      `apps/extension/.output/chrome-mv3/`, the reload-after-rebuild step), a
      panel-vs-CLI capability table that names the four things each host does
      not do, "Where your data goes", and the limits table.
      `src/content/docs/extension/export.md` covers the scope UI, label
      filters, the macro toggle, document settings, the template library,
      preview and background exports, with a minimal and an advanced example
      and a twelve-row troubleshooting table. The published-version callout is
      there verbatim, `edit → publish → preview` is named as the supported
      loop, and "**My change isn't in the preview**" is the **first row** of
      troubleshooting. Both pages are in the `astro.config.mjs` sidebar under a
      new "Browser Extension" group and cross-link the Confluence guides in
      both directions.

      The original screenshot clause is deliberately waived rather than left
      as hidden follow-up work. The user confirmed this product/documentation
      decision after completing the manual extension walkthrough.
- [x] `src/content/docs/recipes/ci-cd-docs.md`: update with the scope/label
      flags and `--report json` recipes (kept in lockstep with folder 008's
      CLI work — one product, one docs release).

      *(New § "Export the published docs as a release artifact" closes the
      loop the page was missing — it published to Confluence and never exported
      back out. A GitHub Actions step with `--scope tree`,
      `--label-exclude internal,draft`, `--completeness strict`, `--out-dir`,
      `--report json` and `--strict`, then a per-flag table of why each belongs
      in a pipeline, the classified exit codes, and a pointer to
      `recipes/export-automation.md` for report parsing rather than duplicating
      it. Also carries the "document settings are not CLI flags" note so a CI
      author does not go looking for `--watermark`.)*
- [x] ~~`CHANGELOG.md`: entries per Conventional-Commit scope~~
      **Divergence: this item is a no-op and writing it would be harmful.**
      `CHANGELOG.md` is generated **wholesale** by `git-cliff` from the commit
      history at release time (`scripts/release.ts:208`,
      `bunx git-cliff --tag v<version> -o CHANGELOG.md`), with `cliff.toml`
      supplying the header and the `feat`/`fix`/`doc`/… grouping. A
      hand-written entry would be silently overwritten by the next release.
      The item is satisfied by the *commits* carrying the right Conventional
      Commit scopes, which they do. There is no `[Unreleased]` section to
      maintain.
- [ ] Release: `bun scripts/release.ts <type> --dry-run` first, never
      automatic; post-release verify GitHub release page, Homebrew tap
      (`brew info atlcli`), CHANGELOG.md; run the manual extension
      verification protocol (Tests section) against the release build before
      tagging.

      **Open by design.** CLAUDE.md: "Never release automatically." This is the
      user's call, not a task to complete here.
- [x] **Added this pass, not in the original item: a docs link gate.**
      `scripts/docs-links.test.ts` resolves every internal link and every
      heading anchor across `src/content/docs/` against the source markdown
      (heading ids via the same `github-slugger` Astro's `rehype-slug` uses; no
      site build required), and asserts every page is reachable from the
      sidebar. It found **five pre-existing defects on its first run**: the
      anchor `#the-bundled-default-template-engine-ts` wrong on four lines of
      `export.md` since the commit that introduced the section (the real slug
      has three hyphens, from `(--engine ts)`), a dead
      `/confluence/export/#template-placeholders` from `docx-engine.md`, two
      `getting-started.md` relative links emitted **verbatim** into the built
      HTML (Astro does not rewrite a `.md` reference to an `.mdx` file, so both
      were 404s), and `recipes/export-automation` + `confluence/dynamic-macros`
      missing from the sidebar entirely. All five fixed. Mutation-tested with
      four independent mutations — dead page link, dead cross-page anchor,
      removed sidebar entry, and an anchor that exists only as a `#` comment
      inside a fenced code block — each of which turns exactly one assertion
      red; the fence-skip in particular is load-bearing rather than defensive.

### Tests (no mocking)

**Hard rule: NEVER mock HTTP.** No fetch stubs, no recorded HTTP fixtures.
Allowed and encouraged: pure-function tests, port fakes for *our own* ports
(a fake `TreeSource`/`JiraIssuePort` is a test implementation of an interface
we defined, not an HTTP mock), and `fake-indexeddb` — a spec-complete
in-memory IndexedDB implementation with real transactions/cursors (already the
established pattern in `apps/extension/tests/docx/template-store.test.ts` and
`apps/extension/tests/pdf/job-store.test.ts`; it stays).

Existing extension test patterns to extend (all `bun test`, in
`apps/extension/tests/`): pure reducers (`panel-state.test.ts`), IndexedDB
stores on fake-indexeddb (`docx/template-store.test.ts`, `pdf/job-store.test.ts`),
React view tests (`pdf/report-view.test.tsx`, `docx/scan-view.test.tsx`,
`docx/report-view.test.tsx`), protocol/host logic (`pdf/compiler-host.test.ts`,
`pdf/compile-port.test.ts`, `messages.test.ts`, `router.test.ts`), real-wasm
compiler runs (`pdf/compiler.test.ts` — actual Typst compile, byte-identical
warm repeats), build gates (`manifest.test.ts`, `output-scan.test.ts`,
`typecheck-coverage.test.ts`).

Component/unit (new):

- [x] `apps/extension/tests/scope-state.test.ts`: scope reducer — kind
      transitions, depth bounds, label parsing/dedupe, prune-subtree default.
      *(All four at that path: "moves between page / tree / space", "clamps
      below the minimum and above the maximum", "splits on commas and
      whitespace, trims, drops empties, dedupes", "defaults excludeMode to
      prune-subtree (excluded pages take their children)".)*
- [x] `apps/extension/tests/scope-section.test.tsx`: progressive disclosure
      (advanced closed by default), space option gating on `spaceKey`,
      confirmation copy for space scope.
      *(All three at that path: "starts on 'Current page' with the Advanced
      disclosure closed", "disables it — with a reason — when the page reports
      no space", "asks before a space export and names the page count" /
      "still asks — with count-free wording — when the host cannot count".)*
- [x] `apps/extension/tests/pdf/run-export-scope.test.ts`: scope-aware
      `runPdfExport` against a **fake `TreeSource`** (port fake, no HTTP):
      composed chapters reach the neutral engine, `sourceIdentity` differs
      between page and tree scope for the same root, abort during the walk
      stops fetching and stores no job, `onProgress` sequence is ordered.
      *(All four at that path: "hands the COMPOSED chapters to the neutral
      engine, in document order", "differs between a page export and a tree
      export of the SAME root", "aborting mid-walk stops fetching and never
      reaches the compile port", "forwards onProgress in document order, one
      tick per fetched body".)*
- [x] `apps/extension/tests/pdf/run-export-scope.test.ts` (extend): a macro on
      a **non-root** `ExportPageNode` resolves `MacroExportContext` from
      `block.sourcePage`, not the root page — regression for Architecture
      point 6/T5.4's per-source-page context task (fake `TreeSource` +
      port-fake registry, no HTTP).
      *(`describe("macro resolution is per SOURCE page (Architecture point 6)")`
      — "uses the macro's OWN page id, never the export root's", "the rendered
      body is the CHILD page's, and it reaches the compiler".)*
- [x] `apps/extension/tests/pdf/job-store.test.ts` (extend): pre-flight
      rejection reads the already-deduped asset list from a fake
      `preparePdfDocument` result and names the largest offenders (no
      dedupe logic inside `job-store.ts` itself — assert it does *not*
      duplicate `prepare.ts`'s hashing); regression: a bundle > 64 MiB fails
      before any IDB write.

      **Two of three assertions are here; the offender-naming one is
      elsewhere, because the code is elsewhere** (see the T5.1 budget-hardening
      task). At this path: "never runs a second dedupe pass over the bundle it
      is handed" (the "does not duplicate `prepare.ts`'s hashing" assertion) and
      "rejects oversized input before writing" (the > 64 MiB regression), plus
      four bonus cases proving the caps cannot be bypassed by mutating the
      bundle after the call. The largest-offender message is asserted in
      `packages/confluence/src/asset-budget.test.ts` and, cross-engine, in
      `packages/pdf/src/asset-budget-parity.test.ts` — "both engines throw
      AssetBudgetExceededError with the identical offender list".
- [x] `apps/extension/tests/docx/template-store-migration.test.ts` (new,
      fake-indexeddb): seed a **v1** database containing a `"current"`
      record, reopen at `DB_VERSION` 2, assert (a) the synchronous phase
      completes with a `migrationPending: 1` placeholder record (`recordKey`
      set, `templateId` a fresh uuid, `engine: "docx"`, `scope: "global"`,
      `sha256: null`) and `"current"` key gone, immediately after
      `onupgradeneeded` returns — i.e. before the async backfill runs; (b)
      the async backfill completes `sha256`/`size` and clears
      `migrationPending`; (c) **interrupted backfill**: close the connection
      between phase 1 and phase 2, reopen — the `migrationPending` record is
      found via its index and finished, never left half-migrated; (d) second
      open at v2 (already migrated) is a no-op; (e) empty v1 DB migrates
      cleanly; (f) phase 1 is `await`-free.

      **(f) cannot be a behavioural test — corrected 2026-07-20 after probing
      the fake.** `fake-indexeddb` does **not** model version-change
      transaction inactivity: an upgrade handler that `await`s
      `crypto.subtle.digest(...)` and then calls `objectStore.put()` *succeeds
      silently* under the fake, exactly where Chrome throws
      `TransactionInactiveError`. A test asserting "no `TransactionInactiveError`
      is thrown" is therefore **vacuously green** — it passes both with and
      without the bug, and would have signed off the very regression the
      two-phase design exists to prevent. Implemented instead as a
      **source-level guard** that parses the phase-1 call graph and fails if it
      is not `await`-free, itself mutation-tested (making a phase-1 helper
      `async` must fail the guard). Do not "upgrade" this to a behavioural test
      against the fake — that trades a real check for a green light. The real
      browser behavior is covered by the manual fresh-profile migration item in
      the release protocol.

      *(Verified this pass. (a)–(e) are at the stated path — "phase 1 lands a
      synchronous placeholder record and drops the legacy 'current' key",
      "phase 2 backfills sha256 + size and clears the pending marker", "resumes
      an interrupted backfill: the pending row is found via its index on the
      next open", "is a no-op on a second open at v2", "migrates an empty v1
      database cleanly". (f) landed exactly as the correction above describes:
      `apps/extension/tests/docx/phase1-sync-guard.ts`, an **AST walk of the
      real call graph from `req.onupgradeneeded`**, closed by default — an
      unresolvable or imported callee is itself a violation. It is invoked by
      "keeps migration phase 1 free of any await — the guard a runtime test
      cannot give us" and mutation-tested by six cases under `describe("the
      phase-1 guard itself (mutation tests)")`: awaiting `const` arrow helper,
      imported helper, unlisted name, an `await` hidden behind a `}` inside a
      string literal, a vanished entry point (must fail loudly, not report
      success), and a no-false-positive run on the unmodified source. The guard
      header (`phase1-sync-guard.ts:6-41`) also records that an earlier
      regex-based version proved nothing — worth keeping, because it is the
      reason the AST form exists.)*
- [x] `apps/extension/tests/templates/library.test.ts`: v2-store
      `TemplateLibrary` adapter — `list` filtering by engine/space,
      `getBytes` sha256 verification failure is a hard error; a global entry
      and a space-scoped override sharing the same `templateId` but distinct
      `recordKey`s **coexist** in the store and `resolveTemplate` picks the
      space one; deleting the space-scoped record leaves the global record
      resolvable (delete → global fallback); two entries with the same
      `templateId` **and** the same `spaceKey` but different `siteOrigin`
      (two Atlassian sites both using space key `DOCSY`) resolve
      independently, never bleeding into each other; resolution itself is
      `resolveTemplate` from `@atlcli/core` (already covered by folder-007
      unit tests — do not re-test the pure function here, test the adapter's
      wiring of it and the `recordKey`/`templateId` split).
      *(All five clauses at that path: "filters by engine, never resolving a
      wrong-engine entry", "throws a hard integrity error when the stored bytes
      were modified", "keeps a global entry and its space override as two rows
      and resolves the space one", "leaves the global entry resolvable after the
      space override is deleted", "keeps two sites that share a space key
      completely independent". `resolveTemplate` itself is not re-tested here.
      **Beyond plan**: a `describe("delimiter injection in logical ids")` block
      proving one upload cannot destroy another's bytes through a colliding
      record key, and four cases covering the site-agnostic migration
      sentinel.)*
- [x] `apps/extension/tests/settings-form.test.tsx`: one case per widget type
      (`text|boolean|choice|color|number|asset`), default filling from
      manifest, invalid number/color rejection, values round-trip to
      `template-prefs`; PDF-only for v1 — assert the form never attempts to
      write a `settings` field onto a DOCX `ExportInput`.
      *(All at that path: "renders text, boolean, choice, color, number and
      asset controls", "fills every control from the schema default", "shows the
      issue next to the field for an invalid number and colour", "round-trips
      values through the real template-prefs store", "**never writes `settings`
      onto a DOCX export request**". Also pins the schema to the engine — "uses
      the same template id the engine's built-in manifest declares" — and
      treats a manifest as untrusted data.)*
- [x] `apps/extension/tests/pdf/preview.test.ts`: **scope-dependent**
      truncation — `scope: page` is never truncated; `tree`/`space` is
      chapter-count **and** block/asset-byte bounded (a single oversized
      chapter is still capped, not just counted as "1 of N"); capture sink
      returns bytes without invoking download; a superseded preview resolves
      as discarded **without** the worker being terminated (assert
      `destroyWorker`/`terminate` is not called on preview supersession,
      only on an explicit export cancel).
      *(First three clauses at that path: "compiles the WHOLE document for
      scope: page — the CONFCLOUD-84742 case", "stops on the block backstop
      before the chapter budget is reached" / "stops on the asset-byte
      backstop" / "always keeps the first chapter, even when it alone busts
      every backstop", "keeps the handle instead of downloading it". The fourth
      clause **split across two files**: this file asserts the caller-visible
      half ("reports a superseded preview as a status, not an error"), and the
      `destroyWorker`/`terminate` half lives where the worker does —
      `tests/pdf/compiler-host.test.ts`, "cancelling an active preview does NOT
      terminate the worker" and "cancelling an active EXPORT still terminates
      the worker (user-initiated abort)".)*
- [x] `apps/extension/tests/pdf/preview-cache.test.ts` (new, fake-indexeddb):
      a cache hit on identical `sourceIdentity` + settings hash returns bytes
      and suppresses a second compile; **changing one setting value invalidates
      the entry** (no stale-bytes download); a `truncated: true` entry is
      **never** returned to Download (regression for the silently-cut-off-PDF
      trap, Architecture point 5) while still serving the viewer; entries are
      deleted on the normal job-lifecycle path so preview churn does not grow
      the store.
      *(All at that path: "Download reuses a complete entry" + "opens the cached
      preview without compiling" (`tests/preview-screen.test.tsx`), "hashes
      different settings to different keys" / "changes the cache key when any of
      the three parts changes", "**Download must NOT reuse a truncated entry,
      but the viewer may read it**", "expires an entry older than the job
      horizon and drops it from storage" / "is single-slot: a second preview
      replaces the first". **Beyond plan**: "changes the tree hash when a CHILD
      page's version changes" — the stale-child-page hole the planned two-part
      key would have left open.)*
- [x] ~~`apps/extension/tests/pdf/viewer-config.test.ts` (new)~~
      **`apps/extension/tests/pdf/viewer.test.ts`** — the file was written
      broader than "config" and the narrower name would have been misleading:
      the single PDF.js
      construction site passes `isEvalSupported: false` and a local
      `workerSrc` — the runtime half of Architecture point 8's contract, which
      the static build scan cannot check.
      *("sets isEvalSupported: false at the single construction site",
      "disables XFA and system fonts, and configures no remote runtime URLs",
      "points the worker at a bundled URL and assigns it once", "sources both
      runtime files from the vendored package, emitted verbatim", plus
      "does not implement isEvalSupported (the option was removed in v6)" —
      the test Architecture point 8 asks for, which fails if PDF.js ever
      reintroduces the option. The same file also carries the `blob:`-URL
      borrow-hazard cases and the render-scale/canvas-cap tests.)*
- [x] `apps/extension/tests/output-scan.test.ts` (extend): **inverted, because
      no exemption was added.** Instead of proving an exemption is narrow, the
      tests prove the gate covers PDF.js at all: seeding `new Function(` into
      the real emitted PDF.js artifact must FAIL the real CLI, and a `.mjs`
      leak elsewhere must fail too (`.mjs` was previously unscanned). Adding a
      simulated path-scoped exemption turns those tests red — so one cannot be
      introduced later without the suite objecting.
      *(Verified: `describe("dynamic-code rule has no PDF.js exemption")` —
      "flags a string-to-code constructor at the vendored PDF.js path like
      anywhere else", "the emitted PDF.js paths are recognizable, and match
      nothing else in the bundle"; and the end-to-end CLI cases "fails when
      dynamic code is seeded into the vendored PDF.js file itself" and "scans
      .mjs assets at all — a new extension is not a way around the gate". These
      run against the real `.output/chrome-mv3`, so they require `bun run build`
      first.)*
- [ ] **Real-browser render coverage belongs in Playwright, not happy-dom.**
      PDF.js rendering is `<canvas>` + a real Worker; happy-dom cannot
      meaningfully execute it, so the unit tests above deliberately cover the
      *pure* parts (scheduling, truncation, cache keys, config) and assert no
      pixels. Add the actual "compiled bytes render to a non-blank canvas with
      the expected page count" assertion to the existing Playwright harness in
      `apps/browser-export-harness` (which already runs a real browser for
      engine parity). Do not simulate a canvas in a unit test and call it
      render coverage.

      **Left unticked — partially implemented, exact pixel gate still missing.**
      `apps/extension/tests/pdf/browser/viewer.e2e.ts` now compiles a real PDF,
      opens it through the real PDF.js worker, awaits `renderPage`, asserts the
      real page count, exercises internal/external AnnotationLayer links and
      fails on page/console errors. What it does **not** yet assert is that the
      canvas contains non-background pixels, and the case has not moved into
      `apps/browser-export-harness`. The *discipline* half also holds — no unit
      test simulates a canvas and claims pixel coverage; `viewer.test.ts` calls
      its PDF.js implementation a structural fake explicitly.
- [x] `apps/extension/tests/pdf/compiler-host.test.ts` (extend): `kind:
      "preview" | "export"` scheduling — an export queued behind an
      in-flight preview jumps ahead; rapid preview→preview→export creates
      exactly one worker instance (`createWorker` call count); a queued
      preview superseded before it starts never reaches the worker.
      *(All three at that path, under `describe("ChromeWorkerCompilerHost —
      preview/export scheduling")`: "lets an export queued behind an in-flight
      preview jump ahead of a queued preview", "creates exactly ONE worker
      across a rapid preview → preview → export sequence", "never sends a
      superseded queued preview to the worker".)*
- [x] `apps/extension/tests/macros/session-ports.test.ts`: constructed real
      `Response` objects (per the "never mock HTTP" rule — these are
      hand-built `Response`s, not a fetch mock) covering the full taxonomy:
      403 → `skip` + permission note; 404 → `skip` + not-found note; opaque
      redirect / 3xx (session expired) → resolution pass aborts with a
      distinct note, not a silent placeholder cascade; 429 with `Retry-After`
      exhausting the client's retries → typed `degraded` note, chain
      continues; 5xx → `degraded` note, chain continues; toggle OFF →
      `skipped-by-config` without any port call. Also assert
      `JiraIssuePort`/`ExportViewPort` are thin adapters over
      `JiraClient`/`ConfluenceClient` (constructed with a session profile),
      not a parallel fetch implementation — the real HTTP behavior of the
      underlying clients is exercised E2E (below), never via mocked fetch.
      *(Every branch of the taxonomy at that path: "403 → chain skip with a
      permission note, export continues", "404 → chain skip with a not-found
      note", "an opaque redirect stops further port calls and surfaces one
      distinct note" (+ "a raw 3xx", "a 200 login page (non-JSON body)", "the
      latch is emitted exactly once across many macros"), "429 exhausting the
      client's own retries → degraded note, chain continues", "5xx after the
      client's retries → degraded note, chain continues", "emits
      skipped-by-config without a single port call". Thin-adapter claim:
      "maps an issue through the client and issues no HTTP of its own",
      "builds a Jira port from the tab's session profile with no client
      passed", plus the compile-time witness `session-ports.ts:118`.)*
- [x] `apps/extension/tests/macros/external-asset-policy.test.ts` (new): same
      fixture set (site-origin URL, allowed Atlassian media origin,
      disallowed third-party origin, redirect to a disallowed origin,
      loopback/private target) run through **both** `utils/pdf/run-export.ts`'s
      resolver and `utils/docx/env.ts`'s `sessionAssetFetcher` — assert
      identical allow/reject outcomes across engines.
      *(At that path, table-driven over the shared
      `packages/export-wiring/src/fixtures.ts` set —
      `describe("cross-host parity — the shared fixtures through the
      extension's policy")` running each fixture through both `allow()` and
      `fetch()` including the redirect chain, plus "the SSRF guard the extension
      uses is the shared predicate" and "is exactly the set the manifest grants
      — the fixture allowlist, not a superset". The *both-engines* half is
      asserted from the engine side in `tests/pdf/run-export-scope.test.ts` —
      `describe("cross-engine policy parity over the shared fixtures")`, with
      guard-the-guard cases showing an unwrapped resolver fails the assertion.)*
- [x] `apps/extension/tests/pdf/compiler.test.ts` (extend): warm-worker
      preview-then-export sequence compiles both from one compiler instance;
      multi-chapter bundle compile stays under the scaled timeout.

      *(At that path: "compiles a preview and the full export with one real warm
      compiler instance" creates one real `BrowserPdfCompiler`, compiles a
      one-chapter preview followed by a six-chapter full export, validates both
      PDFs and proves the full result grows beyond the preview. "compiles a
      real multi-chapter bundle within the production scaled timeout" composes
      twelve real chapters, compiles them through wasm, compares elapsed time
      with `ChromeWorkerCompilerHost.timeoutForPages(12)`, and validates the
      tagged outlined result and page count. The scheduling/one-worker property
      remains independently covered against the fake worker in
      `tests/pdf/compiler-host.test.ts`; this item supplies the missing real-wasm
      half.)*
- [x] `apps/extension/tests/pdf/job-durability.test.ts` (new): re-instantiate
      the background router mid-job (simulating a service-worker restart —
      drop and rebuild `activePdfJobs`/message listeners without touching the
      `atlcli-pdf` job record) and assert the panel can still find the job's
      eventual `status` in the store; a job whose worker never responds
      within its timeout ends up `failed`, not stuck `queued`/`compiling`
      forever. **Extend for T5.6**: after a simulated SW restart that resets
      `activePdfJobs` to `0`, a *second* job completing must **not** arm
      `offscreenIdle` while the first is still `compiling` — the regression for
      Architecture point 3 defect (b), the torn-down-mid-compile offscreen
      document.
      *(All at that path: "is still findable, and still finishes, after the
      in-memory state is rebuilt", "returns the compiled result even though the
      compile message is never answered", "ends the job failed at its deadline
      instead of leaving it compiling forever" (+ "is reached by the watcher
      too, so the panel is told rather than hanging"), and the T5.6 extension
      "does not arm the offscreen idle timer while a pre-restart compile is
      still running".)*
- [x] `apps/extension/tests/pdf/section-navigation.test.tsx` (new): changing
      `loadedPage`/`pageUrl` mid-export **stops watching** but does not abort —
      the `AbortController` is not signalled and the job record stays
      `compiling`; only the explicit Cancel button aborts. Direct regression
      for `PdfSection.tsx:30-37` (Architecture point 3 defect (a)) and the
      in-repo reproduction of CONFCLOUD-83694.
      *(At that path: "stops watching without aborting — the export and its
      record survive", "still aborts on the explicit Cancel button", "does not
      abort when the panel itself goes away", "starts a fresh export on the new
      page rather than reusing the detached one". The subject under test is now
      `components/app/export-runs.tsx`, not `PdfSection.tsx` — see the T5.6
      task, and note it covers the **PDF** run only.)*
- [x] `apps/extension/tests/pdf/job-store.test.ts` (extend, T5.6): enforcing
      `PDF_STORE_MAX_BYTES` performs **no** `getAll()` over payload records
      (assert via a spy or a store seeded with records whose payload access
      would throw); a status transition does not rewrite the payload record
      (byte-identical payload row, changed status row); `cancelPdfJob`
      releases the bundle rather than only setting a status; closing the panel
      mid-export leaves no orphan record holding a full bundle.
      *(All four, under `describe("byte handling (spec 010, T5.6)")`: "enforces
      PDF_STORE_MAX_BYTES without opening a payload store" + "computes the quota
      from meta records even when every payload is unreadable" (the
      seeded-throwing-payload variant the task suggested), "does not rewrite the
      payload record on a status transition", "cancelPdfJob releases the bundle,
      not only the status", "deleting a job leaves no orphan payload behind"
      (with the panel-close path in `tests/pdf/job-durability.test.ts`,
      "releases the source bundle at every terminal state").)*
- [x] `packages/pdf/src/validate.test.ts` (extend): chunked scanning yields
      verdicts identical to the current whole-buffer implementation across the
      existing fixtures, **including a marker deliberately straddling a chunk
      boundary** — the failure mode a naive chunking introduces.
      *(`describe("chunked scanning (spec 010, T5.6)")` — "agrees with the
      whole-file scan on every existing fixture", plus seven boundary cases
      including "joins a /Type at BOUNDARY-1 to a /Page thousands of spaces
      later", "finds a catalog /Lang whose enclosing object spans the chunk
      boundary" and "reports untagged when the only /StructTreeRoot is a
      near-miss at the boundary". The chunk size is exported as
      `PDF_SCAN_CHUNK_BYTES` so the tests cannot silently stop testing the
      boundary if it changes.)*
- [x] `apps/extension/tests/pdf/jobs-section.test.tsx` (new): re-attach UI —
      mounting with a `compiling` record in `atlcli-pdf` re-attaches and shows
      progress; a finished record offers its download; a job from another site
      origin is not listed; no jobs → no UI (the 90 % case sees nothing new).
      *(All four at that path: "re-attaches on mount to a job that is still
      compiling, with its progress", "offers the download for a finished job,
      and consumes it when taken", "does not list a job from another site",
      "renders no list at all when there are no jobs" — plus "never lists a
      preview job" and the copy-honesty assertion.)*
- [x] Shared-budget test (T5.3 + T5.6): with the store near
      `PDF_STORE_MAX_BYTES`, a new export evicts preview-cache entries but
      **never** a finished-but-unconsumed export job — the eviction policy from
      the T5.6 task, asserted rather than left to two features racing.
      *(`apps/extension/tests/jobs/shared-budget.test.ts` — "evicts the preview
      cache — and not the finished export — to admit a new job", "refuses a new
      job rather than dropping a finished export", "does drop a finished export
      once the user has collected it".)*

E2E — primary path via CLI against DOCSY (engine behavior is owned and covered
by folders 002/008; CLAUDE.md workflow: profile `mayflower`, space `DOCSY`,
project `ATLCLI`):

**Completed live against a purpose-built, deliberately retained subtree of the
standing DOCSY "M1 Abnahme Root" on 2026-07-22.** Earlier read-only runs remain
useful evidence — a 62-page tree export (`512b527`, `9a6410f`) and live Jira
datasource parity on page 1126236245 (`512b527`, `de4696d`) — but the new fixture
closes the combined label-filter/source-page gap those runs did not cover.

- [x] Create a small DOCSY test tree (root + 2 levels, labels `handbook` /
      `internal`, one page with a jira macro on `ATLCLI` issues, one with a
      compatibility page-break macro) via `atlcli`; export it with
      `--tree`, `--label-exclude internal`, both engines; assert report notes
      (`label-filtered`, macro `rendered-via`) — this validates the exact
      engine pipeline the extension re-hosts, over real HTTP. Put the jira
      macro on a **non-root, non-leaf child page** specifically, and assert
      the rendered issue table reflects that child page's macro instance
      (not silently the root's) — the concrete regression for the
      `sourcePage`/`contextFor` gap (Architecture point 6, T5.4 task).

      *(Live evidence: persistent root `1132920850` under M1 root `1125482517`;
      macro child `1133445124` carrying `handbook`; filtered grandchild
      `1133150217` carrying `internal`. The macro child is non-root and non-leaf
      and stores a Jira JQL macro plus `scroll-pagebreak`. After Confluence's CQL
      index exposed the freshly-added label, both `--engine ts --scope tree`
      DOCX and `--format pdf --scope tree` PDF completed with exit 0,
      `label-filtered: 1`, `macro-rendered-via: 1`, exactly two included source
      pages, and the provisional macro note bound to `sourcePageId: 1133445124`.
      Both rendered a real three-issue ATLCLI table; visual QA also confirmed
      the manual page break and absence of the filtered grandchild.)*
- [x] ~~**Clean up all DOCSY test pages and ATLCLI test issues after the run**~~
      **Deliberate divergence:** the user explicitly requested that these three
      pages remain in DOCSY as permanent M1 fixtures. No Jira issue was created;
      the macro queries the standing ATLCLI test issues. Their `M1 Abnahme 010`
      names deliberately do not match the `atlcli-e2e-*` sweeper convention.

E2E — extension-specific: a **manual verification protocol per release**
(Chrome extension E2E is not CI-automatable here without mocking; the
Playwright conformance harness in `apps/browser-export-harness` covers engine
parity, not the panel chrome). Execute and check off before each release, with
the same profile-equivalent browser session (logged in to the `mayflower`
site):

**All 16 manual-behavior/resource boxes below are accepted as complete; the
seventeenth, automated full-suite gate remains open.** The first real run on
2026-07-21 found three preview defects (see "What the first manual run found").
After the fixes and rebuilds, the user confirmed the remaining manual protocol
complete on 2026-07-22, including PDF/DOCX exports, scope/template/migration
flows, preview/download behavior, macros and background-job resilience. This
manual acceptance does not invent benchmark data: the separate numeric T5.6
Chrome/V8 measurement task above remains open until peak figures are recorded.

- [x] `bun run build`, load `apps/extension/.output/chrome-mv3` unpacked in
      Chrome (≥ 140); open the side panel on a DOCSY page.

      *(Built and loaded unpacked; the panel came up and detected the page,
      including the German locale. The later complete protocol and the retained
      M1 010 fixture above supply the DOCSY-specific evidence.)*
- [x] Single page: export PDF + DOCX; files download; reports show no
      unexpected warnings.
- [x] Tree scope: select "Page + children" on the DOCSY test root, exclude
      label `internal`; progress shows "Page n/total"; Cancel mid-fetch aborts
      within ~1 s and leaves no stuck job (re-export works immediately).
- [x] Space scope: confirmation shows a plausible page count; export completes
      or fails with the friendly budget error (both acceptable outcomes must
      be legible to the user).
- [x] Template library: upload two templates, assign one to DOCSY as space
      override, verify the export uses the override and that deleting it falls
      back to global; reload the panel — selection survives (IndexedDB v2).
- [x] Fresh-profile migration: load the previous release build, upload a
      template (v1 `"current"`), then load this release build — the template
      appears as a global library entry, no data loss.
- [x] Preview: open preview, change a setting (e.g. orientation) — preview
      updates after the debounce, first compile noticeably slower than the
      second (warm worker); Export after preview reuses the warm worker
      (compile time < first preview). Trigger several rapid settings changes
      to queue overlapping previews, then immediately click Export — Export
      completes without waiting for a queued preview to finish and without a
      visible cold-init pause (job-kind priority + no worker termination on
      supersession, T5.3).
- [x] Preview viewer: page forward/back, fit-width and zoom work in the 400 px
      panel; "Open large preview" opens the tab viewer showing the **same**
      document; the panel stays usable while the tab is open.

      *(Verified 2026-07-21, but only **after** three fixes this box produced —
      it failed on first contact. Evidence: paging observed at "Seite 3 von 4"
      and "Seite 1 von 5"; fit-width confirmed working by the reporter; zoom is
      proven by construction, because the fit-width control is disabled at zoom
      1, so exercising it at all required zooming first; the large-preview tab
      renders the same document (`260717 Jour Fixe`, 5 pages) at full tab width,
      with the panel still live beside it in the same screenshot.*

      *Additional verification on 2026-07-22: internal table-of-contents links
      and external inline links work in the installed extension; rapid paging,
      zoom and fit changes produce neither a fake-worker warning nor an
      unhandled `RenderingCancelledException`. Still outside this box: whether
      the tab view survives a reload of the tab itself and window-resize
      re-fitting —
      the resize path is deliberately untested in the suite too, because
      happy-dom has no layout engine and any assertion there would pass whether
      the observer were wired or deleted (see `preview-screen.test.tsx`).)*
- [x] Preview→download identity: on a **single page**, preview, then Download
      — the download completes without a second compile (no visible compile
      phase) and the file matches what the viewer showed. Then on a **tree**
      scope: preview (truncated), Download — a full compile *does* run and the
      downloaded PDF contains the whole tree, not the truncated preview. This
      is the manual check for the cut-off-PDF trap.
- [x] Iteration loop end to end (the CONFCLOUD-84742 scenario): change page
      content in Confluence, publish, refresh the panel, preview — the change
      appears. Confirm the panel copy makes clear that unpublished edits are
      not previewed.
- [x] Macro wiring: DOCSY page with jira macro renders a real issue table in
      the PDF; toggle "Resolve dynamic macros" off → placeholder +
      `skipped-by-config` note. A jira/`export_view` macro on a **child page**
      of a tree export renders against that child page, not the root
      (`sourcePage` regression, T5.4). An `export_view`-sourced image (if the
      test space has a third-party macro that emits one) renders identically
      — or degrades identically with a placeholder — in both PDF and DOCX
      (`ExternalAssetPolicy`, T5.4); confirm the PDF path no longer
      unconditionally rejects it.
- [x] Long export resilience: start a large-enough tree/space export that it
      runs at least a couple of minutes, then reload the extension
      (`chrome://extensions` → reload, simulating a service-worker restart)
      mid-export — reopening the panel finds the job's eventual result
      (or a clear failure) instead of a silent hang (T5.1 durable-job task).
- [x] **The CONFCLOUD-83694 scenario itself** (T5.6): start a space/tree
      export, then navigate to a different Confluence page while it runs — the
      export **continues**, the panel shows it as a running job, and returning
      to the original page still offers the result. Then repeat while closing
      the side panel entirely: reopening finds the finished job and its
      download, and the toolbar badge indicated completion while the panel was
      closed. Finally confirm the honest limit — closing the browser does end
      the job, and the panel says so rather than pretending otherwise.
- [x] Memory sanity (T5.6 measurement task): with DevTools attached to the
      panel and the offscreen document, run an image-heavy tree export and
      record peak heap. Compare against the pre-T5.6 build. If the fixes did
      not move the number, say so in the PLAN rather than claiming a win.
      *(Manual protocol accepted by the user; no peak figures were supplied or
      recorded here, so the separate numeric T5.6 measurement deliverable
      remains open.)*
- [x] Verify the downloaded multi-page PDF: cover, outline with chapters,
      chapter page breaks, working cross-page links.
- [x] **Delete the DOCSY pages/templates created during the protocol.**
      *(Protocol resources were cleaned up. The three newly-added M1 Abnahme
      010 pages are separate permanent fixtures retained by explicit request.)*
- [ ] `bun run typecheck` + full `bun test` green before commit/push
      (workflow rules).

      *(Typecheck and the focused extension/real-browser checks are green. The
      full PR run on commit `42512b4` completed with 4372 pass, 17 skip and
      three failures, all in spec-012 PDF golden/running-head assertions:
      default-output byte parity, verified page-index query, and one-chapter
      byte parity. They are outside the PDF.js/010 diff, but this box cannot be
      called green while the required suite is red.)*

### What the first manual run found (2026-07-21)

Three defects in one sitting, all in the preview path, all shipped green by a
4300-test suite. They are recorded together because **they are one bug three
times**, and that is the finding worth keeping:

> An option exists, is typed, is documented, and is read by nobody for the
> thing it names.

| # | Defect | The dead option | Fix |
|---|--------|-----------------|-----|
| 1 | "Fit width" did nothing, at any zoom | `renderPage`'s `containerWidth` — **zero** production call sites, so it fell back to `canvas.clientWidth`, which `renderPage` itself had just written. The fit basis was the previous render's own output, making `zoom: 1` a multiplication by one | `f795ab7` — `containerWidth` made required; the screen measures a padding-free frame |
| 2 | The large-preview tab showed nothing | — (a design gap, not a dead option): opening the tab activates it, which the observer read as "the user navigated away", nulling the window's entity. It destroyed its own precondition **and** blanked the side panel behind it | `9f60ae9` — the extension's own pages are no longer a page change |
| 3 | The large preview rendered at side-panel width | `PreviewShellConfig.layout: "compact" \| "full"`, whose docstring said the shells differ "only in a layout value". It decided one button's visibility and a `data-layout` attribute — never a width | `4af16ad` — width is a shell prop; `AppShell`'s `max-w-[400px]` is no longer a constant |

Why the suite could not see #1 and #3: in both cases the *pure* function was
well tested — but only in a configuration production never used, because the
test supplied the argument itself. For #1 the fake was literally
`async renderPage(pageNumber)`, discarding the options object, so the only zoom
test could prove a re-render happened and nothing about its scale.

**The countermeasure now used for all three: a consumption-site test.** Each fix
ships a guard that reads the *caller* and fails if it stops passing the value —
`background.ts` for `ownOrigin`, `entrypoints/preview/App.tsx` for
`layout="full"`. Weaker than a behavioural test, and deliberately so: these are
closures inside entrypoints with nothing to import and drive. A weaker real
check beats a strong imaginary one.

This is the same shape as the CLI findings in
`specs/SUPPORT-CLI-FLAG-AUDIT.md` ("two code paths behind one help line, and
only one honours the flag"). **Closed by scope decision (2026-07-22):** no
extension-wide call-site audit will be run for 010. The three concrete defects
keep their targeted consumption-site guards; there is no hidden audit task.

### Open findings from the same run

- [x] **PDF.js no longer falls back to its "fake worker" in the side panel.** The
      original console finding was recorded at `6246190`; the later local
      bootstrap had not fixed it safely because it exported no
      `WorkerMessageHandler`, breaking PDF.js' own fallback as well. The first
      proposed correction — PDF.js' official legacy pair — was rejected by the
      unchanged MV3 output gate because that build contains a core-js
      `Function(...)` constructor. No exemption was added. The shipped correction
      keeps the clean, sha256-pinned modern assets and turns the local bootstrap
      into a real ES module: it installs the two operations missing from the
      tested Chrome baseline, top-level-awaits the upstream worker, and re-exports
      `WorkerMessageHandler`. Chrome's declared floor is now 140, the oldest
      browser exercised by this packed-extension test.
      `tests/pdf/extension-worker/worker.e2e.ts` loads a temporary copy
      of the real built MV3 extension and proves under `chrome-extension://`
      that the normal path exposes a native `Worker` with no fake-worker warning;
      a second case forces the constructor failure and proves the upstream
      fallback still resolves as `LoopbackPort`. Both pass in headless Chromium.
      The installed-build retest also exposed a separate render-lifecycle race:
      cancellation could reject `render.promise` before annotation loading had
      attached the aggregate handler, causing Chrome to record an unhandled
      `RenderingCancelledException`. The viewer now observes the render promise
      immediately, preserves real failures for its caller, and the regression
      test pins that handler timing. The rebuilt extension completed rapid page,
      zoom and fit changes without another console error.

      Historical evidence retained below. Console:
      `Warning: Setting up fake worker.` from `assets/pdf.min-*.mjs`. The stack
      ends in the `worker.addEventListener("error", …)` branch of
      `PDFWorker.#initialize`, so the worker was *constructed* and then failed
      to load — not a constructor throw (that logs "The worker has been
      disabled." instead). Impact is degradation, not breakage: pdf.js runs the
      worker code on the main thread, so every page render blocks the panel.
      The later diagnosis ruled out both recorded hypotheses: Chromium maps
      `.mjs` to `text/javascript`, and PDF.js regards the local worker URL as the
      same `chrome-extension://<id>` origin, so it does not create its CDN/blob
      wrapper. The exact preceding error line from the historical run was not
      retained. Independently confirmed defects were the unsupported
      modern-runtime surface and the unsafe bootstrap subsequently added around
      it; the corrected ES bootstrap and explicit Chrome floor remove both
      variables without weakening the output gate.

## Definition of Done

- All T5.1–T5.4 UI and adapters implemented in `apps/extension/` with **zero**
  engine logic added to the extension; every exported document is
  byte-reproducible via the CLI with equivalent flags (spot-checked in the
  DOCSY E2E).
- Macros on a non-root page of a tree/space export resolve against their own
  page (`sourcePage`/`contextFor`, Architecture point 6), never silently
  against the export root; blocked and flagged (not shipped mis-resolving)
  if `002-scope-orchestration` has not yet landed `unknown.sourcePage`.
- `SettingsForm.tsx` only writes `RunPdfExportInput.settings`; it does not
  attempt to set a `settings` field on DOCX's `ExportInput` (no such field
  exists today) — DOCX settings threading is tracked as a follow-up, not
  built as untyped/`as any` wiring against an engine seam that doesn't exist.
- The PDF side of the template library is settings-on-the-built-in-template
  only; no PDF/Typst template upload or swap UI ships in this folder
  (`PdfSection.tsx`'s "no template upload required" copy stays accurate).
- The v2 template store's IDB primary key (`recordKey`) and its logical
  resolution key (`templateId`) are distinct fields: a global entry and a
  space-scoped override of the same template coexist without one
  overwriting the other, deleting the override falls back to the global
  entry, and two Atlassian sites sharing a space key never bleed into each
  other's template selection (manual fresh-profile + coexistence tests).
- IndexedDB migration v1→v2 ships with a two-phase, resumable upgrade path
  (schema/marker synchronously inside `onupgradeneeded`, hash/size backfilled
  in a normal transaction afterward — no `await` inside the version-change
  transaction, no `TransactionInactiveError`), a regression test seeded from
  a real v1 database shape plus an interrupted-backfill case, and no
  user-visible template loss in the manual fresh-profile check.
- `htmlToExportBlocks` is exported from `packages/confluence/src/index.browser.ts`
  (landed by 004's own T1.10) and gated in `BROWSER_ENTRYPOINTS`, so the
  extension's `export_view` fallback renderer actually builds.
- `ExternalAssetPolicy` is wired into both the PDF and DOCX asset resolvers
  with matching allow/reject behavior for the same URL; the PDF path no
  longer unconditionally rejects every external image once macro rendering
  ships.
- Asset dedupe exists in exactly one place (`preparePdfDocument`, exact-byte);
  the job store measures and caps the already-canonical bundle it receives
  and never runs a second, independent dedupe pass.
- Progress + abort work for every scope: cancel during fetch, queue, and
  compile each leaves the panel re-exportable without reload.
- Preview never blocks or degrades export: export from a cold panel works
  without ever opening the preview; preview failures render diagnostics, not
  a broken panel; an export queued behind an in-flight preview takes
  priority and completes without paying a cold wasm+font re-init (job-kind
  scheduling, not worker termination, resolves preview/export contention);
  the preview budget is labelled "first N chapters", never "pages".
- The preview renders through a **locally bundled** PDF.js (viewer + worker in
  `REQUIRED_PDF_ARTIFACTS`, sha256-pinned, no CDN, no remotely hosted code),
  lazy-loaded so a panel that never opens the preview never parses it.
- Download reuses cached preview bytes **only** for a non-truncated entry whose
  `sourceIdentity` + settings hash match exactly; a truncated preview can never
  be downloaded as if it were the full document.
- **No gate is relaxed at all.** The planned `DYNAMIC_CODE_RES` exemption was
  dropped after measurement: `pdfjs-dist@6.1.200` contains zero
  `eval`/`new Function` tokens and no longer offers `isEvalSupported` (v6 uses a
  WebAssembly PostScript evaluator). The gate is instead *stronger* than before —
  it now scans `.mjs` (previously unscanned, so the vendored artifacts were
  invisible to every rule), both PDF.js artifacts are sha256-pinned in
  `REQUIRED_PDF_ARTIFACTS`, and a scope test fails if a future exemption is
  introduced. See Architecture point 8.
- Actual PDF.js render coverage lives in the real-browser Playwright harness;
  no unit test simulates a canvas and claims render coverage.
- The panel and docs state plainly that the preview shows the last published
  version, not the open editor draft.
- Job-store budgets enforced pre-flight with actionable errors; no code path
  can store an over-budget bundle.
- A PDF job's status is recoverable from `atlcli-pdf` after a service-worker
  restart mid-compile; no job is left permanently `queued`/`compiling` with
  no path to resolution.
- Navigating to another Confluence page never aborts a running export
  (`PdfSection.tsx:30-37` no longer signals the `AbortController` on identity
  change); only the explicit Cancel button does. The panel re-attaches to
  running and finished jobs on mount, and a badge reports completion that
  happened while the panel was closed — with **no new manifest permission**.
- The offscreen document is never torn down while a compile is in flight, including
  after a service-worker restart has reset the in-memory job counter; in-flight
  state is derived from durable job records, not from `activePdfJobs`.
- No terminal-state cleanup depends on the panel being alive; closing the panel
  mid-export leaves no orphan record holding a full bundle.
- `PDF_STORE_MAX_BYTES` is enforced without deserializing payload records
  (no `getAll()` over bundles), and a status transition does not rewrite the
  payload. Preview cache and background jobs share one documented eviction
  policy over one budget.
- Every byte-handling change in T5.6 is backed by a recorded measurement; a fix
  whose measurement did not justify it is documented as dropped rather than
  landed anyway. Bytes still never cross `chrome.runtime.sendMessage`.
- The panel and docs state the honest durability limit: a background export
  survives navigation, panel close and extension restart, but not closing the
  browser. No wording implies server-side durability.
- Session-fetch macro ports (`JiraIssuePort`, `ExportViewPort`) reuse
  `JiraClient`/`ConfluenceClient`'s existing login-redirect and 429-backoff
  handling; an expired session degrades the live-macro pass with one clear
  note instead of a per-macro placeholder cascade.
- Docs tasks merged in the same release PRs (docs-with-behavior rule);
  CHANGELOG updated; release only after dry-run + manual protocol checklist
  fully checked; all DOCSY test resources deleted.
- `bun run typecheck` and `bun test` green; no new host permissions in
  `apps/extension/wxt.config.ts` (asserted by `tests/manifest.test.ts`).

## Risks & open questions

**Risks**

- **Browser memory on large scopes.** Blocks are small, assets are big
  (BASELINE-DESIGN A2): a space export can exhaust the MV3 panel/offscreen
  memory before hitting the 64 MiB job cap. Mitigation here: `maxPages` +
  pre-flight budget + confirmation; real fix (per-chapter asset streaming
  into the compiler VFS) is a deliberate Later (UMSETZUNGSPLAN T4.9).
- **IndexedDB upgrade while a job is in flight.** A v2 open in the panel
  while the offscreen worker holds a v1 connection to `atlcli-docx` would
  block the upgrade (`onblocked`). Mitigation: the worker never touches the
  template DB (only `atlcli-pdf`), and both stores open→close per operation
  (verified in `template-store.ts` / `job-store.ts` `finally db.close()`);
  keep it that way and add an `onblocked` timeout error rather than a hang.
- **Preview compile cost on tables/diagram-heavy pages.** Even warm compiles
  of pathological pages can take seconds; the debounce bounds the *rate*, and
  for tree/space the first-N truncation bounds the *size*. **Single-page scope
  no longer truncates** (Architecture point 5), so a single pathological page —
  a large test report with many tables and images, precisely the
  CONFCLOUD-84742 user — compiles in full on every debounced change. The UI
  must show a spinner state, never a frozen viewer, and the timing note in the
  report is the signal for whether a per-page cost ceiling is needed after all
  (revisit with the T4.3 benchmark suite, not by guessing now).
- **Vendored viewer: maintenance and bundle weight.** PDF.js is a large,
  actively-moving dependency added next to an already ≥ 20 MB Typst WASM
  artifact. Lazy loading keeps it off the critical path for users who never
  preview, and the sha256 pins in `REQUIRED_PDF_ARTIFACTS` make version bumps a
  visible, reviewed event rather than a silent drift — but it is still a new
  upstream to track for security advisories.
- ~~**A relaxed dynamic-code gate is a standing risk.**~~ **Resolved, not
  mitigated (2026-07-21):** no exemption exists. The vendored PDF.js version
  ships no string-to-code constructors, so the gate stayed intact — see
  Architecture point 8. Residual risk moves to *version drift*: a future
  `pdfjs-dist` upgrade could reintroduce those tokens. That is caught
  mechanically, because the artifacts are sha256-pinned and now actually
  scanned, so a bump is a visible, reviewed event rather than silent drift.
- **`export_view` markup drift** (BASELINE-DESIGN E1 risk): the HTML fallback
  is unversioned upstream; the DOCSY E2E in folders 002/008 is the canary, the
  extension inherits whatever the shared converter does — no extension-side
  parsing to drift independently.
- **Timeout tuning.** The scaled compile timeout is a guess until the
  benchmark suite (T4.3) exists; ship conservative values and surface the
  timeout in the failure message so reports are diagnosable. This
  compounds the MV3 service-worker risk below: a longer legitimate compile
  is also a longer window in which the SW can be reclaimed.
- **MV3 service-worker reclamation mid-export.** `extensionPdfCompilePort`
  holds one `chrome.runtime.sendMessage` open for the whole compile
  (`compile-port.ts:65`) and `background.ts#activePdfJobs` is a volatile
  in-memory counter (`background.ts:49`); Chrome can terminate the service
  worker mid-request (5-minute single-event cap, or an unrelated idle
  teardown) independent of whether work is in flight. Mitigation: the panel
  treats the durable `atlcli-pdf` job record as the source of truth and
  re-attaches to it instead of only awaiting the message response (T5.1
  task); still a risk for the *first* release since MV3 SW lifecycle
  behavior varies across Chrome versions — ship the reattachment path even
  though it is hard to deterministically reproduce the teardown in CI.
- **Cancelling an in-flight compile kills the warm worker.**
  `PdfCompilerHost.cancel()` on the active job calls `destroyWorker()`
  (`compiler-host.ts:52-67`), dropping `compilerPromise` memoization. This is
  correct/expected for a user-initiated **export** cancel (a fresh worker for
  the next attempt is fine), but T5.3's preview-vs-export scheduling (job
  `kind`, Architecture point 5) must never route preview supersession through
  this path, or every debounced settings tweak would pay a full cold
  wasm+font re-init and periodically starve the export click behind FIFO.
- **T5.6 widens this folder's blast radius.** Background jobs plus the byte
  handling behind them touch `packages/pdf` (`validate.ts`, `run-export.ts`,
  the output contract) on top of the host adapters — a host-integration folder
  now carrying engine changes. Mitigation: the set is enumerated and bounded in
  Architecture point 9, every change lands in the shared engine (CLI benefits
  too), and the measurement task can *remove* items from the set. Risk remains
  that review attention spreads thin across a folder that is now noticeably
  larger; splitting T5.6 into its own folder stays the fallback if review or
  landing order becomes unwieldy.
- **The `PdfBytesHandle` storage decision rests on two unverified assumptions**
  (Chrome IDB Blob out-of-heap behavior; PDF.js chunk-loading from `blob:`).
  Both are measured in T5.6's first task, but if both fail the preview cache
  and job retention keep their current heap cost and the "cache is nearly free"
  premise behind T5.3's download-reuse weakens. The seam itself survives either
  outcome; the storage format is what is at stake.
- **"Background job" invites an expectation we cannot meet.** Users who read
  CONFCLOUD-83694 will expect Confluence-style server-side durability. An MV3
  extension cannot survive browser close. The mitigation is copy discipline
  (Definition of Done), but a mismatch between expectation and behavior is a
  support-load risk, not only a wording risk — worth watching in early feedback.
- **Session-port response taxonomy has real-world edge cases beyond the
  fixture set.** Confluence/Jira Cloud auth-redirect and rate-limit responses
  can vary by tenant configuration (SSO providers, custom rate-limit
  headers); `client.ts`'s existing handling is the best available baseline
  but is not exhaustively E2E-tested against every tenant shape. Mitigation:
  reusing `ConfluenceClient`/`JiraClient` means fixes to that handling
  benefit CLI and extension simultaneously instead of drifting.

**Open questions**

1. Preview budget N for **tree/space** scope: fixed 5 chapters, or
   user-adjustable? Proposal: fixed 5 for v1, revisit with telemetry-free
   feedback (report timing note). Note this is a chapter/block budget, not a
   guaranteed PDF page count (see Architecture point 5). Single-page scope is
   settled: no truncation.
2. Where does the *active template selection* live for a user who uses both
   CLI and extension on the same site — is per-host selection acceptable for
   v1 (proposal: yes; the folder-007 site-library attachment adapter is the
   later convergence point)? The `recordKey`'s `siteOrigin` component
   (Architecture point 4) keeps this per-host choice from bleeding across
   sites; it does not yet unify CLI and extension selection — that stays the
   later convergence point.
3. Space-scope permission gaps: page not readable mid-tree — omit with note
   (baseline A1 proposal) or abort? The panel should follow whatever folder
   002 decides (`completenessMode: "strict" | "partial"`,
   `002-scope-orchestration/PLAN.md`); the UI copy depends on it.
4. Presets (named `{templateId, settings}` bundles, B10): panel UI in this
   folder or deferred until folder 007 fixes preset storage scope
   (space-property vs. IndexedDB)? Proposal: defer; `SettingsForm` values per
   template are enough for v1.
5. Manual E2E protocol ownership: release checklist in `CHANGELOG.md` PR, or
   a `spec/`-adjacent living document? Proposal: keep it in this PLAN and
   copy the checklist into each release PR description.
6. DOCX-side `ExportInput.settings` seam: who owns adding it — a new small
   prerequisite folder (mirroring 007's Level-A settings threading, but for
   `packages/docx`), or an extension of 007's own scope? Proposal: a
   follow-up folder scoped narrowly to the DOCX settings contract (owner,
   types, validation, CLI `--set` wiring, `packages/docx` engine change) so
   it lands on its own review/test cycle rather than being smuggled into a
   host-integration folder that isn't supposed to own engine changes (see
   crossPlanImpacts). Until it lands, `SettingsForm.tsx` here stays PDF-only.
7. `.wiki-pdf-template` container adoption timing: 010's DOCX template upload
   stays a raw `.docx` upload (today's format, just multi-slot) rather than
   requiring the `.wiki-pdf-template` container from folder 007 (T2.4). Should
   a later folder migrate DOCX template intake to the shared container format
   (enabling cross-host `.wiki-pdf-template` portability for DOCX too, per
   BASELINE-DESIGN B3), or is raw `.docx` upload permanent for the extension?
   Proposal: raw upload stays for v1; container adoption is a follow-up once
   007's container package matures and is proven for the PDF side.
8. **Manual page-break authoring — own spec folder, not a task in this one.**
   (T5.6 is now taken by durable background jobs; page-break authoring is a
   separate, still-unopened folder.)
   CONFCLOUD-84742's second ask ("insert manual page breaks to control content
   placement") is *not* delivered by this folder. The **render** side already
   exists: `scroll-pagebreak` → `{ type: "pageBreak" }`
   (`packages/confluence/src/export-blocks.ts:1494`) → `#pagebreak(weak: true)`
   (`packages/pdf/src/serialize.ts:1129`). What is missing is **authoring** in
   Confluence Cloud, which Atlassian does not offer natively. A follow-up
   folder should own the whole contract — an `ExportBlock` transformation
   applied before compilation ("break before this heading", "keep heading with
   next paragraph", "do not split this table row"), plus the persistence
   decision. That decision is the open question and must not be defaulted:
   **page/version-scoped local storage silently discards the user's break
   configuration on every page edit**, which for the "tweak 5–10 times" user is
   arguably worse than no feature. Alternatives: content-property storage
   (team-wide, survives edits, needs an explicit Confluence contract) or a
   Confluence macro (authored in-page, portable to the CLI, highest
   integration cost). Recorded here as a crossPlanImpact so 010 links to it;
   scoping, ownership and the persistence choice belong to that folder's own
   review cycle, not to a host-integration folder.
9. **Editor-draft preview** — explicitly out of scope for 010 (see Goal). A
   later proof would have to establish a supported way to read unpublished
   content; it must not be built on undocumented Confluence-internal APIs or
   editor DOM scraping, both of which would drift silently. Open: is there a
   supported draft-content API at all, and is the `edit → publish → preview`
   loop good enough in practice that this never becomes worth the risk?
10. **Preview cost ceiling for pathological single pages** (see Risks): if the
    full single-page preview turns out to be too slow on real test reports,
    what is the fallback — a per-page byte/block ceiling with a "preview
    simplified" note, a manual "Refresh preview" button instead of debounced
    auto-recompile, or accepting the latency? Proposal: decide on evidence from
    the T4.3 benchmark suite, ship debounced auto-recompile for v1.
11. **Retention of finished background jobs.** `cleanupPdfJobs` sweeps at 24 h
    (`job-store.ts:265-290`, `PDF_JOB_MAX_AGE_MS`). Is that right once a
    finished job is a thing the user comes back to? A finished-but-undownloaded
    export holding 64 MiB for 24 h is expensive; deleting it after an hour may
    lose work the user meant to fetch. Proposal: keep 24 h for the record and
    its status, but drop the *payload* earlier (e.g. 2 h) with the UI offering
    "re-run" instead of "download" afterwards — decide with the T5.6
    measurement in hand.
12. **Concurrent background exports.** `PdfCompilerHost` is a single-worker
    FIFO (`compiler-host.ts:83`) and T5.3 adds preview/export priority on top.
    Should the panel allow queuing several tree/space exports, or refuse a
    second while one runs? Proposal: allow queuing but cap at a small number
    (2–3) with the queue visible in `JobsSection.tsx` — unbounded queuing plus
    64 MiB payloads collides with `PDF_STORE_MAX_BYTES` immediately.
13. **The two Forge gating questions** (Architecture point 10): does the Forge
    Custom UI CSP permit `wasm-unsafe-eval`, and does a ≥ 20 MB Typst WASM
    artifact fit its static-resource bundle limits? Not this folder's work, but
    the answers determine whether Track 2 can reuse this engine at all, and
    they should be established before Track 2 architecture is planned rather
    than discovered during it. Owner: whoever opens the Forge folder.

---

## Addendum — note-code vocabulary unification (shipped)

"Same report vocabulary, shipped together" (see Reference, above) was not
actually true: three codes named the same condition differently depending on
which engine, or which host, produced the report. A consumer filtering
`notesByCode` on one spelling matched nothing on the other — silently, because a
missing key and a clean export look identical in most `jq` expressions.

**Resolved to the unprefixed spelling in every case**, since each condition is a
fact about the *source page*, not about the output format or the host:

| Retired | Emitted today | Evidence |
|---|---|---|
| `pdf-image-missing-alt` | `image-missing-alt` | Both engines apply the identical `isMissingAltText` rule to the same source block before any fetch (`packages/pdf/src/prepare.ts`, `packages/docx/src/image.ts`) |
| `pdf-image-skipped` | `image-embed-failed` | Both emit at the same pipeline position when one image's bytes could not be obtained (`prepare.ts` resolver throw ≡ `serialize.ts` `{ ok: false }`) |
| `pdf-mention-unresolved` | `mention-unresolved` | The extension host's spelling of the code both CLI hosts already used |

**Deliberately left distinct** — verified by reading the emitters, not the names:

- **`image-skipped` is NOT the counterpart of `pdf-image-skipped`.** It is
  DOCX's `info` note for "this export was configured with no image pipeline at
  all" (`!ctx.images`), a whole-export configuration fact the PDF engine cannot
  represent — `preparePdfDocument` takes a *required* resolver. The name
  similarity is a trap; the true counterpart is `image-embed-failed`.
- **`pdf-image-alt-fallback`** is the render-stage statement that the filename
  was substituted into `alt:`. DOCX performs the same substitution into `descr`
  silently and emits nothing, so there is no counterpart to unify with.
- **`pdf-mention-resolution-failed`** reports that the whole resolution *call*
  failed (count unknown). The CLI does not wrap `resolveExportMentions`, so it
  has no counterpart either. Its `pdf-` prefix is now misleading — it is
  host-specific, not PDF-specific — but renaming a code with no divergence to
  fix would be a breaking change bought for nothing. Left for a future pass.

**Contract handling.** The report `schema` string stays `atlcli.export-report/1`:
the document *shape* is unchanged, only three values inside it, and the repo's
precedent (the `v1` → `/1` bump) reserves the string for shape changes.
`RETIRED_EXPORT_NOTE_CODES` + `canonicalExportNoteCode()` in
`packages/confluence/src/export-blocks.ts` are the machine-readable migration
path, pinned by tests so the table cannot rot into a comment. Nothing emits both
spellings: dual emission would double every affected tally and inflate `--strict`
counts for a single fact — the defect the duplicate-`mention-unresolved` fix
removed.

**Known remaining divergence, out of scope here:** `pdf-diagram-unsupported` /
`pdf-diagram-failed` (PDF) versus `diagram-unsupported` / `diagram-render-failed`
(DOCX) are the same class of split and were left alone.

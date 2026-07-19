# 010 — Extension integration (scope UI, template library, preview)

Status: Plan, 2026-07-19. Track 1 of `specs/export-expansion/UMSETZUNGSPLAN.md`
(T5.1–T5.5). Design details for the underlying engine capabilities live in
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
    `wasm-unsafe-eval`), `apps/extension/entrypoints/background.ts`
    (offscreen idle timer), `apps/extension/entrypoints/offscreen/main.ts`
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
- **See the PDF before downloading it** (T5.3): an instant, debounced preview
  of the first pages right in the panel, powered by the already-warm compiler
  worker. For DOCX the honest story stays the scan report — we do not fake a
  Word rendering we cannot produce.
- **Pages with live macros export like the page looks** (T5.4): Jira issue
  tables and third-party macro output rendered through the user's own browser
  session — no tokens to configure, which is precisely the extension's edge
  over the CLI.
- **Documented and released as one product** (T5.5): docs/ updated in the same
  release, CHANGELOG, release checklist.

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
   always takes the front of the queue ahead of any queued preview. Preview
   cost is bounded by compiling a truncated composition (first N **chapters**
   of the composed block list — see the honesty note below), not by
   post-processing the PDF — no new PDF-slicing dependency. Output goes to a
   capture sink (bytes, not a download) and is shown via a `blob:` URL in
   Chrome's built-in PDF viewer (`<embed type="application/pdf">` is
   CSP-clean under the existing `script-src 'self' 'wasm-unsafe-eval'`).
   Settings/scope changes are debounced; each new preview supersedes the
   previous one per the coalescing rule above, not via `pdf:cancel` when a
   compile is still active. The background idle timer
   (`entrypoints/background.ts#offscreenIdle`) must treat preview traffic as
   activity so the offscreen document (and with it the warm worker) survives a
   debounce pause. **Honesty note**: "first N pages" is only true when every
   source page compiles to roughly one PDF page. `RunPdfExportInput.blocks`
   only carries block-level structure; actual `pageCount` is known only after
   compile + `validatePdfOutput` (`packages/pdf/src/run-export.ts:161,178` —
   `inspection.pageCount` is read post-compile). A single dense chapter (large
   table, many images) can compile to far more than N PDF pages on its own.
   The panel therefore labels this "Preview — first N chapters" (not
   "pages"), and the truncation additionally carries a block-count/asset-byte
   backstop so a single pathological chapter still bounds preview compile
   time (see T5.3 task).
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

## Tasks

### Scope UI (T5.1)

- [ ] `apps/extension/utils/confluence/tree-source.ts` (new): session-backed
      `TreeSource` adapter (`getPage`, `getChildren` in UI order,
      `getSpaceHomepageId`, `searchPages` for CQL label batches), built on
      `profileFromTabUrl` + `ConfluenceClient` from `@atlcli/confluence/browser`
      (pattern: `utils/read-path.ts`). Every method takes the export
      `AbortSignal`.
- [ ] `apps/extension/utils/scope-state.ts` (new): pure reducer for the scope
      form (kind page/tree/space, `maxDepth`, include-root, label include/
      exclude chips, parse/normalize of comma-separated label input) —
      testable without DOM, mirroring `utils/panel-state.ts`.
- [ ] `apps/extension/entrypoints/sidepanel/ScopeSection.tsx` (new): scope
      radio (Current page / Page + children / Entire space — space option
      enabled when `LoadedPage.details.spaceKey` is present), depth selector,
      and an "Advanced" `<details>` with two label tag inputs
      (include/exclude, OR semantics, `excludeMode` default `prune-subtree` —
      copy explains "excluded pages take their children with them"). Renders a
      page-count confirmation ("212 pages, continue?") before space exports.
- [ ] `apps/extension/utils/pdf/run-export.ts`: accept
      `scope: ExportScope` + `labels?: LabelFilter`; call `fetchExportTree` →
      `composeChapters`; extend `sourceIdentity` with a scope+filter
      discriminator (today `pageUrl|id|version` — a tree export must never
      reuse a single-page cache identity); forward `onProgress`
      (`{ fetched, total, currentTitle }`) alongside the existing `onPhase`.
- [ ] `apps/extension/utils/pdf/run-export.ts` + `apps/extension/utils/docx/env.ts`:
      key attachment fetches on `ref.pageId ?? rootPageId` once folder 002
      lands `ImageSource.pageId` (BASELINE-DESIGN A1, recommended variant).
- [ ] `apps/extension/entrypoints/sidepanel/PdfSection.tsx` +
      `TemplateSection.tsx`: consume the shared scope; progress line
      "Page 37/210: <title>" during `fetching`; Cancel keeps working mid-walk
      (signal reaches `fetchExportTree`, not only the compile — verify the
      `pdf:cancel` path still tears down queued jobs).
- [ ] `apps/extension/utils/pdf/job-store.ts` budget hardening for multi-page
      bundles: pre-flight estimate, computed from `preparePdfDocument`'s
      already-deduped asset list (`packages/pdf/src/prepare.ts` — do **not**
      re-implement dedupe in the job store, see Architecture point 2), with
      an error that names the largest assets and suggests `maxDepth`/label
      filters instead of failing after a long fetch; keep
      `PDF_JOB_MAX_BYTES`/`PDF_STORE_MAX_BYTES` values (document why in the
      module comment).
- [ ] `apps/extension/utils/pdf/compiler-host.ts`: make `timeoutMs` scale with
      job size (e.g. base 60 s + per-page increment carried in the job
      record) so a 200-page space compile is not killed as a hang.
- [ ] Durable job survival across service-worker restarts (Architecture
      point 3): the panel's export flow re-attaches to a running/finished job
      by reading `job.status` from `atlcli-pdf` (`utils/pdf/job-store.ts`)
      instead of depending solely on the open `chrome.runtime.sendMessage`
      response reaching it; `background.ts` rebuilds any in-memory tracking
      (`activePdfJobs` and equivalents) from persisted job records on
      startup rather than assuming a fresh `0`; a job whose worker never
      reports back within its timeout is marked `failed` with a
      recoverable error, never left `queued`/`compiling` forever.

### Template library UI & migration (T5.2)

- [ ] `apps/extension/utils/docx/template-store.ts` — **DB migration v1→v2**
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
         and a `migrationPending: true` marker: `{ recordKey:
         "<site>|docx|<templateId>|global", templateId: crypto.randomUUID(),
         displayName: name, engine: "docx", scope: "global", name, bytes,
         uploadedAt, sha256: null, size, migrationPending: true }` (v1 only
         ever stored DOCX templates, so `engine: "docx"` is safe; `<site>` is
         read from the ambient session profile at migration time, not from
         the record — see Open questions if no site is resolvable); delete
         key `"current"`; create indexes `engine`, `scope`, `spaceKey`,
         `migrationPending`; create object store `template-prefs` (keyPath
         `recordKey`, e.g. `<site>|<engine>|<spaceKey>`) for the active
         selection and per-template settings values.
      2. **Async backfill, after the upgrade transaction commits** (normal
         `readwrite` transaction, opened once the `onupgradeneeded`/`onsuccess`
         handler returns): for every record with `migrationPending: true`,
         compute `sha256Hex(bytes)` and `size`, `put()` the completed record,
         clear the marker. Resumable by construction: if the panel is closed
         mid-backfill, the next open finds `migrationPending` records via the
         index and finishes them — no partial-hash record is ever presented
         as migrated.
      3. No data leaves IndexedDB — scan verdicts stay derived-on-read
         (existing invariant in the module docstring stays true for v2).
      4. Idempotent: opening at `DB_VERSION` 2 a second time (schema already
         current, no `migrationPending` records left) is a no-op.
- [ ] `apps/extension/utils/templates/library.ts` (new): adapt the v2 store to
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
- [ ] `apps/extension/entrypoints/sidepanel/TemplateSection.tsx`: replace the
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
- [ ] `apps/extension/entrypoints/sidepanel/SettingsForm.tsx` (new): generic
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
- [ ] `apps/extension/utils/docx/env.ts`: `idbTemplateSource` resolves through
      the library (active entry for engine+space, via `template-prefs`'s
      `recordKey`) instead of the literal `"current"` slot; keep
      `memoryTemplateSource` re-export untouched.

### PDF preview (T5.3)

- [ ] `apps/extension/utils/pdf/compiler-host.ts`: add a `kind: "preview" |
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
- [ ] `apps/extension/utils/pdf/preview.ts` (new): `runPdfPreview(input, deps)`
      — same pipeline as `runPdfExport` but (a) blocks truncated to a
      first-N-**chapters** budget (slice of the composed chapter list, N
      default 5, labelled honestly in the UI as "Preview — first N chapters"
      — not "pages": a single source page can compile to many PDF pages, and
      `pageCount` is only known post-compile via `validatePdfOutput`
      (`packages/pdf/src/run-export.ts:161,178`), so the panel cannot promise
      an actual page count before compiling), with an additional block-count
      and asset-byte ceiling on the truncated slice so one pathological
      chapter (huge table, many images) still bounds preview compile time
      even though it counts as "1" against the chapter budget; (b) `output`
      is a capture sink returning bytes instead of `downloadBytes`, (c)
      reuses `extensionPdfCompilePort`/`kind: "preview"` so the compile rides
      the warm worker per the coalescing contract above.
- [ ] `apps/extension/entrypoints/sidepanel/PdfPreview.tsx` (new): renders the
      captured bytes as `<embed type="application/pdf">` over a `blob:` URL
      (revoke the previous URL on replace/unmount); shows compile diagnostics
      inline on failure; collapsed by default behind a "Preview" toggle so the
      common export click never pays a preview compile.
- [ ] Debounce + coalescing: settings-form and scope changes trigger a
      preview recompile after ~400 ms of quiet; each new trigger supersedes
      the in-flight preview per the `kind: "preview"` coalescing rule above
      (**not** `pdf:cancel` → `PdfCompilerHost.cancel` — that path terminates
      the worker); preview jobs use the normal job store and are deleted in
      `finally` like export jobs (no budget creep). A user-initiated export
      click still goes through the real `AbortController` → `pdf:cancel` path
      when the user explicitly cancels an export.
- [ ] `apps/extension/entrypoints/background.ts`: count `pdf:compile` traffic
      from previews as offscreen activity (reset `offscreenIdle`) so the warm
      worker is not torn down between debounced previews; verify the idle
      close still happens after the panel goes quiet.
- [ ] Honest DOCX story: no fake Word preview. `TemplateSection.tsx` keeps the
      scan report (placeholder verdicts) as the DOCX "preview"; add one line
      of copy explaining why ("Word rendering happens in Word — the scan
      shows exactly what will be filled in"). No task may add an HTML
      approximation of the DOCX output.

### Macro renderer wiring (T5.4)

- [ ] **Prerequisite (owned by 004, verify only)**: 004's T1.10 now exports
      `packages/confluence/src/html-to-blocks.ts` from
      `packages/confluence/src/index.browser.ts` itself
      (`004-macro-renderer/PLAN.md:415-450,1053-1054`) — do not re-add it
      here, that would duplicate 004's own task. Verify, once 004 lands,
      that `html-to-blocks.ts` is on `BROWSER_ENTRYPOINTS` in
      `scripts/check-browser-build.ts` (add it here only if 004's task
      missed that specific check file) before wiring it into
      `defaultRegistry` below.
- [ ] `apps/extension/utils/macros/session-ports.ts` (new): `JiraIssuePort`
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
- [ ] Per-source-page macro context: wire `packages/export-macros`'s
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
- [ ] `ExternalAssetPolicy` wiring (Architecture point 6): implement the
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
- [ ] Wire the registry through the existing env seams: `ExportEnv.macros` in
      the DOCX path (`apps/extension/entrypoints/sidepanel/TemplateSection.tsx`
      export handler via `utils/docx/export-deps.ts`) and `PdfExportEnv`
      (`apps/extension/utils/pdf/run-export.ts`), with the renderer set from
      `packages/export-macros` (jira, diagram preview-PNG, `export_view`
      fallback) — one registry construction site per engine path, no
      extension-local renderer logic.
- [ ] Progressive-disclosure toggle "Resolve dynamic macros (contacts
      Jira/Confluence)" in `ScopeSection.tsx`'s Advanced block, default ON;
      OFF yields deterministic exports (chain stops at native conversion +
      placeholder, report note `skipped-by-config`).
- [ ] Report surfacing: `PdfReportView` (`PdfSection.tsx`) and the DOCX report
      view group the new note classes (`rendered-via`, `degraded`,
      `skipped-by-config`) so "3 macros rendered live, 1 degraded" is visible
      without expanding all notes.
- [ ] Verify `apps/extension/wxt.config.ts` host permissions cover the Jira
      REST calls on Cloud sites (`*://*.atlassian.net/*` — same origin) and
      assert it in `apps/extension/tests/manifest.test.ts`; no new
      permissions expected, fail the task if one becomes necessary (that is a
      review-worthy scope change).

### Docs & release (T5.5)

Docs are first-class (CLAUDE.md): same PR as the features, per-page template
(intro → prerequisites → steps → options → examples → troubleshooting →
related topics), UI-first (panel) and config-first (CLI) paths clearly
labelled, ≥ 1 minimal + 1 advanced example per feature.

- [ ] `src/content/docs/confluence/export.md`: extend with scope selection
      (tree/space), label filters, and settings — CLI flags (config-first)
      and panel steps (UI-first) side by side; troubleshooting for the new
      failure shapes (page limit, asset budget with named offenders, label
      filter produced empty document).
- [ ] `src/content/docs/confluence/export-templates.md` (new): template
      library concept (global vs. space, `resolveTemplate` precedence), CLI
      directories (`~/.atlcli/templates/`, sync-dir space templates) and panel
      library management, manifest settings reference table (each setting:
      type, default, required/optional, constraints) per the docs reference
      standard.
- [ ] `src/content/docs/confluence/macro-compatibility.md` (new):
      compatibility matrix of supported compatibility macros by their storage
      names (`scroll-pagebreak`, `scroll-landscape`, `scroll-portrait`,
      `scroll-only`, `scroll-ignore`, `scroll-title`, …) and dynamic macros
      (jira, drawio/gliffy, `export_view` fallback) with per-engine behavior
      and degradation notes. Macro identifiers only — no third-party product
      or vendor names.
- [ ] `src/content/docs/extension/` (new section): `index.md` (install/load,
      what the panel can do) and `export.md` (scope UI, template library,
      preview walkthrough with captioned screenshots per docs media standard);
      cross-link with the Confluence guides ("Related topics").
- [ ] `src/content/docs/recipes/ci-cd-docs.md`: update with the scope/label
      flags and `--report json` recipes (kept in lockstep with folder 008's
      CLI work — one product, one docs release).
- [ ] `CHANGELOG.md`: entries per Conventional-Commit scope
      (`feat(extension): …`, `feat(confluence): …`, `docs: …`).
- [ ] Release: `bun scripts/release.ts <type> --dry-run` first, never
      automatic; post-release verify GitHub release page, Homebrew tap
      (`brew info atlcli`), CHANGELOG.md; run the manual extension
      verification protocol (Tests section) against the release build before
      tagging.

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

- [ ] `apps/extension/tests/scope-state.test.ts`: scope reducer — kind
      transitions, depth bounds, label parsing/dedupe, prune-subtree default.
- [ ] `apps/extension/tests/scope-section.test.tsx`: progressive disclosure
      (advanced closed by default), space option gating on `spaceKey`,
      confirmation copy for space scope.
- [ ] `apps/extension/tests/pdf/run-export-scope.test.ts`: scope-aware
      `runPdfExport` against a **fake `TreeSource`** (port fake, no HTTP):
      composed chapters reach the neutral engine, `sourceIdentity` differs
      between page and tree scope for the same root, abort during the walk
      stops fetching and stores no job, `onProgress` sequence is ordered.
- [ ] `apps/extension/tests/pdf/run-export-scope.test.ts` (extend): a macro on
      a **non-root** `ExportPageNode` resolves `MacroExportContext` from
      `block.sourcePage`, not the root page — regression for Architecture
      point 6/T5.4's per-source-page context task (fake `TreeSource` +
      port-fake registry, no HTTP).
- [ ] `apps/extension/tests/pdf/job-store.test.ts` (extend): pre-flight
      rejection reads the already-deduped asset list from a fake
      `preparePdfDocument` result and names the largest offenders (no
      dedupe logic inside `job-store.ts` itself — assert it does *not*
      duplicate `prepare.ts`'s hashing); regression: a bundle > 64 MiB fails
      before any IDB write.
- [ ] `apps/extension/tests/docx/template-store-migration.test.ts` (new,
      fake-indexeddb): seed a **v1** database containing a `"current"`
      record, reopen at `DB_VERSION` 2, assert (a) the synchronous phase
      completes with a `migrationPending: true` placeholder record (`recordKey`
      set, `templateId` a fresh uuid, `engine: "docx"`, `scope: "global"`,
      `sha256: null`) and `"current"` key gone, immediately after
      `onupgradeneeded` returns — i.e. before the async backfill runs; (b)
      the async backfill completes `sha256`/`size` and clears
      `migrationPending`; (c) **interrupted backfill**: close the connection
      between phase 1 and phase 2, reopen — the `migrationPending` record is
      found via its index and finished, never left half-migrated; (d) second
      open at v2 (already migrated) is a no-op; (e) empty v1 DB migrates
      cleanly; (f) no `TransactionInactiveError` is thrown at any point (the
      test fails loudly if phase 1 contains an `await`).
- [ ] `apps/extension/tests/templates/library.test.ts`: v2-store
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
- [ ] `apps/extension/tests/settings-form.test.tsx`: one case per widget type
      (`text|boolean|choice|color|number|asset`), default filling from
      manifest, invalid number/color rejection, values round-trip to
      `template-prefs`; PDF-only for v1 — assert the form never attempts to
      write a `settings` field onto a DOCX `ExportInput`.
- [ ] `apps/extension/tests/pdf/preview.test.ts`: truncation budget is
      chapter-count **and** block/asset-byte bounded (a single oversized
      chapter is still capped, not just counted as "1 of N"); capture sink
      returns bytes without invoking download; a superseded preview resolves
      as discarded **without** the worker being terminated (assert
      `destroyWorker`/`terminate` is not called on preview supersession,
      only on an explicit export cancel); blob URL revocation on replace.
- [ ] `apps/extension/tests/pdf/compiler-host.test.ts` (extend): `kind:
      "preview" | "export"` scheduling — an export queued behind an
      in-flight preview jumps ahead; rapid preview→preview→export creates
      exactly one worker instance (`createWorker` call count); a queued
      preview superseded before it starts never reaches the worker.
- [ ] `apps/extension/tests/macros/session-ports.test.ts`: constructed real
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
- [ ] `apps/extension/tests/macros/external-asset-policy.test.ts` (new): same
      fixture set (site-origin URL, allowed Atlassian media origin,
      disallowed third-party origin, redirect to a disallowed origin,
      loopback/private target) run through **both** `utils/pdf/run-export.ts`'s
      resolver and `utils/docx/env.ts`'s `sessionAssetFetcher` — assert
      identical allow/reject outcomes across engines.
- [ ] `apps/extension/tests/pdf/compiler.test.ts` (extend): warm-worker
      preview-then-export sequence compiles both from one compiler instance;
      multi-chapter bundle compile stays under the scaled timeout.
- [ ] `apps/extension/tests/pdf/job-durability.test.ts` (new): re-instantiate
      the background router mid-job (simulating a service-worker restart —
      drop and rebuild `activePdfJobs`/message listeners without touching the
      `atlcli-pdf` job record) and assert the panel can still find the job's
      eventual `status` in the store; a job whose worker never responds
      within its timeout ends up `failed`, not stuck `queued`/`compiling`
      forever.

E2E — primary path via CLI against DOCSY (engine behavior is owned and covered
by folders 002/008; CLAUDE.md workflow: profile `mayflower`, space `DOCSY`,
project `ATLCLI`):

- [ ] Create a small DOCSY test tree (root + 2 levels, labels `handbook` /
      `internal`, one page with a jira macro on `ATLCLI` issues, one with a
      compatibility page-break macro) via `atlcli`; export it with
      `--tree`, `--label-exclude internal`, both engines; assert report notes
      (`label-filtered`, macro `rendered-via`) — this validates the exact
      engine pipeline the extension re-hosts, over real HTTP. Put the jira
      macro on a **non-root, non-leaf child page** specifically, and assert
      the rendered issue table reflects that child page's macro instance
      (not silently the root's) — the concrete regression for the
      `sourcePage`/`contextFor` gap (Architecture point 6, T5.4 task).
- [ ] **Clean up all DOCSY test pages and ATLCLI test issues after the run**
      (workflow rule; the tree-export tests must delete the whole created
      subtree, not just the root).

E2E — extension-specific: a **manual verification protocol per release**
(Chrome extension E2E is not CI-automatable here without mocking; the
Playwright conformance harness in `apps/browser-export-harness` covers engine
parity, not the panel chrome). Execute and check off before each release, with
the same profile-equivalent browser session (logged in to the `mayflower`
site):

- [ ] `bun run build`, load `apps/extension/.output/chrome-mv3` unpacked in
      Chrome (≥ 116); open the side panel on a DOCSY page.
- [ ] Single page: export PDF + DOCX; files download; reports show no
      unexpected warnings.
- [ ] Tree scope: select "Page + children" on the DOCSY test root, exclude
      label `internal`; progress shows "Page n/total"; Cancel mid-fetch aborts
      within ~1 s and leaves no stuck job (re-export works immediately).
- [ ] Space scope: confirmation shows a plausible page count; export completes
      or fails with the friendly budget error (both acceptable outcomes must
      be legible to the user).
- [ ] Template library: upload two templates, assign one to DOCSY as space
      override, verify the export uses the override and that deleting it falls
      back to global; reload the panel — selection survives (IndexedDB v2).
- [ ] Fresh-profile migration: load the previous release build, upload a
      template (v1 `"current"`), then load this release build — the template
      appears as a global library entry, no data loss.
- [ ] Preview: open preview, change a setting (e.g. orientation) — preview
      updates after the debounce, first compile noticeably slower than the
      second (warm worker); Export after preview reuses the warm worker
      (compile time < first preview). Trigger several rapid settings changes
      to queue overlapping previews, then immediately click Export — Export
      completes without waiting for a queued preview to finish and without a
      visible cold-init pause (job-kind priority + no worker termination on
      supersession, T5.3).
- [ ] Macro wiring: DOCSY page with jira macro renders a real issue table in
      the PDF; toggle "Resolve dynamic macros" off → placeholder +
      `skipped-by-config` note. A jira/`export_view` macro on a **child page**
      of a tree export renders against that child page, not the root
      (`sourcePage` regression, T5.4). An `export_view`-sourced image (if the
      test space has a third-party macro that emits one) renders identically
      — or degrades identically with a placeholder — in both PDF and DOCX
      (`ExternalAssetPolicy`, T5.4); confirm the PDF path no longer
      unconditionally rejects it.
- [ ] Long export resilience: start a large-enough tree/space export that it
      runs at least a couple of minutes, then reload the extension
      (`chrome://extensions` → reload, simulating a service-worker restart)
      mid-export — reopening the panel finds the job's eventual result
      (or a clear failure) instead of a silent hang (T5.1 durable-job task).
- [ ] Verify the downloaded multi-page PDF: cover, outline with chapters,
      chapter page breaks, working cross-page links.
- [ ] **Delete the DOCSY pages/templates created during the protocol.**
- [ ] `bun run typecheck` + full `bun test` green before commit/push
      (workflow rules).

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
- Job-store budgets enforced pre-flight with actionable errors; no code path
  can store an over-budget bundle.
- A PDF job's status is recoverable from `atlcli-pdf` after a service-worker
  restart mid-compile; no job is left permanently `queued`/`compiling` with
  no path to resolution.
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
  of pathological pages can take seconds; the debounce plus first-N truncation
  bounds it, but the UI must show a spinner state, never a frozen embed.
  Fallback if `<embed>` proves flaky across Chrome versions: render pages to
  canvas via the compiler's SVG output (bigger task — only on evidence).
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
- **Session-port response taxonomy has real-world edge cases beyond the
  fixture set.** Confluence/Jira Cloud auth-redirect and rate-limit responses
  can vary by tenant configuration (SSO providers, custom rate-limit
  headers); `client.ts`'s existing handling is the best available baseline
  but is not exhaustively E2E-tested against every tenant shape. Mitigation:
  reusing `ConfluenceClient`/`JiraClient` means fixes to that handling
  benefit CLI and extension simultaneously instead of drifting.

**Open questions**

1. Preview budget N: fixed 5 chapters, or user-adjustable? Proposal: fixed 5
   for v1, revisit with telemetry-free feedback (report timing note). Note
   this is a chapter/block budget, not a guaranteed PDF page count (see
   Architecture point 5).
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
7. `.atlcli-template` container adoption timing: 010's DOCX template upload
   stays a raw `.docx` upload (today's format, just multi-slot) rather than
   requiring the `.atlcli-template` container from folder 007 (T2.4). Should
   a later folder migrate DOCX template intake to the shared container format
   (enabling cross-host `.atlcli-template` portability for DOCX too, per
   BASELINE-DESIGN B3), or is raw `.docx` upload permanent for the extension?
   Proposal: raw upload stays for v1; container adoption is a follow-up once
   007's container package matures and is proven for the PDF side.

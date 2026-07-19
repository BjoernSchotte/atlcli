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

## Dependencies (M1 folders 001–004, 007)

This folder starts after milestone M1 (UMSETZUNGSPLAN "Baseline richtig gut")
and consumes only published seams of sibling folders (of which `003-content-features`
already exists on disk; the others land with their lanes):

| Folder | Provides (consumed here) |
|---|---|
| 001 (scope & orchestration, Lane A / T1.1–T1.3) | `ExportScope`, `LabelFilter`, `TreeSource` port, `fetchExportTree` (with `signal`, `onProgress`, `maxPages`), `composeChapters` in `packages/confluence/src/{export-scope,tree-fetch,compose-document}.ts` |
| 002 (CLI scope & PDF commands, Lane K / T3.1–T3.4) | CLI parity + the DOCSY E2E coverage of engine behavior this folder's tests lean on |
| 003 (content features, Lane C — `specs/export-expansion/003-content-features/`) | compatibility-macro rendering (`pageBreak`, `orientation`, captions) that must survive unchanged through the panel path |
| 004 (macro renderers, Lane E / T1.7–T1.10) | `MacroRenderer` registry + `resolveMacroBlocks` in `packages/export-macros`, ports `JiraIssuePort`, `ExportViewPort`, fallback chain incl. `export_view` |
| 007 (template library, Lane P / T2.1–T2.4) | `TemplateLibrary`/`TemplateLibraryEntry` + pure `resolveTemplate(entries, id, spaceKey)` in `packages/core/src/template-library.ts`, `settings` threading (`RunPdfExportInput.settings`), manifest settings types (`text|boolean|choice|color|number|asset`) |

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
   (they protect the profile's IndexedDB quota), add (a) sha256 asset dedupe
   before the cap check (baseline A1 risk note), (b) a pre-flight size
   estimate with a friendly, named-offender error before any job is stored,
   (c) a page-count confirmation for `space` scope (baseline A2 UX), and
   (d) a compile timeout in `PdfCompilerHost` that scales with page count
   instead of the flat 60 s.
3. **Template library (T5.2).** `utils/docx/template-store.ts` migrates
   IndexedDB `atlcli-docx` v1 → v2 (multi-slot records + indexes, migration
   plan in the task list). A new `utils/templates/library.ts` adapts the v2
   store to the folder-007 `TemplateLibrary` interface; selection resolution is
   the **pure, shared** `resolveTemplate` from `@atlcli/core` — the panel must
   not grow its own precedence rules. The settings form is one generic
   renderer (`SettingsForm.tsx`) over the manifest schema, the same widget
   vocabulary the CLI documents for `--set key=value`.
4. **Preview (T5.3).** No second compiler: the preview path reuses
   `extensionPdfCompilePort` → offscreen `PdfCompilerHost` → memoized
   `compilerPromise` in `workers/pdf-compiler.ts`, so the first preview pays
   wasm+font init once and every subsequent preview is a warm compile. Preview
   cost is bounded by compiling a truncated composition (first N pages of the
   composed block list), not by post-processing the PDF — no new PDF-slicing
   dependency. Output goes to a capture sink (bytes, not a download) and is
   shown via a `blob:` URL in Chrome's built-in PDF viewer (`<embed
   type="application/pdf">` is CSP-clean under the existing
   `script-src 'self' 'wasm-unsafe-eval'`). Settings/scope changes are
   debounced; each new preview aborts the previous via the existing
   `pdf:cancel` path. The background idle timer
   (`entrypoints/background.ts#offscreenIdle`) must treat preview traffic as
   activity so the offscreen document (and with it the warm worker) survives a
   debounce pause.
5. **Macro renderers (T5.4).** New `utils/macros/session-ports.ts` implements
   the folder-004 ports over session fetch: `JiraIssuePort` against
   `<site>/rest/api/3` (covered by the existing `*://*.atlassian.net/*` host
   permission — same origin as Confluence Cloud), `ExportViewPort` against the
   Confluence REST `export_view`/macro-body endpoints. The registry is passed
   through the existing env seams (`ExportEnv.macros` /
   `PdfExportEnv.macros`); without the ports the chain degrades exactly as in
   the CLI (placeholder + report note — "never silently drop").
6. **Panel layout.** `App.tsx` gains a shared `ScopeSection` above the two
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
      key attachment fetches on `ref.pageId ?? rootPageId` once folder 001
      lands `ImageSource.pageId` (BASELINE-DESIGN A1, recommended variant).
- [ ] `apps/extension/entrypoints/sidepanel/PdfSection.tsx` +
      `TemplateSection.tsx`: consume the shared scope; progress line
      "Page 37/210: <title>" during `fetching`; Cancel keeps working mid-walk
      (signal reaches `fetchExportTree`, not only the compile — verify the
      `pdf:cancel` path still tears down queued jobs).
- [ ] `apps/extension/utils/pdf/job-store.ts` budget hardening for multi-page
      bundles: sha256 dedupe of identical asset bytes before `putPdfJob`'s cap
      check; pre-flight estimate with an error that names the largest assets
      and suggests `maxDepth`/label filters instead of failing after a long
      fetch; keep `PDF_JOB_MAX_BYTES`/`PDF_STORE_MAX_BYTES` values (document
      why in the module comment).
- [ ] `apps/extension/utils/pdf/compiler-host.ts`: make `timeoutMs` scale with
      job size (e.g. base 60 s + per-page increment carried in the job
      record) so a 200-page space compile is not killed as a hang.

### Template library UI & migration (T5.2)

- [ ] `apps/extension/utils/docx/template-store.ts` — **DB migration v1→v2**
      (`DB_NAME "atlcli-docx"`, `DB_VERSION` 1 → 2), executed inside the
      `onupgradeneeded` upgrade transaction:
      1. keep object store `templates` (keyPath `id`);
      2. read the legacy `"current"` record (if present) and rewrite it as a
         library entry: `{ id: crypto.randomUUID(), displayName: name,
         engine: "docx", scope: "global", name, bytes, uploadedAt,
         sha256, size }` (v1 only ever stored DOCX templates, so
         `engine: "docx"` is safe); delete key `"current"`;
      3. create indexes `engine`, `scope`, `spaceKey`;
      4. create object store `template-prefs` (keyPath `key`) for the active
         selection per `engine|spaceKey` and per-template settings values;
      5. no data leaves IndexedDB — scan verdicts stay derived-on-read
         (existing invariant in the module docstring stays true for v2).
- [ ] `apps/extension/utils/templates/library.ts` (new): adapt the v2 store to
      the folder-007 `TemplateLibrary` interface (`list(engine, spaceKey)`,
      sha256-verified `getBytes(entry)`); selection = pure
      `resolveTemplate(entries, id, spaceKey)` from
      `packages/core/src/template-library.ts` — space entry beats global,
      identical to the CLI (`~/.atlcli/templates/` global vs. sync-dir space
      templates).
- [ ] `apps/extension/entrypoints/sidepanel/TemplateSection.tsx`: replace the
      single-slot UI with a library list (name, scope badge Global/Space,
      uploaded date, scan verdict re-derived on read), actions upload / set
      active / assign to current space / delete; sha256 mismatch on
      `getBytes` is a hard "template was modified — re-upload" error, never a
      silent fallback (BASELINE-DESIGN B2 UX).
- [ ] `apps/extension/entrypoints/sidepanel/SettingsForm.tsx` (new): generic
      form renderer over the template-manifest settings schema
      (`text | boolean | choice | color | number | asset` — folder 007 / B10);
      values persisted per template in `template-prefs`; feeds
      `RunPdfExportInput.settings` (PDF) and `ExportInput` settings defaults
      (DOCX); presets are out of scope here (folder 007 owns preset storage
      semantics — open question below).
- [ ] `apps/extension/utils/docx/env.ts`: `idbTemplateSource` resolves through
      the library (active entry for engine+space) instead of the literal
      `"current"` slot; keep `memoryTemplateSource` re-export untouched.

### PDF preview (T5.3)

- [ ] `apps/extension/utils/pdf/preview.ts` (new): `runPdfPreview(input, deps)`
      — same pipeline as `runPdfExport` but (a) blocks truncated to a
      first-N-pages budget (slice of the composed chapter list, N default 5
      chapters/pages, labelled honestly in the UI as "Preview — first N
      pages"), (b) `output` is a capture sink returning bytes instead of
      `downloadBytes`, (c) reuses `extensionPdfCompilePort` so the compile
      rides the warm worker (`compilerPromise` memoization in
      `apps/extension/workers/pdf-compiler.ts` + live worker in
      `PdfCompilerHost` — no new compiler instance, first preview warms the
      export path too).
- [ ] `apps/extension/entrypoints/sidepanel/PdfPreview.tsx` (new): renders the
      captured bytes as `<embed type="application/pdf">` over a `blob:` URL
      (revoke the previous URL on replace/unmount); shows compile diagnostics
      inline on failure; collapsed by default behind a "Preview" toggle so the
      common export click never pays a preview compile.
- [ ] Debounce + cancellation: settings-form and scope changes trigger a
      preview recompile after ~400 ms of quiet; each trigger aborts the
      in-flight preview (`AbortController` → existing `pdf:cancel` →
      `PdfCompilerHost.cancel`); preview jobs use the normal job store and are
      deleted in `finally` like export jobs (no budget creep).
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

- [ ] `apps/extension/utils/macros/session-ports.ts` (new): session-fetch
      implementations of the folder-004 ports —
      `JiraIssuePort` (`getIssue`, `searchJql`) against
      `<profile.baseUrl>/rest/api/3` with `credentials: "include"`, and
      `ExportViewPort.renderMacroHtml(pageId, macroId)` against the Confluence
      v1 macro-body + contentbody-convert endpoints (BASELINE-DESIGN E1/E2
      "Extension: Session-Fetch gegen …/rest/api/3 derselben Site"). Both
      honor the export `AbortSignal`; 403/404 map to the chain's `skip` so the
      fallback (placeholder + note) applies instead of aborting the export.
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
      flags and `--report json` recipes (kept in lockstep with folder 002's
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
- [ ] `apps/extension/tests/pdf/job-store.test.ts` (extend): asset dedupe
      before cap check; pre-flight rejection names offenders; regression: a
      bundle > 64 MiB fails before any IDB write.
- [ ] `apps/extension/tests/docx/template-store-migration.test.ts` (new,
      fake-indexeddb): seed a **v1** database containing a `"current"` record,
      reopen at `DB_VERSION` 2, assert the record is rewritten to a library
      entry (uuid id, `engine: "docx"`, `scope: "global"`, sha256/size
      computed), `"current"` key gone, indexes and `template-prefs` store
      exist; second open at v2 is a no-op (idempotent upgrade); empty v1 DB
      migrates cleanly.
- [ ] `apps/extension/tests/templates/library.test.ts`: v2-store
      `TemplateLibrary` adapter — `list` filtering by engine/space,
      `getBytes` sha256 verification failure is a hard error; resolution
      itself is `resolveTemplate` from `@atlcli/core` (already covered by
      folder-007 unit tests — do not re-test the pure function here, test the
      adapter's wiring of it).
- [ ] `apps/extension/tests/settings-form.test.tsx`: one case per widget type
      (`text|boolean|choice|color|number|asset`), default filling from
      manifest, invalid number/color rejection, values round-trip to
      `template-prefs`.
- [ ] `apps/extension/tests/pdf/preview.test.ts`: truncation budget (N-page
      slice), capture sink returns bytes without invoking download, debounce
      cancels the prior job (fake timers via injected `schedule`, pattern:
      `compiler-host.test.ts`), blob URL revocation on replace.
- [ ] `apps/extension/tests/macros/session-ports.test.ts`: port fakes only for
      registry wiring (403 → `skip` → placeholder note; toggle OFF →
      `skipped-by-config`); the real HTTP behavior of these adapters is
      exercised exclusively E2E (below), never via mocked fetch.
- [ ] `apps/extension/tests/pdf/compiler.test.ts` (extend): warm-worker
      preview-then-export sequence compiles both from one compiler instance;
      multi-chapter bundle compile stays under the scaled timeout.

E2E — primary path via CLI against DOCSY (engine behavior is owned and covered
by folders 002/008; CLAUDE.md workflow: profile `mayflower`, space `DOCSY`,
project `ATLCLI`):

- [ ] Create a small DOCSY test tree (root + 2 levels, labels `handbook` /
      `internal`, one page with a jira macro on `ATLCLI` issues, one with a
      compatibility page-break macro) via `atlcli`; export it with
      `--tree`, `--label-exclude internal`, both engines; assert report notes
      (`label-filtered`, macro `rendered-via`) — this validates the exact
      engine pipeline the extension re-hosts, over real HTTP.
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
      (compile time < first preview).
- [ ] Macro wiring: DOCSY page with jira macro renders a real issue table in
      the PDF; toggle "Resolve dynamic macros" off → placeholder +
      `skipped-by-config` note.
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
- IndexedDB migration v1→v2 ships with an idempotent upgrade path, a
  regression test seeded from a real v1 database shape, and no user-visible
  template loss in the manual fresh-profile check.
- Progress + abort work for every scope: cancel during fetch, queue, and
  compile each leaves the panel re-exportable without reload.
- Preview never blocks or degrades export: export from a cold panel works
  without ever opening the preview; preview failures render diagnostics, not
  a broken panel.
- Job-store budgets enforced pre-flight with actionable errors; no code path
  can store an over-budget bundle.
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
  timeout in the failure message so reports are diagnosable.

**Open questions**

1. Preview page budget N: fixed 5, or user-adjustable? Proposal: fixed 5 for
   v1, revisit with telemetry-free feedback (report timing note).
2. Where does the *active template selection* live for a user who uses both
   CLI and extension on the same site — is per-host selection acceptable for
   v1 (proposal: yes; the folder-007 site-library attachment adapter is the
   later convergence point)?
3. Space-scope permission gaps: page not readable mid-tree — omit with note
   (baseline A1 proposal) or abort? The panel should follow whatever folder
   001 decides; the UI copy depends on it.
4. Presets (named `{templateId, settings}` bundles, B10): panel UI in this
   folder or deferred until folder 007 fixes preset storage scope
   (space-property vs. IndexedDB)? Proposal: defer; `SettingsForm` values per
   template are enough for v1.
5. Manual E2E protocol ownership: release checklist in `CHANGELOG.md` PR, or
   a `spec/`-adjacent living document? Proposal: keep it in this PLAN and
   copy the checklist into each release PR description.

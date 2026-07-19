# 004 — Macro renderer registry & third-party macro support

Status: Plan, 2026-07-19. Part of the `export-expansion` series.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane E, tasks T1.7–T1.10 (owner:
  new package `packages/export-macros`).
- `specs/export-expansion/BASELINE-DESIGN.md` §5 Cluster E — shared architecture
  (`MacroRendererRegistry` port + staged fallback chain), E1 (`export_view`/ADF
  fallback), E2 (Jira macro), E3 (draw.io/Gliffy preview PNG).
- Code seams this plan builds on (verified):
  - `packages/confluence/src/export-blocks.ts:195` — the enriched
    `{ type: "unknown" }` block spec 001 landed: `walkMacro` (`:800`) now
    captures `params`/`body`/`plainBody`/`macroId` losslessly and parks the
    scratch-walk notes of the body in `bodyNotes` (`:864`) instead of
    discarding them — precisely so this lane can promote them (see the
    `bodyNotes` task under T1.7). The walker's own note push
    (`macro-not-rendered`/`unknown-macro`) is at `:836`.
  - `packages/docx/src/serialize.ts:433` and `packages/pdf/src/serialize.ts:802`
    — current placeholder rendering of `unknown` blocks (still `macroName`
    only; 001 deliberately did not render the enrichment fields).
  - `packages/jira/src/client.ts:725` (`getIssue`) and `:855` (`search`, JQL via
    `POST /search/jql`) — the complete Jira API surface the CLI adapter needs.
  - `packages/confluence/src/client.ts:247` (`request` helper), `:512`
    (`body.storage` expand), `:1448` (`listAttachments`), `:1563`
    (`downloadAttachment`) — REST plumbing for the new export-view and
    attachment-lookup methods.
  - `packages/docx/src/env.ts:59` (`ExportEnv`) and
    `packages/pdf/src/run-export.ts:33` (`PdfExportEnv`) — the host-injection
    pattern the resolver pass plugs into; `countPrepared` at
    `packages/pdf/src/run-export.ts:74` is the container-walk shape to reuse.
  - `packages/docx/src/export.ts:112–140` (`ExportInput`, no `macros` slot
    today) and `packages/docx/src/env.ts:90–101` (`runExport` threads only
    `assets`/`rasterizer` from `ExportEnv` into `ExportInput`) — `exportDocx`
    itself never sees `ExportEnv`, so the hook-in needs the same two-hop
    threading `assets`/`rasterizer` already use, not just a field on the env
    type (see Architecture). `packages/pdf/src/run-export.ts:111`
    (`runPdfExport(input, env)`) has no such split — `env` is already in
    scope where `preparePdfDocument` is called, so the PDF side has no
    equivalent gap.
  - `packages/jira/src/client.ts:151–170` (429 exhausts retries → generic
    `Error`), `:194–211` (non-2xx → generic `Error`, no status/code carried)
    and `packages/confluence/src/client.ts:299–350` (same shape) — neither
    client's `request()` accepts an `AbortSignal`
    (`packages/jira/src/client.ts:97–107`,
    `packages/confluence/src/client.ts:247–253`); the resolver's `signal` can
    only be checked cooperatively between port calls, not threaded into a
    single in-flight fetch, until/unless the clients grow signal support
    (out of scope here — flagged in Risks).
  - `packages/docx/src/image.ts:380` — `ImageEmbedder.embed` throws `"SVG
    images are not embedded yet (spec 005 deferral)"` for ordinary
    attachment images; the `SvgRasterizer` seam is wired only to the mermaid
    `diagramSeam` (`packages/docx/src/export.ts:703–718`), not to arbitrary
    SVG attachments. General SVG-attachment embedding for DOCX lands with
    **006-word-quality G4/T1.15** (`specs/export-expansion/006-word-quality/PLAN.md`
    §"G4 SVG embedding"), which this plan now depends on for its own SVG
    preference (see Dependencies).
  - `packages/confluence/package.json:6–13` and
    `packages/confluence/src/index.browser.ts:16–19` — the browser-safe
    barrel re-exports a curated isomorphic surface only, enforced by
    `scripts/check-browser-build.ts` (`BROWSER_ENTRYPOINTS`,
    `check-browser-build.ts:15–25`); a new `html-to-blocks.ts` module is not
    in that list, so `exportViewFallbackRenderer` must not import it at
    runtime (see Architecture — dependency injection instead).
  - `apps/cli/src/commands/export.ts:80` — CLI `--engine` defaults to
    `"python"`, not `"ts"`; the macro chain only exists on the ts-engine
    path (see Host wiring).
  - `apps/cli/src/commands/export-internals.ts:127–130` — `tokenAssetFetcher`
    performs an unrestricted `fetch()` against any `http(s)://` URL and
    buffers the full response with no origin allowlist, redirect check, or
    size cap; today's only source of such URLs is `<ac:image>` external refs
    the page author placed. T1.10 gives the same sink a new source
    (third-party-rendered `export_view` HTML), so it needs an explicit
    safety gate (see Architecture, T1.10 task, Risks).
- Cross-reference: `specs/export-expansion/006-word-quality/PLAN.md` (G4
  SVG-attachment embedding, a dependency of the diagram renderer's SVG
  preference) and `specs/export-expansion/011-quality-gates/PLAN.md`
  (E2E resource naming convention `atlcli-e2e-<feature>-<timestamp>` /
  `makeE2eTitle()`, and the "macros" browser-harness conformance case
  T4.6 that gates the M1 milestone alongside this plan's own DoD).
- External sources (kept from BASELINE-DESIGN §5):
  [v1 macro body API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---macro-body/) ·
  [macro export release announcement](https://community.developer.atlassian.com/t/forge-macro-export-release/58566)

## Goal & user value

"As a docs owner I export pages that embed a live Jira table, a draw.io
diagram, and assorted third-party macros — and the export looks like the page."
Today every macro without a native conversion collapses into a gray placeholder
(DOCX) or is dropped with a warning (PDF). This is the largest content-fidelity
gap and an adoption blocker for teams migrating off server-side exporters.

This spec delivers the pipeline that closes it:

1. A **`MacroRendererRegistry` port** and an **async resolver pass** between
   `storageToBlocks` and the two engines, in a new isomorphic package
   `packages/export-macros`.
2. A **staged fallback chain** per macro: native conversion → specific renderer
   → server-side `export_view`/ADF rendering via REST → visible placeholder +
   report note. "Never silently drop" stays an invariant; every stage that
   fires is visible in the export report.
3. **Concrete renderers**: Jira (single issue + JQL table rendered as a real
   styled table through our theme pipeline — a differentiator), draw.io/Gliffy
   (preview-PNG attachment mapped to an existing `image` block), and the
   generic `export_view` fallback that covers the long tail of third-party
   macros whose apps declare an ADF export function (Confluence serves their
   output through the `export_view` body representation — no cross-app
   invocation needed).
4. **Confluence-native dynamic macros** (E4/E5 — `UMSETZUNGSPLAN.md:19`
   assigns this whole folder "E1–E5", and BASELINE-DESIGN §5 designs all
   five): Multiexcerpt-include and `scroll-tablelayout` (single-sourcing and
   legacy-migration content, E4), plus TOC, `children`, `include`/`excerpt`,
   and the Page Properties Report (E5) — the macros that appear in nearly
   every real Confluence doc space and that Scroll Word/PDF Exporter has
   supported for years. Without these, "E1–E5" in the umbrella plan would be
   false advertising; with them, this plan closes essentially the entire
   macro-fidelity gap in one lane instead of leaving native Confluence
   dynamism unplanned.

## Dependencies (001)

- **001 — ExportBlock model extension (T0.1/T0.2)** must be merged first
  (implemented 2026-07-19 on `claude/exportblock-model-subagents-82d71f`;
  the shape below is the **as-built** one, verified against
  `packages/confluence/src/export-blocks.ts:195`, not a sketch). This
  spec consumes the enriched `unknown` block it introduces:

  ```ts
  | { type: "unknown"; macroName: string;
      params?: MacroParameter[];         // every <ac:parameter>, ordered, losslessly typed
      body?: ExportBlock[];              // ac:rich-text-body, walked recursively
      plainBody?: string;                // ac:plain-text-body
      macroId?: string;                  // ac:macro-id (for REST macro rendering)
      bodyNotes?: ExportNote[] }         // notes from 001's scratch walk of `body`,
                                         // parked on the block for THIS lane to
                                         // promote (see T1.7 bodyNotes task)
  ```

  **Post-hardening correction:** 001's own hardening round replaced the
  earlier `params?: Record<string, string>` sketch (still the shape
  BASELINE-DESIGN.md §5 shows) with `MacroParameter[] = { name: string; text?:
  string; refs?: MacroParamRef[] }[]`, because `elementText()` reads
  `ri:page`/`ri:attachment`/`ri:url`/`ri:user`/`ri:space` parameters — the
  unnamed page-ref parameter of `include`/`excerpt-include` among them — as
  empty strings, silently dropping them under the flat shape (see
  `001-exportblock-model/PLAN.md`, "Why not `Record<string, string>`" and
  Risks). This plan's `MacroInstance.params` (Architecture, below) follows
  suit. Every `params.<name>` read in the E2–E5 tasks below has been rewritten
  to `macroParamText(m.params, "<name>")` (the case-insensitive, text-only
  convenience export 001 also adds) **except** the `include`/`excerpt-include`
  page reference (E5 task), which reads `m.params`' unnamed parameter's
  `refs` directly, since that parameter carries a `ri:page` ref, not text.
  001's landing also recorded **two further obligations it explicitly
  deferred to this lane (T1.7)** — both now have owning tasks below:
  (a) promoting `unknown.bodyNotes` into the export report once body content
  becomes visible (001 Risks, "Scratch-ctx decision" — see the `bodyNotes`
  task under "Registry & resolver pass"); (b) extending
  `resolve-mentions.ts` to traverse `unknown.body`
  (`packages/confluence/src/resolve-mentions.ts:113–116` carries the pointer
  comment; 001's negative regression test pins the current non-traversal —
  see the mention-resolution task under "Placeholder floor keeps content").
  Without `params`/`macroId` no renderer can act; without the compiling no-op
  renderings (T0.2) the engines are not green. This is the only ordered landing
  in the hot file `export-blocks.ts` that Lane E waits for (T1.1 → T1.4 → T1.8
  per UMSETZUNGSPLAN); everything else in this spec lives in new files owned by
  this lane. (The `T1.8` label in that citation names Lane E's own Jira-renderer
  task, which per this plan's own task list never touches `export-blocks.ts` —
  flagged as a likely UMSETZUNGSPLAN.md numbering slip under crossPlanImpacts;
  treat the intended gate as "after T1.4 lands", not literally T1.8.)
- **006-word-quality G4/T1.15** (SVG-attachment embedding for DOCX): the
  diagram renderer's SVG preference (T1.9) needs the general `SvgRasterizer
  → embed` path for arbitrary attachment SVGs that G4 delivers; today that
  seam only serves mermaid (`packages/docx/src/export.ts:703–718`,
  `packages/docx/src/image.ts:380`). Until G4 lands, T1.9's SVG preference is
  PDF-only; DOCX stays on the PNG preview (see T1.9 task).
- **Not fully disjoint, but additive-only**: this plan's own tasks add
  optional fields/methods to six files other lanes also touch —
  `packages/docx/src/env.ts` and `packages/docx/src/export.ts` (also touched
  by 002-scope-orchestration, 003-content-features, 006-word-quality,
  009-package-publishing), `packages/pdf/src/run-export.ts`/
  `packages/pdf/src/types.ts` (also touched by 002, 007-pdf-template-settings,
  008-pdf-cli, 009), `packages/confluence/src/client.ts` (new REST methods
  only, no lane currently listed against it), and
  `apps/cli/src/commands/export-internals.ts` (`tokenAssetFetcher` gains the
  `ExternalAssetFetcher` contract from T1.10 — see Architecture "External
  asset fetching"). None of Lane E's edits to these files change existing
  signatures — every addition is a new optional field or a new method — so
  the conflict surface is textual (same hunks), not semantic; land Lane E's
  hook-ins as their own small commits per file (rather than bundled with the
  `packages/export-macros` work) so they rebase cleanly against whichever
  lane merges first. UMSETZUNGSPLAN.md's "two hot files" framing
  (`UMSETZUNGSPLAN.md:31–39`) undercounts this — flagged under
  crossPlanImpacts. Everything else in this spec (the resolver, registry, and
  all renderers) lives in the new `packages/export-macros` package with no
  other lane owning any file in it.
- **Cross-plan sync point with 002-scope-orchestration (tree/space export
  correctness)**: `MacroExportContext.page` is a single `{id, spaceKey}` for
  the whole resolve pass, but 002 fetches and `storageToBlocks`-walks every
  `ExportPageNode` **separately** before `composeChapters` merges them into
  one flat block tree (`002-scope-orchestration/PLAN.md:37–48,68,81–92`); by
  the time this plan's engine-hook-in resolver runs (after composition, at
  `exportDocx`/`runPdfExport`), a single global `ctx.page` can no longer tell
  which source page a given `unknown` block came from. 002 already solves the
  identical problem for images by adding `pageId?: string` to the
  `ImageSource` attachment variant, set from a per-page "walk-context" field
  that `fetchExportTree` supplies to `storageToBlocks`
  (`002-scope-orchestration/PLAN.md:72`). This plan needs the same treatment
  for the `unknown` block: an optional `sourcePage?: { id: string; version?:
  number; spaceKey?: string }` field, populated by the identical walk-context
  mechanism 002 is already building (ideally in the same commit that adds
  `ImageSource.pageId`, since both are one-line additions to the same walker
  function and the same `StorageToBlocksOptions` field). `resolveMacroBlocks`
  then builds each macro instance's effective page context from
  `block.sourcePage ?? ctx.page` — falling back to the shared `ctx.page` for
  single-page exports (where 002's walk-context field is never set) so
  today's single-page behavior is unchanged. This is a **request to
  002-scope-orchestration**, not a file this plan owns — see
  crossPlanImpacts. Without it, tree/space exports would resolve child-page
  macros (attachment lookups, `export_view`, Confluence-native include
  renderers) against the wrong page.

## Architecture (isomorphic)

The resolver and all renderers are **pure functions over ports** — no direct
HTTP, no client imports, no host APIs. One renderer implementation serves every
host: the CLI adapts `JiraClient`/`ConfluenceClient` (token auth), the browser
extension adapts session `fetch`, and any future host supplies the same ports
over its own HTTP adapter.

New package `packages/export-macros` has **zero runtime imports** from any
host-facing package (`@atlcli/jira`, `@atlcli/confluence`'s client/HTML
modules) — only type-level imports of `ExportBlock`/`ExportNote` from
`@atlcli/confluence`, enforced the same way the repo already enforces browser
safety for other isomorphic packages: `packages/export-macros/src/index.ts`
joins `BROWSER_ENTRYPOINTS` in `scripts/check-browser-build.ts:15` (see Host
wiring task), so a stray runtime import fails CI the same way a stray
`node:`/`bun:` specifier does today — no new lint infra needed.

```ts
// packages/export-macros/src/types.ts
// `MacroParameter`/`macroParamText` are type-level imports from
// `@atlcli/confluence` (see Dependencies' post-hardening correction) — this
// package still takes no runtime import from it.
export interface MacroInstance { name: string; params: MacroParameter[];
  body?: ExportBlock[]; plainBody?: string; macroId?: string }

/** Stable per-instance key for report correlation (see Report/UX below).
 *  Internal to the resolver — never round-tripped through `ExportNote`,
 *  which has no `macroId`/`instanceId` field (see Report/UX). */
export type MacroInstanceId = string; // macroId when present, else a block-path fallback

export type MacroRenderResult =
  | { kind: "blocks"; blocks: ExportBlock[]; notes?: ExportNote[] }
  | { kind: "skip"; notes?: ExportNote[] };  // → next stage of the chain; notes always
                                              // surface even when nothing renders (e.g.
                                              // Jira 403 → skip + "no permission" note)

/** Tagged reason a port call failed, so the resolver can decide fall-through
 *  vs. abort without parsing error message strings. Ports SHOULD reject with
 *  a {@link PortError}; the resolver treats any other thrown error as
 *  "invalid-response" (fall through) except `AbortError`/`ctx.signal.aborted`,
 *  which always propagates and stops the whole export. */
export type PortErrorKind = "permission" | "not-found" | "rate-limited" | "network" | "invalid-response";
export interface PortError extends Error {
  readonly kind: PortErrorKind;
  /** Present on `"rate-limited"`; drives the per-port circuit breaker (see
   *  "Budget & concurrency" below). Parsed from a `Retry-After` header when
   *  the underlying client surfaces one, else a conservative default. */
  readonly retryAfterMs?: number;
  /** Which port raised this, for circuit-breaker bookkeeping and note text
   *  (e.g. `"jira"`, `"confluence"`, `"exportView"`). */
  readonly service?: string;
}

export interface MacroRenderer {
  readonly macros: readonly string[];    // ac:name values, lowercase; "*" = catch-all
  /** Stable identity for registry introspection, override resolution, and
   *  DoD's "supported macros" listing — NOT the same as `macros` (one
   *  renderer's id is fixed even if its macro-name coverage changes). */
  readonly id: string;
  /** `false` for renderers that only read `m.params`/`m.body` (TOC,
   *  scroll-tablelayout, the `excerpt`/`expand`-style transparent-body
   *  renderers) — the determinism switch (`--no-live-macros`) still runs
   *  these. `true` for anything that touches `ctx.confluence`/`ctx.jira`/
   *  `ctx.exportView`/`ctx.attachments`. Required, not defaulted: a renderer
   *  that reads a port but forgets to declare `true` would silently run
   *  under "no live macros", which is worse than a compile error. */
  readonly requiresLivePort: boolean;
  render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult>;
}

/** Metadata `AttachmentLookupPort.lookup` returns instead of a bare boolean —
 *  needed by the diagram renderer's staleness note (T1.9) and by any future
 *  consumer that needs more than existence. */
export interface AttachmentMeta {
  filename: string;
  version: number;
  /** ISO timestamp of the attachment's last version, when the host's
   *  listing exposes one (Confluence's `version.when`, currently dropped by
   *  `ConfluenceClient.parseAttachmentResponse`, `client.ts:1783` — CLI host
   *  wiring adds it there; see T1.9). Absent hosts skip the staleness note. */
  modified?: string;
}

export interface MacroExportContext {
  /** The macro's *source* page — for tree/space exports this must be the
   *  page the macro instance actually came from, not the export root (see
   *  Dependencies — cross-plan sync point with 002). `resolveMacroBlocks`
   *  computes this per instance as `block.sourcePage ?? ctx.page` once 002
   *  lands `unknown.sourcePage`; until then (and for single-page exports)
   *  `ctx.page` is the only source and is correct by construction. */
  page: { id: string; version?: number; spaceKey?: string };
  confluence?: ConfluenceContentPort;    // getPageStorage(title, space), getChildren(id), searchCql(cql)
  jira?: JiraIssuePort;                  // getIssue(key), searchJql(jql, opts)
  exportView?: ExportViewPort;           // renderMacroHtml(pageId, macroId)
  attachments?: AttachmentLookupPort;    // lookup(pageId, filename) — diagram preview probing + staleness
  /** Host-optional fetch contract for non-attachment external bytes
   *  (`export_view`-sourced `<img>` URLs, T1.10). Absent → CLI/extension
   *  default same-origin-only fetcher (see "External asset fetching"). */
  externalAssets?: ExternalAssetFetcher;
  depth: number; visited: Set<string>;   // recursion guards (shared with later include renderers)
  /** Checked cooperatively between port calls, not threaded into a single
   *  in-flight fetch for `JiraIssuePort` — `jira/src/client.ts:97–107`
   *  accepts no `AbortSignal` and this plan does not add one (out of
   *  scope). For `ConfluenceContentPort`/`ExportViewPort`/
   *  `AttachmentLookupPort`, once 002-scope-orchestration lands real
   *  `AbortSignal` support on `ConfluenceClient.request`/`requestV2`
   *  (`002-scope-orchestration/PLAN.md:59`), the CLI adapters for those
   *  three ports MUST pass `ctx.signal` into the underlying client call so a
   *  deadline can interrupt an in-flight fetch or retry sleep, not just stop
   *  the *next* macro instance. `resolveMacroBlocks` itself always checks
   *  `signal.aborted` before starting each macro instance's render and
   *  rethrows immediately, regardless of per-port signal support. */
  signal?: AbortSignal;
  /** Per-export live-resolution budget (see "Budget & concurrency" below). */
  budget?: MacroResolutionBudget;
}

export interface MacroResolutionBudget {
  /** Max concurrent in-flight port calls across the whole resolve pass. Default 4. */
  concurrency?: number;
  /** Wall-clock deadline for the whole resolve pass; exceeding it degrades
   *  all remaining macro instances to `skipped-by-config` rather than
   *  failing the export. */
  deadlineMs?: number;
}

/** An immutable, validated ordering of renderers — the "port" the Goal
 *  section promises, not a bare array (see registry.ts task). */
export interface MacroRendererRegistry {
  readonly renderers: readonly MacroRenderer[];
  /** Returns a new registry with `overrides` placed before the built-ins,
   *  keeping first-match-wins semantics; still validated (see
   *  `createRegistry`). Lets hosts/customers add or shadow renderers without
   *  forking `defaultRegistry`. */
  compose(...overrides: MacroRenderer[]): MacroRendererRegistry;
}

/** Validates and freezes a renderer list into a `MacroRendererRegistry`:
 *  throws (at registry-construction time, not export time) if two
 *  non-catch-all renderers claim the same lowercase macro name without one
 *  being an explicit override, or if more than one renderer declares the
 *  `"*"` catch-all. */
export function createRegistry(renderers: readonly MacroRenderer[]): MacroRendererRegistry;

/** Options threaded through `ExportInput`/`PdfExportEnv` (see Engine
 *  hook-in). Both engines' `macros?` field is exactly this type. */
export interface MacroResolutionOptions {
  registry: MacroRendererRegistry;
  /** Builds the per-page `MacroExportContext` from `{id, version,
   *  spaceKey}` — a function rather than a static object because tree/space
   *  exports need a fresh context per source page (ports, budget, and
   *  policies are shared/reused across calls; only `page`/`visited`/`depth`
   *  vary). Single-page hosts can return a constant context. */
  contextFor(page: { id: string; version?: number; spaceKey?: string }): MacroExportContext;
  /** `false` (default `true`) disables stages 2–3 for `requiresLivePort:
   *  true` renderers only — see "Determinism switch" and Host wiring. Pure
   *  renderers (TOC, scroll-tablelayout, transparent-body passthroughs)
   *  keep running regardless. */
  live?: boolean;
}

export async function resolveMacroBlocks(
  /** The full walker result, not bare blocks — the resolver needs `notes`
   *  to remove the walker's pre-existing `unknown-macro`/`macro-not-rendered`
   *  entry for every instance it replaces (see Report/UX; outcome ownership
   *  is otherwise impossible to implement against this signature). */
  input: { blocks: ExportBlock[]; notes: ExportNote[] },
  registry: MacroRendererRegistry,
  ctx: MacroExportContext
): Promise<{ blocks: ExportBlock[]; notes: ExportNote[] }>
```

**Fallback chain** (decided per macro instance, top to bottom):

1. Native conversion in the walker (callouts, code, expand, status, …) —
   unchanged; those macros never reach the resolver.
2. Macro-specific renderer from the registry → real `ExportBlock[]`, full
   template/theme fidelity.
3. `export_view` REST fallback: Confluence renders the macro server-side to
   HTML; a small HTML-subset → `ExportBlock[]` converter takes over. This stage
   also transparently carries ADF-exported output of current-generation
   third-party apps — it is not a separate channel.
4. Visible placeholder + report note (today's behavior), now enriched to
   render the preserved `body`/`plainBody` beneath the placeholder line
   instead of discarding them (see registry task) — the guaranteed floor,
   never empty when the source macro carried content.

A `PortError` with `kind: "permission" | "not-found" | "rate-limited" |
"network" | "invalid-response"` always falls through to the next stage with a
note; `AbortError`/an aborted `ctx.signal` always stops the whole resolve pass
immediately (never falls through, never degrades to a note).

**Engine hook-in.** PDF and DOCX differ here because of an existing structural
asymmetry: `runPdfExport(input, env)` (`packages/pdf/src/run-export.ts:111`)
is one function with `env` already in scope where `preparePdfDocument` is
called, so an optional `macros?` field on `PdfExportEnv`
(`packages/pdf/src/run-export.ts:33`), read directly at that call site
(`packages/pdf/src/run-export.ts:125`), is sufficient. DOCX splits a pure
`exportDocx(input: ExportInput)` (`packages/docx/src/export.ts:112`) from an
impure `runExport(input, env)` wrapper (`packages/docx/src/env.ts:90`) that
today threads only `assets`/`rasterizer` from `ExportEnv` into `ExportInput`
— `exportDocx` never receives `ExportEnv` at all. So DOCX needs the field in
**two** places, mirroring the existing `assets`/`rasterizer` pattern exactly:
an optional `macros?: MacroResolutionOptions` on `ExportInput`
(`packages/docx/src/export.ts`, applied inside `exportDocx` directly after
`storageToBlocks`, line 235) **and** the same optional field on `ExportEnv`
(`packages/docx/src/env.ts:59`), threaded through by `runExport` the same way
`rest.assets ?? env.assets` is today (`packages/docx/src/env.ts:97`). Hosts
that call `exportDocx` directly (a documented part of the host contract,
`packages/docx/src/env.ts:84–88`) can still pass `macros` explicitly on
`ExportInput`. Hosts that don't set either field get today's behavior
byte-for-byte — the pass is additive on both engines.

**Single-page vs. composed (tree/space) input.** "Directly after
`storageToBlocks`" is exact for a single-page export (today's only caller of
`exportDocx`/`runPdfExport`). Once 002-scope-orchestration's `composeChapters`
lands, both engines instead receive one already-merged block tree spanning
every exported page (`002-scope-orchestration/PLAN.md:43,81`) — the resolver
still runs at the same call site (once, on the composed tree, not once per
page — that keeps the semaphore/dedup/deadline budget correctly export-wide
rather than fragmented per page), but `MacroResolutionOptions.contextFor` is
what makes this correct: for every `unknown` block, the resolver calls
`contextFor(block.sourcePage ?? ctx.page)` (see Dependencies — cross-plan
sync point with 002) so a macro that came from page B is resolved against
page B's id/version/space, never the export root's. Single-page exports never
set `sourcePage`, so `contextFor` always receives the same `ctx.page` and
behavior is unchanged.

**`htmlToExportBlocks` is injected, not imported.** `packages/export-macros`
must stay free of runtime imports from `@atlcli/confluence` (see package
header above), but `htmlToExportBlocks` (T1.10) lives in `packages/confluence`
next to the storage walker it shares a tokenizer with. `exportViewFallbackRenderer`
therefore takes it as a constructor dependency — the same DI shape E4's
`multiexcerptIncludeRenderer(deps: { storageToBlocks })` already uses for
`storageToBlocks`:

```ts
export function exportViewFallbackRenderer(deps: {
  htmlToExportBlocks: (html: string) => { blocks: ExportBlock[]; notes: ExportNote[] };
}): MacroRenderer { /* … */ }
```

`defaultRegistry(opts)` accepts `opts.htmlToExportBlocks` and wires it through;
CLI/extension host-wiring code imports `htmlToExportBlocks` from
`@atlcli/confluence` and passes it in. This keeps the `packages/export-macros`
package boundary honest — the DI shape is the point, not where
`html-to-blocks.ts` itself is exported from.

**`html-to-blocks.ts` must be on the browser barrel.** The package's `browser`
condition (`packages/confluence/package.json:6–13`) resolves the bare
specifier `@atlcli/confluence` to `index.browser.ts` in any browser-targeted
build — including the extension's host-wiring code that is supposed to
import `htmlToExportBlocks` to build `defaultRegistry(opts)`. Keeping
`html-to-blocks.ts` off `index.browser.ts`'s curated surface (as an earlier
draft of this plan specified) would make that import fail to resolve in the
extension, not just be "impure" — a real build break, not a style choice.
Since `html-to-blocks.ts` is built on the same XML tokenizer `export-blocks.ts`
already uses and that module is already on the browser barrel, it is
provably isomorphic the same way; add
`export * from "./html-to-blocks.js";` to `packages/confluence/src/index.browser.ts`
alongside the existing re-exports and let `scripts/check-browser-build.ts`
verify it builds for `--target=browser` with no `node:`/`bun:` specifiers,
same as every other entry on that barrel.

**Live-resolution budget & concurrency.** Beyond T1.10's page-level
`export_view` batching, `resolveMacroBlocks` runs macro instances through a
small internal semaphore (`ctx.budget?.concurrency ?? 4`) and de-duplicates
identical port calls within one export. The dedup key is a **canonical
structured tuple**, not a partial string: `{ port, method, siteId,
...normalizedArgs }` — e.g. `{ port: "jira", method: "searchJql", siteId,
jql, columns: sortedColumns, maximumIssues }` for `searchJql`, `{ port:
"jira", method: "getIssue", siteId, key }` for `getIssue`. Two Jira macros
with identical JQL but different `columns` or `maximumIssues` are **not** the
same cache entry (they would otherwise share an incompatible result — wrong
columns or a truncated row set silently reused). `siteId` distinguishes
multi-profile/multi-site exports from colliding on the same textual key
against different Confluence/Jira instances. Concurrent resolution never
reorders output: each macro instance's replacement blocks/notes are spliced
back into the tree at that instance's original pre-order position once its
render settles, regardless of which instance's port call returns first — a
slow macro can never push a faster one out of document order.

A `deadlineMs` budget degrades any macro instance still unresolved when the
deadline passes to `skipped-by-config` rather than letting one slow
third-party app hang the whole export. **Per-port circuit breaker**: when a
port call rejects with `PortError.kind === "rate-limited"`, the resolver
records that `service` as "open" (with `retryAfterMs`, default 30s if the
port didn't supply one) for the remainder of the resolve pass; every
subsequent macro instance that would call the same service short-circuits
straight to `{ kind: "skip" }` with a `skipped-by-config`-class note
("service rate-limited, skipping remaining macro calls") instead of issuing
another request — a page with fifty Jira macros never turns one 429 into
fifty. The breaker is per export (fresh `MacroExportContext`), never
persisted across exports.

Fine-grained per-macro progress reporting is deliberately **not** part of
this plan (would require a new callback shape on both `ExportEnv` and
`PdfExportEnv`, whose only progress primitive today is PDF's coarse
`onPhase`); left as an open question for T5.4.

**External asset fetching — a fetch contract, not a boolean gate.**
`htmlToExportBlocks` turns `<img src>` into `ImageSource { kind: "external",
url }`, which flows through the same host asset fetcher that already handles
`<ac:image>` external refs — but those refs come from the page author,
whereas `export_view` HTML is rendered by whichever third-party app owns the
macro, so the URL is no longer a first-party-trusted input. The CLI's asset
fetcher does an unrestricted `fetch()` today
(`apps/cli/src/commands/export-internals.ts:127–130`, `tokenAssetFetcher`)
that follows redirects transparently and buffers the full response before any
size check — no origin allowlist, no per-hop redirect check, no streaming
cap. A pre-fetch predicate checked once against the *initial* URL cannot
enforce either of those: it never sees the redirect target(s) `fetch()`
follows internally, and it has no hook into the byte stream to cap it. So
`ExternalAssetPolicy.allow(url): boolean` (an earlier draft of this plan) is
downgraded to the origin-check *building block*, and T1.10 adds the actual
enforcement point:

```ts
// packages/export-macros/src/types.ts
export interface ExternalAssetPolicy { allow(url: string): boolean }

/** The real sink-side contract — replaces a naive fetch() call with one that
 *  can actually enforce a policy across redirects and cap memory. Hosts
 *  implement this once; `exportViewFallbackRenderer`'s images and (once
 *  006-word-quality's SVG path exists) any other `export-view`-sourced
 *  asset consumer share it. */
export interface ExternalAssetFetcher {
  fetch(url: string, opts: { maxBytes: number; signal?: AbortSignal }):
    Promise<{ bytes: Uint8Array; mediaType?: string }>;
}
```

`ctx.externalAssets` (see `MacroExportContext`) carries the host's
`ExternalAssetFetcher`; the CLI's default implementation wraps native `fetch`
with `redirect: "manual"`, re-checks `policy.allow(location)` against every
redirect hop before following it (rejecting on the first disallowed hop),
and reads the response body through a length-capped stream (reject as soon
as `maxBytes` is exceeded, not "check after full buffer" like today's
`tokenAssetFetcher`). Default `policy.allow` permits only the exporting
profile's own Confluence origin and rejects loopback/private/link-local
targets (RFC 1918, `169.254.0.0/16`, `::1`, etc.); hosts may widen it. Without
`ctx.externalAssets`, T1.10 falls back to same-origin-only, still through the
capped/redirect-checked path (safe default, not a network regression for the
common case).

**Trust marker.** `ImageSource`'s external variant, `AssetRef`
(`packages/docx/src/env.ts:26–38`), and `PdfAssetRef`
(`packages/pdf/src/types.ts:14–28`) carry no provenance today — a page-author
`<ac:image>` external ref and an `export_view`-derived `<img>` are
indistinguishable once they reach the asset seam. T1.10 adds an optional
`trust?: "page" | "export-view"` field to all three (additive, same "new
optional field" pattern as the rest of this plan's cross-file touches — see
Dependencies), set to `"export-view"` only by `htmlToExportBlocks`; the
DOCX/PDF asset seams route `trust: "export-view"` refs through
`ctx.externalAssets`/`ExternalAssetPolicy` and leave `trust: "page"`/unset
refs on today's path unchanged (no behavior change for ordinary page images).
See T1.10 task and Risks.

**Report/UX — exactly one terminal outcome per macro instance.** The walker
already emits `unknown-macro`/`macro-not-rendered` for every unresolved macro
during `storageToBlocks` (`packages/confluence/src/export-blocks.ts:836`),
*before* the resolver ever runs. Left alone, a macro the resolver successfully
renders would show up in the report as both "not rendered" and
"rendered via …" — confusing and wrong. `resolveMacroBlocks` therefore takes
outcome ownership for every macro it processes: for each `unknown` block it
replaces (by walking the block tree — see registry task), it removes the
walker's original note for that exact instance and appends exactly one new
note — `rendered-via`, `degraded`, or `skipped-by-config`.

**Matching is positional, not by `macroId`** — `ExportNote`
(`packages/confluence/src/export-blocks.ts:212`) has no `macroId` field
today, and spec 001 deliberately added none ("Report-identical",
`001-exportblock-model/PLAN.md:94`); `walkMacro` writes only `macroName`
(`export-blocks.ts:836`), which is not unique across instances. The only
reliable correlation is emission order: `walkMacro` pushes exactly one
`unknown-macro`/`macro-not-rendered` note per `unknown` block, in the same
pre-order sequence the blocks themselves appear in. `resolveMacroBlocks`
therefore takes `input.notes` (see `resolveMacroBlocks` signature above — this
is why the resolver needs the full `StorageToBlocksResult`, not bare blocks),
filters it to those two codes, and pairs the *n*-th such note with the *n*-th
`unknown` block found in a pre-order walk of `input.blocks`, computed once up
front before resolution starts. `macroId`, when present, is still used to
build the internal `MacroInstanceId` (for `visited`/dedup bookkeeping and
future report correlation) — just not to locate the note to remove, since the
note itself never carries it. Two macro instances with the same `macroName`
where only one resolves must produce two distinct, correctly-attributed
notes, never a duplicate or a dangling "not rendered" for the one that
succeeded, even with unrelated non-macro notes interleaved between them in
`input.notes` (positional pairing is over the filtered subsequence, not raw
array index — see resolve.test.ts task).

Three note classes instead of two — `rendered-via` (info, stages 2–3),
`degraded` (warning, stage 4), `skipped-by-config`. Chain fully active by
default; one progressive-disclosure switch "Resolve dynamic macros live
(contacts Jira/Confluence)" for compliance users who want a deterministic
export with **no additional Jira/`export_view`/attachment-lookup calls** —
precise wording, since the page body and its own (page-authored) attachments
still go over the network regardless (see Host wiring; a true offline mode is
not this plan's scope), and **since the switch only suppresses
`requiresLivePort: true` renderers** — pure renderers (TOC,
scroll-tablelayout, the transparent-body `excerpt`/`expand`-style
passthroughs) keep running under `--no-live-macros` because they never touch
a port (see `MacroRenderer.requiresLivePort` and Host wiring). A renderer
that reads `m.body`/`m.params` only is not "live" just because its *sibling*
macros in the registry are.

## Tasks

### Registry & resolver pass (T1.7)

- [ ] Scaffold `packages/export-macros/` (package.json `@atlcli/export-macros`,
      tsconfig, `src/index.ts` barrel) mirroring the existing workspace-package
      layout; type-only dependency on `@atlcli/confluence` for `ExportBlock`/
      `ExportNote` only — no runtime import from any `@atlcli/*` package.
      Add `packages/export-macros/src/index.ts` to `BROWSER_ENTRYPOINTS` in
      `scripts/check-browser-build.ts:15` so a stray runtime import (e.g. of
      `@atlcli/jira` or `html-to-blocks.ts`) fails CI the same way a
      `node:`/`bun:` specifier does today, instead of relying on an
      unenforced "type-only" comment.
- [ ] `packages/export-macros/src/types.ts` — `MacroInstance`,
      `MacroRenderResult` (`{ kind: "blocks"; blocks; notes? }` |
      `{ kind: "skip"; notes? }` — `skip` carries notes too, so a permission
      or rate-limit skip is never silent), `PortErrorKind`/`PortError`
      (with `retryAfterMs?`/`service?`), `MacroRenderer` (with the required
      `id`/`requiresLivePort` fields), `MacroExportContext` (with
      `page.version?`, `externalAssets?`), `MacroResolutionBudget`,
      `AttachmentMeta`, `MacroRendererRegistry`/`createRegistry`,
      `MacroResolutionOptions`, `ExternalAssetPolicy`/`ExternalAssetFetcher`,
      and the port interfaces `ConfluenceContentPort`, `JiraIssuePort`,
      `ExportViewPort`, `AttachmentLookupPort` (`lookup(pageId, filename):
      Promise<AttachmentMeta | undefined>` — ports only, no client imports).
      Document that port implementations SHOULD reject with a tagged
      `PortError`; the resolver treats untagged errors as
      `"invalid-response"` (falls through) and `AbortError`/`signal.aborted`
      as always-propagating.
- [ ] `packages/export-macros/src/resolve.ts` — `resolveMacroBlocks(input:
      StorageToBlocksResult, registry, ctx)`: walk the block tree including
      nested containers (`table` cells, `callout`, `list` items,
      `blockquote` — same walk structure as `countPrepared`,
      `packages/pdf/src/run-export.ts:74`), replace `unknown` blocks via the
      chain, collect notes, honor `signal` (checked before each macro
      instance, not mid-request — see Architecture). First matching renderer
      wins; `{ kind: "skip" }` falls through to the next registrant, then to
      the catch-all, then to the placeholder floor (the original `unknown`
      block is kept, but see the placeholder-floor task below for rendering
      its preserved `body`/`plainBody`). A concurrency-limited pool
      (`ctx.budget?.concurrency ?? 4`) processes independent macro instances,
      keyed for dedup by the canonical `{port, method, siteId, ...args}`
      tuple (Architecture — not a partial string); results are spliced back
      at each instance's original pre-order position regardless of
      completion order. A `ctx.budget?.deadlineMs` past-due instance degrades
      to `skipped-by-config` instead of blocking the export. **Circuit
      breaker**: a `kind: "rate-limited"` `PortError` opens that `service`
      for the rest of the pass; later instances needing the same service
      short-circuit to skip + note without calling it again (Architecture).
      **Outcome ownership**: pair the *n*-th `unknown-macro`/
      `macro-not-rendered` note in `input.notes` with the *n*-th `unknown`
      block in a pre-order walk of `input.blocks`, computed once up front
      (positional — `ExportNote` carries no `macroId`, see Architecture —
      Report/UX); remove that note and append exactly one terminal note —
      never both an old and a new note for the same instance. When
      `registry`/`ctx` policy marks live resolution off, skip straight to
      `skipped-by-config` for every `requiresLivePort: true` renderer without
      calling it (pure renderers still run — see Architecture).
- [ ] `packages/export-macros/src/registry.ts` — `createRegistry(renderers)`
      validating exactly one `"*"` catch-all and no duplicate non-catch-all
      macro name across renderers (throws at construction, not export time);
      `MacroRendererRegistry.compose(...overrides)` prepending overrides with
      first-match-wins semantics, still validated. `defaultRegistry(opts)`
      assembles the standard renderer order via `createRegistry`: TOC first
      (pure, no dependencies — see TOC renderer task), then specific
      renderers (Jira, diagram, multiexcerpt-include, scroll-tablelayout,
      children, include/excerpt, page-properties-report — E2–E5),
      `exportViewFallbackRenderer` last; `opts` carries the injected
      `htmlToExportBlocks` and `storageToBlocks` dependencies the E1/E4/E5
      renderers need (see Architecture — DI, not runtime import).
- [ ] Hook-in DOCX (two-hop, mirrors `assets`/`rasterizer`): add optional
      `macros?: MacroResolutionOptions` to **both** `ExportInput`
      (`packages/docx/src/export.ts`, applied inside `exportDocx` right after
      `storageToBlocks`, line 235, via `macros.contextFor({id, version,
      spaceKey})` for the current page) **and** `ExportEnv`
      (`packages/docx/src/env.ts:59`), threaded through by `runExport`
      alongside `assets`/`rasterizer` (`packages/docx/src/env.ts:97`); merge
      returned notes into the export report. Regression test: a direct
      `exportDocx()` call (no `runExport`) with `macros` set on `ExportInput`
      resolves macros identically to a `runExport()` call with `macros` set
      on `ExportEnv` — both entry points must work, per the documented host
      contract (`packages/docx/src/env.ts:84–88`).
- [ ] Hook-in PDF: optional `macros?: MacroResolutionOptions` field directly
      on `PdfExportEnv` in `packages/pdf/src/run-export.ts:33` — no second
      hop needed, `runPdfExport` already has `env` in scope where it's
      applied, during the `preparing` phase before `preparePdfDocument`
      (`packages/pdf/src/run-export.ts:125`); abort/error mapping via the
      existing `wrapFailure(…, "prepare")` path.
- [ ] Note taxonomy: introduce the codes `macro-rendered-via`,
      `macro-degraded`, `macro-skipped-by-config` that **replace** (not
      "alongside", per outcome ownership above) the walker's
      `unknown-macro`/`macro-not-rendered` notes from
      `packages/confluence/src/export-blocks.ts:836` for every macro
      instance the resolver actually touches; macros the resolver never
      reaches (e.g. `env.macros` unset) keep today's walker notes unchanged.
      These three codes populate `ExportNote.source` using the `source`
      field 003-content-features introduces on `ExportNote` (see
      `003-content-features/PLAN.md`, Walker tasks), once that field lands.
- [ ] **`unknown.bodyNotes` promotion (deferred from 001)**: 001's walker
      parks the notes produced while scratch-walking an `unknown` macro's
      rich-text body in `bodyNotes` on the block
      (`packages/confluence/src/export-blocks.ts:207,:864`) instead of the
      top-level report — deliberately, so that report stays byte-identical
      while nothing renders the body, and so *this* resolver can promote
      them once something does. `resolveMacroBlocks` owns them now, exactly
      once per instance: when the instance's terminal outcome makes the
      preserved `body` visible — the stage-4 placeholder floor below, or a
      renderer whose `{ kind: "blocks" }` output derives from `m.body`
      (scroll-tablelayout, excerpt, the transparent passthroughs) — append
      `bodyNotes` to the returned `notes` right after the instance's
      terminal note; when the body is superseded wholesale by port-fetched
      content (Jira table, `export_view` HTML), drop them with the body they
      described (they annotate content that no longer appears — keeping
      them would report problems in invisible content). Never merge them
      twice, never keep a `bodyNotes` note whose content is visible without
      surfacing it. This resolves 001's open revisit note ("`bodyNotes` may
      fold into the resolver's note model"): the field stays on the model;
      the resolver is its only consumer. Test in `resolve.test.ts`: an
      `unknown` block with `bodyNotes` that falls through to the placeholder
      floor surfaces them in the result `notes`; the same block resolved by
      a port-backed renderer does not.

### TOC renderer (E5 — pure, no-IO reference renderer)

BASELINE-DESIGN.md's own recommended cluster order puts this first after the
registry: "the ideal first registry renderer (pure, no port → reference test
case for the DX)" (`BASELINE-DESIGN.md:1018`). It has `requiresLivePort:
false` and needs no fixture beyond the composed block tree, so it is the
cheapest way to prove the registry/resolver contract end-to-end before the
port-backed renderers land.

- [ ] `packages/export-macros/src/toc.ts` — pure `tocFromHeadings(blocks:
      ExportBlock[], opts: { minLevel?: number; maxLevel?: number }):
      ExportBlock[]` producing a `{ type: "list" }` of `link` inline nodes
      targeting `{ kind: "anchor", anchor }` for each heading in range
      (reusing the heading-to-anchor convention `composeChapters` establishes
      — `002-scope-orchestration/PLAN.md:84` — for single-page exports
      without composition, anchors are the heading's own in-page slug).
      `tocRenderer(): MacroRenderer` for macro `["toc"]`: `requiresLivePort:
      false`; params `minLevel`/`maxLevel` (default 1/6) and `outline`
      (ignored — reserved). Never fails; empty heading set → `{ kind: "skip"
      }` (placeholder floor renders nothing rather than an empty list).
- [ ] Native-TOC suppression: DOCX skips emitting the macro's body-TOC list
      with an info note (`macro-skipped-by-config`-class, message
      "native Word TOC field present") when the resolved template already
      contains a TOC field (the scan already detects this —
      `packages/docx/src/placeholder-map.ts`'s TOC/`updateFields` handling);
      PDF renders the body TOC unless the template's outline is disabled.
      Default: never a duplicate table of contents. Implemented as a
      renderer-level option threaded from `MacroResolutionOptions` (host
      wiring passes the template's native-TOC-presence flag), not a
      hardcoded check inside `packages/export-macros` (which has no
      knowledge of templates).
- [ ] Test: `packages/export-macros/src/toc.test.ts` — heading range
      filtering, empty-document skip, nested headings inside a composed
      multi-page document (anchor prefixing matches `composeChapters`'s
      `p<pageId>-<anchor>` scheme once 002 lands; single-page anchors
      unprefixed).

### Jira renderer (T1.8)

- [ ] `packages/export-macros/src/jira.ts` — `jiraMacroRenderer()` for macros
      `["jira", "jiraissues"]`, `requiresLivePort: true`:
      - `macroParamText(m.params, "key")` → single-issue line: bold external link
        `KEY Summary` + existing `status` inline node with mapped color.
        Dedup key: `{ port: "jira", method: "getIssue", siteId, key }`.
      - `macroParamText(m.params, "jqlQuery")` → `searchJql` with `columns`
        (default `key,summary,status`, split on `,`/`;`) and
        `maximumIssues` (default 20, hard cap 100) → `issueTable(cols, rows)`
        emitting a real `{ type: "table" }` `ExportBlock` with a header row, so
        DOCX table styles and the PDF table-contrast policy apply unchanged.
        Dedup key: `{ port: "jira", method: "searchJql", siteId, jql,
        columns: [...columns].sort(), maximumIssues }` — **not** just `jql`
        (Architecture): two macros with the same JQL but different
        `columns`/`maximumIssues` must not share a cached result, since the
        cached row set would have the wrong shape/length for one of them.
      - No `ctx.jira` → `{ kind: "skip" }` (falls through to `export_view`,
        then placeholder).
      - The issue's browse URL (`i.url` above) is not `JiraIssue.self`
        (that's the REST API URL) — the CLI port adapter builds it as
        `${profile.baseUrl}/browse/${key}` (no existing client helper
        returns a browse URL today).
      - Map Jira `statusCategory.colorName` → the Confluence status color
        names the engines already render.
      - Port errors use the `PortError` taxonomy (Architecture): 403 →
        `kind: "permission"` → `{ kind: "skip", notes: [{ level: "warning",
        code: "macro-degraded", message: "Issue table skipped: no Jira
        permission" }] }`; 404 (deleted/renamed issue or bad JQL) →
        `kind: "not-found"` → same shape with a "not found" message; 429
        after the client's own retries are exhausted → `kind: "rate-limited"`
        → skip + note (never retried again inside the renderer — the client
        already retried). None of these throw past the renderer; only
        `AbortError` does.
      - `serverId` (multi-site links): ignore in v1, emit info note.
- [ ] CLI port adapter (see Host wiring): built on `JiraClient.getIssue`
      (`packages/jira/src/client.ts:725`) and `JiraClient.search`
      (`packages/jira/src/client.ts:855`, `POST /search/jql`) — no new client
      features needed for the happy path; the adapter catches the client's
      generic `Error(`Jira API error (${status}): …`)`
      (`packages/jira/src/client.ts:151–211`) and classifies it into a
      `PortError` by parsing the leading status code (403/404/429 → the
      matching `kind`, everything else → `"network"`) since the client
      doesn't carry a structured status field to switch on directly.

### Diagram renderers (T1.9)

- [ ] `packages/export-macros/src/diagram.ts` — `diagramMacroRenderer()` for
      `["drawio", "inc-drawio", "drawio-sketch", "gliffy"]`,
      `requiresLivePort: true`: resolve the diagram name
      (`macroParamText(m.params, "diagramName") ?? macroParamText(m.params, "name")`;
      no name → `{ kind: "skip" }`).
      **The renderer must confirm the preview exists before committing to a
      block, not after**: once `resolveMacroBlocks` accepts a `{ kind:
      "blocks" }` result, the block tree replacement is final — a later
      image-fetch failure inside the DOCX/PDF engines' own asset resolution
      (`packages/docx/src/serialize.ts:410–428`,
      `packages/pdf/src/prepare.ts:218–244`) degrades that one image to a
      blank/skipped-image note, it does **not** re-enter the macro fallback
      chain (the resolver has already moved on). So:
      - With `ctx.attachments` (required for this renderer — see below):
        call `lookup(pageId, `${name}.png`)`; a defined `AttachmentMeta` →
        emit the `image` block (`source: { kind: "attachment", filename:
        `${name}.png` }`) plus an info note; `undefined` → `{ kind: "skip" }`
        (falls through to `export_view`, which independently yields its own
        `<img>` URL from the server-rendered macro HTML, then the
        placeholder floor).
      - Without `ctx.attachments`: `{ kind: "skip" }` unconditionally — do
        **not** blindly emit a PNG block on the hope it exists, since a
        wrong guess would strand the export in the "engine already
        committed to this block" failure mode above instead of falling
        through cleanly.
      - IO-free beyond the lookup — actual byte fetching still goes through
        the engines' existing asset seams (`AssetFetcher` /
        `PdfAssetResolver`). Dedup key:
        `{ port: "confluence", method: "attachmentLookup", siteId, pageId,
        filename }`.
- [ ] Prefer SVG when available: if `ctx.attachments.lookup(pageId,
      `${name}.svg`)` resolves, emit the SVG attachment instead of the PNG. **PDF
      only for v1** — PDF renders SVG natively. DOCX has no seam today that
      rasterizes an arbitrary attachment SVG: the general image embedder
      rejects SVG outright (`packages/docx/src/image.ts:380`, `"SVG images
      are not embedded yet"`), and the `SvgRasterizer` seam
      (`packages/docx/src/env.ts:54`) is wired only to the mermaid
      code-diagram path (`packages/docx/src/export.ts:703–718`), not to
      attachment files. DOCX stays on the PNG preview until
      **006-word-quality G4/T1.15** lands the general SVG-attachment path
      (see Dependencies); this renderer's DOCX branch takes an explicit
      `TODO(T1.15)` and a regression test that asserts DOCX still gets PNG
      even when an SVG preview exists.
- [ ] Staleness note: `AttachmentMeta.modified` is only populated once CLI
      host wiring's `attachmentLookupFromClient` adapter captures
      `version.when` from the raw Confluence response — today's
      `ConfluenceClient.parseAttachmentResponse` (`client.ts:1783`) reads
      `version.number` but drops `version.when` entirely, so this is a
      one-line addition to `AttachmentInfo`/`parseAttachmentResponse`, not
      just a renderer concern. When `modified` is present, compare it
      against `ctx.page.version`'s own timestamp (host wiring supplies both
      from the same page-details fetch) and add "preview may be outdated" as
      an info note (preview PNGs are only generated on save). Hosts that
      can't supply `modified` simply never populate it — no staleness note,
      no error.
- [ ] **Spike (blocking for E2E, not for merge): verify the attachment naming
      convention on Cloud** — create a draw.io diagram in space `DOCSY`
      (profile `mayflower`), list attachments via
      `ConfluenceClient.listAttachments` (`packages/confluence/src/client.ts:1448`),
      and record the actual filenames for `drawio`, `drawio-sketch`, and (if
      licensed) `gliffy`, including the `.png`/`.svg` pairing. Document the
      finding in this spec directory and adjust the renderer's name derivation
      if the convention differs.

### Confluence-native include renderers — multiexcerpt & scroll-tablelayout (E4)

Single-sourcing (Appfire Multiexcerpt) and legacy-migration content
(`scroll-tablelayout`) are exactly the content that shows up in every real
migrating-from-Scroll-Exporter space (`BASELINE-DESIGN.md:966–1018`); without
these two renderers this plan leaves the "E1–E5" folder description
(`UMSETZUNGSPLAN.md:19`, this plan's own §4 above) unimplemented for a large
share of real-world pages, even though the registry task already lists their
names in `defaultRegistry`'s order. `ConfluenceContentPort` is defined once
here and reused by every E4/E5 renderer below.

- [ ] `packages/export-macros/src/types.ts` addition —
      `ConfluenceContentPort`: `getPageStorage(title: string, spaceKey?:
      string): Promise<{ id: string; version: number; storage: string } |
      undefined>` (undefined → page not found, distinct from a `PortError`),
      `getChildren(pageId: string, opts?: { limit?: number }):
      Promise<{ id: string; title: string }[]>`, `searchCql(cql: string,
      opts?: { limit?: number }): Promise<{ id: string; title: string }[]>`.
      All three reject with a tagged `PortError` on transport/permission
      failure per the shared taxonomy (Architecture); a 403 on
      `getPageStorage` → `kind: "permission"`, mirroring the Jira renderer's
      pattern, never an uncaught throw.
- [ ] `packages/export-macros/src/multiexcerpt.ts` —
      `multiexcerptIncludeRenderer(deps: { storageToBlocks: typeof
      storageToBlocks })` for `["multiexcerpt-include-macro",
      "multiexcerpt-include"]`, `requiresLivePort: true`: resolve
      `pageTitle = macroParamText(m.params, "PageWithExcerpt") ?? macroParamText(m.params, "page")`
      and `name = macroParamText(m.params, "MultiExcerptName") ?? macroParamText(m.params, "name")`
      (Appfire renamed the
      parameter between Server and Cloud generations — accept both, per
      `BASELINE-DESIGN.md:1003`); missing `ctx.confluence`/`pageTitle`/`name`
      → `{ kind: "skip" }`. Recursion guard: `key = `${pageTitle}#${name}``;
      `ctx.visited.has(key) || ctx.depth > 5` → `{ kind: "skip" }` with an
      info note (guard is shared with the E5 include renderers below via the
      same `ctx.visited`/`ctx.depth`, so a multiexcerpt that itself includes
      another multiexcerpt or an `include` macro is still bounded). Otherwise
      `ctx.visited.add(key)`, fetch via `getPageStorage`, extract the named
      `multiexcerpt-macro`/`multiexcerpt` body with a new
      `extractMacroBody(storage, macroNames, name)` helper (reuses the XML
      tokenizer `export-blocks.ts` already exports — never regex-parse
      markup, `parseXml`, `export-blocks.ts:280`), then `deps.storageToBlocks(fragment,
      { walkContext: { depth: ctx.depth + 1 } })` and return `{ kind:
      "blocks", blocks, notes }`. No fragment found → `{ kind: "skip" }`.
      Definition-side `multiexcerpt-macro`/`multiexcerpt` (the macro on the
      page that *defines* the excerpt, not the include) renders its body
      transparently — same one-line treatment as `expand` in the walker
      (`export-blocks.ts:826`); this half needs a `walkMacro` addition, so
      land it alongside spec 001's other walker changes or as its own
      additive hunk in `export-blocks.ts` (see Dependencies — hot file).
- [ ] `packages/export-macros/src/table-layout.ts` —
      `scrollTableLayoutRenderer()` for `["scroll-tablelayout",
      "scroll-tablelayout-macro"]`, `requiresLivePort: false` (pure —
      transparent body wrapper, no port): no `m.body` → `{ kind: "skip" }`.
      Parse `macroParamText(m.params, "widths")` (comma-separated) and apply to every `table`
      block found at the top level of `m.body` via the existing
      `columnWidths` field (`export-blocks.ts:175`; PDF already honors it,
      G3/`006-word-quality` documents the DOCX gap — this renderer does not
      duplicate that work, it only sets the field). Unparseable/absent
      widths → pass `m.body` through unchanged with an info note ("widths not
      recognized, layout unchanged") rather than a `skip` (the content itself
      is still good — never regress to the placeholder floor over a cosmetic
      parameter). `orientation=landscape` param: v1 emits an info note only
      (`BASELINE-DESIGN.md:1003` — full landscape-section support belongs
      with C6's page-orientation work in 003-content-features, not
      duplicated here).
- [ ] Tests: `packages/export-macros/src/multiexcerpt.test.ts` — happy path
      via in-memory `ConfluenceContentPort`, both `PageWithExcerpt`/`page`
      and `MultiExcerptName`/`name` parameter spellings, missing page →
      skip, cycle (`A` includes `B` includes `A`) → depth/visited guard fires
      with a note and terminates, permission error → skip + note (not
      abort). `packages/export-macros/src/table-layout.test.ts` — width
      parsing, non-table content in body passed through unchanged, missing
      body → skip.

### Confluence-native include renderers — children, include/excerpt, page properties report (E5)

- [ ] `packages/export-macros/src/children.ts` — `childrenRenderer()` for
      `["children"]`, `requiresLivePort: true`: `ctx.confluence.getChildren(
      ctx.page.id, { limit: macroParamText(m.params, "depth") === "all" ? undefined : 50 })` →
      nested `{ type: "list" }` block of `link` inline nodes
      (`target: { kind: "page", contentTitle }`, `export-blocks.ts:47`).
      **Default cap 50 children, hard cap 200** (same "default X, hard cap
      Y" convention as the Jira renderer's `maximumIssues`) with a
      `macro-degraded`-class info note when the cap truncates the list —
      never an unbounded fetch against a space with thousands of pages.
      **Deterministic sort**: results ordered by title (stable, locale-aware
      `localeCompare`) regardless of the port's own return order, so repeated
      exports of an unchanged tree are byte-identical. `macroParamText(m.params,
      "sort")` (`"title" | "created"`, default `"title"`) selects the sort key when the port
      exposes it; unsupported sort → note + fall back to title order (never
      silently ignore a param without saying so).
- [ ] `packages/export-macros/src/include-excerpt.ts` — three renderers
      sharing the same recursion guard as multiexcerpt-include:
      - `includeRenderer()` for `["include"]`, `requiresLivePort: true`:
        identical pattern to `multiexcerptIncludeRenderer` but fetches the
        *entire* target page's storage (no named-fragment extraction).
        **Not a text-parameter read** (post-hardening correction, see
        Dependencies): both `packages/confluence/src/markdown.ts:310-334` and
        Confluence's own page-picker UI emit the `include` macro's target as
        an unnamed parameter (`ac:name=""`) carrying a `ri:page` element
        child (`ri:content-id`, or `ri:content-title`/`ri:space-key` for
        older/hand-authored storage) — never as text `page`/`spaceKey`
        parameters. Resolve it from `m.params.find(p => p.name === "")?.refs`,
        take the first `{ kind: "page" }` ref, and prefer `contentId` (exact
        lookup) over `contentTitle`/`spaceKey` (name lookup, same ambiguity
        rules as 002's link-target resolution) → `getPageStorage` → recursive
        `storageToBlocks`. No unnamed parameter, or an unnamed parameter with
        no `page` ref → `{ kind: "skip" }` + info note (never guess a page
        from unrelated text parameters). This is the Confluence-macro
        `include`, a
        different mechanism from Lane D's `$scroll.includepage.(…)`
        **template placeholder** (`005-placeholders/PLAN.md`) — same
        underlying JTBD (pull in another page's content) but a different
        trigger (a storage-XML macro here vs. a docxtemplater token there),
        different owning files, and no shared code; both independently need
        cycle guards, which is the only thing they have in common. Called
        out explicitly so it is never mistaken for a duplicate of D1.
      - `excerptIncludeRenderer()` for `["excerpt-include"]`,
        `requiresLivePort: true`: same as `includeRenderer` but extracts the
        named `excerpt` macro body via `extractMacroBody` (shared helper
        from the E4 task) instead of the whole page.
      - `excerptRenderer()` for `["excerpt"]`, `requiresLivePort: false`
        (pure — this is the *definition*-side macro on the page itself, no
        fetch needed): `macroParamText(m.params, "hidden") === "true"` → `{ kind: "blocks",
        blocks: [] }` (suppressed, matches Confluence's own display
        behavior); otherwise transparent body passthrough, same one-liner
        pattern as `expand`/multiexcerpt-definition.
      All three share `ctx.visited`/`ctx.depth` with the E4 multiexcerpt
      renderer (same key format: `` `${pageTitle}#${excerptName ?? ""}` ``)
      so an `include` that targets a page containing another `include` (or a
      `multiexcerpt-include`) is bounded by the same guard, not a
      per-renderer one — a cross-renderer cycle (A `include`s B, B
      `multiexcerpt-include`s A) must be caught too.
- [ ] `packages/export-macros/src/page-properties-report.ts` —
      `pagePropertiesReportRenderer()` for `["detailssummary"]`,
      `requiresLivePort: true`: `ctx.confluence.searchCql(cqlFromParams(m.params))`
      (label/CQL param → `label = "…"`-shaped CQL, reusing the same
      CQL-building convention `002-scope-orchestration`'s label filter uses
      for consistency) → for each matched page, `getPageStorage` +
      **reuse the existing** `parsePageProperties`
      (`packages/confluence/src/page-properties.ts:120`) to read that page's
      `details` table → aggregate into one `{ type: "table" }` block, columns
      = union of property keys across matched pages (missing key on a given
      page → empty cell, not a dropped row), first column = page-title link.
      **Default cap 50 matched pages, hard cap 200**, same pattern as
      `children`, with a truncation note. **Deterministic sort**: rows
      ordered by page title (`BASELINE-DESIGN.md:1018` — "reproducible
      exports" is an explicit acceptance bar for this renderer specifically).
      `macroParamText(m.params, "firstcolumn")` (custom label for the page-title column):
      respected when present, default "Page". No CQL/no matches → `{ kind:
      "skip" }` (falls through to `export_view`, then placeholder).
      Definition-side `details` macro (the property table on the page being
      aggregated) already renders as a native table via existing walker
      logic — no change needed there.
- [ ] Tests: `packages/export-macros/src/children.test.ts` — cap/truncation
      note, title sort determinism, empty children → empty list (not skip).
      `packages/export-macros/src/include-excerpt.test.ts` — `include` happy
      path, `excerpt-include` named-fragment extraction, `excerpt` hidden
      suppression, cross-renderer cycle (`include` → `multiexcerpt-include` →
      back to the first page) caught by the shared guard.
      `packages/export-macros/src/page-properties-report.test.ts` — column
      union across heterogeneous property sets, missing-key empty cells,
      sort determinism, cap/truncation note, no-CQL skip.
- [ ] E2E extension (same DOCSY/mayflower script as T1.10's — see Tests
      section): the test page also exercises `children` (on a page with at
      least two child pages), one `include`/`excerpt-include` pair, and (if a
      space with an existing Page Properties Report is available, else a
      purpose-built fixture page) `detailssummary`; assert deterministic
      output across two consecutive runs (no flaky ordering).

### export_view fallback (T1.10)

- [ ] `packages/confluence/src/client.ts` — two new REST methods on
      `ConfluenceClient` using the existing `request` helper (`:247`):
      - `getMacroBodyByMacroId(pageId, version, macroId)` (v1 macro body API).
      - `convertToExportView(storageFragment)` (async contentbody convert to
        `export_view`).
      Plus a batch path: fetch `body.export_view` once for the whole page and
      match fragments by `data-macro-id`, so N macros cost 1 request instead
      of N (rate-limit protection). **Logging policy**: these three calls'
      response bodies are full page/macro content (potentially confidential),
      not API metadata — `ConfluenceClient.request`'s generic success-path
      logging (`client.ts:357–364`, `body: redactSensitive(data)`) persists
      full response bodies to global/project JSONL logs
      (`packages/core/src/logger.node.ts`), and `redactSensitive`
      (`packages/core/src/redact.ts`) only strips values under
      token/password/secret/credential-shaped **keys** — arbitrary page text
      passes through untouched. Add a `logBody: false | "meta-only"` request
      option (default unchanged for existing callers) that these three new
      methods pass; `"meta-only"` logs `{ byteLength, contentType,
      requestId }` instead of the body, in both the success and error log
      paths (an error path that embeds the raw response text in the thrown
      message would defeat this — verify `request()`'s error branch doesn't).
      Regression test: export a page containing a unique sentinel string via
      one of these methods with logging enabled at `debug` level; assert the
      sentinel never appears in the resulting log file.
- [ ] `packages/confluence/src/html-to-blocks.ts` — `htmlToExportBlocks(html,
      limits?: HtmlConversionLimits)`: HTML-subset → `ExportBlock[]`
      converter (`p`, `h1–h6`, `table`, `img`, `ul`/`ol`, `pre`, `br`, inline
      `a`/`strong`/`em`/`code`). Reuse the existing XML tokenizer that
      `export-blocks.ts` uses (HTML namespace instead of `ac:`); never
      regex-parse markup. `<img src>` becomes `ImageSource { kind:
      "external", url, trust: "export-view" }` so bytes flow through the
      existing asset seams under the stricter policy (see Architecture —
      "External asset fetching"). `<a href>`: only `http(s):`/`mailto:`
      schemes become a `link` inline node (same allowlist PDF's
      `resolveLink` already enforces, `packages/pdf/src/serialize.ts:227`,
      closing the gap where DOCX's `hyperlinkField`
      (`packages/docx/src/serialize.ts:158–165`) would otherwise turn *any*
      non-empty `href` — including `javascript:`/`file:` — into a live
      hyperlink field; the check lives here, at the point this renderer's
      output is constructed, not in `docx/src/serialize.ts`, which stays
      general-purpose and out of this plan's file ownership) — other schemes
      keep the link text but drop the target, with an info note. `<script>`,
      `<style>`, `<template>`, `<iframe>`, `<object>`, `<embed>`, and form
      elements (`<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`)
      are dropped **with their content**, not unwrapped — these are the only
      tags where "keep children" would surface active content or executable
      script text. Every *other* unknown tag: unwrap and keep children (lossy
      but visible beats dropped). `HtmlConversionLimits` (input byte length,
      node count, nesting depth, attributes-per-node, text-per-node,
      total output blocks — each with a conservative default) caps the
      conversion of this specific input: unlike a page's own `ac:`-storage
      XML (authored by the same tenant and already bounded by Confluence's
      own storage limits), `export_view` HTML is rendered by whichever
      third-party app owns the macro and is not a first-party-trusted input
      (Architecture — "External asset fetching" makes the same trust
      distinction for images); exceeding any limit truncates deterministically
      and returns a `macro-degraded` note instead of building an unbounded
      tree. Exported from `packages/confluence`'s regular Node barrel **and**
      added to `index.browser.ts` (see Architecture — the browser package
      condition resolves there); `packages/export-macros` never imports it
      directly (see Architecture — DI); only host-wiring code (CLI,
      extension) imports it to build the `defaultRegistry(opts)` dependency.
- [ ] `packages/export-macros/src/export-view.ts` —
      `exportViewFallbackRenderer(deps: { htmlToExportBlocks })` for macros
      `["*"]`, `requiresLivePort: true`, registered last: skip without
      `ctx.exportView` or `m.macroId`; otherwise `renderMacroHtml(pageId,
      macroId)` → `deps.htmlToExportBlocks` → non-empty result becomes
      `{ kind: "blocks" }` with an info note (`macro-rendered-via`: "…
      rendered via Confluence export_view"), empty result → `{ kind: "skip" }`
      (placeholder floor).
- [ ] External asset fetching (Architecture — "External asset fetching" /
      "Trust marker"): `packages/export-macros/src/types.ts` —
      `ExternalAssetPolicy`/`ExternalAssetFetcher`, an optional
      `externalAssets` field on `MacroExportContext`. Add the additive
      `trust?: "page" | "export-view"` field to `ImageSource`'s external
      variant (`packages/confluence/src/export-blocks.ts:93`), `AssetRef`
      (`packages/docx/src/env.ts:26–38`), and `PdfAssetRef`
      (`packages/pdf/src/types.ts:14–28`); thread it from
      `htmlToExportBlocks` through to both asset seams. CLI host wiring's
      default `ExternalAssetFetcher` implementation (in
      `apps/cli/src/commands/export-internals.ts`, alongside
      `tokenAssetFetcher`) constructs its `ExternalAssetPolicy` default from
      `profile.baseUrl` (same-origin-only), fetches with `redirect: "manual"`
      and re-checks the policy against every `Location` header before
      following it, and reads the body through a length-capped stream.
      Tests: relative URLs (always allowed, same-origin by construction),
      disallowed scheme (`file:`, `javascript:`), a private/loopback target,
      a redirect chain ending at a disallowed origin (must reject on the
      redirect hop, not just the initial URL), and an oversized response
      (streaming byte cap fires before the full body is buffered, not "check
      after full buffer" like today's `tokenAssetFetcher`).
- [ ] Determinism switch: when the host disables live macro resolution
      (`MacroResolutionOptions.live === false`), the resolver skips stages
      2–3 **only for `requiresLivePort: true` renderers** and emits
      `skipped-by-config` notes for those; renderers with `requiresLivePort:
      false` (TOC, scroll-tablelayout, the `excerpt`/`expand`-style
      transparent passthroughs) keep running — see Architecture and Host
      wiring's engine/flag matrix.

### Placeholder floor keeps content (stage 4 hardening)

Spec 001 deliberately keeps stage-4 rendering byte-identical to today
(`specs/export-expansion/001-exportblock-model/PLAN.md`, "Report-identical") —
`unknown.body`/`plainBody` are preserved in the model but nobody renders them
yet. This plan is what actually uses them, since "never silently drop" is
this spec's invariant, not 001's.

- [ ] **Mention resolution for `unknown.body` (deferred from 001)**:
      `packages/confluence/src/resolve-mentions.ts` deliberately does not
      traverse `unknown.body` today (pointer comment at
      `resolve-mentions.ts:113–116`; pinned by 001's negative test in
      `resolve-mentions.test.ts`), because nothing rendered that body and
      traversing it would have made the extension's PDF path — which calls
      `resolveExportMentions` unconditionally
      (`apps/extension/utils/pdf/run-export.ts:165`) — issue live
      `getUsersBulk` lookups for invisible content. The moment this section
      makes the body visible, that reasoning inverts: the **same PR** that
      lands the placeholder-floor body rendering must add a
      `case "unknown":` recursing into `block.body` to both
      `collectUnresolvedMentionIds` and `resolveBlockMentions`, flip 001's
      negative test into a positive regression test, and remove the pointer
      comment — otherwise a mention inside a rendered macro body ships as a
      raw technical `accountId` in visible output (exactly the silent-drop
      class 001's plan documents).
- [ ] `packages/docx/src/serialize.ts` (`case "unknown"`, line 433): when
      `block.body` is present, render the existing placeholder line followed
      by the body's blocks serialized through the normal `serializeChildren`
      path (recursive, so a table/list/nested-unknown-macro inside an
      unresolved third-party macro still shows up); when only `plainBody` is
      present, render it as a `codeBlock`-styled paragraph. Cap recursion
      depth and total rendered length (reuse the resolver's depth guard
      shape) so a pathological macro body can't blow up a single page.
- [ ] `packages/pdf/src/serialize.ts` (`case "unknown"`, line 802): same
      treatment — today it emits nothing but a report note; render the
      preserved body/plain-body content instead of silently omitting it.
- [ ] Tests: unresolved unknown macro with a table in `body`, with a list,
      with a nested unknown macro inside `body`, and with a very large
      `plainBody` (assert the cap fires with a note, not an unbounded
      document).

### Host wiring

- [ ] CLI adapters in `apps/cli/src/commands/export-internals.ts` (same
      pattern as `tokenAssetFetcher`, line 119): `jiraIssuePortFromClient(JiraClient)`,
      `exportViewPortFromClient(ConfluenceClient)`,
      `attachmentLookupFromClient(ConfluenceClient)` (backed by the cached
      per-page attachment listing that already exists for image resolution,
      extended with `version.when` for the staleness note — see Diagram
      renderers task), `confluenceContentPortFromClient(ConfluenceClient)`
      (backs the E4/E5 renderers: `getPageStorage`/`getChildren`/`searchCql`
      via `client.getPage`/`client.search`), and the default
      `ExternalAssetFetcher` (see export_view fallback task).
- [ ] Wire the registry into the ts-engine paths in
      `apps/cli/src/commands/export.ts` (`exportWithTsEngine`, line ~729, and
      the PDF path): build `defaultRegistry`, populate `MacroResolutionOptions.contextFor`
      from the active profile, set `env.macros`. Jira port only when the
      profile has Jira access configured; otherwise the chain degrades
      gracefully.
- [ ] **Engine/flag matrix for `--no-live-macros`** (deterministic exports
      for CI): the macro chain only exists on the ts-engine path
      (`exportWithTsEngine`); `--engine` defaults to `"python"`
      (`apps/cli/src/commands/export.ts:80`). So: `--no-live-macros` with
      `--engine python` (explicit or default) **fails fast** with a usage
      error ("`--no-live-macros` requires `--engine ts`") rather than
      silently no-op'ing on a path that never resolves macros in the first
      place. When set: `MacroResolutionOptions.live = false`, which per the
      Determinism switch task suppresses only `requiresLivePort: true`
      renderers, omitting the Jira/export_view/attachment-lookup ports from
      the built context — never described as "network-free" (see Definition
      of Done fix below; the page body and its own attachments still fetch
      over the network). All macro-related E2E tests in this plan run with
      `--engine ts` explicitly, never relying on a future default flip
      (T3.5 tracks the default-flip decision separately). When the Python
      engine path encounters a page containing macros this registry would
      have handled live (detected via `KNOWN_MACROS`/unknown-macro notes,
      same signal the walker already emits), emit a one-line CLI hint
      ("this page has dynamic macros; re-run with `--engine ts` for live
      rendering") rather than silently exporting placeholders with no
      explanation of why.
- [ ] Extension wiring notes only (implementation is T5.4, post-M1): the
      extension supplies the same ports over its session `fetch` against the
      current site (`…/rest/api/3` for Jira on connected sites,
      `/wiki/rest/api` for export_view). Record the port contracts it needs in
      `packages/export-macros/src/index.ts` doc comments so T5.4 needs no
      package changes.
- [ ] Further hosts: nothing host-specific leaks into
      `packages/export-macros` — CI check: the package imports neither
      `@atlcli/jira` nor `ConfluenceClient` (types excepted).
- [ ] **CLI `--json` report note fidelity** (synergy, not new scope): today
      `apps/cli/src/commands/export.ts`'s `--json` report flattens every
      `ExportNote` to a plain string (`${n.level}: ${n.message}`,
      `export.ts:884`), discarding `code`/`macroName` — a CI script cannot
      tell `macro-rendered-via` from `macro-degraded` from the JSON output
      today. `005-placeholders/PLAN.md` already plans to stop discarding
      `ExportNote.code` in this same code path for its own E2E assertions
      (`005-placeholders/PLAN.md:39`); this plan takes a dependency on that
      landing rather than re-doing it, and only needs to verify its own three
      note codes (`macro-rendered-via`, `macro-degraded`,
      `macro-skipped-by-config`) survive structured once 005 lands — add that
      assertion to this plan's E2E script rather than to 005's.
- [ ] Docs (`docs/`): feature guide "Exporting pages with dynamic macros" —
      fallback chain explained, supported macros table, `--no-live-macros`,
      troubleshooting (403 from Jira, stale diagram previews, placeholder
      meaning). Same PR as the feature (workflow rule).

### Tests (no mocking)

Hard rule: **never mock HTTP**. Unit tests exercise pure logic through
in-memory port implementations (real implementations of our own interfaces —
not API mocks); anything talking to Confluence/Jira is an E2E test against the
real instance.

- [ ] `packages/export-macros/src/resolve.test.ts` — registry/fallback-chain
      as pure logic with in-memory renderers, called with a
      `StorageToBlocksResult`-shaped `input` (not bare blocks): order (first
      match wins), skip fall-through to catch-all and to placeholder floor,
      nested-container traversal (unknown macro inside a table cell and a
      callout), note collection and classes, abort via `AbortSignal`,
      recursion guards (`depth`/`visited`). **Outcome-ownership/note-matching**:
      two macro instances with the same `macroName` where only one resolves
      produce two distinct, correctly-attributed notes — including a variant
      with an unrelated info/warning note from a different `code` sitting
      between the two macro notes in `input.notes`, proving positional
      pairing is over the filtered subsequence, not raw array index (see
      Architecture — Report/UX). **Concurrency/ordering**: an
      artificially-delayed in-memory renderer for the *first* macro in
      document order and an instant one for the *second* must still produce
      output with the first macro's blocks preceding the second's. **Dedup**:
      two renderers issuing the same in-memory port call with identical
      structured args count as one call; identical `jql` with different
      `columns`/`maximumIssues` count as two. **Circuit breaker**: a
      `"rate-limited"` `PortError` from one macro's port call causes every
      later macro needing the same `service` to skip without a further call.
- [ ] `packages/export-macros/src/registry.test.ts` — `createRegistry`
      invariants: duplicate non-catch-all macro name across two renderers
      throws; more than one `"*"` catch-all throws; `compose(...)` places
      overrides before built-ins and still validates; introspecting
      `registry.renderers.flatMap(r => r.macros)` gives a stable, complete
      "supported macros" list (feeds the docs feature guide's table).
- [ ] `packages/export-macros/src/jira.test.ts` — renderer against an
      in-memory `JiraIssuePort` (fixed issue rows): single-issue block shape,
      table shape (header row, column selection, `maximumIssues` cap), status
      color mapping, missing-port skip, 403 → skip + note.
- [ ] `packages/export-macros/src/diagram.test.ts` — name derivation across
      the four macro variants, PNG vs. SVG preference via in-memory
      `AttachmentLookupPort`, no-name skip.
- [ ] `packages/confluence/src/html-to-blocks.test.ts` — converter against
      **real captured export_view HTML fixtures**, committed under
      `packages/confluence/test-fixtures/export-view/`, plus hand-written
      **adversarial fixtures** for what a real Cloud capture won't exercise:
      deeply nested tags past `HtmlConversionLimits.maxDepth`, a wide sibling
      list past `maxNodes`, an unclosed-tag/malformed-markup input (must not
      hang or throw — degrade with a note, matching the tokenizer's existing
      stray-closer tolerance), and `<script>`/`<iframe>`/`<form>`-bearing
      HTML (content must not survive into the output, not even as unwrapped
      text). Each limit-exceeding fixture asserts truncation + a
      `macro-degraded` note, never an unbounded tree or a thrown error.
      - [ ] One-time capture task: run the CLI against space `DOCSY` (profile
            `mayflower`) to fetch `body.export_view` for pages containing a
            Jira macro, a diagram macro, and at least one third-party macro;
            commit the raw HTML files. Golden tests then run offline and
            detect Cloud markup drift on recapture.
- [ ] E2E (workflow rules; profile `mayflower`, space `DOCSY`, Jira project
      `ATLCLI`; always `--engine ts`):
      - [ ] Script creates a test page containing (a) a Jira macro with a JQL
            over `project = ATLCLI` issues, (b) a draw.io diagram if the app
            is available on the instance (otherwise skip with notice), and
            (c) an unknown third-party macro (any installed app macro without
            a specific renderer).
      - [ ] Export via CLI to **both DOCX and PDF**; assert: rendered issue
            table with the expected issue keys, embedded diagram image (or
            documented skip), and for the unknown macro either
            export_view-rendered content (with `rendered-via` note) or a
            visible placeholder + `degraded` note — never silent omission.
      - [ ] **Cross-page macro identity** (Dependencies — cross-plan sync
            point with 002-scope-orchestration; runs once 002 lands
            `--scope tree`/`ImageSource.pageId`/`unknown.sourcePage`): script
            creates two child pages under a common parent, each containing a
            Jira macro with the *same* `macroId`-irrelevant but
            textually-identical JQL structure resolving to **different**
            issue sets, and each with a same-named draw.io diagram
            attachment containing visibly different content. Export via
            `--scope tree`; assert each chapter's issue table and diagram
            image reflect that chapter's own source page, never the other
            page's or the root's.
      - [ ] Regression guard: export a page with no dynamic macros with and
            without `env.macros` set — identical output (pass is additive).
      - [ ] Cleanup: delete the created test page(s) (and any test
            attachments) after the run; script is re-runnable.
- [ ] `bun run typecheck` green; both engines' exhaustive block switches
      untouched (no new block types in this spec).

## Definition of Done

- `packages/export-macros` exists, builds in the Turbo graph, and exports
  `resolveMacroBlocks`, `defaultRegistry`/`createRegistry`, all port types,
  and **all nine** renderers: Jira, diagram, TOC, multiexcerpt-include,
  scroll-tablelayout, children, include, excerpt-include/excerpt,
  page-properties-report, and the `export_view` catch-all — the full E1–E5
  set this folder is scoped to (`UMSETZUNGSPLAN.md:19`), not a subset.
- Both engines accept the optional `macros` env field; omitting it reproduces
  today's output byte-for-byte (golden tests unchanged).
- Fallback chain verified end-to-end: Jira macro → real styled table in DOCX
  and PDF; diagram macro → embedded image; TOC/children/include/excerpt/
  multiexcerpt/scroll-tablelayout/page-properties-report → real rendered
  content, not placeholders, on a page that uses them; unknown third-party
  macro → export_view content or visible placeholder + note. No macro is
  ever silently dropped.
- `createRegistry` invariants hold: exactly one catch-all, no unresolved
  duplicate macro-name claims, `compose()` lets a custom renderer override a
  built-in.
- Export report distinguishes `rendered-via` / `degraded` /
  `skipped-by-config`, matched to the correct macro instance even when two
  instances share a `macroName` (positional note-matching, Architecture).
  `--no-live-macros` requires `--engine ts` (fails fast otherwise), suppresses
  **only** `requiresLivePort: true` renderers, and is never described as
  "network-free" — the page body and its page-authored attachments still
  fetch over the network; the guarantee is "no additional
  Jira/export_view/attachment-lookup calls".
- Both obligations 001 deferred to this lane are closed: `unknown.bodyNotes`
  are promoted into the report exactly when the body content they describe
  becomes visible (and dropped when it is superseded — `resolve.test.ts`
  covers both directions), and `resolve-mentions.ts` traverses `unknown.body`
  in the same PR that renders it, with 001's negative test flipped to a
  positive one and the pointer comment removed.
- Per-port circuit breaker verified: a rate-limited port stops receiving
  further calls for the rest of the export instead of every remaining macro
  independently exhausting the same limit.
- `export_view`/macro-body REST response bodies never appear verbatim in
  CLI logs (regression test with a sentinel string), and `htmlToExportBlocks`
  enforces `HtmlConversionLimits` plus active-content stripping and a
  `http(s):`/`mailto:` link-scheme allowlist on untrusted third-party HTML.
- Cross-page macro identity holds under `--scope tree`: two child pages with
  textually-identical macro parameters each render their own page's content,
  never the export root's or a sibling's (Dependencies — cross-plan sync
  point with 002-scope-orchestration; this criterion is conditional on that
  sync point landing — see Risks).
- Unit suites run offline (in-memory ports + committed HTML fixtures +
  adversarial fixtures); E2E script against `DOCSY` passes deterministically
  (two consecutive runs produce identical output for
  children/page-properties-report) and cleans up after itself.
- Attachment-naming spike documented; docs feature guide (including the full
  supported-macros table, sourced from registry introspection, not
  hand-maintained) merged in the same PR; typecheck green.

## Risks & open questions

- **export_view markup drift**: the HTML is unversioned; Cloud can change it
  any time. Mitigation: committed golden fixtures + a recapture script; the
  converter unwraps unknown tags instead of failing.
- **Diagram preview naming/staleness**: the `${name}.png` convention must be
  verified on Cloud (spike above); previews are only written on save, so they
  can be stale or missing → staleness note + export_view fallback. Cloud
  variants (`drawio-sketch`, embeds) may use different parameters.
- **Legacy app macros** without an ADF export path return empty export_view
  bodies → stage 4 placeholder is the honest floor.
- **Rate limits** with many macros per page → batch `body.export_view` per
  page and match by `data-macro-id` instead of N calls.
- **Jira permissions/multi-site**: 403 must degrade to a note, never abort;
  `serverId` handling (linked second site) is deferred — v1 ignores it with a
  note.
- **Cross-page macro-context sync point is a hard dependency, not a nice-to-have**:
  until 002-scope-orchestration lands `unknown.sourcePage` (or an equivalent
  per-block page tag — Dependencies), `--scope tree`/`--scope space` exports
  resolve every child-page macro against the export root's `ctx.page`. If 002
  merges after this plan's first cut, land the single-page-correct version
  first (documented as a known limitation for tree/space scope) and follow up
  once 002's walk-context field exists — do not block the whole plan on 002,
  but do not claim the cross-page DoD criterion met until it lands either.
- **Jira retry-sleep is not truly abortable**: even after 002 threads a real
  `AbortSignal` into `ConfluenceClient`'s fetch/retry-sleep, `JiraClient`
  (`packages/jira/src/client.ts:97–107`) still accepts none — a `deadlineMs`
  budget degrades a still-pending Jira macro to `skipped-by-config` once it
  expires, but cannot interrupt an in-flight Jira request or its 429 backoff
  sleep already underway (worst case ~7s at `maxRetries=3`). The circuit
  breaker (Architecture) bounds the *blast radius* of repeated 429s across
  macros; it does not make one in-flight call faster to cancel. Threading a
  signal into `JiraClient` itself is out of this plan's scope.
- **Registry override policy**: `compose()`'s "overrides win, still
  validated" rule assumes exactly one renderer per macro name is the desired
  end state; if a future host genuinely wants two renderers to both see the
  same macro (e.g. an A/B comparison mode), that's explicitly unsupported in
  v1 — open question for T5.4 if the extension ever needs it.
- Open: exact status-color mapping table (Jira `statusCategory.colorName` →
  Confluence status colors) — decide during E2 implementation against real
  ATLCLI issues.
- Open: should the export_view batch call be the default and the per-macro v1
  macro-body API the fallback, or vice versa? Measure both against `DOCSY`
  during T1.10.
- Open: where the `--no-live-macros` default lands for CI recipes (T3.4 owns
  the CI/CD DX story) — coordinate flag naming with Lane K.
- Open: `scroll-tablelayout`'s `widths` unit (px vs. %) and
  `orientation=landscape` semantics are not reliably documented publicly
  (`BASELINE-DESIGN.md:1003`) — calibrate against real Cloud content found
  during the E4 E2E pass; v1 treats `orientation` as an info note only.
- Open: `detailssummary`'s CQL/label parameter shape and the `firstcolumn`
  param's exact semantics need calibration against a real Cloud instance with
  an existing Page Properties Report during E5 implementation.

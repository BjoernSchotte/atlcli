# 004 — Macro renderer registry & third-party macro support

Status: Plan, 2026-07-19. Part of the `export-expansion` series.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane E, tasks T1.7–T1.10 (owner:
  new package `packages/export-macros`).
- `specs/export-expansion/BASELINE-DESIGN.md` §5 Cluster E — shared architecture
  (`MacroRendererRegistry` port + staged fallback chain), E1 (`export_view`/ADF
  fallback), E2 (Jira macro), E3 (draw.io/Gliffy preview PNG).
- Code seams this plan builds on (verified):
  - `packages/confluence/src/export-blocks.ts:113` — today's lossy
    `{ type: "unknown"; macroName }` block; `walkMacro` at `:666` drops params
    and body at `:698–:709`.
  - `packages/docx/src/serialize.ts:431` and `packages/pdf/src/serialize.ts:796`
    — current placeholder rendering of `unknown` blocks.
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

## Dependencies (001)

- **001 — ExportBlock model extension (T0.1/T0.2)** must be merged first. This
  spec consumes the enriched `unknown` block it introduces in
  `packages/confluence/src/export-blocks.ts`:

  ```ts
  | { type: "unknown"; macroName: string;
      params?: Record<string, string>;   // all <ac:parameter>
      body?: ExportBlock[];              // ac:rich-text-body, walked recursively
      plainBody?: string;                // ac:plain-text-body
      macroId?: string }                 // ac:macro-id (for REST macro rendering)
  ```

  Without `params`/`macroId` no renderer can act; without the compiling no-op
  renderings (T0.2) the engines are not green. This is the only ordered landing
  in the hot file `export-blocks.ts` that Lane E waits for (T1.1 → T1.4 → T1.8
  per UMSETZUNGSPLAN); everything else in this spec lives in new files owned by
  this lane.
- No dependency on Lanes A/C/D/G/P — file ownership is disjoint
  (`packages/export-macros` is new; engine hook-in is two small, additive
  seams).

## Architecture (isomorphic)

The resolver and all renderers are **pure functions over ports** — no direct
HTTP, no client imports, no host APIs. One renderer implementation serves every
host: the CLI adapts `JiraClient`/`ConfluenceClient` (token auth), the browser
extension adapts session `fetch`, and any future host supplies the same ports
over its own HTTP adapter.

New package `packages/export-macros` (type-only dependency on
`@atlcli/confluence` for `ExportBlock`/`ExportNote`):

```ts
// packages/export-macros/src/types.ts
export interface MacroInstance { name: string; params: Record<string, string>;
  body?: ExportBlock[]; plainBody?: string; macroId?: string }

export type MacroRenderResult =
  | { kind: "blocks"; blocks: ExportBlock[]; notes?: ExportNote[] }
  | { kind: "skip" };                    // → next stage of the chain

export interface MacroRenderer {
  readonly macros: readonly string[];    // ac:name values, lowercase; "*" = catch-all
  render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult>;
}

export interface MacroExportContext {
  page: { id: string; spaceKey?: string };
  confluence?: ConfluenceContentPort;    // getPageStorage(title, space), getChildren(id), searchCql(cql)
  jira?: JiraIssuePort;                  // getIssue(key), searchJql(jql, opts)
  exportView?: ExportViewPort;           // renderMacroHtml(pageId, macroId)
  attachments?: AttachmentLookupPort;    // exists(pageId, filename) — diagram preview probing
  depth: number; visited: Set<string>;   // recursion guards (shared with later include renderers)
  signal?: AbortSignal;
}

export async function resolveMacroBlocks(blocks: ExportBlock[],
  registry: MacroRenderer[], ctx: MacroExportContext
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
4. Visible placeholder + report note (today's behavior) as the guaranteed
   floor.

**Engine hook-in**: an optional `macros?` field on `ExportEnv`
(`packages/docx/src/env.ts:59`), applied in `exportDocx` directly after
`storageToBlocks` (`packages/docx/src/export.ts:235`); and on `PdfExportEnv`
(`packages/pdf/src/run-export.ts:33`), applied in the `preparing` phase before
`preparePdfDocument` (`packages/pdf/src/run-export.ts:125`). Hosts that don't
set the field get today's behavior byte-for-byte — the pass is additive.

**Report/UX**: three note classes instead of two — `rendered-via` (info, stages
2–3), `degraded` (warning, stage 4), `skipped-by-config`. Chain fully active by
default; one progressive-disclosure switch "Resolve dynamic macros live
(contacts Jira/Confluence)" for compliance users who need deterministic,
network-free exports.

## Tasks

### Registry & resolver pass (T1.7)

- [ ] Scaffold `packages/export-macros/` (package.json `@atlcli/export-macros`,
      tsconfig, `src/index.ts` barrel) mirroring the existing workspace-package
      layout; type-only dependency on `@atlcli/confluence`.
- [ ] `packages/export-macros/src/types.ts` — `MacroInstance`,
      `MacroRenderResult`, `MacroRenderer`, `MacroExportContext`, and the port
      interfaces `ConfluenceContentPort`, `JiraIssuePort`, `ExportViewPort`,
      `AttachmentLookupPort` (ports only — no client imports).
- [ ] `packages/export-macros/src/resolve.ts` — `resolveMacroBlocks`: walk the
      block tree including nested containers (`table` cells, `callout`, `list`
      items, `blockquote` — same walk structure as `countPrepared`,
      `packages/pdf/src/run-export.ts:74`), replace `unknown` blocks via the
      chain, collect notes, honor `signal`. First matching renderer wins;
      `{ kind: "skip" }` falls through to the next registrant, then to the
      catch-all, then to the placeholder floor (the original `unknown` block is
      kept so engines render it exactly as today).
- [ ] `packages/export-macros/src/registry.ts` — `defaultRegistry(opts)`
      assembling the standard renderer order: specific renderers first,
      `exportViewFallbackRenderer` last.
- [ ] Hook-in DOCX: add optional `macros?: { registry: MacroRenderer[]; ctx: … }`
      to `ExportEnv` in `packages/docx/src/env.ts` and apply it in
      `packages/docx/src/export.ts` right after `storageToBlocks` (line 235);
      merge returned notes into the export report.
- [ ] Hook-in PDF: same optional field on `PdfExportEnv` in
      `packages/pdf/src/run-export.ts`, applied during the `preparing` phase
      before `preparePdfDocument`; abort/error mapping via the existing
      `wrapFailure(…, "prepare")` path.
- [ ] Note taxonomy: introduce the codes `macro-rendered-via`,
      `macro-degraded`, `macro-skipped-by-config` alongside the existing
      `unknown-macro`/`macro-not-rendered` notes from
      `packages/confluence/src/export-blocks.ts:698`.

### Jira renderer (T1.8)

- [ ] `packages/export-macros/src/jira.ts` — `jiraMacroRenderer()` for macros
      `["jira", "jiraissues"]`:
      - `params.key` → single-issue line: bold external link
        `KEY Summary` + existing `status` inline node with mapped color.
      - `params.jqlQuery` → `searchJql` with `columns`
        (default `key,summary,status`, split on `,`/`;`) and
        `maximumIssues` (default 20, hard cap 100) → `issueTable(cols, rows)`
        emitting a real `{ type: "table" }` `ExportBlock` with a header row, so
        DOCX table styles and the PDF table-contrast policy apply unchanged.
      - No `ctx.jira` → `{ kind: "skip" }` (falls through to `export_view`,
        then placeholder).
      - Map Jira `statusCategory.colorName` → the Confluence status color
        names the engines already render.
      - Permission errors (403) → `{ kind: "skip" }` + warning note
        "Issue table skipped: no Jira permission" instead of failing the
        export.
      - `serverId` (multi-site links): ignore in v1, emit info note.
- [ ] CLI port adapter (see Host wiring): built on `JiraClient.getIssue`
      (`packages/jira/src/client.ts:725`) and `JiraClient.search`
      (`packages/jira/src/client.ts:855`, `POST /search/jql`) — no new client
      features needed.

### Diagram renderers (T1.9)

- [ ] `packages/export-macros/src/diagram.ts` — `diagramMacroRenderer()` for
      `["drawio", "inc-drawio", "drawio-sketch", "gliffy"]`: resolve the
      diagram name (`params.diagramName ?? params.name`; no name →
      `{ kind: "skip" }`) and emit an existing `image` block with
      `source: { kind: "attachment", filename: `${name}.png` }` (the preview
      PNG the diagram apps write next to the diagram file on save) plus an
      info note. IO-free — the engines fetch bytes through their existing
      asset seams (`AssetFetcher` / `PdfAssetResolver`); a missing attachment
      takes the established error path (note) and the chain falls back to
      `export_view` (which yields an `<img>` URL) and finally the placeholder.
- [ ] Prefer SVG when available: if `ctx.attachments?.exists(pageId,
      `${name}.svg`)`, emit the SVG attachment instead (PDF renders SVG
      natively; DOCX via the `SvgRasterizer` seam,
      `packages/docx/src/env.ts:54`). Without the port, emit the PNG
      unconditionally.
- [ ] Staleness note: when the attachment listing exposes version dates,
      compare attachment date vs. page version and add "preview may be
      outdated" as an info note (preview PNGs are only generated on save).
- [ ] **Spike (blocking for E2E, not for merge): verify the attachment naming
      convention on Cloud** — create a draw.io diagram in space `DOCSY`
      (profile `mayflower`), list attachments via
      `ConfluenceClient.listAttachments` (`packages/confluence/src/client.ts:1448`),
      and record the actual filenames for `drawio`, `drawio-sketch`, and (if
      licensed) `gliffy`, including the `.png`/`.svg` pairing. Document the
      finding in this spec directory and adjust the renderer's name derivation
      if the convention differs.

### export_view fallback (T1.10)

- [ ] `packages/confluence/src/client.ts` — two new REST methods on
      `ConfluenceClient` using the existing `request` helper (`:247`):
      - `getMacroBodyByMacroId(pageId, version, macroId)` (v1 macro body API).
      - `convertToExportView(storageFragment)` (async contentbody convert to
        `export_view`).
      Plus a batch path: fetch `body.export_view` once for the whole page and
      match fragments by `data-macro-id`, so N macros cost 1 request instead
      of N (rate-limit protection).
- [ ] `packages/confluence/src/html-to-blocks.ts` — `htmlToExportBlocks(html)`:
      HTML-subset → `ExportBlock[]` converter (`p`, `h1–h6`, `table`, `img`,
      `ul`/`ol`, `pre`, `br`, inline `a`/`strong`/`em`/`code`). Reuse the
      existing XML tokenizer that `export-blocks.ts` uses (HTML namespace
      instead of `ac:`); never regex-parse markup. `<img src>` becomes
      `ImageSource { kind: "external", url }` so bytes flow through the
      existing asset seams. Unknown tags: unwrap and keep children (lossy but
      visible beats dropped).
- [ ] `packages/export-macros/src/export-view.ts` —
      `exportViewFallbackRenderer()` with `macros: ["*"]`, registered last:
      skip without `ctx.exportView` or `m.macroId`; otherwise
      `renderMacroHtml(pageId, macroId)` → `htmlToExportBlocks` → non-empty
      result becomes `{ kind: "blocks" }` with an info note
      (`macro-rendered-via`: "… rendered via Confluence export_view"), empty
      result → `{ kind: "skip" }` (placeholder floor).
- [ ] Determinism switch: when the host disables live macro resolution, the
      resolver bypasses stages 2–3 entirely and emits `skipped-by-config`
      notes.

### Host wiring

- [ ] CLI adapters in `apps/cli/src/commands/export-internals.ts` (same
      pattern as `tokenAssetFetcher`, line 119): `jiraIssuePortFromClient(JiraClient)`,
      `exportViewPortFromClient(ConfluenceClient)`,
      `attachmentLookupFromClient(ConfluenceClient)` (backed by the cached
      per-page attachment listing that already exists for image resolution).
- [ ] Wire the registry into the ts-engine paths in
      `apps/cli/src/commands/export.ts` (`exportWithTsEngine`, line ~729, and
      the PDF path): build `defaultRegistry`, populate `MacroExportContext`
      from the active profile, set `env.macros`. Jira port only when the
      profile has Jira access configured; otherwise the chain degrades
      gracefully.
- [ ] CLI flag `--no-live-macros` (deterministic exports for CI): omits the
      Jira/export_view ports and sets the `skipped-by-config` mode.
- [ ] Extension wiring notes only (implementation is T5.4, post-M1): the
      extension supplies the same ports over its session `fetch` against the
      current site (`…/rest/api/3` for Jira on connected sites,
      `/wiki/rest/api` for export_view). Record the port contracts it needs in
      `packages/export-macros/src/index.ts` doc comments so T5.4 needs no
      package changes.
- [ ] Further hosts: nothing host-specific leaks into
      `packages/export-macros` — CI check: the package imports neither
      `@atlcli/jira` nor `ConfluenceClient` (types excepted).
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
      as pure logic with in-memory renderers: order (first match wins), skip
      fall-through to catch-all and to placeholder floor, nested-container
      traversal (unknown macro inside a table cell and a callout), note
      collection and classes, abort via `AbortSignal`, recursion guards
      (`depth`/`visited`).
- [ ] `packages/export-macros/src/jira.test.ts` — renderer against an
      in-memory `JiraIssuePort` (fixed issue rows): single-issue block shape,
      table shape (header row, column selection, `maximumIssues` cap), status
      color mapping, missing-port skip, 403 → skip + note.
- [ ] `packages/export-macros/src/diagram.test.ts` — name derivation across
      the four macro variants, PNG vs. SVG preference via in-memory
      `AttachmentLookupPort`, no-name skip.
- [ ] `packages/confluence/src/html-to-blocks.test.ts` — converter against
      **real captured export_view HTML fixtures**, committed under
      `packages/confluence/test-fixtures/export-view/`.
      - [ ] One-time capture task: run the CLI against space `DOCSY` (profile
            `mayflower`) to fetch `body.export_view` for pages containing a
            Jira macro, a diagram macro, and at least one third-party macro;
            commit the raw HTML files. Golden tests then run offline and
            detect Cloud markup drift on recapture.
- [ ] E2E (workflow rules; profile `mayflower`, space `DOCSY`, Jira project
      `ATLCLI`):
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
      - [ ] Regression guard: export a page with no dynamic macros with and
            without `env.macros` set — identical output (pass is additive).
      - [ ] Cleanup: delete the created test page (and any test attachments)
            after the run; script is re-runnable.
- [ ] `bun run typecheck` green; both engines' exhaustive block switches
      untouched (no new block types in this spec).

## Definition of Done

- `packages/export-macros` exists, builds in the Turbo graph, and exports
  `resolveMacroBlocks`, `defaultRegistry`, all port types, and the three
  renderers.
- Both engines accept the optional `macros` env field; omitting it reproduces
  today's output byte-for-byte (golden tests unchanged).
- Fallback chain verified end-to-end: Jira macro → real styled table in DOCX
  and PDF; diagram macro → embedded image; unknown third-party macro →
  export_view content or visible placeholder + note. No macro is ever silently
  dropped.
- Export report distinguishes `rendered-via` / `degraded` /
  `skipped-by-config`; `--no-live-macros` produces a deterministic,
  network-free export.
- Unit suites run offline (in-memory ports + committed HTML fixtures); E2E
  script against `DOCSY` passes and cleans up after itself.
- Attachment-naming spike documented; docs feature guide merged in the same
  PR; typecheck green.

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
- Open: exact status-color mapping table (Jira `statusCategory.colorName` →
  Confluence status colors) — decide during E2 implementation against real
  ATLCLI issues.
- Open: should the export_view batch call be the default and the per-macro v1
  macro-body API the fallback, or vice versa? Measure both against `DOCSY`
  during T1.10.
- Open: where the `--no-live-macros` default lands for CI recipes (T3.4 owns
  the CI/CD DX story) — coordinate flag naming with Lane K.

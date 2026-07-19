# 002 — Scope orchestration: tree, space and label export

Status: Plan, 2026-07-19. Branch: `export-expansion`.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane A:
  - **T1.1** `export-scope.ts`, `tree-fetch.ts` (TreeSource port, ordered walk, cycle/depth protection), `compose-document.ts` (chapters, heading offset, anchor namespacing).
  - **T1.2** Label filter (include/exclude, OR, prune-subtree) via CQL + local filtering.
  - **T1.3** Engine integration: chapter merge through both serializers + golden tests for multi-page documents.
- `specs/export-expansion/BASELINE-DESIGN.md` §1 Cluster A:
  - **A1** page-tree export, **A2** space export, **A3** label include/exclude, **A4** hierarchy→chapter merge (heading normalization across pages), **A5** headless/library export story (CI JTBD, no hosted job API).
- CLI flag delivery (`--scope`, labels) corresponds to **T3.3**; the PDF CLI command itself is folder **008** (PDF CLI, T3.1/T3.2). Host wiring for the extension is folder **010** — this spec only defines the ports it consumes.

## Goal & user value

"Export this handbook" almost never means "this one page" — documentation lives as a page tree. Today the ts engine explicitly rejects `--include-children` (`apps/cli/src/commands/export.ts:759-761`, cliNote "not supported by the ts engine yet"). This spec delivers:

- **One shippable document from a page tree or a whole space** — chapters follow the page hierarchy (page depth = chapter level), with a working table of contents and working cross-page links. Space export covers compliance/offboarding/archive JTBDs.
- **Curated exports via labels** — `internal` pages pruned out, or only `handbook` pages in; the standard migration pattern from established exporter workflows.
- **A headless story (A5)**: the same `fetchExportTree` → `composeChapters` → engine pipeline is the library API; the CLI with `--json` reports and deterministic exit codes is the "API" for CI pipelines. No hosted job polling, no data egress to third parties.

All of it lands once in `@atlcli/confluence` and is consumed identically by CLI, extension, further hosts.

## Dependencies (001)

- **001 (block model, T0.1/T0.2)** must be merged first. This spec consumes from it:
  - `{ type: "pageBreak" }` block variant in `packages/confluence/src/export-blocks.ts` plus its no-op/real renderings in `packages/docx/src/serialize.ts` and `packages/pdf/src/serialize.ts` (DOCX `<w:br w:type="page"/>`, Typst `#pagebreak(weak: true)`).
  - `{ type: "anchor"; name: string }` block variant (used by the anchor rewrite).
  - Exhaustive-switch discipline in both serializers (compile errors mark every render site).
- If 001 has not (yet) added `explicitAnchor?: string` on the `heading` block, this spec adds it — it is a backwards-compatible optional field and is owned by the composition work here (see Tasks).
- `export-blocks.ts` is a hot file (merge order T1.1 → T1.4 → T1.8 per UMSETZUNGSPLAN); Lane A lands first, so our edits there must stay minimal and additive.
- Folder **008** (PDF CLI compile port + `--format pdf` single page) is required only for the *PDF* CLI flags and PDF E2E; DOCX(ts) scope flags do not depend on it.

## Architecture (isomorphic)

One scope-agnostic orchestration layer in `@atlcli/confluence` (fetch + composition on `ExportBlock[]` level). The engines stay single-document serializers — they never see that the document came from multiple pages.

```
ExportScope ──▶ fetchExportTree(TreeSource, scope, {labels, maxPages, signal, onProgress})
                     │  ordered walk, label pruning, cycle/depth guards, concurrency pool
                     ▼
               ExportPageNode[] ──▶ composeChapters(pages, opts)
                                         │  heading shift, pageBreak per chapter,
                                         │  anchor namespacing, link rewrite
                                         ▼
                                   { blocks: ExportBlock[], notes } ──▶ @atlcli/docx runExport
                                                                    └─▶ @atlcli/pdf runPdfExport
```

- **New modules** (all isomorphic, exported from `packages/confluence/src/index.ts` **and** `index.browser.ts`, zero Node-only imports):
  - `packages/confluence/src/export-scope.ts` — serializable `ExportScope` (`page` | `tree` | `space`) and `LabelFilter` types. Serializable on purpose: CLI flags and extension URL/panel state map to the same object.
  - `packages/confluence/src/tree-fetch.ts` — `TreeSource` **port** (not `ConfluenceClient` directly) + `fetchExportTree`. The port exists so further hosts (e.g. an extension session-fetch adapter, folder 010) reuse the logic unchanged — same pattern as `PdfAssetResolver` (`packages/pdf/src/types.ts:26`). The Node adapter maps 1:1 onto the existing client.
  - `packages/confluence/src/compose-document.ts` — `composeChapters` chapter merge, consumed by DOCX **and** PDF paths.
- **Traversal order**: pre-order depth-first (document order), children ordered via `ConfluenceClient.getChildrenWithPosition` (`client.ts:911`, real UI position, cursor-paginated) — not the CQL-based `getChildren` (`client.ts:998`), which has no position guarantee. (UMSETZUNGSPLAN's "BFS" shorthand is superseded by BASELINE-DESIGN's pre-order requirement; pre-order is what yields book order.) Folder nodes come from `getFolderChildren` (`client.ts:2521`): folder = structure without body → chapter heading without content.
- **Space = tree** whose root is the space homepage (`scope.kind: "space"` resolves the homepage id, then delegates to the tree walk, root included). No separate codepath.
- **Safety rails**: `visited: Set<pageId>` cycle guard (note `tree-cycle` + skip), `maxDepth`, `maxPages` (default 500) with a hard, early, actionable error — never a silent hang or a degraded mega-document. Memory: blocks are small, assets are big — the PDF asset budget `PDF_MAX_TOTAL_ASSET_BYTES = 50 MiB` (`packages/pdf/src/prepare.ts:20`, enforced at `prepare.ts:181`) is respected by deduplicating assets by sha256 before the cap check and failing early with the offender list and suggestions (`--max-depth`, `--no-images`).
- **Progress/abort**: child listing is sequential (ordering!), body fetch + `storageToBlocks` run in a concurrency pool (default 4); `signal` is threaded into every fetch (`throwIfAborted` pattern already exists at `packages/pdf/src/run-export.ts:59`). `onProgress` drives the CLI spinner; the PDF engine's `onPhase` (`run-export.ts:30`) stays the phase-level channel and gains per-asset detail. Extension progress UI consumes the same callbacks — port note only, wiring in folder 010.
- **Engines untouched in shape**: the composed document always starts at heading level 1, so the existing promotion offsets (`computeHeadingOffset`, `packages/docx/src/serialize.ts:243`; `min - 1` in `packages/pdf/src/serialize.ts:838` via `writer.headingOffset`, used at `serialize.ts:654`) compute 0 automatically — no engine rebuild, only the shared helper is lifted and small anchor/bookmark additions land.

## Tasks

### Model + fetch

- [ ] Create `packages/confluence/src/export-scope.ts`: `ExportScope` union (`{ kind: "page"; pageId }` | `{ kind: "tree"; rootPageId; includeRoot?; maxDepth? }` | `{ kind: "space"; spaceKey }`) and `LabelFilter` (`include?: string[]` OR-semantics, `exclude?: string[]` OR-semantics, `excludeMode?: "prune-subtree" | "page-only"`, default `prune-subtree`). Pure types + small validators, no IO.
- [ ] Create `packages/confluence/src/tree-fetch.ts` with the `TreeSource` port: `getPage(id)` (id, title, storage, version?, labels?, spaceKey?), `getChildren(id)` (id, title, position), `getSpaceHomepageId(spaceKey)`, optional `searchPages(cql)` for label batch filtering; plus `TreeFetchProgress` and `ExportPageNode` (pageId, title, depth, parentId, `blocks: ExportBlock[]`, `notes: ExportNote[]`, meta: version/labels/position).
- [ ] Implement `fetchExportTree(source, scope, opts)` in `tree-fetch.ts`: pre-order walk, sequential child listing, `visited` set with `ExportNote { code: "tree-cycle" }` on revisit, `maxDepth` cut, `maxPages` default 500 with hard early error, body fetch + `storageToBlocks` (`packages/confluence/src/export-blocks.ts:330`) through a concurrency pool (default 4), `signal` on every request, `onProgress` per fetched page ("page 37/210: ‹title›", total may be `null` while unknown).
- [ ] Space scope: add `getSpaceHomepageId(spaceKey)` to `ConfluenceClient` in `packages/confluence/src/client.ts` — extract the homepage-detection already used by `getSpaceFolders` (`client.ts:2576-2597`, CQL root-page lookup) into a reusable method; `fetchExportTree` case `"space"` resolves it and delegates to the tree walk with the homepage as included root. Error with guidance when a space has no classic homepage (folder-only roots → open question).
- [ ] Node adapter: `confluenceTreeSource(client: ConfluenceClient): TreeSource` (in `tree-fetch.ts`; it only touches the client interface, which is isomorphic) mapping `getPage` → `client.getPageDetails` (`client.ts:539`, brings labels via `metadata.labels`), `getChildren` → `client.getChildrenWithPosition` (`client.ts:911`) merged with `client.getFolderChildren` (`client.ts:2521`), `getSpaceHomepageId` → new client method, `searchPages` → `client.searchPages` (`client.ts:694`).
- [ ] Attachment page context: extend `ImageSource` attachment variant in `packages/confluence/src/export-blocks.ts:91` with optional `pageId?: string`, set it in the image walker (`export-blocks.ts:639-656`) from a new `StorageToBlocksOptions`/walk-context field that `fetchExportTree` supplies per page. Backwards compatible (optional); single-page export leaves it unset. This is the recommended variant from A1(c) — no `filename@pageId` multiplexing hack in hosts.
- [ ] Label filter (T1.2) in `tree-fetch.ts`, applied after the ordering walk (ids known) and **before** body fetch: batch CQL per filter list via `source.searchPages` — `id in (...) and label in (...)` — chunked at 100 ids per query; `exclude` with `prune-subtree` removes node + descendants pre-fetch (cost + privacy: filtered pages are never loaded), `page-only` removes just the node; `include` acts page-only (child of a non-included page may stay — established OR semantics); empty post-include result ⇒ hard error instead of an empty document; excluded root ⇒ hard error with hint. Emit `ExportNote { code: "label-filtered" }` counting omitted pages. Fallback when `searchPages` is absent on the port: labels from `getPage().labels` (local filtering, N requests already paid).
- [ ] Keep the pure decision logic as an exported function `applyLabelFilter(nodes, labelsById, filter)` in `tree-fetch.ts` (functional core, imperative shell — CLAUDE.md pattern), used by `fetchExportTree`.
- [ ] Export all new modules from `packages/confluence/src/index.ts` **and** `packages/confluence/src/index.browser.ts` (browser barrel already re-exports `export-blocks.js` at `index.browser.ts:18`; keep the zero-Node-imports rule stated there).

### Composition

- [ ] Verify/add the two backwards-compatible model extensions in `packages/confluence/src/export-blocks.ts` (coordinate with 001; add here if 001 did not): `explicitAnchor?: string` on the `heading` variant, and the `{ type: "pageBreak" }` variant (with no-op renderings in both engines if 001's T0.2 has not landed them).
- [ ] Lift `computeHeadingOffset`/`minHeadingLevel` from `packages/docx/src/serialize.ts:243-267` into `@atlcli/confluence` (new home: `compose-document.ts`, re-exported via both index barrels); re-import in DOCX (`serialize.ts:330`) and replace the duplicated min-heading scan in `packages/pdf/src/serialize.ts` (offset computation feeding `headingOffset` at `serialize.ts:838`). Today the promotion logic exists twice — after this, once.
- [ ] Create `packages/confluence/src/compose-document.ts`: `composeChapters(pages: ExportPageNode[], opts?: ComposeOptions): { blocks: ExportBlock[]; notes: ExportNote[] }` with `ComposeOptions { chapterBreak?: "none" | "pageBreak" /* default pageBreak */; chapterTitleFromPage?: boolean /* default true */ }`.
- [ ] Chapter merge core: per page emit optional `pageBreak`, then chapter heading at `clamp(depth + 1, 1, 6)` with `explicitAnchor: "page-<pageId>"`, then the page's blocks shifted by `chapterLevel - computeHeadingOffset(page.blocks)` (per-page promotion first, then depth shift — never global promotion, which would let one H4-first page distort all others). Clamp shifted levels at 6 with `ExportNote { code: "heading-depth-clamped" }`.
- [ ] Anchor namespacing + link rewrite in `composeChapters`, over inline `link` nodes (`LinkTarget`, `export-blocks.ts:45-49`): `{kind:"page", contentTitle}` whose title (or id, when resolvable from the chapter set) is in the export → `{kind:"anchor", anchor:"page-<id>"}`; in-page `{kind:"anchor"}` → `"p<pageId>-<anchor>"` (collision-free for same-named headings on different pages); same prefixing for `{ type: "anchor" }` blocks and heading-derived anchors within each page.
- [ ] Links to pages *outside* the export scope become absolute URLs (`baseUrl + /wiki/...`) instead of dead anchors, with `ExportNote { code: "link-outside-scope" }`. `composeChapters` takes the base URL (or a `resolveExternalUrl` callback) via options to stay pure.
- [ ] Determinism: `composeChapters` is a pure function of its inputs (stable note ordering, no Date/random) so golden tests are byte-stable.

### Engine integration

- [ ] DOCX (`packages/docx/src/serialize.ts`): render `explicitAnchor` headings with real bookmarks — `<w:bookmarkStart w:id="…" w:name="page-123456"/>…<w:bookmarkEnd/>` — and turn internal anchor links into real jumps `<w:hyperlink w:anchor="…" w:history="1">` (today internal links are only styled, no navigation; see the link handling around `serialize.ts:166`). Bookmark ids allocated from a serializer counter; bookmark names sanitized to OOXML rules (≤40 chars, no spaces — hash-suffix on overflow).
- [ ] DOCX entry: `runExport` (`packages/docx/src/env.ts:90`, `RunExportInput extends Omit<ExportInput, "templateBytes">` at `env.ts:79`) accepts pre-composed blocks instead of deriving them from a single page's storage; `ExportInput.details` stays the *root* page (placeholders like title/author resolve against the root — consistent with existing template conventions). `serializeBlocks` itself unchanged.
- [ ] PDF: `RunPdfExportInput.blocks` (`packages/pdf/src/run-export.ts:22-23`) is already scope-agnostic — feed it composed blocks. Render `explicitAnchor` as a Typst label `<page-123456>` immediately after the emitted `#heading(...)` (heading emission at `serialize.ts:654`); extend `resolveLink` (`serialize.ts:227`) to resolve namespaced anchors via the label map so `#link(<page-123456>)[…]` cross-references work; the existing template outline (`template.ts`, `outline(depth: 3)`) picks chapters up automatically — no template change.
- [ ] PDF chapter breaks: `pageBreak` blocks flow through `preparePdfDocument` (`packages/pdf/src/prepare.ts`) / `PreparedPdfBlock` (`packages/pdf/src/types.ts`) and serialize as `#pagebreak(weak: true)`; DOCX as `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` (shared with 001's model landing — verify, don't duplicate).
- [ ] Progress: add `onProgress?: (p: { phase: PdfExportPhase; done: number; total: number; detail?: string }) => void` next to `onPhase` on `RunPdfExportInput` (`run-export.ts:30`); `preparePdfDocument` reports per embedded asset. DOCX `runExport` gets the equivalent optional callback on `RunExportInput`. Hosts: CLI spinner here; extension panel progress is a port note only (folder 010).
- [ ] Asset memory guard: sha256-dedupe fetched assets in `preparePdfDocument` before counting against `PDF_MAX_TOTAL_ASSET_BYTES` (`prepare.ts:20`, check at `prepare.ts:181`); on breach fail early listing the largest offenders (page title + filename + size) and suggesting `--max-depth` / `--no-images` / label filters — never emit a truncated document silently.
- [ ] Reports: thread compose/fetch `ExportNote`s (`export-blocks.ts:116`) into both engines' reports (`ExportReport` in `packages/docx/src/export.ts`, PDF report in `packages/pdf/src/types.ts`) so `tree-cycle`, `label-filtered`, `heading-depth-clamped`, `link-outside-scope` reach `--json` output (A5: report schema is API — keep codes stable).

### CLI

- [ ] `apps/cli/src/commands/export.ts`: add `--scope page|tree|space` (default `page`), keep `--include-children` as a deprecated alias for `--scope tree` (it already exists at `export.ts:73`); add `--space <KEY>` (implies `--scope space`), `--max-depth <n>`, `--max-pages <n>`, `--label-include a,b`, `--label-exclude c,d` (comma-separated, OR), `--label-exclude-mode prune-subtree|page-only`. Flags parse into the serializable `ExportScope`/`LabelFilter` — one construction site, shared with other hosts by shape.
- [ ] ts engine path (`exportWithTsEngine`, wiring around `export.ts:108-129` and `export.ts:705-`): replace the cliNote rejection at `export.ts:759-761` with `fetchExportTree(confluenceTreeSource(client), scope, …)` → `composeChapters` → existing `runExport`; wire `onProgress` to the CLI spinner and `AbortSignal` to Ctrl-C. Python engine (`--engine python`, default at `export.ts:81`) keeps its legacy `--include-children` behavior untouched; `--scope`/label flags with `--engine python` fail with "use --engine ts".
- [ ] PDF flags: same `--scope`/label flags for `atlcli wiki export --format pdf`, layered on folder 008's PDF command (T3.2) — the orchestration call site is shared; only the engine invocation differs (`runPdfExport` with composed blocks + multiplexed `PdfAssetResolver` honoring `ImageSource.pageId`). If 008 has not merged, land DOCX(ts) first; the PDF wiring task is a follow-up commit on 008's seam, not a fork.
- [ ] UX: pre-flight page count for `--scope space` (one listing pass) printed as an info line ("212 pages…"); hard early errors for maxPages/asset-cap with actionable suggestions; report lists filtered/omitted pages so missing chapters are never mistaken for bugs.
- [ ] `--json` report (A5): include scope, page count, note codes with counts; document exit codes in the command help (`export.ts:998-1029` help text: replace the `--include-children` line, add scope/label flags with one minimal and one advanced example).
- [ ] Update `docs/` feature guide for tree/space export (per docs standards: intro → prerequisites → steps → options → minimal + advanced example → troubleshooting → related topics), including the CI/headless recipe (A5 positioning: "automation = CLI, no hosted job polling").

### Tests (no mocking)

Rule: **no mocks, ever.** Unit tests exercise pure functions and use an in-memory `TreeSource` implementation — that is a legitimate port implementation (functional core, imperative shell), not an API mock. E2E tests run the real CLI against real Confluence.

- [ ] `packages/confluence/src/tree-fetch.test.ts`: in-memory `TreeSource` (`inMemoryTreeSource(pages: {id, title, parent, position, labels, storage}[])`) implementing the full port incl. `searchPages` CQL-subset evaluation over its own data. Cases: pre-order ordering with positions, `includeRoot` on/off, `maxDepth` cut, `maxPages` hard error, cycle graph → `tree-cycle` note + termination, abort via `AbortSignal` mid-walk, `onProgress` sequence, folder node → empty-body chapter.
- [ ] Label filter unit tests (same file or `applyLabelFilter` block): exclude prune-subtree removes descendants and never fetches their bodies (in-memory source counts `getPage` calls — behavioral proof, no mock), exclude page-only keeps children, include OR-semantics, include+exclude combined, empty include result → error, excluded root → error, id-chunking at >100 nodes exercised against the in-memory `searchPages`.
- [ ] `packages/confluence/src/compose-document.test.ts`: golden/snapshot tests (pattern: `packages/docx/src/golden.test.ts`, snapshots under `packages/confluence/src/__snapshots__/`) for a fixture tree (depth 3, duplicate page titles, same-named in-page headings, links between pages, link to out-of-scope page): chapter levels, per-page promotion then shift, clamp note at depth > 6, `page-<id>`/`p<id>-<anchor>` rewrites, `link-outside-scope` URL fallback, `chapterBreak: "none"` variant, determinism (double run byte-equal).
- [ ] Heading-offset lift regression: existing `packages/docx/src/serialize.test.ts` and `packages/pdf/src/serialize.test.ts` promotion cases keep passing against the shared helper (import moved, behavior identical); add one case proving composed documents yield offset 0 in both engines.
- [ ] Engine golden tests (T1.3): multi-page composed document through DOCX serializer (bookmarks + `w:hyperlink w:anchor` in golden XML) and PDF serializer (Typst source golden with `#pagebreak(weak: true)`, `<page-…>` labels, resolved `#link(<page-…>)`), extending `packages/docx/src/serialize.test.ts` / `packages/pdf/src/serialize.test.ts`.
- [ ] E2E — create test tree in DOCSY (profile `mayflower`, per CLAUDE.md; record ids for cleanup):
  ```bash
  atlcli wiki page create --profile mayflower --space DOCSY --title "E2E 002 Root" --body root.md
  atlcli wiki page create --profile mayflower --space DOCSY --title "E2E 002 Child A" --parent <rootId> --body a.md
  atlcli wiki page create --profile mayflower --space DOCSY --title "E2E 002 Child B" --parent <rootId> --body b.md
  atlcli wiki page create --profile mayflower --space DOCSY --title "E2E 002 Child C" --parent <rootId> --body c.md
  atlcli wiki page create --profile mayflower --space DOCSY --title "E2E 002 Grandchild A1" --parent <childAId> --body a1.md
  atlcli wiki page label add internal --id <childBId>
  atlcli wiki page label add public --id <childAId> && atlcli wiki page label add public --id <childCId>
  ```
  Bodies include headings (one page starting at H3 for promotion), a cross-page link A→C, and an image attachment on the grandchild.
- [ ] E2E — tree export (DOCX/ts):
  ```bash
  atlcli wiki export <rootId> --profile mayflower --engine ts --scope tree \
    --template <tpl> -o /tmp/e2e-002-tree.docx --json
  ```
  Assert: exit 0; exactly **one** document; unzip + grep `word/document.xml` for chapter headings in pre-order (Root → A → A1 → B → C), bookmark `page-<childCId>` and a `w:hyperlink w:anchor="page-<childCId>"` from Child A; JSON report has 0 error notes.
- [ ] E2E — label filtering:
  ```bash
  atlcli wiki export <rootId> --profile mayflower --engine ts --scope tree \
    --label-exclude internal --template <tpl> -o /tmp/e2e-002-filtered.docx --json
  ```
  Assert: Child B absent from `document.xml`, report note `label-filtered` count 1; second run with `--label-include public` contains A and C but not B, root handling per include semantics.
- [ ] E2E — space export smoke: `atlcli wiki export --profile mayflower --engine ts --scope space --space DOCSY --max-pages 500 --template <tpl> -o /tmp/e2e-002-space.docx --json` — asserts homepage as root chapter, page count info line, exit 0. PDF variants of the tree/label runs via folder **008**'s `--format pdf` command once merged (assert single PDF, outline entries per chapter).
- [ ] E2E — cleanup (workflow rule): `atlcli wiki page delete --profile mayflower --id <grandchildId> …` for all five created pages (children before parents), verify with `atlcli wiki page children --id <rootId>` gone / search empty; remove `/tmp/e2e-002-*` artifacts.
- [ ] Run `bun test` + `bun run typecheck` green before commit (workflow rules).

## Definition of Done

- [ ] `fetchExportTree` + `composeChapters` exported from `@atlcli/confluence` via both barrels; extension/host consumption possible with nothing but a `TreeSource` + asset resolver implementation (port note for folder 010 written into that folder's spec, no `apps/extension` code touched here).
- [ ] `atlcli wiki export --engine ts --scope tree|space` with `--label-include/--label-exclude` produces one DOCX with correct chapter hierarchy, working TOC and cross-page jumps; PDF path integrated on 008's seam.
- [ ] The `--include-children` cliNote rejection (`apps/cli/src/commands/export.ts:759-761`) is gone; flag aliases documented.
- [ ] Heading promotion logic exists exactly once (in `@atlcli/confluence`), consumed by both engines; all pre-existing serializer tests green.
- [ ] Notes/report codes (`tree-cycle`, `label-filtered`, `heading-depth-clamped`, `link-outside-scope`) stable and visible in `--json`.
- [ ] Unit + golden + E2E tasks above all checked; E2E resources in DOCSY deleted; `bun test` and `bun run typecheck` green; docs guide updated in the same PR.

## Risks & open questions

- **Hot file `export-blocks.ts`**: three lanes want it (UMSETZUNGSPLAN merge order T1.1 → T1.4 → T1.8). Our additions (`ImageSource.pageId`, `explicitAnchor`, walk-context page id) must land first and stay additive; daily rebase on `main`.
- **Asset budget on image-heavy trees**: 50 MiB cap (`prepare.ts:20`) will trigger on real spaces; sha256-dedupe + early actionable error is v1, per-chapter asset streaming into the compiler VFS is explicitly deferred (L follow-up, UMSETZUNGSPLAN T4.3/T4.9). Browser-host memory for huge spaces bounded only by `maxPages` in v1.
- **CQL `id in (...)` length**: chunked at 100; verify server-side CQL length limits in E2E with a >100-page scope (can reuse DOCSY only if large enough, otherwise unit-level proof + note).
- **Unreadable pages inside a tree** (permission gaps): proposal from A1 — emit note + omit chapter, count in report; alternative is hard abort. **Open — decide before implementation.**
- **Root page excluded by label filter**: proposal — hard error with hint (children-as-top-chapters rejected). **Open — confirm.**
- **Folder-only space roots** (no classic homepage): error with guidance in v1. **Open — is a synthetic root chapter needed?**
- **Chapter numbering** (Typst `set heading(numbering: "1.1")`) as theme option: proposal yes, default off — belongs to the template/settings lane, only the anchor contract here must not preclude it. **Open.**
- **Traversal wording**: UMSETZUNGSPLAN T1.1 says "BFS", BASELINE-DESIGN §A prescribes pre-order DFS with UI-position child order; this plan implements pre-order (document order). Flagged so the discrepancy is resolved consciously, not silently.
- **`getPageDetails` cost**: it expands history + labels per page (`client.ts:539-568`); for 500-page scopes consider a lighter expand profile on the adapter (labels only) — measure in E2E before optimizing.

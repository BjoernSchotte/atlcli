# 001 — ExportBlock model extension (sync point 0)

Reference: UMSETZUNGSPLAN T0.1/T0.2 · BASELINE-DESIGN cluster C/E (prerequisites)

Status: Plan. Owner: one developer/agent, serial — this is the single
non-parallelizable foundation. Everything in Phase 1 (lanes A, C, E, G and the
engine parts of D/P/K) depends on this landing first, in **one PR**, so that
`packages/confluence/src/export-blocks.ts` is touched exactly once before the
lanes fork.

## Goal & user value

Extend the shared intermediate export model (`ExportBlock` in
`packages/confluence/src/export-blocks.ts`) with every variant the Phase-1
content features need, and give both engines (`@atlcli/docx`, `@atlcli/pdf`)
compiling **no-op renderings** for the new variants — behavior byte-identical
to today.

No user-visible feature ships here. The value is structural:

- **One landing instead of three conflicting ones.** Lanes C (compatibility
  macros), E (macro-renderer registry) and A (scope composition) all want to
  change the block model. Landing the model once eliminates three-way merge
  conflicts on the hot file (see UMSETZUNGSPLAN, "Merge-Ordnung").
- **The compiler writes the engines' to-do list.** Both serializers have
  exhaustive `switch` statements with `never` checks
  (`packages/docx/src/serialize.ts:434`, `packages/pdf/src/serialize.ts:805`,
  `packages/pdf/src/prepare.ts:275`). Adding a variant produces compile errors
  at exactly the places that need rendering — T0.2 resolves them with
  deliberate no-ops so `main` stays green and every follow-up folder
  (002-…, 003-…, …) can start in parallel.
- **Lossless macro capture** (cluster E prerequisite): today `walkMacro`
  (`export-blocks.ts:667`) throws away macro parameters and bodies when it
  emits `{ type: "unknown", macroName }` (`export-blocks.ts:709`). Enriching
  the `unknown` block is what makes any renderer strategy (live Jira tables,
  draw.io previews, `export_view` fallback) structurally possible at all.

## Dependencies

- **Upstream: none.** This is the root of the Phase-1 dependency graph.
- **Downstream (blocked until this merges):** T1.1–T1.10, T1.13/T1.14 and the
  engine-rendering halves of every content feature. Independent work that may
  proceed in parallel regardless: T3.1, T1.16, T2.1, T2.4, T1.11/T1.12, T4.6.
- **Consumed-as-is (verified, no changes needed):**
  - Type re-export seams: `packages/confluence/src/index.ts:5` and
    `packages/confluence/src/index.browser.ts:18` both do
    `export * from "./export-blocks.js"` — new types surface automatically to
    all hosts (CLI, extension, further hosts).
  - Walker helpers that the enrichment reuses: `childByName`
    (`export-blocks.ts:448`), `childrenByName` (`:453`), `macroParam` (`:458`),
    `elementText` (`:442`), `walkBlocks` (`:369`). Attribute keys are
    lowercased by `parseAttributes` (`:261`), so `ac:macro-id` reads as
    `el.attrs["ac:macro-id"]`.

## Architecture (isomorphic)

Unchanged pipeline, richer vocabulary:

```
storageToBlocks(storage, options?)        packages/confluence/src/export-blocks.ts
        │  ExportBlock[] + ExportNote[]
        ├── serializeBlocks(...)          packages/docx/src/serialize.ts   (OOXML)
        └── preparePdfDocument(...)       packages/pdf/src/prepare.ts
              │  PreparedPdfBlock[]
              └── serializePdfDocument()  packages/pdf/src/serialize.ts   (Typst)
```

Principles carried over from the existing model (header comment of
`export-blocks.ts`):

- **Isomorphic.** No `node:`/`bun:` imports; everything added here must build
  for the browser entry (`index.browser.ts`) unchanged.
- **Consumer-neutral.** The model describes content ("a page break", "a
  landscape region", "a named anchor"), never presentation (no OOXML, no
  Typst). Rendering decisions stay in the serializers — and in this sync
  point the rendering decision is deliberately "render nothing / render
  children transparently".
- **Never silently drop.** The `orientation` no-op must serialize its
  `content` children transparently in both engines, so no content can be lost
  in the window between the walker learning `scroll-landscape` (T1.4) and the
  engines learning real orientation rendering (T1.5).
- **Additive and backward-compatible.** All new fields are optional; all new
  variants are unreachable from today's walker output (the walker emits
  `pageBreak`/`orientation`/`anchor` only from T1.4 on). The only walker
  change is the lossless `unknown` enrichment, which adds optional fields to
  already-emitted blocks.
- **Report-identical.** No new `ExportNote` codes, no changed messages. The
  `unknown` body is walked with a scratch `WalkCtx` whose notes are discarded
  (see Risks), so `storageToBlocks(...).notes` stays exactly as today.

Target model shape (final state of this PR):

```ts
// packages/confluence/src/export-blocks.ts
export type CaptionKind = "figure" | "table" | "code" | "equation";
export interface Caption { kind: CaptionKind; content: InlineNode[] }

export type ExportBlock =
  // ...existing variants unchanged, except three gain an optional caption:
  | { type: "codeBlock"; language?: string; code: string; caption?: Caption }
  | { type: "table"; rows: TableRow[]; columnWidths?: number[]; caption?: Caption }
  | { type: "image"; source: ImageSource; alt?: string; width?: number; height?: number; caption?: Caption }
  // new variants:
  | { type: "pageBreak" }
  | { type: "orientation"; landscape: boolean; content: ExportBlock[] }
  | { type: "anchor"; name: string }
  // enriched (all fields optional → backward compatible):
  | { type: "unknown"; macroName: string;
      params?: Record<string, string>;   // every <ac:parameter>
      body?: ExportBlock[];              // <ac:rich-text-body>, recursively walked
      plainBody?: string;                // <ac:plain-text-body>
      macroId?: string };                // ac:macro-id attribute

export interface StorageToBlocksOptions {
  /** Exporter identity for scroll-only / scroll-ignore (consumed from T1.4 on). */
  exporter?: "pdf" | "word";
}
export function storageToBlocks(storage: string, options?: StorageToBlocksOptions): StorageToBlocksResult;
```

## Tasks

Every task is sized for one reviewable commit inside the single T0 PR.

### Model (@atlcli/confluence)

- [ ] Add `CaptionKind` and `Caption` to
      `packages/confluence/src/export-blocks.ts`, exported next to
      `InlineNode`/`LinkTarget` (model section, around line 90–113).
- [ ] Extend the `codeBlock`, `table` and `image` variants of `ExportBlock`
      (`export-blocks.ts:102`) with `caption?: Caption`. No walker emits a
      caption yet (that is T1.4, `scroll-title`).
- [ ] Add the three new variants to `ExportBlock`: `{ type: "pageBreak" }`,
      `{ type: "orientation"; landscape: boolean; content: ExportBlock[] }`,
      `{ type: "anchor"; name: string }`. Update the doc comment on the union
      to state which walker features feed them (T1.4) and that engines render
      them as no-ops until T1.3/T1.5.
- [ ] Enrich the `unknown` variant (`export-blocks.ts:113`) with
      `params?`, `body?`, `plainBody?`, `macroId?` as sketched above; update
      its doc comment ("never carries raw XML" still holds — parameters and a
      walked body are structured data, not passthrough XML).
- [ ] Add `StorageToBlocksOptions` (with `exporter?: "pdf" | "word"`) and
      change `storageToBlocks(storage)` (`export-blocks.ts:330`) to
      `storageToBlocks(storage, options?)`. Thread `exporter` into `WalkCtx`
      (`export-blocks.ts:278`) as an optional field. **No behavioral use yet**
      — semantics arrive with `scroll-only`/`scroll-ignore` in T1.4. Existing
      call sites keep compiling (optional parameter).
- [ ] Implement the lossless capture in the unknown-macro fallback of
      `walkMacro` (`export-blocks.ts:698–710`):
      - `params`: iterate `childrenByName(el, "ac:parameter")`, key =
        lowercased `ac:name` attr, value = `elementText(p).trim()` (same
        reading as `macroParam`, `:458`); omit the field when empty.
      - `plainBody`: `elementText(childByName(el, "ac:plain-text-body"))`
        when present.
      - `body`: `walkBlocks(bodyEl.children, scratchCtx)` for
        `childByName(el, "ac:rich-text-body")` — using a **scratch
        `WalkCtx`** whose notes are discarded so the report is unchanged
        (nested content of an unrendered macro must not produce report
        lines; the T1.7 resolver pass re-walks and re-reports when it
        actually renders the body). Omit when absent/empty.
      - `macroId`: `el.attrs["ac:macro-id"]` when present.
      - The existing note push (`macro-not-rendered` / `unknown-macro`,
        `:701–708`) stays byte-identical.
- [ ] Pass the engine identity at the one call site an engine owns:
      `packages/docx/src/export.ts:235` becomes
      `storageToBlocks(input.details.storage ?? "", { exporter: "word" })`.
      Pure plumbing — zero behavior until T1.4. (PDF hosts call
      `storageToBlocks` themselves and wire `{ exporter: "pdf" }` in Lane C.)
- [ ] `isInlineMacro` (`export-blocks.ts:397`) is intentionally **not**
      touched here — the `scroll-only-inline`/`scroll-ignore-inline` handling
      is T1.4. Leave a one-line pointer comment so Lane C finds the seam.

### Engines (no-op renderings)

DOCX (`packages/docx/src/serialize.ts`):

- [ ] Resolve the compile errors in the exhaustive `switch` of
      `serializeBlock` (`serialize.ts:344–438`) with three new cases placed
      before the `never` default (`:434`):
      - `case "pageBreak": return "";`
      - `case "anchor": return "";`
      - `case "orientation": return serializeChildren(block.content, ctx, notes, depth);`
        (transparent passthrough via the existing helper, `serialize.ts:491` —
        children render exactly as if the region wrapper did not exist).
      No notes are pushed: today's walker never emits these blocks, so silent
      no-ops keep output and report byte-identical.
- [ ] Extend the two non-exhaustive recursive walks so an `orientation`
      region's children are not skipped once T1.4 emits it:
      `minHeadingLevel` (`serialize.ts:249`, heading promotion must see
      headings inside regions) and `prefetchBlocks` (`serialize.ts:281`,
      images/diagrams inside regions must prefetch). Both get
      `case "orientation": … recurse into block.content …`.
- [ ] `caption?` on `codeBlock`/`table`/`image` needs **no** DOCX change
      (optional field, ignored by `serializeBlock`); confirm the `unknown`
      placeholder (`serialize.ts:431–432`) still renders from `macroName`
      only and ignores the enrichment fields.

PDF (`packages/pdf/src/{types,prepare,serialize,run-export}.ts`):

- [ ] `packages/pdf/src/types.ts` — extend `PreparedPdfBlock`
      (`types.ts:36`):
      - Add `"orientation"` to the `Exclude<…>` passthrough list and
        re-declare it with prepared children:
        `| { type: "orientation"; landscape: boolean; content: PreparedPdfBlock[] }`.
        (`pageBreak`/`anchor` and the enriched `unknown` flow through the
        existing `Exclude` passthrough automatically — verify by typecheck,
        no edit needed.)
      - The re-declared `table`/`codeBlock` variants gain `caption?: Caption`
        and the `image`/`diagram` variants gain `caption?: Caption`
        (import `Caption` as a type from `@atlcli/confluence`), so Lane C's
        rendering task never has to touch this file again.
- [ ] `packages/pdf/src/prepare.ts` — extend the `walk` switch
      (`prepare.ts:192–281`):
      - `case "orientation": return { ...block, content: await walk(block.content) };`
        (same shape as the `blockquote` arm, `:198`).
      - Add `"pageBreak"` and `"anchor"` to the passthrough group
        (`case "heading": case "paragraph": case "divider": case "unknown":`,
        `:270–274`).
      - Carry captions across the two arms that rebuild objects explicitly:
        the `image` arm (`:229–236` and the failure arm `:243`) and the
        `diagram` arm (`:255`) copy `caption: block.caption`. (`table` and
        non-mermaid `codeBlock` spread `...block` and carry it for free.)
- [ ] `packages/pdf/src/serialize.ts` — resolve the compile errors in
      `serializeBlock` (`serialize.ts:639–811`) before the `never` default
      (`:805`):
      - `case "pageBreak": value = ""; break;`
      - `case "anchor": value = ""; break;`
      - `case "orientation": value = serializeBlocks(block.content, writer, \`${path}.content\`, context); break;`
        (transparent — no `#set page(flipped:)` yet, that is T1.5).
      No new notes; the `unknown` arm (`:796–804`) keeps emitting
      `pdf-unknown-block` from `macroName` only.
- [ ] Extend the non-exhaustive recursive walks in the PDF engine with an
      `orientation` recursion (and a `""` result for `pageBreak`/`anchor`
      where a value is required): `blocksPlainText` (`serialize.ts:122`),
      `minHeadingLevel` (`serialize.ts:464`), `collectHeadingLabels`
      (`serialize.ts:488`), and `countPrepared`
      (`packages/pdf/src/run-export.ts:74`).
- [ ] Run `bun run typecheck` at the repo root — the `never` checks in both
      engines are the completeness proof; typecheck green means no switch was
      missed.

### Tests (no mocking)

Hard rule (repo-wide, applies here): **never mock HTTP or the
Confluence/Jira clients.** Unit tests feed real storage-XML fixture strings
into `storageToBlocks` (the established pattern throughout
`packages/confluence/src/export-blocks.test.ts` — e.g. the feature-zoo
integration snapshot at its "structural snapshot of the whole document"
test); engine tests feed hand-built `ExportBlock[]` documents (the pattern in
`packages/pdf/src/serialize.test.ts:26` and
`packages/docx/src/serialize.test.ts`). E2E runs against the real Confluence
instance (profile `mayflower`, space `DOCSY` — CLAUDE.md workflow rule).

Unit — walker (`packages/confluence/src/export-blocks.test.ts`):

- [ ] New `describe("storageToBlocks — lossless unknown macros")` with real
      storage fixtures:
      - a `drawio`-style macro with `ac:macro-id`, several `<ac:parameter>`s
        and no body → `params` + `macroId` captured, `body`/`plainBody`
        absent;
      - a macro with `<ac:rich-text-body>` containing a paragraph and a
        nested known macro → `body` is a walked `ExportBlock[]` **and**
        `notes` contains only the single outer `unknown-macro`/
        `macro-not-rendered` note (scratch-ctx regression test);
      - a macro with `<ac:plain-text-body><![CDATA[…]]>` → `plainBody`
        captured verbatim;
      - a bare `<ac:structured-macro ac:name="x"/>` → block equals
        `{ type: "unknown", macroName: "x" }` with no extra fields
        (backward-compat pin).
- [ ] Options test: `storageToBlocks(xml, { exporter: "pdf" })` and
      `storageToBlocks(xml)` return deeply-equal results for a fixture with
      mixed content (pins "no semantics before T1.4").
- [ ] Review the updated snapshot
      (`packages/confluence/src/__snapshots__/export-blocks.test.ts.snap`):
      the only permitted diffs are **additive fields on `unknown` blocks**.
      Any other diff is a regression — reject it.
- [ ] Compile-shape test constructing an `ExportBlock[]` literal containing
      `pageBreak`, `orientation` (with children), `anchor`, and captioned
      `codeBlock`/`table`/`image` — pins the public type shape hosts rely on.

Unit — DOCX engine (`packages/docx/src/serialize.test.ts` + golden):

- [ ] New test: serialize a document containing the three new blocks plus
      captioned image/table/codeBlock through `serializeBlocks` with a
      minimal `SerializeContext`; assert (a) `pageBreak`/`anchor` contribute
      zero XML — output equals the same document without them, (b)
      `orientation` output equals its children serialized bare, (c) headings
      inside an `orientation` region still drive promotion
      (`computeHeadingOffset` regression), (d) zero notes added.
- [ ] Golden pin: `packages/docx/src/golden.test.ts` must pass **unchanged —
      no recapture of `golden-extension-export.json`**. This is the
      engine-level proof that T0 changed nothing observable (same role the
      golden played for the spec-006 extraction).

Unit — PDF engine (`packages/pdf/src/{prepare,serialize}.test.ts`):

- [ ] `prepare.test.ts`: prepare a document with an `orientation` region
      containing an attachment image (real bytes via the local
      `PdfAssetResolver` fixture pattern already used there — an in-memory
      resolver is a real implementation of the port, not an HTTP mock);
      assert the image inside the region is resolved into `assets` and
      `caption` fields survive `preparePdfDocument` on table/codeBlock/image.
- [ ] `serialize.test.ts` (the PDF engine's golden-style suite — it pins
      `main.typ` content): assert a document with `pageBreak`/`anchor`
      produces `main.typ` identical to the same document without them, and
      an `orientation` region's children appear exactly as if unwrapped; no
      `pdf-unknown-block` or other new notes.
- [ ] `run-export.test.ts`: `countPrepared` counts an image inside an
      `orientation` region (report `embeddedImages` regression).

E2E — real Confluence (profile `mayflower`, space `DOCSY`):

- [ ] Create the test page containing the affected macros. Author
      `/tmp/t0-zoo.md` with raw storage passthrough (the markdown→storage
      converter allows HTML/macro passthrough — `html: true` in
      `packages/confluence/src/markdown.ts:64`; verify the macros survive
      by fetching the page after create): body includes
      `<ac:structured-macro ac:name="scroll-pagebreak"/>`, a
      `scroll-landscape` macro with a rich-text body (wide table), a
      `scroll-title` macro wrapping an image, a `scroll-bookmark` macro, and
      a parameterized third-party-style macro (e.g. `drawio`). Then:
      `bun run --cwd apps/cli src/index.ts wiki page create --space DOCSY --title "T0 ExportBlock no-op zoo" --body /tmp/t0-zoo.md --profile mayflower`
      — record the created page id.
- [ ] Export the page with the ts engine and assert **today's behavior**:
      `bun run --cwd apps/cli src/index.ts wiki export <pageId> --engine ts -o /tmp/t0-zoo.docx --profile mayflower`
      — the DOCX opens, `scroll-*` and `drawio` macros render as today's
      placeholder paragraphs (`[<name> macro not rendered]`), and the report
      lists the same `macro-not-rendered`/`unknown-macro` notes as a
      pre-change run of the same command on `main` (run both, diff the
      reports). PDF has no CLI command until T3.1/T3.2 — the PDF no-op proof
      at sync point 0 is the unit/`main.typ` pin above; note this limitation
      in the PR description.
- [ ] Cleanup (workflow rule): delete the test page —
      `bun run --cwd apps/cli src/index.ts wiki page delete --id <pageId> --profile mayflower`
      — and verify with `wiki page get --id <pageId>` that it is gone.

## Definition of Done

- [ ] `bun run typecheck` and `bun test` green at the repo root; both
      engines' exhaustive `never` checks compile with the new variants
      handled.
- [ ] `packages/docx/src/golden.test.ts` passes **without recapturing**
      `golden-extension-export.json`; PDF `serialize.test.ts` expectations
      pass without loosening existing assertions.
- [ ] Walker snapshot diffs are limited to additive optional fields on
      `unknown` blocks; `storageToBlocks(...).notes` output is proven
      unchanged by tests.
- [ ] No new `ExportNote` codes, no changed note messages, no new public API
      surface beyond: `Caption`, `CaptionKind`, `StorageToBlocksOptions`, the
      new/extended `ExportBlock` variants, and the widened `storageToBlocks`
      signature — all exported through `index.ts` **and** `index.browser.ts`
      (existing `export *`).
- [ ] E2E run against DOCSY performed, before/after report diff empty, test
      page deleted.
- [ ] One PR, conventional commit style
      (`feat(confluence): extend ExportBlock model …` +
      `feat(docx,pdf): compile no-op renderings …`), merged before any lane
      branch is cut; lanes rebase on it.

## Risks & open questions

- **Scratch-ctx decision for `unknown.body` notes.** Walking a rich-text
  body can encounter nested macros/images that would push notes. Discarding
  those notes keeps the report byte-identical (the T0 contract) and avoids
  reporting on content nobody renders; the cost is that the T1.7 resolver
  pass must re-report when it renders body blocks. Alternative (collect and
  merge now) would change reports today — rejected for this PR. Revisit in
  Lane E if the resolver wants pre-collected notes.
- **`ac:macro-id` presence.** The attribute is present in Cloud storage but
  the field stays optional and the E2E zoo page verifies capture against a
  real instance. If a real fixture shows a different casing/name, only the
  walker line changes.
- **`orientation` renders portrait until T1.5.** The transparent no-op means
  a `scroll-landscape` region exported between T1.4 and T1.5 renders its
  content in portrait — acceptable (identical to today's behavior for that
  content) and the reason T1.5 lists T1.4 + T0.2 as prerequisites.
- **`PreparedPdfBlock` passthrough is implicit.** `pageBreak`/`anchor` reach
  the PDF serializer via the `Exclude<…>` passthrough in `types.ts:36`; a
  future variant with children must remember to re-declare (as `orientation`
  does here). Mitigation: the exhaustive switch in `prepare.ts` fails to
  compile if someone forgets the walk arm.
- **Open: include `explicitAnchor?` on `heading` now?** BASELINE-DESIGN
  (cluster A foundation) wants `heading.explicitAnchor` for chapter anchors;
  UMSETZUNGSPLAN scopes it to Lane A (T1.1) but it lives in the same hot
  file. Recommendation: add the optional field in this PR (two lines, no
  behavior) to spare `export-blocks.ts` a fourth landing — decide at review.
- **Open: should the DOCX host pass `{ exporter: "word" }` here or in
  T1.4?** This plan wires it now (pure plumbing, no semantics); if review
  prefers zero cross-package edits, drop that task and let Lane C do it.

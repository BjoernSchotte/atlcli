# 001 — ExportBlock model extension (sync point 0)

Reference: UMSETZUNGSPLAN T0.1/T0.2 · BASELINE-DESIGN cluster C/E (prerequisites)

Status: **Erledigt** (implementiert 2026-07-19, Branch
`claude/exportblock-model-subagents-82d71f`, Commits `e7e693b` +
`061e361`; Review: approve, keine Defekte). Typecheck grün, 1905 Tests
grün, DOCX-Golden ohne Recapture, E2E gegen DOCSY inkl. verifiziertem
Cleanup (Seite 1124565000 gelöscht, 404 bestätigt). Beide offenen
Fragen wurden gemäß Empfehlung entschieden: `heading.explicitAnchor?`
ist mit drin, `{ exporter: "word" }` ist in `packages/docx/src/export.ts`
verdrahtet. Zwei dokumentierte E2E-Abweichungen: die Zoo-Seite wurde per
Storage-Representation-Update statt Markdown-Passthrough befüllt (der
Converter escapte die rohen Makros; Endzustand identisch), und die Makros
erscheinen im ts-Engine-Report als `notes` statt `unsupportedNames`
(Python-Engine-Konzept; Vorher/Nachher-Parität war der Prüfpunkt und ist
erfüllt). Der Cross-Plan-Follow-up an 004-macro-renderer (Adoption der
`MacroParameter[]`-Form, `bodyNotes`-Promotion, `unknown.body`-Mention-
Resolution) ist erledigt: Commit `43136b4`.

Ursprünglicher Plan-Kopf: Owner: one developer/agent, serial — this is the
single non-parallelizable foundation. Everything in Phase 1 (lanes A, C, E, G and the
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
  engines learning real orientation rendering (T1.5). The same principle
  governs the two additions this rule motivates elsewhere in this plan:
  macro parameters that live in `ri:*` element children (not text) are
  captured as structured `refs`, not silently read as empty strings; and
  notes produced while scratch-walking an `unknown` macro's body are kept as
  `bodyNotes` on the block rather than discarded, even though they are not
  merged into the top-level report yet (see Architecture's macro-parameter
  note and Risks).
- **Additive and backward-compatible.** All new fields are optional; all new
  variants are unreachable from today's walker output (the walker emits
  `pageBreak`/`orientation`/`anchor` only from T1.4 on). The only walker
  change is the lossless `unknown` enrichment, which adds optional fields to
  already-emitted blocks.
- **Report-identical.** No new `ExportNote` codes, no changed messages. The
  `unknown` body is walked with a scratch `WalkCtx` (via `forkWalkCtx`) whose
  notes are collected into `bodyNotes` on the block instead of `ctx.notes`
  (see Risks), so `storageToBlocks(...).notes` stays exactly as today.
  Mention resolution is scoped the same way: T0 wires `orientation.content`
  and `caption?.content` into `resolve-mentions.ts`'s traversal, but
  deliberately not `unknown.body` — that body is not rendered by anything
  yet, and `apps/extension/utils/pdf/run-export.ts` already calls
  `resolveExportMentions` unconditionally today, so wiring it in now would
  be a real (if narrow) behavior change, not a no-op (see Risks).

Target model shape (final state of this PR):

```ts
// packages/confluence/src/export-blocks.ts
export type CaptionKind = "figure" | "table" | "code" | "equation";
export interface Caption { kind: CaptionKind; content: InlineNode[] }

/**
 * A structured reference captured from a macro parameter's `ri:*` child
 * element (never raw XML — a typed projection of the five reference shapes
 * the markdown→storage converter and hand-authored storage both emit:
 * `ri:page`, `ri:attachment`, `ri:url`, `ri:user`, `ri:space`).
 */
export type MacroParamRef =
  | { kind: "page"; contentId?: string; contentTitle?: string; spaceKey?: string; anchor?: string }
  | { kind: "attachment"; filename: string }
  | { kind: "url"; value: string }
  | { kind: "user"; accountId: string }
  | { kind: "space"; spaceKey: string };

/**
 * One `<ac:parameter>`. `name` is the lowercased `ac:name` attribute — the
 * empty string for the unnamed first parameter some macros use (e.g.
 * `include`/`excerpt-include`'s page ref, `markdown.ts:333`). `text` holds
 * trimmed text content when present (today's `elementText` semantics);
 * `refs` holds every `ri:*` child in document order — most parameters have
 * at most one, but `spaces` (`blog-posts`) can carry several sibling
 * `ri:space` refs under a single parameter. A parameter can have `text`,
 * `refs`, both (mixed content), or neither (empty parameter).
 */
export interface MacroParameter {
  name: string;
  text?: string;
  refs?: MacroParamRef[];
}

/** Case-insensitive convenience lookup for a parameter's plain-text value only (mirrors the pre-existing internal `macroParam` helper). Returns `undefined` for ref-only or absent parameters — callers that need `ri:*` data read `refs` directly. */
export function macroParamText(params: MacroParameter[] | undefined, name: string): string | undefined;

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
      params?: MacroParameter[];         // every <ac:parameter>, ordered, losslessly typed
      body?: ExportBlock[];              // <ac:rich-text-body>, recursively walked
      plainBody?: string;                // <ac:plain-text-body>
      macroId?: string;                  // ac:macro-id attribute
      bodyNotes?: ExportNote[] };        // notes the scratch walk of `body` produced but did
                                          // not merge into the top-level report (see Risks)

export interface StorageToBlocksOptions {
  /** Exporter identity for scroll-only / scroll-ignore (consumed from T1.4 on). */
  exporter?: "pdf" | "word";
}
export function storageToBlocks(storage: string, options?: StorageToBlocksOptions): StorageToBlocksResult;
```

**Why not `Record<string, string>` for `params`** (as BASELINE-DESIGN §5's prerequisite sketch and 004-macro-renderer's `MacroInstance` currently assume — see Risks for the cross-plan follow-up this implies): `packages/confluence/src/markdown.ts` proves real storage carries `ri:page` (`:310,:333`), `ri:attachment` (`:406`), `ri:url` (`:442`), `ri:user` (`:796`) and `ri:space` (`:790`) as **element** children of `<ac:parameter>`, not text. `elementText()` (`export-blocks.ts:442`) walks text nodes only, so a naive `Record<string, string>` capture reads these as empty strings and — because the capture task omits empty fields — silently drops the parameter entirely. That defeats the "lossless macro capture" goal for exactly the macros Lane E (T1.8 Jira, T1.9 draw.io, T1.10 export_view) most needs `params` for, and for `include`/`excerpt-include`/`multimedia`/`widget`/`blog-posts` today. A `Record` also can't represent duplicate parameter names, name casing, or parameter order — all legal in storage XML.

## Tasks

Every task is sized for one reviewable commit inside the single T0 PR.

### Model (@atlcli/confluence)

- [x] Add `CaptionKind` and `Caption` to
      `packages/confluence/src/export-blocks.ts`, exported next to
      `InlineNode`/`LinkTarget` (model section, around line 90–113).
- [x] Extend the `codeBlock`, `table` and `image` variants of `ExportBlock`
      (`export-blocks.ts:102`) with `caption?: Caption`. No walker emits a
      caption yet (that is T1.4, `scroll-title`).
- [x] Add the three new variants to `ExportBlock`: `{ type: "pageBreak" }`,
      `{ type: "orientation"; landscape: boolean; content: ExportBlock[] }`,
      `{ type: "anchor"; name: string }`. Update the doc comment on the union
      to state which walker features feed them (T1.4) and that engines render
      them as no-ops until T1.3/T1.5.
- [x] Add `MacroParamRef`, `MacroParameter` and the `macroParamText()`
      convenience export to `export-blocks.ts`, next to `Caption` (model
      section). `macroParamText` is a straight lift of the existing
      case-insensitive lookup loop in `macroParam` (`:458`), just reading
      `.text` instead of `elementText(p)`.
- [x] Enrich the `unknown` variant (`export-blocks.ts:113`) with
      `params?: MacroParameter[]`, `body?`, `plainBody?`, `macroId?`,
      `bodyNotes?: ExportNote[]` as sketched above; update its doc comment
      ("never carries raw XML" still holds — parameters and a walked body
      are structured data, not passthrough XML).
- [x] Add `StorageToBlocksOptions` (with `exporter?: "pdf" | "word"`) and
      change `storageToBlocks(storage)` (`export-blocks.ts:330`) to
      `storageToBlocks(storage, options?)`. Thread `exporter` into `WalkCtx`
      (`export-blocks.ts:278`) as an optional field. **No behavioral use yet**
      — semantics arrive with `scroll-only`/`scroll-ignore` in T1.4. Existing
      call sites keep compiling (optional parameter).
- [x] Add a `forkWalkCtx(ctx: WalkCtx, notes: ExportNote[]): WalkCtx` helper
      next to `WalkCtx` (`export-blocks.ts:278`) that returns
      `{ ...ctx, notes }`. Every current and future scratch walk (today: only
      the `unknown.body` capture below) must go through this helper instead
      of hand-building `{ notes: [] }` — `WalkCtx` already grows an
      `exporter` field in this same PR, and a hand-built scratch context
      would silently compile while dropping it (and any field added later),
      producing exporter-blind rendering decisions inside macro bodies for
      whichever lane discovers the gap. Document the invariant on `WalkCtx`'s
      doc comment: "a scratch walk replaces only the note sink; it inherits
      every other field via `forkWalkCtx`."
- [x] Implement the lossless capture in the unknown-macro fallback of
      `walkMacro` (`export-blocks.ts:698–710`):
      - `params`: iterate `childrenByName(el, "ac:parameter")` in document
        order; for each, `name` = lowercased `ac:name` attr (empty string
        when absent — the unnamed first parameter of `include`/
        `excerpt-include`), `text` = `elementText(p).trim()` when non-empty,
        `refs` = one `MacroParamRef` per recognized `ri:page` /
        `ri:attachment` / `ri:url` / `ri:user` / `ri:space` **element**
        child (there can be more than one, e.g. `blog-posts`' `spaces`
        parameter), skipping unrecognized `ri:*` names rather than
        misclassifying them. Push a `MacroParameter` only when `text` or
        `refs` (or both) is non-empty; omit `params` entirely when no
        parameter yielded one. **Do not** reuse `elementText` as the sole
        read path — it silently returns `""` for element-only parameters
        (see "Why not `Record<string, string>`" above), which is exactly
        the loss this task exists to prevent.
      - `plainBody`: `elementText(childByName(el, "ac:plain-text-body"))`
        when present.
      - `body`: `walkBlocks(bodyEl.children, forkWalkCtx(ctx, scratchNotes))`
        for `childByName(el, "ac:rich-text-body")`, with `scratchNotes = []`.
        After the walk, if `scratchNotes` is non-empty, attach it as
        `bodyNotes` on the `unknown` block **without** merging it into
        `ctx.notes` — so `storageToBlocks(...).notes` (the top-level report)
        stays exactly as today, but the observations are not lost: a
        nested unresolvable image, a nested unknown macro, or any other
        note-worthy content inside the captured body survives on the block
        for a later consumer to promote. This replaces silently discarding
        the scratch notes (see Risks — the earlier "discard" design made the
        plan's own claim that "the T1.7 resolver pass re-walks and
        re-reports" false for content `walkImage` drops outright, e.g. an
        unresolvable nested `<ac:image>`, which leaves no trace in `body`
        for anything to re-walk). Omit `body`/`bodyNotes` when the body is
        absent/empty.
      - `macroId`: `el.attrs["ac:macro-id"]` when present.
      - The existing note push (`macro-not-rendered` / `unknown-macro`,
        `:701–708`) stays byte-identical.
- [x] Pass the engine identity at the one call site an engine owns:
      `packages/docx/src/export.ts:235` becomes
      `storageToBlocks(input.details.storage ?? "", { exporter: "word" })`.
      Pure plumbing — zero behavior until T1.4. (PDF hosts call
      `storageToBlocks` themselves and wire `{ exporter: "pdf" }` in Lane C.)
- [x] `isInlineMacro` (`export-blocks.ts:397`) is intentionally **not**
      touched here — the `scroll-only-inline`/`scroll-ignore-inline` handling
      is T1.4. Leave a one-line pointer comment so Lane C finds the seam.
- [x] Extend the two non-exhaustive `switch (block.type)` walks in
      `packages/confluence/src/resolve-mentions.ts` —
      `collectUnresolvedMentionIds` (`:25`) and `resolveBlockMentions`
      (`:68`) — with a `case "orientation":` that recurses into
      `block.content` (mirroring the existing `callout`/`blockquote` cases),
      and add `case "codeBlock": case "image": case "table":` handling that
      also visits `block.caption?.content` (in addition to `table`'s
      existing cell recursion). Without the `orientation` case,
      `resolveExportMentions` — already exported through `index.ts`/
      `index.browser.ts` and the designated mention-resolution entry point
      (`@mention` inside a `scroll-landscape` region) — silently stops
      seeing mentions nested in the new container once a host wires it up;
      the switches lack a `never` check, so this is exactly the class of
      silent-drop bug the plan's "never silently drop" principle targets and
      that a typecheck cannot catch. The caption case matters even though no
      walker emits a caption until T1.4: `Caption.content` is typed
      `InlineNode[]` in this very model (target shape above), so a mention
      inside a `scroll-title` caption would otherwise be reachable by every
      other traversal in the codebase except this one — silently leaving a
      technical `accountId` in a visible caption once T1.4 lands, with
      nothing (not typecheck, not the non-exhaustive switch) flagging the
      gap. `pageBreak`/`anchor` need no case (no nested content).
      **Deliberately not in scope for this task: `case "unknown":`
      recursing into `block.body`.** `unknown.body` is populated
      unconditionally by the capture task above, and
      `apps/extension/utils/pdf/run-export.ts:165` already calls
      `resolveExportMentions` unconditionally on every walked block *today*
      — so adding an `unknown` case here would make the existing PDF export
      path start issuing live `getUsersBulk` calls (and possibly surface a
      new `pdf-mention-unresolved`/`pdf-mention-resolution-failed` note) for
      mentions buried in macro bodies nobody renders yet, breaking this PR's
      own "no user-visible feature ships here" / report-identical goal.
      Traversing `unknown.body` belongs with T1.7 (Lane E), once a macro
      renderer actually turns that body into visible output — leave a
      one-line pointer comment on `resolveBlockMentions`'s `default` arm
      saying so.

### Engines (no-op renderings)

DOCX (`packages/docx/src/serialize.ts`):

- [x] Resolve the compile errors in the exhaustive `switch` of
      `serializeBlock` (`serialize.ts:344–438`) with three new cases placed
      before the `never` default (`:434`):
      - `case "pageBreak": return "";`
      - `case "anchor": return "";`
      - `case "orientation": return serializeChildren(block.content, ctx, notes, depth);`
        (transparent passthrough via the existing helper, `serialize.ts:491` —
        children render exactly as if the region wrapper did not exist).
      No notes are pushed: today's walker never emits these blocks, so silent
      no-ops keep output and report byte-identical.
- [x] Extend the two non-exhaustive recursive walks so an `orientation`
      region's children are not skipped once T1.4 emits it:
      `minHeadingLevel` (`serialize.ts:249`, heading promotion must see
      headings inside regions) and `prefetchBlocks` (`serialize.ts:281`,
      images/diagrams inside regions must prefetch). Both get
      `case "orientation": … recurse into block.content …`.
- [x] `caption?` on `codeBlock`/`table`/`image` needs **no** DOCX change
      (optional field, ignored by `serializeBlock`); confirm the `unknown`
      placeholder (`serialize.ts:431–432`) still renders from `macroName`
      only and ignores the enrichment fields.

PDF (`packages/pdf/src/{types,prepare,serialize,run-export}.ts`):

- [x] `packages/pdf/src/types.ts` — extend `PreparedPdfBlock`
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
- [x] `packages/pdf/src/prepare.ts` — extend the `walk` switch
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
- [x] `packages/pdf/src/serialize.ts` — resolve the compile errors in
      `serializeBlock` (`serialize.ts:639–811`) before the `never` default
      (`:805`):
      - `case "pageBreak": value = ""; break;`
      - `case "anchor": value = ""; break;`
      - `case "orientation": value = serializeBlocks(block.content, writer, \`${path}.content\`, context); break;`
        (transparent — no `#set page(flipped:)` yet, that is T1.5).
      No new notes; the `unknown` arm (`:796–804`) keeps emitting
      `pdf-unknown-block` from `macroName` only.
      **No behavioral change needed to `writeMapped`** (`serialize.ts:578`):
      every `serializeBlock` branch — including the pre-existing `unknown`
      arm's `value = ""` — already flows through `writeMapped`, which wraps
      even an empty `value` in `/* atlcli:start:<path> */…/* atlcli:end:<path>
      */` source-map comment markers and pushes a (zero-width) source-map
      entry. `pageBreak`/`anchor`/`orientation` inherit that same, already-
      shipped behavior for free — this is precedent, not a gap. The
      consequence lands in the Tests task below: `main.typ` byte-identity
      to the same document without these blocks is **not** achievable
      (comment markers are real characters in `main.typ`, and inserting a
      block shifts every later sibling's array index, and therefore its
      `writeMapped` path/comment text, even though nothing about that
      sibling's own content changed) — assert semantic identity instead.
- [x] Extend the non-exhaustive recursive walks in the PDF engine with an
      `orientation` recursion (and a `""` result for `pageBreak`/`anchor`
      where a value is required): `blocksPlainText` (`serialize.ts:122`),
      `minHeadingLevel` (`serialize.ts:464`), `collectHeadingLabels`
      (`serialize.ts:488`), and `countPrepared`
      (`packages/pdf/src/run-export.ts:74`).
- [x] Run `bun run typecheck` at the repo root — the `never` checks in both
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

- [x] New `describe("storageToBlocks — lossless unknown macros")` with real
      storage fixtures:
      - a `drawio`-style macro with `ac:macro-id`, several plain-text
        `<ac:parameter>`s and no body → `params` (as `{ name, text }`
        entries) + `macroId` captured, `body`/`plainBody`/`bodyNotes`
        absent;
      - one fixture per structured reference shape actually produced by
        `markdown.ts` — `<ac:parameter><ri:page ri:content-id="…"/></…>`
        (`:310`), `<ri:attachment ri:filename="…"/>` (`:406`), `<ri:url
        ri:value="…"/>` (`:442`), `<ri:user ri:account-id="…"/>` (`:796`),
        and a `spaces`-style parameter with **two** sibling `<ri:space
        ri:space-key="…"/>` children (`:790`) — each captured as the
        matching `MacroParamRef` in `refs`, never as an empty/missing
        parameter (the regression the "Why not `Record<string, string>`"
        note in Architecture exists to prevent);
      - an unnamed parameter (`<ac:parameter ac:name="">…`, the
        `include`/`excerpt-include` shape) → captured with `name: ""`;
      - two parameters with the same name in different casing
        (`ac:name="Foo"` / `ac:name="foo"`) → both present in `params` as
        separate entries in document order (pins that `params` is an
        ordered array, not a deduplicating map);
      - a parameter whose text has leading/trailing whitespace → `text` is
        trimmed (mirrors `macroParam`'s existing behavior);
      - a macro with `<ac:rich-text-body>` containing a paragraph and a
        nested known macro → `body` is a walked `ExportBlock[]` **and**
        `notes` contains only the single outer `unknown-macro`/
        `macro-not-rendered` note (scratch-ctx regression test);
      - a macro with `<ac:rich-text-body>` containing a nested `<ac:image>`
        that has neither `ri:attachment` nor `ri:url` (unresolvable) →
        `body` omits the image (as `walkImage` already does) **and**
        `bodyNotes` contains the `image-unresolved` note that the scratch
        walk produced, while the top-level `notes` does **not** (proves the
        note is preserved on the block, not discarded, and not merged into
        the report — the `bodyNotes` regression test);
      - a macro with `<ac:plain-text-body><![CDATA[…]]>` → `plainBody`
        captured verbatim;
      - a bare `<ac:structured-macro ac:name="x"/>` → block equals
        `{ type: "unknown", macroName: "x" }` with no extra fields
        (backward-compat pin).
- [x] `macroParamText()` unit tests: returns the `text` of a matching
      parameter case-insensitively, `undefined` for a ref-only or absent
      parameter, and the first match when duplicate names exist (documents
      the convenience API's tie-breaking behavior for callers, e.g. 004's
      renderer registry, that only need simple string params).
- [x] Options test: `storageToBlocks(xml, { exporter: "pdf" })` and
      `storageToBlocks(xml)` return deeply-equal results for a fixture with
      mixed content (pins "no semantics before T1.4").
- [x] Review the updated snapshot
      (`packages/confluence/src/__snapshots__/export-blocks.test.ts.snap`):
      the only permitted diffs are **additive fields on `unknown` blocks**.
      Any other diff is a regression — reject it.
- [x] Compile-shape test constructing an `ExportBlock[]` literal containing
      `pageBreak`, `orientation` (with children), `anchor`, and captioned
      `codeBlock`/`table`/`image` — pins the public type shape hosts rely on.

Unit — mention resolution (`packages/confluence/src/resolve-mentions.test.ts`):

- [x] New test: an unresolved mention nested inside `{ type: "orientation",
      content: [...] }` is returned by `collectUnresolvedMentionIds` and gets
      its `displayName` filled by `resolveExportMentions` — regression for
      the new `orientation` recursion case.
- [x] New test: an unresolved mention inside a hand-built `caption?.content`
      on each of `codeBlock`, `image` and `table` (the walker does not emit
      captions until T1.4, so build the `ExportBlock[]` literal directly —
      same pattern as the compile-shape test above) is collected and
      resolved — regression for the caption-traversal case, and the reason
      it must land in T0 rather than wait for T1.4: without it, T1.4 could
      ship a caption-producing walker change that passes typecheck while
      silently leaving mentions unresolved in visible `scroll-title`
      captions, with no test anywhere catching it.
- [x] New **negative** test: an unresolved mention nested inside
      `{ type: "unknown", macroName, body: [...] }` is **not** returned by
      `collectUnresolvedMentionIds` and **not** touched by
      `resolveExportMentions` (`unresolved` count and returned `blocks` are
      unaffected) — pins that `unknown.body` traversal is deliberately out
      of scope for this PR (see the Model task above) and guards against a
      future edit accidentally wiring it in without updating
      `apps/extension/utils/pdf/run-export.ts`'s behavior contract at the
      same time. A bare `unknown` block without `body` remains a no-op
      (existing behavior unchanged).

Unit — DOCX engine (`packages/docx/src/serialize.test.ts` + golden):

- [x] New test: serialize a document containing the three new blocks plus
      captioned image/table/codeBlock through `serializeBlocks` with a
      minimal `SerializeContext`; assert (a) `pageBreak`/`anchor` contribute
      zero XML — output equals the same document without them, (b)
      `orientation` output equals its children serialized bare, (c) headings
      inside an `orientation` region still drive promotion
      (`computeHeadingOffset` regression), (d) zero notes added.
- [x] New test: an `orientation` region containing an image and a mermaid
      `codeBlock` — assert `ctx.images?.prefetch`/`ctx.diagrams?.prefetch`
      are invoked for the nested blocks (spy/fake port, not a mock of an
      HTTP or Confluence client), regression for the `prefetchBlocks`
      `orientation` case added in Engines above; without this, a future
      change to `prefetchBlocks`'s switch could silently stop prefetching
      images/diagrams inside a region and nothing but a slower serial fetch
      at render time would reveal it.
- [x] Golden pin: `packages/docx/src/golden.test.ts` must pass **unchanged —
      no recapture of `golden-extension-export.json`**. This is the
      engine-level proof that T0 changed nothing observable (same role the
      golden played for the spec-006 extraction).

Unit — PDF engine (`packages/pdf/src/{prepare,serialize}.test.ts`):

- [x] `prepare.test.ts`: prepare a document with an `orientation` region
      containing an attachment image (real bytes via the local
      `PdfAssetResolver` fixture pattern already used there — an in-memory
      resolver is a real implementation of the port, not an HTTP mock);
      assert the image inside the region is resolved into `assets` and
      `caption` fields survive `preparePdfDocument` on table/codeBlock/image.
- [x] `serialize.test.ts` (the PDF engine's golden-style suite — it pins
      `main.typ` content): assert a document with `pageBreak`/`anchor`/
      `orientation` produces `main.typ` **semantically identical** — equal
      after stripping every `/* atlcli:start:<path> */`/`/* atlcli:end:<path>
      */` source-map comment marker via regex — to the same document without
      these blocks; do **not** assert raw string equality (see the Engines
      task's note on `writeMapped`: comment markers are real characters, and
      array-index shifts change sibling paths even when sibling content is
      unchanged, so byte-identity is unreachable by design, not a bug to
      fix). Separately assert: `pageBreak`/`anchor` each still get their own
      zero-width `sourceMap` entry (consistent with the pre-existing
      `unknown`-block precedent — this is intentional, not a leak, and keeps
      `mapPdfDiagnostics` able to attribute a future Typst error to the
      right block); no `pdf-unknown-block` or other new notes.
- [x] New test: a heading nested inside an `orientation` region — assert
      `minHeadingLevel`/`collectHeadingLabels` see it (heading-offset
      promotion and an internal link resolving to the label), regression for
      the `orientation` cases added to those two walks in Engines above (no
      exhaustiveness check protects them from silently skipping a new
      container).
- [x] `run-export.test.ts`: `countPrepared` counts an image inside an
      `orientation` region (report `embeddedImages` regression).

E2E — real Confluence (profile `mayflower`, space `DOCSY`):

- [x] Compute the title once, up front:
      `atlcli-e2e-exportblock-model-<epoch-seconds>` — the
      `atlcli-e2e-<feature>-<timestamp>` convention
      `specs/export-expansion/011-quality-gates/PLAN.md` establishes for all
      live E2E resources (also followed by `specs/export-expansion/
      003-content-features/PLAN.md`). T0 runs its E2E before either of those
      plans lands, so this is the actual first user of the convention in
      merge order — use it rather than the static `"T0 ExportBlock no-op
      zoo"` title, both for consistency and to avoid title collisions across
      parallel/repeated runs in the shared `DOCSY` space. Adopt 011's shared
      `makeE2eTitle`/cleanup helper once it exists instead of inlining the
      timestamp logic.
- [x] Create the test page containing the affected macros. Author
      `/tmp/t0-zoo.md` with raw storage passthrough (the markdown→storage
      converter allows HTML/macro passthrough — `html: true` in
      `packages/confluence/src/markdown.ts:64`; verify the macros survive
      by fetching the page after create): body includes
      `<ac:structured-macro ac:name="scroll-pagebreak"/>`, a
      `scroll-landscape` macro with a rich-text body (wide table), a
      `scroll-title` macro wrapping an image, a `scroll-bookmark` macro, and
      a parameterized third-party-style macro (e.g. `drawio`, with several
      `<ac:parameter>`s and an `ac:macro-id`). Then:
      `bun run --cwd apps/cli src/index.ts wiki page create --space DOCSY --title "$TITLE" --body /tmp/t0-zoo.md --profile mayflower`
      — persist the created page id immediately (before any further step)
      and guard every step from here on with `try/finally` (or a shell
      `trap`) so the delete in the last bullet always runs, including on
      assertion failure; on a cleanup failure, print the page id prominently
      so it can be deleted manually.
- [x] Fetch the server-normalized storage and assert real capture — this is
      the step that actually exercises `macroId`/`params`/`body` against a
      live Cloud instance, which the no-op export below cannot do (both
      no-op serializers ignore those fields by design — see Engines):
      `bun run --cwd apps/cli src/index.ts wiki page get --id <pageId> --profile mayflower` (JSON output), extract `.page.storage`, and run it through
      `storageToBlocks` (a short one-off script or an E2E test file importing
      `@atlcli/confluence`). Assert the `drawio`-style macro's `unknown`
      block has a non-empty `macroId`, `params` containing at least the
      parameters authored above (with real `ri:*` refs surviving as `refs`
      where applicable — Cloud may normalize the referenced storage; if a
      real fixture shows different casing/attribute names than assumed, only
      the walker's `MacroParamRef` recognition changes, not this test's
      shape), and `body` present for the `scroll-landscape` macro's
      rich-text body.
- [x] Export the page with the ts engine and assert **today's behavior**:
      `bun run --cwd apps/cli src/index.ts wiki export <pageId> --engine ts -o /tmp/t0-zoo.docx --profile mayflower`
      — `apps/cli/src/commands/export.ts:873–890`'s `output()` call already
      emits the full JSON report to stdout by default, no extra flag needed;
      capture stdout to a file for both runs. The DOCX opens, `scroll-*` and
      `drawio` macros render as today's placeholder paragraphs (`[<name>
      macro not rendered]`), and the report, **after normalizing away
      run-to-run-variable fields**, is empty-diff against a pre-change run of
      the same command on `main`. The CLI report (`export.ts:879–887`) is
      `{ resolvedCount, unsupportedNames, embeddedImages, renderedDiagrams,
      skippedImages, durationMs, notes: string[] }` — `notes` is already
      flattened to `"<level>: <message>"` strings (no separate `code`/
      `macroName` fields survive to this layer), and one note is always the
      `perf-timing` line (`packages/docx/src/export.ts:355`,
      `"info: Timing: <n> ms total — …"`) embedding concrete, run-varying
      millisecond values. Normalize before comparing: drop `durationMs`,
      drop the one `notes` entry matching `/^info: Timing: \d+ ms total/`,
      sort `unsupportedNames` and the remaining `notes`, and diff the rest
      (plus the top-level `output` path, which varies by tmp dir — drop it
      too). Document this normalization step inline in the E2E notes so it
      is reproducible, not ad hoc. PDF has no CLI command until T3.1/T3.2 —
      the PDF no-op proof at sync point 0 is the unit/`main.typ` pin above;
      note this limitation in the PR description.
- [x] Cleanup (workflow rule, guaranteed by the `try/finally`/`trap` above):
      delete the test page —
      `bun run --cwd apps/cli src/index.ts wiki page delete --id <pageId> --confirm --profile mayflower`
      (`--confirm` or `--dry-run` is required by `page.ts`'s delete handler;
      omitting it fails with a usage error before anything is deleted) — and
      verify with `wiki page get --id <pageId>` that it is gone.

## Definition of Done

- [x] `bun run typecheck` and `bun test` green at the repo root; both
      engines' exhaustive `never` checks compile with the new variants
      handled.
- [x] `packages/docx/src/golden.test.ts` passes **without recapturing**
      `golden-extension-export.json`; PDF `serialize.test.ts` expectations
      pass without loosening existing assertions.
- [x] Walker snapshot diffs are limited to additive optional fields on
      `unknown` blocks; `storageToBlocks(...).notes` output is proven
      unchanged by tests.
- [x] No new `ExportNote` codes, no changed note messages, no new public API
      surface beyond: `Caption`, `CaptionKind`, `MacroParamRef`,
      `MacroParameter`, `macroParamText`, `StorageToBlocksOptions`, the
      new/extended `ExportBlock` variants, and the widened `storageToBlocks`
      signature — all exported through `index.ts` **and** `index.browser.ts`
      (existing `export *`).
- [x] Macro-parameter capture is verified lossless against every structured
      reference shape `markdown.ts` actually produces (`ri:page`,
      `ri:attachment`, `ri:url`, `ri:user`, `ri:space`, including the
      multi-`ri:space` `spaces` parameter) plus unnamed parameters,
      duplicate/case-colliding names, and whitespace — no parameter is
      silently omitted because its value lived in element attributes rather
      than text.
- [x] `resolveExportMentions` (`packages/confluence/src/resolve-mentions.ts`)
      resolves mentions nested inside `orientation.content` and inside
      `caption?.content` on `codeBlock`/`image`/`table`, proven by the new
      `resolve-mentions.test.ts` cases — every container type this repo's
      `ExportBlock` model can hold `InlineNode`/`ExportBlock` content in is
      reachable by mention resolution after this PR, **except** `unknown.body`
      which is deliberately deferred to Lane E (T1.7) and pinned by the new
      negative test — not a gap, a scoping decision recorded here and in
      Risks.
- [x] Scratch-walked notes for `unknown.body` are never permanently lost:
      either they never occur (empty scratch walk) or they land in
      `bodyNotes` on the block — `storageToBlocks(...).notes` (the top-level
      report) still stays exactly as today, proven by the `bodyNotes`
      regression test.
- [x] `forkWalkCtx` is the only way a scratch `WalkCtx` is constructed
      anywhere in `export-blocks.ts` (no hand-built `{ notes: [] }` literal
      that would silently drop `exporter` or a future `WalkCtx` field).
- [x] E2E run against DOCSY performed under the
      `atlcli-e2e-exportblock-model-<timestamp>` naming convention with
      guaranteed cleanup (`try/finally`/`trap`); the E2E independently fetches
      real Cloud storage and asserts `macroId`/`params`/`body` capture (not
      just no-op export parity — the no-op serializers ignore those fields
      by construction and cannot prove capture on their own); the DOCX
      before/after CLI report diff is empty **after** the documented
      `durationMs`/`perf-timing`-note normalization; test page deleted and
      deletion verified.
- [x] One PR, conventional commit style
      (`feat(confluence): extend ExportBlock model …` +
      `feat(docx,pdf): compile no-op renderings …`), merged before any lane
      branch is cut; lanes rebase on it.

## Risks & open questions

- **`params` deviates from BASELINE-DESIGN §5's `Record<string, string>`
  sketch — cross-plan impact on 004-macro-renderer.** BASELINE-DESIGN.md
  (§5, prerequisite block) and `specs/export-expansion/004-macro-renderer/
  PLAN.md` (`MacroInstance.params: Record<string, string>`, and dozens of
  `params.<name>` string-indexed reads throughout its E2/E3/E4 tasks) both
  assume the flat shape. This plan replaces it with `MacroParameter[]`
  because the flat shape is provably lossy for real storage (see
  Architecture, "Why not `Record<string, string>`") — `elementText()` reads
  `ri:page`/`ri:attachment`/`ri:url`/`ri:user`/`ri:space` parameters as
  empty strings, and the capture task omits empty fields, so e.g. `include`,
  `excerpt-include`, `multimedia`, `widget`, and `blog-posts`' `author`/
  `spaces` parameters would silently vanish from `params` — exactly the
  macros Lane E most needs parameter data for. The `macroParamText()`
  convenience export keeps simple string lookups (`params.jqlQuery`-style
  reads that 004 assumes for plain-text parameters) working with a
  mechanical `macroParamText(m.params, "jqlQuery")` rewrite; reads that need
  a `ri:*` reference instead (e.g. `include`'s unnamed page-ref parameter,
  or `params.page`/`params.spaceKey` as used in 004's T1.10-adjacent text)
  need a `refs`-based rewrite. **004-macro-renderer's `PLAN.md` needs a
  follow-up pass to adopt this shape** before its tasks are implemented —
  flagged for the orchestrator, not resolved here (004's file is out of
  scope for this review).
- **`unknown.body` mention resolution is deferred to Lane E, not shipped
  here.** An earlier draft of this plan wired `resolve-mentions.ts` to
  recurse into `unknown.body` in T0. That would have been a real behavior
  change on landing: `apps/extension/utils/pdf/run-export.ts` already calls
  `resolveExportMentions` unconditionally on every walked block, and
  `unknown.body` is populated unconditionally by the capture task — so any
  mention buried in a macro body nobody renders yet would start triggering
  live `getUsersBulk` lookups (and possibly a new-looking
  `pdf-mention-unresolved`/`pdf-mention-resolution-failed` note) purely from
  this PR landing, contradicting "no user-visible feature ships here."
  Fixed by scoping T0's resolver-switch task to `orientation`/`caption`
  only and adding a negative regression test. Lane E (T1.7) is the right
  owner: once a macro renderer turns `body` into visible output, resolving
  mentions inside it is no longer wasted/observable-changing work.
- **Scratch-ctx decision for `unknown.body` notes.** Walking a rich-text
  body can encounter nested macros/images that would push notes.
  Discarding those notes outright (an earlier draft's design) kept the
  top-level report byte-identical but made the claim "the T1.7 resolver
  pass re-walks and re-reports when it renders body blocks" false for
  content that leaves no trace at all once discarded — e.g. `walkImage`
  drops an unresolvable nested `<ac:image>` from `body` entirely, so there
  is nothing left for a later pass to re-walk. Fixed by collecting scratch
  notes into `bodyNotes` on the `unknown` block instead of discarding them:
  the top-level report still stays byte-identical (T0 contract preserved),
  but the observation survives on the block for Lane E to promote when it
  actually renders that content — consistent with the plan's own "never
  silently drop" principle. Revisit in Lane E once the resolver's own note
  model is designed; `bodyNotes` may fold into it rather than staying a
  permanent field.
- **`ac:macro-id` presence.** The attribute is present in Cloud storage but
  the field stays optional and the E2E zoo page's storage-fetch step (Tests)
  verifies capture against a real instance. If a real fixture shows a
  different casing/name, only the walker line changes.
- **`orientation` renders portrait until T1.5.** The transparent no-op means
  a `scroll-landscape` region exported between T1.4 and T1.5 renders its
  content in portrait — acceptable (identical to today's behavior for that
  content) and the reason T1.5 lists T1.4 + T0.2 as prerequisites.
- **`PreparedPdfBlock` passthrough is implicit.** `pageBreak`/`anchor` reach
  the PDF serializer via the `Exclude<…>` passthrough in `types.ts:36`; a
  future variant with children must remember to re-declare (as `orientation`
  does here). Mitigation: the exhaustive switch in `prepare.ts` fails to
  compile if someone forgets the walk arm.
- **PDF `main.typ` transparency is semantic, not byte-identical.** Every
  `serializeBlock` branch (including the pre-existing `unknown` arm) is
  wrapped by `writeMapped`'s source-map comment markers, and those markers
  embed the block's array-index path — so inserting/removing a no-op block
  shifts every later sibling's path text even though the sibling's own
  content is unchanged. Byte-identity between "with no-ops" and "without
  no-ops" `main.typ` is therefore unreachable by design; the Tests task
  normalizes by stripping the comment markers before comparing. Not a defect
  to fix — matches the pre-existing `unknown`-block precedent.
- **Open: include `explicitAnchor?` on `heading` now?** BASELINE-DESIGN
  (cluster A foundation) wants `heading.explicitAnchor` for chapter anchors;
  UMSETZUNGSPLAN scopes it to Lane A (T1.1) but it lives in the same hot
  file. Recommendation: add the optional field in this PR (two lines, no
  behavior) to spare `export-blocks.ts` a fourth landing — decide at review.
- **Open: should the DOCX host pass `{ exporter: "word" }` here or in
  T1.4?** This plan wires it now (pure plumbing, no semantics); if review
  prefers zero cross-package edits, drop that task and let Lane C do it.

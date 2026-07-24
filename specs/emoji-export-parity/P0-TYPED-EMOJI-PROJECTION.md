# P0 — Typed emoji projection for DOCX and PDF

Status: active implementation

Baseline: `5876348343c5805c3424eea5d516a8c937b4f6f5`

## 1. Outcome

Known Confluence legacy emoji must not appear as literal `:name:` text in
TypeScript DOCX or Typst/PDF when the source carries typed emoji semantics.

The shared source layer shall deterministically resolve:

```text
typed ADF emoji / Storage ac:emoticon / custom-panel icon
        |
        |-- usable non-colon Unicode text ---------------- preserve exactly
        |-- known canonical short name or alias ---------- portable projection
        `-- unknown/site-custom short name --------------- visible text + note
```

Both engines continue to consume the same `ExportBlock[]`/`InlineNode[]`.
Neither renderer gets its own shortcode parser.

## 2. Verified root cause

- The pinned ADF schema requires only `emoji.attrs.shortName`; `text` is
  optional.
- `adfToBlocks()` and `storageToBlocks()` currently choose non-empty source
  text, otherwise the short name. A colon-shaped result emits
  `emoji-text-fallback` but remains visible unchanged.
- `@atlcli/docx` and `@atlcli/pdf` serialize the selected text run and do not
  interpret `EmojiSemantics`.
- Markdown authoring has a separate catalog of 22 canonical legacy names and
  26 aliases. That catalog is not reused by export.
- A custom panel separately chooses `panelIconText || panelIcon`; unresolved
  short names are not diagnosed when `panelIcon` is present.

This is a shared projection defect exposed by the ADF-primary pipeline, not a
Typst escaping defect.

## 3. Scope

### In scope

- One browser-safe canonical emoji catalog in `@atlcli/confluence`.
- The existing 22 canonical Markdown names and 26 aliases.
- A deterministic portable projection for every canonical name.
- Shared normalization used by Markdown authoring, ADF decoding, Storage
  decoding, and custom-panel decoding.
- Confluence Data Center compatibility through the shared Body Storage
  `ac:emoticon` contract wherever the source provides a supported canonical
  name or alias.
- Exact preservation of already usable Unicode, including variation selectors,
  skin-tone modifiers, ZWJ sequences, and flags.
- Exact preservation does not claim that every recipient font can shape every
  arbitrary source-provided sequence. The rendered guarantee applies to the
  reviewed canonical projection table; arbitrary source Unicode is a
  losslessness guarantee.
- Typed diagnostics for unresolved short names.
- PDF glyph coverage against bundled, checksummed fonts.
- DOCX preserves the selected Unicode and is accepted against the recorded
  Microsoft Word and LibreOffice baselines. P0 does not add font embedding; a
  candidate that depends on an unverified recipient-only glyph is not a
  portable projection and blocks P0.1.
- Unit, serializer, background-job, packed-browser, and rendered-golden proof.
- Documentation and ADF gap-register updates.

### Out of scope

- Reinterpreting arbitrary text nodes that happen to match `:name:`.
- Fetching emoji assets from undocumented Atlassian endpoints.
- Resolving site-custom emoji IDs to network assets.
- Adding default icons to ordinary `info`/`warning`/`tip` callouts; P1 owns that.
- Color emoji or pixel parity with the Confluence editor.
- The retired Python DOCX exporter.
- A live Data Center certification run: no DC instance is available in the
  configured environment, so P0 proves the DC-relevant Body Storage contract
  exhaustively and keeps the live acceptance run on DOCSY Cloud.

## 4. Target contract

Add a target-neutral module, expected at
`packages/confluence/src/emoji-projection.ts`, with an explicit contract similar
to:

```ts
export interface PortableEmojiProjection {
  canonicalName: string;
  text: string;
}

export type EmojiProjectionResult =
  | { kind: "source-text"; text: string }
  | { kind: "known"; text: string; projection: PortableEmojiProjection }
  | { kind: "unresolved"; text: string };

export function normalizeEmojiShortName(value: string): string | undefined;

export function projectTypedEmoji(input: {
  shortName: string;
  sourceText?: string;
}): EmojiProjectionResult;
```

Contract rules:

1. A non-empty, non-colon-shaped `sourceText` wins byte-for-byte.
2. Missing, empty, or colon-shaped source text may be resolved only through the
   canonical typed catalog. The typed `shortName` is authoritative; a
   colon-shaped `sourceText` naming a different known emoji is retained as
   provenance but never overrides it.
3. Canonical names and aliases are matched case-insensitively after stripping
   exactly one surrounding colon pair.
4. Unknown/custom names return the exact short name and retain
   `emoji-text-fallback`.
5. Plain ADF/Storage text never calls this resolver.
6. Markdown alias normalization consumes the same catalog and never maintains a
   second list.
7. The catalog is immutable and exhaustively tested: every alias points to one
   canonical entry; duplicate names and aliases fail tests.
8. For Storage, `ac:emoji-shortname` is authoritative when present;
   `ac:name` is normalized only when the short-name attribute is absent.

The exact projection table is code-reviewed in P0.1. All 22 canonical entries
must have semantically distinguishable projections. In particular, the four
legacy star colors may not collapse to the same output. If any entry has no
defensible projection that passes the PDF and recorded DOCX baselines, P0.1
stops and remains unchecked.

`EmojiSemantics` becomes:

```ts
export interface EmojiSemantics {
  shortName: string;        // exact authoritative source identity
  id?: string;              // exact optional service identity
  text?: string;            // exact optional source display text
  renderedFrom: "source-text" | "catalog-projection" | "short-name";
  projection?: PortableEmojiProjection;
}
```

The visible `InlineNode.text` is always the actual serialized text. A
`catalog-projection` state requires `projection`, and `InlineNode.text` must
equal `projection.text`. A `source-text` state has no projection and preserves
`EmojiSemantics.text` exactly. A `short-name` state has no projection and
preserves the exact authoritative short name. PDF and DOCX serialize
`InlineNode.text`; they may inspect the metadata for tests/reporting but never
re-resolve it.

Custom-panel source fields remain exact. A resolved catalog value is carried
separately as `panelIconProjection?: PortableEmojiProjection`. Renderer
precedence is:

```text
non-empty panelIconText
  -> non-colon panelIcon (portable text, exact)
    -> panelIconProjection.text
      -> unresolved colon panelIcon (exact + adf-node-degraded)
        -> no icon
```

An empty `panelIconText` does not suppress the remaining chain. A standard
panel carrying an explicit source icon follows this same chain; P1 may add a
semantic default only after the entire explicit-source chain.

## 5. Commit-sized implementation tasks

- [x] **P0.1 — Establish the shared catalog and pure projection contract.**
  Create the browser-safe catalog/module, move the 22 canonical names and 26
  aliases out of `markdown.ts`, define deterministic projections, and add
  exhaustive pure tests. Prove that usable Unicode is preserved, raw text is
  outside the API, all projections remain distinguishable where their canonical
  semantics differ, and the candidate table compiles into one PDF font-coverage
  probe without missing-glyph diagnostics.

  Verification:

  ```bash
  bun run test packages/confluence/src/emoji-projection.test.ts packages/confluence/src/markdown.test.ts
  bun run test packages/pdf-compiler-browser/src/emoji-font-coverage.test.ts packages/docx/src/emoji-font-coverage.libreoffice.test.ts
  bun run test scripts/api-report.test.ts
  bun run check:browser
  bun run typecheck
  ```

  Evidence (2026-07-24):

  - All 22 canonical projections and all 26 aliases pass exhaustive contract
    tests; the combined regression run reports 244 passing and zero failing
    tests.
  - One real Typst WASM compilation with all pinned production fonts covers
    every projection without diagnostics and produces a valid tagged PDF.
  - One generated DOCX containing all projections survives headless
    LibreOffice conversion and PDF text extraction; the installed Microsoft
    Word for Mac also renders all 22 rows without tofu or missing glyphs.
  - The API-report guard, browser-isomorphism check, and workspace typecheck
    pass.
  - A read-only live export of DOCSY page `1126236245` completes as both DOCX
    and PDF with exit code zero and no warnings or errors. It creates no remote
    test resource, so no cleanup is required.

  Commit: `feat(confluence): define typed emoji projections`

- [x] **P0.2 — Apply the contract to ADF and Storage emoji nodes.**
  Route only typed `emoji`/`ac:emoticon` nodes through the shared projection.
  Materialize the exact `EmojiSemantics` state machine above. Retain
  `emoji-text-fallback` only for unresolved values. Add regression cases for
  missing, empty, colon-shaped, Unicode, alias, unknown/custom, literal text,
  a conflicting known `sourceText`, and conflicting Storage
  `ac:emoji-shortname`/`ac:name`. Exercise all 22 canonical names and all 26
  aliases through both ADF and the DC-relevant Body Storage adapter.

  Verification:

  ```bash
  bun run test packages/confluence/src/adf-to-blocks.test.ts packages/confluence/src/export-blocks.test.ts packages/confluence/src/adf-direct-fixtures.test.ts
  bun run test scripts/api-report.test.ts
  bun run check:adf-pinned
  bun run typecheck
  ```

  Evidence (2026-07-24):

  - The ADF and Body Storage integration matrices each cover all 22 canonical
    names and all 26 aliases. They also pin missing, empty, colon-shaped,
    conflicting, exact-Unicode, literal-text, unknown/custom, and invalid-empty
    states.
  - The focused regression run reports 273 passing and zero failing tests. The
    generated API report, five API-surface guards, pinned ADF drift check, full
    workspace typecheck, fresh build, and `git diff --check` pass.
  - The Body Storage tests use real `ac:emoticon` XML and prove that explicit
    `ac:emoji-shortname` wins over `ac:name`. This is the shared Cloud/DC
    contract proof; it is not presented as a live DC certification.
  - A synthetic DOCSY page
    `atlcli-e2e-emoji-p02-1784878868` (page `1140686885`) exported successfully
    as DOCX and PDF. Extracted text contains the warning symbol, preserves
    literal `:warning:` and unresolved `:custom-party:`, and reports exactly one
    expected fallback. Every rendered DOCX/PDF page was visually checked
    without tofu, clipping, or overlap.
  - Cleanup is proven: the page was deleted in the guarded cleanup path and a
    subsequent page lookup returned not found.

  Commit: `fix(confluence): resolve typed emoji short names`

- [ ] **P0.3 — Reuse the projection for custom-panel icons and both serializers.**
  Prefer valid `panelIconText`, otherwise resolve a known typed `panelIcon`.
  Preserve a non-colon `panelIcon` exactly. Unknown/custom colon short names
  stay visible and emit the stable `adf-node-degraded` code with ADF path
  provenance. Add PDF and DOCX assertions for known, explicit-text,
  non-colon Unicode, unknown, ID-only, and standard-panel explicit icons. Prove
  serializers do not independently parse raw colon text.

  Verification:

  ```bash
  bun run test packages/confluence/src/adf-to-blocks.test.ts packages/docx/src/serialize.test.ts packages/pdf/src/serialize.test.ts
  bun run typecheck
  ```

  Commit: `fix(export): project typed custom panel icons`

- [ ] **P0.4 — Prove packed-browser and real-render fidelity.**
  Extend the ADF conformance source with a known emoji lacking usable Unicode,
  a known colon-valued fallback, an unresolved custom emoji, and a custom panel
  without `panelIconText`. Prove direct/background PDF and DOCX parity, update
  the rendered-golden source hash and reviewed images, and inspect the real
  outputs for tofu, clipping, overlap, and leaked known short names. The
  conformance fixture includes all 22 canonical projections, all 26 supported
  aliases, plus representative preserved sequences (variation selector, skin
  tone, ZWJ, and flag).

  Verification:

  ```bash
  bun run check:browser
  bun run typecheck:browser-export-harness
  bun run build:browser-export-harness
  bun run check:browser-export-harness
  bun run test:browser-export-harness
  bun run update:adf-rendered-goldens
  # Visually review every regenerated PDF and DOCX PNG before continuing.
  bun run check:adf-rendered-goldens
  ```

  Expected artifact assertions:

  - known typed emoji are visible as symbols in DOCX and PDF;
  - known short names do not occur in extracted artifact text;
  - unresolved custom short names remain visible;
  - direct and background artifacts and reports remain equal;
  - no missing-glyph/tofu box appears in reviewed renders.

  Commit: `test(export): prove emoji artifact parity`

- [ ] **P0.5 — Align docs, gap accounting, and aggregate gates.**
  Replace the stale supported-emoticon table with the canonical catalog,
  document the typed-vs-literal boundary, update the ADF coverage/gap register,
  and record the remaining custom-emoji/font limitations. Run the full
  regression and browser gates. Perform the required `mayflower`/`DOCSY` live
  export for both formats, retain only redacted evidence, and delete the
  synthetic test page/resources. The final DOCSY fixture and both downloadable
  artifacts enumerate all 22 canonical notations and all 26 aliases with an
  explicit input label, graphical expected output, literal-known negative
  control, and unknown-custom negative control.

  Verification:

  ```bash
  bun run test
  bun run typecheck
  bun run build
  bun run check:browser
  bun run docs:check
  git diff --check
  ```

  Live acceptance:

  - create `/tmp/atlcli-emoji-export-parity.md` with a unique
    `atlcli-e2e-emoji-export-parity-<epoch-seconds>` title and raw Storage
    `ac:emoticon` cases for a built-in, literal colon text, and one unresolved
    custom emoji;
  - create it with
    `bun run --cwd apps/cli src/index.ts wiki page create --space DOCSY
    --title <title> --body /tmp/atlcli-emoji-export-parity.md
    --profile mayflower`, persist the returned page ID immediately, and guard
    all later steps with `try/finally`;
  - export with
    `bun run --cwd apps/cli src/index.ts wiki export <pageId> --format pdf
    --profile mayflower -o /tmp/atlcli-emoji-export-parity.pdf --report json`
    and
    `bun run --cwd apps/cli src/index.ts wiki export <pageId> --format docx
    --engine ts --profile mayflower -o
    /tmp/atlcli-emoji-export-parity.docx --report json`;
  - confirm built-ins render graphically, literal text remains literal, and the
    custom emoji is diagnosed;
  - in `finally`, run
    `bun run --cwd apps/cli src/index.ts wiki page delete --id <pageId>
    --confirm --profile mayflower`, then prove
    `wiki page get --id <pageId> --profile mayflower` fails as not found.

Pre-commit live gate for every P0 task:

- P0.1 performs a read-only DOCX/PDF smoke export of a DOCSY page selected by
  `wiki page list --space DOCSY --profile mayflower --json`; record the page ID
  and both successful artifact validations. This task does not wire the new
  catalog into production yet.
- P0.2 through P0.5 run the synthetic create/export/inspect/delete protocol
  above. Expectations advance with the task, but cleanup is mandatory even on
  assertion failure.

  Commit: `docs(export): document typed emoji parity`

## 6. Required test matrix

| Source | Input | Expected visible output | Note |
|---|---|---|---|
| ADF emoji | `shortName=:warning:`, no `text` | portable warning symbol | none |
| ADF emoji | `shortName=:warning:`, `text=""` | portable warning symbol | none |
| ADF emoji | `shortName=:warning:`, `text=:warning:` | portable warning symbol | none |
| ADF emoji | `shortName=:warning:`, `text=:smile:` | portable warning symbol | none |
| ADF emoji | `shortName=:warning:`, `text=⚠️` | exact `⚠️` | none |
| ADF emoji | known alias | canonical portable symbol | none |
| ADF emoji | unknown/custom | exact short name | `emoji-text-fallback` |
| Storage emoticon | known `ac:name`, no fallback | portable symbol | none |
| Storage emoticon | Unicode fallback | exact fallback | none |
| Storage emoticon | conflicting short-name/name | short-name projection | none |
| Storage emoticon | unknown/custom | exact short name | `emoji-text-fallback` |
| ADF text | literal `:warning:` | literal `:warning:` | none |
| Custom panel | known `panelIcon`, no text | portable symbol | none |
| Custom panel | Unicode `panelIcon`, no text | exact Unicode | none |
| Custom panel | unknown `panelIcon`, no text | exact short name | degradation |
| Standard panel | explicit source icon | explicit source icon | source-dependent |

## 7. Stop conditions

Stop and report instead of improvising if:

- a canonical legacy name has no defensible portable projection;
- a chosen symbol is absent from the pinned PDF runtime fonts;
- guaranteeing the DOCX glyph requires licensing or embedding changes not
  covered by the existing OFL font policy;
- the active Confluence payload proves `shortName` does not identify the
  intended standard emoji;
- resolving an alias would require interpreting ordinary text rather than typed
  emoji metadata;
- rendered-golden review shows a projection that is materially misleading.

## 8. Definition of done

P0 is complete only when every P0 checkbox is checked with evidence, every
checked task has its own pushed commit under the explicit authorization for
this branch, the draft PR contains all task commits, the live resources are
cleaned up, and known typed short names no longer leak into either artifact.

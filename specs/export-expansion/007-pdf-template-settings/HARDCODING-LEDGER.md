# Hardcoding ledger (lite) — `packages/pdf/src/template.ts`

Dated: 2026-07-19. Folder `specs/export-expansion/007-pdf-template-settings`,
task **T2.5**.

## What this is

Folder 007 migrated a handful of Level-A values out of `template.ts`'s
hardcoded literals into settings (page geometry, section toggles,
header/footer text, accent color, organization name, logo, watermark).
**Everything else in `template.ts` stays hardcoded on purpose** — that full
design-token migration is `012-pdf-template-migration/PLAN.md`'s scope, not
this folder's.

This file is a **restatement** of what is deliberately left hardcoded after
007 lands — not new scope, not a migration. It is produced mechanically from a
line-by-line read of `packages/pdf/src/template.ts` (state after T2.1–T2.4)
so that **`012` starts from this inventory instead of re-deriving it by
re-reading the template**. `012-pdf-template-migration/PLAN.md` is the direct
consumer: its Reference section names this file as the migration inventory it
inherits.

Line numbers reference `packages/pdf/src/template.ts` as of 2026-07-19. They
are advisory (the file will drift); the values are the durable record.

The companion lint stub `packages/pdf/scripts/check-hardcoding-ledger.ts`
treats **this file as its single source of truth**: every hex color, font
family, and `pt`/`mm`/`em` length literal below appears in a backtick code
span, and the lint fails if `template.ts` grows a token that is not recorded
here (and not on its narrow engine-structural allowlist). Adding a new
hardcoded value therefore means adding a row here first.

## Legend

- **Settings-driven default** — the literal is only a fallback; the value is
  overridable through `PdfTemplateSettings` (see `pdf-template-settings.md`).
  It is still recorded here because the *default* remains hardcoded.
- **Theme-derived** — the literal lives in `packages/pdf/src/theme.ts` and
  reaches `template.ts` through a `${theme.colors.*}` interpolation, so it is
  **not** a bare literal in the template source (the lint does not see it), but
  it is part of `012`'s migration surface and recorded for completeness.

## Fonts / faces

| Value | Role | Lines |
|-------|------|-------|
| `Source Serif 4` | Body copy; cover title; closing-page title | 109, 204, 238 |
| `Source Sans 3` | Headings, list markers, header/footer, table cells, cover/closing structural text, callout body, task marker, watermark, ordered-list numbering | 51, 65, 118, 119, 120, 140, 152, 169, 173, 177, 188, 196, 233, 280, 355 |
| `Source Code Pro` | Code / raw blocks; status badges | 185, 290, 339 |

Bundled font set and pinning live in `pdf-engine.md`; the family *names* above
are the template-level hardcoding.

## Color tokens (bare hex literals)

| Value | Role | Lines | Notes |
|-------|------|-------|-------|
| `#4B57A3` | Accent / Editorial Indigo (cover eyebrow + rule, closing accents) | 87 | **Settings-driven default** (`accent-color`) |
| `#DE350B` | Watermark text color | 69 | **Settings-driven default** (`watermark.color`) |
| `#202A44` | Local `ink` — cover/closing title + metadata values | 99 | Distinct from the theme `ink` |
| `#74727A` | `warm-slate` — metadata rail labels | 100 | |
| `#6B778C` | Muted / subtle — numbering, list markers, running header, footer, unchecked task marker | 54, 118, 119, 120, 140, 152, 359 | |
| `#DFE1E6` | Running-header hairline stroke | 147 | |
| `#253858` | Heading level-3 fill | 177 | |
| `#F4F5F7` | Code-block background; callout `panel` background | 181, 268 | |
| `#0052CC` | Checked task marker | 359 | |

### Semantic palette — callouts (lines 263–269)

| Kind | Background | Foreground |
|------|-----------|-----------|
| info | `#DEEBFF` | `#0747A6` |
| note | `#EAE6FF` | `#403294` |
| warning | `#FFFAE6` | `#974F0C` |
| tip | `#E3FCEF` | `#006644` |
| panel | `#F4F5F7` | `#42526E` |

### Semantic palette — status badges

| Value | Role | Lines |
|-------|------|-------|
| `#42526E` | Default badge color (`status-badge`, `dense-status-badge`), callout `panel` foreground | 268, 286, 322 |

### Theme-derived colors (in `theme.ts`, not bare in `template.ts`)

| Value | Role | Source |
|-------|------|--------|
| `#172B4D` | Body text fill; heading level-1 / level-2 fill | `theme.ts:6` (`colors.ink`) via `${theme.colors.ink}` at template lines 111, 169, 173 |
| `#FCFBF8` | Cover / closing-page paper fill (`cover-paper`) | `theme.ts:7` (`colors.paper`) via `${theme.colors.paper}` at template line 101 |

## Typography — sizes & weights

| Role | Size | Weight | Lines |
|------|------|--------|-------|
| Body text | `10pt` | regular | 110 |
| Heading 1 | `18pt` | semibold | 169 |
| Heading 2 | `14pt` | semibold | 173 |
| Heading 3 | `11.5pt` | semibold | 177 |
| Raw / code block | `8.5pt` | regular | 185 |
| Table cell | `9pt` | regular | 188 |
| Ordered-list numbering | `0.95em` | semibold | 49, 51 |
| Running header / footer | `8pt` | regular | 140, 152 |
| Cover eyebrow (space label) | `8pt` | semibold | 200 |
| Cover title | `31pt` | semibold | 204 |
| Cover metadata label | `7.5pt` | semibold | 213, 215, 217 |
| Cover metadata value | `9.5pt` | regular | 214, 216, 218 |
| Closing eyebrow (`END OF DOCUMENT`) | `8pt` | semibold | 234 |
| Closing title | `24pt` | semibold | 238 |
| Closing metadata label | `7.5pt` | semibold | 247, 249, 251 |
| Closing metadata value | `9.5pt` | regular | 248, 250, 252 |
| Closing colophon line | `8.5pt` | regular | 255 |
| Status badge | `7.5pt` | bold | 290, 339 |
| Task marker | `8.5pt` | semibold | 355 |
| Watermark | `96pt` | bold | 68 (**settings-driven default** `watermark.size`) |

Tracking (letter-spacing) literals: `0.12em` (cover eyebrow, 200), `0.08em`
(metadata labels, 213/215/217/247/249/251), `0.14em` (closing eyebrow, 234).

## Page margins

| Value | Role | Line |
|-------|------|------|
| top `23mm`, bottom `20mm`, left `22mm`, right `22mm` | Page margin box | 134 |

## Component spacing

| Component | Values | Lines |
|-----------|--------|-------|
| Paragraph | leading `0.74em`, spacing `10pt` | 115 |
| List | body-indent `0.7em`, spacing `8pt` | 122, 123 |
| Enum | body-indent `0.7em`, spacing `8pt` | 127, 129 |
| Heading 1 block | above `28pt`, below `14pt` | 170 |
| Heading 2 block | above `24pt`, below `12pt` | 174 |
| Heading 3 block | above `18pt`, below `8pt` | 178 |
| Code block | inset `9pt`, radius `4pt` | 182, 183 |
| Callout | inset x `11pt` / y `9pt`, radius `4pt`, above `6pt`, below `8pt` | 275, 277, 278, 279 |
| Status badge | inset x `5pt` / y `2pt`, radius `3pt` | 286, 287, 288 |
| Dense status badge (fallback) | inset x `1pt` / y `2pt`, radius `3pt`, leading `0.72em`, width `available-width - 2pt` | 333, 335, 336, 345 |
| Task item | grid columns `1.05em` / `1fr`, column-gutter `0.45em` | 352, 353 |
| Dense-table threshold | `18mm` (one-track dense-table boundary) | 297, 300 |

## Cover / header / footer / closing-page offsets

| Location | Values | Lines |
|----------|--------|-------|
| Cover | top pad `37mm`, block width `90%`, logo box height `12mm` / width `45mm`, `17pt`, `25pt`, rule length `52mm` stroke `0.9pt`, `23pt`, grid columns `30mm` / `1fr` gutter `12pt` row `8pt` | 194, 195, 198, 201, 206, 207, 208, 210 |
| Running header | hairline length `100%`, stroke `#DFE1E6` | 147 |
| Closing page | top pad `57mm`, block width `82%`, `14pt`, `22pt`, rule `52mm` stroke `0.9pt`, `22pt`, grid `30mm` / `1fr` gutter `12pt` row `8pt`, `24pt` | 231, 232, 236, 240, 241, 242, 244, 254 |

Cover paragraph leading `0.98em` (203) and closing paragraph leading `1.02em`
(237) are the title-block leading overrides.

## Engine-structural values (deliberately NOT ledgered)

These are structural, not presentation, and are on the lint's inline
allowlist rather than recorded above:

- Paper catalog names `a4` / `us-letter` (97, 98) — page geometry, already
  settings-driven; not a color/spacing token.
- Unit-conversion multipliers: `* 1pt` (68) and `* 1deg` (64) that turn a
  numeric setting into a Typst length/angle.
- Layout ratios that are not `pt`/`mm`/`em` lengths: `1fr` grid fractions,
  `100%` / `90%` / `82%` block widths, `depth: 3` outline depth,
  percentage-based `transparentize` math.

## Consumer

`012-pdf-template-migration/PLAN.md` migrates the values above into
`wiki.pdf-template/v1` manifest design-token fields. It inherits this file as
its migration inventory and the lint stub as its "no new unledgered
hardcoding" guard. See that plan's Reference and Goal sections.

---

## Spec 012 migration status — COMPLETE (2026-07-20)

Every presentation literal in the tables above has been migrated out of
`template.ts`/`serialize.ts` and into the built-in template's validated
`wiki.pdf-template/v1` design manifest:

- **Destination**: `packages/pdf/src/builtin-template.ts`
  (`BUILTIN_PDF_TEMPLATE_MANIFEST.design`). Fonts → `typography.fonts`;
  typography sizes/weights/tracking → `typography.roles`; color tokens →
  `tokens.colors`; component spacing/geometry → `tokens.layout`; block-width
  and lighten percentages → `tokens.ratios`; callout/status palettes →
  `semanticPalettes`; page margins → `page.margin`; feature toggles →
  `features`; accent → `branding.accent`. Document-facing labels
  (`Version`/`Exported`/`Contents`/… and the German bundle) → `localization`.
- **How the engine consumes it**: static design is interpolated when
  `createAtlcliTypstTemplate(design)` generates the Typst string; the
  settings-driven subset (accent, page size/orientation, cover/outline,
  organization name) and the labels are read from the emitted
  `settings.design`/`settings.labels` dict at Typst runtime. `serialize.ts`
  sources its emitted colors/lengths from the same built-in design.
- **Proof of non-regression**: the default built-in output is byte-identical
  before and after the migration — see
  `packages/pdf-compiler-browser/src/template-migration-parity.test.ts`
  (sha256 pinned against the pre-migration engine, real Typst compiler).

### Engine-invariant allowlist (CI-enforced)

`packages/pdf/scripts/check-hardcoding-ledger.ts` is now a CI-enforced lint
(companion test `check-hardcoding-ledger.test.ts`). It scans **both**
`template.ts` and `serialize.ts`, blanks `${…}` interpolation spans (design
reads, not literals), and fails on any remaining bare hex color, `pt`/`mm`/`em`
length, or `font: "…"` family that is not on the reviewed engine-invariant
allowlist. That allowlist currently has exactly one entry, each requiring a
one-line structural justification:

| Literal | Justification |
|---------|---------------|
| `1pt` | Unit-conversion multiplier `settings…watermark.size * 1pt` — turns a numeric setting into a Typst length. Structural, not a presentation size. |

Presentation values (colors, sizes, fonts, labels) must never be added to this
allowlist; migrate them into the manifest instead (spec 012 STOP condition).

### Accepted limits of the lint

The lint is a heuristic review aid, not a Typst/TypeScript parser. These
bypasses are known and accepted — all are contrived, and the byte-parity gate
(`template-migration-parity.test.ts`) plus code review are the real backstop:

- a literal hidden inside its own `${…}` interpolation (the blanking step
  removes the span, so the literal inside it is not scanned);
- non-6-digit hex (`#abc`, `#aabbccdd`) and non-`pt`/`mm`/`em` units
  (`cm`, `in`, `%`);
- multi-family font stacks and `font:` values built by concatenation.

Tightening any of these is cheap follow-up work if a real case appears; none has.

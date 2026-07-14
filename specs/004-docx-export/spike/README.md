# DOCX engine spike (spec 004, Task 1)

Throwaway-but-runnable spike comparing **docx-templates** (MIT) vs
**docxtemplater** (free tier) for the DOCX export. Findings and the decision live
in `../engine-decision.md`.

> This directory has its **own** `package.json` + `bun.lock` and is **not** part
> of the repo's bun workspace (`workspaces: ["apps/*","packages/*"]` — `specs/**`
> is outside those globs). `bun install` here writes only `spike/node_modules`
> and `spike/bun.lock`; the root install/test/build are untouched.

## Run

```bash
bun install      # local only
bun run all      # build fixtures → run both engines + preprocessor → verify
```

Individual steps: `bun run build:template`, `build:payload`,
`run:docx-templates`, `run:docxtemplater`, `run:preprocessor`, `run:errors`,
`verify`.

## What's here

| Path | Role |
|---|---|
| `src/build-template.ts` | Produces `fixtures/fixture-template.docx` — a mayflower-style template (cover, header/footer with `$scroll.*`, native TOC field, Heading 1–3 styles) via the `docx` lib. Placeholders are left as **literal** `$scroll.*` text. |
| `src/build-payload.ts` + `src/png.ts` | Generate the 3 fixture PNGs (hand-rolled PNG encoder, no native deps). |
| `src/payload.ts` + `src/ooxml.ts` | The content zoo (headings 1–4, 4 callouts, merged-cell table, nested lists, colored code, links, status badge, 3 images) as OOXML fragments + the **self-built image module** (media/rel/content-type). |
| `src/preprocess.ts` | Engine-agnostic `$scroll.*` find/replace across document/header/footer parts. |
| `src/run-docx-templates.ts` | docx-templates native IMAGE + literal-XML injection → `out/docx-templates-native.docx`. |
| `src/run-docxtemplater.ts` | docxtemplater free `{@rawXml}` + self-built images → `out/docxtemplater-native.docx`. |
| `src/run-preprocessor.ts` | Realistic customer path (either engine) → `out/customer-preprocessed.docx`. |
| `src/run-errors.ts` | Criterion 4: malformed-template error behaviour. |
| `src/verify-outputs.ts` | Opens produced XML and **asserts** replacements/images/callouts/code (not "no exception"). |
| `bundle/` | `bun build --target=browser` outputs used to measure bundle size. |

## How the fixtures were produced

- **Template**: `docx` library (MIT), see `src/build-template.ts`. Header/footer
  and body carry literal `$scroll.*` strings; TOC is a native Word `TableOfContents`
  field bound to Heading 1–3 styles.
- **Images**: solid-colour PNGs from `src/png.ts` (zlib-deflated scanlines +
  CRC32 chunks) — deterministic, tiny, no `canvas`/native dependency.
- **Content payload**: hand-authored OOXML fragments (`src/payload.ts`), because
  the spike tests the **engines**, not the storage→OOXML converter (that walker
  is Task 2, a separate concern).

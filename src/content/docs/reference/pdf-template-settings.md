---
title: "PDF Template Settings"
description: "Level-A settings that configure the built-in PDF template: page size, orientation, cover/outline toggles, header/footer text, accent color, organization name, logo, and watermark"
---

# PDF Template Settings

The PDF exporter renders through a single versioned template contract,
`wiki.pdf-template/v1`. Level-A **settings** let you configure that template
without editing Typst source: page size, orientation, section toggles,
header/footer text, brand accent color, organization name, a logo, and a
watermark. Settings are plain, serializable values, so every host — CLI flags,
the extension form, or a further host — supplies the same shape.

Settings are **data, never code**. The engine validates every value in
TypeScript and rejects anything malformed with a structured error; it never
silently clamps an out-of-range value. Host-supplied strings are escaped before
they reach the generated document, so a header or watermark string can never
inject template source.

## On this page

- [Prerequisites](#prerequisites)
- [How settings flow](#how-settings-flow)
- [Settings reference](#settings-reference)
- [Watermark settings](#watermark-settings)
- [Logo settings](#logo-settings)
- [Custom fonts (engine seam)](#custom-fonts-engine-seam)
- [Minimal example](#minimal-example)
- [Advanced example](#advanced-example)
- [Validation and error handling](#validation-and-error-handling)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A working PDF export pipeline (see [PDF Export Engine](pdf-engine.md)).
- A host that forwards a `settings` object into the export call. Omitting
  settings entirely reproduces the default document exactly.

## How settings flow

```text
host settings (plain object)
   -> RunPdfExportInput.settings
   -> PdfSerializeOptions.settings
   -> resolvePdfSettings()  (validate + default; throws on invalid)
   -> main.typ: #show: atlcli-doc.with(meta: (...), settings: (...))
   -> atlcli-doc(meta, settings, body)   // wiki.pdf-template/v1
```

Validation runs as the first step of an export, before any attachment is
fetched, so a settings typo fails fast and never pays for network work it would
discard.

## Settings reference

All fields are optional. Omitting a field applies its default.

| Field | Type | Default | Required | Constraints |
|-------|------|---------|----------|-------------|
| `page` | `"a4" \| "letter"` | `"a4"` | Optional | Must be exactly `a4` or `letter`. |
| `orientation` | `"portrait" \| "landscape"` | `"portrait"` | Optional | Must be exactly `portrait` or `landscape`. |
| `cover` | `boolean` | `true` | Optional | — |
| `outline` | `boolean` | `true` | Optional | — |
| `headerText` | `string` | *(none)* | Optional | At most 200 Unicode code points. |
| `footerText` | `string` | *(none)* | Optional | At most 200 Unicode code points. |
| `accentColor` | `string` | `"#4B57A3"` | Optional | Any color the exporter can normalize to `#RRGGBB` (`#RGB`, `#RRGGBB`, `rgb(...)`, or a named CSS color). |
| `organizationName` | `string` | *(none)* | Optional | At most 200 Unicode code points. |
| `logo` | `PdfLogoAsset` | *(none)* | Optional | See [Logo settings](#logo-settings). |
| `watermark` | `PdfWatermarkSettings` | *(none)* | Optional | See [Watermark settings](#watermark-settings). |

The default accent color is the built-in Editorial Indigo. The default page is
A4 portrait with the cover and outline sections both enabled — identical to the
document produced when no settings are supplied.

:::note[The running head is not a Level-A setting]
Whether the running head shows the document title, the **current chapter**, or a
fixed string is a *template design* decision (`design.features.header.mode` in
the manifest), not a per-export field. `headerText` above still wins over
whatever mode the template declares. See
[Running-head modes](pdf-template-contract.md#running-head-modes) — including
the DOCX `STYLEREF` equivalent.
:::

Rendered behavior:

- `page` / `orientation` set the page geometry for the whole document
  (`letter` maps to the US Letter paper size, 612 × 792 pt).
- `cover: false` and `outline: false` each remove exactly one page — the
  section *and* its trailing page break — never leaving a blank page behind.
  The closing document-integrity page always renders.
- `headerText` replaces the running header on body pages, and outranks the
  template's own running-head mode. `footerText` renders left of the centered
  page number.
- `accentColor` recolors every accent the template draws: the cover eyebrow
  and rule, and the closing-page accents.
- `organizationName` renders in uppercase before the space label on the cover
  and right-aligned in the footer.
- `logo` renders on the cover above the title inside a fixed 45 × 12 mm box
  (scaled to fit, never widening the cover layout); its `alt` text becomes the
  image's alternative text in the tagged PDF.

## Watermark settings

A watermark is a rotated text layer drawn under the content, so it becomes a
page Artifact and does not interfere with text selection. Set `watermark` to a
`PdfWatermarkSettings` object; `text` is required and every other field
defaults.

| Field | Type | Default | Required | Constraints |
|-------|------|---------|----------|-------------|
| `text` | `string` | — | **Required** | Must be non-empty (whitespace-only is rejected). |
| `color` | `string` | `"#DE350B"` | Optional | Normalizable to `#RRGGBB`. |
| `opacity` | `number` | `0.08` | Optional | In the half-open range `(0, 1]`. `0`, negative values, `NaN`, and `Infinity` are rejected. |
| `angle` | `number` | `-54` | Optional | Degrees, `-180..180` inclusive. |
| `size` | `number` | `96` | Optional | Points, `8..400` inclusive. |

The watermark is wired into the page background, so it repeats on the cover,
every body page, and the closing page, and it never changes the page count.
Because it sits under the content as a page Artifact, text selection, search,
and assistive-technology reading order are unaffected.

Two variants are **explicitly rejected** for v1, not merely unimplemented:

- **Foreground (over-content) watermarks** — a layer above the text would
  cover content and break copy/select.
- **Image watermarks** — out of scope for v1; the watermark is text-only.

## Logo settings

A `logo` is a `PdfLogoAsset` with three fields:

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `bytes` | `Uint8Array` | **Required** | Non-empty; at most 5 MiB (rejected, never downscaled). |
| `mediaType` | `"image/png" \| "image/svg+xml"` | **Required** | For PNG, the bytes must begin with the PNG signature. |
| `alt` | `string` | **Required when a logo is present** | Non-empty alternative text. |

Security rules (restated from the template security model):

- **PNG or sanitized SVG only.** SVG bytes must contain an `<svg>` root and are
  rejected (namespace prefixes such as `svg:script` do not bypass the checks)
  if they contain any of: a `DOCTYPE` or `ENTITY` declaration, a `script` or
  `foreignObject` element, an `on*` event handler attribute, or any
  `href`/`xlink:href` value that is not empty or a pure `#fragment` reference —
  external URLs, `data:`/`javascript:` URIs, and relative paths are all
  rejected.
- **Bundled bytes only.** The engine never fetches a logo; supply the bytes.
- **A present logo always requires a non-empty `alt`.** A meaning-bearing logo
  without alternative text is rejected.

## Custom fonts (engine seam)

Corporate fonts are **not** a `PdfTemplateSettings` field. They enter through a
separate engine seam: a host resolves approved font bytes and constructs the
browser compiler with `bundledFonts ∪ customFonts`. The PDF engine never fetches
a font — the host supplies the bytes, exactly like the logo.

Two types describe the seam:

| Type | Shape | Purpose |
|------|-------|---------|
| `FontAsset` | `{ family, style: "normal" \| "italic", weight, sha256, license? }` | One approved face. `sha256` is the lowercase hex digest of the exact bytes; `license` is an optional attestation (`OFL` / `Apache-2.0` / `proprietary`). |
| `FontSource` | `{ list(): Promise<FontAsset[]>; getBytes(sha256): Promise<Uint8Array> }` | Host-provided port (mirrors `PdfAssetResolver`). The host owns storage and the upload/attestation flow. |

### Accepted and rejected formats

`parseFontMeta(bytes)` inspects sfnt bytes and returns one record per face:

- **Accepted:** TrueType (`00 01 00 00`), CFF/OpenType (`OTTO`), and TrueType
  Collections (`ttcf`). A collection returns **one record per bundled face**, so
  a multi-face `.ttc` never silently drops faces.
- **Rejected — WOFF/WOFF2** (`wOFF` / `wOF2`) with the actionable message
  *"web-packaged font detected — the PDF compiler consumes TTF/OTF; export the
  desktop font from your font source."* The pinned Typst compiler consumes sfnt
  only.
- **Rejected — malformed input** (empty buffer, over the 10 MB per-font cap,
  truncated headers, out-of-range table offsets, hostile table counts, unknown
  magic) with a typed `FontParseError` carrying a machine-readable `reason`. It
  never throws an anonymous `RangeError`.

### Mandatory verification before use

`verifyFontBytes(asset, bytes)` re-hashes delivered bytes against
`asset.sha256` and throws a typed `FontVerificationError` on any mismatch. This
step is **mandatory host wiring** between `FontSource.getBytes` and the
compiler's `fonts` array: without it, a corrupted or swapped delivery would be
embedded under the approved font's license claim with no error.

```ts
new BrowserPdfCompiler({
  wasm,
  fonts: [
    ...bundledFonts,
    ...(await Promise.all(
      customFonts.map(async (f) => {
        const bytes = await fontSource.getBytes(f.sha256);
        await verifyFontBytes(f, bytes); // gates every custom font
        return bytes;
      }),
    )),
  ],
});
```

`BrowserPdfCompilerAssets.fonts` is already `Uint8Array[]` and the compiler's
`add_raw_font` accepts arbitrary extra fonts, so **no change is needed in the
compiler package** to add custom fonts.

### How templates reference fonts

Template-pack manifests reference approved fonts as a `choice` setting whose
options a host generates from `FontSource.list()` — Level A keeps the "font
choice from an approved set" model with **no free-form font input**. The upload
UI, the license-attestation flow, and font storage are host follow-ups, not part
of this engine seam.

## Minimal example

Export to US Letter with no cover page:

```ts
await runPdfExport(
  {
    blocks,
    metadata,
    filename: "guide.pdf",
    settings: { page: "letter", cover: false },
  },
  env,
);
```

## Advanced example

A confidential, branded export: Letter landscape, a legal footer line, a brand
accent, an organization name, and a draft watermark.

```ts
await runPdfExport(
  {
    blocks,
    metadata,
    filename: "acme-confidential.pdf",
    settings: {
      page: "letter",
      orientation: "landscape",
      outline: false,
      footerText: "Acme Confidential — do not distribute",
      accentColor: "#0052CC",
      organizationName: "Acme Corp",
      logo: { bytes: acmeLogoPng, mediaType: "image/png", alt: "Acme Corp" },
      watermark: { text: "DRAFT", opacity: 0.1, angle: -45 },
    },
  },
  env,
);
```

## Validation and error handling

Invalid settings throw before any asset is fetched. Each failure names the exact
offending field through a `PdfSettingsError` with:

- `path` — the field, e.g. `watermark.opacity` or `logo.alt`.
- `value` — the offending value.
- `constraint` — a human-readable description of the rule.

When run through the export orchestrator, the failure surfaces at the
`configuration` phase (distinct from `prepare`, so a settings typo is never
mistaken for an asset-fetch failure), carrying the `PdfSettingsError` as its
cause.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Export fails at the `configuration` phase | A settings value is out of range or malformed | Read the `PdfSettingsError` `path`/`constraint`; correct that field. |
| `watermark.opacity` rejected for `0` | Fully transparent is not a valid watermark | Use a small positive value such as `0.08`. |
| `logo.bytes` rejected as "do not match the declared PNG media type" | `mediaType` says PNG but the bytes are not PNG | Supply real PNG bytes or set `mediaType` to `image/svg+xml`. |
| `logo.alt` rejected | A logo was supplied without alternative text | Provide a non-empty `alt`. |
| SVG logo rejected as "active or externally loaded content" | The SVG has a script, event handler, `<foreignObject>`, or external reference | Export a static, self-contained SVG, or use PNG. |

## Related topics

- [PDF Template Contract](pdf-template-contract.md) — the `wiki.pdf-template/v1`
  render surface these settings flow into.
- [Template Pack Format](template-pack-format.md) — the `.wiki-pdf-template`
  container for shareable templates.
- [PDF Export Engine](pdf-engine.md)
- [DOCX and PDF Export](../confluence/export.md)
- [DOCX Export Engine](docx-engine.md)

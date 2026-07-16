---
title: "DOCX Export Engine"
description: "The isomorphic @atlcli/docx export engine and how a new surface plugs in"
---

# DOCX Export Engine (`@atlcli/docx`)

`packages/docx` holds atlcli's isomorphic DOCX export engine: the pure pipeline that turns a
Confluence page plus a Word template with Scroll placeholders (`$scroll.*`) into a finished
`.docx`. It runs unchanged in the browser (the Chrome extension's "Export to Word") and under
Node/Bun (`atlcli wiki export --engine ts`) — the hosts differ only in the side effects they
inject.

## In this page

- [Architecture](#architecture)
- [The three injected interfaces](#the-three-injected-interfaces)
- [Image embedding](#image-embedding)
- [Mermaid diagrams](#mermaid-diagrams)
- [Plugging in a new surface](#plugging-in-a-new-surface)
- [Guarantees and gates](#guarantees-and-gates)
- [Related topics](#related-topics)

## Architecture

The engine follows the repo's "functional core, imperative shell" rule:

| Layer | Where | Examples |
|-------|-------|----------|
| Pure engine | `packages/docx/src` | template scan, placeholder resolution, `ExportBlock[]` → OOXML serialization, docxtemplater orchestration, Shiki highlighting |
| Host shells | each consumer | extension: IndexedDB store, session fetch, browser download · CLI: `readFile`/`writeFile`, token-auth client |

Entry points (package `exports` conditions, mirroring `@atlcli/core`):

| Import | Resolves to | Use |
|--------|-------------|-----|
| `@atlcli/docx` | Node barrel | engine + Node filesystem adapters |
| `@atlcli/docx/browser` | browser barrel | engine only (no `node:` imports, CI-gated) |
| `@atlcli/docx/scan` | scan module | lightweight template scan without pulling the full engine |

## The three injected interfaces

`runExport(input, env)` is the cross-host entry. `env` is an `ExportEnv` with exactly the three
places hosts differ:

```ts
interface TemplateSource {
  getBytes(id: string): Promise<Uint8Array>;   // extension: IndexedDB · CLI: readFile
}
interface AssetFetcher {
  fetch(ref: AssetRef): Promise<Uint8Array>;   // extension: session fetch · CLI: token client
}
interface OutputSink {
  emit(name: string, bytes: Uint8Array): Promise<void>; // extension: download · CLI: writeFile
}
interface SvgRasterizer {
  rasterize(svg: string, target: { widthPx: number; heightPx: number }): Promise<Uint8Array>;
} // extension: <canvas> · Node hosts: resvg or similar (optional)
interface ExportEnv {
  templates: TemplateSource;
  assets?: AssetFetcher;
  rasterizer?: SvgRasterizer;
  output: OutputSink;
}
```

`AssetFetcher` drives image embedding (spec 005). It is optional: a host that omits it gets the
pre-005 behavior — every image degrades to an `image-skipped` report note instead of embedding.

`SvgRasterizer` drives mermaid diagram embedding (spec 005a) — it supplies the mandatory PNG
fallback Word needs next to the vector SVG. Also optional: a host that omits it exports mermaid
blocks as readable source code blocks with a `diagram-skipped` report note.

## Image embedding

Images embed through a self-built OOXML image module (`packages/docx/src/image.ts` — the
docxtemplater free tier has no image support): per image the engine writes a
`word/media/…` part, a `document.xml.rels` relationship, a `[Content_Types].xml` default, and an
inline `<w:drawing>` with unique element ids and alt text. Details that matter to hosts:

- **Formats:** PNG, JPEG, GIF (dimensions decoded from the header bytes, no image library).
  SVG is detected but deferred — it degrades to a report note.
- **Sizing:** page-set width/height (`ac:width`) wins over the intrinsic size; everything is
  capped to the content width (600 px at 96 dpi) preserving aspect ratio.
- **Failure is never fatal:** a failed fetch/decode/oversized image produces an
  `image-embed-failed` warning note and no OOXML — never a dangling relationship.
- **`AssetRef` shape:** attachment refs carry a wiki-base-relative `url`
  (`/download/attachments/{pageId}/{filename}`) plus `pageId`/`filename`; external images carry
  their absolute URL. A session host (the extension) prefixes its Confluence root and rides the
  ambient cookies — note Cloud 302s these downloads to `api.media.atlassian.com`, so an MV3 host
  needs that origin in its `host_permissions` (the media CDN's wildcard CORS header rejects
  credentialed fetches otherwise). A **token host must not** fetch the cookie-only `/download/attachments/…`
  path (it answers 401 to API tokens) — resolve `pageId`+`filename` through the REST attachment
  listing and fetch the API's own `downloadUrl` instead, as the CLI's fetcher does
  (`tokenAssetFetcher` in `apps/cli/src/commands/export.ts`).
- Byte-identical images share one media part; the report counts `embeddedImages` and
  `skippedImages`.

## Mermaid diagrams

Fenced ```` ```mermaid ```` code blocks render into inline vector drawings (spec 005a) through
[`beautiful-mermaid`](https://github.com/lukilabs/beautiful-mermaid) — a self-contained,
DOM-free renderer (not mermaid.js). The renderer is the **format-agnostic adapter package
`@atlcli/diagram`** (`packages/diagram`): it knows nothing about DOCX, so the PDF export path
can consume the same SVG natively later. It is lazy-loaded, so diagram-free exports never pay
for its ~1.5 MB elkjs layout chunk; the SVG → PNG rasterization is the host's injected
`SvgRasterizer` (a DOCX-side concern — Word needs the raster fallback, PDF will not).

- **Supported types:** flowchart (`graph`/`flowchart`), state, sequence, class, ER, XY chart.
- **Word compatibility:** each diagram embeds as `asvg:svgBlip` (vector, modern Word) **plus** a
  PNG rendered at 2× the intrinsic size in the same blip (older Word). Both media parts,
  relationships and content types are written by the image module — shared id space with page
  images, width-capped, and the diagram **source** carried as the drawing's alt text.
- **Everything else degrades honestly:** an unsupported type (Gantt, Pie, Mindmap, Timeline,
  Git graph, C4, …) yields a `diagram-unsupported` info note naming the type; a render, raster
  or embed failure yields a `diagram-render-failed` warning; no rasterizer yields
  `diagram-skipped`. In every non-rendered route the block exports as a readable monospace
  source block — never a broken image, never a dangling relationship. The report counts
  `renderedDiagrams`.
- **Theming:** `ExportInput.diagramTheme` takes two base colors (`bg`, `fg`) plus optional role
  overrides (`line`, `accent`, `muted`, `surface`, `border`, `font`); the full scheme is derived
  from the base pair. Default is a neutral zinc-light palette matching the export's code blocks.
- **Licensing note:** beautiful-mermaid is MIT; its layout dependency `elkjs` is **EPL-2.0**
  (weak copyleft, satisfied by attribution — see the repository `NOTICE` file).

### Logo placeholders

`$scroll.spacelogo` and `$scroll.globallogo` embed the **space logo** as an inline drawing
through the same image module (the placeholder paragraph is replaced, its alignment preserved).
The icon location comes from the optional `deps.getSpaceLogo(spaceKey)` round-trip — wire it to
`GET /space/{key}?expand=icon` and return the `icon.path` as an `AssetRef` (the CLI and the
extension both do). Details:

- **`$scroll.globallogo` maps to the space logo:** Confluence Cloud exposes no separately
  fetchable global logo; the report carries a `placeholder-substituted` info note per export.
- **Size args:** `$scroll.spacelogo.(H,W)` — height first, then width, in px; a single argument
  is the height (width scales by aspect ratio). Both are optional.
- **Headers/footers work:** the `r:embed` relationship is written into the referencing part's
  own rels (e.g. `word/_rels/header1.xml.rels`).
- **Cloud default logos are SVG** and therefore degrade to a `logo-embed-failed` note (same SVG
  deferral as page images). Custom logos (PNG/JPEG/GIF) embed. On a token host, a custom logo's
  `icon.path` is a cookie-only `/download/attachments/{contentId}/{filename}` URL — carry the
  content id + filename on the `AssetRef` so the fetcher resolves them via the REST attachment
  listing (the CLI's `getSpaceLogo` does exactly this).
- **Missing dep/fetcher, fetch errors, no space key** all degrade to `logo-skipped` notes; the
  token is blanked, never left literal.

## Plugging in a new surface

A new consumer (MCP server, Tauri Studio, Org-Server) implements the three interfaces and calls
`runExport`. Minimal Node example:

```ts
import { runExport, fileTemplateSource, fileOutputSink } from "@atlcli/docx";

const report = await runExport(
  {
    details,                              // ConfluencePageDetails (title, storage, …)
    template: { name: "corporate.docx", modificationDate: new Date() },
    deps: {                               // lazy resolver round-trips, all optional
      getSpace: (key) => client.getSpace(key),
      getCurrentUser: () => client.getCurrentUser(),
      getPageOwner: (id) => client.getPageOwner(id),
      getSpaceHomepageStorage: (key) => client.getSpaceHomepageStorage(key),
      getSpaceLogo: async (key) => {      // $scroll.spacelogo / $scroll.globallogo
        const icon = await client.getSpaceIcon(key);
        return icon ? { url: icon.path } : null;
      },
    },
  },
  {
    templates: fileTemplateSource("./corporate.docx"),
    // assets: { fetch } — supply an AssetFetcher to embed images (see above);
    // omitted, images become report notes instead.
    output: fileOutputSink("./out.docx"),
  }
);
```

A browser surface supplies its own implementations instead (see
`apps/extension/utils/docx/env.ts` for the extension's adapters). Browser bundling note: PizZip
and docxtemplater reference `Buffer.*`; that is a **host** bundling concern — the extension
installs a `Uint8Array` shim + Vite `define`, a Node host has the real `Buffer`, and the engine
itself never touches either.

## Guarantees and gates

- **Isomorphism:** `packages/docx/src/index.browser.ts` is one of the CI-gated browser
  entrypoints (`bun run check:browser`) — a `node:`/`bun:` specifier anywhere in its graph fails CI.
- **Golden-file equality:** `packages/docx/src/golden.test.ts` pins the engine's output to the
  pre-extraction extension export; `node-consumer.test.ts` proves the identical output under Node
  filesystem adapters.
- **Determinism:** highlighting warms the Shiki grammar on load, so the same input always yields
  the same OOXML (a first-call tokenization drift would otherwise break golden equality).
- **Roadmap:** the PDF export (spec 007) builds its Typst serializer directly into this engine —
  same `ExportBlock` model, same env contract, no second extraction.

## Related topics

- [DOCX Export](../confluence/export.md) — the `atlcli wiki export` command (both engines)
- [CLI Commands](cli-commands.md) — full command reference

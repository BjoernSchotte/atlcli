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
- [Host ports](#host-ports)
- [Browser hosts](#browser-hosts)
- [Image embedding](#image-embedding)
- [Mermaid diagrams](#mermaid-diagrams)
- [Plugging in a new surface](#plugging-in-a-new-surface)
- [Performance model](#performance-model)
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
| `@atlcli/docx/browser-runtime` | browser support | byte compatibility bootstrap plus memory/canvas adapters |
| `@atlcli/docx/vite` | Vite defines | build-time replacements required by PizZip/docxtemplater |
| `@atlcli/docx/scan` | scan module | lightweight template scan without pulling the full engine |

DOCX and PDF deliberately remain separate engines. They share the structured Confluence
`ExportBlock[]` input model, not a generic export runner, report, or output sink.

## Host ports

`runExport(input, env)` is the cross-host entry. `env` is an `ExportEnv` with the format-specific
ports where hosts differ:

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
blocks as readable source code blocks with a `diagram-skipped` report note. Two implementations
ship: the neutral browser canvas rasterizer (`@atlcli/docx/browser-runtime`) and a Node
rasterizer over the WebAssembly build of resvg (`resvgSvgRasterizer` in
`packages/docx/src/node-adapters.ts`) that the CLI uses.

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
  from the base pair. Use hex colors (`#RRGGBB`). Default is a neutral zinc-light palette
  matching the export's code blocks.
- **Flattened SVG:** beautiful-mermaid themes through CSS custom properties and
  `color-mix()`, which neither Word's svgBlip renderer nor resvg resolves (unresolved `var()`
  paints black). `renderDiagram` flattens both to literal presentation attributes before the
  SVG reaches any rasterizer or the archive (`flattenSvgStyles` in
  `packages/diagram/src/svg-flatten.ts`); the CSS background becomes a real background
  `<rect>`. Browsers render the flattened SVG identically.
- **Extension rasterizer:** the MV3 side panel draws each flattened SVG to a canvas and encodes
  its PNG synchronously with `toDataURL`. The asynchronous `toBlob` callback path showed
  repeatable ~1-second scheduling delays in real side-panel E2E runs. Diagram preparation is
  already serialized, so synchronous encoding avoids that host task runner without adding
  concurrent main-thread work.
- **Node rasterizer (CLI):** `resvgSvgRasterizer()` renders the PNG fallback through
  `@resvg/resvg-wasm` — chosen over the native `@resvg/resvg-js` because release binaries are
  cross-compiled from one Linux runner, which can embed one portable `.wasm` for every target
  but never another platform's `.node` addon. The wasm build sees no system fonts, so the
  package bundles Inter and JetBrains Mono (`packages/docx/fonts/`, SIL OFL) — the exact
  families the diagram SVGs name. Hosts may pass their own `{ wasm, fonts }` bytes (the
  compiled CLI binary reads its embedded copies); plain Node hosts omit them and the adapter
  resolves both from the package.
- **Licensing note:** beautiful-mermaid is MIT; its layout dependency `elkjs` is **EPL-2.0**
  (weak copyleft, satisfied by attribution); resvg is **MPL-2.0**; the bundled Inter and
  JetBrains Mono fonts are **SIL OFL 1.1** — see the repository `NOTICE` file.

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

### Included pages — `$scroll.includepage.(…)`

`$scroll.includepage.(…)` embeds the **body of another Confluence page** at the placeholder
position — a central imprint, legal disclaimer, or standard appendix maintained once and pulled
into every export. It is a document pass (not a text value): the placeholder paragraph is swapped
for the referenced page's serialized OOXML body, inserted verbatim. Wire the optional
`deps.getIncludedPage` round-trip (the CLI and extension both build it from
`buildGetIncludedPage`, which owns the title lookup, id-sorted determinism, and error mapping).
Title references resolve through the **direct content endpoint**
(`client.findPagesByTitle` → `GET /content?title=…`), **not** the CQL search index — so a page
created moments before the export (e.g. a CI pipeline that creates then immediately exports) is
findable at once, instead of returning `includepage-unresolved` until the search index catches up
minutes later.

**Argument forms:**

| Form | Example | Meaning |
| --- | --- | --- |
| `(Title)` | `$scroll.includepage.(Imprint)` | A page titled *Imprint* in the exported page's space |
| `(SPACE:Title)` | `$scroll.includepage.(DOCSY:Imprint)` | A page titled *Imprint* in space `DOCSY` (split on the **first** colon; the title may contain more) |
| `("Quoted Title")` | `$scroll.includepage.("A: B")` | A quote-wrapped title is verbatim (colon-safe) |
| `(pageId)` | `$scroll.includepage.(1234567)` | An all-digits argument is a page id |

**Behavior:**

- **Referenced more than once** (body **and** header, header **and** footer, or twice in one
  part): the target is fetched and walked **once**, cached, and rendered in **every** occurrence.
  Only a page including **itself** is a cycle (`includepage-cycle`, rendered empty) — every other
  repeat is intentional and renders.
- **Atomic paragraph only:** the token must be the *sole* visible content of its paragraph. A
  token sharing a paragraph with prose (`See our disclaimer: $scroll.includepage.(Imprint)`) is
  **not** expanded — the surrounding text survives verbatim, the token is blanked, and
  `includepage-invalid-context` is noted. Put the include on its own line.
- **Assets follow the part:** an included page's attachment images and Mermaid diagrams embed
  their relationships into the **target part's own** rels (`word/_rels/header1.xml.rels`,
  `…/footer1.xml.rels`, …) — never a dangling relationship, even in headers/footers.
- **Budget:** at most 25 unique included pages and 2 MiB of cumulative included storage per
  export; beyond that, further **new** targets blank with `includepage-budget-exceeded` (already
  fetched targets keep rendering). A v1 guess, revisited on real large templates.
- **Never a literal:** every failure path (invalid args, not found, no permission, auth failure,
  rate limit, transient/network error, budget, cycle) blanks the token with its own report note.

**Note codes** (all surfaced in the export report, and as `code` in the `--json`
`atlcli.export-report/1` report):

| Code | Meaning |
| --- | --- |
| `includepage-unresolved` | The argument names no page, or the page was not found / not readable (Cloud 403 ≡ 404) |
| `includepage-invalid-context` | The token shares a paragraph with other text — put it on its own line |
| `includepage-cycle` | A page referenced itself; rendered empty |
| `includepage-ambiguous-title` | A title matched several pages; the first (id-sorted) rendered — disambiguate with `SPACE:Title` or `(pageId)` |
| `includepage-auth-failed` | Authentication failed while fetching (check the export credentials) |
| `includepage-rate-limited` | Confluence rate-limited the fetch; retry the export |
| `includepage-transient-error` | A 5xx / network failure (or no include fetcher available) |
| `includepage-budget-exceeded` | The per-export include budget was exceeded; later new targets blanked |

> A title containing `)` cannot be referenced by title (the scan grammar stops the argument at
> the first `)`) — use the `(pageId)` form instead.

## Browser hosts

Browser consumers install the DOCX-specific compatibility layer before importing the engine:

```ts
import "@atlcli/docx/browser-runtime";

const { runExport } = await import("@atlcli/docx/browser");
```

`installDocxBrowserRuntime()` installs namespaced `Uint8Array` helpers; it does not create a
fake global `Buffer`. `memoryTemplateSource()` and `canvasSvgRasterizer()` provide neutral DOM
adapters. Storage, authenticated asset fetching, download/save behavior, and UI remain owned by
the consuming host. Vite hosts also spread `docxViteDefines` from `@atlcli/docx/vite` into their
`define` configuration.

`apps/browser-export-harness` is the permanent package-conformance consumer. Its production
build runs the real engine and canvas path in Chromium without extension APIs or native Node
globals. A host still needs its own packaging, CSP, authentication, and output integration tests.

## Plugging in a new surface

A new consumer implements the DOCX host ports and calls
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
      getIncludedPage: buildGetIncludedPage({   // $scroll.includepage.(…)
        getPage: (id) => client.getPage(id),
        // DIRECT title lookup (not CQL) — findable the moment a page exists.
        findPagesByTitle: (title, spaceKey) => client.findPagesByTitle(title, { spaceKey }),
        defaultSpaceKey: details.spaceKey,  // fills a bare (Title) form
      }),
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

A browser surface composes the neutral browser runtime with its own storage, authenticated
fetch, and output adapters. PizZip and docxtemplater reference `Buffer.*`; the package-owned
browser runtime and Vite configuration handle that compatibility without leaking it into the
engine or defining `globalThis.Buffer`. A Node host uses the real `Buffer` through the default
entrypoint.

## Performance model

The engine overlaps every independent cost instead of paying them back to back; a page with
many integrations (images, diagrams, code blocks, logos) exports in roughly one network
latency plus the heaviest CPU leg:

- **Resolver round-trips run concurrently.** Space, current user, page owner, and space-homepage
  fetches fire together via `Promise.all`; report notes keep a fixed order regardless of which
  response arrives first.
- **Placeholder resolution, body serialization, and the space-logo fetch overlap.** The logo pass
  is split into a fetch leg (starts immediately, never rejects) and an embed leg (mutates the
  archive after the body is serialized, in the same deterministic order as before).
- **Asset fetches are prefetched and pooled.** Before the document-order serialization walk, a
  prefetch pass starts every image download (max 6 in flight — safe for browser per-origin
  limits, CLI sockets, and future webview hosts). Diagram preparation stays on a single ordered
  chain because concurrent canvas rasterization degrades sharply in the extension; repeated
  occurrences of the exact same Mermaid source share one preparation. Embedding still happens
  in document order, so relationship ids and media numbering never depend on completion timing
  (pinned by the determinism regression tests in `export.test.ts`).
- **Syntax highlighting warms early and picks the fastest engine.** Code-block languages found
  during the prefetch pass start their grammar loads immediately; aliases such as `ts` and
  `typescript` share one canonical grammar load. Hosts that may compile WebAssembly (CLI, Node,
  Tauri) get Shiki's Oniguruma engine (~30 ms for the TypeScript grammar); the MV3 panel (no
  `wasm-unsafe-eval`) keeps the JavaScript engine and never fetches the wasm chunk — the choice
  is made by an 8-byte compile probe at runtime.
- **The CLI overlaps its own legs too.** The page fetch runs concurrently with template
  read/scan; a quick local template scan pre-starts exactly the resolver round-trips the template
  needs, and page-dependent space/homepage calls start as soon as the page yields its space key.
  `$scroll.space.*` and the logo share one `?expand=icon` call. The resvg module, WASM, and fonts
  are loaded only when the page storage contains a Mermaid code block.
- **CLI asset cache.** Immutable asset bytes — version-stamped download URLs (the space logo)
  and attachments keyed by `id` + `version` — are cached under `~/.atlcli/cache/assets/`. A
  replaced logo or re-uploaded attachment gets a new version stamp, so the cache never serves
  stale bytes. Entries carry a checksum envelope so damaged files are refetched and repaired;
  the directory is mode `0700` and entries are `0600`. Deleting the directory is always safe.
- **The extension warms only opted-in export work.** Once a valid template exists, engine and
  host chunks load in the background. On Export, the existing scan pre-starts only the required
  resolver calls while host chunks settle, and the already-loaded template bytes are reused from
  memory. Space/icon metadata is cached for five minutes per canonical site + space. Current user
  and homepage storage remain per-export because neither has a safe same-site invalidation signal;
  versioned asset bytes use a separate bounded cache keyed by canonical site + URL.

## Guarantees and gates

- **Isomorphism:** `packages/docx/src/index.browser.ts` is one of the CI-gated browser
  entrypoints (`bun run check:browser`) — a `node:`/`bun:` specifier anywhere in its graph fails CI.
- **Golden-file equality:** `packages/docx/src/golden.test.ts` pins the engine's output to the
  pre-extraction extension export; `node-consumer.test.ts` proves the identical output under Node
  filesystem adapters.
- **Determinism:** highlighting warms the Shiki grammar on load, so the same input always yields
  the same OOXML (a first-call tokenization drift would otherwise break golden equality).
- **Second browser consumer:** the production Vite harness exports a real DOCX with a Mermaid
  diagram and asserts the expected OOXML media parts under headless Chromium.
- **Separate PDF lane:** `@atlcli/pdf` consumes the same `ExportBlock[]` model but owns a
  different runner, report, validation path, and compiler port.

## Related topics

- [DOCX Export](../confluence/export.md) — the `atlcli wiki export` command (both engines)
- [CLI Commands](cli-commands.md) — full command reference

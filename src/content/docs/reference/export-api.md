---
title: "Public Export API (v1)"
description: "The frozen v1 seams of the @atlcli export engines: what is stable, what is experimental, what is internal"
---

# Public Export API (v1)

The API freeze (spec 009 T4.2). Five packages froze at **1.0.0**:
`@atlcli/confluence`, `@atlcli/docx`, `@atlcli/pdf`, `@atlcli/pdf-compiler-browser`, and
`@atlcli/export-macros`. Everything on this page is the **stable v1 surface** — changes follow
the breaking-change policy in [Package Versioning](/reference/versioning/). Every stable
entrypoint's full symbol list and transitive type closure is committed and CI-guarded at
`packages/<p>/etc/<p>.api.md` (surface snapshot) and `packages/<p>/etc/<p>.closure.md`
(closure classification incl. the per-package freeze decision).

## In this page

- [Stability classes](#stability-classes)
- [Document model: ExportBlock & storageToBlocks](#document-model-exportblock--storagetoblocks)
- [Tree export: TreeSource, fetchExportTree, composeChapters](#tree-export-treesource-fetchexporttree-composechapters)
- [DOCX engine: ExportEnv & runExport](#docx-engine-exportenv--runexport)
- [PDF engine: PdfExportEnv & runPdfExport](#pdf-engine-pdfexportenv--runpdfexport)
  - [Emitting compiled bytes: PdfOutputSink & PdfBytesHandle](#emitting-compiled-bytes-pdfoutputsink--pdfbyteshandle)
- [PDF compiler port: PdfCompilePort & BrowserPdfCompiler](#pdf-compiler-port-pdfcompileport--browserpdfcompiler)
- [Macro rendering: MacroRendererRegistry](#macro-rendering-macrorendererregistry)
- [Unstable and internal surfaces](#unstable-and-internal-surfaces)
- [Related topics](#related-topics)

## Stability classes

| Class | Meaning |
|---|---|
| **stable** | Frozen v1. Breaking changes = major version, with one `@deprecated` minor first. |
| **experimental** | Exported and usable, but may change in minor releases (0.x packages, `./browser-runtime`, `./vite`). |
| **internal** | Non-frozen implementation subpaths (`./internal`, `./scan`, `./fixtures`, `./template`). May change without notice. |

## Document model: ExportBlock & storageToBlocks

`@atlcli/confluence` — the shared block tree both engines consume.

- `storageToBlocks(storage, options?)` → `{ blocks: ExportBlock[], notes: ExportNote[] }` —
  Confluence storage XML → typed block tree.
- `ExportBlock` / `InlineNode` / `LinkTarget` / `TableRow` / `Caption` / `MacroParameter` — the
  document model.
- `ExportNote` with `code: ExportNoteCode` — every note code is a member of the frozen
  `EXPORT_NOTE_CODES` registry; renaming or removing one is a breaking change.
- `htmlToExportBlocks` — the export_view HTML fallback walker.

## Tree export: TreeSource, fetchExportTree, composeChapters

`@atlcli/confluence` (spec 002).

- `TreeSource` — the fetch port (`getPage`, `getChildren`, `getPageVersion`,
  `getSpaceHomepageId`, optional `searchPages`). `confluenceTreeSource(client)` adapts a
  `ConfluenceClient`; in-memory implementations are legitimate ports.
- `fetchExportTree(source, scope, opts)` → `{ nodes, notes, complete }` — ordered DFS with
  label filtering, completeness contract (`strict`/`partial`), limits, cancellation, progress.
- `composeChapters(nodes, opts?)` → `{ blocks, notes }` — one chapterized document with
  namespaced anchors and rewritten cross-page links. Pure and deterministic.

## DOCX engine: ExportEnv & runExport

`@atlcli/docx` (spec 006).

- `runExport(input: RunExportInput, env: ExportEnv)` → `ExportReport`.
- `ExportEnv` seams: `TemplateSource`, `AssetFetcher`, `OutputSink`, `SvgRasterizer` — hosts
  inject them; nothing assumes a browser or Node.
- Node adapters (stable, exported from the barrel): `fileTemplateSource`, `fileOutputSink`,
  `resvgSvgRasterizer`, `unsupportedAssetFetcher`.
- Transitively frozen input/report types: `ExportInput`, `ConfluencePageDetails` (from
  confluence), `TemplateMeta`, `ResolveDeps`, `ScanResult`, `ExportReport`.

## PDF engine: PdfExportEnv & runPdfExport

`@atlcli/pdf` (specs 007/008).

- `runPdfExport(input: RunPdfExportInput, env: PdfExportEnv)` → `PdfExportReport` (phases:
  preparing → fetching → compiling → validating → emitting; failures are typed
  `PdfExportError`s).
- `PdfExportEnv` seams: `PdfAssetResolver`, `PdfCompilePort`, `PdfOutputSink` — the sink
  receives a `PdfBytesHandle`, see
  [Emitting compiled bytes](#emitting-compiled-bytes-pdfoutputsink--pdfbyteshandle).
- Host helper seams (specs 007/008): `preparePdfDocument` (pre-compile asset resolution),
  `validatePdfOutput` (structural output gate), `resolvePdfSettings` (template settings),
  `normalizePdfLocale`, `parseFontMeta`/`verifyFontBytes` (font intake),
  `formatPdfCompilerDiagnostics`, `PDF_RUNTIME_ASSETS` (the canonical font/license manifest).
- Transitively frozen types: `PdfBytesHandle`, `PdfSourceBundle`, `PdfCompilerDiagnostic`, `PdfExportMetadata`,
  `PdfProfile`, `PdfThemeOptions`, `PdfTemplateSettings` (spec 007 settings/watermark),
  `PreparePdfOptions`/`PreparedPdfDocument`, `ResolvedPdfSettings`, `ParsedFontFace`.
- Internal helpers deliberately **not** frozen (reachable via `./internal`): `sha256Hex`,
  `typstSettingsDict`, the `DEFAULT_PDF_*` watermark consts, and the asset-limit consts.

### Emitting compiled bytes: PdfOutputSink & PdfBytesHandle

`PdfOutputSink.emit(name, bytes, context?)` hands the host a **`PdfBytesHandle`** — a reference
to the compiled document — not the `Uint8Array` itself. The handle owns one representation and
converts on demand, memoizing each conversion, so a host that needs a different *shape* of the
bytes (a `Blob` for a download, an object URL for a viewer) never ends up holding a second full
copy of the document beside the first. For a 64 MiB PDF that duplicate was measured at
+64.0 MiB.

:::caution[This changed shape after the 1.0 freeze]
`emit`'s second parameter used to be a `Uint8Array`. Existing sinks must call
`await bytes.asUint8Array()`. See [Package Versioning](/reference/versioning/#post-freeze-contract-changes)
for why this landed without a deprecation cycle.
:::

| Member | Type | Notes |
|---|---|---|
| `size` | `number` | Byte length. Deliberately synchronous and always known, so quota accounting never materializes a payload just to add numbers. |
| `mimeType` | `string` | `"application/pdf"` for everything this engine emits. |
| `asUint8Array()` | `Promise<Uint8Array>` | **Borrowed, not owned** — see the caution below. |
| `asBlob()` | `Promise<Blob>` | Memoized: two calls return the same `Blob`, not two copies. |
| `objectUrl()` | `Promise<string>` | Memoized `blob:` URL; the handle owns revocation. Rejects on a runtime with no `URL.createObjectURL`. |
| `release()` | `void` | Revoke the minted object URL and drop memoized conversions. The handle stays usable — a later `objectUrl()` mints a fresh one. |

Minimal Node sink — write the document to disk:

```ts
import { writeFile } from "node:fs/promises";
import type { PdfOutputSink } from "@atlcli/pdf";

const sink: PdfOutputSink = {
  async emit(name, bytes) {
    await writeFile(name, await bytes.asUint8Array());
  },
};
```

Browser sink — download without a second copy of the document in memory:

```ts
import type { PdfBytesHandle, PdfOutputSink } from "@atlcli/pdf";

const sink: PdfOutputSink = {
  async emit(name: string, bytes: PdfBytesHandle, context): Promise<void> {
    context?.signal?.throwIfAborted();
    const url = await bytes.objectUrl(); // memoized — concurrent calls cannot leak a URL
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
    } finally {
      bytes.release(); // the handle revokes what it minted
    }
  },
};
```

:::caution[`asUint8Array()` lends, it does not copy]
The array you get back **is** the handle's backing store. Two consumers that both call it hold
the same object; mutating it, or detaching its `ArrayBuffer`, changes or destroys what every
other consumer — and the handle itself — will read.

- Read-only (writing to disk, hashing, size accounting)? Use it directly.
- Need to mutate? Copy first: `new Uint8Array(await bytes.asUint8Array())`.
- Handing the bytes to something that may **transfer** the buffer? Copy, or prefer
  `asBlob()`/`objectUrl()`. `pdfjs.getDocument({ data })` is the live example — PDF.js may
  transfer `data`'s `ArrayBuffer` to its worker, leaving every other holder with a zero-length
  view. PDF.js accepts a URL and detaches nothing.
:::

Companion exports on the same barrel: `pdfBytesFromUint8Array(bytes)` and
`pdfBytesFromBlob(blob)` construct a handle; `isPdfBytesHandle(value)` narrows an unknown value
to the interface — useful in a sink shared with the DOCX engine, whose `OutputSink.emit` still
takes a plain `Uint8Array`.

## PDF compiler port: PdfCompilePort & BrowserPdfCompiler

- `PdfCompilePort` (`@atlcli/pdf`): `compile(bundle, context?)` → `PdfCompileResult`.
- `BrowserPdfCompiler` (`@atlcli/pdf-compiler-browser`): the shipped implementation over the
  sha256-pinned, CSP-patched typst.ts wasm ("browser" names the wasm build target — it runs
  under Node/Bun/browsers). Assets come in as `BrowserPdfCompilerAssets`
  (`{ wasm, fonts }` — see the [asset contract](/reference/asset-contract/)).

## Macro rendering: MacroRendererRegistry

`@atlcli/export-macros` (spec 004).

- `MacroRendererRegistry` + `defaultRegistry(deps)`/`createRegistry` — hosts inject the
  walker/converter deps and client ports; the package has zero runtime imports from other
  `@atlcli/*` packages.
- `resolveMacroBlocks(blocks, options: MacroResolutionOptions)` — the async resolver pass both
  engines call; `MacroResolutionOptions` is embedded in the frozen docx/pdf surfaces.
- The frozen surface is the registry/port **contract** (the injected dep + port interfaces, the
  error helpers `portError`/`isPortError`) and the resolver pass — **not** the concrete
  renderer instances (`tocRenderer`, `jiraMacroRenderer`, …) or their helpers
  (`slugifyHeading`, `issueTable`, `jiraStatusColor`, …). `defaultRegistry` wires those
  internally; they stay reachable via `@atlcli/export-macros/internal`. The renderer *set* may
  grow additively in minor releases.

## Unstable and internal surfaces

Explicitly **not** part of the freeze:

- `./internal` subpaths — non-frozen implementation helpers, still importable in-repo and by
  adventurous hosts: confluence sync machinery (Bun-only); docx resolver/serializer/OOXML plus
  placeholder classification (`classifyPlaceholder`), date formatting, image embedding and the
  numbering helpers; pdf Typst escaping/serialization/theming (`preparePdfDocument` and
  `validatePdfOutput` themselves ARE frozen seams — only the serialize/theme/escape internals
  are not); export-macros' concrete renderer instances + helpers.
- `@atlcli/docx/scan` and `@atlcli/docx/fixtures` (dev/test API), `@atlcli/pdf/template`
  (raw Typst template), `./browser-runtime` and `./vite` (host bootstrap, experimental).
- The 0.x packages: `@atlcli/core`, `@atlcli/diagram`, `@atlcli/jira`, `@atlcli/plugin-api`,
  `@atlcli/template-pack`, `@atlcli/export-node` — see the freeze table in
  [Package Versioning](/reference/versioning/) for the per-package reasoning. Types owned by
  0.x packages but reachable from frozen surfaces (e.g. `Profile` from core,
  `DiagramTheme`/`renderDiagram` re-exported by docx) are **frozen-by-closure**: the frozen
  packages' 1.0 contract covers their use; the owning package stays 0.x for its wider surface.

## Related topics

- [Package Versioning](/reference/versioning/) — semver + breaking-change policy, freeze table
- [Consuming the @atlcli Packages](/reference/package-consumption/) — install paths
- [Export Asset Contract](/reference/asset-contract/) — wasm/font subpaths
- [DOCX Export Engine](/reference/docx-engine/) · [PDF Export Engine](/reference/pdf-engine/)

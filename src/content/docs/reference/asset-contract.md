---
title: "Export Asset Contract"
description: "Stable @atlcli/* asset subpaths (wasm, fonts, licenses) and how bundlers load them via ?url"
---

# Export Asset Contract (`?url` subpaths)

The export packages expose binary runtime assets at **stable subpaths**. PDF
hosts load and inject compiler/font bytes through `BrowserPdfCompilerAssets`.
The DOCX package owns its code-font loader: Node reads the installed package
file, browser bundlers emit a same-origin asset, and the compiled CLI injects
its embedded copy. This page is the contract those subpaths follow.

## In this page

- [Stable subpaths](#stable-subpaths)
- [DOCX code-font loading](#docx-code-font-loading)
- [`BrowserPdfCompilerAssets`](#browserpdfcompilerassets)
- [Vite `?url` example](#vite-url-example)
- [Ambient type declarations](#ambient-type-declarations)
- [Node hosts](#node-hosts)
- [Guarantees](#guarantees)
- [Related topics](#related-topics)

## Stable subpaths

| Subpath | Contents |
|---|---|
| `@atlcli/pdf-compiler-browser/wasm` | The vendored, CSP-safe and provenance-bound typst.ts compiler WASM (`typst_ts_web_compiler_bg.wasm`) |
| `@atlcli/pdf/fonts/<file>.ttf` | The twelve sha256-pinned Source Sans 3 / Source Serif 4 / Source Code Pro / Noto Symbols / Noto Emoji TTFs |
| `@atlcli/pdf/licenses/<file>` | The SIL OFL 1.1 license texts accompanying those fonts |
| `@atlcli/docx/fonts/<file>` | The committed Inter TTFs used by SVG rasterization and the JetBrains Mono face embedded for inline/block code |

The canonical font/license list lives in code — `PDF_RUNTIME_ASSETS` (exported from
`@atlcli/pdf`) — and `scripts/pack-check.test.ts` asserts the shipped tarball matches it
exactly. Never hardcode a font list; iterate `PDF_RUNTIME_ASSETS.fonts`.

## DOCX code-font loading

`prepareDocxExportRuntime(blocks, { preloadCodeFont: true })` explicitly
resolves and validates the committed `JetBrainsMono-Regular.ttf` after DOCX
intent. Without that option, preparation performs no font work; the render path
uses completed body-plus-include OOXML as the demand signal. Both paths share
one single-flight, retryable load-plus-validation promise.

Browser bundlers discover the package-relative
`new URL(..., import.meta.url)` and emit exactly one local asset; callers do not
pass a font URL or fetch callback. Node/Bun resolve the installed package file
instead. The browser harness and MV3 output scans pin the asset's SHA-256 and
require exactly one emitted copy.

## `BrowserPdfCompilerAssets`

`@atlcli/pdf-compiler-browser`'s compiler takes the loaded bytes:

```ts
interface BrowserPdfCompilerFontSourceV1 {
  assetId: string;
  sha256: string;
  load(context?: PdfCompileContext): Promise<Uint8Array> | Uint8Array;
}

interface BrowserPdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  fonts: readonly Uint8Array[] | readonly BrowserPdfCompilerFontSourceV1[];
}
```

Pass the wasm in the shape your host loads most naturally. A legacy font byte
array registers the complete set. A demand-aware host supplies one hash-bound
source per `PDF_RUNTIME_ASSETS.fonts` entry; the compiler invokes only the
sources named by the final bundle's `ResolvedPdfFontRequirementsV1`.

## Vite `?url` example

Exactly the pattern `apps/browser-export-harness/src/pdf-worker.ts` uses in production (and
that `scripts/consumer-smoke-vite.ts` proves against packed tarballs):

```ts
import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
import sansLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Sans-3.txt?url&no-inline";
// …one static import per entry in PDF_RUNTIME_ASSETS.fonts / .licenses
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset failed to load (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

// Collect one URL per font you import (repeat the static import pattern above
// for every entry in PDF_RUNTIME_ASSETS.fonts).
const fontUrls = new Map([
  ["SourceSans3-Regular.ttf", sansRegularUrl],
  // …one statically imported URL per manifest entry
]);

const compiler = new BrowserPdfCompiler({
  wasm: await fetch(wasmUrl), // Response is accepted directly
  fonts: PDF_RUNTIME_ASSETS.fonts.map((font) => ({
    assetId: font.assetId,
    sha256: font.sha256,
    load: ({ signal } = {}) => fetchBytes(fontUrls.get(font.fileName), signal),
  })),
});
```

Recommended Vite settings (matching the harness): `resolve.conditions: ["browser"]`,
`build.assetsInlineLimit: 0` (keep the wasm/fonts as real files). The static import is the
compile-time existence proof — a typo'd font name fails the build, not the
first export. License imports remain static packaging evidence; they are not
fetched for each compile.

## Ambient type declarations

TypeScript does not know `?url` specifiers by default. Add a `*.d.ts` in your source tree,
modeled on `apps/browser-export-harness/src/worker-assets.d.ts`:

```ts
declare module "*.ttf?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?url&no-inline" {
  const url: string;
  export default url;
}
```

(Vite users who include `vite/client` types already get the generic `*?url` declaration.)

## Node hosts

No bundler needed — resolve the same subpaths against `node_modules`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bytesOf = (spec: string) =>
  new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve(spec))));
const wasm = bytesOf("@atlcli/pdf-compiler-browser/wasm");
```

## Guarantees

- The subpaths above are part of the frozen packaging surface: renaming an asset file or
  subpath is a **breaking change** (see [Package Versioning](/reference/versioning/)).
- Every subpath resolves to a real file inside the packed tarball — enforced by
  `scripts/pack-check.test.ts`.
- The glue is source-level CSP-safe (no `new Function`); its WASM SHA-256 and fork provenance are pinned and the
  patch behavior is regression-tested (`packages/pdf-compiler-browser/src/vendor.test.ts`).

## Related topics

- [Consuming the @atlcli Packages](/reference/package-consumption/) — install paths
- [PDF Export Engine](/reference/pdf-engine/) · [DOCX Export Engine](/reference/docx-engine/)

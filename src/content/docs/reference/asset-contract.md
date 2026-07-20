---
title: "Export Asset Contract"
description: "Stable @atlcli/* asset subpaths (wasm, fonts, licenses) and how bundlers load them via ?url"
---

# Export Asset Contract (`?url` subpaths)

The PDF and DOCX engines never bundle their binary runtime assets. Instead the packages expose
them at **stable subpaths**, and every host — CLI, extension, harness, or an external bundler —
loads bytes itself and injects them through the engine seams
(`BrowserPdfCompilerAssets`, `ExportEnv`). This page is the contract those subpaths follow.

## In this page

- [Stable subpaths](#stable-subpaths)
- [`BrowserPdfCompilerAssets`](#browserpdfcompilerassets)
- [Vite `?url` example](#vite-url-example)
- [Ambient type declarations](#ambient-type-declarations)
- [Node hosts](#node-hosts)
- [Guarantees](#guarantees)
- [Related topics](#related-topics)

## Stable subpaths

| Subpath | Contents |
|---|---|
| `@atlcli/pdf-compiler-browser/wasm` | The vendored, CSP-patched typst.ts compiler wasm (`typst_ts_web_compiler_bg.wasm`) |
| `@atlcli/pdf/fonts/<file>.ttf` | The ten sha256-pinned Source Sans 3 / Source Serif 4 / Source Code Pro TTFs |
| `@atlcli/pdf/licenses/<file>` | The SIL OFL 1.1 license texts accompanying those fonts |
| `@atlcli/docx/fonts/<file>` | The committed Inter / JetBrains Mono TTFs used by the CLI's SVG rasterizer |

The canonical font/license list lives in code — `PDF_RUNTIME_ASSETS` (exported from
`@atlcli/pdf`) — and `scripts/pack-check.test.ts` asserts the shipped tarball matches it
exactly. Never hardcode a font list; iterate `PDF_RUNTIME_ASSETS.fonts`.

## `BrowserPdfCompilerAssets`

`@atlcli/pdf-compiler-browser`'s compiler takes the loaded bytes:

```ts
interface BrowserPdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  fonts: Uint8Array[];
}
```

Pass whatever your host loads most naturally: an `ArrayBuffer` (Bun/Node `readFile`,
`fetch(...).arrayBuffer()`), a `URL`, or a `Response` (browser `fetch` streaming).

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
const fontUrls = [sansRegularUrl /* , serifRegularUrl, monoRegularUrl, … */];

const compiler = new BrowserPdfCompiler({
  wasm: await fetch(wasmUrl), // Response is accepted directly
  fonts: await Promise.all(fontUrls.map(fetchBytes)),
});
```

Recommended Vite settings (matching the harness): `resolve.conditions: ["browser"]`,
`build.assetsInlineLimit: 0` (keep the wasm/fonts as real files). The static import is the
compile-time existence proof — a typo'd font name fails the build, not the first export.

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
- The wasm is always the CSP-patched build (no `new Function`): its sha256 is pinned and the
  patch behavior is regression-tested (`packages/pdf-compiler-browser/src/vendor.test.ts`).

## Related topics

- [Consuming the @atlcli Packages](/reference/package-consumption/) — install paths
- [PDF Export Engine](/reference/pdf-engine/) · [DOCX Export Engine](/reference/docx-engine/)

# @atlcli/pdf-compiler-browser

The shipped `PdfCompilePort` implementation: a version-pinned adapter around
the typst.ts web compiler. Ships a **vendored, CSP-patched** copy of the
wasm-bindgen glue + wasm (both `new Function` call sites replaced by a
throwing allowlist — no `unsafe-eval`; sha256-pinned, Apache-2.0 with NOTICE).

- **Entry points:**
  - `.` — `BrowserPdfCompiler`, `PDF_BROWSER_COMPILER_VERSION`,
    `BrowserPdfCompilerAssets`, `BrowserPdfCompilerFontSourceV1`.
  - `./wasm` — the vendored compiler wasm (for `?url` imports /
    `import.meta.resolve`).
  - `./vendor/*` — the vendored typst.ts files (glue, types, LICENSE, NOTICE).
- **Runtime:** Node ≥ 20, Bun, and browsers — anywhere with `WebAssembly`;
  the host supplies wasm plus local font bytes or lazy font sources explicitly.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";

const compiler = new BrowserPdfCompiler({ wasm, fonts });
const { pdf, diagnostics } = await compiler.compile(bundle);
```

For demand-aware staging, keep every font statically discoverable but make its
bytes lazy:

```ts
const fonts = PDF_RUNTIME_ASSETS.fonts.map((font) => ({
  assetId: font.assetId,
  sha256: font.sha256,
  load: ({ signal } = {}) => fetchBytes(fontUrls.get(font.fileName), signal),
}));

const compiler = new BrowserPdfCompiler({ wasm, fonts });
```

The compiler validates the bundle's versioned requirements before loading,
registers only that subset, and exposes `fontEvidence` in the compile result.
Because typst.ts font access is process-global, compiler instances share one
exclusive operation queue and one active owner. An owner or requirement-key
change frees and rebuilds the active compiler. A legacy `Uint8Array[]`, or a
hand-built bundle without requirements, retains full-bundle compatibility.

Asset wiring (`?url`, `BrowserPdfCompilerAssets`):
[export asset contract](https://atlcli.sh/reference/asset-contract/).
Versioning: [package versioning](https://atlcli.sh/reference/versioning/).

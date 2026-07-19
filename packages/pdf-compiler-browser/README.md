# @atlcli/pdf-compiler-browser

The shipped `PdfCompilePort` implementation: a version-pinned adapter around
the typst.ts web compiler. Ships a **vendored, CSP-patched** copy of the
wasm-bindgen glue + wasm (both `new Function` call sites replaced by a
throwing allowlist — no `unsafe-eval`; sha256-pinned, Apache-2.0 with NOTICE).

- **Entry points:**
  - `.` — `BrowserPdfCompiler`, `PDF_BROWSER_COMPILER_VERSION`,
    `BrowserPdfCompilerAssets`.
  - `./wasm` — the vendored compiler wasm (for `?url` imports /
    `import.meta.resolve`).
  - `./vendor/*` — the vendored typst.ts files (glue, types, LICENSE, NOTICE).
- **Runtime:** Node ≥ 20, Bun, and browsers — anywhere with `WebAssembly`;
  the host supplies wasm + font bytes explicitly.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";

const compiler = new BrowserPdfCompiler({ wasm, fonts });
const { pdf, diagnostics } = await compiler.compile(bundle);
```

Asset wiring (`?url`, `BrowserPdfCompilerAssets`):
[export asset contract](https://atlcli.sh/reference/asset-contract/).
Versioning: [package versioning](https://atlcli.sh/reference/versioning/).

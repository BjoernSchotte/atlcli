# Browser export conformance harness

Private vanilla Vite consumer for the public browser exports of `@atlcli/docx`, `@atlcli/pdf`,
and `@atlcli/pdf-compiler-browser`. It is test infrastructure, not a shipped product.

The production Playwright case serves `dist/` below `/conformance/nested/`, applies a local CSP,
and runs independent DOCX and PDF exports in Chromium. It verifies the real DOCX canvas/Mermaid
path, a real module Worker and Typst-WASM/font compile, deterministic warm PDF output, and
abort-without-emission. The artifact scanner rejects native-runtime, extension-runtime, remote
code, dynamic-code, and root-relative asset leaks.

The highlighting performance case also starts in a fresh browser context. It proves that
Shiki core, the JavaScript engine, the selected theme, and direct grammar modules load only
after explicit intent; a one-language trace rejects unrelated/aggregate catalogue requests,
and the 22-language trace verifies overlap, warm reuse, and byte-identical DOCX output.

```bash
bun run typecheck:browser-export-harness
bun run build:browser-export-harness
bun run check:browser-export-harness
bun run test:browser-export-harness
```

The harness imports only package exports. Authentication, persistent storage, download/save UI,
packaging, iframe behavior, and target-host CSP remain integration responsibilities of each real
host.

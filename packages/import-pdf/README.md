# @atlcli/import-pdf

Source-specific, byte-oriented PDF analysis for AtlCLI imports. The package
uses exact-pinned PDFium WASM behind an owned facts adapter and emits normalized,
serializable facts. It never accepts URLs, fetches runtime assets, executes PDF
actions, supplies OCR, or falls back to PDF.js.

Callers inject verified local WASM bytes. Node hosts may load the packaged asset
through `@atlcli/import-pdf/node`; browser hosts import
`@atlcli/import-pdf/browser-worker` inside a static module worker and provide
same-origin packaged bytes. Hard cancellation of a synchronous PDFium call is
owned by terminating that worker/process.

This package is experimental (`0.x`). PDF.js remains the viewer engine in the
browser extension and is not a dependency of the importer.

The package ships the exact PDFium WASM, wrapper/PDFium license texts,
provenance tuple, and an explicit third-party-notice gap inventory under
`@atlcli/import-pdf/licenses/*`. It does not claim an upstream SBOM or a fully
reproducible PDFium build where the selected distribution provides neither.

/**
 * Browser entry point for `@atlcli/pdf` (spec 009).
 *
 * Trimmed to the documented v1 seams: the export runner
 * (`runPdfExport`/`PdfExportEnv`), the compile port contract
 * (`PdfCompilePort`/`PdfCompileResult`/`PdfCompileContext` +
 * `formatPdfCompilerDiagnostics`), the runtime asset manifest
 * (`PDF_RUNTIME_ASSETS`), and the shared types the seams transitively need
 * (`PdfSourceBundle`, `PdfCompilerDiagnostic`, `PdfProfile`,
 * `PdfThemeOptions`, `PdfExportMetadata`, …).
 *
 * Implementation-detail modules (escape/prepare/serialize/theme/validate and
 * the raw Typst template) stay reachable via the explicit `./template`
 * subpath and the non-frozen `./internal` subpath.
 */
export * from "./compiler.js";
export * from "./run-export.js";
export * from "./runtime-assets.js";
export type * from "./types.js";

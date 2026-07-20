/**
 * Browser entry point for `@atlcli/pdf` (spec 009).
 *
 * Trimmed to the documented host-facing seams: the export runner
 * (`runPdfExport`/`PdfExportEnv`), the compile port contract
 * (`PdfCompilePort`/`PdfCompileResult`/`PdfCompileContext` +
 * `formatPdfCompilerDiagnostics`), the runtime asset manifest
 * (`PDF_RUNTIME_ASSETS`), the spec-007/008 host seams — template settings
 * (`resolvePdfSettings`/`normalizePdfLocale`), font intake
 * (`parseFontMeta`/`verifyFontAsset`), pre-compile asset resolution
 * (`preparePdfDocument`) and output validation (`validatePdfOutput`) — and
 * the shared types the seams transitively need (`PdfSourceBundle`,
 * `PdfCompilerDiagnostic`, `PdfProfile`, `PdfThemeOptions`,
 * `PdfExportMetadata`, `PdfAssetResolver`, …).
 *
 * Rendering internals (escape/serialize/theme and the raw Typst template)
 * stay reachable via the explicit `./template` subpath and the non-frozen
 * `./internal` subpath.
 */
export * from "./compiler.js";
export * from "./fonts.js";
export * from "./prepare.js";
export * from "./run-export.js";
export * from "./runtime-assets.js";
export * from "./settings.js";
export * from "./validate.js";
export type * from "./types.js";

/**
 * Browser entry point for `@atlcli/pdf` (spec 009 — frozen v1 surface).
 *
 * EXPLICIT named re-exports of exactly the documented v1 seams (see
 * `docs/reference/export-api.md`) plus the types they transitively require
 * (the closure guard, `scripts/api-closure.ts`, fails on any
 * reachable-but-unexported gap). A blanket `export *` is deliberately NOT
 * used: it would freeze implementation helpers (`sha256Hex`,
 * `typstSettingsDict`, the `DEFAULT_PDF_*` consts, …) into the stable 1.0.0
 * surface. Rendering internals (escape/serialize/theme, the raw Typst
 * template) stay reachable via `./internal` and `./template`.
 */

// --- Export runner (run-export.ts) ---
export {
  runPdfExport,
  preparePdfExport,
  renderPreparedPdfExport,
  normalizePdfLocale,
  PdfExportError,
} from "./run-export.js";
export type {
  PdfExportEnv,
  PdfOutputSink,
  PdfExportPhase,
  PdfExportErrorPhase,
  RunPdfExportInput,
  PreparePdfExportEnv,
  PreparedPdfExportV1,
  RenderPreparedPdfExportInput,
  RenderPreparedPdfExportEnv,
} from "./run-export.js";

// --- Compiled-byte handle (bytes-handle.ts, spec 010 T5.6) ---
export { pdfBytesFromUint8Array, pdfBytesFromBlob, isPdfBytesHandle } from "./bytes-handle.js";
export type { PdfBytesHandle } from "./bytes-handle.js";

// --- Compile port contract (compiler.ts) ---
export { formatPdfCompilerDiagnostics } from "./compiler.js";
export type { PdfCompilePort, PdfCompileResult, PdfCompileContext } from "./compiler.js";

// --- Pre-compile asset resolution (prepare.ts) ---
export { preparePdfDocument } from "./prepare.js";
export type { PreparePdfOptions } from "./prepare.js";

// --- Template settings resolution (settings.ts, spec 007/012) ---
export { resolvePdfSettings } from "./settings.js";
export type {
  ResolvedPdfSettings,
  ResolvedPdfWatermark,
  ResolvedPdfLogo,
  ResolvedPdfDesign,
  ResolvedPdfLabels,
  ResolvePdfSettingsContext,
} from "./settings.js";

// --- Font intake (fonts.ts, spec 007/008) ---
export { parseFontMeta, verifyFontBytes } from "./fonts.js";
export type {
  ParsedFontFace,
  FontParseError,
  FontVerificationError,
  FontParseErrorReason,
} from "./fonts.js";

// --- Output validation (validate.ts) ---
export { validatePdfOutput } from "./validate.js";
export type { PdfOutputInspection } from "./validate.js";

// --- Runtime asset manifest (runtime-assets.ts) ---
export { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
export type { PdfRuntimeFontAsset } from "./runtime-assets.js";

// --- Curated built-in templates + manifest contract (spec 012) ---
export { BUILTIN_PDF_TEMPLATE_ID, BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
export {
  MANUSCRIPT_PDF_TEMPLATE_ID,
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
  BUILTIN_PDF_TEMPLATES,
  getBuiltinPdfTemplate,
} from "./curated-templates.js";
export type { TemplateManifest, WikiPdfTemplateDesignV1 } from "@atlcli/template-pack";

// --- Shared document/PDF model (types.ts) ---
export type {
  PdfExportMetadata,
  PdfAssetRef,
  PdfResolvedAsset,
  PdfAssetResolver,
  PreparedPdfAsset,
  PreparedPdfInlineNode,
  PreparedPdfCaption,
  PreparedPdfBlock,
  PreparedPdfDocument,
  PdfSourceMapEntry,
  PdfSourceBundle,
  PdfProfile,
  PdfTableCellTextMode,
  PdfThemeOptions,
  PdfTheme,
  PdfWatermarkSettings,
  PdfLogoAsset,
  PdfTemplateSettings,
  PdfSerializeOptions,
  PdfExportTimings,
  PdfExportReport,
  PdfCompilerDiagnostic,
  FontAsset,
  FontSource,
} from "./types.js";

// --- Shared document model (owned by @atlcli/confluence, surfaced here so PDF
// consumers get it from one barrel — the same set types.ts re-exports). ---
export type { ExportBlock, ExportNote, InlineNode, LinkTarget } from "./types.js";

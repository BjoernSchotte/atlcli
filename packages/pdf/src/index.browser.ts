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
export {
  pdfBytesFromUint8Array,
  pdfBytesFromBlob,
  isPdfBytesHandle,
} from "./bytes-handle.js";
export type { PdfBytesHandle } from "./bytes-handle.js";

// --- Compile port contract (compiler.ts) ---
export { formatPdfCompilerDiagnostics } from "./compiler.js";
export type {
  PdfCompilePort,
  PdfCompileResult,
  PdfCompileContext,
} from "./compiler.js";

// --- Strict output-standard policy (Typst 0.15.1) ---
export {
  PDF_OUTPUT_STANDARDS_V1,
  TYPST_PDF_STANDARDS_0_15_1,
  PdfOutputPolicyError,
  resolvePdfOutputPolicyV1,
  resolveTypstPdfOptions0151,
} from "./output-policy.js";
export type {
  PdfOutputPolicyV1,
  PdfOutputStandardV1,
  ResolvedPdfOutputPolicyV1,
  TypstPdfOptions0151,
  TypstPdfStandard0151,
  PdfOutputStandardEvidenceV1,
} from "./output-policy.js";

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
  PdfBindableLevelASetting,
  PdfSettingPresenceMask,
  PdfDesignResolutionTraceEntry,
} from "./settings.js";

// --- Font intake (fonts.ts, spec 007/008) ---
export { parseFontMeta, verifyFontBytes } from "./fonts.js";
export type {
  ParsedFontAxis,
  ParsedFontFace,
  FontParseError,
  FontVerificationError,
  FontParseErrorReason,
} from "./fonts.js";

// --- Output validation (validate.ts) ---
export { validatePdfOutput, validatePdfOutputStandard } from "./validate.js";
export type { PdfOutputInspection } from "./validate.js";

// --- Runtime asset manifest (runtime-assets.ts) ---
export { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
export type { PdfRuntimeFontAsset } from "./runtime-assets.js";

// --- Demand-aware PDF font requirements (issue #126) ---
export {
  resolvePdfFontRequirementsV1,
  resolveFullPdfFontRequirementsV1,
  assertResolvedPdfFontRequirementsV1,
} from "./font-requirements.js";
export type {
  PdfFontDiagnosticV1,
  PdfFontRequirementReasonKindV1,
  PdfFontRequirementReasonV1,
  ResolvedPdfFontAssetRequirementV1,
  ResolvedPdfFontRequirementsV1,
  ResolvePdfFontRequirementsInputV1,
} from "./font-requirements.js";

// --- Template visual-asset capability contract ---
export { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "./template-asset-capabilities.js";
export type { TemplateAssetCapabilitiesV1 } from "@atlcli/template-pack";

// --- PDF template-pack visual validation/loading ---
export {
  PDF_TEMPLATE_ASSET_SLOTS_V1,
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_CANONICAL_SOURCE_REVISION_1,
  PDF_CANONICAL_SOURCE_REVISION_2,
  PDF_CANONICAL_SOURCE_REVISION_3,
  PDF_CANONICAL_SOURCE_REVISION_4,
  PDF_CANONICAL_SOURCE_REVISION_5,
  PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION,
  PDF_SUPPORTED_CANONICAL_SOURCE_REVISIONS,
  PDF_TEMPLATE_DECORATION_IDS_V1,
  PDF_TEMPLATE_WRITERS_V1,
  PdfTemplateValidationError,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  loadPdfTemplatePack,
  clonePdfTemplateRuntime,
  generateCanonicalPdfTemplateSourceV1,
  buildUniformPdfPageBorderV1,
} from "./template-pack.js";

export {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V3,
  PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V3,
  PDF_TEMPLATE_PRESENTATION_REVISION_V1,
  PDF_TEMPLATE_PRESENTATION_REVISION_V2,
  PDF_TEMPLATE_PRESENTATION_REVISION_V3,
} from "./design-catalog.js";

// --- Recipe-V2 installed baseline resolution (authoring only; no IO) ---
export {
  PDF_TEMPLATE_BASELINE_SCHEMA_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_VERSION_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_REGISTRY_V1,
  PdfTemplateRecipeV2ResolutionError,
  canonicalPdfTemplateBaselineV1,
  computePdfTemplateBaselineDigestV1,
  resolvePdfTemplateRecipeV2Design,
} from "./recipe-baselines.js";

export {
  materializePdfTemplateRecipeV1,
  materializePdfTemplateRecipeV2,
} from "./template-recipe.js";
export type {
  MaterializePdfTemplateRecipeInputV1,
  MaterializePdfTemplateRecipeInputV2,
  MaterializedPdfTemplateRecipeV1,
  MaterializedPdfTemplateRecipeV2,
  ResolvedPdfTemplateRecipeAssetV1,
} from "./template-recipe.js";
export type {
  PdfTemplateBaselineContentV1,
  ResolvedPdfTemplateBaselineV1,
  PdfTemplateBaselineRegistryV1,
  ResolvedPdfTemplateRecipeV2,
  PdfTemplateRecipeV2ResolutionReason,
} from "./recipe-baselines.js";

// --- Host-neutral authoring runtime materializer ---
export {
  PdfGeneratedTemplateProofCompiler,
  PdfTemplateRuntimeMaterializer,
} from "./template-authoring-runtime.js";

// --- Host-neutral preview compiler adapter ---
export {
  PdfTemplatePreviewCompiler,
  PdfTemplatePreviewError,
} from "./template-preview.js";
export type {
  PdfTemplatePreviewModelV1,
  PdfTemplatePreviewCompilerOptionsV1,
} from "./template-preview.js";
export type {
  PdfTemplateAssetSlotV1,
  PdfTemplateDecorationIdV1,
  PdfTemplateValidationPhase,
  PdfTemplateValidationReason,
  PdfTemplateVisualsV1,
  PdfTemplateRuntimeSnapshotV1,
  PdfVerifiedCanonicalSourceV1,
  PdfTemplateRuntimeV1,
  AnyPdfTemplateManifest,
  PdfTemplateManifestV5,
  ResolvedPdfTemplateAssetV1,
  ValidatedPdfTemplatePackV1,
  DocxUniformPageBorderInputV1,
} from "./template-pack.js";

// --- Curated built-in templates + manifest contract (spec 012) ---
export {
  BUILTIN_PDF_TEMPLATE_ID,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
export {
  MANUSCRIPT_PDF_TEMPLATE_ID,
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
  BUILTIN_PDF_TEMPLATES,
  getBuiltinPdfTemplate,
} from "./curated-templates.js";
export type {
  TemplateManifest,
  WikiPdfTemplateDesignV1,
  WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";

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
  PdfFontLoadEvidenceV1,
  PdfExportReport,
  PdfCompilerDiagnostic,
  FontAsset,
  FontSource,
} from "./types.js";

// --- Shared document model (owned by @atlcli/confluence, surfaced here so PDF
// consumers get it from one barrel — the same set types.ts re-exports). ---
export type {
  ExportBlock,
  ExportNote,
  InlineNode,
  LinkTarget,
} from "./types.js";

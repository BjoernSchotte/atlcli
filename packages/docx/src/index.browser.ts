/**
 * Browser-safe entry point for `@atlcli/docx` (spec 006 / 009 — frozen v1
 * surface).
 *
 * EXPLICIT named re-exports of exactly the documented v1 seams (see
 * `docs/reference/export-api.md`) plus the types they transitively require
 * (the closure guard, `scripts/api-closure.ts`, fails on any
 * reachable-but-unexported gap). A blanket `export *` is deliberately NOT
 * used: the export/image/placeholder-map/dateformat modules carry ~40 OOXML
 * and parsing helpers (`ensureNumberingPart`, `encodeXmlText`, `relsPathFor`,
 * `parseSvgSize`, `classifyPlaceholder`, …) that must NOT be frozen into the
 * stable 1.0.0 surface. Those stay reachable via `./scan` and the non-frozen
 * `./internal` subpath. Every re-exported module MUST build for
 * `--target=browser` (enforced by `scripts/check-browser-build.ts`).
 */

// --- Export host contract (env.ts) ---
export { runExport } from "./env.js";
export type {
  ExportEnv,
  RunExportInput,
  TemplateSource,
  AssetRef,
  AssetFetcher,
  OutputSink,
  SvgRasterizer,
  HostCallContext,
} from "./env.js";

// --- Lower-level entry + report/input model (export.ts) ---
export {
  exportDocx,
  prepareDocxExport,
  renderPreparedDocxExport,
  renderPreparedDocxExportStream,
  DocxRenderError,
} from "./export.js";
export type {
  ExportInput,
  ExportReport,
  ExportResult,
  StreamedDocxExportResult,
  ExportTimings,
  PreparedDocxMediaPartV1,
  PreparedDocxExportV1,
  PreparedDocxRenderStateV1,
  RenderPreparedDocxExportInput,
} from "./export.js";
export { prepareDocxExportRuntime } from "./runtime-preparation.js";
export type {
  DocxExportRuntimePreparation,
  PrepareDocxExportRuntimeOptions,
} from "./runtime-preparation.js";

// --- Types transitively required by the seams above (closure-enforced) but
// whose implementation modules stay behind ./scan and ./internal. ---
export type {
  CurrentUser,
  IncludePageDetails,
  IncludeLookupOutcome,
  PageOwner,
  ResolveDeps,
  TemplateMeta,
} from "./resolver.js";
export type { ScanHit, ScanResult } from "./scan.js";
export type { IncludePageRef, PlaceholderStatus } from "./placeholder-map.js";
export type { NumberingAllocator, NumberingBase, NumberingXml } from "./numbering.js";

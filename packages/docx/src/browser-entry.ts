/**
 * Canonical ordered browser entry for DOCX intent hosts.
 *
 * The runtime side effect is deliberately the first module request. ESM
 * evaluates it before the browser engine graph below, so PizZip/docxtemplater
 * can never run before the namespaced byte helpers are installed. Hosts should
 * import their engine and browser adapters from this one subpath instead of
 * recreating that ordering with sequential dynamic imports.
 */
import "./browser-runtime.js";

export * from "./index.browser.js";

export {
  canvasSvgRasterizer,
  installDocxBrowserRuntime,
  memoryTemplateSource,
  prepareDocxCodeHighlighting,
} from "./browser-runtime.js";
export type {
  CanvasRasterizerTiming,
  CanvasSvgRasterizerOptions,
  DocxByteHelpers,
} from "./browser-runtime.js";

// Template inspection is part of the explicit DOCX-intent graph. Keeping the
// two host-facing helpers here lets browser consumers avoid a second PizZip
// entry while the wider, non-frozen scan implementation remains on ./scan.
export { scanTemplate, unzipDocx } from "./scan.js";
export type { ArchiveBudget, DocxErrorKind } from "./scan.js";

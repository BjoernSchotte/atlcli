/**
 * Compatibility re-export (spec 010 Phase 0).
 *
 * `TemplateSection` was an effect owner: IndexedDB reads, session-authenticated
 * dependency round-trips, lazy engine imports and the export call all lived in
 * the component. Those moved to `./ports/docx.ts` (the host half) and the
 * component became `components/export/DocxExportPanel.tsx`, a port consumer.
 *
 * Its presentational and pure parts were already separated and tested, so they
 * moved unchanged and are re-exported here — `tests/docx/report-view.test.tsx`,
 * `tests/docx/scan-view.test.tsx`, `tests/docx/template-load.test.ts` and
 * `tests/docx/rasterizer-report.test.ts` all keep passing through the move
 * without being touched.
 */
export { ReportView } from "../../components/export/DocxReportView.js";
export { ScanView } from "../../components/export/ScanView.js";
export {
  loadCurrentTemplate,
  rasterizerTimingNote,
  type CurrentTemplate,
} from "../../components/export/docx-template.js";

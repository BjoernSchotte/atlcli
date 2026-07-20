/**
 * Compatibility re-export (spec 010 Phase 0).
 *
 * `PdfSection` was an effect owner: it built its own `AbortController`, imported
 * the export engine, tracked phases and held the report. All of that is now
 * split between {@link PdfExportPort} (the host's job — `./ports/pdf.ts`) and
 * `ExportRunsProvider` (state that must outlive a screen change), leaving
 * `components/export/PdfExportPanel.tsx` as pure rendering.
 *
 * Its presentational half was already separated and tested, so it moved
 * unchanged and is re-exported from here: `tests/pdf/report-view.test.tsx`
 * keeps passing through the move without being touched.
 */
export { PdfReportView } from "../../components/export/PdfReportView.js";

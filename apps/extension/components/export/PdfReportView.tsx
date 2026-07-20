/**
 * PDF export report (presentational).
 *
 * Moved here from `entrypoints/sidepanel/PdfSection.tsx` in spec 010 Phase 0:
 * it is a screen-level component, and screens are portable units. The old path
 * still re-exports it so `tests/pdf/report-view.test.tsx` keeps passing
 * unchanged through the move.
 */
import React from "react";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import { useT } from "../../utils/i18n/context.js";
import { formatDuration } from "./format.js";

export function PdfReportView({ report }: { report: PdfExportReport }): React.JSX.Element {
  const t = useT();
  return (
    <div
      data-testid="pdf-report"
      className="mt-2 rounded-md bg-success/15 p-2 text-xs"
    >
      <strong>{report.filename}</strong>
      <div>
        {formatDuration(report.timings.totalMs)} ·{" "}
        {t("pdf.report.summary", {
          images: report.embeddedImages,
          diagrams: report.renderedDiagrams,
        })}
      </div>
      <div aria-label={t("pdf.report.timingsLabel")} className="mt-0.5 text-muted-foreground">
        {t("pdf.report.timings", {
          prepare: formatDuration(report.timings.prepareMs),
          compile: formatDuration(report.timings.compileMs),
          emit: formatDuration(report.timings.emitMs),
        })}
      </div>
      {report.notes.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer">
            {t("pdf.report.notes", { count: report.notes.length })}
          </summary>
          <ul className="m-0 mt-1 list-disc pl-4">
            {report.notes.map((note, index) => (
              <li key={`${note.code}-${index}`}>{note.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

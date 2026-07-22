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
import { CircleCheck } from "lucide-react";
import { useT } from "../../utils/i18n/context.js";
import { ExportNoteGroups } from "./ExportNoteGroups.js";
import { formatDuration } from "./format.js";
import { MacroOutcomeSummary } from "./MacroOutcomeSummary.js";

export function PdfReportView({ report }: { report: PdfExportReport }): React.JSX.Element {
  const t = useT();
  return (
    <div
      data-testid="pdf-report"
      className="mt-2 rounded-md border bg-card p-2.5 text-xs text-card-foreground"
    >
      <div className="flex items-start gap-2">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <div className="min-w-0">
          <strong className="block truncate" title={report.filename}>{report.filename}</strong>
          <div>
            {formatDuration(report.timings.totalMs)} ·{" "}
            {t("pdf.report.summary", {
              images: report.embeddedImages,
              diagrams: report.renderedDiagrams,
            })}
          </div>
        </div>
      </div>
      <div aria-label={t("pdf.report.timingsLabel")} className="mt-0.5 text-muted-foreground">
        {t("pdf.report.timings", {
          prepare: formatDuration(report.timings.prepareMs),
          compile: formatDuration(report.timings.compileMs),
          emit: formatDuration(report.timings.emitMs),
        })}
      </div>
      <MacroOutcomeSummary notes={report.notes} />
      <ExportNoteGroups notes={report.notes} />
    </div>
  );
}

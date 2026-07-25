/**
 * DOCX export report (presentational).
 *
 * Notes are the export's trust surface (spec 004 §2.5): fetch failures, image
 * skips, date/highlight warnings and walker degradations must all be visible,
 * grouped so a warning never hides among informational notes. Note *messages*
 * stay untranslated — they come from the shared engine and are identical in the
 * CLI, so a support request can be matched against CLI output verbatim.
 *
 * Moved here from `entrypoints/sidepanel/TemplateSection.tsx` in spec 010
 * Phase 0; the old path re-exports it so `tests/docx/report-view.test.tsx`
 * keeps passing unchanged.
 */
import React from "react";
import type { ExportReport } from "@atlcli/docx/browser";
import { CircleCheck } from "lucide-react";
import { useT } from "../../utils/i18n/context.js";
import { ExportNoteGroups } from "./ExportNoteGroups.js";
import { MacroOutcomeSummary } from "./MacroOutcomeSummary.js";

export function ReportView({ report }: { report: ExportReport }): React.JSX.Element {
  const t = useT();

  return (
    <div data-testid="export-report" className="mt-2.5 rounded-md border bg-card p-2.5 text-xs text-card-foreground">
      <div className="flex items-start gap-2">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <div className="min-w-0">
          <strong>{t("docx.report.title")}</strong>
          <div className="truncate" title={report.filename}>{report.filename}</div>
        </div>
      </div>
      <ul className="m-0 mt-1.5 list-disc pl-4">
        <li data-testid="report-code-theme">
          {t("export.codeThemeValue", { theme: report.codeTheme })}
        </li>
        <li>{t("docx.report.resolved", { count: report.resolvedCount })}</li>
        {report.unsupportedNames.length > 0 && (
          <li data-testid="report-unsupported">
            {t("docx.report.unsupported", {
              count: report.unsupportedNames.length,
              names: report.unsupportedNames.join(", "),
            })}
          </li>
        )}
        {report.embeddedImages > 0 && (
          <li data-testid="report-embedded-images">
            {t("docx.report.embeddedImages", { count: report.embeddedImages })}
          </li>
        )}
        {report.renderedDiagrams > 0 && (
          <li data-testid="report-rendered-diagrams">
            {t("docx.report.renderedDiagrams", { count: report.renderedDiagrams })}
          </li>
        )}
        {report.skippedImages > 0 && (
          <li data-testid="report-skipped-images">
            {t("docx.report.skippedImages", { count: report.skippedImages })}
          </li>
        )}
        <li>{t("docx.report.duration", { ms: report.durationMs })}</li>
      </ul>

      <MacroOutcomeSummary notes={report.notes} />
      <ExportNoteGroups notes={report.notes} />
    </div>
  );
}

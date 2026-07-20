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
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import { cn } from "../ui/utils.js";

const NOTE_LEVELS = [
  { level: "warning", labelKey: "docx.report.warnings", className: "text-warning" },
  { level: "info", labelKey: "docx.report.notes", className: "text-muted-foreground" },
] as const satisfies readonly { level: string; labelKey: MessageKey; className: string }[];

export function ReportView({ report }: { report: ExportReport }): React.JSX.Element {
  const t = useT();
  const groups = new Map<string, ExportReport["notes"]>();
  for (const note of report.notes) {
    const level = note.level === "warning" ? "warning" : "info";
    const bucket = groups.get(level) ?? [];
    bucket.push(note);
    groups.set(level, bucket);
  }

  return (
    <div data-testid="export-report" className="mt-2.5 rounded-md bg-muted p-2 text-xs">
      <strong>{t("docx.report.title")}</strong> — {report.filename}
      <ul className="m-0 mt-1.5 list-disc pl-4">
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

      {NOTE_LEVELS.map(({ level, labelKey, className }) => {
        const notes = groups.get(level);
        if (!notes || notes.length === 0) return null;
        return (
          <div key={level} data-testid={`report-notes-${level}`} className="mt-2">
            <div className={cn("font-semibold", className)}>{t(labelKey, { count: notes.length })}</div>
            <ul className="m-0 mt-0.5 list-disc pl-4">
              {notes.map((note, index) => (
                <li key={`${note.code}-${index}`} className={className}>
                  {note.message}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * PDF export panel — a port consumer, not an effect owner (spec 010 Phase 0).
 *
 * Everything this component used to do itself (build an `AbortController`,
 * dynamically import `utils/pdf/run-export.js`, thread `onPhase`, hold the
 * report) now belongs to either the {@link PdfExportPort} implementation (the
 * host's job) or `ExportRunsProvider` (state that must outlive a screen
 * change). What is left is rendering.
 */
import React from "react";
import type { LoadedPage } from "../../utils/read-path.js";
import type { PdfExportPort } from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
import type { ExportPhase } from "../../utils/ports/index.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { SectionHeading } from "../ui/field.js";
import { useExportRuns } from "../app/export-runs.js";
import { PdfReportView } from "./PdfReportView.js";

const PHASE_KEYS: Record<ExportPhase, MessageKey> = {
  preparing: "pdf.phase.preparing",
  fetching: "pdf.phase.fetching",
  queued: "pdf.phase.queued",
  compiling: "pdf.phase.compiling",
  validating: "pdf.phase.validating",
  downloading: "pdf.phase.downloading",
};

export function PdfExportPanel({
  port,
  page,
  pageUrl,
}: {
  port: PdfExportPort;
  page: LoadedPage | null;
  pageUrl: string | null;
}): React.JSX.Element {
  const t = useT();
  const { pdf, startPdf, cancelPdf } = useExportRuns();
  const ready = page !== null && pageUrl !== null;

  return (
    <section data-testid="pdf-section" className="flex flex-col gap-2">
      <SectionHeading>{t("pdf.title")}</SectionHeading>
      <p className="m-0 text-xs text-muted-foreground">{t("pdf.builtIn")}</p>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            if (ready && !pdf.phase) startPdf(port, { page, pageUrl });
          }}
          disabled={!ready || Boolean(pdf.phase)}
          data-testid="pdf-export"
          title={ready ? t("pdf.export") : t("pdf.needsPage")}
        >
          {pdf.phase ? t(PHASE_KEYS[pdf.phase]) : t("pdf.export")}
        </Button>
        {pdf.phase && (
          <Button variant="outline" onClick={cancelPdf} data-testid="pdf-cancel">
            {t("pdf.cancel")}
          </Button>
        )}
      </div>

      {!ready && <p className="m-0 text-xs text-muted-foreground">{t("pdf.needsPage")}</p>}

      {pdf.error && (
        <Alert role="alert" tone="danger" data-testid="pdf-error">
          {pdf.error}
        </Alert>
      )}

      {pdf.report && <PdfReportView report={pdf.report} />}
    </section>
  );
}

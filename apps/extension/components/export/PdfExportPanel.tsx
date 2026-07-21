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
import type { PdfTemplateSettings } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../../utils/read-path.js";
import type { ExportScopeRequest, PdfExportPort } from "../../utils/ports/index.js";
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
  scopeRequest,
  settings,
  gate = (run) => run(),
}: {
  port: PdfExportPort;
  page: LoadedPage | null;
  pageUrl: string | null;
  /** The **shared** scope, owned by the Export screen above both engines. */
  scopeRequest?: ExportScopeRequest;
  /** Level-A template settings. PDF only — `packages/docx` has no equivalent. */
  settings?: PdfTemplateSettings;
  /** Lets the screen interpose a confirmation (space scope) before starting. */
  gate?: (run: () => void) => void;
}): React.JSX.Element {
  const t = useT();
  const { pdf, startPdf, cancelPdf } = useExportRuns();
  const ready = page !== null && pageUrl !== null;

  return (
    <section data-testid="pdf-section" className="flex flex-col gap-2">
      <SectionHeading>{t("pdf.title")}</SectionHeading>
      {/*
        Stays true for v1: 007's Level-B custom-Typst render path does not
        exist, so there is deliberately no PDF template upload control here —
        only the settings form below, which tunes the built-in design.
      */}
      <p className="m-0 text-xs text-muted-foreground">{t("pdf.builtIn")}</p>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            if (ready && !pdf.phase) {
              gate(() =>
                startPdf(port, {
                  page,
                  pageUrl,
                  ...scopeRequest,
                  ...(settings ? { settings } : {}),
                })
              );
            }
          }}
          disabled={!ready || Boolean(pdf.phase)}
          data-testid="pdf-export"
          title={ready ? t("pdf.export") : t("pdf.needsPage")}
        >
          {pdf.phase ? t(PHASE_KEYS[pdf.phase]) : t("pdf.export")}
        </Button>
        {/*
          Cancel stays reachable for the whole run, including the tree walk:
          the provider's `AbortController` is the same signal the port hands to
          `fetchExportTree`, so cancelling mid-walk stops fetching rather than
          only skipping a compile that never started.
        */}
        {pdf.phase && (
          <Button variant="outline" onClick={cancelPdf} data-testid="pdf-cancel">
            {t("pdf.cancel")}
          </Button>
        )}
      </div>

      {pdf.progress && pdf.progress.total > 0 && (
        <p className="m-0 text-xs text-muted-foreground" data-testid="pdf-progress">
          {t("export.progress", {
            fetched: pdf.progress.fetched,
            total: pdf.progress.total,
            title: pdf.progress.currentTitle ?? "",
          })}
        </p>
      )}

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

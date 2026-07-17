import React, { useEffect, useRef, useState } from "react";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../../utils/read-path.js";
import type { PdfExportPhase } from "../../utils/pdf/run-export.js";

const PHASE_LABEL: Record<PdfExportPhase, string> = {
  preparing: "Preparing content…",
  fetching: "Fetching attachments…",
  queued: "Queued for PDF compiler…",
  compiling: "Compiling PDF…",
  validating: "Validating PDF…",
  downloading: "Downloading…",
};

export function PdfSection({
  loadedPage,
  pageUrl,
}: {
  loadedPage: LoadedPage | null;
  pageUrl: string | null;
}): React.JSX.Element {
  const [phase, setPhase] = useState<PdfExportPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PdfExportReport | null>(null);
  const active = useRef<{ identity: string; controller: AbortController } | null>(null);
  const identity = loadedPage && pageUrl
    ? `${pageUrl}|${loadedPage.details.id}|${loadedPage.details.version ?? ""}`
    : "";

  useEffect(() => {
    if (active.current && active.current.identity !== identity) {
      active.current.controller.abort();
      active.current = null;
      setPhase(null);
      setReport(null);
    }
  }, [identity]);

  useEffect(() => () => active.current?.controller.abort(), []);

  async function exportPdf(): Promise<void> {
    if (!loadedPage || !pageUrl || phase) return;
    const controller = new AbortController();
    active.current = { identity, controller };
    setError(null);
    setReport(null);
    setPhase("preparing");
    try {
      const { runPdfExport } = await import("../../utils/pdf/run-export.js");
      const result = await runPdfExport({
        page: loadedPage,
        pageUrl,
        signal: controller.signal,
        onPhase: setPhase,
      });
      if (!controller.signal.aborted && active.current?.identity === identity) setReport(result);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (active.current?.controller === controller) active.current = null;
      if (!controller.signal.aborted) setPhase(null);
    }
  }

  function cancel(): void {
    active.current?.controller.abort();
    active.current = null;
    setPhase(null);
    setError("PDF export was cancelled.");
  }

  return (
    <section data-testid="pdf-section" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", color: "#666" }}>PDF export</h2>
      <p style={{ color: "#6b778c", margin: "0 0 8px" }}>
        Uses the built-in atlcli document design. No template upload required.
      </p>
      <button
        type="button"
        onClick={() => void exportPdf()}
        disabled={!loadedPage || Boolean(phase)}
        data-testid="pdf-export"
        title={loadedPage ? "Export this page to PDF" : "Open a Confluence page to export"}
      >
        {phase ? PHASE_LABEL[phase] : "Export to PDF"}
      </button>
      {phase && (
        <button type="button" onClick={cancel} data-testid="pdf-cancel" style={{ marginLeft: 8 }}>
          Cancel
        </button>
      )}
      {error && <p role="alert" data-testid="pdf-error" style={{ color: "#bf2600" }}>{error}</p>}
      {report && <PdfReportView report={report} />}
    </section>
  );
}

export function PdfReportView({ report }: { report: PdfExportReport }): React.JSX.Element {
  return (
    <div data-testid="pdf-report" style={{ marginTop: 8, padding: 8, background: "#e3fcef", borderRadius: 4 }}>
      <strong>{report.filename}</strong>
      <div>{formatDuration(report.timings.totalMs)} · {report.embeddedImages} image(s) · {report.renderedDiagrams} diagram(s)</div>
      <div
        aria-label="PDF export timing breakdown"
        style={{ marginTop: 2, color: "#42526e", fontSize: 12 }}
      >
        Prepare {formatDuration(report.timings.prepareMs)} · Compile {formatDuration(report.timings.compileMs)} · Download {formatDuration(report.timings.emitMs)}
      </div>
      {report.notes.length > 0 && (
        <details>
          <summary>{report.notes.length} note(s)</summary>
          <ul>{report.notes.map((note, index) => <li key={`${note.code}-${index}`}>{note.message}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 1000) return `${Math.round(safeMilliseconds)} ms`;
  return `${(safeMilliseconds / 1000).toFixed(1)} s`;
}

/**
 * Where Export screen state lives (spec 010 Phase 0).
 *
 * In-flight export state is held ABOVE the screen registry, not inside
 * `PdfExportPanel` / `DocxExportPanel`. Once navigation is a registry lookup,
 * a screen unmounts when the user opens Settings — and state owned by the
 * screen would take a running export with it. That is the same class of defect
 * as CONFCLOUD-83694, just at the UI layer, so the state is hoisted from the
 * start.
 *
 * What is deliberately NOT changed here: a page change still aborts the active
 * export (preserving `PdfSection.tsx:30-37`'s behaviour verbatim). Turning that
 * into "identity change stops *watching*, never aborts" is T5.1/T5.6 work with
 * its own durable-job machinery behind it; doing half of it here would ship a
 * running export nobody can observe or cancel.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ExportReport } from "@atlcli/docx/browser";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import type {
  DocxExportPort,
  DocxExportRequest,
  ExportPhase,
  PdfExportPort,
  PdfExportRequest,
} from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import { exportErrorMessage } from "../export/docx-template.js";

export interface PdfRun {
  phase: ExportPhase | null;
  error: string | null;
  report: PdfExportReport | null;
}

export interface DocxRun {
  running: boolean;
  error: string | null;
  report: ExportReport | null;
}

const IDLE_PDF: PdfRun = { phase: null, error: null, report: null };
const IDLE_DOCX: DocxRun = { running: false, error: null, report: null };

export interface ExportRuns {
  pdf: PdfRun;
  docx: DocxRun;
  startPdf(port: PdfExportPort, request: Omit<PdfExportRequest, "signal" | "onPhase">): void;
  cancelPdf(): void;
  startDocx(port: DocxExportPort, request: Omit<DocxExportRequest, "signal">): void;
  /** Surface an error raised outside a run (template upload, store read). */
  setDocxError(message: string | null): void;
}

const ExportRunsContext = createContext<ExportRuns | null>(null);

interface ActiveRun {
  identity: string;
  controller: AbortController;
}

export function ExportRunsProvider({
  identity,
  children,
}: {
  /** Discriminates "the same page" from "a different page". */
  identity: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useT();
  const [pdf, setPdf] = useState<PdfRun>(IDLE_PDF);
  const [docx, setDocx] = useState<DocxRun>(IDLE_DOCX);
  const pdfRun = useRef<ActiveRun | null>(null);
  const docxRun = useRef<ActiveRun | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  useEffect(() => {
    if (pdfRun.current && pdfRun.current.identity !== identity) {
      pdfRun.current.controller.abort();
      pdfRun.current = null;
      setPdf(IDLE_PDF);
    }
    if (docxRun.current && docxRun.current.identity !== identity) {
      docxRun.current.controller.abort();
      docxRun.current = null;
      setDocx(IDLE_DOCX);
    }
  }, [identity]);

  // Unmount (panel closed) tears down anything still running: without a durable
  // job record (T5.6) an orphaned run has no observer left.
  useEffect(
    () => () => {
      pdfRun.current?.controller.abort();
      docxRun.current?.controller.abort();
    },
    []
  );

  const startPdf = useCallback<ExportRuns["startPdf"]>(
    (port, request) => {
      if (pdfRun.current) return;
      const runIdentity = identityRef.current;
      const controller = new AbortController();
      pdfRun.current = { identity: runIdentity, controller };
      setPdf({ phase: "preparing", error: null, report: null });

      void (async () => {
        try {
          const report = await port.run({
            ...request,
            signal: controller.signal,
            onPhase: (phase) => {
              if (!controller.signal.aborted) setPdf((prev) => ({ ...prev, phase }));
            },
          });
          if (!controller.signal.aborted && identityRef.current === runIdentity) {
            setPdf({ phase: null, error: null, report });
          }
        } catch (reason) {
          if (!controller.signal.aborted) {
            setPdf({
              phase: null,
              report: null,
              error: reason instanceof Error ? reason.message : String(reason),
            });
          }
        } finally {
          if (pdfRun.current?.controller === controller) pdfRun.current = null;
        }
      })();
    },
    []
  );

  const cancelPdf = useCallback<ExportRuns["cancelPdf"]>(() => {
    pdfRun.current?.controller.abort();
    pdfRun.current = null;
    setPdf({ phase: null, report: null, error: t("pdf.cancelled") });
  }, [t]);

  const startDocx = useCallback<ExportRuns["startDocx"]>(
    (port, request) => {
      if (docxRun.current) return;
      const runIdentity = identityRef.current;
      const controller = new AbortController();
      docxRun.current = { identity: runIdentity, controller };
      setDocx({ running: true, error: null, report: null });

      void (async () => {
        try {
          const report = await port.run({ ...request, signal: controller.signal });
          if (!controller.signal.aborted && identityRef.current === runIdentity) {
            setDocx({ running: false, error: null, report });
          }
        } catch (reason) {
          if (!controller.signal.aborted) {
            setDocx({ running: false, report: null, error: exportErrorMessage(t, reason) });
          }
        } finally {
          if (docxRun.current?.controller === controller) docxRun.current = null;
        }
      })();
    },
    [t]
  );

  const setDocxError = useCallback<ExportRuns["setDocxError"]>((message) => {
    setDocx((prev) => ({ ...prev, error: message }));
  }, []);

  const value = useMemo<ExportRuns>(
    () => ({ pdf, docx, startPdf, cancelPdf, startDocx, setDocxError }),
    [pdf, docx, startPdf, cancelPdf, startDocx, setDocxError]
  );

  return <ExportRunsContext.Provider value={value}>{children}</ExportRunsContext.Provider>;
}

export function useExportRuns(): ExportRuns {
  const context = useContext(ExportRunsContext);
  if (!context) {
    throw new Error("useExportRuns must be used inside an <ExportRunsProvider>.");
  }
  return context;
}

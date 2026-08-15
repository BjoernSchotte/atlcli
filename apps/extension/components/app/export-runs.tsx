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
 * Phase 0 deliberately kept `PdfSection.tsx:30-37`'s "a page change aborts the
 * export" behaviour verbatim, because half of the fix without durable records
 * would have shipped a running export nobody could observe or cancel. T5.6
 * built the other half, so it lands here: **an identity change stops watching
 * an export, it never aborts one.** Both PDF and DOCX are durable background
 * jobs now; Activity remains their owner and observer after the panel detaches.
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
  ExportProgress,
  PdfExportPort,
  PdfExportRequest,
} from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import { exportErrorMessage } from "../export/docx-template.js";

export interface PdfRun {
  phase: ExportPhase | null;
  error: string | null;
  report: PdfExportReport | null;
  /** Per-page tree-walk ticks (T5.1); `null` outside a multi-page walk. */
  progress: ExportProgress | null;
}

export interface DocxRun {
  running: boolean;
  error: string | null;
  report: ExportReport | null;
  progress: ExportProgress | null;
}

const IDLE_PDF: PdfRun = { phase: null, error: null, report: null, progress: null };
const IDLE_DOCX: DocxRun = { running: false, error: null, report: null, progress: null };

/** What a caller supplies; the provider owns `signal` and the callbacks. */
export type StartPdfRequest = Omit<PdfExportRequest, "signal" | "onPhase" | "onProgress">;
export type StartDocxRequest = Omit<
  DocxExportRequest,
  "signal" | "onPhase" | "onProgress"
>;

export interface ExportRuns {
  pdf: PdfRun;
  docx: DocxRun;
  startPdf(port: PdfExportPort, request: StartPdfRequest): void;
  cancelPdf(): void;
  startDocx(port: DocxExportPort, request: StartDocxRequest): void;
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
    // A page change STOPS WATCHING an export; it never aborts one
    // (spec 010 T5.6, Architecture point 3 defect (a)). Aborting here was
    // CONFCLOUD-83694 reproduced in our own panel: navigating to another
    // Confluence page killed a running export by design. It looked harmless
    // while every export was one page and took seconds; tree and space exports
    // make it the normal case, and the Chrome side panel survives tab
    // navigation on its own, so this was our decision and not a platform limit.
    // The job keeps running, its durable record keeps being updated, and the
    // Jobs screen is where it is observed and cancelled from. Abort stays bound
    // to an explicit cancellation action.
    if (pdfRun.current && pdfRun.current.identity !== identity) {
      pdfRun.current = null;
      setPdf(IDLE_PDF);
    }
    // DOCX now has the same durable outer record and offscreen ownership.
    if (docxRun.current && docxRun.current.identity !== identity) {
      docxRun.current = null;
      setDocx(IDLE_DOCX);
    }
  }, [identity]);

  const startPdf = useCallback<ExportRuns["startPdf"]>(
    (port, request) => {
      if (pdfRun.current) return;
      const runIdentity = identityRef.current;
      const controller = new AbortController();
      pdfRun.current = { identity: runIdentity, controller };
      setPdf({ phase: "preparing", error: null, report: null, progress: null });

      void (async () => {
        try {
          const report = await port.run({
            ...request,
            signal: controller.signal,
            onPhase: (phase) => {
              if (!controller.signal.aborted) setPdf((prev) => ({ ...prev, phase }));
            },
            onProgress: (progress) => {
              if (!controller.signal.aborted) setPdf((prev) => ({ ...prev, progress }));
            },
          });
          if (!controller.signal.aborted && identityRef.current === runIdentity) {
            setPdf({ phase: null, error: null, report, progress: null });
          }
        } catch (reason) {
          if (!controller.signal.aborted) {
            setPdf({
              phase: null,
              report: null,
              progress: null,
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
    setPdf({ phase: null, report: null, progress: null, error: t("pdf.cancelled") });
  }, [t]);

  const startDocx = useCallback<ExportRuns["startDocx"]>(
    (port, request) => {
      if (docxRun.current) return;
      const runIdentity = identityRef.current;
      const controller = new AbortController();
      docxRun.current = { identity: runIdentity, controller };
      setDocx({ running: true, error: null, report: null, progress: null });

      void (async () => {
        try {
          const report = await port.run({
            ...request,
            signal: controller.signal,
            onProgress: (progress) => {
              if (!controller.signal.aborted) setDocx((prev) => ({ ...prev, progress }));
            },
          });
          if (!controller.signal.aborted && identityRef.current === runIdentity) {
            setDocx({ running: false, error: null, report, progress: null });
          }
        } catch (reason) {
          if (!controller.signal.aborted) {
            setDocx({
              running: false,
              report: null,
              progress: null,
              error: exportErrorMessage(t, reason),
            });
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

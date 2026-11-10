import type { PdfExportReport } from "@atlcli/pdf/browser";
import { downloadBytes } from "../download.js";
import type { PdfExportRequest } from "../ports/export.js";
import type { IndexedDbExportJobCatalog } from "./catalog.js";
import type { IndexedDbExportByteStore } from "./chunk-store.js";
import { readExtensionPdfExportReport } from "./executor-store.js";
import {
  chromePdfExportSubmissionDeps,
  submitExtensionPdfExport,
} from "./pdf-submit.js";
import {
  chromeExportJobsChanged,
  observeSubmittedExport,
  type ObserveSubmittedExportDepsV1,
} from "./run-observer.js";

export type RunSubmittedExtensionPdfExportDepsV1 =
  ObserveSubmittedExportDepsV1<PdfExportRequest, PdfExportReport>;

/** Submit a PDF export, then observe its durable job (see `run-observer.ts`). */
export function runSubmittedExtensionPdfExport(
  request: PdfExportRequest,
  deps: RunSubmittedExtensionPdfExportDepsV1,
): Promise<PdfExportReport> {
  return observeSubmittedExport("PDF", request, deps);
}

export function chromeExtensionPdfRunDeps(): RunSubmittedExtensionPdfExportDepsV1 {
  const submission = chromePdfExportSubmissionDeps();
  const catalog = submission.catalog as IndexedDbExportJobCatalog;
  const bytes = submission.bytes as IndexedDbExportByteStore;
  return {
    submit: (request) => submitExtensionPdfExport(request, submission),
    catalog,
    bytes,
    readReport: (ref) => readExtensionPdfExportReport(ref, { bytes }),
    emit: ({ filename, bytes: output, mediaType, signal }) =>
      downloadBytes({
        name: filename,
        bytes: output,
        mimeType: mediaType,
        ...(signal ? { signal } : {}),
      }),
    onChanged: chromeExportJobsChanged,
  };
}

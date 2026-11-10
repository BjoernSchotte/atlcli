import type { ExportReport } from "@atlcli/docx/browser";
import { downloadBytes } from "../download.js";
import type { DocxExportRequest } from "../ports/export.js";
import type { IndexedDbExportJobCatalog } from "./catalog.js";
import { IndexedDbExportByteStore } from "./chunk-store.js";
import { readExtensionDocxExportReport } from "./docx-executor-store.js";
import {
  chromeDocxExportSubmissionDeps,
  submitExtensionDocxExport,
} from "./docx-submit.js";
import {
  chromeExportJobsChanged,
  observeSubmittedExport,
  type ObserveSubmittedExportDepsV1,
} from "./run-observer.js";

export type RunSubmittedExtensionDocxExportDepsV1 =
  ObserveSubmittedExportDepsV1<DocxExportRequest, ExportReport>;

/** Submit a DOCX export, then observe its durable job (see `run-observer.ts`). */
export function runSubmittedExtensionDocxExport(
  request: DocxExportRequest,
  deps: RunSubmittedExtensionDocxExportDepsV1,
): Promise<ExportReport> {
  return observeSubmittedExport("DOCX", request, deps);
}

export function chromeExtensionDocxRunDeps(): RunSubmittedExtensionDocxExportDepsV1 {
  const submission = chromeDocxExportSubmissionDeps();
  return {
    submit: (request) => submitExtensionDocxExport(request, submission),
    catalog: submission.catalog as IndexedDbExportJobCatalog,
    bytes: new IndexedDbExportByteStore(),
    readReport: (ref) => readExtensionDocxExportReport(ref),
    emit: ({ filename, bytes, mediaType, signal }) =>
      downloadBytes({
        name: filename,
        bytes,
        mimeType: mediaType,
        ...(signal ? { signal } : {}),
      }),
    onChanged: chromeExportJobsChanged,
  };
}

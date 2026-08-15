/**
 * Local ES-module bootstrap for PDF.js' modern worker build.
 *
 * Top-level await makes bootstrap readiness identical to upstream-worker
 * readiness: an import failure becomes a Worker error instead of an unobserved
 * rejected promise. Re-exporting `WorkerMessageHandler` is equally important:
 * PDF.js imports `workerSrc` on the main thread when it has to fall back to its
 * LoopbackPort implementation.
 */
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline";
import { ensurePdfjsModernBuiltins } from "./pdfjs-modern-builtins.js";

ensurePdfjsModernBuiltins();
const workerModule = (await import(/* @vite-ignore */ pdfjsWorkerUrl)) as {
  WorkerMessageHandler: unknown;
};

export const WorkerMessageHandler = workerModule.WorkerMessageHandler;

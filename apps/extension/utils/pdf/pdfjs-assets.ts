/**
 * Emitted URLs of the vendored PDF.js runtime (spec 010 T5.3).
 *
 * Isolated in its own module for two reasons:
 *
 *   1. `?url&no-inline` is a **build-time** transform. A module that imports it
 *      cannot be loaded by a plain module runner (Bun's test runner resolves
 *      the specifier to the real `.mjs` and fails on the missing default
 *      export). Keeping the two imports here lets `viewer.ts` — which holds all
 *      the logic worth testing — stay importable in unit tests, and lets the
 *      viewer reach these URLs through a dynamic `import()` only on the real
 *      code path.
 *   2. It makes the vendoring decision a single, greppable file: both runtime
 *      files come from `pdfjs-dist/build/` and are emitted **verbatim**, which
 *      is what makes their sha256 pins in `scripts/check-output-build.ts`
 *      meaningful.
 */
import pdfjsModuleUrl from "pdfjs-dist/build/pdf.min.mjs?url&no-inline";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline";

/** Emitted URL of the PDF.js library (unmodified upstream bytes). */
export const PDFJS_MODULE_URL: string = pdfjsModuleUrl;
/** Emitted URL of the PDF.js worker (unmodified upstream bytes). */
export const PDFJS_WORKER_URL: string = pdfjsWorkerUrl;

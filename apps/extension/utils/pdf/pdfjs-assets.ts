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
 *   2. It makes the runtime entry URLs greppable. The viewer asset is emitted
 *      verbatim here. `PDFJS_WORKER_URL` points at a local ES-module bootstrap;
 *      that bootstrap separately emits/imports the verbatim upstream worker,
 *      whose sha256 remains pinned by `scripts/check-output-build.ts`.
 */
import pdfjsModuleUrl from "pdfjs-dist/build/pdf.min.mjs?url&no-inline";
import pdfjsWorkerBootstrapUrl from "./pdfjs-worker-bootstrap.ts?worker&url";

/** Emitted URL of the PDF.js library (unmodified upstream bytes). */
export const PDFJS_MODULE_URL: string = pdfjsModuleUrl;
/** Emitted URL of the local ES-module bootstrap for the pinned upstream worker. */
export const PDFJS_WORKER_URL: string = pdfjsWorkerBootstrapUrl;

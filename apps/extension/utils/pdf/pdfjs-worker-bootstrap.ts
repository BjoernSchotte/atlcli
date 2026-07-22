/**
 * Local module-worker bootstrap for PDF.js' modern build.
 *
 * The upstream worker remains a verbatim `?url&no-inline` asset covered by the
 * output gate's SHA-256 pin. This small local module only installs the same
 * compatibility operations as the viewer realm before evaluating that asset.
 */
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline";
import { ensurePdfjsModernBuiltins } from "./pdfjs-modern-builtins.js";

ensurePdfjsModernBuiltins();
void import(/* @vite-ignore */ pdfjsWorkerUrl);

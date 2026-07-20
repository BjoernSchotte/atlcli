/// <reference lib="webworker" />

import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
import sansItalicUrl from "@atlcli/pdf/fonts/SourceSans3-It.ttf?url";
import sansSemiBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Semibold.ttf?url";
import sansBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Bold.ttf?url";
import serifRegularUrl from "@atlcli/pdf/fonts/SourceSerif4-Regular.ttf?url";
import serifItalicUrl from "@atlcli/pdf/fonts/SourceSerif4-It.ttf?url";
import serifSemiBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf?url";
import serifBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Bold.ttf?url";
import codeRegularUrl from "@atlcli/pdf/fonts/SourceCodePro-Regular.ttf?url";
import codeBoldUrl from "@atlcli/pdf/fonts/SourceCodePro-Bold.ttf?url";
import sansLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Sans-3.txt?url&no-inline";
import serifLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Serif-4.txt?url&no-inline";
import codeLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Code-Pro.txt?url&no-inline";
import compilerLicenseUrl from "../../../LICENSE?url&no-inline";
import {
  BrowserPdfCompiler,
} from "@atlcli/pdf-compiler-browser";
import { PDF_RUNTIME_ASSETS, formatPdfCompilerDiagnostics } from "@atlcli/pdf/browser";
import {
  claimPdfJob,
  completePdfJob,
  failPdfJob,
  getPdfJob,
} from "../utils/pdf/job-store.js";
import type { PdfWorkerRequest, PdfWorkerResponse } from "../utils/pdf/worker-protocol.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Packaged PDF compiler asset failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let compilerPromise: Promise<BrowserPdfCompiler> | null = null;
const fontUrls = new Map<string, string>([
  ["SourceSans3-Regular.ttf", sansRegularUrl],
  ["SourceSans3-It.ttf", sansItalicUrl],
  ["SourceSans3-Semibold.ttf", sansSemiBoldUrl],
  ["SourceSans3-Bold.ttf", sansBoldUrl],
  ["SourceSerif4-Regular.ttf", serifRegularUrl],
  ["SourceSerif4-It.ttf", serifItalicUrl],
  ["SourceSerif4-Semibold.ttf", serifSemiBoldUrl],
  ["SourceSerif4-Bold.ttf", serifBoldUrl],
  ["SourceCodePro-Regular.ttf", codeRegularUrl],
  ["SourceCodePro-Bold.ttf", codeBoldUrl],
]);
const licenseUrls = new Map<string, string>([
  ["LICENSE-Source-Sans-3.txt", sansLicenseUrl],
  ["LICENSE-Source-Serif-4.txt", serifLicenseUrl],
  ["LICENSE-Source-Code-Pro.txt", codeLicenseUrl],
]);

function sameNames(actual: Iterable<string>, expected: Iterable<string>): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function assertStaticAssetParity(): void {
  if (!sameNames(fontUrls.keys(), PDF_RUNTIME_ASSETS.fonts.map((asset) => asset.fileName))) {
    throw new Error("Extension PDF font imports do not match the canonical manifest.");
  }
  if (!sameNames(licenseUrls.keys(), PDF_RUNTIME_ASSETS.licenses.map((asset) => asset.fileName))) {
    throw new Error("Extension PDF license imports do not match the canonical manifest.");
  }
  // The static import itself is the compile-time existence proof. Avoid a
  // unary truthiness check because Vite rewrites `?url` bindings to URL
  // expressions and can otherwise change operator precedence in output.
  if (PDF_RUNTIME_ASSETS.compilerLicense.fileName !== "LICENSE") {
    throw new Error("Extension compiler license import does not match the canonical manifest.");
  }
}

function getCompiler(): Promise<BrowserPdfCompiler> {
  if (!compilerPromise) {
    assertStaticAssetParity();
    compilerPromise = Promise.all([
      fetchBytes(wasmUrl),
      ...PDF_RUNTIME_ASSETS.fonts.map((asset) => fetchBytes(fontUrls.get(asset.fileName)!)),
      ...PDF_RUNTIME_ASSETS.licenses.map((asset) => fetchBytes(licenseUrls.get(asset.fileName)!)),
      fetchBytes(compilerLicenseUrl),
    ])
      .then(([wasm, ...fontAndLicenseBytes]) => new BrowserPdfCompiler({
        wasm: wasm.buffer,
        fonts: fontAndLicenseBytes.slice(0, PDF_RUNTIME_ASSETS.fonts.length),
      }))
      .catch((error) => {
        compilerPromise = null;
        throw error;
      });
  }
  return compilerPromise;
}

async function compileJob(jobId: string): Promise<PdfWorkerResponse> {
  try {
    const claimed = await claimPdfJob(jobId);
    if (!claimed || claimed.status !== "compiling") {
      throw new Error("PDF job is missing, cancelled, or no longer ready to compile.");
    }
    const compiler = await getCompiler();
    const result = await compiler.compile(claimed.bundle);
    if (!result.pdf) {
      const error = formatPdfCompilerDiagnostics(result.diagnostics);
      await failPdfJob(jobId, error, result.diagnostics);
      return { kind: "pdf-worker:complete", jobId, ok: false, error, fatal: false };
    }
    const completed = await completePdfJob(jobId, {
      pdf: result.pdf,
      diagnostics: result.diagnostics,
      compilerVersion: result.compilerVersion,
    });
    if (!completed || completed.status !== "complete") {
      throw new Error("PDF job was cancelled before the result could be stored.");
    }
    return { kind: "pdf-worker:complete", jobId, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await getPdfJob(jobId).catch(() => undefined);
    if (current?.status === "prepared" || current?.status === "compiling") {
      await failPdfJob(jobId, message).catch(() => undefined);
    }
    return { kind: "pdf-worker:complete", jobId, ok: false, error: message, fatal: true };
  }
}

workerScope.addEventListener("message", (event: MessageEvent<PdfWorkerRequest>) => {
  if (event.data?.kind !== "pdf-worker:compile") return;
  void compileJob(event.data.jobId).then((response) => workerScope.postMessage(response));
});

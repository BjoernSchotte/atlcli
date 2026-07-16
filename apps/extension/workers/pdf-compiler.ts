/// <reference lib="webworker" />

import wasmUrl from "@myriaddreamin/typst-ts-web-compiler/wasm?url";
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
  PDF_COMPILER_VERSION,
  formatPdfDiagnostics,
} from "../utils/pdf/compiler.js";
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
const packagedLicenses = [sansLicenseUrl, serifLicenseUrl, codeLicenseUrl, compilerLicenseUrl];

function getCompiler(): Promise<BrowserPdfCompiler> {
  if (!compilerPromise) {
    if (packagedLicenses.some((url) => !url)) {
      return Promise.reject(new Error("PDF runtime license assets are missing."));
    }
    compilerPromise = Promise.all([
      fetchBytes(wasmUrl),
      fetchBytes(sansRegularUrl),
      fetchBytes(sansItalicUrl),
      fetchBytes(sansSemiBoldUrl),
      fetchBytes(sansBoldUrl),
      fetchBytes(serifRegularUrl),
      fetchBytes(serifItalicUrl),
      fetchBytes(serifSemiBoldUrl),
      fetchBytes(serifBoldUrl),
      fetchBytes(codeRegularUrl),
      fetchBytes(codeBoldUrl),
    ])
      .then(([wasm, ...fonts]) => new BrowserPdfCompiler({ wasm: wasm.buffer, fonts }))
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
      const error = formatPdfDiagnostics(result.diagnostics, claimed.bundle.sourceMap);
      await failPdfJob(jobId, error, result.diagnostics);
      return { kind: "pdf-worker:complete", jobId, ok: false, error, fatal: false };
    }
    const completed = await completePdfJob(jobId, {
      pdf: result.pdf,
      diagnostics: result.diagnostics,
      compilerVersion: PDF_COMPILER_VERSION,
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

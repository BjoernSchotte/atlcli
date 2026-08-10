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
import symbolsRegularUrl from "@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf?url";
import emojiRegularUrl from "@atlcli/pdf/fonts/NotoEmoji-wght.ttf?url";
import arabicRegularUrl from "@atlcli/pdf/fonts/NotoSansArabic-Regular.ttf?url";
import sansLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Sans-3.txt?url&no-inline";
import serifLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Serif-4.txt?url&no-inline";
import codeLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Source-Code-Pro.txt?url&no-inline";
import symbolsLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Noto-Sans-Symbols-2.txt?url&no-inline";
import emojiLicenseUrl from "@atlcli/pdf/licenses/LICENSE-Noto-Emoji.txt?url&no-inline";
import compilerLicenseUrl from "../../../LICENSE?url&no-inline";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import type { PdfCompileContext, PdfCompileResult } from "@atlcli/pdf/browser";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./pdf-worker-protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

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
  ["NotoSansArabic-Regular.ttf", arabicRegularUrl],
  ["NotoSansSymbols2-Regular.ttf", symbolsRegularUrl],
  ["NotoEmoji-wght.ttf", emojiRegularUrl],
]);

const licenseUrls = new Map<string, string>([
  ["LICENSE-Source-Sans-3.txt", sansLicenseUrl],
  ["LICENSE-Source-Serif-4.txt", serifLicenseUrl],
  ["LICENSE-Source-Code-Pro.txt", codeLicenseUrl],
  ["LICENSE-Noto-Sans-Symbols-2.txt", symbolsLicenseUrl],
  ["LICENSE-Noto-Emoji.txt", emojiLicenseUrl],
]);

function sameNames(actual: Iterable<string>, expected: Iterable<string>): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function assertStaticAssetParity(): void {
  if (!sameNames(fontUrls.keys(), PDF_RUNTIME_ASSETS.fonts.map((asset) => asset.fileName))) {
    throw new Error("The harness's static PDF font imports do not match the canonical manifest.");
  }
  if (!sameNames(licenseUrls.keys(), PDF_RUNTIME_ASSETS.licenses.map((asset) => asset.fileName))) {
    throw new Error("The harness's static PDF license imports do not match the canonical manifest.");
  }
  // The static import itself is the compile-time existence proof. Avoid a
  // unary truthiness check here: Vite rewrites `?url` bindings to URL
  // expressions, and `!binding` can lose parentheses during that transform.
  void compilerLicenseUrl;
  if (PDF_RUNTIME_ASSETS.compilerLicense.fileName !== "LICENSE") {
    throw new Error("The harness's compiler license import does not match the canonical manifest.");
  }
}

async function fetchBytes(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Packaged PDF runtime asset failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let compilerPromise: Promise<BrowserPdfCompiler> | null = null;

function getCompiler(): Promise<BrowserPdfCompiler> {
  if (compilerPromise) return compilerPromise;
  assertStaticAssetParity();
  compilerPromise = fetchBytes(wasmUrl)
    .then((wasm) => {
      const fonts = PDF_RUNTIME_ASSETS.fonts.map((asset) => ({
        assetId: asset.assetId,
        sha256: asset.sha256,
        load: (context: PdfCompileContext = {}) =>
          fetchBytes(fontUrls.get(asset.fileName)!, context.signal),
      }));
      return new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
    })
    .catch((error) => {
      compilerPromise = null;
      throw error;
    });
  return compilerPromise;
}

function transferableResult(result: PdfCompileResult): {
  result: PdfCompileResult;
  transfer: Transferable[];
} {
  if (!result.pdf) return { result, transfer: [] };
  const pdf = result.pdf.slice();
  return { result: { ...result, pdf }, transfer: [pdf.buffer] };
}

async function compile(request: PdfWorkerRequest): Promise<void> {
  try {
    const compiler = await getCompiler();
    const compiled = transferableResult(
      await compiler.compile(request.bundle, request.options ?? {}),
    );
    const response: PdfWorkerResponse = {
      kind: "result",
      requestId: request.requestId,
      ok: true,
      result: compiled.result,
    };
    scope.postMessage(response, compiled.transfer);
  } catch (error) {
    const response: PdfWorkerResponse = {
      kind: "result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  }
}

scope.addEventListener("message", (event: MessageEvent<PdfWorkerRequest>) => {
  if (event.data?.kind === "compile") void compile(event.data);
});

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
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import {
  claimPdfJob,
  completePdfJob,
} from "../../../utils/pdf/job-store.js";
import type {
  MemoryWorkerPhase,
  MemoryWorkerRequest,
  MemoryWorkerResponse,
} from "./protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const fontUrls = [
  sansRegularUrl,
  sansItalicUrl,
  sansSemiBoldUrl,
  sansBoldUrl,
  serifRegularUrl,
  serifItalicUrl,
  serifSemiBoldUrl,
  serifBoldUrl,
  codeRegularUrl,
  codeBoldUrl,
] as const;

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Memory harness asset failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let compilerPromise: Promise<BrowserPdfCompiler> | null = null;
let continueRun: (() => void) | null = null;

function postPhase(
  phase: Exclude<MemoryWorkerPhase, "error">,
  detail?: Record<string, number>
): void {
  const response: MemoryWorkerResponse = {
    kind: "phase",
    phase,
    ...(detail ? { detail } : {}),
  };
  scope.postMessage(response);
}

function waitForContinue(): Promise<void> {
  return new Promise((resolve) => {
    continueRun = resolve;
  });
}

function getCompiler(): Promise<BrowserPdfCompiler> {
  if (compilerPromise) return compilerPromise;
  compilerPromise = Promise.all([fetchBytes(wasmUrl), ...fontUrls.map(fetchBytes)]).then(
    ([wasm, ...fonts]) => new BrowserPdfCompiler({ wasm: wasm.buffer, fonts })
  );
  return compilerPromise;
}

async function warm(): Promise<void> {
  const compiler = await getCompiler();
  await compiler.getLoadedFonts();
  postPhase("warm");
}

async function compile(jobId: string): Promise<void> {
  const compiler = await getCompiler();
  const claimed = await claimPdfJob(jobId);
  if (!claimed?.bundle) throw new Error(`Memory harness could not claim PDF job ${jobId}.`);
  const bundleBytes =
    new TextEncoder().encode(claimed.bundle.main).byteLength +
    new TextEncoder().encode(claimed.bundle.template).byteLength +
    claimed.bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
  postPhase("bundle-received", { bundleBytes });
  await waitForContinue();

  const hook = Symbol.for("atlcli.pdf-compiler-browser.memory-probe.after-vfs-loaded");
  const host = globalThis as typeof globalThis &
    Record<symbol, (() => Promise<void>) | undefined>;
  host[hook] = async () => {
    postPhase("vfs-ready", { bundleBytes });
    await waitForContinue();
  };
  let result: Awaited<ReturnType<BrowserPdfCompiler["compile"]>>;
  try {
    result = await compiler.compile(claimed.bundle);
  } finally {
    delete host[hook];
  }
  if (!result.pdf) {
    throw new Error(`Memory fixture failed to compile: ${JSON.stringify(result.diagnostics)}`);
  }
  postPhase("compiled-held", { pdfBytes: result.pdf.byteLength });
  await waitForContinue();
  await completePdfJob(jobId, {
    pdf: result.pdf,
    diagnostics: result.diagnostics,
    compilerVersion: result.compilerVersion,
  });
  postPhase("complete", { pdfBytes: result.pdf.byteLength });
}

scope.addEventListener("message", (event: MessageEvent<MemoryWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "continue") {
    const resume = continueRun;
    continueRun = null;
    resume?.();
    return;
  }
  if (request.kind === "shutdown") {
    void compilerPromise?.then((compiler) => compiler.reset()).finally(() => scope.close());
    return;
  }
  const operation = request.kind === "warm" ? warm() : compile(request.jobId);
  void operation.catch((error) => {
    const response: MemoryWorkerResponse = {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  });
});

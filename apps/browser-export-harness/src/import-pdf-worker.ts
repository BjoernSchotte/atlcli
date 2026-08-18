/// <reference lib="webworker" />

import pdfiumWasmUrl from "@atlcli/import-pdf/wasm?url&no-inline";
import {
  createBrowserPdfiumFactsAdapter,
  normalizeUntaggedPdfFacts,
} from "@atlcli/import-pdf/browser-worker";
import type {
  ImportPdfWorkerRequest,
  ImportPdfWorkerResponse,
} from "./import-pdf-worker-protocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function sameOriginBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = new URL(url, scope.location.href);
  if (resolved.origin !== scope.location.origin) {
    throw new Error("The PDF importer runtime asset must be same-origin.");
  }
  const response = await fetch(resolved);
  if (!response.ok) {
    throw new Error(`The packaged PDFium asset failed to load (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function analyze(request: ImportPdfWorkerRequest): Promise<void> {
  try {
    const wasmBinary = await sameOriginBytes(pdfiumWasmUrl);
    const adapter = createBrowserPdfiumFactsAdapter({ wasmBinary });
    const analyzed = await adapter.analyze(request.bytes);
    const semantics = await normalizeUntaggedPdfFacts(
      analyzed.facts,
      analyzed.factsDigest,
    );
    const response: ImportPdfWorkerResponse = {
      kind: "result",
      requestId: request.requestId,
      ok: true,
      result: {
        pageCount: analyzed.facts.pageCount,
        complete: analyzed.facts.completeness.complete,
        classification: analyzed.facts.classification,
        engine: analyzed.facts.provenance.engine,
        engineVersion: analyzed.facts.provenance.engineVersion,
        wasmSha256: analyzed.facts.provenance.wasmSha256,
        factsDigest: analyzed.factsDigest,
        semanticDigest: semantics.semanticDigest,
        titleCandidate: semantics.document.titleCandidate ?? null,
        blockTypes: semantics.document.blocks.map((block) => block.type),
      },
    };
    scope.postMessage(response);
  } catch (error) {
    const response: ImportPdfWorkerResponse = {
      kind: "result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(response);
  }
}

scope.addEventListener("message", (event: MessageEvent<ImportPdfWorkerRequest>) => {
  if (event.data?.kind === "analyze") void analyze(event.data);
});

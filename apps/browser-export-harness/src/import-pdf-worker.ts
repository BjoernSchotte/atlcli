/// <reference lib="webworker" />

import pdfiumWasmUrl from "@atlcli/import-pdf/wasm?url&no-inline";
import {
  createBrowserPdfiumFactsAdapter,
  createBrowserPdfiumFactsAdapterV2,
  normalizeUntaggedPdfFacts,
  normalizeUntaggedPdfFactsV2,
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
    const analyzedV2 = await createBrowserPdfiumFactsAdapterV2({ wasmBinary })
      .analyze(request.bytes);
    const semantics = await normalizeUntaggedPdfFacts(
      analyzed.facts,
      analyzed.factsDigest,
    );
    const semanticsV2 = await normalizeUntaggedPdfFactsV2(
      analyzedV2.facts,
      analyzedV2.factsDigest,
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
        factsSchemaV2: analyzedV2.facts.schema,
        semanticSchemaV2: semanticsV2.schema,
        semanticDigestV2: semanticsV2.semanticDigest,
        boundaryCountV2: semanticsV2.boundaries.length,
        unresolvedBoundaryCountV2: semanticsV2.pageOutcomes.reduce(
          (count, page) => count + page.unresolvedBoundaryCount,
          0,
        ),
        pageModesV2: semanticsV2.pageOutcomes.map((page) => page.mode),
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

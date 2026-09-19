import fixtureUrl from "../../../specs/import-pdf-mvp/fixtures/simple-untagged.pdf?url&no-inline";
import {
  PDFIUM_ENGINE_VERSION,
  PDFIUM_WASM_SHA256,
} from "@atlcli/import-pdf/browser-worker";
import {
  isImportPdfWorkerResponse,
  type ImportPdfWorkerResponse,
} from "./import-pdf-worker-protocol.js";

export interface ImportPdfCaseResult {
  pageCount: number;
  complete: boolean;
  classification: string;
  engine: string;
  engineVersion: string;
  wasmSha256: string;
  factsDigest: string;
  semanticDigest: string;
  factsSchemaV2: string;
  semanticSchemaV2: string;
  semanticDigestV2: string;
  boundaryCountV2: number;
  unresolvedBoundaryCountV2: number;
  pageModesV2: string[];
  titleCandidate: string | null;
  blockTypes: string[];
  workerTerminated: boolean;
}

async function loadFixture(): Promise<Uint8Array<ArrayBuffer>> {
  const resolved = new URL(fixtureUrl, location.href);
  if (resolved.origin !== location.origin) {
    throw new Error("The PDF import fixture must be loaded from the harness origin.");
  }
  const response = await fetch(resolved);
  if (!response.ok) throw new Error(`The PDF import fixture failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function runWorker(bytes: Uint8Array<ArrayBuffer>): Promise<ImportPdfWorkerResponse> {
  const worker = new Worker(new URL("./import-pdf-worker.ts", import.meta.url), {
    type: "module",
    name: "atlcli-browser-harness-import-pdf",
  });
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("The PDF import Worker exceeded its 30 second harness deadline."));
    }, 30_000);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isImportPdfWorkerResponse(event.data) || event.data.requestId !== 1) return;
      window.clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "The PDF import Worker failed."));
    };
    worker.postMessage({ kind: "analyze", requestId: 1, bytes }, [bytes.buffer]);
  });
}

export async function runImportPdfCase(): Promise<ImportPdfCaseResult> {
  const response = await runWorker(await loadFixture());
  if (!response.ok) throw new Error(response.error);
  const result = response.result;
  if (
    result.pageCount !== 1
    || !result.complete
    || result.classification !== "digital-untagged"
    || result.engine !== "pdfium"
    || result.engineVersion !== PDFIUM_ENGINE_VERSION
    || result.wasmSha256 !== PDFIUM_WASM_SHA256
    || result.titleCandidate !== "Quarterly Garden Notes"
    || result.blockTypes.join(",") !== "heading,paragraph,paragraph,paragraph,heading,list"
    || !/^[a-f0-9]{64}$/u.test(result.factsDigest)
    || !/^[a-f0-9]{64}$/u.test(result.semanticDigest)
    || result.factsSchemaV2 !== "atlcli.pdf-facts/2"
    || result.semanticSchemaV2 !== "atlcli.pdf-untagged-semantics/2"
    || !/^[a-f0-9]{64}$/u.test(result.semanticDigestV2)
    || result.boundaryCountV2 !== 51
    || result.unresolvedBoundaryCountV2 !== 0
    || result.pageModesV2.join(",") !== "geometry-native"
  ) {
    throw new Error(`The browser PDF import facts drifted: ${JSON.stringify(result)}`);
  }
  return { ...result, workerTerminated: true };
}

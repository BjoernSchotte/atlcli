export interface ImportPdfWorkerRequest {
  kind: "analyze";
  requestId: number;
  bytes: Uint8Array;
}

export interface ImportPdfWorkerSuccess {
  kind: "result";
  requestId: number;
  ok: true;
  result: {
    pageCount: number;
    complete: boolean;
    classification: string;
    engine: string;
    engineVersion: string;
    wasmSha256: string;
    factsDigest: string;
    semanticDigest: string;
    titleCandidate: string | null;
    blockTypes: string[];
  };
}

export interface ImportPdfWorkerFailure {
  kind: "result";
  requestId: number;
  ok: false;
  error: string;
}

export type ImportPdfWorkerResponse = ImportPdfWorkerSuccess | ImportPdfWorkerFailure;

export function isImportPdfWorkerResponse(value: unknown): value is ImportPdfWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ImportPdfWorkerResponse>;
  return candidate.kind === "result"
    && typeof candidate.requestId === "number"
    && typeof candidate.ok === "boolean";
}

import type { PdfCompileResult, PdfSourceBundle } from "@atlcli/pdf/browser";

export interface PdfWorkerCompileRequest {
  kind: "compile";
  requestId: number;
  bundle: PdfSourceBundle;
}

export type PdfWorkerRequest = PdfWorkerCompileRequest;

export type PdfWorkerResponse =
  | {
      kind: "result";
      requestId: number;
      ok: true;
      result: PdfCompileResult;
    }
  | {
      kind: "result";
      requestId: number;
      ok: false;
      error: string;
    };

export function isPdfWorkerResponse(value: unknown): value is PdfWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PdfWorkerResponse>;
  return (
    candidate.kind === "result" &&
    typeof candidate.requestId === "number" &&
    typeof candidate.ok === "boolean"
  );
}

export type PdfWorkerRequest = { kind: "pdf-worker:compile"; jobId: string };

export type PdfWorkerResponse =
  | { kind: "pdf-worker:complete"; jobId: string; ok: true }
  | { kind: "pdf-worker:complete"; jobId: string; ok: false; error: string; fatal: boolean };

export function isPdfWorkerResponse(value: unknown): value is PdfWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PdfWorkerResponse>;
  return candidate.kind === "pdf-worker:complete" && typeof candidate.jobId === "string" && typeof candidate.ok === "boolean";
}

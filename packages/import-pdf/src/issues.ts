export type PdfImportErrorCode =
  | "pdf/input-type-invalid"
  | "pdf/adapter-busy"
  | "pdf/input-empty"
  | "pdf/input-too-large"
  | "pdf/signature-invalid"
  | "pdf/wasm-digest-mismatch"
  | "pdf/load-rejected"
  | "pdf/page-count-invalid"
  | "pdf/budget-exceeded"
  | "pdf/deadline-exceeded"
  | "pdf/cancelled"
  | "pdf/engine-failure"
  | "pdf/provenance-drift"
  | "pdf/asset-request-invalid"
  | "pdf/incomplete";

export class PdfImportError extends Error {
  readonly code: PdfImportErrorCode;
  readonly context?: Record<string, string | number>;

  constructor(
    code: PdfImportErrorCode,
    message: string,
    context?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "PdfImportError";
    this.code = code;
    this.context = context;
  }
}

export function isPdfImportError(error: unknown): error is PdfImportError {
  return error instanceof PdfImportError;
}

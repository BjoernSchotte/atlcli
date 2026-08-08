import type {
  PdfCompilerDiagnostic,
  PdfFontLoadEvidenceV1,
  PdfSourceBundle,
} from "./types.js";
import type {
  PdfOutputPolicyV1,
  TypstPdfOptions0151,
} from "./output-policy.js";

export interface PdfCompileResult {
  pdf?: Uint8Array;
  diagnostics: PdfCompilerDiagnostic[];
  compilerVersion: string;
  fontEvidence?: PdfFontLoadEvidenceV1;
}

export interface PdfCompileContext {
  signal?: AbortSignal;
  /** Strict request-scoped PDF standard selection; absent preserves legacy output. */
  outputPolicy?: PdfOutputPolicyV1;
  /** Auditable low-level Typst 0.15.1 seam; product callers use outputPolicy. */
  pdfOptions?: TypstPdfOptions0151;
}

export interface PdfCompilePort {
  compile(bundle: PdfSourceBundle, context?: PdfCompileContext): Promise<PdfCompileResult>;
}

export function formatPdfCompilerDiagnostics(diagnostics: PdfCompilerDiagnostic[]): string {
  if (diagnostics.length === 0) return "Typst produced no PDF and no diagnostics.";
  return diagnostics.map((diagnostic) => {
    const location = diagnostic.blockPath
      ? `${diagnostic.blockPath}: `
      : diagnostic.path
        ? `${diagnostic.path}${diagnostic.startLine ? `:${diagnostic.startLine}` : ""}: `
        : "";
    return `${location}${diagnostic.severity}: ${diagnostic.message}`;
  }).join("\n");
}

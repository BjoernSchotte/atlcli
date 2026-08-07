/** Exact low-level standard enum exposed by the pinned Typst 0.15.1 renderer. */
export const TYPST_PDF_STANDARDS_0_15_1 = [
  "1.4",
  "1.5",
  "1.6",
  "1.7",
  "2.0",
  "a-1b",
  "a-1a",
  "a-2b",
  "a-2u",
  "a-2a",
  "a-3b",
  "a-3u",
  "a-3a",
  "a-4",
  "a-4f",
  "a-4e",
  "ua-1",
] as const;

export type TypstPdfStandard0151 = (typeof TYPST_PDF_STANDARDS_0_15_1)[number];

/** Product-facing conformance choices; raw PDF-version selection is excluded. */
export const PDF_OUTPUT_STANDARDS_V1 = [
  "a-1b",
  "a-1a",
  "a-2b",
  "a-2u",
  "a-2a",
  "a-3b",
  "a-3u",
  "a-3a",
  "a-4",
  "a-4f",
  "a-4e",
  "ua-1",
] as const;

export type PdfOutputStandardV1 = (typeof PDF_OUTPUT_STANDARDS_V1)[number];

/** Typed low-level seam used only by compiler-adapter conformance tests. */
export interface TypstPdfOptions0151 {
  standard: TypstPdfStandard0151;
}

/**
 * Product-owned output policy. Explicit requests are strict: the compiler
 * either produces the requested standard or returns no PDF bytes.
 *
 * The pinned typst.ts binding accepts one `pdf_standard` value per snapshot,
 * so V1 deliberately rejects multi-standard requests even though Typst core
 * can model some compatible combinations.
 */
export interface PdfOutputPolicyV1 {
  schema: "atlcli.pdf-output-policy/1";
  standards: readonly [PdfOutputStandardV1, ...PdfOutputStandardV1[]];
}

export interface ResolvedPdfOutputPolicyV1 {
  schema: "atlcli.pdf-output-policy/1";
  standards: readonly [PdfOutputStandardV1];
  basePdfVersion: "1.4" | "1.5" | "1.6" | "1.7" | "2.0";
}

/** Evidence derived from the emitted bytes, never from the request alone. */
export interface PdfOutputStandardEvidenceV1 {
  schema: "atlcli.pdf-output-standard-evidence/1";
  requestedStandard: PdfOutputStandardV1;
  basePdfVersion: ResolvedPdfOutputPolicyV1["basePdfVersion"];
  pdfa?: {
    part: "1" | "2" | "3" | "4";
    conformance?: "A" | "B" | "E" | "F" | "U";
  };
  pdfua?: { part: "1" };
  hasDocumentIdentifier: boolean;
  tagged: boolean;
  hasLang: boolean;
  embeddedFontFiles: number;
}

export class PdfOutputPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfOutputPolicyError";
  }
}

const standards = new Set<string>(PDF_OUTPUT_STANDARDS_V1);

function basePdfVersion(
  standard: PdfOutputStandardV1,
): ResolvedPdfOutputPolicyV1["basePdfVersion"] {
  if (standard.startsWith("a-1")) return "1.4";
  if (standard.startsWith("a-4")) return "2.0";
  return "1.7";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolvePdfOutputPolicyV1(
  value: PdfOutputPolicyV1 | undefined,
): ResolvedPdfOutputPolicyV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new PdfOutputPolicyError("PDF output policy must be an object.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "schema" && key !== "standards")) {
    throw new PdfOutputPolicyError("PDF output policy contains an unknown field.");
  }
  if (value.schema !== "atlcli.pdf-output-policy/1") {
    throw new PdfOutputPolicyError("Unsupported PDF output policy schema.");
  }
  if (!Array.isArray(value.standards) || value.standards.length === 0) {
    throw new PdfOutputPolicyError("PDF output policy standards must be non-empty.");
  }
  for (const standard of value.standards) {
    if (typeof standard !== "string" || !standards.has(standard)) {
      throw new PdfOutputPolicyError(`Unsupported PDF output standard: ${String(standard)}.`);
    }
  }
  if (new Set(value.standards).size !== value.standards.length) {
    throw new PdfOutputPolicyError("PDF output standards must not contain duplicates.");
  }
  const indexes = value.standards.map((standard) =>
    PDF_OUTPUT_STANDARDS_V1.indexOf(standard as PdfOutputStandardV1)
  );
  if (indexes.some((index, position) => position > 0 && index < indexes[position - 1]!)) {
    throw new PdfOutputPolicyError("PDF output standards must use canonical order.");
  }
  if (value.standards.length !== 1) {
    throw new PdfOutputPolicyError(
      "The pinned Typst 0.15.1 browser binding supports exactly one PDF output standard per request.",
    );
  }
  const standard = value.standards[0] as PdfOutputStandardV1;
  return {
    schema: "atlcli.pdf-output-policy/1",
    standards: [standard],
    basePdfVersion: basePdfVersion(standard),
  };
}

export function resolveTypstPdfOptions0151(
  value: TypstPdfOptions0151 | undefined,
): TypstPdfOptions0151 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "standard")) {
    throw new PdfOutputPolicyError("Typst PDF options must contain only standard.");
  }
  if (
    typeof value.standard !== "string" ||
    !TYPST_PDF_STANDARDS_0_15_1.includes(value.standard as TypstPdfStandard0151)
  ) {
    throw new PdfOutputPolicyError(`Unsupported Typst 0.15.1 PDF standard: ${String(value.standard)}.`);
  }
  return { standard: value.standard as TypstPdfStandard0151 };
}

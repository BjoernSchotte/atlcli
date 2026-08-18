import { PdfImportError } from "./issues.js";

export const PDF_ANALYSIS_BUDGET_REVISION = "atlcli.pdf-analysis-budgets/1" as const;

export interface PdfAnalysisBudgets {
  maxInputBytes: number;
  maxPages: number;
  maxTotalMs: number;
  maxPageMs: number;
  maxTextItemsTotal: number;
  maxTextItemsPerPage: number;
  maxPageObjectsTotal: number;
  maxPageObjectsPerPage: number;
  maxStructureNodesTotal: number;
  maxStructureNodesPerPage: number;
  maxAssetsTotal: number;
  maxAssetsPerPage: number;
  maxDecodedPixelsTotal: number;
  maxDecodedPixelsPerAsset: number;
  maxDecodedBytesTotal: number;
  maxDecodedBytesPerAsset: number;
  maxEvidenceEntries: number;
  maxCanonicalBytes: number;
  maxPageObjectDepth: number;
  maxStructureDepth: number;
  maxOutlineDepth: number;
}

export const PDF_ANALYSIS_HARD_BUDGETS: Readonly<PdfAnalysisBudgets> = Object.freeze({
  maxInputBytes: 100 * 1024 * 1024,
  maxPages: 500,
  maxTotalMs: 120_000,
  maxPageMs: 10_000,
  maxTextItemsTotal: 2_000_000,
  maxTextItemsPerPage: 100_000,
  maxPageObjectsTotal: 5_000_000,
  maxPageObjectsPerPage: 250_000,
  maxStructureNodesTotal: 2_000_000,
  maxStructureNodesPerPage: 100_000,
  maxAssetsTotal: 5_000,
  maxAssetsPerPage: 500,
  maxDecodedPixelsTotal: 400_000_000,
  maxDecodedPixelsPerAsset: 80_000_000,
  maxDecodedBytesTotal: 250 * 1024 * 1024,
  maxDecodedBytesPerAsset: 25 * 1024 * 1024,
  maxEvidenceEntries: 250_000,
  maxCanonicalBytes: 50 * 1024 * 1024,
  maxPageObjectDepth: 64,
  maxStructureDepth: 64,
  maxOutlineDepth: 64,
});

export function resolvePdfAnalysisBudgets(
  requested: Partial<PdfAnalysisBudgets> | undefined,
): PdfAnalysisBudgets {
  const result = { ...PDF_ANALYSIS_HARD_BUDGETS };
  if (!requested) return result;
  for (const key of Object.keys(PDF_ANALYSIS_HARD_BUDGETS) as Array<keyof PdfAnalysisBudgets>) {
    const value = requested[key];
    if (value === undefined) continue;
    const hard = PDF_ANALYSIS_HARD_BUDGETS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > hard) {
      throw new PdfImportError(
        "pdf/budget-exceeded",
        `PDF budget ${key} must be an integer from 1 through ${hard}.`,
        { budget: key, actual: value, limit: hard },
      );
    }
    result[key] = value;
  }
  const unknown = Object.keys(requested).filter((key) => !(key in PDF_ANALYSIS_HARD_BUDGETS));
  if (unknown.length > 0) {
    throw new PdfImportError(
      "pdf/budget-exceeded",
      `Unknown PDF budget key(s): ${unknown.sort().join(", ")}.`,
    );
  }
  return result;
}

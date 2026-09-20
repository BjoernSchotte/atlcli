import type { ImportIssue, ImportOutcome } from "@atlcli/import-core";
import type {
  PdfTextAssemblyV2,
  PdfTextBoundaryDecisionV2,
  PdfTextTransformationV2,
} from "./text-assembly.js";

export interface PdfTextAssemblyAggregateV2 {
  boundaries: PdfTextBoundaryDecisionV2[];
  transformations: PdfTextTransformationV2[];
}

export function appendPdfTextAssemblyV2(
  target: PdfTextAssemblyAggregateV2,
  assembly: PdfTextAssemblyV2,
): void {
  target.boundaries.push(...assembly.boundaries);
  target.transformations.push(...assembly.transformations);
}

export function pdfTextBoundaryDecisionIdsV2(assembly: PdfTextAssemblyV2): string[] {
  return assembly.boundaries.map((boundary) => boundary.id);
}

export function pdfTextAssemblyConfidenceV2(assembly: PdfTextAssemblyV2): number {
  return assembly.boundaries.length > 0
    ? Math.min(...assembly.boundaries.map((boundary) => boundary.confidence))
    : 1;
}

export function pdfTextAssemblyOutcomeV2(assembly: PdfTextAssemblyV2): ImportOutcome {
  return assembly.unresolvedBoundaryCount > 0 || assembly.issues.length > 0
    ? "reported"
    : "native";
}

export function pdfTextAssemblyIssuesV2(
  assembly: PdfTextAssemblyV2,
  pageIndex: number,
  sourceId: string,
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (assembly.unresolvedBoundaryCount > 0) {
    issues.push({
      code: "pdf-import/text-boundary-unresolved",
      severity: "warning",
      outcome: "reported",
      message: "A material text boundary could not be resolved from source evidence.",
      sourceRefs: [sourceId],
      context: { pageIndex, boundaries: assembly.unresolvedBoundaryCount },
    });
  }
  if (assembly.issues.some((issue) => issue.code === "pdf-import/actual-text-mark-unmapped")) {
    issues.push({
      code: "pdf-import/actual-text-mark-unmapped",
      severity: "warning",
      outcome: "reported",
      message: "Author-provided replacement text could not retain a source annotation safely.",
      sourceRefs: [sourceId],
      context: {
        pageIndex,
        markedCharacters: assembly.issues.reduce(
          (count, issue) => count + issue.characterIndexes.length,
          0,
        ),
      },
    });
  }
  return issues;
}

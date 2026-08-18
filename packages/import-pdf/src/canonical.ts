import { sha256Hex } from "@atlcli/core";
import { canonicalJson } from "@atlcli/import-core";
import type { PdfAnalysisProvenanceV1, PdfFactsV1 } from "./contracts.js";
import { PdfImportError } from "./issues.js";

export async function digestPdfCanonical(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > maxBytes) {
    throw new PdfImportError("pdf/budget-exceeded", "Canonical PDF facts exceed the byte budget.", {
      actual: bytes.byteLength,
      limit: maxBytes,
    });
  }
  return sha256Hex(bytes);
}

export async function digestPdfFacts(facts: PdfFactsV1, maxBytes?: number): Promise<string> {
  return digestPdfCanonical(facts, maxBytes);
}

export function assertPdfAnalysisProvenance(
  expected: PdfAnalysisProvenanceV1,
  actual: PdfAnalysisProvenanceV1,
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF analyzer provenance differs from the reviewed preview. Run preview again.",
    );
  }
}

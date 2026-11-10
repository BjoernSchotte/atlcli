import { sha256Hex } from "@atlcli/core";
import { canonicalJson } from "@atlcli/import-core";
import type {
  PdfAnalysisProvenanceV1,
  PdfAnalysisProvenanceV2,
  PdfFactsV1,
  PdfFactsV2,
} from "./contracts.js";
import { PdfImportError } from "./issues.js";

function overBudget(actual: number, limit: number): never {
  throw new PdfImportError("pdf/budget-exceeded", "Canonical PDF facts exceed the byte budget.", { actual, limit });
}

export async function digestPdfCanonical(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > maxBytes) overBudget(bytes.byteLength, maxBytes);
  return sha256Hex(bytes);
}

// One import verifies the same facts object against its digest at every stage
// (normalize, hybrid, figures); serializing and hashing tens of MiB each time
// dominated the run. Keyed on identity: facts are treated as immutable once
// analyzed, and a changed copy is a new object that hashes afresh.
const factsDigests = new WeakMap<object, Promise<{ digest: string; byteLength: number }>>();

async function digestFactsOnce(facts: object, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  let pending = factsDigests.get(facts);
  if (!pending) {
    pending = (async () => {
      const bytes = new TextEncoder().encode(canonicalJson(facts));
      // Over budget: report the size without paying for the hash.
      return { digest: bytes.byteLength > maxBytes ? "" : await sha256Hex(bytes), byteLength: bytes.byteLength };
    })();
    factsDigests.set(facts, pending);
  }
  const { digest, byteLength } = await pending;
  if (byteLength > maxBytes) overBudget(byteLength, maxBytes);
  if (digest) return digest;
  // First asked under a tighter budget than this call allows.
  factsDigests.delete(facts);
  return digestFactsOnce(facts, maxBytes);
}

export async function digestPdfFacts(facts: PdfFactsV1, maxBytes?: number): Promise<string> {
  return digestFactsOnce(facts, maxBytes);
}

export async function digestPdfFactsV2(facts: PdfFactsV2, maxBytes?: number): Promise<string> {
  return digestFactsOnce(facts, maxBytes);
}

export function assertPdfAnalysisProvenance(
  expected: PdfAnalysisProvenanceV1,
  actual: PdfAnalysisProvenanceV1,
): void;
export function assertPdfAnalysisProvenance(
  expected: PdfAnalysisProvenanceV2,
  actual: PdfAnalysisProvenanceV2,
): void;
export function assertPdfAnalysisProvenance(
  expected: PdfAnalysisProvenanceV1 | PdfAnalysisProvenanceV2,
  actual: PdfAnalysisProvenanceV1 | PdfAnalysisProvenanceV2,
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF analyzer provenance differs from the reviewed preview. Run preview again.",
    );
  }
}

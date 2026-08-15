/**
 * Import provenance baseline (specs/import-docx/006-inplace-update §3,
 * `atlcli.docx-page-baseline/1`).
 *
 * Written as an `atlcli.import.baseline` page property at publish time and
 * REQUIRED for in-place updates: update authority comes from a validated,
 * digest-checked manifest — never from a visible marker or a bare page id.
 * The body digest is computed over the CANONICALIZED READBACK ADF (sorted
 * keys), so "has anyone edited this page since the import?" is a pure
 * digest comparison at update time.
 */
import { sha256Hex } from "@atlcli/core";

export const BASELINE_SCHEMA = "atlcli.docx-page-baseline/1" as const;
export const BASELINE_PROPERTY_KEY = "atlcli.import.baseline" as const;

export interface BaselineAssetBinding {
  /** Source asset id (package part path). */
  sourceAssetId: string;
  remoteFilename: string;
  sha256: string;
}

export interface ImportedPageBaselineV1 {
  schema: typeof BASELINE_SCHEMA;
  pageId: string;
  deployment: "cloud";
  /** sha256 of the source DOCX bytes. */
  sourceSha256: string;
  /** Digest of the placeholder-form ADF plan (preview digest). */
  importPlanDigest: string;
  /** sha256 over the canonicalized readback ADF right after publication. */
  bodyDigest: string;
  importedPageVersion: number;
  assetBindings: BaselineAssetBinding[];
  /** sha256 over the canonical JSON of every field above. */
  provenanceDigest: string;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, sortValue(obj[key])]),
    );
  }
  return value;
}

/** Canonical JSON (recursively sorted keys) for digest computation. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/**
 * Digest an ADF document from readback: parse, canonicalize, hash. The same
 * function runs at publish time (seals the baseline) and at update time
 * (checks for divergence), so normalization drift on either side is caught.
 */
export async function digestAdfValue(adfJsonText: string): Promise<string> {
  const parsed = JSON.parse(adfJsonText) as unknown;
  return sha256Hex(new TextEncoder().encode(canonicalJson(parsed)));
}

export async function buildBaseline(input: {
  pageId: string;
  sourceSha256: string;
  importPlanDigest: string;
  bodyDigest: string;
  importedPageVersion: number;
  assetBindings: BaselineAssetBinding[];
}): Promise<ImportedPageBaselineV1> {
  const withoutProvenance = {
    schema: BASELINE_SCHEMA,
    pageId: input.pageId,
    deployment: "cloud" as const,
    sourceSha256: input.sourceSha256,
    importPlanDigest: input.importPlanDigest,
    bodyDigest: input.bodyDigest,
    importedPageVersion: input.importedPageVersion,
    assetBindings: [...input.assetBindings].sort((a, b) =>
      a.sourceAssetId.localeCompare(b.sourceAssetId),
    ),
  };
  const provenanceDigest = await sha256Hex(
    new TextEncoder().encode(canonicalJson(withoutProvenance)),
  );
  return { ...withoutProvenance, provenanceDigest };
}

/**
 * Validate a stored baseline: schema, page identity, and the provenance
 * digest over its own content. Returns the reason it is invalid, or
 * undefined when it verifies.
 */
export async function validateBaseline(
  value: unknown,
  expectedPageId: string,
): Promise<{ baseline?: ImportedPageBaselineV1; reason?: string }> {
  if (typeof value !== "object" || value === null) {
    return { reason: "baseline property is not an object" };
  }
  const b = value as Partial<ImportedPageBaselineV1>;
  if (b.schema !== BASELINE_SCHEMA) return { reason: `unknown baseline schema ${JSON.stringify(b.schema)}` };
  if (b.pageId !== expectedPageId) {
    return { reason: `baseline belongs to page ${b.pageId}, not ${expectedPageId} (copied page?)` };
  }
  if (
    typeof b.sourceSha256 !== "string" ||
    typeof b.importPlanDigest !== "string" ||
    typeof b.bodyDigest !== "string" ||
    typeof b.importedPageVersion !== "number" ||
    !Array.isArray(b.assetBindings)
  ) {
    return { reason: "baseline is missing required fields" };
  }
  const { provenanceDigest, ...rest } = b as ImportedPageBaselineV1;
  const expected = await sha256Hex(new TextEncoder().encode(canonicalJson(rest)));
  if (expected !== provenanceDigest) {
    return { reason: "baseline provenance digest mismatch (tampered or corrupted)" };
  }
  return { baseline: b as ImportedPageBaselineV1 };
}

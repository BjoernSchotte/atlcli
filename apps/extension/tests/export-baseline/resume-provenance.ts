import { createHash } from "node:crypto";

export interface ChromeBaselineConfiguration {
  pages: Array<50 | 500>;
  formats: Array<"docx" | "pdf">;
  repeat: number;
  seed: number;
}

export interface ChromeBaselineProvenanceInput {
  gitCommit: string | null;
  workingTreeDirty: boolean | null;
  treeFingerprint: string | null;
  harnessFixtureDigest: string;
  browser: Record<string, string>;
  platform: string;
  release: string;
  architecture: string;
  configuration: ChromeBaselineConfiguration;
}

export interface ChromeBaselineProvenance extends ChromeBaselineProvenanceInput {
  schema: "atlcli.pre-queue-export-provenance/1";
  fingerprint: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function provenanceFingerprint(input: ChromeBaselineProvenanceInput): string {
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}

export function createChromeBaselineProvenance(
  input: ChromeBaselineProvenanceInput,
): ChromeBaselineProvenance {
  return {
    schema: "atlcli.pre-queue-export-provenance/1",
    ...input,
    fingerprint: provenanceFingerprint(input),
  };
}

export function selectResumableResults(
  previous: {
    schema?: string;
    state?: string;
    shape?: string;
    provenance?: ChromeBaselineProvenance;
    results?: Array<Record<string, unknown>>;
  },
  current: ChromeBaselineProvenance,
): Array<Record<string, unknown>> {
  if (
    previous.schema !== "atlcli.pre-queue-export-baseline/1" ||
    previous.state !== "pre-queue" ||
    previous.shape !== "browser-extension-harness"
  ) {
    throw new Error("Cannot resume an incompatible Chrome baseline report.");
  }
  const stored = previous.provenance;
  const storedPayload = stored
    ? (({ schema: _schema, fingerprint: _fingerprint, ...payload }) => payload)(stored)
    : undefined;
  if (
    !stored ||
    !storedPayload ||
    stored.schema !== "atlcli.pre-queue-export-provenance/1" ||
    stored.fingerprint !== provenanceFingerprint(storedPayload) ||
    stored.fingerprint !== current.fingerprint
  ) {
    throw new Error("Cannot resume Chrome results from different provenance.");
  }
  const results = previous.results ?? [];
  if (results.some((result) => result.provenanceFingerprint !== current.fingerprint)) {
    throw new Error("Cannot resume a Chrome result without matching provenance.");
  }
  return results;
}

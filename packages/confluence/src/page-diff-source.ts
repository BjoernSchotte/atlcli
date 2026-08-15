import type { ConfluenceClient } from "./client.js";
import {
  diffSemanticTreesV1,
  type SemanticDiffLimitsV1,
  type SemanticDiffResultV1,
  type SemanticTreeSnapshotV1,
} from "@atlcli/change-set";
import {
  canonicalizeAdfV1,
  type AdfParseBudget,
} from "@atlcli/change-set/adf";
import {
  ExportPageReadError,
  type PageBody,
} from "./page-body.js";
import {
  canonicalizeStorageV1,
  type StorageChangeTreeBudgetV1,
} from "./storage-change-tree.js";

/** Why one exact page-version diff source uses Storage instead of ADF. */
export type PageDiffSourceFallbackReason =
  | "data-center"
  | "adf-version-unavailable";

/** One immutable, exact-version input to the semantic page diff pipeline. */
export interface PageDiffSourceV1 {
  id: string;
  title: string;
  version: number;
  deployment: "cloud" | "data-center";
  body: PageBody;
  /** Exact-version compatibility body retained while ADF is primary. */
  storageSidecar?: string;
  fallbackReason?: PageDiffSourceFallbackReason;
}

/** Two exact versions normalized to one representation before projection. */
export interface PageDiffPairV1 {
  from: PageDiffSourceV1;
  to: PageDiffSourceV1;
  representation: PageBody["representation"];
}

function invalidSelection(
  message: string,
  pageId?: string,
): ExportPageReadError {
  return new ExportPageReadError(
    "invalid-diff-source-selection",
    message,
    pageId,
  );
}

function storageValue(source: PageDiffSourceV1): string | undefined {
  return source.body.representation === "storage"
    ? source.body.value
    : source.storageSidecar;
}

function asStorageSource(source: PageDiffSourceV1): PageDiffSourceV1 {
  const value = storageValue(source);
  if (value === undefined) {
    throw invalidSelection(
      `Confluence page ${source.id} version ${source.version} has no exact Storage body for common-representation fallback.`,
      source.id,
    );
  }
  const { storageSidecar: _storageSidecar, ...rest } = source;
  return {
    ...rest,
    body: { representation: "storage", value },
    fallbackReason: source.deployment === "data-center"
      ? "data-center"
      : "adf-version-unavailable",
  };
}

/**
 * Normalize two already acquired page versions to one trustworthy body format.
 * ADF is retained only when both Cloud versions have it; every other valid pair
 * uses the exact Storage bodies acquired for those same versions.
 */
export function selectPageDiffPair(
  from: PageDiffSourceV1,
  to: PageDiffSourceV1,
): PageDiffPairV1 {
  if (from.id !== to.id) {
    throw invalidSelection(
      `Cannot compare Confluence page ${from.id} with page ${to.id}.`,
    );
  }
  if (from.deployment !== to.deployment) {
    throw invalidSelection(
      `Confluence page ${from.id} diff sources disagree on deployment type.`,
      from.id,
    );
  }
  if (
    !Number.isInteger(from.version) || from.version < 1 ||
    !Number.isInteger(to.version) || to.version < 1
  ) {
    throw invalidSelection(
      `Confluence page ${from.id} diff sources must use positive integer versions.`,
      from.id,
    );
  }

  if (
    from.body.representation === "atlas_doc_format" &&
    to.body.representation === "atlas_doc_format"
  ) {
    if (from.deployment !== "cloud") {
      throw invalidSelection(
        `Data Center page ${from.id} cannot use a Cloud ADF diff source.`,
        from.id,
      );
    }
    return { from, to, representation: "atlas_doc_format" };
  }

  const storageFrom = asStorageSource(from);
  const storageTo = asStorageSource(to);
  return {
    from: storageFrom,
    to: storageTo,
    representation: "storage",
  };
}

/** Read two exact page versions and apply the common-representation policy. */
export async function readPageDiffPair(
  client: ConfluenceClient,
  pageId: string,
  fromVersion: number,
  toVersion: number,
  options: { signal?: AbortSignal } = {},
): Promise<PageDiffPairV1> {
  if (fromVersion === toVersion) {
    const source = await client.getPageDiffSource(pageId, fromVersion, options);
    return selectPageDiffPair(source, source);
  }
  const [from, to] = await Promise.all([
    client.getPageDiffSource(pageId, fromVersion, options),
    client.getPageDiffSource(pageId, toVersion, options),
  ]);
  return selectPageDiffPair(from, to);
}

export interface BuildPageDiffChangeSetOptionsV1 {
  adfBudget?: Partial<AdfParseBudget>;
  storageBudget?: Partial<StorageChangeTreeBudgetV1>;
  matcherLimits?: Partial<SemanticDiffLimitsV1>;
}

function semanticSnapshot(
  source: PageDiffSourceV1,
  options: BuildPageDiffChangeSetOptionsV1,
): SemanticTreeSnapshotV1 {
  const commonRef = {
    revision: String(source.version),
    representation: source.body.representation,
    deployment: source.deployment,
    acquisition: source.body.representation === "atlas_doc_format" ? "rest-v2" : "rest-v1",
  } as const;
  const tree = source.body.representation === "atlas_doc_format"
    ? canonicalizeAdfV1(
        source.body.value,
        options.adfBudget ? { budget: options.adfBudget } : {},
      )
    : canonicalizeStorageV1(
        source.body.value,
        options.storageBudget ? { budget: options.storageBudget } : {},
      );
  return {
    ref: commonRef,
    sourceTree: tree.sourceTree,
    semanticTree: tree.semanticTree,
    ...(tree.diagnostics.length > 0 ? { diagnostics: tree.diagnostics } : {}),
  };
}

/** Project an exact-version pair and build its portable, read-only ChangeSet. */
export async function buildPageDiffChangeSetV1(
  pair: PageDiffPairV1,
  options: BuildPageDiffChangeSetOptionsV1 = {},
): Promise<SemanticDiffResultV1> {
  if (
    pair.from.body.representation !== pair.representation ||
    pair.to.body.representation !== pair.representation
  ) {
    throw invalidSelection(
      "Page diff pair bodies do not match the selected common representation.",
      pair.from.id,
    );
  }
  const baseline = semanticSnapshot(pair.from, options);
  const target = semanticSnapshot(pair.to, options);
  if (
    pair.from.fallbackReason === "adf-version-unavailable" ||
    pair.to.fallbackReason === "adf-version-unavailable"
  ) {
    baseline.diagnostics = [
      ...(baseline.diagnostics ?? []),
      {
        code: "source-fallback",
        severity: "warning",
        message: "Historical Cloud ADF was unavailable; both versions use exact Storage.",
        path: [],
      },
    ];
  }
  return diffSemanticTreesV1({
    subject: {
      provider: "confluence",
      kind: "page",
      id: pair.to.id,
      label: pair.to.title,
    },
    baseline,
    target,
    ...(options.matcherLimits ? { limits: options.matcherLimits } : {}),
  });
}

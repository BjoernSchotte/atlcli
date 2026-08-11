import type { LocalModelInferencePerformanceV1 } from "./protocol.js";

export const LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1 =
  "atlcli.browser-local-gemma-performance-history/v1" as const;
export const LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1 =
  "/.atlcli/chat/v1/local-gemma-performance.json" as const;
export const LOCAL_GEMMA_PERFORMANCE_HISTORY_LIMIT_V1 = 40;

export interface LocalGemmaPerformanceSampleV1 {
  requestId: string;
  recordedAt: string;
  inputTokens: number;
  outputTokens: number;
  timing: LocalModelInferencePerformanceV1;
}

export interface LocalGemmaPerformanceHistoryV1 {
  schema: typeof LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1;
  samples: LocalGemmaPerformanceSampleV1[];
}

export interface LocalGemmaPerformanceWorkspaceV1 {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface LocalGemmaPerformanceSummaryV1 {
  samples: number;
  medianFirstPreviewMs?: number;
  medianTotalMs: number;
}

function emptyHistoryV1(): LocalGemmaPerformanceHistoryV1 {
  return {
    schema: LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1,
    samples: [],
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSampleV1(value: unknown): value is LocalGemmaPerformanceSampleV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Partial<LocalGemmaPerformanceSampleV1>;
  const timing = sample.timing as Partial<LocalModelInferencePerformanceV1> | undefined;
  return typeof sample.requestId === "string" &&
    typeof sample.recordedAt === "string" &&
    isFiniteNonNegative(sample.inputTokens) &&
    isFiniteNonNegative(sample.outputTokens) &&
    !!timing &&
    (timing.runtimeState === "cold" || timing.runtimeState === "warm") &&
    isFiniteNonNegative(timing.queuedMs) &&
    isFiniteNonNegative(timing.runtimeLoadMs) &&
    isFiniteNonNegative(timing.tokenizeMs) &&
    isFiniteNonNegative(timing.generationMs) &&
    isFiniteNonNegative(timing.totalMs) &&
    (timing.firstTokenMs === undefined || isFiniteNonNegative(timing.firstTokenMs)) &&
    (timing.firstPreviewMs === undefined || isFiniteNonNegative(timing.firstPreviewMs));
}

export function parseLocalGemmaPerformanceHistoryV1(
  serialized: string | undefined,
): LocalGemmaPerformanceHistoryV1 {
  if (!serialized) return emptyHistoryV1();
  try {
    const parsed = JSON.parse(serialized) as Partial<LocalGemmaPerformanceHistoryV1>;
    if (parsed.schema !== LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1 ||
        !Array.isArray(parsed.samples)) return emptyHistoryV1();
    return {
      schema: LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1,
      samples: parsed.samples.filter(isSampleV1).slice(
        -LOCAL_GEMMA_PERFORMANCE_HISTORY_LIMIT_V1,
      ),
    };
  } catch {
    return emptyHistoryV1();
  }
}

export async function appendLocalGemmaPerformanceSamplesV1(input: {
  workspace: LocalGemmaPerformanceWorkspaceV1;
  samples: LocalGemmaPerformanceSampleV1[];
}): Promise<LocalGemmaPerformanceHistoryV1> {
  const existing = parseLocalGemmaPerformanceHistoryV1(
    await input.workspace.readFile(LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1),
  );
  const history: LocalGemmaPerformanceHistoryV1 = {
    schema: LOCAL_GEMMA_PERFORMANCE_HISTORY_SCHEMA_V1,
    samples: [...existing.samples, ...input.samples.filter(isSampleV1)].slice(
      -LOCAL_GEMMA_PERFORMANCE_HISTORY_LIMIT_V1,
    ),
  };
  await input.workspace.writeFile(
    LOCAL_GEMMA_PERFORMANCE_HISTORY_PATH_V1,
    JSON.stringify(history),
  );
  return history;
}

function medianV1(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function summarizeLocalGemmaPerformanceV1(
  samples: LocalGemmaPerformanceSampleV1[],
  runtimeState: LocalModelInferencePerformanceV1["runtimeState"],
): LocalGemmaPerformanceSummaryV1 | undefined {
  const matching = samples.filter((sample) => sample.timing.runtimeState === runtimeState);
  if (matching.length === 0) return undefined;
  const previews = matching.flatMap((sample) =>
    sample.timing.firstPreviewMs === undefined ? [] : [sample.timing.firstPreviewMs]
  );
  return {
    samples: matching.length,
    ...(previews.length > 0 ? { medianFirstPreviewMs: medianV1(previews) } : {}),
    medianTotalMs: medianV1(matching.map((sample) => sample.timing.totalMs)),
  };
}

export function evaluateLocalGemmaPerformanceRatchetV1(input: {
  before: LocalGemmaPerformanceSampleV1[];
  after: LocalGemmaPerformanceSampleV1[];
  minimumWarmSamples?: number;
  maximumRegressionPermille?: number;
}): { passed: boolean; reasons: string[] } {
  const minimumWarmSamples = input.minimumWarmSamples ?? 3;
  const maximumRegressionPermille = input.maximumRegressionPermille ?? 50;
  const before = summarizeLocalGemmaPerformanceV1(input.before, "warm");
  const after = summarizeLocalGemmaPerformanceV1(input.after, "warm");
  const reasons: string[] = [];
  if (!before || before.samples < minimumWarmSamples) reasons.push("before-warm-samples");
  if (!after || after.samples < minimumWarmSamples) reasons.push("after-warm-samples");
  if (reasons.length > 0 || !before || !after) return { passed: false, reasons };
  const maximumFactor = 1 + maximumRegressionPermille / 1_000;
  if (after.medianTotalMs > before.medianTotalMs * maximumFactor) {
    reasons.push("median-total-regressed");
  }
  if (before.medianFirstPreviewMs !== undefined &&
      after.medianFirstPreviewMs !== undefined &&
      after.medianFirstPreviewMs > before.medianFirstPreviewMs * maximumFactor) {
    reasons.push("median-first-preview-regressed");
  }
  return { passed: reasons.length === 0, reasons };
}

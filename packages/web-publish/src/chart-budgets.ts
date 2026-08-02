import {
  CHART_LIMITS_V1,
  visitExportBlocksV1,
  type ChartModelV1,
} from "@atlcli/export-blocks";
import type {
  PublicationChartRenderPolicyV1,
  PublicationIssueV1,
  PublicationPageV1,
  PublicationProjectV1,
  PublicationRefreshPlanV1,
} from "./contracts.js";
import { digestPublicationRefreshPlanV1 } from "./digests.js";

export const DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1 = Object.freeze({
  maxSvgNodes: 100_000,
  maxSvgBytes: 2 * 1024 * 1024,
  maxRenderMs: 2_000,
});

export const DEFAULT_PUBLICATION_CHART_ISLAND_MOUNT_MS_V1 = 250;
export const MAX_PUBLICATION_CHART_ISLAND_MOUNT_MS_V1 = 1_000;
export const DEFAULT_PUBLICATION_CHART_ACQUISITION_MS_V1 = 5 * 60 * 1_000;
export const MAX_PUBLICATION_CHART_ACQUISITION_MS_V1 = 15 * 60 * 1_000;
export const DEFAULT_PUBLICATION_CHART_AGGREGATE_BYTES_V1 = 16 * 1024 * 1024;
export const MAX_PUBLICATION_CHART_AGGREGATE_BYTES_V1 = 64 * 1024 * 1024;

export class PublicationChartAcquisitionDeadlineErrorV1 extends Error {
  readonly code = "chart-acquisition-timeout" as const;

  constructor(readonly maxDurationMs: number) {
    super(`Chart acquisition exceeded its ${maxDurationMs}ms deadline`);
    this.name = "PublicationChartAcquisitionDeadlineErrorV1";
  }
}

function boundedProjectLimit(value: number | undefined, fallback: number, hardMaximum: number): number {
  return Math.max(1, Math.min(hardMaximum, value ?? fallback));
}

/** Freeze private project configuration into a safe, ID-free render policy. */
export function createPublicationChartRenderPolicyV1(
  project: PublicationProjectV1,
): PublicationChartRenderPolicyV1 {
  const maxIslandRows = boundedProjectLimit(project.renderers.maxChartRows, 80, CHART_LIMITS_V1.maxRows);
  const maxIslandSeries = boundedProjectLimit(project.renderers.maxChartSeries, 12, CHART_LIMITS_V1.maxSeries);
  const product = Math.min(Number.MAX_SAFE_INTEGER, maxIslandRows * maxIslandSeries);
  return Object.freeze({
    strict: project.completeness === "strict",
    acquisition: Object.freeze({
      maxDurationMs: boundedProjectLimit(
        project.renderers.maxChartAcquisitionMs,
        DEFAULT_PUBLICATION_CHART_ACQUISITION_MS_V1,
        MAX_PUBLICATION_CHART_ACQUISITION_MS_V1,
      ),
      maxAggregateBytes: boundedProjectLimit(
        project.renderers.maxChartAggregateBytes,
        DEFAULT_PUBLICATION_CHART_AGGREGATE_BYTES_V1,
        MAX_PUBLICATION_CHART_AGGREGATE_BYTES_V1,
      ),
    }),
    normalization: Object.freeze({
      maxRows: Math.min(CHART_LIMITS_V1.maxRows, project.macros.maxRows),
      maxSeries: CHART_LIMITS_V1.maxSeries,
      maxPoints: Math.min(CHART_LIMITS_V1.maxPoints, project.macros.maxNodes),
      maxBytes: Math.min(CHART_LIMITS_V1.maxPayloadBytes, project.macros.maxBytes),
    }),
    static: Object.freeze({
      maxSvgNodes: boundedProjectLimit(project.renderers.maxChartSvgNodes, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxSvgNodes, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxSvgNodes),
      maxSvgBytes: boundedProjectLimit(project.renderers.maxChartSvgBytes, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxSvgBytes, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxSvgBytes),
      maxRenderMs: boundedProjectLimit(project.renderers.maxChartRenderMs, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxRenderMs, DEFAULT_PUBLICATION_CHART_STATIC_BUDGET_V1.maxRenderMs),
    }),
    island: Object.freeze({
      enabled: project.renderers.allowIslands,
      maxRows: maxIslandRows,
      maxSeries: maxIslandSeries,
      maxPoints: boundedProjectLimit(project.renderers.maxChartPoints, Math.min(800, product), Math.min(CHART_LIMITS_V1.maxPoints, product)),
      maxBytes: boundedProjectLimit(project.renderers.maxIslandBytes, 64 * 1024, 64 * 1024),
      maxMountMs: boundedProjectLimit(
        project.renderers.maxChartIslandMountMs,
        DEFAULT_PUBLICATION_CHART_ISLAND_MOUNT_MS_V1,
        MAX_PUBLICATION_CHART_ISLAND_MOUNT_MS_V1,
      ),
    }),
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Chart acquisition was aborted");
}

/**
 * Bound a source-acquisition operation even if an adapter accidentally ignores
 * its AbortSignal. The child signal still gives cooperative adapters an
 * immediate cancellation path, while the raced rejection keeps callers from
 * waiting indefinitely.
 */
export async function runWithPublicationChartAcquisitionDeadlineV1<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { maxDurationMs: number; signal?: AbortSignal },
): Promise<T> {
  const maxDurationMs = Math.floor(options.maxDurationMs);
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new TypeError("maxDurationMs must be a positive safe integer");
  }
  if (options.signal?.aborted) throw abortReason(options.signal);

  const controller = new AbortController();
  const relayParentAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), { once: true });
    timer = setTimeout(() => {
      controller.abort(new PublicationChartAcquisitionDeadlineErrorV1(maxDurationMs));
    }, maxDurationMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      cancellation,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayParentAbort);
  }
}

function chartCounts(chart: ChartModelV1): { rows: number; nodes: number; bytes: number } {
  const bytes = new TextEncoder().encode(JSON.stringify(chart)).byteLength;
  if (chart.data.mode === "categories") {
    const points = chart.data.labels.length * chart.data.series.length;
    return { rows: chart.data.labels.length, nodes: chart.data.labels.length + chart.data.series.length + points, bytes };
  }
  if (chart.data.mode === "points") {
    const points = chart.data.series.reduce((sum, series) => sum + series.points.length, 0);
    const rows = Math.max(0, ...chart.data.series.map((series) => series.points.length));
    return { rows, nodes: rows + chart.data.series.length + points, bytes };
  }
  return { rows: chart.data.tasks.length, nodes: chart.data.tasks.length * 2, bytes };
}

function budgetIssue(
  project: PublicationProjectV1,
  page: PublicationPageV1,
  path: string,
  budget: "maxRows" | "maxNodes" | "maxBytes" | "maxAggregateBytes",
): PublicationIssueV1 {
  return {
    level: project.completeness === "strict" ? "error" : "warning",
    code: "chart-p0-diagnostic",
    message: budget === "maxAggregateBytes"
      ? "Chart publication acquisition exceeded the configured maxAggregateBytes budget."
      : `Chart publication admission exceeded the configured macro ${budget} budget.`,
    source: { sourceId: page.sourceId, route: page.route, path },
  };
}

/** Apply the acquisition/admission budgets to normalized page-local chart data. */
export function collectPublicationChartBudgetIssuesV1(
  project: PublicationProjectV1,
  pages: readonly PublicationPageV1[],
): readonly PublicationIssueV1[] {
  const issues: PublicationIssueV1[] = [];
  const maxAggregateBytes = createPublicationChartRenderPolicyV1(project).acquisition.maxAggregateBytes;
  let aggregateBytes = 0;
  let aggregateReported = false;
  for (const page of pages) {
    visitExportBlocksV1(page.blocks, {
      block(block, context) {
        if (block.type !== "chart") return;
        const counts = chartCounts(block.chart);
        aggregateBytes += counts.bytes;
        if (counts.rows > project.macros.maxRows) issues.push(budgetIssue(project, page, context.path, "maxRows"));
        if (counts.nodes > project.macros.maxNodes) issues.push(budgetIssue(project, page, context.path, "maxNodes"));
        if (counts.bytes > project.macros.maxBytes) issues.push(budgetIssue(project, page, context.path, "maxBytes"));
        if (!aggregateReported && aggregateBytes > maxAggregateBytes) {
          aggregateReported = true;
          issues.push(budgetIssue(project, page, context.path, "maxAggregateBytes"));
        }
      },
    });
  }
  return issues.sort((left, right) =>
    (left.source?.sourceId ?? "").localeCompare(right.source?.sourceId ?? "") ||
    (left.source?.path ?? "").localeCompare(right.source?.path ?? "") ||
    left.message.localeCompare(right.message),
  );
}

export async function applyPublicationChartBudgetPolicyV1(
  project: PublicationProjectV1,
  pages: readonly PublicationPageV1[],
  refreshPlan: PublicationRefreshPlanV1,
): Promise<PublicationRefreshPlanV1> {
  const budgetIssues = collectPublicationChartBudgetIssuesV1(project, pages);
  if (budgetIssues.length === 0) return refreshPlan;
  const provisional: PublicationRefreshPlanV1 = {
    ...refreshPlan,
    complete: refreshPlan.complete && project.completeness !== "strict",
    issues: [...refreshPlan.issues, ...budgetIssues],
    planDigest: "pending",
  };
  return { ...provisional, planDigest: await digestPublicationRefreshPlanV1(provisional) };
}

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
    }),
  });
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
  budget: "maxRows" | "maxNodes" | "maxBytes",
): PublicationIssueV1 {
  return {
    level: project.completeness === "strict" ? "error" : "warning",
    code: "chart-p0-diagnostic",
    message: `Chart publication admission exceeded the configured macro ${budget} budget.`,
    source: { sourceId: page.sourceId, route: page.route, path },
  };
}

/** Apply the acquisition/admission budgets to normalized page-local chart data. */
export function collectPublicationChartBudgetIssuesV1(
  project: PublicationProjectV1,
  pages: readonly PublicationPageV1[],
): readonly PublicationIssueV1[] {
  const issues: PublicationIssueV1[] = [];
  for (const page of pages) {
    visitExportBlocksV1(page.blocks, {
      block(block, context) {
        if (block.type !== "chart") return;
        const counts = chartCounts(block.chart);
        if (counts.rows > project.macros.maxRows) issues.push(budgetIssue(project, page, context.path, "maxRows"));
        if (counts.nodes > project.macros.maxNodes) issues.push(budgetIssue(project, page, context.path, "maxNodes"));
        if (counts.bytes > project.macros.maxBytes) issues.push(budgetIssue(project, page, context.path, "maxBytes"));
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

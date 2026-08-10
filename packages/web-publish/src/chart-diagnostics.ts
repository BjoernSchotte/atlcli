import {
  visitExportBlocksV1,
  type ChartDiagnosticCodeV1,
} from "@atlcli/export-blocks";
import type {
  PublicationIssueV1,
  PublicationPageV1,
  PublicationProjectV1,
  PublicationRefreshPlanV1,
} from "./contracts.js";
import { digestPublicationRefreshPlanV1 } from "./digests.js";

/** Diagnostics that mean a chart is semantically incomplete by default. */
export const DEFAULT_CHART_P0_DIAGNOSTIC_CODES_V1 = Object.freeze([
  "unsupported-kind",
  "malformed-data",
  "locale-parse",
  "skipped-row",
  "truncated",
  "renderer-fallback",
] as const satisfies readonly ChartDiagnosticCodeV1[]);

export class PublicationChartDiagnosticPolicyErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationChartDiagnosticPolicyErrorV1";
  }
}

function configuredP0Codes(project: PublicationProjectV1): ReadonlySet<ChartDiagnosticCodeV1> {
  return new Set(project.macros.chartDiagnostics?.p0Codes ?? DEFAULT_CHART_P0_DIAGNOSTIC_CODES_V1);
}

function sortedIssues(issues: readonly PublicationIssueV1[]): readonly PublicationIssueV1[] {
  return [...issues].sort((left, right) =>
    (left.source?.sourceId ?? "").localeCompare(right.source?.sourceId ?? "") ||
    (left.source?.path ?? "").localeCompare(right.source?.path ?? "") ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message),
  );
}

/**
 * Convert bounded chart diagnostics into safe publication issues. Diagnostic
 * messages can contain source values, so bundle issues retain only stable
 * codes and block paths; the detailed note remains on the visible chart.
 */
export function collectPublicationChartIssuesV1(
  project: PublicationProjectV1,
  pages: readonly PublicationPageV1[],
): readonly PublicationIssueV1[] {
  const p0Codes = configuredP0Codes(project);
  const issues: PublicationIssueV1[] = [];
  for (const page of pages) {
    visitExportBlocksV1(page.blocks, {
      block(block, context) {
        if (block.type !== "chart") return;
        for (const diagnostic of block.diagnostics ?? []) {
          const p0 = p0Codes.has(diagnostic.code);
          issues.push({
            level: p0 && project.completeness === "strict" ? "error" : "warning",
            code: p0 ? "chart-p0-diagnostic" : "chart-diagnostic",
            message: p0
              ? `Chart diagnostic '${diagnostic.code}' requires an explicit partial-publication policy.`
              : `Chart diagnostic '${diagnostic.code}' was published with a visible chart note.`,
            source: { sourceId: page.sourceId, route: page.route, path: context.path },
          });
        }
      },
    });
  }
  return sortedIssues(issues);
}

/** Apply chart completeness policy and re-digest the immutable refresh plan. */
export async function applyPublicationChartDiagnosticPolicyV1(
  project: PublicationProjectV1,
  pages: readonly PublicationPageV1[],
  refreshPlan: PublicationRefreshPlanV1,
): Promise<PublicationRefreshPlanV1> {
  const chartIssues = collectPublicationChartIssuesV1(project, pages);
  if (chartIssues.length === 0) return refreshPlan;
  const chartIncomplete = project.completeness === "strict" &&
    chartIssues.some((issue) => issue.code === "chart-p0-diagnostic");
  const provisional: PublicationRefreshPlanV1 = {
    ...refreshPlan,
    complete: refreshPlan.complete && !chartIncomplete,
    issues: sortedIssues([...refreshPlan.issues, ...chartIssues]),
    planDigest: "pending",
  };
  return { ...provisional, planDigest: await digestPublicationRefreshPlanV1(provisional) };
}

/** A strict build never consumes a bundle created with P0 chart degradation. */
export function assertPublicationChartBuildPolicyV1(
  project: PublicationProjectV1,
  issues: readonly PublicationIssueV1[],
): void {
  if (
    project.completeness === "strict" &&
    issues.some((issue) => issue.code === "chart-p0-diagnostic")
  ) {
    throw new PublicationChartDiagnosticPolicyErrorV1(
      "Strict publication build rejected an active bundle with P0 chart diagnostics.",
    );
  }
}

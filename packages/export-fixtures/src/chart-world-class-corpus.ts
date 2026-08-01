import {
  chartModelDigestV1,
  type ChartKindV1,
  type ChartModelV1,
  type ExportBlock,
} from "@atlcli/confluence/browser";

const source = {
  kind: "cloud-adf" as const,
  macroName: "chart" as const,
  dependencyDigest: "fixture-chart-source-v1",
};

function chart(kind: ChartKindV1, model: Omit<ChartModelV1, "schema" | "kind" | "source">): Extract<ExportBlock, { type: "chart" }> {
  const chartModel: ChartModelV1 = {
    schema: "atlcli.chart/1",
    kind,
    source,
    ...model,
  };
  return {
    type: "chart",
    chart: chartModel,
    localId: `world-class-${kind}`,
    caption: { kind: "figure", content: [{ type: "text", text: `${model.title ?? kind} — deterministic all-host proof` }] },
  };
}

/**
 * Tenant-free, IO-free acceptance corpus for every chart host. The cases are
 * deliberately richer than a dispatch smoke test: signed values, multiple
 * series, orientation/stacking, sparse XY data, stepped paths, locale-stable
 * timestamps, pie semantics, and Gantt progress/dependencies are all present.
 */
export const CHART_WORLD_CLASS_BLOCKS_V1: readonly Extract<ExportBlock, { type: "chart" }>[] = Object.freeze([
  chart("pie", {
    title: "Portfolio allocation",
    subtitle: "Approved investment by workstream",
    legend: "right",
    threeD: true,
    pie: { sectionLabel: "name-value", explode: [0, 10, 0, 0] },
    style: { colors: ["#0c66e4", "#00875a", "#6554c0", "#974f0c"] },
    display: { width: 720, height: 360, data: "after" },
    data: {
      mode: "categories",
      labels: ["Platform", "Experience", "Operations", "Research"],
      series: [{ id: "allocation", label: "Budget", values: [38, 27, 21, 14] }],
    },
  }),
  chart("bar", {
    title: "Quarterly variance",
    subtitle: "Signed change from plan",
    xLabel: "Variance",
    yLabel: "Quarter",
    legend: "bottom",
    orientation: "horizontal",
    stacked: true,
    opacity: 0.92,
    axes: { x: { min: -20, max: 40, tickUnit: 10 }, y: { categoryLabelPosition: "near" } },
    data: {
      mode: "categories",
      labels: ["Q1", "Q2", "Q3", "Q4"],
      series: [
        { id: "product", label: "Product", values: [22, -8, 31, 18] },
        { id: "services", label: "Services", values: [10, 14, -6, 12] },
      ],
    },
  }),
  chart("line", {
    title: "Service health",
    subtitle: "Monthly score and baseline",
    xLabel: "Month",
    yLabel: "Score",
    legend: "top",
    showShapes: true,
    axes: { y: { min: -10, max: 40, tickUnit: 10 }, x: { labelAngle: -25, categoryLabelPosition: "far" } },
    data: {
      mode: "categories",
      labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
      series: [
        { id: "actual", label: "Actual", values: [8, 14, -3, 25, 18, 34] },
        { id: "baseline", label: "Baseline", values: [10, 10, 10, 10, 10, 10] },
      ],
    },
  }),
  chart("area", {
    title: "Capacity envelope",
    subtitle: "Available and committed days",
    legend: "left",
    opacity: 0.78,
    axes: { y: { min: 0, max: 80, tickUnit: 20 } },
    data: {
      mode: "categories",
      labels: ["Sprint 1", "Sprint 2", "Sprint 3", "Sprint 4"],
      series: [
        { id: "available", label: "Available", values: [68, 72, 64, 76] },
        { id: "committed", label: "Committed", values: [42, 57, 61, 49] },
      ],
    },
  }),
  chart("xyArea", {
    title: "Throughput envelope",
    subtitle: "Observed range over load",
    legend: "right",
    xLabel: "Concurrent users",
    yLabel: "Requests per second",
    axes: { x: { min: 0, max: 100, tickUnit: 20 }, y: { min: 0, max: 600, tickUnit: 100 } },
    data: {
      mode: "points",
      series: [
        { id: "p50", label: "P50", points: [{ x: 5, y: 110 }, { x: 20, y: 240 }, { x: 50, y: 410 }, { x: 90, y: 520 }] },
        { id: "p95", label: "P95", points: [{ x: 5, y: 70 }, { x: 30, y: 190 }, { x: 55, y: 330 }, { x: 90, y: 420 }] },
      ],
    },
  }),
  chart("xyBar", {
    title: "Change by release",
    subtitle: "Added and removed pages",
    legend: "bottom",
    xLabel: "Release",
    yLabel: "Pages",
    axes: { y: { min: -20, max: 60, tickUnit: 20 } },
    data: {
      mode: "points",
      series: [
        { id: "added", label: "Added", points: [{ x: 1, y: 18 }, { x: 2, y: 35 }, { x: 3, y: 52 }] },
        { id: "removed", label: "Removed", points: [{ x: 1, y: -6 }, { x: 2, y: -12 }, { x: 3, y: -9 }] },
      ],
    },
  }),
  chart("xyLine", {
    title: "Latency curve",
    subtitle: "Sparse series retain their own X values",
    legend: "top",
    showShapes: true,
    axes: { x: { min: 0, max: 100, tickUnit: 20 }, y: { min: 0, max: 500, tickUnit: 100 } },
    data: {
      mode: "points",
      series: [
        { id: "api", label: "API", points: [{ x: 10, y: 90 }, { x: 35, y: 140 }, { x: 80, y: 310 }] },
        { id: "web", label: "Web", points: [{ x: 5, y: 70 }, { x: 50, y: 220 }, { x: 95, y: 430 }] },
      ],
    },
  }),
  chart("xyStep", {
    title: "Deployment state",
    subtitle: "Values change only at event boundaries",
    legend: "none",
    showShapes: true,
    axes: { x: { min: 0, max: 24, tickUnit: 4 }, y: { min: 0, max: 4, tickUnit: 1 } },
    data: { mode: "points", series: [{ id: "state", label: "State", points: [{ x: 0, y: 1 }, { x: 4, y: 3 }, { x: 12, y: 2 }, { x: 20, y: 4 }] }] },
  }),
  chart("xyStepArea", {
    title: "Reserved capacity",
    subtitle: "Stepped allocation through the day",
    legend: "none",
    opacity: 0.8,
    axes: { x: { min: 0, max: 24, tickUnit: 4 }, y: { min: 0, max: 100, tickUnit: 20 } },
    data: { mode: "points", series: [{ id: "capacity", label: "Capacity", points: [{ x: 0, y: 20 }, { x: 6, y: 55 }, { x: 13, y: 80 }, { x: 19, y: 35 }] }] },
  }),
  chart("scatter", {
    title: "Lead time correlation",
    subtitle: "Story size versus delivery days",
    legend: "right",
    xLabel: "Story points",
    yLabel: "Days",
    axes: { x: { min: 0, max: 21, tickUnit: 3 }, y: { min: 0, max: 30, tickUnit: 5 } },
    data: {
      mode: "points",
      series: [
        { id: "team-a", label: "Team A", points: [{ x: 2, y: 3 }, { x: 5, y: 7 }, { x: 8, y: 13 }, { x: 13, y: 21 }] },
        { id: "team-b", label: "Team B", points: [{ x: 3, y: 4 }, { x: 5, y: 10 }, { x: 10, y: 15 }, { x: 18, y: 26 }] },
      ],
    },
  }),
  chart("timeSeries", {
    title: "Publication activity",
    subtitle: "UTC timestamps with explicit German locale policy",
    legend: "bottom",
    xLabel: "Date",
    yLabel: "Published pages",
    locale: { language: "de", country: "DE", dateFormat: "dd.MM.yyyy", timePeriod: "day" },
    axes: { x: { dateTickPosition: "center", labelAngle: -30 }, y: { min: 0, max: 80, tickUnit: 20 } },
    data: {
      mode: "points",
      series: [{ id: "published", label: "Published", points: [
        { x: "2026-01-01T00:00:00.000Z", y: 12 },
        { x: "2026-01-08T00:00:00.000Z", y: 38 },
        { x: "2026-01-15T00:00:00.000Z", y: 57 },
        { x: "2026-01-22T00:00:00.000Z", y: 71 },
      ] }],
    },
  }),
  chart("gantt", {
    title: "Publishing rollout",
    subtitle: "Progress and dependency chain",
    legend: "none",
    display: { width: 840, height: 420, data: "after" },
    data: {
      mode: "gantt",
      tasks: [
        { id: "model", label: "Render model", start: "2026-01-05", end: "2026-01-12", progress: 1 },
        { id: "themes", label: "Theme integration", start: "2026-01-10", end: "2026-01-20", progress: 0.65, dependencies: ["model"] },
        { id: "proof", label: "Host proof", start: "2026-01-19", end: "2026-01-30", progress: 0.25, dependencies: ["themes"] },
      ],
    },
  }),
]);

export const CHART_WORLD_CLASS_KINDS_V1: readonly ChartKindV1[] = Object.freeze(
  CHART_WORLD_CLASS_BLOCKS_V1.map((block) => block.chart.kind),
);

export const CHART_WORLD_CLASS_DIGESTS_V1: Readonly<Record<ChartKindV1, string>> = Object.freeze(
  Object.fromEntries(CHART_WORLD_CLASS_BLOCKS_V1.map((block) => [block.chart.kind, chartModelDigestV1(block.chart)])) as Record<ChartKindV1, string>,
);

export function chartWorldClassBlocksV1(): Extract<ExportBlock, { type: "chart" }>[] {
  return structuredClone([...CHART_WORLD_CLASS_BLOCKS_V1]);
}

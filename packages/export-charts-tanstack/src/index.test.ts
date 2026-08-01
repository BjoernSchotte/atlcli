import { expect, test } from "bun:test";
import { CHART_KINDS_V1, type ChartKindV1, type ChartModelV1 } from "@atlcli/export-blocks";
import {
  TANSTACK_CHART_ADAPTER_V1,
  createTanStackChartDefinitionV1,
  createTanStackChartSceneV1,
  renderTanStackChartSvgV1,
} from "./index.js";

const source = { kind: "cloud-adf" as const, macroName: "chart" as const };

function model(kind: ChartKindV1): ChartModelV1 {
  if (kind === "gantt") return {
    schema: "atlcli.chart/1",
    kind,
    title: "Release plan",
    source,
    data: { mode: "gantt", tasks: [
      { id: "build", label: "Build", start: "2026-01-01", end: "2026-01-08", progress: 0.75 },
      { id: "publish", label: "Publish", start: "2026-01-08", end: "2026-01-12", progress: 0.25, dependencies: ["build"] },
    ] },
  };
  if (kind === "pie") return {
    schema: "atlcli.chart/1",
    kind,
    title: "Allocation",
    legend: "right",
    pie: { sectionLabel: "name-value", explode: [0, 8, 0] },
    source,
    data: { mode: "categories", labels: ["Build", "Run", "Learn"], series: [{ id: "budget", label: "Budget", values: [50, 30, 20] }] },
  };
  if (["xyArea", "xyBar", "xyLine", "xyStep", "xyStepArea", "scatter", "timeSeries"].includes(kind)) return {
    schema: "atlcli.chart/1",
    kind,
    title: `Shape ${kind}`,
    source,
    locale: kind === "timeSeries" ? { dateFormat: "dd.MM.yyyy", language: "de", country: "DE", timePeriod: "day" } : undefined,
    axes: { x: kind === "timeSeries" ? {} : { tickUnit: 1 }, y: { min: -10, max: 40, tickUnit: 10 } },
    data: { mode: "points", series: [
      { id: "one", label: "One", points: [
        { x: kind === "timeSeries" ? "2026-01-01T00:00:00.000Z" : 1, y: -4 },
        { x: kind === "timeSeries" ? "2026-01-08T00:00:00.000Z" : 2, y: 18 },
        { x: kind === "timeSeries" ? "2026-01-15T00:00:00.000Z" : 3, y: 33 },
      ] },
    ] },
  };
  return {
    schema: "atlcli.chart/1",
    kind,
    title: `Shape ${kind}`,
    source,
    orientation: kind === "bar" ? "horizontal" : "vertical",
    stacked: kind === "bar",
    axes: { x: { labelAngle: -25 }, y: { min: -20, max: 50, tickUnit: 10 } },
    data: { mode: "categories", labels: ["A", "B", "C"], series: [
      { id: "one", label: "One", values: [12, -8, 31] },
      { id: "two", label: "Two", values: [7, 14, -5] },
    ] },
  };
}

test("pins the single all-static TanStack adapter", () => {
  expect(TANSTACK_CHART_ADAPTER_V1).toEqual({ id: "tanstack-v0.3/all-static", package: "@tanstack/charts", version: "0.3.1" });
});

test("compiles and renders all twelve normalized shapes through TanStack scenes", () => {
  for (const kind of CHART_KINDS_V1) {
    const chart = model(kind);
    const { definition } = createTanStackChartDefinitionV1(chart);
    expect(definition).toBeTruthy();
    const scene = createTanStackChartSceneV1(chart);
    expect(scene.width).toBeGreaterThanOrEqual(320);
    expect(scene.height).toBeGreaterThanOrEqual(220);
    expect(scene.nodes.length).toBeGreaterThan(0);
    const svg = renderTanStackChartSvgV1(chart, { idPrefix: `proof-${kind}` });
    expect(svg).toStartWith("<svg");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('class="ts-chart"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain(`Shape ${kind}`.replace("Shape pie", "Allocation").replace("Shape gantt", "Release plan"));
    expect(svg).not.toContain("<script");
  }
});

test("uses native TanStack marks for signed horizontal stacks, steps, pie labels, and Gantt dependencies", () => {
  const horizontal = renderTanStackChartSvgV1(model("bar"));
  expect(horizontal).toContain("ts-chart__bar");
  expect(horizontal).toContain("−5");
  expect(createTanStackChartSceneV1(model("bar")).points.some((point) => point.xValue === -8)).toBe(true);

  const stepped = renderTanStackChartSvgV1(model("xyStepArea"));
  expect(stepped).toContain("ts-chart__area");
  expect(stepped).toContain("ts-chart__line");

  const pie = renderTanStackChartSvgV1(model("pie"));
  expect(pie).toContain("Build: 50");
  expect(pie).toContain("ts-chart__polar");

  const gantt = renderTanStackChartSvgV1(model("gantt"));
  expect(gantt).toContain("ts-chart__rect");
  expect(gantt).toContain("ts-chart__arrow");
});

test("pads continuous XY bar domains so grouped edge bars stay inside the scene", () => {
  const base = model("xyBar");
  if (base.data.mode !== "points") throw new Error("test fixture drift");
  const chart: ChartModelV1 = {
    ...base,
    data: {
      ...base.data,
      series: [...base.data.series, {
        id: "two",
        label: "Two",
        points: base.data.series[0]!.points.map((point) => ({ ...point, y: point.y / 2 })),
      }],
    },
  };
  const scene = createTanStackChartSceneV1(chart);
  expect(scene.points.length).toBe(6);
  expect(scene.points.every((point) => point.x >= 0 && point.x <= scene.width)).toBe(true);
});

test("reports explicit approximations instead of silently emulating unsupported presentation", () => {
  const { approximations } = createTanStackChartDefinitionV1({ ...model("pie"), threeD: true, legend: "right" });
  expect(approximations.map((entry) => entry.code)).toEqual(["flattened-3d", "legend-position", "pie-explode"]);
});

test("escapes hostile labels in the DOM-free SVG renderer", () => {
  const chart = model("line");
  if (chart.data.mode !== "categories") throw new Error("test fixture drift");
  chart.data = { ...chart.data, labels: ['<script>alert("x")</script>', "B", "C"] };
  const svg = renderTanStackChartSvgV1(chart);
  expect(svg).not.toContain("<script>");
  expect(svg).toContain("&lt;script&gt;");
});

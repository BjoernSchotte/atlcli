import { expect, test } from "bun:test";
import { CHART_KINDS_V1, type ChartKindV1, type ChartModelV1 } from "@atlcli/export-blocks";
import {
  TANSTACK_CHART_ADAPTER_V1,
  createTanStackChartDefinitionV1,
  createTanStackChartSceneV1,
  renderTanStackChartSvgV1,
} from "./index.js";
import type { SceneNode } from "@tanstack/charts";

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
    pie: { sectionLabelFormat: "%0%: %1%", explode: ["Run"] },
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

function sceneNodes(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((node) => node.kind === "group" ? [node, ...sceneNodes(node.children)] : [node]);
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

test("keeps validated background and border presentation in the shared TanStack scene", () => {
  const chart: ChartModelV1 = {
    ...model("bar"),
    style: { backgroundColor: "#FFEECC", borderColor: "#123456" },
  };
  const scene = createTanStackChartSceneV1(chart);
  expect(scene.theme.background).toBe("#FFEECC");
  expect(scene.nodes.at(-1)).toMatchObject({
    kind: "rect",
    key: "atlcli-chart-border",
    style: { fill: "none", stroke: "#123456", strokeWidth: 1 },
  });
  const svg = renderTanStackChartSvgV1(chart);
  expect(svg).toContain('fill="#FFEECC"');
  expect(svg).toContain('class="atlcli-chart-border"');
  expect(svg).toContain('stroke="#123456"');
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

test("reports only the intentional 3D approximation", () => {
  const { approximations } = createTanStackChartDefinitionV1({ ...model("pie"), threeD: true, legend: "right" });
  expect(approximations.map((entry) => entry.code)).toEqual(["flattened-3d"]);
});

test("lays out every requested legend position outside the TanStack plot", () => {
  for (const position of ["top", "right", "bottom", "left"] as const) {
    const scene = createTanStackChartSceneV1({ ...model("line"), legend: position });
    const legend = scene.nodes.find((node) => node.key === "legend");
    expect(legend?.kind).toBe("group");
    if (!legend || legend.kind !== "group") throw new Error("legend fixture drift");
    const dots = legend.children.filter((node) => node.kind === "dot");
    expect(dots).toHaveLength(2);
    if (position === "top") expect(dots.every((node) => node.kind === "dot" && node.y < scene.chart.y)).toBeTrue();
    if (position === "right") expect(dots.every((node) => node.kind === "dot" && node.x > scene.chart.x + scene.chart.width)).toBeTrue();
    if (position === "bottom") expect(dots.every((node) => node.kind === "dot" && node.y > scene.chart.y + scene.chart.height)).toBeTrue();
    if (position === "left") expect(dots.every((node) => node.kind === "dot" && node.x < scene.chart.x)).toBeTrue();
  }
});

test("offsets named pie sections and their labels from the canonical TanStack scene", () => {
  const exploded = createTanStackChartSceneV1(model("pie"));
  const plain = createTanStackChartSceneV1({ ...model("pie"), pie: { sectionLabelFormat: "%0%: %1%" } });
  const explodedPoint = exploded.points.find((point) => point.groupLabel === "pie-arcs" && (point.datum as { data?: { label?: string } }).data?.label === "Run");
  const plainPoint = plain.points.find((point) => point.groupLabel === "pie-arcs" && (point.datum as { data?: { label?: string } }).data?.label === "Run");
  expect(explodedPoint).toBeTruthy();
  expect(plainPoint).toBeTruthy();
  expect(explodedPoint?.x).not.toBe(plainPoint?.x);
  expect(explodedPoint?.y).not.toBe(plainPoint?.y);
  const svg = renderTanStackChartSvgV1(model("pie"));
  expect(svg).toContain("ts-chart__pie-explode");
  expect(svg).toContain("translate(");
});

test("maps documented category rotations and time-period tick positions", () => {
  for (const [position, rotation] of [["up45", -45], ["up90", -90], ["down45", 45], ["down90", 90]] as const) {
    const category = createTanStackChartSceneV1({ ...model("line"), axes: { x: { categoryLabelPosition: position } } });
    const categoryLabels = sceneNodes(category.nodes).filter((node) => node.kind === "label" && node.key.startsWith("x-tick-label:"));
    expect(categoryLabels.some((node) => node.kind === "label" && node.rotate === rotation)).toBeTrue();
  }

  const time = createTanStackChartSceneV1({ ...model("timeSeries"), axes: { x: { dateTickPosition: "middle" }, y: { min: -10, max: 40, tickUnit: 10 } } });
  const firstPoint = time.points.filter((point) => point.markId === "chart-timeSeries").sort((left, right) => left.x - right.x)[0];
  const firstTick = sceneNodes(time.nodes).filter((node) => node.kind === "label" && node.key.startsWith("x-tick-label:")).sort((left, right) => left.kind === "label" && right.kind === "label" ? left.x - right.x : 0)[0];
  expect(firstPoint).toBeTruthy();
  expect(firstTick?.kind).toBe("label");
  if (firstTick?.kind === "label") expect(firstTick.x).toBeGreaterThan(firstPoint!.x);
  expect(firstTick?.kind === "label" ? firstTick.text : "").toBe("01.01.2026");

  const twoWeeks = createTanStackChartSceneV1({
    ...model("timeSeries"),
    axes: { x: { valueType: "date", tickUnit: 2, tickPeriod: "week", dateTickPosition: "start" }, y: { min: -10, max: 40, tickUnit: 10 } },
  });
  const dateLabels = sceneNodes(twoWeeks.nodes).filter((node) => node.kind === "label" && node.key.startsWith("x-tick-label:"));
  expect(dateLabels).toHaveLength(2);
  expect(dateLabels.map((node) => node.kind === "label" ? node.text : "")).toEqual(["01.01.2026", "15.01.2026"]);
});

test("renders the documented pie label mini-language as inert text", () => {
  const svg = renderTanStackChartSvgV1({ ...model("pie"), pie: { sectionLabelFormat: "%0% = %1% (%2%)" } });
  expect(svg).toContain("Build = 50 (50%)");
  expect(svg).not.toContain("%0%");
});

test("bounds Gantt date ticks so adjacent provider dates cannot collide", () => {
  const gantt = createTanStackChartSceneV1(model("gantt"));
  const labels = sceneNodes(gantt.nodes)
    .filter((node) => node.kind === "label" && node.key.startsWith("x-tick-label:"))
    .sort((left, right) => left.kind === "label" && right.kind === "label" ? left.x - right.x : 0);
  expect(labels.length).toBeGreaterThanOrEqual(3);
  expect(labels.length).toBeLessThanOrEqual(6);
  for (let index = 1; index < labels.length; index += 1) {
    const previous = labels[index - 1];
    const current = labels[index];
    if (previous?.kind !== "label" || current?.kind !== "label") throw new Error("Gantt tick fixture drift");
    expect(current.x - previous.x).toBeGreaterThan(48);
  }
});

test("escapes hostile labels in the DOM-free SVG renderer", () => {
  const chart = model("line");
  if (chart.data.mode !== "categories") throw new Error("test fixture drift");
  chart.data = { ...chart.data, labels: ['<script>alert("x")</script>', "B", "C"] };
  const svg = renderTanStackChartSvgV1(chart);
  expect(svg).not.toContain("<script>");
  expect(svg).toContain("&lt;script&gt;");
});

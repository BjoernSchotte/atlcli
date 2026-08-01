import {
  areaY,
  arrow,
  barX,
  barY,
  colorLegend,
  createChartScene,
  defineChart,
  d3Curve,
  dot,
  group,
  lineY,
  rect,
  renderChartSvg,
  stack,
  type ChartScene,
  type ChartValue,
  type StaticChartDefinition,
} from "@tanstack/charts";
import { polar, radialArc, radialText } from "@tanstack/charts/polar";
import { renderChartSvgWithResources } from "@tanstack/charts/svg/resources";
import {
  validateChartModelV1,
  type ChartAxisV1,
  type ChartModelV1,
} from "@atlcli/export-blocks";
import { scaleBand, scaleLinear, scalePoint, scaleUtc } from "d3-scale";
import { curveStepAfter, pie as createPie, type PieArcDatum } from "d3-shape";

export const TANSTACK_CHART_ADAPTER_V1 = Object.freeze({
  id: "tanstack-v0.3/all-static" as const,
  package: "@tanstack/charts" as const,
  version: "0.3.1" as const,
});

export const TANSTACK_CHART_SIZE_V1 = Object.freeze({ width: 720, height: 400 });

export type TanStackChartDefinitionV1 = StaticChartDefinition<unknown, ChartValue, ChartValue>;

export interface TanStackChartApproximationV1 {
  code: "flattened-3d" | "legend-position" | "pie-explode" | "axis-position";
  message: string;
}

export interface TanStackChartAdapterResultV1 {
  definition: TanStackChartDefinitionV1;
  approximations: readonly TanStackChartApproximationV1[];
}

export interface RenderTanStackChartSvgOptionsV1 {
  width?: number;
  height?: number;
  idPrefix?: string;
  ariaLabel?: string;
  ariaDescription?: string;
}

interface CategoryRow {
  id: string;
  category: string;
  series: string;
  value: number;
}

interface PointRow {
  id: string;
  x: number | Date;
  series: string;
  value: number;
  label: string;
}

interface GanttRow {
  id: string;
  task: string;
  start: Date;
  end: Date;
  progressEnd: Date;
  progress: number;
  color: string;
}

interface GanttDependencyRow {
  id: string;
  predecessorTask: string;
  predecessorEnd: Date;
  task: string;
  taskStart: Date;
}

interface PieRow {
  id: string;
  label: string;
  value: number;
  color: string;
}

type PieDatum = PieArcDatum<PieRow> & { sectionLabel: string };

const DEFAULT_COLORS = ["#0c66e4", "#00875a", "#6554c0", "#de350b", "#974f0c", "#00a3bf"] as const;

function colors(chart: ChartModelV1): readonly string[] {
  return chart.style?.colors?.length ? chart.style.colors : DEFAULT_COLORS;
}

function finiteAxisValue(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function numericExtent(values: readonly number[], axis: ChartAxisV1 | undefined, includeZero: boolean): [number, number] {
  const finite = values.filter(Number.isFinite);
  let min = finiteAxisValue(axis?.min) ?? Math.min(...finite, ...(includeZero ? [0] : []));
  let max = finiteAxisValue(axis?.max) ?? Math.max(...finite, ...(includeZero ? [0] : []));
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 1;
  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.1);
    min -= padding;
    max += padding;
  }
  return [min, max];
}

function tickValues(extent: readonly [number, number], unit: number | undefined): number[] | undefined {
  if (!unit || unit <= 0) return undefined;
  const values: number[] = [];
  for (let value = Math.ceil(extent[0] / unit) * unit, count = 0; value <= extent[1] + unit * 1e-9 && count < 128; value += unit, count += 1) values.push(Math.abs(value) < unit * 1e-10 ? 0 : value);
  return values.length > 1 ? values : undefined;
}

function paddedBarExtent(
  values: readonly number[],
  axis: ChartAxisV1 | undefined,
  extent: readonly [number, number],
): [number, number] {
  const unique = [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
  const gaps = unique.slice(1).map((value, index) => value - unique[index]!).filter((gap) => gap > 0);
  const step = gaps.length > 0
    ? Math.min(...gaps)
    : Math.max(1, Math.abs(unique[0] ?? 0) * 0.2);
  const padding = step * 0.55;
  return [
    finiteAxisValue(axis?.min) ?? extent[0] - padding,
    finiteAxisValue(axis?.max) ?? extent[1] + padding,
  ];
}

function utcFormatter(pattern: string | undefined): (value: Date) => string {
  return (value) => {
    const yyyy = String(value.getUTCFullYear()).padStart(4, "0");
    const MM = String(value.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(value.getUTCDate()).padStart(2, "0");
    const HH = String(value.getUTCHours()).padStart(2, "0");
    const mm = String(value.getUTCMinutes()).padStart(2, "0");
    const ss = String(value.getUTCSeconds()).padStart(2, "0");
    return (pattern?.trim() || "yyyy-MM-dd").replaceAll("yyyy", yyyy).replaceAll("MM", MM).replaceAll("dd", dd).replaceAll("HH", HH).replaceAll("mm", mm).replaceAll("ss", ss);
  };
}

function theme(chart: ChartModelV1) {
  return {
    foreground: "#172b4d",
    muted: "#5e6c84",
    grid: "#dfe1e6",
    background: chart.style?.backgroundColor ?? "#ffffff",
    palette: colors(chart),
  };
}

function legend(chart: ChartModelV1, domain: readonly string[]) {
  return chart.legend === "none" || domain.length < 2 ? undefined : {
    domain,
    range: colors(chart),
    legend: colorLegend({ itemWidth: 128 }),
  };
}

function axisTickOptions(axis: ChartAxisV1 | undefined, values?: readonly number[], formatter?: (value: never) => string) {
  const ticks = values ? { values } : undefined;
  return {
    ...(ticks || formatter ? { ticks: { ...ticks, ...(formatter ? { format: formatter } : {}) } } : {}),
    ...(axis?.labelAngle !== undefined ? { tickLabels: { rotate: axis.labelAngle } } : {}),
  };
}

function approximations(chart: ChartModelV1): TanStackChartApproximationV1[] {
  const result: TanStackChartApproximationV1[] = [];
  if (chart.threeD) result.push({ code: "flattened-3d", message: "TanStack static output intentionally flattens Confluence 3D presentation." });
  if (chart.legend && chart.legend !== "none" && chart.legend !== "top") result.push({ code: "legend-position", message: `TanStack 0.3.1 lays out the ${chart.legend} legend in its deterministic top legend region.` });
  if (chart.pie?.explode?.some((value) => value > 0)) result.push({ code: "pie-explode", message: "TanStack 0.3.1 preserves pie labels and values but does not offset exploded sections." });
  if (chart.axes?.x?.categoryLabelPosition || chart.axes?.x?.dateTickPosition || chart.axes?.y?.categoryLabelPosition || chart.axes?.y?.dateTickPosition) result.push({ code: "axis-position", message: "TanStack 0.3.1 preserves ticks and rotation but normalizes Confluence near/center/far axis-position hints." });
  return result;
}

/**
 * The twelve validated model branches create heterogeneous mark tuples. The
 * TanStack overload can infer each literal tuple, but TypeScript cannot retain
 * that inference after the closed runtime discriminant is joined again. Keep
 * the cast at this single boundary; every returned definition is compiled by
 * TanStack immediately in the tests and consumers.
 */
function defineClosedChart(spec: unknown): TanStackChartDefinitionV1 {
  return defineChart(spec as never) as unknown as TanStackChartDefinitionV1;
}

function categoryRows(chart: ChartModelV1): CategoryRow[] {
  if (chart.data.mode !== "categories") return [];
  return chart.data.labels.flatMap((category, categoryIndex) => chart.data.mode === "categories" ? chart.data.series.map((series) => ({
    id: `${series.id}:${categoryIndex}`,
    category,
    series: series.label,
    value: series.values[categoryIndex]!,
  })) : []);
}

function pointRows(chart: ChartModelV1): PointRow[] {
  if (chart.data.mode !== "points") return [];
  const isTime = chart.kind === "timeSeries";
  return chart.data.series.flatMap((series) => series.points.map((point, pointIndex) => ({
    id: `${series.id}:${pointIndex}`,
    x: isTime ? new Date(String(point.x)) : typeof point.x === "number" ? point.x : Number(point.x),
    series: series.label,
    value: point.y,
    label: point.label ?? String(point.x),
  })));
}

function categoryDefinition(chart: ChartModelV1): TanStackChartDefinitionV1 {
  const rows = categoryRows(chart);
  const series = chart.data.mode === "categories" ? chart.data.series.map((entry) => entry.label) : [];
  const extent = numericExtent(rows.map((row) => row.value), chart.orientation === "horizontal" ? chart.axes?.x : chart.axes?.y, true);
  const linear = scaleLinear().domain(extent);
  const band = scaleBand<string>().domain(chart.data.mode === "categories" ? [...chart.data.labels] : []).padding(0.18);
  const layout = chart.stacked ? stack({ offset: "diverging" }) : group({ padding: 0.12 });
  const common = {
    id: `chart-${chart.kind}`,
    z: "series" as const,
    color: "series" as const,
    key: "id" as const,
    fillOpacity: chart.opacity,
  };
  const marks = chart.kind === "bar"
    ? chart.orientation === "horizontal"
      ? [barX(rows, { ...common, x: "value", y: "category", layout, radius: 3 })]
      : [barY(rows, { ...common, x: "category", y: "value", layout, radius: 3 })]
    : chart.kind === "area"
      ? [areaY(rows, { ...common, x: "category", y: "value", fillOpacity: Math.min(0.32, chart.opacity ?? 0.32), ...(chart.stacked ? { layout: stack({ offset: "diverging" }) } : { y1: 0 }) }), lineY(rows, { ...common, x: "category", y: "value", points: chart.showShapes !== false, strokeWidth: 2.5 })]
      : [lineY(rows, { ...common, x: "category", y: "value", points: chart.showShapes !== false, strokeWidth: 2.5 })];
  const xAxis = chart.orientation === "horizontal" && chart.kind === "bar"
    ? { scale: linear, grid: true, axis: { label: chart.xLabel, ...axisTickOptions(chart.axes?.x, tickValues(extent, chart.axes?.x?.tickUnit)) } }
    : { scale: band, grid: false, axis: { label: chart.xLabel, ...axisTickOptions(chart.axes?.x) } };
  const yAxis = chart.orientation === "horizontal" && chart.kind === "bar"
    ? { scale: band, grid: false, axis: { label: chart.yLabel, ...axisTickOptions(chart.axes?.y) } }
    : { scale: linear, grid: true, axis: { label: chart.yLabel, ...axisTickOptions(chart.axes?.y, tickValues(extent, chart.axes?.y?.tickUnit)) } };
  return defineClosedChart({ marks, x: xAxis, y: yAxis, color: legend(chart, series), theme: theme(chart), clip: true });
}

function pointDefinition(chart: ChartModelV1): TanStackChartDefinitionV1 {
  const rows = pointRows(chart);
  const series = chart.data.mode === "points" ? chart.data.series.map((entry) => entry.label) : [];
  const isTime = chart.kind === "timeSeries";
  const numericX = rows.map((row) => row.x instanceof Date ? row.x.getTime() : row.x);
  const baseXExtent = numericExtent(numericX, chart.axes?.x, false);
  const xExtent = chart.kind === "xyBar"
    ? paddedBarExtent(numericX, chart.axes?.x, baseXExtent)
    : baseXExtent;
  const yExtent = numericExtent(rows.map((row) => row.value), chart.axes?.y, ["xyBar", "xyArea", "xyStepArea"].includes(chart.kind));
  const xScale = isTime ? scaleUtc().domain(xExtent.map((value) => new Date(value)) as [Date, Date]) : scaleLinear().domain(xExtent);
  const yScale = scaleLinear().domain(yExtent);
  const common = { id: `chart-${chart.kind}`, z: "series" as const, color: "series" as const, key: "id" as const };
  const stepped = chart.kind === "xyStep" || chart.kind === "xyStepArea";
  const curve = stepped ? d3Curve(curveStepAfter) : undefined;
  const marks = chart.kind === "xyBar"
    ? [barY(rows, { ...common, x: "x", y: "value", layout: group({ padding: 0.12 }), radius: 3, fillOpacity: chart.opacity })]
    : chart.kind === "scatter"
      ? [dot(rows, { ...common, x: "x", y: "value", r: 4.5, fillOpacity: chart.opacity })]
      : chart.kind === "xyArea" || chart.kind === "xyStepArea"
        ? [areaY(rows, { ...common, x: "x", y: "value", y1: 0, curve, fillOpacity: Math.min(0.3, chart.opacity ?? 0.3) }), lineY(rows, { ...common, x: "x", y: "value", curve, points: chart.showShapes === true, strokeWidth: 2.5, strokeOpacity: chart.opacity })]
        : [lineY(rows, { ...common, x: "x", y: "value", curve, points: chart.showShapes !== false && (chart.showShapes === true || chart.kind === "xyLine" || isTime), strokeWidth: 2.5, strokeOpacity: chart.opacity })];
  const dateFormat = utcFormatter(chart.locale?.dateFormat);
  const xTickValues = chart.kind === "xyBar" && chart.axes?.x?.tickUnit === undefined
    ? [...new Set(numericX)].sort((left, right) => left - right)
    : tickValues(xExtent, chart.axes?.x?.tickUnit);
  return defineClosedChart({
    marks,
    x: { scale: xScale, grid: false, axis: { label: chart.xLabel, ...axisTickOptions(chart.axes?.x, isTime ? undefined : xTickValues, isTime ? (value: never) => dateFormat(value as Date) : undefined) } },
    y: { scale: yScale, grid: true, axis: { label: chart.yLabel, ...axisTickOptions(chart.axes?.y, tickValues(yExtent, chart.axes?.y?.tickUnit)) } },
    color: legend(chart, series),
    theme: theme(chart),
    clip: true,
  });
}

function pieLabel(chart: ChartModelV1, row: PieRow, total: number): string {
  const percent = `${Math.round((row.value / total) * 100)}%`;
  switch (chart.pie?.sectionLabel) {
    case "value": return String(row.value);
    case "percent": return percent;
    case "name-value": return `${row.label}: ${row.value}`;
    case "name":
    default: return row.label;
  }
}

function pieDefinition(chart: ChartModelV1): TanStackChartDefinitionV1 {
  if (chart.data.mode !== "categories") throw new Error("pie charts require category data");
  const palette = colors(chart);
  const rows: PieRow[] = chart.data.labels.map((label, index) => ({ id: `pie:${index}`, label, value: Math.max(0, chart.data.mode === "categories" ? chart.data.series[0]?.values[index] ?? 0 : 0), color: palette[index % palette.length]! }));
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  const arcs: PieDatum[] = createPie<PieRow>().sort(null).value((row) => row.value)(rows).map((arc) => ({ ...arc, sectionLabel: pieLabel(chart, arc.data, total) }));
  const marks = [polar({
    marks: [
      radialArc(arcs, { id: "pie-arcs", key: (arc) => arc.data.id, color: (arc) => arc.data.label, fillOpacity: chart.opacity, stroke: "#ffffff", strokeWidth: 1.5 }),
      radialText(arcs, { id: "pie-labels", key: (arc) => arc.data.id, angle: (arc) => (arc.startAngle + arc.endAngle) / 2, radius: 0.62, text: "sectionLabel", fill: "#ffffff", fontSize: 11, fontWeight: 700, anchor: "middle", baseline: "middle" }),
    ],
    angle: { scale: scaleLinear().domain([0, Math.PI * 2]), wrap: true },
    radius: { scale: scaleLinear().domain([0, 1]) },
    inset: 12,
  })];
  return defineClosedChart({ marks, x: null, y: null, color: legend(chart, rows.map((row) => row.label)), theme: theme(chart), margin: 16 });
}

function ganttDefinition(chart: ChartModelV1): TanStackChartDefinitionV1 {
  if (chart.data.mode !== "gantt") throw new Error("gantt charts require task data");
  const palette = colors(chart);
  const tasks: GanttRow[] = chart.data.tasks.map((task, index) => {
    const start = new Date(task.start);
    const end = new Date(task.end);
    const progress = Math.max(0, Math.min(1, task.progress ?? 0));
    return { id: task.id, task: task.label, start, end, progressEnd: new Date(start.getTime() + (end.getTime() - start.getTime()) * progress), progress, color: palette[index % palette.length]! };
  });
  const byId = new Map(chart.data.tasks.map((task) => [task.id, task]));
  const dependencies: GanttDependencyRow[] = chart.data.tasks.flatMap((task) => (task.dependencies ?? []).flatMap((dependency) => {
    const predecessor = byId.get(dependency);
    return predecessor ? [{ id: `${dependency}->${task.id}`, predecessorTask: predecessor.label, predecessorEnd: new Date(predecessor.end), task: task.label, taskStart: new Date(task.start) }] : [];
  }));
  const marks = [
    rect(tasks, { id: "gantt-tasks", x1: "start", x2: "end", y: "task", key: "id", color: "task", fillOpacity: 0.28, radius: 4 }),
    rect(tasks, { id: "gantt-progress", x1: "start", x2: "progressEnd", y: "task", key: "id", color: "task", fillOpacity: 0.9, radius: 4 }),
    arrow(dependencies, { id: "gantt-dependencies", x1: "predecessorEnd", y1: "predecessorTask", x2: "taskStart", y2: "task", key: "id", stroke: "#6554c0", strokeWidth: 1.5, headLength: 7 }),
  ];
  const timestamps = tasks.flatMap((task) => [task.start.getTime(), task.end.getTime()]);
  const extent = numericExtent(timestamps, chart.axes?.x, false);
  const format = utcFormatter(chart.locale?.dateFormat);
  return defineClosedChart({
    marks,
    x: { scale: scaleUtc().domain(extent.map((value) => new Date(value)) as [Date, Date]), grid: true, axis: { label: chart.xLabel, ticks: { format } } },
    y: { scale: scaleBand<string>().domain(tasks.map((task) => task.task)).padding(0.22), grid: false, axis: { label: chart.yLabel } },
    color: legend(chart, tasks.map((task) => task.task)),
    theme: theme(chart),
    clip: false,
  });
}

export function createTanStackChartDefinitionV1(input: ChartModelV1): TanStackChartAdapterResultV1 {
  const chart = validateChartModelV1(input);
  const definition = chart.kind === "pie"
    ? pieDefinition(chart)
    : chart.kind === "gantt"
      ? ganttDefinition(chart)
      : chart.data.mode === "categories"
        ? categoryDefinition(chart)
        : pointDefinition(chart);
  return Object.freeze({ definition, approximations: Object.freeze(approximations(chart)) });
}

export function createTanStackChartSceneV1(input: ChartModelV1, options: Pick<RenderTanStackChartSvgOptionsV1, "width" | "height"> = {}): ChartScene {
  const chart = validateChartModelV1(input);
  const { definition } = createTanStackChartDefinitionV1(chart);
  const width = Math.max(320, Math.min(1200, Math.round(options.width ?? chart.display?.width ?? TANSTACK_CHART_SIZE_V1.width)));
  const height = Math.max(220, Math.min(800, Math.round(options.height ?? chart.display?.height ?? TANSTACK_CHART_SIZE_V1.height)));
  return createChartScene(definition, { width, height });
}

export function renderTanStackChartSvgV1(input: ChartModelV1, options: RenderTanStackChartSvgOptionsV1 = {}): string {
  const chart = validateChartModelV1(input);
  const scene = createTanStackChartSceneV1(chart, options);
  const render = scene.gradients.length > 0 ? renderChartSvgWithResources : renderChartSvg;
  const svg = render(scene, {
    ariaLabel: options.ariaLabel ?? chart.title ?? `${chart.kind} chart`,
    ariaDescription: options.ariaDescription ?? chart.subtitle ?? `${chart.kind} chart with normalized Confluence data`,
    idPrefix: options.idPrefix ?? `atlcli-${chart.kind}`,
    tabIndex: 0,
  });
  // TanStack's DOM-free renderer emits an HTML-compatible `<svg>` root. The
  // namespace is optional in HTML but mandatory for standalone consumers such
  // as resvg, Word's svgBlip part, and strict XML tooling.
  return svg.includes('xmlns="http://www.w3.org/2000/svg"')
    ? svg
    : svg.replace(/^<svg\b/u, '<svg xmlns="http://www.w3.org/2000/svg"');
}

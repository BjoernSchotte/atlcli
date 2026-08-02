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
  type ChartColorLegend,
  type ChartScene,
  type ChartValue,
  type SceneGroup,
  type SceneNode,
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
  code: "flattened-3d";
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

function legendPosition(chart: ChartModelV1): Exclude<ChartModelV1["legend"], undefined> {
  return chart.legend ?? "top";
}

function legendItemLabel(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters ? value : `${characters.slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
}

function positionedColorLegend(chart: ChartModelV1, itemCount: number): ChartColorLegend {
  const position = legendPosition(chart);
  const top = colorLegend({ itemWidth: 128 });
  if (position === "top") return top;
  return {
    height: () => 0,
    render: ({ colors: colorScale, chart: bounds, width }) => {
      const children: SceneNode[] = [];
      if (position === "left" || position === "right") {
        const availableHeight = Math.max(19, bounds.height);
        const rows = Math.max(1, Math.floor(availableHeight / 19));
        const columns = Math.max(1, Math.ceil(itemCount / rows));
        const availableWidth = position === "left" ? Math.max(72, bounds.x - 64) : Math.max(72, width - bounds.x - bounds.width - 20);
        const itemWidth = availableWidth / columns;
        const maxCharacters = Math.max(4, Math.floor((itemWidth - 22) / 6.4));
        const startX = position === "left" ? 12 : bounds.x + bounds.width + 18;
        colorScale.domain.forEach((value, index) => {
          const column = Math.floor(index / rows);
          const row = index % rows;
          const x = startX + column * itemWidth;
          const y = bounds.y + 10 + row * 19;
          children.push(
            { kind: "dot", key: `legend-dot:${String(value)}`, x: x + 4, y, radius: 4, style: { fill: colorScale.map(value) } },
            { kind: "label", key: `legend-label:${String(value)}`, x: x + 13, y, text: legendItemLabel(String(value), maxCharacters), baseline: "middle", fontSize: 11, style: { fill: theme(chart).foreground, fillOpacity: 0.76 } },
          );
        });
      } else {
        const columns = Math.max(1, Math.floor(bounds.width / 128));
        const itemWidth = bounds.width / Math.max(1, Math.min(columns, itemCount));
        const startY = bounds.y + bounds.height + 48;
        colorScale.domain.forEach((value, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          const x = bounds.x + column * itemWidth;
          const y = startY + row * 19;
          children.push(
            { kind: "dot", key: `legend-dot:${String(value)}`, x: x + 4, y, radius: 4, style: { fill: colorScale.map(value) } },
            { kind: "label", key: `legend-label:${String(value)}`, x: x + 13, y, text: legendItemLabel(String(value), Math.max(4, Math.floor((itemWidth - 20) / 6.4))), baseline: "middle", fontSize: 11, style: { fill: theme(chart).foreground, fillOpacity: 0.76 } },
          );
        });
      }
      return { kind: "group", key: "legend", className: `ts-chart__legend ts-chart__legend--${position}`, ariaHidden: true, children };
    },
  };
}

function legendMargin(chart: ChartModelV1, domain: readonly string[]): Partial<{ top: number; right: number; bottom: number; left: number }> | undefined {
  if (chart.legend === "none" || domain.length < 2 || legendPosition(chart) === "top") return undefined;
  const width = Math.max(320, Math.min(1200, chart.display?.width ?? TANSTACK_CHART_SIZE_V1.width));
  const height = Math.max(220, Math.min(800, chart.display?.height ?? TANSTACK_CHART_SIZE_V1.height));
  const position = legendPosition(chart);
  if (position === "bottom") {
    const columns = Math.max(1, Math.floor(Math.max(1, width - 80) / 128));
    const rows = Math.ceil(domain.length / columns);
    return { bottom: Math.min(height * 0.42, 58 + rows * 19) };
  }
  const longest = Math.max(...domain.map((value) => [...value].length));
  const legendWidth = Math.min(width * 0.34, Math.max(96, longest * 6.4 + 32));
  return position === "left" ? { left: legendWidth + 64 } : { right: legendWidth + 16 };
}

function legend(chart: ChartModelV1, domain: readonly string[]) {
  return chart.legend === "none" || domain.length < 2 ? undefined : {
    domain,
    range: colors(chart),
    legend: positionedColorLegend(chart, domain.length),
  };
}

function axisTickOptions(axis: ChartAxisV1 | undefined, values?: readonly ChartValue[], formatter?: (value: never) => string) {
  const ticks = values ? { values } : undefined;
  const categoryRotation = axis?.categoryLabelPosition === "up45" ? -45
    : axis?.categoryLabelPosition === "up90" ? -90
      : axis?.categoryLabelPosition === "down45" ? 45
        : axis?.categoryLabelPosition === "down90" ? 90
          : undefined;
  return {
    ...(ticks || formatter ? { ticks: { ...ticks, ...(formatter ? { format: formatter } : {}) } } : {}),
    ...(axis?.labelAngle !== undefined || categoryRotation !== undefined ? { tickLabels: { rotate: axis?.labelAngle ?? categoryRotation } } : {}),
  };
}

function nextUtcPeriodStart(value: Date, period: NonNullable<ChartModelV1["locale"]>["timePeriod"]): Date {
  const next = new Date(value.getTime());
  switch (period) {
    case "millisecond": next.setTime(next.getTime() + 1); break;
    case "second": next.setUTCSeconds(next.getUTCSeconds() + 1); break;
    case "minute": next.setUTCMinutes(next.getUTCMinutes() + 1); break;
    case "hour": next.setUTCHours(next.getUTCHours() + 1); break;
    case "week": next.setUTCDate(next.getUTCDate() + 7); break;
    case "month": next.setUTCMonth(next.getUTCMonth() + 1); break;
    case "quarter": next.setUTCMonth(next.getUTCMonth() + 3); break;
    case "year": next.setUTCFullYear(next.getUTCFullYear() + 1); break;
    case "day":
    default: next.setUTCDate(next.getUTCDate() + 1); break;
  }
  return next;
}

function positionedDateTicks(chart: ChartModelV1, timestamps: readonly number[]): { values?: readonly Date[]; format: (value: Date) => string } {
  const dateFormat = utcFormatter(chart.locale?.dateFormat);
  const position = chart.axes?.x?.dateTickPosition;
  if (!position) return { format: dateFormat };
  const period = chart.locale?.timePeriod ?? "day";
  const labels = new Map<number, Date>();
  const values = [...new Set(timestamps)].sort((left, right) => left - right).map((timestamp) => {
    const start = new Date(timestamp);
    const next = nextUtcPeriodStart(start, period);
    const positioned = position === "start" ? start
      : position === "middle" ? new Date(start.getTime() + (next.getTime() - start.getTime()) / 2)
        : new Date(next.getTime() - 1);
    labels.set(positioned.getTime(), start);
    return positioned;
  });
  return { values, format: (value) => dateFormat(labels.get(value.getTime()) ?? value) };
}

function approximations(chart: ChartModelV1): TanStackChartApproximationV1[] {
  const result: TanStackChartApproximationV1[] = [];
  if (chart.threeD) result.push({ code: "flattened-3d", message: "TanStack static output intentionally flattens Confluence 3D presentation." });
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
  return defineClosedChart({ marks, x: xAxis, y: yAxis, color: legend(chart, series), margin: legendMargin(chart, series), theme: theme(chart), clip: true });
}

function pointDefinition(chart: ChartModelV1): TanStackChartDefinitionV1 {
  const rows = pointRows(chart);
  const series = chart.data.mode === "points" ? chart.data.series.map((entry) => entry.label) : [];
  const isTime = chart.kind === "timeSeries";
  const numericX = rows.map((row) => row.x instanceof Date ? row.x.getTime() : row.x);
  const dateTicks = isTime ? positionedDateTicks(chart, numericX) : undefined;
  const extentValues = dateTicks?.values ? [...numericX, ...dateTicks.values.map((value) => value.getTime())] : numericX;
  const baseXExtent = numericExtent(extentValues, chart.axes?.x, false);
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
  const xTickValues = chart.kind === "xyBar" && chart.axes?.x?.tickUnit === undefined
    ? [...new Set(numericX)].sort((left, right) => left - right)
    : tickValues(xExtent, chart.axes?.x?.tickUnit);
  return defineClosedChart({
    marks,
    x: { scale: xScale, grid: false, axis: { label: chart.xLabel, ...axisTickOptions(chart.axes?.x, isTime ? dateTicks?.values : xTickValues, isTime ? (value: never) => dateTicks!.format(value as Date) : undefined) } },
    y: { scale: yScale, grid: true, axis: { label: chart.yLabel, ...axisTickOptions(chart.axes?.y, tickValues(yExtent, chart.axes?.y?.tickUnit)) } },
    color: legend(chart, series),
    margin: legendMargin(chart, series),
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
  const domain = rows.map((row) => row.label);
  return defineClosedChart({
    marks,
    x: null,
    y: null,
    color: legend(chart, domain),
    theme: theme(chart),
    margin: { right: 16, bottom: 16, left: 16, ...legendMargin(chart, domain) },
  });
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
  const timeScale = scaleUtc().domain(extent.map((value) => new Date(value)) as [Date, Date]);
  return defineClosedChart({
    marks,
    x: { scale: timeScale, grid: true, axis: { label: chart.xLabel, ticks: { values: timeScale.ticks(5), format } } },
    y: { scale: scaleBand<string>().domain(tasks.map((task) => task.task)).padding(0.22), grid: false, axis: { label: chart.yLabel } },
    color: legend(chart, tasks.map((task) => task.task)),
    margin: legendMargin(chart, tasks.map((task) => task.task)),
    theme: theme(chart),
    clip: false,
  });
}

function pieExplodeOffsets(chart: ChartModelV1, scene: ChartScene): ReadonlyMap<number, { x: number; y: number }> {
  if (chart.kind !== "pie" || chart.data.mode !== "categories" || !chart.pie?.explode?.length) return new Map();
  const exploded = new Set(chart.pie.explode);
  const values = chart.data.labels.map((label, index) => ({ label, value: Math.max(0, chart.data.mode === "categories" ? chart.data.series[0]?.values[index] ?? 0 : 0) }));
  const arcs = createPie<(typeof values)[number]>().sort(null).value((entry) => entry.value)(values);
  const distance = Math.max(8, Math.min(14, Math.min(scene.chart.width, scene.chart.height) * 0.035));
  return new Map(arcs.flatMap((arc, index) => {
    if (!exploded.has(arc.data.label)) return [];
    const angle = (arc.startAngle + arc.endAngle) / 2;
    return [[index, { x: Math.sin(angle) * distance, y: -Math.cos(angle) * distance }] as const];
  }));
}

function pieIndexFromKey(key: string): number | undefined {
  const match = key.match(/:pie:(\d+)(?::dot)?$/u);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : undefined;
}

function explodePieScene(chart: ChartModelV1, scene: ChartScene): ChartScene {
  const offsets = pieExplodeOffsets(chart, scene);
  if (offsets.size === 0) return scene;
  const movePoint = <T extends { key: string; x: number; y: number }>(point: T): T => {
    const index = pieIndexFromKey(point.key);
    const offset = index === undefined ? undefined : offsets.get(index);
    return offset ? { ...point, x: point.x + offset.x, y: point.y + offset.y } : point;
  };
  const moveNode = (node: SceneNode): SceneNode => {
    const mapped = node.kind === "group"
      ? {
          ...node,
          children: node.children.map(moveNode),
          ...(node.focus ? { focus: { ...node.focus, points: node.focus.points.map(movePoint) } } : {}),
        } satisfies SceneGroup
      : node;
    const index = pieIndexFromKey(mapped.key);
    const offset = index === undefined ? undefined : offsets.get(index);
    if (!offset) return mapped;
    return {
      kind: "group",
      key: `pie-explode:${mapped.key}`,
      className: "ts-chart__pie-explode",
      translateX: offset.x,
      translateY: offset.y,
      children: [mapped],
    } satisfies SceneGroup;
  };
  return {
    ...scene,
    nodes: scene.nodes.map(moveNode),
    points: scene.points.map(movePoint),
  };
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
  return explodePieScene(chart, createChartScene(definition, { width, height }));
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

/**
 * Renderer-neutral Confluence Chart macro model.
 *
 * This module deliberately contains no Confluence client, XML/ADF, Astro,
 * DOCX, PDF, or chart-library dependency. Source adapters normalize into this
 * closed model; every consumer can then choose its own projection without
 * receiving raw macro parameters or executable values.
 */

export type ChartKindV1 =
  | "pie"
  | "bar"
  | "line"
  | "area"
  | "xyArea"
  | "xyBar"
  | "xyLine"
  | "xyStep"
  | "xyStepArea"
  | "scatter"
  | "timeSeries"
  | "gantt";

export type ChartSourceKindV1 = "cloud-adf" | "dc-storage";

export interface ChartPointV1 {
  x: number | string;
  y: number;
  label?: string;
}

export interface ChartCategorySeriesV1 {
  id: string;
  label: string;
  values: readonly number[];
}

export interface ChartPointSeriesV1 {
  id: string;
  label: string;
  points: readonly ChartPointV1[];
}

export interface GanttTaskV1 {
  id: string;
  label: string;
  start: string;
  end: string;
  progress?: number;
  dependencies?: readonly string[];
}

export type ChartDataV1 =
  | {
      mode: "categories";
      labels: readonly string[];
      series: readonly ChartCategorySeriesV1[];
    }
  | {
      mode: "points";
      series: readonly ChartPointSeriesV1[];
    }
  | {
      mode: "gantt";
      tasks: readonly GanttTaskV1[];
    };

export type ChartAxisPositionV1 = "near" | "center" | "far";

export interface ChartAxisV1 {
  min?: number | string;
  max?: number | string;
  tickUnit?: number;
  labelAngle?: number;
  categoryLabelPosition?: ChartAxisPositionV1;
  dateTickPosition?: ChartAxisPositionV1;
}

export interface ChartAxesV1 {
  x?: ChartAxisV1;
  y?: ChartAxisV1;
}

export interface ChartStyleV1 {
  backgroundColor?: string;
  borderColor?: string;
  colors?: readonly string[];
}

export interface ChartSourceProvenanceV1 {
  kind: ChartSourceKindV1;
  macroName: "chart";
  attachment?: {
    filename: string;
    version?: number;
    comment?: string;
    thumbnail?: boolean;
  };
  dependencyDigest?: string;
}

export interface ChartModelV1 {
  schema: "atlcli.chart/1";
  kind: ChartKindV1;
  title?: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  legend?: "none" | "top" | "right" | "bottom" | "left";
  orientation?: "vertical" | "horizontal";
  stacked?: boolean;
  threeD?: boolean;
  showShapes?: boolean;
  opacity?: number;
  display?: {
    width?: number;
    height?: number;
    data?: "hidden" | "before" | "after";
  };
  style?: ChartStyleV1;
  axes?: ChartAxesV1;
  pie?: {
    sectionLabel?: "name" | "value" | "percent" | "name-value";
    explode?: readonly number[];
  };
  locale?: {
    language?: string;
    country?: string;
    dateFormat?: string;
    timePeriod?:
      | "millisecond"
      | "second"
      | "minute"
      | "hour"
      | "day"
      | "week"
      | "month"
      | "quarter"
      | "year";
  };
  data: ChartDataV1;
  source: ChartSourceProvenanceV1;
}

export type ChartDiagnosticCodeV1 =
  | "unsupported-kind"
  | "malformed-data"
  | "invalid-option"
  | "locale-parse"
  | "skipped-row"
  | "missing-attachment"
  | "truncated"
  | "renderer-fallback";

export interface ChartDiagnosticV1 {
  code: ChartDiagnosticCodeV1;
  message: string;
  parameter?: string;
  row?: number;
}

/** Validate diagnostics retained on a chart block after lenient source parsing. */
export function validateChartDiagnosticsV1(diagnostics: readonly ChartDiagnosticV1[]): readonly ChartDiagnosticV1[] {
  const codes = new Set<ChartDiagnosticCodeV1>([
    "unsupported-kind", "malformed-data", "invalid-option", "locale-parse", "skipped-row",
    "missing-attachment", "truncated", "renderer-fallback",
  ]);
  if (diagnostics.length > 256) throw new ChartValidationErrorV1("chart diagnostics exceed limits");
  return diagnostics.map((diagnostic, index) => {
    if (!diagnostic || !codes.has(diagnostic.code)) throw new ChartValidationErrorV1(`chart diagnostic ${index + 1} code is invalid`);
    const message = boundedText(diagnostic.message, `chart diagnostic ${index + 1} message`);
    if (!message) throw new ChartValidationErrorV1(`chart diagnostic ${index + 1} message must be non-empty`);
    if (diagnostic.parameter !== undefined) boundedText(diagnostic.parameter, `chart diagnostic ${index + 1} parameter`);
    if (diagnostic.row !== undefined && (!Number.isSafeInteger(diagnostic.row) || diagnostic.row < 1)) {
      throw new ChartValidationErrorV1(`chart diagnostic ${index + 1} row is invalid`);
    }
    return { ...diagnostic, message };
  });
}

export class ChartValidationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartValidationErrorV1";
  }
}

export const CHART_KINDS_V1: readonly ChartKindV1[] = Object.freeze([
  "pie",
  "bar",
  "line",
  "area",
  "xyArea",
  "xyBar",
  "xyLine",
  "xyStep",
  "xyStepArea",
  "scatter",
  "timeSeries",
  "gantt",
]);

export const CHART_LIMITS_V1 = Object.freeze({
  maxRows: 2_000,
  maxSeries: 64,
  maxPoints: 20_000,
  maxTasks: 5_000,
  maxTextLength: 10_000,
  maxPayloadBytes: 512 * 1024,
  maxPaletteEntries: 64,
});

const HEX_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new ChartValidationErrorV1(`${label} must be finite`);
  return value;
}

function boundedText(value: string, label: string): string {
  const text = value.trim();
  if (text.length > CHART_LIMITS_V1.maxTextLength) {
    throw new ChartValidationErrorV1(`${label} exceeds chart text limit`);
  }
  return text;
}

function validateDate(value: string, label: string): string {
  const text = boundedText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/u.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ChartValidationErrorV1(`${label} must be an ISO date/time`);
  }
  return text;
}

function validateSeriesCount(series: readonly unknown[]): void {
  if (series.length === 0 || series.length > CHART_LIMITS_V1.maxSeries) {
    throw new ChartValidationErrorV1("chart series exceed limits");
  }
}

function validateCategoryData(data: Extract<ChartDataV1, { mode: "categories" }>): void {
  if (data.labels.length === 0 || data.labels.length > CHART_LIMITS_V1.maxRows) {
    throw new ChartValidationErrorV1("chart labels exceed limits");
  }
  const labels = data.labels.map((label, index) => boundedText(label, `label ${index + 1}`));
  if (labels.some((label) => label.length === 0)) throw new ChartValidationErrorV1("chart labels must be non-empty");
  validateSeriesCount(data.series);
  const ids = new Set<string>();
  for (const [seriesIndex, series] of data.series.entries()) {
    const id = boundedText(series.id, `series ${seriesIndex + 1} id`);
    const label = boundedText(series.label, `series ${seriesIndex + 1} label`);
    if (!id || ids.has(id)) throw new ChartValidationErrorV1("chart series ids must be unique and non-empty");
    if (!label) throw new ChartValidationErrorV1("chart series labels must be non-empty");
    ids.add(id);
    if (series.values.length !== labels.length) {
      throw new ChartValidationErrorV1("category series must align with labels");
    }
    for (const [valueIndex, value] of series.values.entries()) {
      finite(value, `series ${seriesIndex + 1} value ${valueIndex + 1}`);
    }
  }
}

function validatePointData(data: Extract<ChartDataV1, { mode: "points" }>): void {
  validateSeriesCount(data.series);
  const ids = new Set<string>();
  let points = 0;
  for (const [seriesIndex, series] of data.series.entries()) {
    const id = boundedText(series.id, `series ${seriesIndex + 1} id`);
    const label = boundedText(series.label, `series ${seriesIndex + 1} label`);
    if (!id || ids.has(id)) throw new ChartValidationErrorV1("chart series ids must be unique and non-empty");
    if (!label) throw new ChartValidationErrorV1("chart series labels must be non-empty");
    ids.add(id);
    if (series.points.length === 0 || series.points.length > CHART_LIMITS_V1.maxRows) {
      throw new ChartValidationErrorV1("chart point rows exceed limits");
    }
    points += series.points.length;
    for (const [pointIndex, point] of series.points.entries()) {
      if (typeof point.x === "number") finite(point.x, `point ${pointIndex + 1} x`);
      else if (typeof point.x === "string") boundedText(point.x, `point ${pointIndex + 1} x`);
      else throw new ChartValidationErrorV1("chart point x values must be numbers or strings");
      finite(point.y, `point ${pointIndex + 1} y`);
      if (point.label !== undefined) boundedText(point.label, `point ${pointIndex + 1} label`);
    }
  }
  if (points > CHART_LIMITS_V1.maxPoints) throw new ChartValidationErrorV1("chart point count exceeds limits");
}

function validateGanttData(data: Extract<ChartDataV1, { mode: "gantt" }>): void {
  if (data.tasks.length === 0 || data.tasks.length > CHART_LIMITS_V1.maxTasks) {
    throw new ChartValidationErrorV1("Gantt task count exceeds limits");
  }
  const ids = new Set<string>();
  for (const task of data.tasks) {
    const id = boundedText(task.id, "Gantt task id");
    if (!id || ids.has(id)) throw new ChartValidationErrorV1("Gantt task ids must be unique and non-empty");
    ids.add(id);
    boundedText(task.label, "Gantt task label");
    const start = validateDate(task.start, "Gantt task start");
    const end = validateDate(task.end, "Gantt task end");
    if (Date.parse(end) < Date.parse(start)) throw new ChartValidationErrorV1("Gantt task end precedes start");
    if (task.progress !== undefined && (finite(task.progress, "Gantt progress") < 0 || task.progress > 1)) {
      throw new ChartValidationErrorV1("Gantt progress must be between 0 and 1");
    }
    for (const dependency of task.dependencies ?? []) boundedText(dependency, "Gantt dependency");
  }
}

function validateAxis(axis: ChartAxisV1 | undefined, label: string): void {
  if (!axis) return;
  const positions = new Set<ChartAxisPositionV1>(["near", "center", "far"]);
  for (const [key, value] of Object.entries(axis)) {
    if (key === "min" || key === "max") {
      if (typeof value === "number") finite(value, `${label}.${key}`);
      else if (typeof value === "string") boundedText(value, `${label}.${key}`);
      else throw new ChartValidationErrorV1(`${label}.${key} is invalid`);
    } else if (key === "tickUnit" || key === "labelAngle") {
      finite(value as number, `${label}.${key}`);
      if (key === "tickUnit" && (value as number) <= 0) {
        throw new ChartValidationErrorV1(`${label}.tickUnit must be positive`);
      }
      if (key === "labelAngle" && Math.abs(value as number) > 360) {
        throw new ChartValidationErrorV1(`${label}.labelAngle is out of range`);
      }
    } else if (key === "categoryLabelPosition" || key === "dateTickPosition") {
      if (typeof value !== "string" || !positions.has(value as ChartAxisPositionV1)) {
        throw new ChartValidationErrorV1(`${label}.${key} is invalid`);
      }
    }
  }
  if (typeof axis.min === "number" && typeof axis.max === "number" && axis.max < axis.min) {
    throw new ChartValidationErrorV1(`${label}.max must not precede min`);
  }
}

/** Validate and defensively clone a chart model before it crosses a renderer boundary. */
export function validateChartModelV1(model: ChartModelV1): ChartModelV1 {
  if (!model || model.schema !== "atlcli.chart/1") throw new ChartValidationErrorV1("unsupported chart schema");
  if (!CHART_KINDS_V1.includes(model.kind)) throw new ChartValidationErrorV1(`unsupported chart kind: ${String(model.kind)}`);
  for (const [key, value] of Object.entries(model)) {
    if (key === "title" || key === "subtitle" || key === "xLabel" || key === "yLabel") {
      if (value !== undefined) boundedText(value as string, key);
    }
  }
  if (model.opacity !== undefined && (finite(model.opacity, "opacity") < 0 || model.opacity > 1)) {
    throw new ChartValidationErrorV1("opacity must be between 0 and 1");
  }
  if (model.legend !== undefined && !["none", "top", "right", "bottom", "left"].includes(model.legend)) {
    throw new ChartValidationErrorV1("legend position is invalid");
  }
  if (model.orientation !== undefined && !["vertical", "horizontal"].includes(model.orientation)) {
    throw new ChartValidationErrorV1("chart orientation is invalid");
  }
  if (model.display?.data !== undefined && !["hidden", "before", "after"].includes(model.display.data)) {
    throw new ChartValidationErrorV1("chart data display mode is invalid");
  }
  if (model.locale?.timePeriod !== undefined && ![
    "millisecond", "second", "minute", "hour", "day", "week", "month", "quarter", "year",
  ].includes(model.locale.timePeriod)) {
    throw new ChartValidationErrorV1("chart time period is invalid");
  }
  if (model.pie?.sectionLabel !== undefined && !["name", "value", "percent", "name-value"].includes(model.pie.sectionLabel)) {
    throw new ChartValidationErrorV1("pie section label is invalid");
  }
  if (model.display) {
    for (const [key, value] of Object.entries(model.display)) {
      if (key === "width" || key === "height") {
        if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
          throw new ChartValidationErrorV1(`${key} must be a bounded positive integer`);
        }
      }
    }
  }
  validateAxis(model.axes?.x, "axes.x");
  validateAxis(model.axes?.y, "axes.y");
  for (const color of [model.style?.backgroundColor, model.style?.borderColor, ...(model.style?.colors ?? [])]) {
    if (color !== undefined && !HEX_COLOR.test(color)) throw new ChartValidationErrorV1("chart colors must be canonical hex values");
  }
  if ((model.style?.colors?.length ?? 0) > CHART_LIMITS_V1.maxPaletteEntries) {
    throw new ChartValidationErrorV1("chart palette exceeds limits");
  }
  for (const [index, color] of (model.style?.colors ?? []).entries()) {
    if (!color.trim()) throw new ChartValidationErrorV1(`chart palette entry ${index + 1} must be non-empty`);
  }
  if (model.data.mode === "categories") validateCategoryData(model.data);
  else if (model.data.mode === "points") validatePointData(model.data);
  else validateGanttData(model.data);
  if (model.kind === "gantt" && model.data.mode !== "gantt") throw new ChartValidationErrorV1("Gantt charts require task data");
  if (model.kind !== "gantt" && model.data.mode === "gantt") throw new ChartValidationErrorV1("non-Gantt charts cannot use task data");
  if (model.source.macroName !== "chart") throw new ChartValidationErrorV1("chart source must be the Chart macro");
  const encoded = new TextEncoder().encode(JSON.stringify(model));
  if (encoded.byteLength > CHART_LIMITS_V1.maxPayloadBytes) throw new ChartValidationErrorV1("chart payload exceeds limits");
  return structuredClone(model);
}

export function chartModelDigestV1(model: ChartModelV1): string {
  const normalized = validateChartModelV1(model);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(JSON.stringify(normalized))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

import { validateChartModelV1, type ChartModelV1, type ExportBlock } from "@atlcli/export-blocks";

export interface StaticChartSeriesV1 {
  name: string;
  values: readonly number[];
}

export interface StaticChartModelV1 {
  title: string;
  labels: readonly string[];
  series: readonly StaticChartSeriesV1[];
}

export interface NormalizedStaticChartV1 extends StaticChartModelV1 {
  maximum: number;
}

/** A browser-safe row derived from a validated chart ExportBlock. */
export interface ChartExportBlockRowV1 {
  label: string;
  series: string;
  value: number;
}

export interface NormalizedChartExportBlockV1 {
  block: Extract<ExportBlock, { type: "chart" }>;
  model: ChartModelV1;
  rows: readonly ChartExportBlockRowV1[];
  maximum: number;
}

/** Explicit capability identity for the first new-model TanStack adapter. */
export type ChartExportBlockRendererAdapterIdV1 = "tanstack-v0.3/bar";

export interface ChartExportBlockRendererAdapterV1 {
  readonly id: ChartExportBlockRendererAdapterIdV1;
  readonly capability: "bounded-interactive-bar";
  readonly runtime: "client-only";
  readonly handles: readonly ["bar", "xyBar"];
  validate(block: Extract<ExportBlock, { type: "chart" }>): NormalizedChartExportBlockV1;
}

/** Closed set of build-selected renderer implementations. */
export type ChartRendererAdapterIdV1 = "tanstack-v0.3";

export interface ChartRendererAdapterV1 {
  readonly id: ChartRendererAdapterIdV1;
  readonly capability: "bounded-interactive-bar";
  readonly runtime: "client-only";
  validate(model: StaticChartModelV1): NormalizedStaticChartV1;
}

export class StaticChartValidationErrorV1 extends Error {}

const MAX_ROWS = 200;
const MAX_SERIES = 24;
const MAX_INTERACTIVE_ROWS = 80;
const MAX_INTERACTIVE_SERIES = 12;
const MAX_INTERACTIVE_POINTS = 800;
const MAX_INTERACTIVE_PAYLOAD_BYTES = 64 * 1024;

/**
 * Validate the new source-neutral chart block before it crosses into a client
 * island. V1 promotes categorical bars and the provider's XY-bar shape to the
 * same bounded TanStack bar capability; every other shape keeps its static
 * ChartBlock/table representation.
 */
export function validateInteractiveChartExportBlockV1(
  block: Extract<ExportBlock, { type: "chart" }>,
): NormalizedChartExportBlockV1 {
  const model = validateChartModelV1(block.chart);
  if (
    (model.kind !== "bar" && model.kind !== "xyBar") ||
    (model.kind === "bar" && model.data.mode !== "categories") ||
    (model.kind === "xyBar" && model.data.mode !== "points")
  ) {
    throw new StaticChartValidationErrorV1("TanStack V1 only supports categorical and XY bar chart ExportBlocks");
  }
  const data = model.data;
  if (data.mode !== "categories" && data.mode !== "points") {
    throw new StaticChartValidationErrorV1("TanStack V1 only supports categorical and XY bar chart ExportBlocks");
  }
  const rowCount = data.mode === "categories"
    ? data.labels.length
    : Math.max(...data.series.map((entry) => entry.points.length));
  if (rowCount > MAX_INTERACTIVE_ROWS || data.series.length > MAX_INTERACTIVE_SERIES) {
    throw new StaticChartValidationErrorV1("interactive chart exceeds row, series, or point limits");
  }
  const rows: ChartExportBlockRowV1[] = data.mode === "categories"
    ? data.labels.flatMap((label, labelIndex) => data.series.map((entry) => ({
      label,
      series: entry.label,
      value: entry.values[labelIndex]!,
    })))
    : data.series.flatMap((entry) => entry.points.map((point) => ({
      label: point.label ?? String(point.x),
      series: entry.label,
      value: point.y,
    })));
  if (rows.some((row) => row.value < 0)) {
    throw new StaticChartValidationErrorV1("interactive bar charts require non-negative values");
  }
  if (rows.length > MAX_INTERACTIVE_POINTS) {
    throw new StaticChartValidationErrorV1("interactive chart exceeds row, series, or point limits");
  }
  if (new TextEncoder().encode(JSON.stringify({ kind: model.kind, title: model.title, data })).byteLength > MAX_INTERACTIVE_PAYLOAD_BYTES) {
    throw new StaticChartValidationErrorV1("interactive chart exceeds payload byte limit");
  }
  return Object.freeze({
    block,
    model,
    rows: Object.freeze(rows),
    maximum: Math.max(1, ...rows.map((row) => row.value)),
  });
}

export const TANSTACK_CHART_EXPORT_BLOCK_RENDERER_ADAPTER_V1: ChartExportBlockRendererAdapterV1 = Object.freeze({
  id: "tanstack-v0.3/bar",
  capability: "bounded-interactive-bar",
  runtime: "client-only",
  handles: ["bar", "xyBar"] as const,
  validate: validateInteractiveChartExportBlockV1,
});

export function resolveChartExportBlockRendererAdapterV1(
  id: ChartExportBlockRendererAdapterIdV1 = "tanstack-v0.3/bar",
): ChartExportBlockRendererAdapterV1 {
  switch (id) {
    case "tanstack-v0.3/bar": return TANSTACK_CHART_EXPORT_BLOCK_RENDERER_ADAPTER_V1;
    default: return assertNeverChartExportBlockRendererAdapterV1(id);
  }
}

export function normalizeStaticChartV1(model: StaticChartModelV1): NormalizedStaticChartV1 {
  if (!model || typeof model !== "object" || typeof model.title !== "string" || !model.title.trim()) throw new StaticChartValidationErrorV1("chart title must be non-empty");
  if (!Array.isArray(model.labels) || model.labels.length === 0 || model.labels.length > MAX_ROWS || !model.labels.every((label) => typeof label === "string")) throw new StaticChartValidationErrorV1("chart labels exceed limits");
  if (!Array.isArray(model.series) || model.series.length === 0 || model.series.length > MAX_SERIES) throw new StaticChartValidationErrorV1("chart series exceed limits");
  let maximum = 0;
  for (const series of model.series) {
    if (!series || typeof series.name !== "string" || !series.name.trim() || !Array.isArray(series.values) || series.values.length !== model.labels.length) throw new StaticChartValidationErrorV1("chart series shape is invalid");
    for (const value of series.values) {
      if (!Number.isFinite(value) || value < 0) throw new StaticChartValidationErrorV1("chart values must be finite non-negative numbers");
      maximum = Math.max(maximum, value);
    }
  }
  return Object.freeze({ ...model, maximum: maximum || 1 });
}

/**
 * Validates the bounded, build-frozen data that an opt-in chart island may
 * inspect from its static SVG. The island never receives a URL, callback,
 * renderer definition, or executable configuration.
 */
export function validateInteractiveChartV1(model: StaticChartModelV1): NormalizedStaticChartV1 {
  const normalized = normalizeStaticChartV1(model);
  const pointCount = normalized.labels.length * normalized.series.length;
  if (normalized.labels.length > MAX_INTERACTIVE_ROWS || normalized.series.length > MAX_INTERACTIVE_SERIES || pointCount > MAX_INTERACTIVE_POINTS) {
    throw new StaticChartValidationErrorV1("interactive chart exceeds row, series, or point limits");
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_INTERACTIVE_PAYLOAD_BYTES) {
    throw new StaticChartValidationErrorV1("interactive chart exceeds payload byte limit");
  }
  return normalized;
}

/**
 * The preferred V1 interactive renderer. Its code creates the chart definition
 * locally from bounded static DOM data; definitions and callbacks are never a
 * PublicationBundle serialization format.
 */
export const TANSTACK_CHART_RENDERER_ADAPTER_V1: ChartRendererAdapterV1 = Object.freeze({
  id: "tanstack-v0.3",
  capability: "bounded-interactive-bar",
  runtime: "client-only",
  validate: validateInteractiveChartV1,
});

export function resolveChartRendererAdapterV1(id: ChartRendererAdapterIdV1 = "tanstack-v0.3"): ChartRendererAdapterV1 {
  switch (id) {
    case "tanstack-v0.3": return TANSTACK_CHART_RENDERER_ADAPTER_V1;
    default: return assertNeverChartRendererAdapterV1(id);
  }
}

function assertNeverChartRendererAdapterV1(value: never): never {
  throw new StaticChartValidationErrorV1(`unsupported chart renderer adapter: ${String(value)}`);
}

function assertNeverChartExportBlockRendererAdapterV1(value: never): never {
  throw new StaticChartValidationErrorV1(`unsupported chart ExportBlock renderer adapter: ${String(value)}`);
}

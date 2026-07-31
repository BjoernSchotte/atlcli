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

export class StaticChartValidationErrorV1 extends Error {}

const MAX_ROWS = 200;
const MAX_SERIES = 24;

export function normalizeStaticChartV1(model: StaticChartModelV1): NormalizedStaticChartV1 {
  if (!model.title.trim()) throw new StaticChartValidationErrorV1("chart title must be non-empty");
  if (model.labels.length === 0 || model.labels.length > MAX_ROWS) throw new StaticChartValidationErrorV1("chart labels exceed limits");
  if (model.series.length === 0 || model.series.length > MAX_SERIES) throw new StaticChartValidationErrorV1("chart series exceed limits");
  let maximum = 0;
  for (const series of model.series) {
    if (!series.name.trim() || series.values.length !== model.labels.length) throw new StaticChartValidationErrorV1("chart series shape is invalid");
    for (const value of series.values) {
      if (!Number.isFinite(value) || value < 0) throw new StaticChartValidationErrorV1("chart values must be finite non-negative numbers");
      maximum = Math.max(maximum, value);
    }
  }
  return Object.freeze({ ...model, maximum: maximum || 1 });
}

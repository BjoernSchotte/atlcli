export interface T0ChartSeriesV1 {
  key: string;
  label: string;
  values: readonly number[];
}

export interface T0ChartModelV1 {
  schema: "atlcli.chart-model/1-t0";
  title: string;
  description: string;
  categories: readonly string[];
  series: readonly T0ChartSeriesV1[];
  unit?: string;
}

export interface T0RenderContextV1 {
  locale: string;
  direction?: "ltr" | "rtl";
  resolvedAssets?: Readonly<Record<string, string>>;
}

export interface T0RendererOverridesV1 {
  paragraph?: unknown;
  codeBlock?: unknown;
}

export interface T0ExportDocumentProps {
  blocks: readonly Record<string, unknown>[];
  context: T0RenderContextV1;
  overrides?: T0RendererOverridesV1;
  chart?: T0ChartModelV1;
  interactiveChart?: boolean;
}

export declare function assertT0ChartModel(value: unknown): asserts value is T0ChartModelV1;
export declare function safePublicHref(value: unknown): string | undefined;
export declare function safeHtmlId(value: unknown): string | undefined;

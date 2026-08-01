import { describe, expect, test } from "bun:test";
import {
  CHART_KINDS_V1,
  chartModelDigestV1,
  validateChartModelV1,
  type ChartKindV1,
  type ChartModelV1,
} from "./charts.js";

const source = { kind: "cloud-adf" as const, macroName: "chart" as const };

function model(kind: ChartKindV1): ChartModelV1 {
  if (kind === "gantt") {
    return {
      schema: "atlcli.chart/1", kind, title: "Delivery", source,
      data: { mode: "gantt", tasks: [{ id: "t1", label: "Build", start: "2026-01-01", end: "2026-01-02", progress: 0.5 }] },
    };
  }
  if (["xyArea", "xyBar", "xyLine", "xyStep", "xyStepArea", "scatter", "timeSeries"].includes(kind)) {
    return {
      schema: "atlcli.chart/1", kind, title: "Points", source,
      data: { mode: "points", series: [{ id: "s1", label: "Value", points: [{ x: kind === "timeSeries" ? "2026-01-01T00:00:00.000Z" : 1, y: 3 }] }] },
    };
  }
  return {
    schema: "atlcli.chart/1", kind, title: "Categories", source,
    data: { mode: "categories", labels: ["A", "B"], series: [{ id: "s1", label: "Value", values: [1, 2] }] },
  };
}

describe("ChartModelV1", () => {
  test("validates every documented Confluence chart kind", () => {
    for (const kind of CHART_KINDS_V1) {
      expect(validateChartModelV1(model(kind)).kind).toBe(kind);
    }
  });

  test("rejects misaligned series and unsafe colors", () => {
    expect(() => validateChartModelV1({
      ...model("bar"),
      style: { colors: ["red"] },
    })).toThrow("canonical hex");
    expect(() => validateChartModelV1({
      ...model("bar"),
      data: { mode: "categories", labels: ["A"], series: [{ id: "s", label: "S", values: [1, 2] }] },
    })).toThrow("align");
  });

  test("produces a stable digest for the validated model", () => {
    const value = model("line");
    expect(chartModelDigestV1(value)).toBe(chartModelDigestV1(structuredClone(value)));
    expect(chartModelDigestV1(value)).toMatch(/^fnv1a-[0-9a-f]{8}$/u);
  });
});

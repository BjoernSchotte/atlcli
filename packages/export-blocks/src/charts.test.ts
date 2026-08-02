import { describe, expect, test } from "bun:test";
import {
  CHART_KINDS_V1,
  chartModelDigestV1,
  validateChartDiagnosticsV1,
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
    expect(() => validateChartModelV1({
      ...model("bar"),
      data: { mode: "categories", labels: ["A"], series: [
        { id: "same", label: "S1", values: [1] },
        { id: "same", label: "S2", values: [2] },
      ] },
    })).toThrow("unique");
    expect(() => validateChartModelV1({
      ...model("bar"),
      data: { mode: "categories", labels: [""], series: [{ id: "s", label: "S", values: [1] }] },
    })).toThrow("non-empty");
    expect(() => validateChartModelV1({ ...model("bar"), style: { colors: Array.from({ length: 65 }, () => "#ffffff") } })).toThrow("palette");
  });

  test("retains finite signed category values for mixed-sign static charts", () => {
    const validated = validateChartModelV1({
      ...model("bar"),
      data: {
        mode: "categories",
        labels: ["Ahead", "Behind"],
        series: [{ id: "variance", label: "Variance", values: [12, -7] }],
      },
    });
    expect(validated.data).toEqual({
      mode: "categories",
      labels: ["Ahead", "Behind"],
      series: [{ id: "variance", label: "Variance", values: [12, -7] }],
    });
  });

  test("validates bounded source diagnostics for lenient chart imports", () => {
    expect(validateChartDiagnosticsV1([{ code: "skipped-row", message: "Row 3 was ignored", row: 3 }])).toEqual([
      { code: "skipped-row", message: "Row 3 was ignored", row: 3 },
    ]);
    expect(validateChartDiagnosticsV1([{ code: "locale-parse", message: "Timestamp used the deterministic UTC fallback." }, { code: "renderer-fallback", message: "Static table fallback used." }])).toHaveLength(2);
    expect(() => validateChartDiagnosticsV1([{ code: "not-a-code" as never, message: "bad" }])).toThrow("code");
    expect(() => validateChartDiagnosticsV1([{ code: "skipped-row", message: "", row: 1 }])).toThrow("non-empty");
  });

  test("validates closed axis and presentation enums", () => {
    expect(validateChartModelV1({
      ...model("line"),
      legend: "right",
      axes: { x: { min: 0, max: 10, tickUnit: 5, categoryLabelPosition: "up45", dateTickPosition: "middle" } },
      display: { data: "after" },
    }).axes?.x?.tickUnit).toBe(5);
    expect(() => validateChartModelV1({ ...model("line"), axes: { x: { min: 10, max: 1 } } })).toThrow("max");
    expect(() => validateChartModelV1({ ...model("line"), axes: { x: { tickUnit: 0 } } })).toThrow("positive");
    expect(() => validateChartModelV1({ ...model("line"), legend: "outside" as never })).toThrow("legend");
  });

  test("validates date-axis units, date-valued XY data, pie formats, and source-table digests", () => {
    const validated = validateChartModelV1({
      ...model("xyLine"),
      axes: { x: { valueType: "date", tickUnit: 2, tickPeriod: "week", dateTickPosition: "middle" } },
      pie: { sectionLabelFormat: "%0% = %1% (%2%)" },
      data: { mode: "points", series: [{ id: "s1", label: "Value", points: [{ x: "2026-01-01T00:00:00.000Z", y: 3 }] }] },
      source: { ...source, sourceTableDigests: ["fnv1a-1234abcd"] },
    });
    expect(validated.axes?.x?.tickPeriod).toBe("week");
    expect(validated.source.sourceTableDigests).toEqual(["fnv1a-1234abcd"]);
    expect(() => validateChartModelV1({ ...model("xyLine"), axes: { x: { tickPeriod: "fortnight" as never } } })).toThrow("tickPeriod");
    expect(() => validateChartModelV1({ ...model("pie"), pie: { sectionLabelFormat: "%3%" } })).toThrow("replacement variable");
    expect(() => validateChartModelV1({ ...model("pie"), source: { ...source, sourceTableDigests: ["raw-id"] } })).toThrow("source-table digest");
  });

  test("produces a stable digest for the validated model", () => {
    const value = model("line");
    expect(chartModelDigestV1(value)).toBe(chartModelDigestV1(structuredClone(value)));
    expect(chartModelDigestV1(value)).toMatch(/^fnv1a-[0-9a-f]{8}$/u);
  });
});

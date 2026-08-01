import { expect, test } from "bun:test";
import {
  StaticChartValidationErrorV1,
  normalizeStaticChartV1,
  resolveChartExportBlockRendererAdapterV1,
  resolveChartRendererAdapterV1,
  validateInteractiveChartExportBlockV1,
  validateInteractiveChartV1,
} from "./charts.js";
import type { ExportBlock } from "@atlcli/export-blocks";

const barBlock: Extract<ExportBlock, { type: "chart" }> = {
  type: "chart",
  chart: {
    schema: "atlcli.chart/1",
    kind: "bar",
    title: "Pages",
    data: { mode: "categories", labels: ["Jan", "Feb"], series: [{ id: "pages", label: "Pages", values: [4, 7] }] },
    source: { kind: "cloud-adf", macroName: "chart" },
  },
};

test("normalizes bounded static chart data without executable values", () => {
  expect(normalizeStaticChartV1({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toMatchObject({ maximum: 4 });
  expect(() => normalizeStaticChartV1({ title: "", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toThrow(StaticChartValidationErrorV1);
  expect(() => normalizeStaticChartV1({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [-1] }] })).toThrow("non-negative");
});

test("interactive charts impose stricter bounded frozen-data limits", () => {
  expect(validateInteractiveChartV1({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toMatchObject({ maximum: 4 });
  expect(() => validateInteractiveChartV1({ title: "Pages", labels: Array.from({ length: 81 }, (_, index) => String(index)), series: [{ name: "Count", values: Array.from({ length: 81 }, () => 1) }] })).toThrow("row, series, or point limits");
  expect(() => validateInteractiveChartV1({ title: "Pages", labels: ["x".repeat(70_000)], series: [{ name: "Count", values: [1] }] })).toThrow("payload byte limit");
});

test("the renderer adapter is closed and delegates to the bounded interactive schema", () => {
  const adapter = resolveChartRendererAdapterV1();
  expect(adapter).toMatchObject({ id: "tanstack-v0.3", capability: "bounded-interactive-bar", runtime: "client-only" });
  expect(adapter.validate({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toMatchObject({ maximum: 4 });
  expect(() => resolveChartRendererAdapterV1("untrusted" as never)).toThrow("unsupported chart renderer adapter");
});

test("the new TanStack adapter validates a chart ExportBlock and emits only bounded rows", () => {
  const adapter = resolveChartExportBlockRendererAdapterV1();
  expect(adapter).toMatchObject({ id: "tanstack-v0.3/bar", capability: "bounded-interactive-bar", handles: ["bar"] });
  expect(adapter.validate(barBlock)).toMatchObject({ maximum: 7, rows: [
    { label: "Jan", series: "Pages", value: 4 },
    { label: "Feb", series: "Pages", value: 7 },
  ] });
  expect(() => validateInteractiveChartExportBlockV1({ ...barBlock, chart: { ...barBlock.chart, kind: "line" } })).toThrow("categorical bar");
});

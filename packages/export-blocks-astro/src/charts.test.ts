import { expect, test } from "bun:test";
import { StaticChartValidationErrorV1, normalizeStaticChartV1, validateInteractiveChartV1 } from "./charts.js";

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

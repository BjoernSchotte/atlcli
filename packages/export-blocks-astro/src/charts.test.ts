import { expect, test } from "bun:test";
import { StaticChartValidationErrorV1, normalizeStaticChartV1 } from "./charts.js";

test("normalizes bounded static chart data without executable values", () => {
  expect(normalizeStaticChartV1({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toMatchObject({ maximum: 4 });
  expect(() => normalizeStaticChartV1({ title: "", labels: ["Jan"], series: [{ name: "Count", values: [4] }] })).toThrow(StaticChartValidationErrorV1);
  expect(() => normalizeStaticChartV1({ title: "Pages", labels: ["Jan"], series: [{ name: "Count", values: [-1] }] })).toThrow("non-negative");
});

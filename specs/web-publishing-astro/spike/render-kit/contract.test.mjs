import { describe, expect, test } from "bun:test";
import { assertT0ChartModel, safeHtmlId, safePublicHref } from "./contract.mjs";

const chart = {
  schema: "atlcli.chart-model/1-t0",
  title: "Adoption",
  description: "Quarterly adoption",
  categories: ["Q1", "Q2"],
  series: [{ key: "teams", label: "Teams", values: [1, 2] }],
};

describe("T0 render contract", () => {
  test("accepts a bounded chart model", () => {
    expect(() => assertT0ChartModel(chart)).not.toThrow();
  });

  test("rejects invalid or unbounded chart data", () => {
    expect(() => assertT0ChartModel({ ...chart, categories: [] })).toThrow("1..24");
    expect(() => assertT0ChartModel({
      ...chart,
      series: [{ key: "teams", label: "Teams", values: [Number.POSITIVE_INFINITY, 2] }],
    })).toThrow("finite and bounded");
  });

  test("allows only public link schemes and safe local references", () => {
    expect(safePublicHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safePublicHref("/docs/guide/")).toBe("/docs/guide/");
    expect(safePublicHref("#intro")).toBe("#intro");
    expect(safePublicHref("javascript:alert(1)")).toBeUndefined();
    expect(safePublicHref("//evil.example/path")).toBeUndefined();
  });

  test("normalizes hostile heading text into a bounded inert id", () => {
    expect(safeHtmlId("</script><script>window.bad=true</script>")).toBe("script-script-window-bad-true-script");
  });
});

import { expect, test } from "bun:test";
import {
  CHART_KINDS_V1,
  chartModelDigestV1,
  parseExportBlocksV1,
  validateChartModelV1,
} from "@atlcli/confluence/browser";
import {
  TANSTACK_CHART_ADAPTER_V1,
  createTanStackChartSceneV1,
  renderTanStackChartSvgV1,
} from "@atlcli/export-charts-tanstack";
import {
  CHART_WORLD_CLASS_BLOCKS_V1,
  CHART_WORLD_CLASS_DIGESTS_V1,
  CHART_WORLD_CLASS_KINDS_V1,
  chartWorldClassBlocksV1,
} from "./chart-world-class-corpus.js";

test("the tenant-free corpus covers every chart kind with validated deterministic models", () => {
  expect(CHART_WORLD_CLASS_KINDS_V1).toEqual(CHART_KINDS_V1);
  expect(new Set(CHART_WORLD_CLASS_KINDS_V1).size).toBe(CHART_KINDS_V1.length);
  expect(parseExportBlocksV1(CHART_WORLD_CLASS_BLOCKS_V1)).toHaveLength(CHART_KINDS_V1.length);
  for (const block of CHART_WORLD_CLASS_BLOCKS_V1) {
    expect(validateChartModelV1(block.chart)).toEqual(block.chart);
    expect(CHART_WORLD_CLASS_DIGESTS_V1[block.chart.kind]).toBe(chartModelDigestV1(block.chart));
    expect(JSON.stringify(block)).not.toMatch(/atlassian\.net|bearer|token|accountId|tenant/iu);
  }
});

test("the corpus exercises world-class semantics instead of one-point dispatch stubs", () => {
  const byKind = Object.fromEntries(CHART_WORLD_CLASS_BLOCKS_V1.map((block) => [block.chart.kind, block.chart]));
  expect(byKind.bar?.orientation).toBe("horizontal");
  expect(byKind.bar?.stacked).toBe(true);
  expect(byKind.bar?.data.mode === "categories" && byKind.bar.data.series.some((series) => series.values.some((value) => value < 0))).toBe(true);
  expect(byKind.xyStep?.data.mode === "points" && byKind.xyStep.data.series[0]!.points).toHaveLength(4);
  expect(byKind.xyStepArea?.data.mode === "points" && byKind.xyStepArea.data.series[0]!.points).toHaveLength(4);
  expect(byKind.pie?.pie).toEqual({ sectionLabelFormat: "%0%: %1%", explode: ["Experience"] });
  expect(byKind.timeSeries?.locale).toEqual({ language: "de", country: "DE", dateFormat: "dd.MM.yyyy", timePeriod: "day" });
  expect(byKind.gantt?.data.mode === "gantt" && byKind.gantt.data.tasks[2]?.dependencies).toEqual(["themes"]);
});

test("callers receive a mutable clone without being able to drift the canonical corpus", () => {
  const first = chartWorldClassBlocksV1();
  first[0]!.chart.title = "Changed by a consumer";
  expect(CHART_WORLD_CLASS_BLOCKS_V1[0]!.chart.title).toBe("Portfolio allocation");
  expect(chartWorldClassBlocksV1()[0]!.chart.title).toBe("Portfolio allocation");
});

test("all twelve world-class corpus models compile through the pinned TanStack scene and SVG renderer", () => {
  expect(TANSTACK_CHART_ADAPTER_V1.version).toBe("0.3.1");
  for (const block of CHART_WORLD_CLASS_BLOCKS_V1) {
    const scene = createTanStackChartSceneV1(block.chart);
    expect(scene.nodes.length, block.chart.kind).toBeGreaterThan(0);
    expect(scene.points.length, block.chart.kind).toBeGreaterThan(0);
    const svg = renderTanStackChartSvgV1(block.chart, { idPrefix: `corpus-${block.chart.kind}` });
    expect(svg, block.chart.kind).toContain('class="ts-chart"');
    expect(svg, block.chart.kind).toContain('role="img"');
    expect(svg, block.chart.kind).not.toContain("<script");
  }
});

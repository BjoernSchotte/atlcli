import { describe, expect, test } from "bun:test";
import {
  EXPORT_BLOCK_MODEL_SCHEMA_V1,
  ExportBlockValidationErrorV1,
  parseExportBlockDocumentV1,
  parseExportBlocksV1,
  visitExportBlocksV1,
  type ExportBlock,
} from "./index.js";

const nestedBlocks: readonly ExportBlock[] = [{
  type: "table",
  rows: [{
    cells: [{
      header: false,
      colspan: 1,
      rowspan: 1,
      content: [{
        type: "callout",
        kind: "info",
        content: [{
          type: "paragraph",
          content: [{
            type: "link",
            target: { kind: "external", href: "https://example.invalid" },
            content: [{ type: "text", text: "Example" }],
          }],
        }],
      }],
    }],
  }],
}];

describe("ExportBlock runtime schema v1", () => {
  test("accepts and returns the exact validated document", () => {
    const document = {
      schema: EXPORT_BLOCK_MODEL_SCHEMA_V1,
      blocks: nestedBlocks,
      notes: [{ level: "info", code: "other", message: "fixture" }],
    } as const;
    expect(parseExportBlockDocumentV1(document)).toBe(document);
    expect(parseExportBlocksV1(nestedBlocks)).toBe(nestedBlocks);
    expect(() => parseExportBlocksV1([{
      type: "heading",
      level: 1,
      content: [{ type: "text", text: "Heading" }],
    }])).not.toThrow();
  });

  test("accepts a real chart ExportBlock and validates its model", () => {
    const chart = {
      type: "chart",
      chart: {
        schema: "atlcli.chart/1",
        kind: "xyBar",
        title: "Published pages",
        data: {
          mode: "points",
          series: [{
            id: "series-1",
            label: "Pages",
            points: [{ x: 1, y: 12 }, { x: 2, y: 25 }],
          }],
        },
        source: { kind: "cloud-adf", macroName: "chart" },
        diagnostics: [{ code: "skipped-row", message: "One row was ignored", row: 3 }],
      },
    } as const;
    expect(parseExportBlocksV1([chart])).toEqual([chart]);
    expect(() => parseExportBlocksV1([{
      ...chart,
      chart: { ...chart.chart, kind: "not-a-chart" },
    }])).toThrow("invalid ChartModel");
    expect(parseExportBlocksV1([{
      ...chart,
      caption: { kind: "figure", content: [{ type: "text", text: "Published pages" }] },
      localId: "chart-pages",
    }])).toHaveLength(1);
  });

  test("rejects unknown variants, fields, non-finite values, and cycles", () => {
    expect(() => parseExportBlocksV1([{ type: "rawHtml", html: "<script>" }]))
      .toThrow(ExportBlockValidationErrorV1);
    expect(() => parseExportBlocksV1([{ type: "divider", secret: "no" }]))
      .toThrow("unknown field");
    expect(() => parseExportBlocksV1([{ type: "image", source: { kind: "external", url: "x" }, width: Number.NaN }]))
      .toThrow("finite number");
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => parseExportBlocksV1(cyclic)).toThrow("cyclic value");
  });

  test("accepts only unique positive normalized code highlight lines", () => {
    expect(() => parseExportBlocksV1([{
      type: "codeBlock", code: "const value = 1;", highlightLines: [1, 3],
    }])).not.toThrow();
    expect(() => parseExportBlocksV1([{
      type: "codeBlock", code: "const value = 1;", highlightLines: [1, 1],
    }])).toThrow("unique line numbers");
    expect(() => parseExportBlocksV1([{
      type: "codeBlock", code: "const value = 1;", highlightLines: [0],
    }])).toThrow("positive safe integer");
  });

  test("enforces deterministic resource budgets before typed traversal", () => {
    expect(() => parseExportBlocksV1(nestedBlocks, {
      maxDepth: 2,
      maxNodes: 1_000,
      maxStringBytes: 1_000,
    })).toThrow("depth budget exceeded");
    expect(() => parseExportBlocksV1(nestedBlocks, {
      maxDepth: 128,
      maxNodes: 2,
      maxStringBytes: 1_000,
    })).toThrow("node budget exceeded");
  });
});

test("visitExportBlocksV1 walks nested blocks and inline links with stable paths", () => {
  const blocks: string[] = [];
  const inline: string[] = [];
  visitExportBlocksV1(nestedBlocks, {
    block(block, context) { blocks.push(`${block.type}:${context.path}`); },
    inline(node, context) { inline.push(`${node.type}:${context.path}`); },
  });
  expect(blocks).toEqual([
    "table:$blocks[0]",
    "callout:$blocks[0].rows[0].cells[0].content[0]",
    "paragraph:$blocks[0].rows[0].cells[0].content[0].content[0]",
  ]);
  expect(inline).toEqual([
    "link:$blocks[0].rows[0].cells[0].content[0].content[0].content[0]",
    "text:$blocks[0].rows[0].cells[0].content[0].content[0].content[0].content[0]",
  ]);
});

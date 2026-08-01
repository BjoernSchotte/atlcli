import { describe, expect, test } from "bun:test";
import { adfToBlocks } from "./adf-to-blocks.js";
import { storageToBlocks } from "./export-blocks.js";

const storageChart = (type: string, extra = "") =>
  `<ac:structured-macro ac:name="chart"><ac:parameter ac:name="type">${type}</ac:parameter>${extra}<ac:rich-text-body><table><tbody><tr><th>Month</th><th>Revenue</th></tr><tr><td>Jan</td><td>10</td></tr><tr><td>Feb</td><td>20</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>`;

describe("Confluence Chart macro normalization", () => {
  test("storage emits a source-ordered chart ExportBlock instead of a sidecar/unknown block", () => {
    const result = storageToBlocks(`<p>Before</p>${storageChart("bar")}<p>After</p>`);
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph", "chart", "paragraph"]);
    expect(result.blocks[1]).toMatchObject({
      type: "chart",
      chart: {
        schema: "atlcli.chart/1",
        kind: "bar",
        data: { mode: "categories", labels: ["Jan", "Feb"], series: [{ label: "Revenue", values: [10, 20] }] },
        source: { kind: "dc-storage", macroName: "chart" },
      },
    });
  });

  test("ADF bodied extension uses the same normalized chart model", () => {
    const result = adfToBlocks(JSON.stringify({ version: 1, type: "doc", content: [{
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "chart",
        parameters: { type: "line" },
      },
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Month" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Revenue" }] }] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Jan" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "10" }] }] },
          ] },
        ],
      }],
    }] }));
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: { kind: "line", data: { mode: "categories", labels: ["Jan"], series: [{ values: [10] }] }, source: { kind: "cloud-adf" } },
    });
  });

  test("normalizes presentation and axis parameters into the closed model", () => {
    const result = storageToBlocks(storageChart("line", [
      '<ac:parameter ac:name="subtitle">Adoption trend</ac:parameter>',
      '<ac:parameter ac:name="domainAxisLower">0</ac:parameter>',
      '<ac:parameter ac:name="domainAxisUpper">12</ac:parameter>',
      '<ac:parameter ac:name="rangeAxisTickUnit">5</ac:parameter>',
      '<ac:parameter ac:name="categoryLabelPosition">far</ac:parameter>',
    ].join("")));
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        subtitle: "Adoption trend",
        axes: { x: { min: 0, max: 12, categoryLabelPosition: "far" }, y: { tickUnit: 5 } },
      },
    });
  });
});

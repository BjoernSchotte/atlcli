import { expect, test } from "bun:test";
import { normalizeChartMacro } from "@atlcli/confluence";
import { chartMacroRenderer } from "./chart.js";

test("chart macro renderer converts a normalized table body into a chart ExportBlock", async () => {
  const result = await chartMacroRenderer({ normalizeChartMacro }).render({
    name: "chart",
    params: [
      { name: "type", text: "bar" },
      { name: "title", text: "Revenue" },
    ],
    body: [{
      type: "table",
      rows: [
        { cells: [
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Month" }] }] },
          { header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
        ] },
        { cells: [
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Jan" }] }] },
          { header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "10" }] }] },
        ] },
      ],
    }],
  }, {
    page: { id: "page-1" },
    depth: 0,
    visited: new Set(),
  });
  expect(result.kind).toBe("blocks");
  if (result.kind === "blocks") expect(result.blocks[0]).toMatchObject({ type: "chart", chart: { title: "Revenue", kind: "bar" } });
});

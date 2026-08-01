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
      '<ac:parameter ac:name="categoryLabelPosition">up45</ac:parameter>',
      '<ac:parameter ac:name="dateTickMarkPosition">middle</ac:parameter>',
    ].join("")));
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        subtitle: "Adoption trend",
        axes: { x: { min: 0, max: 12, categoryLabelPosition: "up45", dateTickPosition: "middle" }, y: { tickUnit: 5 } },
      },
    });
  });

  test("normalizes documented display, pie, and generated-attachment semantics", () => {
    const result = storageToBlocks(storageChart("pie", [
      '<ac:parameter ac:name="opacity">65</ac:parameter>',
      '<ac:parameter ac:name="dataDisplay">true</ac:parameter>',
      '<ac:parameter ac:name="legend">false</ac:parameter>',
      '<ac:parameter ac:name="pieSectionExplode">Jan</ac:parameter>',
      '<ac:parameter ac:name="attachment">^chart.png</ac:parameter>',
      '<ac:parameter ac:name="attachmentVersion">replace</ac:parameter>',
      '<ac:parameter ac:name="attachmentComment">Publishing proof</ac:parameter>',
      '<ac:parameter ac:name="thumbnail">true</ac:parameter>',
      '<ac:parameter ac:name="imageFormat">png</ac:parameter>',
    ].join("")));
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        opacity: 0.65,
        display: { data: "after" },
        legend: "none",
        pie: { explode: ["Jan"] },
        source: {
          attachment: { filename: "^chart.png", version: "replace", comment: "Publishing proof", thumbnail: true },
          renderedImageFormat: "png",
        },
      },
    });
  });

  test("does not treat a generated chart attachment as an external data source", () => {
    const result = storageToBlocks('<ac:structured-macro ac:name="chart"><ac:parameter ac:name="attachment">^chart.png</ac:parameter></ac:structured-macro>');
    expect(result.blocks[0]).toMatchObject({ type: "unknown", macroName: "chart" });
    expect(result.notes.some((note) => note.message.includes("not a data source"))).toBeTrue();
    expect(result.notes.some((note) => note.message.includes("was not acquired"))).toBeFalse();
  });

  test("normalizes every documented chart kind for the Data Center Storage adapter", () => {
    const pointKinds = new Set(["xyArea", "xyBar", "xyLine", "xyStep", "xyStepArea", "scatter", "timeSeries"]);
    const gantt = `<ac:rich-text-body><table><tbody><tr><th>Task</th><th>Start</th><th>End</th><th>Progress</th></tr><tr><td>Build</td><td>2026-01-01</td><td>2026-01-03</td><td>50%</td></tr></tbody></table></ac:rich-text-body>`;
    for (const kind of ["pie", "bar", "line", "area", ...pointKinds, "gantt"]) {
      const body = kind === "gantt"
        ? gantt
        : pointKinds.has(kind)
          ? `<ac:rich-text-body><table><tbody><tr><th>X</th><th>Value</th></tr><tr><td>1</td><td>10</td></tr><tr><td>2</td><td>20</td></tr></tbody></table></ac:rich-text-body>`
          : `<ac:rich-text-body><table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr></tbody></table></ac:rich-text-body>`;
      const result = storageToBlocks(`<ac:structured-macro ac:name="chart"><ac:parameter ac:name="type">${kind}</ac:parameter>${body}</ac:structured-macro>`);
      expect(result.blocks[0]).toMatchObject({ type: "chart", chart: { kind } });
    }
  });

  test("normalizes every documented chart kind for the Cloud ADF adapter", () => {
    const pointKinds = new Set(["xyArea", "xyBar", "xyLine", "xyStep", "xyStepArea", "scatter", "timeSeries"]);
    for (const kind of ["pie", "bar", "line", "area", ...pointKinds, "gantt"]) {
      const headers = kind === "gantt" ? ["Task", "Start", "End"] : pointKinds.has(kind) ? ["X", "Value"] : ["Label", "Value"];
      const values = kind === "gantt" ? ["Build", "2026-01-01", "2026-01-03"] : pointKinds.has(kind) ? ["1", "10"] : ["A", "10"];
      const content = [headers, values].map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((text) => ({
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      }));
      const result = adfToBlocks(JSON.stringify({ version: 1, type: "doc", content: [{
        type: "bodiedExtension",
        attrs: { extensionType: "com.atlassian.confluence.macro.core", extensionKey: "chart", parameters: { type: kind } },
        content: [{ type: "table", content }],
      }] }));
      expect(result.blocks[0]).toMatchObject({ type: "chart", chart: { kind } });
    }
  });

  test("keeps unsupported and partial source diagnostics visible on the chart block", () => {
    const unsupported = storageToBlocks(`<ac:structured-macro ac:name="chart"><ac:parameter ac:name="type">radar</ac:parameter></ac:structured-macro>`);
    expect(unsupported.blocks[0]).toMatchObject({ type: "unknown", macroName: "chart" });
    expect(unsupported.notes.some((note) => note.message.includes("Unsupported Confluence Chart macro type"))).toBeTrue();

    const partial = storageToBlocks(storageChart("bar", `<ac:rich-text-body><table><tbody><tr><th>Month</th><th>Revenue</th></tr><tr><td>Jan</td><td>not-a-number</td></tr></tbody></table></ac:rich-text-body>`));
    expect(partial.blocks[0]).toMatchObject({ type: "chart", diagnostics: [{ code: "skipped-row" }] });
  });

  test("makes leniency and approximated presentation choices explicit", () => {
    const result = storageToBlocks(storageChart("bar", [
      '<ac:parameter ac:name="3d">true</ac:parameter>',
      '<ac:parameter ac:name="forgive">true</ac:parameter>',
      '<ac:parameter ac:name="orientation">horizontal</ac:parameter>',
    ].join("")));
    expect(result.blocks[0]).toMatchObject({ type: "chart", chart: { orientation: "horizontal", threeD: true }, diagnostics: [{ code: "invalid-option" }] });

    const strict = storageToBlocks(storageChart("bar", [
      '<ac:parameter ac:name="forgive">false</ac:parameter>',
      '<ac:rich-text-body><table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>bad</td></tr></tbody></table></ac:rich-text-body>',
    ].join("")));
    expect(strict.blocks[0]).toMatchObject({ type: "unknown", macroName: "chart" });
    expect(strict.notes.some((note) => note.message.includes("strict"))).toBeTrue();
  });
});

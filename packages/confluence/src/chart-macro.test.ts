import { describe, expect, test } from "bun:test";
import { adfToBlocks } from "./adf-to-blocks.js";
import { storageToBlocks } from "./export-blocks.js";

const storageChart = (type: string, extra = "") =>
  `<ac:structured-macro ac:name="chart"><ac:parameter ac:name="type">${type}</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>${extra}<ac:rich-text-body><table><tbody><tr><th>Month</th><th>Revenue</th></tr><tr><td>Jan</td><td>10</td></tr><tr><td>Feb</td><td>20</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>`;

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
        parameters: { type: "line", dataOrientation: "vertical" },
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
          ? `<ac:rich-text-body><table><tbody><tr><th>X</th><th>Value</th></tr><tr><td>${kind === "timeSeries" ? "2026-01-01" : "1"}</td><td>10</td></tr><tr><td>${kind === "timeSeries" ? "2026-01-02" : "2"}</td><td>20</td></tr></tbody></table></ac:rich-text-body>`
          : `<ac:rich-text-body><table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr></tbody></table></ac:rich-text-body>`;
      const result = storageToBlocks(`<ac:structured-macro ac:name="chart"><ac:parameter ac:name="type">${kind}</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>${body}</ac:structured-macro>`);
      expect(result.blocks[0]).toMatchObject({ type: "chart", chart: { kind } });
    }
  });

  test("normalizes every documented chart kind for the Cloud ADF adapter", () => {
    const pointKinds = new Set(["xyArea", "xyBar", "xyLine", "xyStep", "xyStepArea", "scatter", "timeSeries"]);
    for (const kind of ["pie", "bar", "line", "area", ...pointKinds, "gantt"]) {
      const headers = kind === "gantt" ? ["Task", "Start", "End"] : pointKinds.has(kind) ? ["X", "Value"] : ["Label", "Value"];
      const values = kind === "gantt" ? ["Build", "2026-01-01", "2026-01-03"] : pointKinds.has(kind) ? [kind === "timeSeries" ? "2026-01-01" : "1", "10"] : ["A", "10"];
      const content = [headers, values].map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((text) => ({
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        })),
      }));
      const result = adfToBlocks(JSON.stringify({ version: 1, type: "doc", content: [{
        type: "bodiedExtension",
        attrs: { extensionType: "com.atlassian.confluence.macro.core", extensionKey: "chart", parameters: { type: kind, dataOrientation: "vertical" } },
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

  test("reports every unsupported or ambiguous P0 parameter family deterministically", () => {
    const parameters = [
      ["forgive", "sometimes"], ["timeSeries", "sometimes"],
      ["width", "wide"], ["height", "tall"],
      ["stacked", "sometimes"], ["3d", "sometimes"], ["showShapes", "sometimes"],
      ["thumbnail", "sometimes"], ["legend", "side"], ["legend", "top"],
      ["orientation", "diagonal"], ["dataDisplay", "sometimes"],
      ["timePeriod", "fortnight"], ["attachmentVersion", "overwrite"],
      ["imageFormat", "gif"], ["opacity", "200"],
      ["domainAxisLowerBound", "low"], ["domainAxisTickUnit", "zero"],
      ["domainAxisLabelAngle", "slanted"], ["categoryLabelPosition", "sideways"],
      ["dateTickPosition", "center"], ["bgColor", "url(evil)"],
      ["borderColor", "not-a-color"], ["colors", "red,not-a-color"],
      ["pieSectionExplode", "Missing"], ["mysteryMode", "private-value-not-echoed"],
    ].map(([name, value]) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`).join("");
    const first = storageToBlocks(storageChart("pie", parameters));
    const second = storageToBlocks(storageChart("pie", parameters));
    expect(first).toEqual(second);
    const block = first.blocks[0];
    expect(block?.type).toBe("chart");
    if (block?.type !== "chart") throw new Error("expected lenient chart projection");
    const diagnosed = new Set((block.diagnostics ?? []).map((diagnostic) => diagnostic.parameter?.toLowerCase()));
    for (const parameter of [
      "forgive", "timeseries", "width", "height", "stacked", "3d", "showshapes",
      "thumbnail", "legend", "orientation", "datadisplay", "timeperiod",
      "attachmentversion", "imageformat", "opacity", "domainaxislowerbound",
      "domainaxistickunit", "domainaxislabelangle", "categorylabelposition",
      "datetickposition", "bgcolor", "bordercolor", "colors",
      "piesectionexplode", "mysterymode",
    ]) expect(diagnosed.has(parameter), parameter).toBe(true);
    expect(block.diagnostics?.some((diagnostic) => diagnostic.message.includes("duplicated; the first value is used"))).toBe(true);
    expect(block.diagnostics?.some((diagnostic) => diagnostic.message.includes("Unsupported Chart macro parameter mysterymode was ignored"))).toBe(true);
    expect(JSON.stringify(block.diagnostics)).not.toContain("private-value-not-echoed");
  });

  test("uses the documented pie and horizontal-content defaults with grouped numbers", () => {
    const result = storageToBlocks(`<ac:structured-macro ac:name="chart"><ac:rich-text-body><table><tbody>
      <tr><th>Metric</th><th>2025</th><th>2026</th></tr>
      <tr><td>Revenue</td><td>9,500</td><td>10,200</td></tr>
    </tbody></table></ac:rich-text-body></ac:structured-macro>`);
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        kind: "pie",
        data: { mode: "categories", labels: ["2025", "2026"], series: [{ label: "Revenue", values: [9500, 10200] }] },
        display: { width: 300, height: 300, data: "hidden" },
        orientation: "vertical",
      },
    });
  });

  test("parses locale-specific decimals deterministically and strict mode rejects a mismatched format", () => {
    const german = storageToBlocks(`<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">bar</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>
      <ac:parameter ac:name="language">de</ac:parameter><ac:parameter ac:name="country">DE</ac:parameter>
      <ac:rich-text-body><table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>1.234,56</td></tr></tbody></table></ac:rich-text-body>
    </ac:structured-macro>`);
    expect(german.blocks[0]).toMatchObject({ type: "chart", chart: { data: { series: [{ values: [1234.56] }] } } });

    const strict = storageToBlocks(`<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">bar</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>
      <ac:parameter ac:name="language">de</ac:parameter><ac:parameter ac:name="country">DE</ac:parameter><ac:parameter ac:name="forgive">false</ac:parameter>
      <ac:rich-text-body><table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>A</td><td>1,234.56</td></tr></tbody></table></ac:rich-text-body>
    </ac:structured-macro>`);
    expect(strict.blocks[0]).toMatchObject({ type: "unknown", macroName: "chart" });
    expect(strict.notes.some((note) => note.message.includes("strict"))).toBeTrue();
  });

  test("selects tables by authored id and columns by header title without publishing source ids", () => {
    const result = storageToBlocks(`<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">bar</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>
      <ac:parameter ac:name="tables">second</ac:parameter><ac:parameter ac:name="columns">Chosen</ac:parameter>
      <ac:rich-text-body>
        <table id="first"><tbody><tr><th>Label</th><th title="Chosen">Revenue</th></tr><tr><td>A</td><td>10</td></tr></tbody></table>
        <table id="second"><tbody><tr><th>Label</th><th title="Chosen">Revenue</th></tr><tr><td>B</td><td>20</td></tr></tbody></table>
      </ac:rich-text-body>
    </ac:structured-macro>`);
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        data: { labels: ["B"], series: [{ label: "Revenue", values: [20] }] },
        source: { sourceTableDigests: [expect.stringMatching(/^fnv1a-/)], dependencyDigest: expect.stringMatching(/^fnv1a-/) },
      },
    });
    expect(JSON.stringify(result.blocks[0])).not.toContain("second");
  });

  test("invalidates the chart dependency digest only when a selected source table changes", () => {
    const source = (selectedValue: number, unselectedValue: number) => `<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">bar</ac:parameter><ac:parameter ac:name="dataOrientation">vertical</ac:parameter>
      <ac:parameter ac:name="tables">1</ac:parameter>
      <ac:rich-text-body>
        <table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>Selected</td><td>${selectedValue}</td></tr></tbody></table>
        <table><tbody><tr><th>Label</th><th>Value</th></tr><tr><td>Ignored</td><td>${unselectedValue}</td></tr></tbody></table>
      </ac:rich-text-body>
    </ac:structured-macro>`;
    const digest = (selectedValue: number, unselectedValue: number): string => {
      const block = storageToBlocks(source(selectedValue, unselectedValue)).blocks[0];
      if (block?.type !== "chart" || !block.chart.source.dependencyDigest) throw new Error("chart dependency digest missing");
      return block.chart.source.dependencyDigest;
    };
    const baseline = digest(10, 20);
    expect(digest(10, 999)).toBe(baseline);
    expect(digest(11, 20)).not.toBe(baseline);
  });

  test("normalizes time-based XY data, explicit date formats, and suffixed tick units", () => {
    const result = storageToBlocks(`<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">xyLine</ac:parameter><ac:parameter ac:name="timeSeries">true</ac:parameter>
      <ac:parameter ac:name="dateFormat">MM/yyyy</ac:parameter><ac:parameter ac:name="timePeriod">month</ac:parameter>
      <ac:parameter ac:name="domainAxisTickUnit">2M</ac:parameter><ac:parameter ac:name="dateTickMarkPosition">middle</ac:parameter>
      <ac:rich-text-body><table><tbody>
        <tr><th>Month</th><th>01/2026</th><th>02/2026</th><th>03/2026</th></tr>
        <tr><td>Revenue</td><td>10</td><td>20</td><td>30</td></tr>
      </tbody></table></ac:rich-text-body>
    </ac:structured-macro>`);
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        kind: "xyLine",
        axes: { x: { valueType: "date", tickUnit: 2, tickPeriod: "month", dateTickPosition: "middle" } },
        locale: { dateFormat: "MM/yyyy", timePeriod: "month" },
        data: { mode: "points", series: [{ points: [
          { x: "2026-01-01T00:00:00.000Z", y: 10 },
          { x: "2026-02-01T00:00:00.000Z", y: 20 },
          { x: "2026-03-01T00:00:00.000Z", y: 30 },
        ] }] },
      },
    });
  });

  test("retains the documented pie label format and canonicalizes HTML color names", () => {
    const result = storageToBlocks(storageChart("pie", [
      '<ac:parameter ac:name="pieSectionLabel">%0% = %1% (%2%)</ac:parameter>',
      '<ac:parameter ac:name="bgColor">white</ac:parameter>',
      '<ac:parameter ac:name="borderColor">navy</ac:parameter>',
      '<ac:parameter ac:name="colors">red, #0c66e4, lime</ac:parameter>',
    ].join("")));
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: {
        pie: { sectionLabelFormat: "%0% = %1% (%2%)" },
        style: { backgroundColor: "#FFFFFF", borderColor: "#000080", colors: ["#FF0000", "#0C66E4", "#00FF00"] },
      },
    });
  });

  test("resolves Gantt dependencies without recalculating provider scheduling", () => {
    const result = storageToBlocks(`<ac:structured-macro ac:name="chart">
      <ac:parameter ac:name="type">gantt</ac:parameter><ac:parameter ac:name="columns">,,1,2,3,4,5</ac:parameter>
      <ac:parameter ac:name="dateFormat">MM/dd/yyyy</ac:parameter>
      <ac:rich-text-body><table><tbody>
        <tr><th>Task</th><th>Start</th><th>End</th><th>Status</th><th>Predecessor</th></tr>
        <tr><td>Build</td><td>06/25/2013</td><td>07/10/2013</td><td>100%</td><td></td></tr>
        <tr><td>Publish</td><td>07/13/2013</td><td>07/20/2013</td><td>40%</td><td>Build</td></tr>
      </tbody></table></ac:rich-text-body>
    </ac:structured-macro>`);
    expect(result.blocks[0]).toMatchObject({
      type: "chart",
      chart: { data: { mode: "gantt", tasks: [
        { id: "table-1-task-1", label: "Build", progress: 1 },
        { id: "table-1-task-2", label: "Publish", progress: 0.4, dependencies: ["table-1-task-1"] },
      ] } },
    });
  });
});

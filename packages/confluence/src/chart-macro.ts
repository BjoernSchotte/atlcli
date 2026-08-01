import {
  chartModelDigestV1,
  validateChartModelV1,
  type ChartDataV1,
  type ChartDiagnosticV1,
  type ChartAxisV1,
  type ChartKindV1,
  type ChartModelV1,
  type ChartSourceKindV1,
} from "@atlcli/export-blocks";
import type { ExportBlock, MacroParameter } from "@atlcli/export-blocks";

export interface ChartMacroNormalizationResult {
  model?: ChartModelV1;
  diagnostics: ChartDiagnosticV1[];
}

export function isChartMacroName(value: string | undefined): boolean {
  const name = value?.trim().toLowerCase() ?? "";
  return name === "chart" || name.endsWith(":chart") || name.endsWith("-chart");
}

function parameter(params: readonly MacroParameter[], name: string): string | undefined {
  const target = name.toLowerCase();
  return params.find((item) => item.name.toLowerCase() === target)?.text?.trim() || undefined;
}

function boolParameter(params: readonly MacroParameter[], name: string): boolean | undefined {
  const value = parameter(params, name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (value === "true" || value === "yes" || value === "1") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  return undefined;
}

function numberParameter(params: readonly MacroParameter[], name: string): number | undefined {
  const value = parameter(params, name);
  if (value === undefined) return undefined;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : undefined;
}

function axisPosition(value: string | undefined): ChartAxisV1["categoryLabelPosition"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "near" || normalized === "center" || normalized === "far") return normalized;
  return undefined;
}

function parseAxis(params: readonly MacroParameter[], axis: "x" | "y"): ChartAxisV1 | undefined {
  const names = axis === "x"
    ? { min: "domainaxislower", max: "domainaxisupper", tick: "domainaxistickunit", angle: "domainaxislabelangle" }
    : { min: "rangeaxislower", max: "rangeaxisupper", tick: "rangeaxistickunit", angle: "rangeaxislabelangle" };
  const min = numberParameter(params, names.min);
  const max = numberParameter(params, names.max);
  const tickUnit = numberParameter(params, names.tick);
  const labelAngle = numberParameter(params, names.angle) ?? numberParameter(params, "labelangle");
  const categoryLabelPosition = axis === "x" ? axisPosition(parameter(params, "categorylabelposition")) : undefined;
  const dateTickPosition = axis === "x" ? axisPosition(parameter(params, "datetickposition")) : undefined;
  if (min === undefined && max === undefined && tickUnit === undefined && labelAngle === undefined && categoryLabelPosition === undefined && dateTickPosition === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tickUnit === undefined ? {} : { tickUnit }),
    ...(labelAngle === undefined ? {} : { labelAngle }),
    ...(categoryLabelPosition === undefined ? {} : { categoryLabelPosition }),
    ...(dateTickPosition === undefined ? {} : { dateTickPosition }),
  };
}

function textOfInline(nodes: readonly import("@atlcli/export-blocks").InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.text;
    if (node.type === "link") return textOfInline(node.content);
    if (node.type === "mention") return node.displayName ? `@${node.displayName}` : "@mention";
    if (node.type === "status") return node.text;
    if (node.type === "date") return node.timestamp;
    if (node.type === "smartCard") return node.card.title ?? node.card.url ?? "Smart link";
    if (node.type === "media") return node.alt ?? node.media.filename ?? "Media";
    if (node.type === "placeholder") return node.text;
    return "\n";
  }).join("").trim();
}

function textOfBlock(block: ExportBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return textOfInline(block.content);
    case "codeBlock": return block.code.trim();
    case "smartCard": return block.card.title ?? block.card.url ?? "Smart link";
    case "table": return block.rows.map((row) => row.cells.map((cell) => cell.content.map(textOfBlock).join(" ")).join(" ")).join(" ");
    case "callout":
    case "expand":
    case "blockquote":
    case "orientation": return block.content.map(textOfBlock).join(" ");
    case "list": return block.items.map((item) => item.content.map(textOfBlock).join(" ")).join(" ");
    case "layout": return block.columns.flatMap((column) => column.content).map(textOfBlock).join(" ");
    case "image": return block.alt ?? (block.source.kind === "attachment" ? block.source.filename : "Image");
    case "mediaFallback": return block.alt ?? block.label;
    case "chart": return block.chart.title ?? "Chart";
    case "unknown": return block.plainBody ?? block.macroName;
    case "divider": case "pageBreak": case "anchor": return "";
  }
}

function tableBlocks(blocks: readonly ExportBlock[]): Extract<ExportBlock, { type: "table" }>[] {
  const out: Extract<ExportBlock, { type: "table" }>[] = [];
  const visit = (items: readonly ExportBlock[]): void => {
    for (const block of items) {
      if (block.type === "table") out.push(block);
      else if (block.type === "callout" || block.type === "expand" || block.type === "blockquote" || block.type === "orientation") visit(block.content);
      else if (block.type === "list") block.items.forEach((item) => visit(item.content));
      else if (block.type === "layout") block.columns.forEach((column) => visit(column.content));
    }
  };
  visit(blocks);
  return out;
}

function parseNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/\s/g, "").replace(/,/g, ".");
  if (!normalized) return undefined;
  const number = Number(normalized.replace(/%$/u, ""));
  return Number.isFinite(number) ? number : undefined;
}

function chartKind(value: string | undefined): ChartKindV1 {
  const normalized = (value ?? "bar").trim().toLowerCase().replace(/[-_\s]/g, "");
  const kinds: Record<string, ChartKindV1> = {
    pie: "pie", bar: "bar", line: "line", area: "area",
    xyarea: "xyArea", xybar: "xyBar", xyline: "xyLine", xystep: "xyStep",
    xysteparea: "xyStepArea", scatter: "scatter", timeseries: "timeSeries", gantt: "gantt",
  };
  return kinds[normalized] ?? "bar";
}

function selectedTableIndex(params: readonly MacroParameter[]): number {
  const value = parameter(params, "tables");
  if (!value) return 0;
  const index = Number(value.split(/[\s,]+/u)[0]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : 0;
}

function parseCategoryData(
  table: Extract<ExportBlock, { type: "table" }>,
  params: readonly MacroParameter[],
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "categories" }> | undefined {
  const rows = table.rows.map((row) => row.cells.map((cell) => cell.content.map(textOfBlock).join(" ").trim()));
  if (rows.length < 2 || rows.some((row) => row.length < 2)) {
    diagnostics.push({ code: "malformed-data", message: "Chart table needs a header and at least one data row." });
    return undefined;
  }
  const orientation = parameter(params, "dataorientation")?.toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  const selectedColumns = parameter(params, "columns")?.split(/[\s,]+/u).filter(Boolean);
  if (orientation === "vertical") {
    const headers = rows[0]!;
    const labels = rows.slice(1).map((row) => row[0] ?? "");
    const indexes = headers.slice(1).map((header, index) => ({ header, index: index + 1 }))
      .filter(({ header, index }) => !selectedColumns || selectedColumns.includes(header) || selectedColumns.includes(String(index + 1)));
    const series = indexes.map(({ header, index }) => ({
      id: `series-${index}`,
      label: header || `Series ${index}`,
      values: rows.slice(1).map((row, rowIndex) => {
        const value = parseNumber(row[index] ?? "");
        if (value === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric value skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
        return value ?? 0;
      }),
    }));
    return { mode: "categories", labels, series };
  }
  const headers = rows[0]!.slice(1);
  const labels = rows.slice(1).map((row) => row[0] ?? "");
  const series = rows.slice(1).map((row, rowIndex) => {
    const label = row[0] || `Series ${rowIndex + 1}`;
    return {
      id: `series-${rowIndex + 1}`,
      label,
      values: row.slice(1, headers.length + 1).map((value, valueIndex) => {
        const number = parseNumber(value ?? "");
        if (number === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric value skipped in row ${rowIndex + 2}, column ${valueIndex + 2}.`, row: rowIndex + 2 });
        return number ?? 0;
      }),
    };
  });
  // The horizontal form is most commonly authored as one series per row. For
  // the normalized category model labels are the table headers and each row is
  // a series, so use the series names and values from the first column.
  return {
    mode: "categories",
    labels: headers,
    series: series.map((item) => ({ id: item.id, label: item.label, values: item.values })),
  };
}

function parsePointData(
  table: Extract<ExportBlock, { type: "table" }>,
  kind: ChartKindV1,
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "points" }> | undefined {
  const rows = table.rows.map((row) => row.cells.map((cell) => cell.content.map(textOfBlock).join(" ").trim()));
  if (rows.length < 2 || rows.some((row) => row.length < 2)) {
    diagnostics.push({ code: "malformed-data", message: "XY/time-series chart table needs x/y columns." });
    return undefined;
  }
  const headers = rows[0]!;
  const xIndex = Math.max(0, headers.findIndex((header) => /^(x|date|time|start)$/iu.test(header)));
  const yIndexes = headers.map((_, index) => index).filter((index) => index !== xIndex);
  const series = yIndexes.map((index) => ({
    id: `series-${index}`,
    label: headers[index] || `Series ${index}`,
    points: rows.slice(1).flatMap((row, rowIndex) => {
      const y = parseNumber(row[index] ?? "");
      if (y === undefined) {
        diagnostics.push({ code: "skipped-row", message: `Non-numeric point skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
        return [];
      }
      const rawX = row[xIndex] ?? String(rowIndex + 1);
      if (kind === "timeSeries" && Number.isNaN(Date.parse(rawX))) {
        diagnostics.push({ code: "skipped-row", message: `Invalid timestamp skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
        return [];
      }
      const x = kind === "timeSeries" ? new Date(rawX).toISOString() : (parseNumber(rawX) ?? rawX);
      return [{ x, y, label: rawX }];
    }),
  }));
  return { mode: "points", series };
}

function parseGanttData(
  table: Extract<ExportBlock, { type: "table" }>,
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "gantt" }> | undefined {
  const rows = table.rows.map((row) => row.cells.map((cell) => cell.content.map(textOfBlock).join(" ").trim()));
  if (rows.length < 2) return undefined;
  const headers = rows[0]!.map((value) => value.toLowerCase());
  const find = (patterns: RegExp[]): number => headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  const labelIndex = Math.max(0, find([/task|name|activity/u]));
  const startIndex = find([/start|begin/u]);
  const endIndex = find([/end|finish|due/u]);
  if (startIndex < 0 || endIndex < 0) {
    diagnostics.push({ code: "malformed-data", message: "Gantt table needs task, start, and end columns." });
    return undefined;
  }
  const progressIndex = find([/progress|percent|complete/u]);
  const dependencyIndex = find([/depend|predecessor/u]);
  const tasks = rows.slice(1).flatMap((row, rowIndex) => {
    const label = row[labelIndex] ?? `Task ${rowIndex + 1}`;
    const start = row[startIndex] ?? "";
    const end = row[endIndex] ?? "";
    if (!label || !start || !end) {
      diagnostics.push({ code: "skipped-row", message: `Incomplete Gantt task skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
      return [];
    }
    const progress = progressIndex >= 0 ? parseNumber(row[progressIndex] ?? "") : undefined;
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      diagnostics.push({ code: "skipped-row", message: `Invalid Gantt date skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
      return [];
    }
    return [{
      id: `task-${rowIndex + 1}`,
      label,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      ...(progress === undefined ? {} : { progress: progress > 1 ? progress / 100 : progress }),
      ...(dependencyIndex >= 0 && row[dependencyIndex] ? { dependencies: row[dependencyIndex]!.split(/[\s,]+/u).filter(Boolean) } : {}),
    }];
  });
  return { mode: "gantt", tasks };
}

export function normalizeChartMacro(
  params: readonly MacroParameter[],
  body: readonly ExportBlock[],
  source: ChartSourceKindV1,
): ChartMacroNormalizationResult {
  const diagnostics: ChartDiagnosticV1[] = [];
  const kind = chartKind(parameter(params, "type"));
  const tables = tableBlocks(body);
  const table = tables[selectedTableIndex(params)] ?? tables[0];
  const attachmentName = parameter(params, "attachment") || params.find((item) => item.refs?.some((ref) => ref.kind === "attachment"))?.refs?.find((ref) => ref.kind === "attachment")?.filename;
  if (!table) {
    diagnostics.push({ code: attachmentName ? "missing-attachment" : "malformed-data", message: attachmentName ? `Chart attachment ${attachmentName} was not acquired.` : "Chart macro has no table data." });
    return { diagnostics };
  }
  let data: ChartDataV1 | undefined;
  if (kind === "gantt") data = parseGanttData(table, diagnostics);
  else if (kind === "xyArea" || kind === "xyBar" || kind === "xyLine" || kind === "xyStep" || kind === "xyStepArea" || kind === "scatter" || kind === "timeSeries") data = parsePointData(table, kind, diagnostics);
  else data = parseCategoryData(table, params, diagnostics);
  if (!data) return { diagnostics };
  const model: ChartModelV1 = {
    schema: "atlcli.chart/1",
    kind,
    ...(parameter(params, "title") ? { title: parameter(params, "title") } : {}),
    ...(parameter(params, "subtitle") ? { subtitle: parameter(params, "subtitle") } : {}),
    ...(parameter(params, "xlabel") ? { xLabel: parameter(params, "xlabel") } : {}),
    ...(parameter(params, "ylabel") ? { yLabel: parameter(params, "ylabel") } : {}),
    ...(parameter(params, "legend") ? { legend: parameter(params, "legend") as ChartModelV1["legend"] } : {}),
    ...(parameter(params, "orientation") ? { orientation: parameter(params, "orientation") as ChartModelV1["orientation"] } : {}),
    ...(boolParameter(params, "stacked") !== undefined ? { stacked: boolParameter(params, "stacked") } : {}),
    ...(boolParameter(params, "3d") !== undefined ? { threeD: boolParameter(params, "3d") } : {}),
    ...(boolParameter(params, "showshapes") !== undefined ? { showShapes: boolParameter(params, "showshapes") } : {}),
    ...(numberParameter(params, "opacity") !== undefined ? { opacity: numberParameter(params, "opacity") } : {}),
    display: {
      ...(numberParameter(params, "width") !== undefined ? { width: Math.round(numberParameter(params, "width")!) } : {}),
      ...(numberParameter(params, "height") !== undefined ? { height: Math.round(numberParameter(params, "height")!) } : {}),
      ...(parameter(params, "datadisplay") ? { data: parameter(params, "datadisplay") as "hidden" | "before" | "after" } : {}),
    },
    style: {
      ...(parameter(params, "bgcolor") ? { backgroundColor: parameter(params, "bgcolor") } : {}),
      ...(parameter(params, "bordercolor") ? { borderColor: parameter(params, "bordercolor") } : {}),
      ...(parameter(params, "colors") ? { colors: parameter(params, "colors")!.split(/[\s,]+/u).filter(Boolean) } : {}),
    },
    axes: {
      ...(parseAxis(params, "x") ? { x: parseAxis(params, "x") } : {}),
      ...(parseAxis(params, "y") ? { y: parseAxis(params, "y") } : {}),
    },
    locale: {
      ...(parameter(params, "language") ? { language: parameter(params, "language") } : {}),
      ...(parameter(params, "country") ? { country: parameter(params, "country") } : {}),
      ...(parameter(params, "dateformat") ? { dateFormat: parameter(params, "dateformat") } : {}),
      ...(parameter(params, "timeperiod") ? { timePeriod: parameter(params, "timeperiod") as NonNullable<ChartModelV1["locale"]>["timePeriod"] } : {}),
    },
    ...(kind === "pie" && (parameter(params, "piesectionlabel") || parameter(params, "piesectionexplode")) ? {
      pie: {
        ...(parameter(params, "piesectionlabel") ? { sectionLabel: parameter(params, "piesectionlabel") as NonNullable<ChartModelV1["pie"]>["sectionLabel"] } : {}),
        ...(parameter(params, "piesectionexplode") ? { explode: parameter(params, "piesectionexplode")!.split(/[\s,]+/u).map(Number).filter(Number.isFinite) } : {}),
      },
    } : {}),
    data,
    source: {
      kind: source,
      macroName: "chart",
      ...(attachmentName ? {
        attachment: {
          filename: attachmentName,
          ...(numberParameter(params, "attachmentversion") !== undefined ? { version: Math.round(numberParameter(params, "attachmentversion")!) } : {}),
          ...(parameter(params, "attachmentcomment") ? { comment: parameter(params, "attachmentcomment") } : {}),
          ...(boolParameter(params, "thumbnail") !== undefined ? { thumbnail: boolParameter(params, "thumbnail") } : {}),
        },
      } : {}),
    },
  };
  try {
    const normalized = validateChartModelV1(model);
    return { model: { ...normalized, source: { ...normalized.source, dependencyDigest: chartModelDigestV1(normalized) } }, diagnostics };
  } catch (error) {
    diagnostics.push({ code: "invalid-option", message: error instanceof Error ? error.message : "Chart model validation failed." });
    return { diagnostics };
  }
}

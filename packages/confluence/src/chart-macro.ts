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

function readBooleanParameter(params: readonly MacroParameter[], name: string, diagnostics: ChartDiagnosticV1[]): boolean | undefined {
  const raw = parameter(params, name);
  const value = boolParameter(params, name);
  if (raw !== undefined && value === undefined) {
    diagnostics.push({ code: "invalid-option", message: `Chart parameter ${name} must be a boolean.`, parameter: name });
  }
  return value;
}

function numberParameter(params: readonly MacroParameter[], name: string): number | undefined {
  const value = parameter(params, name);
  if (value === undefined) return undefined;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : undefined;
}

function readNumberParameter(params: readonly MacroParameter[], name: string, diagnostics: ChartDiagnosticV1[]): number | undefined {
  const raw = parameter(params, name);
  const value = numberParameter(params, name);
  if (raw !== undefined && value === undefined) {
    diagnostics.push({ code: "invalid-option", message: `Chart parameter ${name} must be numeric.`, parameter: name });
  }
  return value;
}

function enumParameter<T extends string>(
  params: readonly MacroParameter[],
  name: string,
  values: readonly T[],
  diagnostics: ChartDiagnosticV1[],
): T | undefined {
  const raw = parameter(params, name);
  if (raw === undefined) return undefined;
  const value = values.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  if (value === undefined) diagnostics.push({ code: "invalid-option", message: `Chart parameter ${name} has an unsupported value.`, parameter: name });
  return value;
}

function categoryLabelPosition(value: string | undefined): ChartAxisV1["categoryLabelPosition"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "up45" || normalized === "up90" || normalized === "down45" || normalized === "down90") return normalized;
  return undefined;
}

function dateTickPosition(value: string | undefined): ChartAxisV1["dateTickPosition"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "start" || normalized === "middle" || normalized === "end") return normalized;
  return undefined;
}

function firstParameter(params: readonly MacroParameter[], ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = parameter(params, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseAxis(params: readonly MacroParameter[], axis: "x" | "y"): ChartAxisV1 | undefined {
  const names = axis === "x"
    ? { min: ["domainaxislowerbound", "domainaxislower"], max: ["domainaxisupperbound", "domainaxisupper"], tick: "domainaxistickunit", angle: "domainaxislabelangle" }
    : { min: ["rangeaxislowerbound", "rangeaxislower"], max: ["rangeaxisupperbound", "rangeaxisupper"], tick: "rangeaxistickunit", angle: "rangeaxislabelangle" };
  const minRaw = firstParameter(params, ...names.min);
  const maxRaw = firstParameter(params, ...names.max);
  const min = minRaw === undefined ? undefined : (Number.isFinite(Number(minRaw.replace(",", "."))) ? Number(minRaw.replace(",", ".")) : minRaw);
  const max = maxRaw === undefined ? undefined : (Number.isFinite(Number(maxRaw.replace(",", "."))) ? Number(maxRaw.replace(",", ".")) : maxRaw);
  const tickUnit = numberParameter(params, names.tick);
  const labelAngle = numberParameter(params, names.angle) ?? numberParameter(params, "labelangle");
  const categoryPosition = axis === "x" ? categoryLabelPosition(parameter(params, "categorylabelposition")) : undefined;
  const tickPosition = axis === "x" ? dateTickPosition(firstParameter(params, "datetickmarkposition", "datetickposition")) : undefined;
  if (min === undefined && max === undefined && tickUnit === undefined && labelAngle === undefined && categoryPosition === undefined && tickPosition === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tickUnit === undefined ? {} : { tickUnit }),
    ...(labelAngle === undefined ? {} : { labelAngle }),
    ...(categoryPosition === undefined ? {} : { categoryLabelPosition: categoryPosition }),
    ...(tickPosition === undefined ? {} : { dateTickPosition: tickPosition }),
  };
}

function parseAxisWithDiagnostics(params: readonly MacroParameter[], axis: "x" | "y", diagnostics: ChartDiagnosticV1[]): ChartAxisV1 | undefined {
  const parsed = parseAxis(params, axis);
  const position = parameter(params, "categorylabelposition");
  if (axis === "x" && position !== undefined && categoryLabelPosition(position) === undefined) {
    diagnostics.push({ code: "invalid-option", message: "Chart category label position is invalid.", parameter: "categoryLabelPosition" });
  }
  const datePosition = firstParameter(params, "datetickmarkposition", "datetickposition");
  if (axis === "x" && datePosition !== undefined && dateTickPosition(datePosition) === undefined) {
    diagnostics.push({ code: "invalid-option", message: "Chart date tick position is invalid.", parameter: "dateTickPosition" });
  }
  return parsed;
}

function opacityParameter(params: readonly MacroParameter[], diagnostics: ChartDiagnosticV1[]): number | undefined {
  const raw = parameter(params, "opacity");
  if (raw === undefined) return undefined;
  const percentage = Number(raw.trim().replace(/%$/u, "").replace(",", "."));
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    diagnostics.push({ code: "invalid-option", message: "Chart opacity must be a percentage from 0 to 100.", parameter: "opacity" });
    return undefined;
  }
  return percentage / 100;
}

function dataDisplayParameter(params: readonly MacroParameter[], diagnostics: ChartDiagnosticV1[]): NonNullable<ChartModelV1["display"]>["data"] | undefined {
  const raw = parameter(params, "datadisplay")?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "after") return "after";
  if (raw === "false" || raw === "hidden") return "hidden";
  if (raw === "before") return "before";
  diagnostics.push({ code: "invalid-option", message: "Chart dataDisplay must be true, false, before, or after.", parameter: "dataDisplay" });
  return undefined;
}

function legendParameter(params: readonly MacroParameter[], diagnostics: ChartDiagnosticV1[]): ChartModelV1["legend"] | undefined {
  const raw = parameter(params, "legend")?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "yes" || raw === "1") return "top";
  if (raw === "false" || raw === "no" || raw === "0") return "none";
  if (raw === "none" || raw === "top" || raw === "right" || raw === "bottom" || raw === "left") return raw;
  diagnostics.push({ code: "invalid-option", message: "Chart legend must be boolean or a supported position.", parameter: "legend" });
  return undefined;
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

function chartKind(value: string | undefined): ChartKindV1 | undefined {
  const normalized = (value ?? "bar").trim().toLowerCase().replace(/[-_\s]/g, "");
  const kinds: Record<string, ChartKindV1> = {
    pie: "pie", bar: "bar", line: "line", area: "area",
    xyarea: "xyArea", xybar: "xyBar", xyline: "xyLine", xystep: "xyStep",
    xysteparea: "xyStepArea", scatter: "scatter", timeseries: "timeSeries", gantt: "gantt",
  };
  return kinds[normalized];
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
        diagnostics.push({ code: "locale-parse", message: `Invalid timestamp skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
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
      diagnostics.push({ code: "locale-parse", message: `Invalid Gantt date skipped in row ${rowIndex + 2}.`, row: rowIndex + 2 });
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
  if (kind === undefined) {
    return {
      diagnostics: [{
        code: "unsupported-kind",
        message: `Unsupported Confluence Chart macro type: ${parameter(params, "type") ?? "(empty)"}.`,
        parameter: "type",
      }],
    };
  }
  const tables = tableBlocks(body);
  const table = tables[selectedTableIndex(params)] ?? tables[0];
  const attachmentName = parameter(params, "attachment") || params.find((item) => item.refs?.some((ref) => ref.kind === "attachment"))?.refs?.find((ref) => ref.kind === "attachment")?.filename;
  if (!table) {
    diagnostics.push({ code: "malformed-data", message: "Chart macro has no table data. Its optional attachment parameter names a generated chart image, not a data source." });
    return { diagnostics };
  }
  let data: ChartDataV1 | undefined;
  if (kind === "gantt") data = parseGanttData(table, diagnostics);
  else if (kind === "xyArea" || kind === "xyBar" || kind === "xyLine" || kind === "xyStep" || kind === "xyStepArea" || kind === "scatter" || kind === "timeSeries") data = parsePointData(table, kind, diagnostics);
  else data = parseCategoryData(table, params, diagnostics);
  if (!data) return { diagnostics };
  for (const name of [
    "width", "height", "domainAxisLower", "domainAxisUpper", "domainAxisTickUnit",
    "domainAxisLabelAngle", "rangeAxisLower", "rangeAxisUpper", "rangeAxisTickUnit", "rangeAxisLabelAngle",
  ]) readNumberParameter(params, name, diagnostics);
  const stacked = readBooleanParameter(params, "stacked", diagnostics);
  const threeD = readBooleanParameter(params, "3d", diagnostics);
  const showShapes = readBooleanParameter(params, "showshapes", diagnostics);
  const thumbnail = readBooleanParameter(params, "thumbnail", diagnostics);
  const forgive = readBooleanParameter(params, "forgive", diagnostics);
  const legend = legendParameter(params, diagnostics);
  const orientation = enumParameter(params, "orientation", ["vertical", "horizontal"] as const, diagnostics);
  const dataDisplay = dataDisplayParameter(params, diagnostics);
  const pieSectionLabel = enumParameter(params, "piesectionlabel", ["name", "value", "percent", "name-value"] as const, diagnostics);
  const pieExplode = parameter(params, "piesectionexplode")?.split(",").map((value) => value.trim()).filter(Boolean);
  if (kind === "pie" && pieExplode && data.mode === "categories") {
    for (const key of pieExplode) {
      if (!data.labels.includes(key)) diagnostics.push({ code: "invalid-option", message: `Pie section ${key} cannot be exploded because it is not present in the chart data.`, parameter: "pieSectionExplode" });
    }
  }
  const timePeriod = enumParameter(params, "timeperiod", [
    "millisecond", "second", "minute", "hour", "day", "week", "month", "quarter", "year",
  ] as const, diagnostics);
  const attachmentVersion = enumParameter(params, "attachmentversion", ["new", "replace", "keep"] as const, diagnostics);
  const renderedImageFormat = enumParameter(params, "imageformat", ["png", "jpg"] as const, diagnostics);
  const opacity = opacityParameter(params, diagnostics);
  const xAxis = parseAxisWithDiagnostics(params, "x", diagnostics);
  const yAxis = parseAxisWithDiagnostics(params, "y", diagnostics);
  const model: ChartModelV1 = {
    schema: "atlcli.chart/1",
    kind,
    ...(parameter(params, "title") ? { title: parameter(params, "title") } : {}),
    ...(parameter(params, "subtitle") ? { subtitle: parameter(params, "subtitle") } : {}),
    ...(parameter(params, "xlabel") ? { xLabel: parameter(params, "xlabel") } : {}),
    ...(parameter(params, "ylabel") ? { yLabel: parameter(params, "ylabel") } : {}),
    ...(legend !== undefined ? { legend } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
    ...(stacked !== undefined ? { stacked } : {}),
    ...(threeD !== undefined ? { threeD } : {}),
    ...(showShapes !== undefined ? { showShapes } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    display: {
      ...(numberParameter(params, "width") !== undefined ? { width: Math.round(numberParameter(params, "width")!) } : {}),
      ...(numberParameter(params, "height") !== undefined ? { height: Math.round(numberParameter(params, "height")!) } : {}),
      ...(dataDisplay !== undefined ? { data: dataDisplay } : {}),
    },
    style: {
      ...(parameter(params, "bgcolor") ? { backgroundColor: parameter(params, "bgcolor") } : {}),
      ...(parameter(params, "bordercolor") ? { borderColor: parameter(params, "bordercolor") } : {}),
      ...(parameter(params, "colors") ? { colors: parameter(params, "colors")!.split(/[\s,]+/u).filter(Boolean) } : {}),
    },
    axes: {
      ...(xAxis ? { x: xAxis } : {}),
      ...(yAxis ? { y: yAxis } : {}),
    },
    locale: {
      ...(parameter(params, "language") ? { language: parameter(params, "language") } : {}),
      ...(parameter(params, "country") ? { country: parameter(params, "country") } : {}),
      ...(parameter(params, "dateformat") ? { dateFormat: parameter(params, "dateformat") } : {}),
      ...(timePeriod !== undefined ? { timePeriod } : {}),
    },
    ...(kind === "pie" && (parameter(params, "piesectionlabel") || pieExplode) ? {
      pie: {
        ...(pieSectionLabel !== undefined ? { sectionLabel: pieSectionLabel } : {}),
        ...(pieExplode ? { explode: pieExplode } : {}),
      },
    } : {}),
    data,
    source: {
      kind: source,
      macroName: "chart",
      ...(attachmentName ? {
        attachment: {
          filename: attachmentName,
          ...(attachmentVersion !== undefined ? { version: attachmentVersion } : {}),
          ...(parameter(params, "attachmentcomment") ? { comment: parameter(params, "attachmentcomment") } : {}),
          ...(thumbnail !== undefined ? { thumbnail } : {}),
        },
      } : {}),
      ...(renderedImageFormat !== undefined ? { renderedImageFormat } : {}),
    },
  };
  if (threeD === true) diagnostics.push({ code: "invalid-option", message: "3D chart perspective is flattened in the source-neutral render model.", parameter: "3d" });
  if (forgive === false && diagnostics.some((diagnostic) => diagnostic.code === "skipped-row" || diagnostic.code === "malformed-data" || diagnostic.code === "locale-parse")) {
    diagnostics.push({ code: "malformed-data", message: "Chart import is strict (forgive=false); no partial chart was published.", parameter: "forgive" });
    return { diagnostics };
  }
  try {
    const normalized = validateChartModelV1(model);
    return { model: { ...normalized, source: { ...normalized.source, dependencyDigest: chartModelDigestV1(normalized) } }, diagnostics };
  } catch (error) {
    diagnostics.push({ code: "invalid-option", message: error instanceof Error ? error.message : "Chart model validation failed." });
    return { diagnostics };
  }
}

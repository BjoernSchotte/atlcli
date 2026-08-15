import {
  validateChartModelV1,
  type ChartDataV1,
  type ChartDiagnosticV1,
  type ChartAxisV1,
  type ChartKindV1,
  type ChartModelV1,
  type ChartSourceKindV1,
  type ChartTimePeriodV1,
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

const KNOWN_CHART_PARAMETERS_V1 = new Set([
  "type", "title", "subtitle", "xlabel", "ylabel",
  "forgive", "language", "country", "dateformat", "timeseries", "timeperiod",
  "dataorientation", "tables", "columns", "width", "height", "datadisplay",
  "stacked", "3d", "showshapes", "opacity", "legend", "orientation",
  "piesectionlabel", "piesectionexplode", "bgcolor", "bordercolor", "colors",
  "domainaxislowerbound", "domainaxislower", "domainaxisupperbound", "domainaxisupper",
  "domainaxistickunit", "domainaxislabelangle", "rangeaxislowerbound", "rangeaxislower",
  "rangeaxisupperbound", "rangeaxisupper", "rangeaxistickunit", "rangeaxislabelangle",
  "labelangle", "categorylabelposition", "datetickmarkposition", "datetickposition",
  "attachment", "attachmentversion", "attachmentcomment", "thumbnail", "imageformat",
]);

function chartParameterDiagnostics(params: readonly MacroParameter[]): ChartDiagnosticV1[] {
  const diagnostics: ChartDiagnosticV1[] = [];
  const seen = new Set<string>();
  for (const item of params) {
    const normalized = item.name.trim().toLowerCase();
    const safeName = /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(normalized) ? normalized : "unknown";
    if (seen.has(normalized)) {
      diagnostics.push({
        code: "invalid-option",
        message: `Chart parameter ${safeName} is duplicated; the first value is used.`,
        parameter: safeName,
      });
      continue;
    }
    seen.add(normalized);
    if (!KNOWN_CHART_PARAMETERS_V1.has(normalized)) {
      diagnostics.push({
        code: "invalid-option",
        message: `Unsupported Chart macro parameter ${safeName} was ignored.`,
        parameter: safeName,
      });
    }
  }
  return diagnostics;
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

interface ChartParsePolicy {
  locale: string;
  dateFormat?: string;
  forgive: boolean;
}

function chartLocale(language: string | undefined, country: string | undefined): string {
  const normalizedLanguage = language?.trim().toLowerCase();
  const normalizedCountry = country?.trim().toUpperCase();
  const candidate = normalizedLanguage
    ? `${normalizedLanguage}${normalizedCountry ? `-${normalizedCountry}` : ""}`
    : normalizedCountry
      ? `en-${normalizedCountry}`
      : "en-US";
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function localeSeparators(locale: string): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(12345.6);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? ",",
  };
}

function parseLocalizedNumber(value: string, policy: ChartParsePolicy): number | undefined {
  const raw = value.trim().replace(/[\u00a0\u202f]/gu, " ");
  if (!raw) return undefined;
  const percent = raw.endsWith("%");
  const body = (percent ? raw.slice(0, -1) : raw).trim();
  const { decimal, group } = localeSeparators(policy.locale);
  const decimalPattern = regexEscape(decimal);
  const groupPattern = group === " " ? "[ \\u00a0\\u202f]" : regexEscape(group);
  const strictPattern = new RegExp(`^[+-]?(?:(?:\\d{1,3}(?:${groupPattern}\\d{3})+)|\\d+)(?:${decimalPattern}\\d+)?$`, "u");
  let normalized: string | undefined;
  if (strictPattern.test(body)) {
    normalized = body
      .replace(new RegExp(groupPattern, "gu"), "")
      .replace(decimal, ".");
  } else if (policy.forgive) {
    const compact = body.replace(/\s/gu, "");
    if (!/^[+-]?[\d.,]+$/u.test(compact)) return undefined;
    const dot = compact.lastIndexOf(".");
    const comma = compact.lastIndexOf(",");
    const separatorIndex = Math.max(dot, comma);
    if (dot >= 0 && comma >= 0) {
      const fractionDigits = compact.length - separatorIndex - 1;
      normalized = compact.slice(0, separatorIndex).replace(/[.,]/gu, "") + (fractionDigits > 0 ? `.${compact.slice(separatorIndex + 1)}` : "");
    } else if (separatorIndex >= 0) {
      const separator = compact[separatorIndex]!;
      const digitsAfter = compact.length - separatorIndex - 1;
      const configuredDecimal = separator === decimal;
      const treatAsGrouping = !configuredDecimal && digitsAfter === 3;
      normalized = treatAsGrouping
        ? compact.replace(/[.,]/gu, "")
        : compact.slice(0, separatorIndex).replace(/[.,]/gu, "") + `.${compact.slice(separatorIndex + 1)}`;
    } else {
      normalized = compact;
    }
  }
  if (normalized === undefined) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? (percent ? number / 100 : number) : undefined;
}

type DatePart = "year" | "month" | "day" | "hour" | "minute" | "second";

function monthNames(locale: string, width: "short" | "long"): readonly string[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, month) => formatter.format(new Date(Date.UTC(2020, month, 1))));
}

function parseDateWithFormat(value: string, format: string, locale: string): string | undefined {
  const tokens = ["yyyy", "MMMM", "MMM", "yy", "MM", "dd", "HH", "mm", "ss", "M", "d", "H", "m", "s"] as const;
  const fields: Array<{ part: DatePart; token: string; names?: readonly string[] }> = [];
  let pattern = "^";
  for (let index = 0; index < format.length;) {
    if (format[index] === "'") {
      const end = format.indexOf("'", index + 1);
      const literal = end === -1 ? format.slice(index + 1) : format.slice(index + 1, end);
      pattern += regexEscape(literal);
      index = end === -1 ? format.length : end + 1;
      continue;
    }
    const token = tokens.find((candidate) => format.startsWith(candidate, index));
    if (!token) {
      pattern += regexEscape(format[index]!);
      index += 1;
      continue;
    }
    const part: DatePart = token.startsWith("y") ? "year"
      : token.startsWith("M") ? "month"
        : token.startsWith("d") ? "day"
          : token.startsWith("H") ? "hour"
            : token.startsWith("m") ? "minute"
              : "second";
    if (token === "MMM" || token === "MMMM") {
      const names = monthNames(locale, token === "MMM" ? "short" : "long");
      fields.push({ part, token, names });
      pattern += `(${names.map(regexEscape).sort((left, right) => right.length - left.length).join("|")})`;
    } else {
      fields.push({ part, token });
      pattern += token.length === 1 ? "(\\d{1,2})" : token === "yyyy" ? "(\\d{4})" : "(\\d{2})";
    }
    index += token.length;
  }
  pattern += "$";
  const match = value.trim().match(new RegExp(pattern, "iu"));
  if (!match) return undefined;
  const parts: Record<DatePart, number> = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  fields.forEach((field, index) => {
    const captured = match[index + 1]!;
    if (field.names) parts[field.part] = field.names.findIndex((name) => name.toLocaleLowerCase(locale) === captured.toLocaleLowerCase(locale)) + 1;
    else if (field.part === "year" && field.token === "yy") parts.year = 2000 + Number(captured);
    else parts[field.part] = Number(captured);
  });
  const timestamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== parts.year || parsed.getUTCMonth() !== parts.month - 1 || parsed.getUTCDate() !== parts.day ||
    parsed.getUTCHours() !== parts.hour || parsed.getUTCMinutes() !== parts.minute || parsed.getUTCSeconds() !== parts.second
  ) return undefined;
  return parsed.toISOString();
}

function localeDateFormats(locale: string): readonly string[] {
  const region = new Intl.Locale(locale).region ?? "US";
  if (["US", "PH"].includes(region)) return ["M/d/yyyy", "M/yyyy"];
  if (["CN", "JP", "KR", "TW"].includes(region)) return ["yyyy/M/d", "yyyy-MM-dd", "yyyy/M"];
  if (["DE", "AT", "CH"].includes(region)) return ["d.M.yyyy", "M/yyyy"];
  return ["d/M/yyyy", "M/yyyy"];
}

function parseLocalizedDate(value: string, policy: ChartParsePolicy): string | undefined {
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/u.test(raw)) {
    const timestamp = Date.parse(raw);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  const formats = [
    ...(policy.dateFormat ? [policy.dateFormat] : []),
    ...localeDateFormats(policy.locale),
    ...(policy.forgive ? ["M/d/yyyy", "d/M/yyyy", "d.M.yyyy", "yyyy/M/d"] : []),
  ];
  for (const format of [...new Set(formats)]) {
    const parsed = parseDateWithFormat(raw, format, policy.locale);
    if (parsed) return parsed;
  }
  return undefined;
}

const DATE_TICK_SUFFIXES: Readonly<Record<string, ChartTimePeriodV1>> = {
  y: "year", M: "month", d: "day", h: "hour", m: "minute", s: "second", u: "millisecond",
};

function dateTickUnit(value: string | undefined): { tickUnit: number; tickPeriod?: ChartTimePeriodV1 } | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^([0-9]+(?:[.,][0-9]+)?)([yMdhmsu])?$/u);
  if (!match) return undefined;
  const tickUnit = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(tickUnit) || tickUnit <= 0) return undefined;
  return { tickUnit, ...(match[2] ? { tickPeriod: DATE_TICK_SUFFIXES[match[2]] } : {}) };
}

function parseAxis(
  params: readonly MacroParameter[],
  axis: "x" | "y",
  policy: ChartParsePolicy,
  dateAxis: boolean,
  diagnostics: ChartDiagnosticV1[],
): ChartAxisV1 | undefined {
  const names = axis === "x"
    ? { min: ["domainaxislowerbound", "domainaxislower"], max: ["domainaxisupperbound", "domainaxisupper"], tick: "domainaxistickunit", angle: "domainaxislabelangle" }
    : { min: ["rangeaxislowerbound", "rangeaxislower"], max: ["rangeaxisupperbound", "rangeaxisupper"], tick: "rangeaxistickunit", angle: "rangeaxislabelangle" };
  const minRaw = firstParameter(params, ...names.min);
  const maxRaw = firstParameter(params, ...names.max);
  const parseBound = (raw: string | undefined, parameterName: string): number | string | undefined => {
    if (raw === undefined) return undefined;
    const parsed = dateAxis && axis === "x" ? parseLocalizedDate(raw, policy) : parseLocalizedNumber(raw, policy);
    if (parsed === undefined) diagnostics.push({ code: dateAxis && axis === "x" ? "locale-parse" : "invalid-option", message: `Chart ${parameterName} could not be parsed deterministically.`, parameter: parameterName });
    return parsed;
  };
  const min = parseBound(minRaw, names.min[0]!);
  const max = parseBound(maxRaw, names.max[0]!);
  const tickRaw = parameter(params, names.tick);
  const dateTick = dateAxis && axis === "x" ? dateTickUnit(tickRaw) : undefined;
  const numericTick = dateAxis && axis === "x" ? undefined : (tickRaw === undefined ? undefined : parseLocalizedNumber(tickRaw, policy));
  if (tickRaw !== undefined && dateTick === undefined && numericTick === undefined) {
    diagnostics.push({ code: "invalid-option", message: `Chart ${names.tick} must be a positive numeric tick unit${dateAxis && axis === "x" ? " with an optional y/M/d/h/m/s/u suffix" : ""}.`, parameter: names.tick });
  }
  const tickUnit = dateTick?.tickUnit ?? numericTick;
  const angleRaw = parameter(params, names.angle) ?? parameter(params, "labelangle");
  const labelAngle = angleRaw === undefined ? undefined : parseLocalizedNumber(angleRaw, policy);
  if (angleRaw !== undefined && labelAngle === undefined) diagnostics.push({ code: "invalid-option", message: `Chart ${names.angle} must be numeric.`, parameter: names.angle });
  const categoryPosition = axis === "x" ? categoryLabelPosition(parameter(params, "categorylabelposition")) : undefined;
  const datePositionRaw = axis === "x" ? firstParameter(params, "datetickmarkposition", "datetickposition") : undefined;
  const tickPosition = axis === "x" ? dateTickPosition(datePositionRaw) : undefined;
  if (axis === "x" && datePositionRaw !== undefined && tickPosition === undefined) diagnostics.push({ code: "invalid-option", message: "Chart date tick position is invalid.", parameter: "dateTickPosition" });
  const position = dateAxis && axis === "x" ? tickPosition ?? "start" : tickPosition;
  if (min === undefined && max === undefined && tickUnit === undefined && labelAngle === undefined && categoryPosition === undefined && position === undefined && !(dateAxis && axis === "x")) return undefined;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tickUnit === undefined ? {} : { tickUnit }),
    ...(dateTick?.tickPeriod === undefined ? {} : { tickPeriod: dateTick.tickPeriod }),
    ...(labelAngle === undefined ? {} : { labelAngle }),
    ...(categoryPosition === undefined ? {} : { categoryLabelPosition: categoryPosition }),
    ...(position === undefined ? {} : { dateTickPosition: position }),
    ...(dateAxis && axis === "x" ? { valueType: "date" as const } : {}),
  };
}

function parseAxisWithDiagnostics(
  params: readonly MacroParameter[],
  axis: "x" | "y",
  policy: ChartParsePolicy,
  dateAxis: boolean,
  diagnostics: ChartDiagnosticV1[],
): ChartAxisV1 | undefined {
  const parsed = parseAxis(params, axis, policy, dateAxis, diagnostics);
  const position = parameter(params, "categorylabelposition");
  if (axis === "x" && position !== undefined && categoryLabelPosition(position) === undefined) {
    diagnostics.push({ code: "invalid-option", message: "Chart category label position is invalid.", parameter: "categoryLabelPosition" });
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

const HTML_CHART_COLORS: Readonly<Record<string, string>> = {
  black: "#000000", silver: "#C0C0C0", gray: "#808080", grey: "#808080",
  white: "#FFFFFF", maroon: "#800000", red: "#FF0000", purple: "#800080",
  fuchsia: "#FF00FF", green: "#008000", lime: "#00FF00", olive: "#808000",
  yellow: "#FFFF00", navy: "#000080", blue: "#0000FF", teal: "#008080",
  aqua: "#00FFFF", orange: "#FFA500",
};

function normalizeChartColor(value: string): string | undefined {
  const raw = value.trim();
  const long = raw.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/iu);
  if (long) return `#${long[1]!.toUpperCase()}`;
  const short = raw.match(/^#?([0-9a-f]{3})$/iu);
  if (short) return `#${[...short[1]!].map((digit) => `${digit}${digit}`).join("").toUpperCase()}`;
  return HTML_CHART_COLORS[raw.toLowerCase()];
}

function chartColorParameter(
  params: readonly MacroParameter[],
  name: string,
  diagnostics: ChartDiagnosticV1[],
): string | undefined {
  const raw = parameter(params, name);
  if (raw === undefined) return undefined;
  const color = normalizeChartColor(raw);
  if (!color) diagnostics.push({ code: "invalid-option", message: `Chart color ${raw} is not a supported hexadecimal or HTML color.`, parameter: name });
  return color;
}

function chartPaletteParameter(params: readonly MacroParameter[], diagnostics: ChartDiagnosticV1[]): string[] | undefined {
  const raw = parameter(params, "colors");
  if (raw === undefined) return undefined;
  const colors = raw.split(",").map((value) => value.trim()).filter(Boolean).flatMap((value) => {
    const normalized = normalizeChartColor(value);
    if (!normalized) {
      diagnostics.push({ code: "invalid-option", message: `Chart color ${value} is not a supported hexadecimal or HTML color.`, parameter: "colors" });
      return [];
    }
    return [normalized];
  });
  return colors.length > 0 ? colors : undefined;
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

function chartKind(value: string | undefined): ChartKindV1 | undefined {
  const normalized = (value ?? "pie").trim().toLowerCase().replace(/[-_\s]/g, "");
  const kinds: Record<string, ChartKindV1> = {
    pie: "pie", bar: "bar", line: "line", area: "area",
    xyarea: "xyArea", xybar: "xyBar", xyline: "xyLine", xystep: "xyStep",
    xysteparea: "xyStepArea", scatter: "scatter", timeseries: "timeSeries", gantt: "gantt",
  };
  return kinds[normalized];
}

type ChartTableBlock = Extract<ExportBlock, { type: "table" }>;

interface ChartSourceTable {
  table: ChartTableBlock;
  index: number;
  rows: string[][];
  titles: Array<string | undefined>;
  digest: string;
}

function fnvDigest(value: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sourceTable(table: ChartTableBlock, index: number): ChartSourceTable {
  const rows = table.rows.map((row) => row.cells.map((cell) => cell.content.map(textOfBlock).join(" ").trim()));
  const titles = table.rows[0]?.cells.map((cell) => cell.title) ?? [];
  return {
    table,
    index,
    rows,
    titles,
    digest: fnvDigest(JSON.stringify({ index, rows, titles })),
  };
}

function selectTables(
  params: readonly MacroParameter[],
  body: readonly ExportBlock[],
  diagnostics: ChartDiagnosticV1[],
): ChartSourceTable[] {
  const available = tableBlocks(body).map(sourceTable);
  const raw = parameter(params, "tables");
  if (!raw) return available;
  const selected: ChartSourceTable[] = [];
  for (const selector of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const number = Number(selector);
    const match = Number.isSafeInteger(number) && number >= 1
      ? available[number - 1]
      : available.find(({ table }) => table.presentation?.sourceId === selector || table.presentation?.localId === selector);
    if (!match) {
      diagnostics.push({ code: "malformed-data", message: `Chart table selector ${selector} did not match a source table.`, parameter: "tables" });
    } else if (!selected.includes(match)) {
      selected.push(match);
    }
  }
  return selected;
}

function selectedColumnIndexes(
  source: ChartSourceTable,
  params: readonly MacroParameter[],
  diagnostics: ChartDiagnosticV1[],
): number[] {
  const width = Math.max(0, ...source.rows.map((row) => row.length));
  const raw = parameter(params, "columns");
  if (!raw) return Array.from({ length: width }, (_, index) => index);
  const headers = source.rows[0] ?? [];
  const indexes: number[] = [0];
  for (const selector of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const number = Number(selector);
    const index = Number.isSafeInteger(number) && number >= 1
      ? number - 1
      : headers.findIndex((header, candidate) => header === selector || source.titles[candidate] === selector);
    if (index < 0 || index >= width) {
      diagnostics.push({ code: "malformed-data", message: `Chart column selector ${selector} did not match table ${source.index + 1}.`, parameter: "columns" });
    } else if (!indexes.includes(index)) {
      indexes.push(index);
    }
  }
  return indexes.sort((left, right) => left - right);
}

function parseCategoryData(
  sources: readonly ChartSourceTable[],
  params: readonly MacroParameter[],
  policy: ChartParsePolicy,
  orientation: "horizontal" | "vertical",
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "categories" }> | undefined {
  const parsed = sources.flatMap((source) => {
    const { rows } = source;
    if (rows.length < 2 || rows.some((row) => row.length < 2)) {
      diagnostics.push({ code: "malformed-data", message: `Chart table ${source.index + 1} needs a header and at least one data row.` });
      return [];
    }
    const indexes = selectedColumnIndexes(source, params, diagnostics);
    const valueIndexes = indexes.filter((index) => index !== 0);
    if (valueIndexes.length === 0) {
      diagnostics.push({ code: "malformed-data", message: `Chart table ${source.index + 1} has no selected value columns.`, parameter: "columns" });
      return [];
    }
    if (orientation === "vertical") {
      const labels = rows.slice(1).map((row) => row[0] ?? "");
      const series = valueIndexes.map((index) => ({
        id: `table-${source.index + 1}-series-${index + 1}`,
        label: rows[0]?.[index] || `Series ${index + 1}`,
        values: rows.slice(1).map((row, rowIndex) => {
          const value = parseLocalizedNumber(row[index] ?? "", policy);
          if (value === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric value replaced with zero in table ${source.index + 1}, row ${rowIndex + 2}, column ${index + 1}.`, row: rowIndex + 2 });
          return value ?? 0;
        }),
      }));
      return [{ labels, series }];
    }
    const labels = valueIndexes.map((index) => rows[0]?.[index] ?? `Category ${index}`);
    const series = rows.slice(1).map((row, rowIndex) => ({
      id: `table-${source.index + 1}-series-${rowIndex + 1}`,
      label: row[0] || `Series ${rowIndex + 1}`,
      values: valueIndexes.map((index) => {
        const value = parseLocalizedNumber(row[index] ?? "", policy);
        if (value === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric value replaced with zero in table ${source.index + 1}, row ${rowIndex + 2}, column ${index + 1}.`, row: rowIndex + 2 });
        return value ?? 0;
      }),
    }));
    return [{ labels, series }];
  });
  if (parsed.length === 0) return undefined;
  const labels = [...parsed[0]!.labels];
  for (const table of parsed.slice(1)) {
    for (const label of table.labels) if (!labels.includes(label)) labels.push(label);
  }
  const series = parsed.flatMap((table) => table.series.map((entry) => ({
    ...entry,
    values: labels.map((label) => {
      const index = table.labels.indexOf(label);
      if (index >= 0) return entry.values[index] ?? 0;
      diagnostics.push({ code: "skipped-row", message: `Series ${entry.label} has no value for category ${label}; zero was used.` });
      return 0;
    }),
  })));
  return series.length > 0 ? { mode: "categories", labels, series } : undefined;
}

function parsePointData(
  sources: readonly ChartSourceTable[],
  params: readonly MacroParameter[],
  policy: ChartParsePolicy,
  orientation: "horizontal" | "vertical",
  dateAxis: boolean,
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "points" }> | undefined {
  const parseX = (raw: string, row: number): number | string | undefined => {
    const value = dateAxis ? parseLocalizedDate(raw, policy) : parseLocalizedNumber(raw, policy);
    if (value === undefined) diagnostics.push({ code: dateAxis ? "locale-parse" : "skipped-row", message: `Invalid ${dateAxis ? "date" : "numeric"} x value skipped in row ${row}.`, row });
    return value;
  };
  const series = sources.flatMap((source) => {
    const { rows } = source;
    if (rows.length < 2 || rows.some((row) => row.length < 2)) {
      diagnostics.push({ code: "malformed-data", message: `XY/time-series chart table ${source.index + 1} needs x/y values.` });
      return [];
    }
    const indexes = selectedColumnIndexes(source, params, diagnostics);
    const valueIndexes = indexes.filter((index) => index !== 0);
    if (orientation === "horizontal") {
      const xValues = valueIndexes.map((index) => ({ raw: rows[0]?.[index] ?? "", value: parseX(rows[0]?.[index] ?? "", 1), index }));
      return rows.slice(1).map((row, rowIndex) => ({
        id: `table-${source.index + 1}-series-${rowIndex + 1}`,
        label: row[0] || `Series ${rowIndex + 1}`,
        points: xValues.flatMap((x) => {
          const y = parseLocalizedNumber(row[x.index] ?? "", policy);
          if (x.value === undefined || y === undefined) {
            if (y === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric point skipped in table ${source.index + 1}, row ${rowIndex + 2}, column ${x.index + 1}.`, row: rowIndex + 2 });
            return [];
          }
          return [{ x: x.value, y, label: x.raw }];
        }),
      })).filter((entry) => entry.points.length > 0);
    }
    const xIndex = indexes.find((index) => /^(x|date|time|start)$/iu.test(rows[0]?.[index] ?? "")) ?? indexes[0] ?? 0;
    const yIndexes = indexes.filter((index) => index !== xIndex);
    return yIndexes.map((index) => ({
      id: `table-${source.index + 1}-series-${index + 1}`,
      label: rows[0]?.[index] || `Series ${index + 1}`,
      points: rows.slice(1).flatMap((row, rowIndex) => {
        const x = parseX(row[xIndex] ?? "", rowIndex + 2);
        const y = parseLocalizedNumber(row[index] ?? "", policy);
        if (x === undefined || y === undefined) {
          if (y === undefined) diagnostics.push({ code: "skipped-row", message: `Non-numeric point skipped in table ${source.index + 1}, row ${rowIndex + 2}.`, row: rowIndex + 2 });
          return [];
        }
        return [{ x, y, label: row[xIndex] ?? "" }];
      }),
    })).filter((entry) => entry.points.length > 0);
  });
  return series.length > 0 ? { mode: "points", series } : undefined;
}

function parseGanttData(
  sources: readonly ChartSourceTable[],
  params: readonly MacroParameter[],
  policy: ChartParsePolicy,
  diagnostics: ChartDiagnosticV1[],
): Extract<ChartDataV1, { mode: "gantt" }> | undefined {
  const unresolved = sources.flatMap((source) => {
    const { rows } = source;
    if (rows.length < 2) return [];
    const selected = new Set(selectedColumnIndexes(source, params, diagnostics));
    const headers = rows[0]!.map((value) => value.toLowerCase());
    const find = (patterns: RegExp[]): number => headers.findIndex((header, index) => selected.has(index) && patterns.some((pattern) => pattern.test(header)));
    const labelIndex = Math.max(0, find([/task|name|activity|plan|actual/u]));
    const startIndex = find([/start|begin/u]);
    const endIndex = find([/end|finish|due/u]);
    if (startIndex < 0 || endIndex < 0) {
      diagnostics.push({ code: "malformed-data", message: `Gantt table ${source.index + 1} needs task, start, and end columns.` });
      return [];
    }
    const progressIndex = find([/progress|status|percent|complete/u]);
    const dependencyIndex = find([/depend|predecessor/u]);
    return rows.slice(1).flatMap((row, rowIndex) => {
      const label = row[labelIndex] ?? `Task ${rowIndex + 1}`;
      const start = parseLocalizedDate(row[startIndex] ?? "", policy);
      const end = parseLocalizedDate(row[endIndex] ?? "", policy);
      if (!label || !start || !end) {
        diagnostics.push({ code: start && end ? "skipped-row" : "locale-parse", message: `Incomplete or invalid Gantt task skipped in table ${source.index + 1}, row ${rowIndex + 2}.`, row: rowIndex + 2 });
        return [];
      }
      const rawProgress = progressIndex >= 0 ? row[progressIndex] ?? "" : "";
      const parsedProgress = rawProgress ? parseLocalizedNumber(rawProgress, policy) : undefined;
      const progress = parsedProgress === undefined ? undefined : Math.min(1, parsedProgress > 1 ? parsedProgress / 100 : parsedProgress);
      return [{
        id: `table-${source.index + 1}-task-${rowIndex + 1}`,
        label,
        start,
        end,
        progress,
        rawDependencies: dependencyIndex >= 0 && row[dependencyIndex]
          ? row[dependencyIndex]!.split(/[,;]/u).map((value) => value.trim()).filter(Boolean)
          : [],
      }];
    });
  });
  if (unresolved.length === 0) return undefined;
  const aliases = new Map<string, string>();
  unresolved.forEach((task, index) => {
    aliases.set(task.id, task.id);
    aliases.set(task.label, task.id);
    aliases.set(String(index + 1), task.id);
  });
  const tasks = unresolved.map(({ rawDependencies, ...task }) => {
    const dependencies = rawDependencies.flatMap((dependency) => {
      const resolved = aliases.get(dependency);
      if (!resolved) {
        diagnostics.push({ code: "invalid-option", message: `Gantt dependency ${dependency} does not identify a selected task.`, parameter: "dependency" });
        return [];
      }
      return [resolved];
    });
    return { ...task, ...(dependencies.length > 0 ? { dependencies } : {}) };
  });
  return { mode: "gantt", tasks };
}

export function normalizeChartMacro(
  params: readonly MacroParameter[],
  body: readonly ExportBlock[],
  source: ChartSourceKindV1,
): ChartMacroNormalizationResult {
  const diagnostics: ChartDiagnosticV1[] = chartParameterDiagnostics(params);
  const kind = chartKind(parameter(params, "type"));
  if (kind === undefined) {
    return {
      diagnostics: [...diagnostics, {
        code: "unsupported-kind",
        message: `Unsupported Confluence Chart macro type: ${parameter(params, "type") ?? "(empty)"}.`,
        parameter: "type",
      }],
    };
  }
  const forgiveParameter = readBooleanParameter(params, "forgive", diagnostics);
  const forgive = forgiveParameter ?? true;
  const language = parameter(params, "language");
  const country = parameter(params, "country");
  const dateFormat = parameter(params, "dateformat");
  const policy: ChartParsePolicy = {
    locale: chartLocale(language, country),
    ...(dateFormat ? { dateFormat } : {}),
    forgive,
  };
  const timeSeriesParameter = readBooleanParameter(params, "timeseries", diagnostics);
  const dateAxis = kind === "timeSeries" || timeSeriesParameter === true;
  const dataOrientation = enumParameter(params, "dataorientation", ["horizontal", "vertical"] as const, diagnostics) ?? "horizontal";
  const tables = selectTables(params, body, diagnostics);
  const attachmentName = parameter(params, "attachment") || params.find((item) => item.refs?.some((ref) => ref.kind === "attachment"))?.refs?.find((ref) => ref.kind === "attachment")?.filename;
  if (tables.length === 0) {
    diagnostics.push({ code: "malformed-data", message: "Chart macro has no table data. Its optional attachment parameter names a generated chart image, not a data source." });
    return { diagnostics };
  }
  let data: ChartDataV1 | undefined;
  if (kind === "gantt") data = parseGanttData(tables, params, policy, diagnostics);
  else if (kind === "xyArea" || kind === "xyBar" || kind === "xyLine" || kind === "xyStep" || kind === "xyStepArea" || kind === "scatter" || kind === "timeSeries") {
    data = parsePointData(tables, params, policy, dataOrientation, dateAxis, diagnostics);
  } else {
    data = parseCategoryData(tables, params, policy, dataOrientation, diagnostics);
  }
  if (!data) return { diagnostics };
  const dimension = (name: "width" | "height"): number => {
    const raw = parameter(params, name);
    if (raw === undefined) return 300;
    const value = parseLocalizedNumber(raw, policy);
    if (value === undefined) {
      diagnostics.push({ code: "invalid-option", message: `Chart parameter ${name} must be numeric.`, parameter: name });
      return 300;
    }
    return Math.round(value);
  };
  const stacked = readBooleanParameter(params, "stacked", diagnostics);
  const threeD = readBooleanParameter(params, "3d", diagnostics);
  const showShapes = readBooleanParameter(params, "showshapes", diagnostics);
  const thumbnail = readBooleanParameter(params, "thumbnail", diagnostics);
  const legend = legendParameter(params, diagnostics);
  const orientation = enumParameter(params, "orientation", ["vertical", "horizontal"] as const, diagnostics);
  const dataDisplay = dataDisplayParameter(params, diagnostics);
  const pieSectionLabelFormat = parameter(params, "piesectionlabel");
  const pieExplode = parameter(params, "piesectionexplode")?.split(",").map((value) => value.trim()).filter(Boolean);
  if (kind === "pie" && pieExplode && data.mode === "categories") {
    for (const key of pieExplode) {
      if (!data.labels.includes(key)) diagnostics.push({ code: "invalid-option", message: `Pie section ${key} cannot be exploded because it is not present in the chart data.`, parameter: "pieSectionExplode" });
    }
  }
  const timePeriod = enumParameter(params, "timeperiod", [
    "millisecond", "second", "minute", "hour", "day", "week", "month", "quarter", "year",
  ] as const, diagnostics) ?? (dateAxis ? "day" : undefined);
  const attachmentVersion = enumParameter(params, "attachmentversion", ["new", "replace", "keep"] as const, diagnostics);
  const renderedImageFormat = enumParameter(params, "imageformat", ["png", "jpg"] as const, diagnostics);
  const opacity = opacityParameter(params, diagnostics);
  const xAxis = parseAxisWithDiagnostics(params, "x", policy, dateAxis, diagnostics);
  const yAxis = parseAxisWithDiagnostics(params, "y", policy, false, diagnostics);
  const backgroundColor = chartColorParameter(params, "bgcolor", diagnostics);
  const borderColor = chartColorParameter(params, "bordercolor", diagnostics);
  const palette = chartPaletteParameter(params, diagnostics);
  const sourceTableDigests = tables.map((table) => table.digest);
  if (kind === "pie" && data.mode === "categories" && data.series.length > 1) {
    diagnostics.push({ code: "invalid-option", message: "A pie chart can display one selected value series; the first series is rendered and all selected series remain in the data table.", parameter: "columns" });
  }
  const model: ChartModelV1 = {
    schema: "atlcli.chart/1",
    kind,
    ...(parameter(params, "title") ? { title: parameter(params, "title") } : {}),
    ...(parameter(params, "subtitle") ? { subtitle: parameter(params, "subtitle") } : {}),
    ...(parameter(params, "xlabel") ? { xLabel: parameter(params, "xlabel") } : {}),
    ...(parameter(params, "ylabel") ? { yLabel: parameter(params, "ylabel") } : {}),
    legend: legend ?? (source === "cloud-adf" ? "top" : "none"),
    orientation: orientation ?? "vertical",
    stacked: stacked ?? false,
    threeD: threeD ?? false,
    showShapes: showShapes ?? true,
    opacity: opacity ?? (threeD === true ? 0.75 : kind === "area" && stacked !== true ? 0.5 : 1),
    display: {
      width: dimension("width"),
      height: dimension("height"),
      data: dataDisplay ?? "hidden",
    },
    style: {
      ...(backgroundColor ? { backgroundColor } : {}),
      ...(borderColor ? { borderColor } : {}),
      ...(palette ? { colors: palette } : {}),
    },
    axes: {
      ...(xAxis ? { x: xAxis } : {}),
      ...(yAxis ? { y: yAxis } : {}),
    },
    locale: {
      ...(language ? { language } : {}),
      ...(country ? { country } : {}),
      ...(dateFormat ? { dateFormat } : {}),
      ...(timePeriod !== undefined ? { timePeriod } : {}),
    },
    ...(kind === "pie" && (pieSectionLabelFormat || pieExplode) ? {
      pie: {
        ...(pieSectionLabelFormat !== undefined ? { sectionLabelFormat: pieSectionLabelFormat } : {}),
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
          version: attachmentVersion ?? "new",
          ...(parameter(params, "attachmentcomment") ? { comment: parameter(params, "attachmentcomment") } : {}),
          thumbnail: thumbnail ?? false,
        },
      } : {}),
      renderedImageFormat: renderedImageFormat ?? "png",
      sourceTableDigests,
      dependencyDigest: fnvDigest(JSON.stringify(sourceTableDigests)),
    },
  };
  if (threeD === true) diagnostics.push({ code: "invalid-option", message: "3D chart perspective is flattened in the source-neutral render model.", parameter: "3d" });
  if (forgive === false && diagnostics.some((diagnostic) => diagnostic.code === "skipped-row" || diagnostic.code === "malformed-data" || diagnostic.code === "locale-parse")) {
    diagnostics.push({ code: "malformed-data", message: "Chart import is strict (forgive=false); no partial chart was published.", parameter: "forgive" });
    return { diagnostics };
  }
  try {
    const normalized = validateChartModelV1(model);
    return { model: normalized, diagnostics };
  } catch (error) {
    diagnostics.push({ code: "invalid-option", message: error instanceof Error ? error.message : "Chart model validation failed." });
    return { diagnostics };
  }
}

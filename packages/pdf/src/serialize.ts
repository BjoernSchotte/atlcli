import type { ExportNote, InlineNode, LinkTarget } from "@atlcli/confluence";
import { escapeTypstContent, safeColor, typstLabel, typstString } from "./escape.js";
import { resolvePdfSettings, typstSettingsDict } from "./settings.js";
import { createAtlcliTypstTemplate } from "./template.js";
import {
  pdfColorContrast,
  pdfTableCellForeground,
  preservePdfSourceCellColor,
  resolvePdfTheme,
} from "./theme.js";
import type {
  PdfSerializeOptions,
  PdfSourceBundle,
  PdfSourceMapEntry,
  PdfTheme,
  PreparedPdfAsset,
  PreparedPdfBlock,
  PreparedPdfDocument,
} from "./types.js";

function inlinePlainText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "link":
          return inlinePlainText(node.content);
        case "mention":
          return `@${node.displayName ?? node.accountId}`;
        case "status":
          return node.text;
        case "lineBreak":
          return " ";
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    })
    .join("");
}

/**
 * Emit user-controlled text as a string value, never as Typst markup.
 *
 * Escaping markup metacharacters is not sufficient here: punctuation,
 * non-breaking whitespace and future Typst syntax can still become meaningful
 * when content is nested inside function arguments. A string passed to
 * `text(...)` remains literal in every surrounding list/table context.
 */
function literalText(value: string): string {
  return `#text(${typstString(value)})`;
}

type PreparedTableRow = Extract<PreparedPdfBlock, { type: "table" }>["rows"][number];
type PreparedTableCell = PreparedTableRow["cells"][number];

interface PositionedTableCell {
  cell: PreparedTableCell;
  cellIndex: number;
  columnIndex: number;
}

interface TableGrid {
  columnCount: number;
  rows: PositionedTableCell[][];
  requiresExplicitPlacement: boolean;
}

/**
 * Lay out the HTML-style cell grid before emitting Typst.
 *
 * Summing each row's colspans is insufficient when a rowspan from an earlier
 * row still occupies columns. Typst also receives a flat cell stream, so tables
 * with merged or incomplete rows need explicit coordinates to preserve source
 * row boundaries.
 */
function tableGrid(rows: PreparedTableRow[], sourceWidths?: number[]): TableGrid {
  const occupiedUntilRow: number[] = [];
  const positionedRows: PositionedTableCell[][] = [];
  let columnCount = sourceWidths?.length ?? 0;
  let hasMergedCells = false;

  rows.forEach((row, rowIndex) => {
    let cursor = 0;
    const positioned = row.cells.map((cell, cellIndex) => {
      const colspan = Math.max(1, cell.colspan);
      const rowspan = Math.max(1, cell.rowspan);
      hasMergedCells ||= colspan > 1 || rowspan > 1;

      while (true) {
        while ((occupiedUntilRow[cursor] ?? 0) > rowIndex) cursor += 1;
        const blockedOffset = Array.from({ length: colspan }, (_, offset) => offset)
          .find((offset) => (occupiedUntilRow[cursor + offset] ?? 0) > rowIndex);
        if (blockedOffset === undefined) break;
        cursor += blockedOffset + 1;
      }

      const columnIndex = cursor;
      const occupiedUntil = rowIndex + rowspan;
      for (let offset = 0; offset < colspan; offset += 1) {
        const column = columnIndex + offset;
        occupiedUntilRow[column] = Math.max(occupiedUntilRow[column] ?? 0, occupiedUntil);
      }
      cursor += colspan;
      columnCount = Math.max(columnCount, cursor);
      return { cell, cellIndex, columnIndex };
    });
    positionedRows.push(positioned);
  });

  const incompleteRows = positionedRows.some((row) => {
    const last = row.at(-1);
    return !last || last.columnIndex + Math.max(1, last.cell.colspan) < columnCount;
  });
  return {
    columnCount: Math.max(1, columnCount),
    rows: positionedRows,
    requiresExplicitPlacement: hasMergedCells || incompleteRows,
  };
}

function blocksPlainText(blocks: PreparedPdfBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return inlinePlainText(block.content);
        case "codeBlock":
          return block.code;
        case "callout":
        case "blockquote":
        case "orientation":
          return blocksPlainText(block.content);
        case "list":
          return block.items.map((item) => blocksPlainText(item.content)).join(" ");
        case "table":
          return block.rows
            .flatMap((row) => row.cells.map((cell) => blocksPlainText(cell.content)))
            .join(" ");
        case "image":
          return block.alt ?? block.fallbackLabel;
        case "diagram":
          return block.alt ?? "Diagram";
        case "divider":
          return "";
        case "unknown":
          return block.macroName;
        case "pageBreak":
        case "anchor":
          return "";
        default: {
          const exhaustive: never = block;
          return exhaustive;
        }
      }
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Give a narrative column more room in status/RACI-style matrices when the
 * source contains only default equal tracks. Explicit unequal author widths
 * always win. The conservative thresholds avoid reshaping prose-heavy tables.
 */
function inferredTableTracks(columnCount: number, rows: PreparedTableRow[]): number[] | undefined {
  if (columnCount < 3 || columnCount > 8) return undefined;
  const bodyRows = rows.filter((row) => row.cells.some((cell) => !cell.header));
  if (
    bodyRows.length < 2 ||
    bodyRows.some(
      (row) =>
        row.cells.length !== columnCount ||
        row.cells.some((cell) => cell.colspan !== 1 || cell.rowspan !== 1)
    )
  ) return undefined;

  const averageLengths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const total = bodyRows.reduce(
      (sum, row) => sum + blocksPlainText(row.cells[columnIndex]!.content).length,
      0
    );
    return total / bodyRows.length;
  });
  const ranked = averageLengths
    .map((length, index) => ({ index, length }))
    .sort((left, right) => right.length - left.length);
  const dominant = ranked[0]!;
  const runnerUp = ranked[1]!;
  const otherAverage = ranked.slice(1).reduce((sum, item) => sum + item.length, 0) / (columnCount - 1);

  if (
    dominant.length < 18 ||
    dominant.length < runnerUp.length * 1.8 ||
    dominant.length < otherAverage * 2.4 ||
    otherAverage > 24
  ) return undefined;

  return Array.from({ length: columnCount }, (_, index) => index === dominant.index ? 2 : 1);
}

function tableColumns(
  columnCount: number,
  sourceWidths: number[] | undefined,
  rows: PreparedTableRow[]
): string {
  const validSourceWidths =
    sourceWidths?.length === columnCount &&
    sourceWidths.every((width) => Number.isFinite(width) && width > 0)
      ? sourceWidths
      : undefined;
  const sourceSpread = validSourceWidths
    ? Math.max(...validSourceWidths) / Math.min(...validSourceWidths)
    : 1;
  const selectedWidths = validSourceWidths && sourceSpread > 1.05
    ? validSourceWidths
    : inferredTableTracks(columnCount, rows);
  if (!selectedWidths) {
    return `(${Array.from({ length: columnCount }, () => "1fr").join(", ")},)`;
  }
  const total = selectedWidths.reduce((sum, width) => sum + width, 0);
  const tracks = selectedWidths.map((width) => {
    const ratio = width / total;
    return `${Number(ratio.toFixed(6))}fr`;
  });
  return `(${tracks.join(", ")},)`;
}

function resolveLink(target: LinkTarget, labels: Map<string, string>): string | null {
  switch (target.kind) {
    case "external":
      return /^(https?:|mailto:)/i.test(target.href) ? target.href : null;
    case "anchor":
      return labels.get(target.anchor) ? `<${labels.get(target.anchor)}>` : null;
    case "page":
      return null;
    case "attachment":
      return null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

type TableDensity = "normal" | "dense";

interface RenderContext {
  tableDensity: TableDensity;
  inTable?: boolean;
  availableWidth?: string;
  coloredCell?: {
    background: string;
    foreground: string;
    theme: PdfTheme;
  };
}

const NORMAL_RENDER_CONTEXT: RenderContext = { tableDensity: "normal" };
const DENSE_TABLE_COLUMN_THRESHOLD = 9;
const DENSE_BREAK_OPPORTUNITY = "\u200B";
const DENSE_ATOMIC_RUN_LENGTH = 4;
const DENSE_STATUS_RUN_LENGTH = 2;

const CONFLUENCE_STATUS_COLORS: Readonly<Record<string, string>> = {
  grey: "#42526E",
  gray: "#42526E",
  red: "#DE350B",
  yellow: "#FF991F",
  green: "#00875A",
  blue: "#0052CC",
};

function denseAtomicToken(value: string, runLength = DENSE_ATOMIC_RUN_LENGTH): string {
  return value
    .replace(/([/.\-_?&=:#@,;])/g, `$1${DENSE_BREAK_OPPORTUNITY}`)
    .replace(
      new RegExp(
        `([\\p{L}\\p{N}\\p{M}]{${runLength}})(?=[\\p{L}\\p{N}\\p{M}])`,
        "gu"
      ),
      `$1${DENSE_BREAK_OPPORTUNITY}`
    );
}

function denseStatusLabel(value: string): string {
  return value.replace(/\S+/gu, (token) => denseAtomicToken(token, DENSE_STATUS_RUN_LENGTH));
}

function statusColor(value: string | undefined): string {
  const semantic = value?.trim().toLowerCase();
  return (semantic && CONFLUENCE_STATUS_COLORS[semantic]) ?? safeColor(value);
}

function denseHostLabel(value: string): string {
  return denseAtomicToken(value);
}

function plainUnmarkedText(nodes: InlineNode[]): string | null {
  if (nodes.length !== 1) return null;
  const [node] = nodes;
  if (node?.type !== "text" || node.color || (node.marks?.length ?? 0) > 0) return null;
  return node.text;
}

function normalizedHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

interface DenseUrlLabels {
  compact: string;
  host: string;
}

function denseRawUrlLabels(href: string, label: string): DenseUrlLabels | null {
  const target = normalizedHttpUrl(href);
  const visible = normalizedHttpUrl(label);
  if (!target || !visible || target.href !== visible.href) return null;

  const hasDetails = target.pathname !== "/" || Boolean(target.search || target.hash);
  return {
    compact: hasDetails ? `${target.hostname}/…` : target.hostname,
    host: denseHostLabel(target.hostname),
  };
}

type TextInlineNode = Extract<InlineNode, { type: "text" }>;

function effectiveCellTextColor(sourceColor: string | undefined, context: RenderContext): string | undefined {
  const cell = context.coloredCell;
  if (!cell) return sourceColor ? safeColor(sourceColor) : undefined;
  return preservePdfSourceCellColor(sourceColor, cell.background, cell.theme) ?? cell.foreground;
}

function styledText(value: string, node: TextInlineNode, context: RenderContext): string {
  let out = literalText(value);
  for (const mark of node.marks ?? []) {
    switch (mark) {
      case "bold":
        out = `#strong[${out}]`;
        break;
      case "italic":
        out = `#emph[${out}]`;
        break;
      case "underline":
        out = `#underline[${out}]`;
        break;
      case "strike":
        out = `#strike[${out}]`;
        break;
      case "code":
        out = `#raw(${typstString(value)})`;
        break;
      case "subscript":
        out = `#sub[${out}]`;
        break;
      case "superscript":
        out = `#super[${out}]`;
        break;
      default: {
        const exhaustive: never = mark;
        out = exhaustive;
      }
    }
  }
  const color = effectiveCellTextColor(node.color, context);
  if (color) out = `#text(fill: rgb(${typstString(color)}))[${out}]`;
  return out;
}

function serializeText(node: TextInlineNode, context: RenderContext): string {
  if (!context.availableWidth) return styledText(node.text, node, context);
  const segments = node.text.match(/\s+|\S+/gu);
  if (!segments) return styledText(node.text, node, context);
  return segments.map((segment) => {
    const normal = styledText(segment, node, context);
    if (/^\s+$/u.test(segment)) return normal;
    const breakable = denseAtomicToken(segment);
    if (breakable === segment) return normal;
    return `#dense-token(${context.availableWidth}, [${normal}], [${styledText(breakable, node, context)}])`;
  }).join("");
}

function serializeMention(
  node: Extract<InlineNode, { type: "mention" }>,
  context: RenderContext
): string {
  const label = node.displayName ?? node.accountId;
  const color = effectiveCellTextColor("#0747A6", context) ?? "#0747A6";
  if (!context.availableWidth) {
    return `#text(fill: rgb(${typstString(color)}))[${literalText(`@${label}`)}]`;
  }

  const segments = label.match(/\s+|\S+/gu) ?? [label];
  const content = `${literalText(`@${DENSE_BREAK_OPPORTUNITY}`)}${segments.map((segment) => {
    const normal = literalText(segment);
    if (/^\s+$/u.test(segment)) return normal;
    const breakable = denseAtomicToken(segment);
    if (breakable === segment) return normal;
    return `#dense-token(${context.availableWidth}, [${normal}], [${literalText(breakable)}])`;
  }).join("")}`;

  return `#text(fill: rgb(${typstString(color)}))[${content}]`;
}

function serializeInline(
  nodes: InlineNode[],
  labels: Map<string, string>,
  notes: ExportNote[],
  context: RenderContext = NORMAL_RENDER_CONTEXT
): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text": {
          return serializeText(node, context);
        }
        case "lineBreak":
          return "#linebreak()";
        case "mention": {
          return serializeMention(node, context);
        }
        case "status": {
          const label = node.text || node.color;
          const color = statusColor(node.color);
          if (context.availableWidth) {
            return `#dense-status-badge(${context.availableWidth}, ${typstString(label)}, ${typstString(denseStatusLabel(label))}, color: ${typstString(color)})`;
          }
          return `#status-badge(${typstString(label)}, color: ${typstString(color)})`;
        }
        case "link": {
          const content = serializeInline(node.content, labels, notes, context);
          const href = resolveLink(node.target, labels);
          if (!href) {
            notes.push({
              level: "info",
              code: "pdf-link-unresolved",
              message: `Link target could not be represented in PDF: ${inlinePlainText(node.content) || "link"}`,
            });
            return content;
          }
          if (href.startsWith("<")) return `#link(${href})[${content}]`;
          if (context.availableWidth) {
            const label = plainUnmarkedText(node.content);
            const denseLabels = label === null ? null : denseRawUrlLabels(href, label);
            if (denseLabels !== null) {
              return `#dense-link(${context.availableWidth}, ${typstString(href)}, ${typstString(label!)}, ${typstString(denseLabels.compact)}, ${typstString(denseLabels.host)})`;
            }
          }
          return `#link(${typstString(href)})[${content}]`;
        }
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    })
    .join("");
}

function minHeadingLevel(blocks: PreparedPdfBlock[]): number {
  let min = Infinity;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        min = Math.min(min, block.level);
        break;
      case "callout":
      case "blockquote":
      case "orientation":
        min = Math.min(min, minHeadingLevel(block.content));
        break;
      case "list":
        for (const item of block.items) min = Math.min(min, minHeadingLevel(item.content));
        break;
      case "table":
        for (const row of block.rows) {
          for (const cell of row.cells) min = Math.min(min, minHeadingLevel(cell.content));
        }
        break;
    }
  }
  return min;
}

function collectHeadingLabels(blocks: PreparedPdfBlock[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  const walk = (list: PreparedPdfBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading": {
          const text = inlinePlainText(block.content);
          const base = typstLabel(text);
          const count = (counts.get(base) ?? 0) + 1;
          counts.set(base, count);
          const label = count === 1 ? base : `${base}-${count}`;
          if (!labels.has(text)) labels.set(text, label);
          break;
        }
        case "callout":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return labels;
}

interface Writer {
  sourceMap: PdfSourceMapEntry[];
  notes: ExportNote[];
  labels: Map<string, string>;
  headingOffset: number;
  headingCounts: Map<string, number>;
  theme: PdfTheme;
  contrastWarnings: Set<string>;
}

function noteLowCellContrast(
  writer: Writer,
  background: string,
  foreground: string
): void {
  const minimum = writer.theme.table.coloredCellText.minimumContrast;
  const ratio = pdfColorContrast(background, foreground);
  if (ratio >= minimum) return;
  const key = `${background}:${foreground}:${minimum}`;
  if (writer.contrastWarnings.has(key)) return;
  writer.contrastWarnings.add(key);
  writer.notes.push({
    level: "warning",
    code: "pdf-table-cell-contrast-low",
    message: `PDF theme table-cell colors ${foreground} on ${background} have contrast ${ratio.toFixed(2)}:1, below the configured ${minimum.toFixed(2)}:1 target.`,
  });
}

function serializeParagraphInline(
  content: InlineNode[],
  writer: Writer,
  context: RenderContext,
  wrapInParagraph: boolean
): string {
  if (context.inTable) {
    const availableWidth = "available-width";
    const inline = serializeInline(content, writer.labels, writer.notes, {
      ...context,
      availableWidth,
    });
    const body = wrapInParagraph ? `#par[${inline}]` : inline;
    return `#table-par(${availableWidth} => [${body}])`;
  }
  const inline = serializeInline(content, writer.labels, writer.notes, context);
  return wrapInParagraph ? `#par[${inline}]` : inline;
}

function serializeBlocks(
  blocks: PreparedPdfBlock[],
  writer: Writer,
  parentPath = "blocks",
  context: RenderContext = NORMAL_RENDER_CONTEXT
): string {
  return blocks
    .map((block, index) => serializeBlock(block, writer, `${parentPath}[${index}]`, context))
    .join("\n");
}

function writeMapped(block: PreparedPdfBlock, writer: Writer, path: string, value: string, summary?: string): string {
  writer.sourceMap.push({
    blockPath: path,
    blockType: block.type,
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 0,
    summary,
  });
  return `/* atlcli:start:${path} */${value}/* atlcli:end:${path} */`;
}

function resolveSourceMap(main: string, entries: PdfSourceMapEntry[]): PdfSourceMapEntry[] {
  const byPath = new Map(entries.map((entry) => [entry.blockPath, { ...entry }]));
  const lineStarts = [0];
  for (let index = 0; index < main.length; index += 1) {
    if (main[index] === "\n") lineStarts.push(index + 1);
  }
  const positionAt = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle + 1;
      else high = middle - 1;
    }
    const lineIndex = Math.max(0, high);
    return { line: lineIndex + 1, column: offset - lineStarts[lineIndex]! + 1 };
  };
  const stack: Array<{ path: string; startLine: number; startColumn: number }> = [];
  const marker = /\/\* atlcli:(start|end):([^*]+) \*\//g;
  for (const match of main.matchAll(marker)) {
    const action = match[1];
    const path = match[2]!;
    if (action === "start") {
      const start = positionAt(match.index! + match[0].length);
      stack.push({ path, startLine: start.line, startColumn: start.column });
      continue;
    }
    let openIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]?.path === path) {
        openIndex = index;
        break;
      }
    }
    if (openIndex < 0) continue;
    const [open] = stack.splice(openIndex, 1);
    const entry = byPath.get(path);
    if (entry) {
      const end = positionAt(match.index!);
      entry.startLine = open!.startLine;
      entry.startColumn = open!.startColumn;
      entry.endLine = Math.max(open!.startLine, end.line);
      entry.endColumn = end.column;
    }
  }
  return entries.map((entry) => byPath.get(entry.blockPath) ?? entry);
}

function serializeBlock(
  block: PreparedPdfBlock,
  writer: Writer,
  path: string,
  context: RenderContext
): string {
  let value: string;
  let summary: string | undefined;
  switch (block.type) {
    case "heading": {
      summary = inlinePlainText(block.content);
      const base = typstLabel(summary);
      const count = (writer.headingCounts.get(base) ?? 0) + 1;
      writer.headingCounts.set(base, count);
      const label = count === 1 ? base : `${base}-${count}`;
      const level = Math.max(1, Math.min(6, block.level - writer.headingOffset));
      const heading = (content: string): string => `#heading(level: ${level}, outlined: true)[${content}]`;
      if (context.inTable) {
        const availableWidth = "available-width";
        const content = serializeInline(block.content, writer.labels, writer.notes, {
          ...context,
          availableWidth,
        });
        value = `#table-par(${availableWidth} => [${heading(content)}]) <${label}>`;
      } else {
        value = `${heading(serializeInline(block.content, writer.labels, writer.notes, context))} <${label}>`;
      }
      break;
    }
    case "paragraph":
      value = serializeParagraphInline(block.content, writer, context, true);
      break;
    case "codeBlock":
      value = `#raw(${typstString(block.code)}, lang: ${typstString(block.language ?? "text")}, block: true)`;
      break;
    case "diagram":
      // Keep exported content in source order. `placement: auto` turns figures
      // into top/bottom floats, which can move a diagram before its heading or
      // collect multiple headings away from their diagrams in real documents.
      value = `#figure(image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? "Diagram")}))`;
      break;
    case "image":
      if (!block.assetPath) {
        value = `#par[#emph[${literalText(`[Image unavailable: ${block.fallbackLabel}]`)}]]`;
      } else {
        if (!block.alt) {
          writer.notes.push({
            level: "warning",
            code: "pdf-image-alt-fallback",
            message: `${block.fallbackLabel} uses a technical filename fallback for alternative text.`,
          });
        }
        value = `#figure(image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? block.fallbackLabel)}))`;
      }
      break;
    case "callout": {
      const title = block.title ? `[${literalText(block.title)}]` : "none";
      value = `#callout(kind: ${typstString(block.kind)}, title: ${title})[\n${serializeBlocks(block.content, writer, `${path}.content`, context)}\n]`;
      break;
    }
    case "blockquote":
      value = `#quote(block: true)[\n${serializeBlocks(block.content, writer, `${path}.content`, context)}\n]`;
      break;
    case "list": {
      const fn = block.ordered ? "enum" : "list";
      const isTaskList = !block.ordered && block.items.some((item) => item.checked !== undefined);
      const items = block.items.map((item, index) => {
        const itemPath = `${path}.items[${index}].content`;
        const [first, ...rest] = item.content;
        let content: string;
        if (first?.type === "paragraph") {
          const inline = writeMapped(
            first,
            writer,
            `${itemPath}[0]`,
            serializeParagraphInline(first.content, writer, context, false)
          );
          const tail = rest.length > 0 ? serializeBlocks(rest, writer, itemPath, context) : "";
          content = `${inline}${tail}`;
        } else {
          content = serializeBlocks(item.content, writer, itemPath, context);
        }
        if (!isTaskList) return `[${content}]`;
        const checked = item.checked === true ? "true" : "false";
        return `[#task-item(${checked})[${content}]]`;
      });
      const options = isTaskList ? "marker: none, body-indent: 0pt, " : "";
      value = `#${fn}(${options}\n${items.join(",\n")}\n)`;
      break;
    }
    case "table": {
      const grid = tableGrid(block.rows, block.columnWidths);
      const { columnCount } = grid;
      const isDense = columnCount >= DENSE_TABLE_COLUMN_THRESHOLD;
      const cellContext: RenderContext = {
        tableDensity: isDense ? "dense" : "normal",
        inTable: true,
      };
      const columns = tableColumns(columnCount, block.columnWidths, block.rows);
      const serializedRows = grid.rows.map((row, rowIndex) => {
        const cells = row.map(({ cell, cellIndex, columnIndex }) => {
          const backgroundColor = cell.backgroundColor ?? (cell.header ? "#F4F5F7" : undefined);
          const foregroundColor = cell.backgroundColor
            ? pdfTableCellForeground(cell.backgroundColor, writer.theme)
            : undefined;
          if (cell.backgroundColor && foregroundColor) {
            noteLowCellContrast(writer, cell.backgroundColor, foregroundColor);
          }
          const args = [
            grid.requiresExplicitPlacement ? `x: ${columnIndex}` : "",
            grid.requiresExplicitPlacement ? `y: ${rowIndex}` : "",
            cell.colspan > 1 ? `colspan: ${cell.colspan}` : "",
            cell.rowspan > 1 ? `rowspan: ${cell.rowspan}` : "",
            backgroundColor ? `fill: rgb(${typstString(backgroundColor)})` : "",
          ].filter(Boolean);
          const content = serializeBlocks(
            cell.content,
            writer,
            `${path}.rows[${rowIndex}].cells[${cellIndex}].content`,
            foregroundColor && cell.backgroundColor
              ? {
                  ...cellContext,
                  coloredCell: {
                    background: cell.backgroundColor,
                    foreground: foregroundColor,
                    theme: writer.theme,
                  },
                }
              : cellContext
          );
          const styledContent = foregroundColor
            ? `#set text(fill: rgb(${typstString(foregroundColor)}))\n${content}`
            : content;
          return `table.cell(${args.length ? `${args.join(", ")}, ` : ""}[${styledContent}])`;
        });
        return {
          cells,
          isHeader: row.length > 0 && row.every(({ cell }) => cell.header),
        };
      });
      const firstBodyRow = serializedRows.findIndex((row) => !row.isHeader);
      const leadingHeaderCount = firstBodyRow === -1 ? serializedRows.length : firstBodyRow;
      const rows: string[] = [];
      if (leadingHeaderCount > 0) {
        const headerCells = serializedRows
          .slice(0, leadingHeaderCount)
          .flatMap((row) => row.cells);
        rows.push(`table.header(${headerCells.join(", ")})`);
      }
      rows.push(...serializedRows.slice(leadingHeaderCount).map((row) => row.cells.join(", ")));
      const horizontalInset = isDense ? 2 : 6;
      value = `#block(width: 100%)[\n#table(columns: ${columns}, inset: (x: ${horizontalInset}pt, y: 7pt), stroke: rgb(\"#DFE1E6\"),\n${rows.join(",\n")}\n)\n]`;
      break;
    }
    case "divider":
      value = `#line(length: 100%, stroke: rgb(\"#DFE1E6\"))`;
      break;
    case "unknown":
      writer.notes.push({
        level: "warning",
        code: "pdf-unknown-block",
        message: `Unsupported ${block.macroName} macro was omitted from the PDF.`,
        macroName: block.macroName,
      });
      value = "";
      break;
    // No-op renderings (T0.2): the walker never emits these yet; real rendering
    // lands in T1.5. `writeMapped` still wraps them (source-map precedent).
    case "pageBreak":
      value = "";
      break;
    case "anchor":
      value = "";
      break;
    case "orientation":
      // Transparent — no `#set page(flipped:)` yet (T1.5); children serialize
      // exactly as if the region wrapper were absent, so nothing is lost.
      value = serializeBlocks(block.content, writer, `${path}.content`, context);
      break;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
  return writeMapped(block, writer, path, value, summary);
}

function typstDate(date: Date): string {
  return `datetime(year: ${date.getUTCFullYear()}, month: ${date.getUTCMonth() + 1}, day: ${date.getUTCDate()})`;
}

function exportedDateLabel(date: Date, language?: string, region?: string): string {
  const locale = [language, region].filter(Boolean).join("-") || "en";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function serializePdfDocument(
  document: PreparedPdfDocument,
  options: PdfSerializeOptions
): PdfSourceBundle {
  const theme = resolvePdfTheme(options.theme);
  const labels = collectHeadingLabels(document.blocks);
  const min = minHeadingLevel(document.blocks);
  const writer: Writer = {
    sourceMap: [],
    notes: [...document.notes],
    labels,
    headingOffset: min === Infinity ? 0 : min - 1,
    headingCounts: new Map(),
    theme,
    contrastWarnings: new Set(),
  };
  const body = serializeBlocks(document.blocks, writer);
  const settings = resolvePdfSettings(options.settings);
  // The validated logo travels as a virtual asset file the compiler maps into
  // its filesystem — the same path-emission pattern prepared image assets use.
  // The "atlcli-logo" name cannot collide with prepared assets, whose paths
  // always carry a numeric index and content hash.
  const logoAsset: PreparedPdfAsset | undefined = settings.logo
    ? {
        path: settings.logo.mediaType === "image/png" ? "assets/atlcli-logo.png" : "assets/atlcli-logo.svg",
        bytes: settings.logo.bytes,
        mediaType: settings.logo.mediaType,
      }
    : undefined;
  const meta = options.metadata;
  const author = meta.author ?? meta.exporter ?? "atlcli";
  const exportedLabel = exportedDateLabel(meta.exportedAt, meta.language, meta.region);
  const main = String.raw`#import "atlcli.typ": atlcli-doc, callout, status-badge, table-par, dense-token, dense-link, dense-status-badge, task-item

#show: atlcli-doc.with(meta: (
  title: ${typstString(meta.title)},
  space: ${typstString(meta.space ?? "Confluence")},
  version: ${typstString(meta.version === undefined ? "—" : `v${meta.version}`)},
  author: ${typstString(author)},
  exporter: ${typstString(meta.exporter ?? author)},
  language: ${typstString(meta.language ?? "en")},
  region: ${meta.region ? typstString(meta.region) : "none"},
  exported-at: ${typstDate(meta.exportedAt)},
  exported-label: ${typstString(exportedLabel)},
), settings: ${typstSettingsDict(settings, { logoPath: logoAsset?.path })})

${body}
`;

  return {
    main,
    template: createAtlcliTypstTemplate(options.theme),
    assets: logoAsset ? [...document.assets, logoAsset] : document.assets,
    sourceMap: resolveSourceMap(main, writer.sourceMap),
    notes: writer.notes,
  };
}

export function mapPdfDiagnostics(
  diagnostics: Array<{
    severity?: string;
    message: string;
    path?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  }>,
  sourceMap: PdfSourceMapEntry[]
): Array<{
  severity: "error" | "warning";
  message: string;
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  blockPath?: string;
}> {
  return diagnostics.map((diagnostic) => {
    const line = diagnostic.line;
    const column = diagnostic.column;
    const mapped =
      diagnostic.path?.replace(/^\/+/, "") === "main.typ" && line !== undefined
        ? sourceMap
            .filter((entry) => {
              if (line < entry.startLine || line > entry.endLine) return false;
              if (column === undefined) return true;
              if (line === entry.startLine && column < entry.startColumn) return false;
              if (line === entry.endLine && column > entry.endColumn) return false;
              return true;
            })
            .sort(
              (left, right) =>
                left.endLine - left.startLine - (right.endLine - right.startLine) ||
                left.endColumn - left.startColumn - (right.endColumn - right.startColumn)
            )[0]
        : undefined;
    return {
      severity: diagnostic.severity === "warning" ? "warning" : "error",
      message: diagnostic.message,
      path: diagnostic.path,
      startLine: line,
      startColumn: column,
      endLine: diagnostic.endLine,
      endColumn: diagnostic.endColumn,
      blockPath: mapped?.blockPath,
    };
  });
}

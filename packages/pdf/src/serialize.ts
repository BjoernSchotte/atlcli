import type {
  BlockPresentation,
  Caption,
  CaptionKind,
  ExportNote,
  InlineNode,
  LinkTarget,
  TablePresentation,
} from "@atlcli/confluence";
import {
  UNSAFE_LINK_NOTE_CODE,
  computeHeadingOffset,
  formatAdfDateTimestamp,
  isSafeLinkScheme,
  statusDisplayText,
  uniqueAnchorId,
} from "@atlcli/confluence";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
import { escapeTypstContent, safeColor, typstLabel, typstString } from "./escape.js";
import { resolvePdfSettings, typstSettingsDict, type ResolvedPdfDesign } from "./settings.js";
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
        case "date":
          return formatAdfDateTimestamp(node.timestamp);
        case "status":
          return statusDisplayText(node);
        case "placeholder":
          return "";
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
        case "expand":
        case "blockquote":
        case "orientation":
          return blocksPlainText(block.content);
        case "list":
          return block.items.map((item) => blocksPlainText(item.content)).join(" ");
        case "layout":
          return block.columns.map((column) => blocksPlainText(column.content)).join(" ");
        case "table":
          return block.rows
            .flatMap((row) => row.cells.map((cell) => blocksPlainText(cell.content)))
            .join(" ");
        case "image":
          return block.alt ?? block.fallbackLabel;
        case "mediaFallback":
          return block.alt ?? block.label;
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

function tableWidthPt(
  presentation: TablePresentation | undefined,
  availableWidthPt: number,
): number | undefined {
  const width = presentation?.width;
  if (width === undefined || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.max(0.75, Math.min(availableWidthPt, width * 0.75));
}

function tableAlignment(presentation: TablePresentation | undefined): "start" | "center" | "end" | undefined {
  switch (presentation?.layout) {
    case "align-start":
      return "start";
    case "align-end":
      return "end";
    case "default":
    case "wide":
    case "full-width":
    case "center":
      return "center";
    default:
      return presentation?.width !== undefined ? "center" : undefined;
  }
}

function resolveLink(target: LinkTarget, labels: Map<string, string>): string | null {
  switch (target.kind) {
    case "external":
      // Shared scheme policy (spec 011): this used to be a third, independent
      // `/^(https?:|mailto:)/i` test that disagreed with the DOCX and walker
      // checks (it never stripped control characters). It now delegates, so the
      // two engines cannot drift. PDF additionally requires an ABSOLUTE target
      // — a relative href the policy allows has no base URL to resolve against
      // in a standalone document, so it degrades to `pdf-link-unresolved`.
      if (!isSafeLinkScheme(target.href)) return null;
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

/** The layout container the current block renders inside (spec 003 C5/C6). */
type RenderContainer = "body" | "tableCell" | "calloutCell";

interface RenderContext {
  tableDensity: TableDensity;
  inTable?: boolean;
  availableWidth?: string;
  coloredCell?: {
    background: string;
    foreground: string;
    theme: PdfTheme;
  };
  /**
   * The layout container (spec 003). `pageBreak`/`orientation` render in
   * `"body"`/`"list"` but are suppressed (children kept, note emitted) inside
   * `"tableCell"`/`"calloutCell"`, where a Typst `set page` / `pagebreak` has no
   * effect inside a `table.cell`/`callout` box.
   */
  container?: RenderContainer;
  /**
   * Usable text width in pt for wide-table classification (spec 003 T1.6). A
   * landscape orientation region widens this so `classifyTableLayout` escalates
   * against the landscape text area, not the portrait one. Undefined → portrait.
   */
  layoutWidthPt?: number;
  /**
   * The ACTIVE template design (spec 012). Serializer-emitted presentation
   * (table stroke/header fill, mention ink, placeholder ink, cell insets, the
   * status palette) reads from here, so a second curated template's tokens
   * genuinely apply instead of silently rendering the built-in's.
   */
  design: ResolvedPdfDesign;
  /** BCP-47 locale for semantic inline dates. */
  locale: string;
}

/** The root render context for a document rendered with `design`. */
function rootContext(design: ResolvedPdfDesign, locale = "en"): RenderContext {
  return { tableDensity: "normal", design, locale };
}
const DENSE_TABLE_COLUMN_THRESHOLD = 9;

// ---- Wide-table layout classification (spec 003 T1.6) ---------------------

/** Escalation tiers for a table that may not fit its available width. */
export type TableLayoutClass = "normal" | "dense" | "scaled" | "overflow-warned";

/** Usable text width (pt) of the built-in A4 template, portrait / landscape. */
const PORTRAIT_TEXT_WIDTH_PT = 470;
const LANDSCAPE_TEXT_WIDTH_PT = 717;
/** Table cell font size (pt) at normal and the practical readability floor. */
const TABLE_FONT_SIZE_PT = 9;
const MIN_TABLE_FONT_SIZE_PT = 7;
/** Horizontal cell inset (pt) at normal vs. dense density. */
const NORMAL_CELL_INSET_PT = 6;
const DENSE_CELL_INSET_PT = 2;
/** Approximate rendered width of one character as a fraction of the font size. */
const CHAR_WIDTH_RATIO = 0.55;

/** Estimated rendered width (pt) of an atomic token at a given font size. */
function estimateTokenWidthPt(tokenLength: number, fontSizePt: number): number {
  return tokenLength * fontSizePt * CHAR_WIDTH_RATIO;
}

/**
 * Classify a table's fit deterministically into the dense → scaled →
 * overflow-warned escalation (spec 003 T1.6). Pure over validated numeric
 * inputs so it is unit-testable without the Typst compiler:
 *
 * - `"normal"` / `"dense"` — the longest atomic token fits the narrowest track
 *   at the (dense) inset; `"dense"` iff the column count crosses the existing
 *   {@link DENSE_TABLE_COLUMN_THRESHOLD} boundary.
 * - `"scaled"` — the token overflows at normal size but fits once body text is
 *   scaled down to {@link MIN_TABLE_FONT_SIZE_PT}.
 * - `"overflow-warned"` — even minimum-size text cannot fit; render at the
 *   minimum size anyway (accept wrap/clip over losing content) and warn.
 */
export function classifyTableLayout(input: {
  columnCount: number;
  sourceWidths?: number[];
  longestAtomicToken: number;
  availableWidth: number;
}): TableLayoutClass {
  const columnCount = Math.max(1, Math.floor(input.columnCount));
  const available = Number.isFinite(input.availableWidth) && input.availableWidth > 0
    ? input.availableWidth
    : PORTRAIT_TEXT_WIDTH_PT;
  const tokenLength = Math.max(0, Math.floor(input.longestAtomicToken));
  const dense = columnCount >= DENSE_TABLE_COLUMN_THRESHOLD;

  // Narrowest track width: the minimum column's share of the available width.
  const widths = input.sourceWidths?.length === columnCount
    && input.sourceWidths.every((w) => Number.isFinite(w) && w > 0)
    ? input.sourceWidths
    : Array.from({ length: columnCount }, () => 1);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const narrowestRatio = Math.min(...widths) / total;
  const trackWidth = (inset: number) => Math.max(0, available * narrowestRatio - 2 * inset);

  const denseInset = dense ? DENSE_CELL_INSET_PT : NORMAL_CELL_INSET_PT;
  if (estimateTokenWidthPt(tokenLength, TABLE_FONT_SIZE_PT) <= trackWidth(denseInset)) {
    return dense ? "dense" : "normal";
  }
  if (estimateTokenWidthPt(tokenLength, MIN_TABLE_FONT_SIZE_PT) <= trackWidth(DENSE_CELL_INSET_PT)) {
    return "scaled";
  }
  return "overflow-warned";
}

/**
 * The longest genuinely-unbreakable token across a table's cell text (chars).
 * Applies the SAME break opportunities the dense renderer inserts
 * ({@link denseAtomicToken}: punctuation + every {@link DENSE_ATOMIC_RUN_LENGTH}
 * alphanumerics) so the measured "atomic" token matches what Typst actually
 * cannot break — a long URL is NOT atomic, it wraps at its slashes/dots. The
 * escalation therefore fires only for genuinely unbreakable runs.
 */
function longestAtomicTokenLength(rows: PreparedTableRow[]): number {
  let longest = 0;
  const splitter = new RegExp(`[\\s${DENSE_BREAK_OPPORTUNITY}]`, "u");
  for (const row of rows) {
    for (const cell of row.cells) {
      const text = blocksPlainText(cell.content);
      for (const token of denseAtomicToken(text).split(splitter)) {
        if (token.length > longest) longest = token.length;
      }
    }
  }
  return longest;
}

// ---- Captions (spec 003 C3) -----------------------------------------------

/** Map a {@link CaptionKind} to the Typst element function used as `figure(kind:)`. */
function typstFigureKind(kind: CaptionKind): string {
  switch (kind) {
    case "figure":
      return "image";
    case "table":
      return "table";
    case "code":
      return "raw";
    case "equation":
      return "math.equation";
  }
}

/**
 * The `caption: [...], kind: <fn>` arguments for a Typst `#figure`. The caption
 * text is serialized at body scope (no dense-table wrapping) and the kind is the
 * walker-normalized {@link CaptionKind}, so DOCX SEQ labels and PDF figure kinds
 * agree and C2's `#outline(target: figure.where(kind: …))` groups correctly.
 */
function captionFigureArgs(caption: Caption, writer: Writer): string {
  const inline = serializeInline(
    caption.content,
    writer.labels,
    writer.notes,
    rootContext(writer.design, writer.locale),
  );
  return `caption: [${inline}], kind: ${typstFigureKind(caption.kind)}`;
}
const DENSE_BREAK_OPPORTUNITY = "\u200B";
const DENSE_ATOMIC_RUN_LENGTH = 4;
const DENSE_STATUS_RUN_LENGTH = 2;

// Serializer-emitted presentation values come from the ACTIVE template design
// (spec 012) \u2014 no bare literals in this file, and no silent fallback to the
// built-in: a second curated template's tokens genuinely apply. The design
// travels on the writer (block scope) and the render context (inline scope).

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

function statusColor(value: string | undefined, design: ResolvedPdfDesign): string {
  const semantic = value?.trim().toLowerCase();
  // The Confluence status palette is per-template data (semanticPalettes.statuses).
  const fallback: Readonly<Record<string, string>> = {
    neutral: "#42526E",
    grey: "#42526E",
    gray: "#42526E",
    purple: "#403294",
    blue: "#0052CC",
    red: "#DE350B",
    yellow: "#FF991F",
    green: "#00875A",
  };
  return (
    (semantic && design.semanticPalettes.statuses[semantic]) ??
    (semantic && fallback[semantic]) ??
    safeColor(value)
  );
}

function serializeDate(
  node: Extract<InlineNode, { type: "date" }>,
  context: RenderContext,
): string {
  const label = formatAdfDateTimestamp(node.timestamp, context.locale);
  const tokens = context.design.tokens;
  return `#box(
  fill: rgb(${typstString(tokens.colors.codeBackground)}),
  inset: (x: ${tokens.layout.inlineCodeInsetX}, y: ${tokens.layout.inlineCodeInsetY}),
  radius: ${tokens.layout.inlineCodeRadius},
)[${literalText(label)}]`;
}

function denseHostLabel(value: string): string {
  return denseAtomicToken(value);
}

function plainUnmarkedText(nodes: InlineNode[]): string | null {
  if (nodes.length !== 1) return null;
  const [node] = nodes;
  if (
    node?.type !== "text" ||
    node.color ||
    node.backgroundColor ||
    (node.marks?.length ?? 0) > 0
  ) return null;
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

/** External PDF links remain recognizable in print-like document designs. */
function styledExternalLink(link: string, context: RenderContext): string {
  const color =
    effectiveCellTextColor(context.design.branding.accent, context) ??
    context.design.branding.accent;
  return `#text(fill: rgb(${typstString(color)}))[#underline[${link}]]`;
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
  const backgroundColor = node.backgroundColor ? safeColor(node.backgroundColor) : undefined;
  if (backgroundColor) {
    out = `#highlight(fill: rgb(${typstString(backgroundColor)}))[${out}]`;
  }
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
  const color =
    effectiveCellTextColor(context.design.tokens.colors.mention, context) ??
    context.design.tokens.colors.mention;
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
  context: RenderContext
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
        case "date":
          return serializeDate(node, context);
        case "status": {
          const label = statusDisplayText(node);
          const color = statusColor(node.color, context.design);
          if (context.availableWidth) {
            return `#dense-status-badge(${context.availableWidth}, ${typstString(label)}, ${typstString(denseStatusLabel(label))}, color: ${typstString(color)})`;
          }
          return `#status-badge(${typstString(label)}, color: ${typstString(color)})`;
        }
        case "placeholder":
          return "";
        case "link": {
          const content = serializeInline(node.content, labels, notes, context);
          const href = resolveLink(node.target, labels);
          if (!href) {
            // Distinguish "blocked by the shared scheme policy" from "merely
            // not representable in a standalone PDF" (spec 011): the first is a
            // security decision the user should see as a warning, the second is
            // an informational limitation.
            const blocked =
              node.target.kind === "external" && !isSafeLinkScheme(node.target.href);
            notes.push({
              level: blocked ? "warning" : "info",
              code: blocked ? UNSAFE_LINK_NOTE_CODE : "pdf-link-unresolved",
              message: blocked
                ? `A link used a blocked scheme and was kept as plain text without a clickable target: ${inlinePlainText(node.content) || "link"}`
                : `Link target could not be represented in PDF: ${inlinePlainText(node.content) || "link"}`,
            });
            return content;
          }
          if (href.startsWith("<")) return `#link(${href})[${content}]`;
          if (context.availableWidth) {
            const label = plainUnmarkedText(node.content);
            const denseLabels = label === null ? null : denseRawUrlLabels(href, label);
            if (denseLabels !== null) {
              return styledExternalLink(
                `#dense-link(${context.availableWidth}, ${typstString(href)}, ${typstString(label!)}, ${typstString(denseLabels.compact)}, ${typstString(denseLabels.host)})`,
                context
              );
            }
          }
          return styledExternalLink(`#link(${typstString(href)})[${content}]`, context);
        }
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    })
    .join("");
}

// Heading-level promotion now lives once in `@atlcli/confluence`
// (`computeHeadingOffset`, imported above); the local min-heading scan that fed
// `headingOffset` here was removed so both engines share one implementation.

interface CollectedLabels {
  /** Link resolution: raw anchor name / heading text → the emitted label. */
  lookup: Map<string, string>;
  /**
   * The EXACT label each explicit-anchor heading / anchor block emits (by
   * block identity), assigned once here so link resolution and serialization
   * can never drift.
   */
  byBlock: Map<PreparedPdfBlock, string>;
}

function collectHeadingLabels(blocks: PreparedPdfBlock[]): CollectedLabels {
  const lookup = new Map<string, string>();
  const byBlock = new Map<PreparedPdfBlock, string>();
  const counts = new Map<string, number>();
  const used = new Set<string>();

  // ---- Pass 1: text-slug labels for anchor-less headings (existing scheme,
  // byte-stable for single-page exports). Registered into `used` FIRST so an
  // anchor whose sanitized name collides with a heading slug gets suffixed —
  // duplicate Typst labels are a compile error.
  const walkSlugs = (list: PreparedPdfBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading": {
          if (block.explicitAnchor) break;
          const text = inlinePlainText(block.content);
          const base = typstLabel(text);
          const count = (counts.get(base) ?? 0) + 1;
          counts.set(base, count);
          const label = count === 1 ? base : `${base}-${count}`;
          used.add(label);
          if (!lookup.has(text)) lookup.set(text, label);
          break;
        }
        case "callout":
        case "expand":
        case "blockquote":
        case "orientation":
          walkSlugs(block.content);
          break;
        case "list":
          for (const item of block.items) walkSlugs(item.content);
          break;
        case "layout":
          for (const column of block.columns) walkSlugs(column.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walkSlugs(cell.content);
          break;
      }
    }
  };

  // ---- Pass 2: explicit-anchor headings + anchor blocks. Names are SANITIZED
  // (raw Confluence anchor macro names like "Table of Contents" are not legal
  // Typst labels — an unsanitized `<Table of Contents>` fails to compile) and
  // deduped per document via `uniqueAnchorId` (duplicate labels are a compile
  // error too). Composed documents arrive pre-sanitized and pre-unique, so
  // sanitize+dedupe is a no-op there and their ids pass through unchanged.
  const walkAnchors = (list: PreparedPdfBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "heading": {
          if (!block.explicitAnchor) break;
          const label = uniqueAnchorId(block.explicitAnchor, used);
          used.add(label);
          byBlock.set(block, label);
          if (!lookup.has(block.explicitAnchor)) lookup.set(block.explicitAnchor, label);
          break;
        }
        case "anchor": {
          const label = uniqueAnchorId(block.name, used);
          used.add(label);
          byBlock.set(block, label);
          if (!lookup.has(block.name)) lookup.set(block.name, label);
          break;
        }
        case "callout":
        case "expand":
        case "blockquote":
        case "orientation":
          walkAnchors(block.content);
          break;
        case "list":
          for (const item of block.items) walkAnchors(item.content);
          break;
        case "layout":
          for (const column of block.columns) walkAnchors(column.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walkAnchors(cell.content);
          break;
      }
    }
  };

  walkSlugs(blocks);
  walkAnchors(blocks);
  return { lookup, byBlock };
}

interface Writer {
  sourceMap: PdfSourceMapEntry[];
  notes: ExportNote[];
  labels: Map<string, string>;
  /** Pre-assigned labels for explicit-anchor headings + anchor blocks. */
  anchorByBlock: Map<PreparedPdfBlock, string>;
  headingOffset: number;
  headingCounts: Map<string, number>;
  theme: PdfTheme;
  contrastWarnings: Set<string>;
  /** The ACTIVE template design driving serializer-emitted presentation. */
  design: ResolvedPdfDesign;
  /** BCP-47 locale for semantic inline dates. */
  locale: string;
}

function serializeDecisionItem(
  sourceState: string | undefined,
  content: string,
  writer: Writer,
): string {
  const state = sourceState ?? "";
  const decided = state.toUpperCase() === "DECIDED";
  const marker = decided ? "◆" : "◇";
  const stateLabel = decided ? "" : `#text(${typstString(`[${state}] `)})`;
  const role = writer.design.typography.roles.taskMarker!;
  const fontRole = role.font ?? "heading";
  const font = writer.design.typography.fonts[fontRole];
  const weight = role.weight ? `, weight: ${typstString(role.weight)}` : "";
  return `#grid(
  columns: (${writer.design.tokens.layout.taskGridMarker}, 1fr),
  column-gutter: ${writer.design.tokens.layout.taskGridGutter},
  align: top,
  text(
    font: (${typstString(font)}, "Noto Sans Symbols2"),
    size: ${role.size}${weight},
    fill: rgb(${typstString(writer.design.tokens.colors.taskChecked)}),
    ${typstString(marker)},
  ),
  [${stateLabel}${content}],
)`;
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

function applyBlockPresentation(
  value: string,
  presentation: BlockPresentation | undefined,
  design: ResolvedPdfDesign,
): string {
  if (!presentation) return value;
  let presented = value;
  if (presentation.alignment !== undefined) {
    presented = `#align(${presentation.alignment})[${presented}]`;
  }
  if (presentation.fontSize === "small") {
    const smallTextSize =
      design.typography.roles.adfSmallText?.size ??
      BUILTIN_PDF_DESIGN.typography.roles.adfSmallText!.size;
    presented = `#text(size: ${smallTextSize})[${presented}]`;
  }
  if (presentation.indentation !== undefined) {
    const level = Math.max(1, Math.min(6, presentation.indentation));
    presented =
      `#block(inset: (left: ${design.tokens.layout.adfBlockIndentStep} * ${level}))[${presented}]`;
  }
  return presented;
}

function serializeBlocks(
  blocks: PreparedPdfBlock[],
  writer: Writer,
  parentPath = "blocks",
  context: RenderContext = rootContext(writer.design, writer.locale),
  startIndex = 0,
): string {
  return blocks
    .map((block, index) => serializeBlock(block, writer, `${parentPath}[${index + startIndex}]`, context))
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
      const navigationTitle = inlinePlainText(block.content);
      summary = navigationTitle;
      // Explicit anchor (spec 002) → the heading emits the sanitized, deduped
      // label the collect pass assigned (the same one links resolve to).
      // Anchor-less headings keep the text-slug label + dedup counter, so
      // single-page output is unchanged.
      let label: string;
      if (block.explicitAnchor) {
        label = writer.anchorByBlock.get(block) ?? uniqueAnchorId(block.explicitAnchor, new Set());
      } else {
        const base = typstLabel(summary);
        const count = (writer.headingCounts.get(base) ?? 0) + 1;
        writer.headingCounts.set(base, count);
        label = count === 1 ? base : `${base}-${count}`;
      }
      const level = Math.max(1, Math.min(6, block.level - writer.headingOffset));
      const heading = (content: string): string =>
        `#atlcli-outline-title.update(${typstString(navigationTitle)})#heading(level: ${level}, outlined: true)[${content}]`;
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
      value = applyBlockPresentation(value, block.presentation, writer.design);
      break;
    }
    case "paragraph":
      value = applyBlockPresentation(
        serializeParagraphInline(block.content, writer, context, true),
        block.presentation,
        writer.design,
      );
      break;
    case "codeBlock": {
      // NOTE: inside `#figure(...)` arguments Typst is in CODE mode, where a
      // leading `#` is a syntax error ("the character `#` is not valid in
      // code") — the figure body must be the bare `raw(...)` expression.
      const rawExpr = `raw(${typstString(block.code)}, lang: ${typstString(block.language ?? "text")}, block: true)`;
      // Only CAPTIONED code becomes a figure — caption-less code keeps today's
      // rendering so C2's `figure.where(kind: raw)` outline never lists every
      // code block (spec 003 C3).
      value = block.caption
        ? `#figure(${rawExpr}, ${captionFigureArgs(block.caption, writer)})`
        : `#${rawExpr}`;
      break;
    }
    case "diagram": {
      // Keep exported content in source order. `placement: auto` turns figures
      // into top/bottom floats, which can move a diagram before its heading or
      // collect multiple headings away from their diagrams in real documents.
      const img = `image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? "Diagram")})`;
      value = block.caption
        ? `#figure(${img}, ${captionFigureArgs(block.caption, writer)})`
        : `#figure(${img})`;
      break;
    }
    case "image":
      if (!block.assetPath) {
        // A captioned image that failed to embed still emits a NUMBERED figure
        // fallback so a broken attachment does not shift figure numbering or
        // leave a caption-less entry in C2's list of figures (spec 003 C3).
        // Figure arguments are CODE context: the body must be the bare
        // `emph[...]` expression — `#emph` there is a Typst syntax error.
        const fallbackExpr = `emph[${literalText(`[Image unavailable: ${block.fallbackLabel}]`)}]`;
        value = block.caption
          ? `#figure(${fallbackExpr}, ${captionFigureArgs(block.caption, writer)})`
          : `#par[#${fallbackExpr}]`;
      } else {
        if (!block.alt) {
          writer.notes.push({
            level: "warning",
            code: "pdf-image-alt-fallback",
            message: `${block.fallbackLabel} uses a technical filename fallback for alternative text.`,
          });
        }
        const img = `image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? block.fallbackLabel)})`;
        value = block.caption
          ? `#figure(${img}, ${captionFigureArgs(block.caption, writer)})`
          : `#figure(${img})`;
      }
      break;
    case "mediaFallback": {
      const fallbackExpr = `emph[${literalText(`[Media unavailable: ${block.label}]`)}]`;
      value = block.caption
        ? `#figure(${fallbackExpr}, ${captionFigureArgs(block.caption, writer)})`
        : `#par[#${fallbackExpr}]`;
      break;
    }
    case "callout": {
      const title = block.title ? `[${literalText(block.title)}]` : "none";
      const calloutContext: RenderContext = { ...context, container: "calloutCell" };
      value = `#callout(kind: ${typstString(block.kind)}, title: ${title})[\n${serializeBlocks(block.content, writer, `${path}.content`, calloutContext)}\n]`;
      break;
    }
    case "expand": {
      const titleText = block.title === undefined ? "[-]" : `[-] ${block.title}`;
      const calloutContext: RenderContext = { ...context, container: "calloutCell" };
      const disclosure =
        `#callout(kind: "panel", title: [${literalText(titleText)}])[\n` +
        `${serializeBlocks(block.content, writer, `${path}.content`, calloutContext)}\n]`;
      value = block.nested
        ? `#block(inset: (left: ${writer.design.tokens.layout.adfBlockIndentStep}))[${disclosure}]`
        : disclosure;
      break;
    }
    case "blockquote":
      value = `#quote(block: true)[\n${serializeBlocks(block.content, writer, `${path}.content`, context)}\n]`;
      break;
    case "list": {
      const fn = block.ordered ? "enum" : "list";
      const isSemanticList = !block.ordered && (
        block.listKind !== undefined ||
        block.items.some((item) => item.kind !== undefined || item.checked !== undefined)
      );
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
          const tail = rest.length > 0 ? serializeBlocks(rest, writer, itemPath, context, 1) : "";
          content = `${inline}${tail}`;
        } else {
          content = serializeBlocks(item.content, writer, itemPath, context);
        }
        if (!isSemanticList) return `[${content}]`;
        if (item.kind === "decision") {
          return `[${serializeDecisionItem(item.state, content, writer)}]`;
        }
        if (item.kind === "task" || item.checked !== undefined) {
          const checked = (item.checked ?? (item.state === "DONE")) ? "true" : "false";
          return `[#task-item(${checked})[${content}]]`;
        }
        return `[${content}]`;
      });
      const options = isSemanticList
        ? `marker: none, body-indent: ${writer.design.tokens.layout.taskListBodyIndent}, `
        : block.ordered && block.start !== undefined
          ? `start: ${block.start}, `
          : "";
      value = `#${fn}(${options}\n${items.join(",\n")}\n)`;
      break;
    }
    case "layout": {
      if (block.columns.length === 0) {
        writer.notes.push({
          level: "warning",
          code: "layout-geometry-fallback",
          message: "An empty page layout produced no visible columns.",
          source: { blockPath: path },
        });
        value = "";
        break;
      }
      const positiveWidths = block.columns.map((column) =>
        Number.isFinite(column.width) && column.width > 0 ? column.width : 0
      );
      const total = positiveWidths.reduce((sum, width) => sum + width, 0);
      const visibleMinimum = total > 0
        ? Math.max(total / 1_000, 0.001)
        : 1;
      const weights = total > 0
        ? positiveWidths.map((width) => width > 0 ? width : visibleMinimum)
        : positiveWidths.map(() => 1);
      const columns = weights.map((weight) => `${Number(weight.toFixed(6))}fr`).join(", ");
      // Layout tokens were added after wiki.pdf-template/v1 shipped. Preserve
      // older custom manifests by falling back to the built-in design.
      const columnGutter =
        writer.design.tokens.layout.pageLayoutColumnGutter ??
        BUILTIN_PDF_DESIGN.tokens.layout.pageLayoutColumnGutter;
      const insetX =
        writer.design.tokens.layout.pageLayoutInsetX ??
        BUILTIN_PDF_DESIGN.tokens.layout.pageLayoutInsetX;
      const cellContext: RenderContext = {
        ...context,
        container: "tableCell",
        inTable: false,
        tableDensity: "normal",
      };
      const cells = block.columns.map((column, index) => {
        const content = serializeBlocks(
          column.content,
          writer,
          `${path}.columns[${index}].content`,
          cellContext,
        );
        const alignment = column.verticalAlignment === "middle"
          ? "horizon"
          : column.verticalAlignment;
        return alignment
          ? `grid.cell(align: ${alignment})[\n${content}\n]`
          : `[\n${content}\n]`;
      });
      value =
        `#grid(\n` +
        `  columns: (${columns}),\n` +
        `  column-gutter: ${columnGutter},\n` +
        `  inset: (left: ${insetX}, right: ${insetX}),\n` +
        `  stroke: none,\n` +
        `  ${cells.join(",\n  ")},\n` +
        `)`;
      break;
    }
    case "table": {
      const grid = tableGrid(block.rows, block.columnWidths);
      const { columnCount } = grid;
      const isDense = columnCount >= DENSE_TABLE_COLUMN_THRESHOLD;
      // Wide-table escalation (spec 003 T1.6). A landscape orientation region
      // widens the available text area, so the same table classifies against
      // the wider track rather than the portrait one.
      const layout = classifyTableLayout({
        columnCount,
        sourceWidths: block.columnWidths,
        longestAtomicToken: longestAtomicTokenLength(block.rows),
        availableWidth: context.layoutWidthPt ?? PORTRAIT_TEXT_WIDTH_PT,
      });
      if (layout === "scaled") {
        writer.notes.push({
          level: "info",
          code: "table-text-scaled",
          message: `A wide table's text was scaled down to ${MIN_TABLE_FONT_SIZE_PT}pt to fit the page width.`,
          source: { blockPath: path },
        });
      } else if (layout === "overflow-warned") {
        writer.notes.push({
          level: "warning",
          code: "table-overflow-warned",
          message: "A wide table may overflow the page even at minimum text size; consider a landscape orientation region for it.",
          source: { blockPath: path },
        });
      }
      const cellContext: RenderContext = {
        tableDensity: isDense ? "dense" : "normal",
        inTable: true,
        container: "tableCell",
        design: context.design,
        locale: context.locale,
      };
      const columns = tableColumns(columnCount, block.columnWidths, block.rows);
      const serializedRows = grid.rows.map((row, rowIndex) => {
        const cells = row.map(({ cell, cellIndex, columnIndex }) => {
          const backgroundColor =
            cell.backgroundColor ??
            (cell.header ? writer.design.tokens.colors.tableHeaderBackground : undefined);
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
            cell.verticalAlignment
              ? `align: ${cell.verticalAlignment === "middle" ? "horizon" : cell.verticalAlignment}`
              : "",
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
        // `repeat: true` is Typst's default, but pin it explicitly so the golden
        // proves header rows repeat on every page across a break (spec 003 T1.6).
        rows.push(`table.header(repeat: true, ${headerCells.join(", ")})`);
      }
      rows.push(...serializedRows.slice(leadingHeaderCount).map((row) => row.cells.join(", ")));
      const horizontalInset = layout === "normal" ? NORMAL_CELL_INSET_PT : DENSE_CELL_INSET_PT;
      const tableMarkup = `#table(columns: ${columns}, inset: (x: ${horizontalInset}pt, y: ${writer.design.tokens.layout.tableCellInsetY}), stroke: rgb(${typstString(writer.design.tokens.colors.tableStroke)}),\n${rows.join(",\n")}\n)`;
      // "scaled"/"overflow-warned" render body text at the readability floor
      // (accept wrap/clip over losing content).
      const scaled = layout === "scaled" || layout === "overflow-warned";
      const tableBody = scaled
        ? `#[\n#set text(size: ${MIN_TABLE_FONT_SIZE_PT}pt)\n${tableMarkup}\n]`
        : tableMarkup;
      // Figure arguments are CODE context: the body must be the bare
      // `block(...)` call — a leading `#` there is a Typst syntax error. The
      // `[...]` content argument re-enters markup, so the inner `#table` stays valid.
      const authoredWidthPt = tableWidthPt(
        block.presentation,
        context.layoutWidthPt ?? PORTRAIT_TEXT_WIDTH_PT,
      );
      const width = authoredWidthPt !== undefined ? `${Number(authoredWidthPt.toFixed(3))}pt` : "100%";
      const blockExpr = `block(width: ${width})[\n${tableBody}\n]`;
      const alignment = tableAlignment(block.presentation);
      const tableBlockExpr = alignment ? `align(${alignment}, ${blockExpr})` : blockExpr;
      value = block.caption
        ? `#figure(${tableBlockExpr}, ${captionFigureArgs(block.caption, writer)})`
        : `#${tableBlockExpr}`;
      break;
    }
    case "divider":
      value = `#line(length: 100%, stroke: rgb(${typstString(writer.design.tokens.colors.tableStroke)}))`;
      break;
    case "unknown": {
      // Placeholder floor (spec 004): render a visible placeholder line, then
      // the preserved body/plainBody, instead of silently omitting content.
      const placeholder = `#text(style: "italic", fill: rgb(${typstString(writer.design.tokens.colors.placeholder)}))[${escapeTypstContent(
        `[${block.macroName} macro not rendered]`
      )}]`;
      const parts = [`#par[${placeholder}]`];
      if (block.body && block.body.length > 0) {
        parts.push(serializeBlocks(block.body, writer, `${path}.body`, context));
      } else if (block.plainBody) {
        const MAX_PLAIN = 20000;
        let text = block.plainBody;
        if (text.length > MAX_PLAIN) {
          text = text.slice(0, MAX_PLAIN);
          writer.notes.push({
            level: "warning",
            code: "macro-body-truncated",
            message: `The "${block.macroName}" macro body was truncated at ${MAX_PLAIN} characters.`,
            macroName: block.macroName,
          });
        }
        parts.push(
          serializeBlocks([{ type: "codeBlock", code: text }], writer, `${path}.plainBody`, context)
        );
      }
      value = parts.join("\n");
      break;
    }
    // Real renderings (spec 002 / T1.3).
    case "pageBreak":
      if (context.container === "tableCell" || context.container === "calloutCell") {
        // A `#pagebreak` inside a `table.cell`/`callout` box has no effect —
        // suppress it with a note (spec 003 C5 container matrix).
        writer.notes.push({
          level: "info",
          code: "pagebreak-suppressed-in-container",
          message: `A page break inside a ${context.container === "tableCell" ? "table cell" : "callout"} was suppressed (it has no effect inside that box).`,
          source: { blockPath: path },
        });
        value = "";
      } else {
        value = "#pagebreak(weak: true)";
      }
      break;
    case "anchor":
      // A zero-width labelable target at this position (`#box[]<label>`), so
      // `page-<id>` chapter-start links and in-page anchor links resolve here.
      // The label is the SANITIZED, per-document-unique id from the collect
      // pass — raw Confluence anchor names ("Table of Contents") are not legal
      // Typst labels and would fail the compile.
      value = `#box[]<${writer.anchorByBlock.get(block) ?? uniqueAnchorId(block.name, new Set())}>`;
      break;
    case "orientation": {
      if (context.container === "tableCell" || context.container === "calloutCell") {
        // A Typst `set page` has no effect inside a `table.cell`/`callout` box —
        // render the children without the wrapper (spec 003 C6 container matrix).
        writer.notes.push({
          level: "info",
          code: "orientation-suppressed-in-container",
          message: `An orientation region inside a ${context.container === "tableCell" ? "table cell" : "callout"} was rendered without an orientation change.`,
          source: { blockPath: path },
        });
        value = serializeBlocks(block.content, writer, `${path}.content`, context);
        break;
      }
      // A block-scoped `set page(flipped:)` — set to the region's ACTUAL boolean
      // both ways (a scroll-portrait region inside a landscape document flips
      // BACK to portrait). Typst set rules are block-scoped; page breaks at the
      // region boundaries happen automatically. Widen the wide-table layout
      // width for a landscape region so classifyTableLayout escalates against
      // the landscape text area (spec 003 C6 / T1.6).
      const regionContext: RenderContext = {
        ...context,
        layoutWidthPt: block.landscape ? LANDSCAPE_TEXT_WIDTH_PT : PORTRAIT_TEXT_WIDTH_PT,
      };
      const inner = serializeBlocks(block.content, writer, `${path}.content`, regionContext);
      value = `#[\n#set page(flipped: ${block.landscape ? "true" : "false"})\n${inner}\n]`;
      break;
    }
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

function documentLocale(language?: string, region?: string): string {
  const requested = language
    ? region && !language.includes("-") ? `${language}-${region}` : language
    : "en";
  try {
    new Intl.DateTimeFormat(requested);
    return requested;
  } catch {
    return "en";
  }
}

export function serializePdfDocument(
  document: PreparedPdfDocument,
  options: PdfSerializeOptions
): PdfSourceBundle {
  const theme = resolvePdfTheme(options.theme);
  // Settings resolve BEFORE the writer: the resolved design drives both the
  // generated template and the serializer's own emitted presentation, so the
  // active (possibly non-built-in) template's tokens reach every emission site.
  const settings = resolvePdfSettings(options.settings, {
    ...(options.metadata.language !== undefined ? { locale: options.metadata.language } : {}),
    ...(options.metadata.region !== undefined ? { region: options.metadata.region } : {}),
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
    ...(options.templateManifest !== undefined ? { manifest: options.templateManifest } : {}),
  });
  const collected = collectHeadingLabels(document.blocks);
  const writer: Writer = {
    sourceMap: [],
    notes: [...document.notes],
    labels: collected.lookup,
    anchorByBlock: collected.byBlock,
    headingOffset: computeHeadingOffset(document.blocks),
    headingCounts: new Map(),
    theme,
    contrastWarnings: new Set(),
    design: settings.design,
    locale: documentLocale(options.metadata.language, options.metadata.region),
  };
  const body = serializeBlocks(document.blocks, writer);
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
  const main = String.raw`#import "atlcli.typ": atlcli-doc, atlcli-outline-title, callout, status-badge, table-par, dense-token, dense-link, dense-status-badge, task-item

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
    template: createAtlcliTypstTemplate(settings.design, settings.labels),
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

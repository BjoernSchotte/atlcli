import type {
  AdfAnnotationIdentity,
  BlockPresentation,
  CaptionKind,
  ExportNote,
  InlineNode,
  LinkTarget,
  SmartCardSemantics,
  TablePresentation,
} from "@atlcli/confluence";
import {
  UNSAFE_LINK_NOTE_CODE,
  computeHeadingOffset,
  formatAdfDateTimestamp,
  inlineMediaDisplayText,
  mediaFallbackDisplayText,
  isSafeLinkScheme,
  mentionDisplayText,
  resolveCalloutIcon,
  smartCardDisplayText,
  statusDisplayText,
  uniqueAnchorId,
} from "@atlcli/confluence";
import { normalizeRasterAssetV1, resolveEffectivePpi } from "@atlcli/export-media";
import {
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
} from "@atlcli/code-highlight/registry";
import {
  projectPdfDesignThroughCatalog,
  readPdfDesignCapability,
} from "./design-catalog.js";
import { escapeTypstContent, safeColor, typstLabel, typstString } from "./escape.js";
import { resolvePdfSettings, typstSettingsDict, type ResolvedPdfDesign } from "./settings.js";
import { createAtlcliTypstTemplate } from "./template.js";
import { resolvePdfFontRequirementsV1 } from "./font-requirements.js";
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
  PreparedPdfCaption,
  PreparedPdfDocument,
  PreparedPdfInlineNode,
} from "./types.js";

function inlinePlainText(nodes: PreparedPdfInlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "link":
          return inlinePlainText(node.content);
        case "mention":
          return `@${mentionDisplayText(node)}`;
        case "date":
          return formatAdfDateTimestamp(node.timestamp);
        case "status":
          return statusDisplayText(node);
        case "smartCard":
          return smartCardDisplayText(node.card);
        case "media":
          return inlineMediaDisplayText(node);
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
          return [block.title, block.code].filter(Boolean).join(" ");
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
        case "smartCard":
          return smartCardDisplayText(block.card);
        case "chart":
          return chartPlainText(block.chart);
        case "diagram":
          return block.alt ?? "Diagram";
        case "divider":
          return "";
        case "unknown":
          return block.extensionFrames
            ? block.extensionFrames
              .map((frame) => blocksPlainText(frame.content))
              .join(" ")
            : block.body
              ? blocksPlainText(block.body)
              : block.macroName;
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
    case "attachment":
      if (!target.href || !isSafeLinkScheme(target.href)) return null;
      return /^(https?:|mailto:)/i.test(target.href) ? target.href : null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function designColor(catalogDesign: ResolvedPdfDesign, key: string): string {
  return readPdfDesignCapability<string>(catalogDesign, `tokens.colors.${key}`);
}

function designLength(catalogDesign: ResolvedPdfDesign, key: string): string {
  return readPdfDesignCapability<string>(catalogDesign, `tokens.layout.${key}`);
}

function serializeSmartCardInline(
  card: SmartCardSemantics,
  labels: Map<string, string>,
  catalogDesign: ResolvedPdfDesign,
): string {
  const label = literalText(smartCardDisplayText(card));
  const content =
    card.appearance === "inline"
      ? `#box(fill: rgb(${typstString(designColor(catalogDesign, "smartCardInlineBackground"))}), ` +
        `inset: (x: ${designLength(catalogDesign, "smartCardInlineInsetX")}, ` +
        `y: ${designLength(catalogDesign, "smartCardInlineInsetY")}), ` +
        `radius: ${designLength(catalogDesign, "smartCardInlineRadius")})[${label}]`
      : label;
  const href = card.target ? resolveLink(card.target, labels) : null;
  if (!href) return content;
  return href.startsWith("<")
    ? `#link(${href})[${content}]`
    : `#link(${typstString(href)})[${content}]`;
}

type TableDensity = "normal" | "dense";

/** The layout container the current block renders inside (spec 003 C5/C6). */
type RenderContainer = "body" | "tableCell" | "calloutCell";

class PdfCommentRegistry {
  private readonly byMarkerRef = new Map<string, {
    number: number;
    annotation: AdfAnnotationIdentity & { comment: NonNullable<AdfAnnotationIdentity["comment"]> };
  }>();

  register(annotation: AdfAnnotationIdentity): number | undefined {
    if (!annotation.comment) return undefined;
    const existing = this.byMarkerRef.get(annotation.id);
    if (existing) return existing.number;
    const number = this.byMarkerRef.size + 1;
    this.byMarkerRef.set(annotation.id, {
      number,
      annotation: annotation as AdfAnnotationIdentity & {
        comment: NonNullable<AdfAnnotationIdentity["comment"]>;
      },
    });
    return number;
  }

  entries(): Array<{
    number: number;
    annotation: AdfAnnotationIdentity & { comment: NonNullable<AdfAnnotationIdentity["comment"]> };
  }> {
    return [...this.byMarkerRef.values()];
  }
}

interface RenderContext {
  tableDensity: TableDensity;
  /**
   * A wrap-left/right media block may enter a serializer-owned side-by-side
   * grid with its following paragraph. Typst has no native contour wrapping;
   * the bounded grid keeps source order and approximates the authored intent.
   */
  mediaInWrapGrid?: boolean;
  /** Override authored media width after the grid has allocated its column. */
  mediaWidthOverride?: string;
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
  catalogDesign: ResolvedPdfDesign;
  /** BCP-47 locale for semantic inline dates. */
  locale: string;
  comments: PdfCommentRegistry;
}

/** The root render context for a catalog-projected document design. */
function rootContext(
  catalogDesign: ResolvedPdfDesign,
  locale = "en",
  comments = new PdfCommentRegistry(),
): RenderContext {
  return { tableDensity: "normal", catalogDesign, locale, comments };
}
const DENSE_TABLE_COLUMN_THRESHOLD = 9;

// ---- Wide-table layout classification (spec 003 T1.6) ---------------------

/** Escalation tiers for a table that may not fit its available width. */
export type TableLayoutClass = "normal" | "dense" | "scaled" | "overflow-warned";

/**
 * Usable text width (pt) of the built-in A4 template, portrait / landscape.
 * Exported (package-internal) because the image-profile normalizer uses them
 * as the conservative render-envelope cap (issue #118 Phase 1).
 */
export const PORTRAIT_TEXT_WIDTH_PT = 470;
export const LANDSCAPE_TEXT_WIDTH_PT = 717;
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
function captionFigureArgs(caption: PreparedPdfCaption, writer: Writer): string {
  const inline = serializeInline(
    caption.content,
    writer.labels,
    writer.notes,
    rootContext(writer.catalogDesign, writer.locale, writer.comments),
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

function statusColor(value: string | undefined, catalogDesign: ResolvedPdfDesign): string {
  const semantic = value?.trim().toLowerCase();
  const authoredColor = safeColor(value, "");
  return (
    authoredColor ||
    (semantic && catalogDesign.semanticPalettes.statuses[semantic]) ||
    catalogDesign.semanticPalettes.statuses.default ||
    catalogDesign.tokens.colors.neutral ||
    safeColor(value)
  );
}

/** Legacy Storage code-macro title as a header row above code or diagram output. */
function serializeCodeTitle(
  title: string | undefined,
  catalogDesign: ResolvedPdfDesign,
): string {
  if (!title) return "";
  return (
    `#block(width: 100%, fill: rgb(${typstString(catalogDesign.tokens.colors.codeBackground)}), ` +
    `inset: ${catalogDesign.tokens.layout.codeInset}, radius: ${catalogDesign.tokens.layout.codeRadius}, ` +
    `below: ${designLength(catalogDesign, "codeTitleBelow")})[#strong[${literalText(title)}]]\n`
  );
}

function serializeDate(
  node: Extract<InlineNode, { type: "date" }>,
  context: RenderContext,
): string {
  const label = formatAdfDateTimestamp(node.timestamp, context.locale);
  const tokens = context.catalogDesign.tokens;
  return `#box(
  fill: rgb(${typstString(tokens.colors.codeBackground)}),
  inset: (x: ${tokens.layout.inlineCodeInsetX}, y: ${tokens.layout.inlineCodeInsetY}),
  radius: ${tokens.layout.inlineCodeRadius},
)[${literalText(label)}]`;
}

function denseHostLabel(value: string): string {
  return denseAtomicToken(value);
}

function plainUnmarkedText(nodes: PreparedPdfInlineNode[]): string | null {
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
    effectiveCellTextColor(context.catalogDesign.branding.accent, context) ??
    context.catalogDesign.branding.accent;
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
  const label = mentionDisplayText(node);
  const color =
    effectiveCellTextColor(context.catalogDesign.tokens.colors.mention, context) ??
    context.catalogDesign.tokens.colors.mention;
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

function annotationMarkers(
  annotations: readonly AdfAnnotationIdentity[] | undefined,
  comments: PdfCommentRegistry,
): string {
  const numbers = (annotations ?? [])
    .map((annotation) => comments.register(annotation))
    .filter((number): number is number => number !== undefined);
  return numbers.map((number) =>
    `#super[${literalText(`[${number}]`)}]`
  ).join("");
}

function endingAnnotations(
  nodes: readonly PreparedPdfInlineNode[],
  index: number,
): readonly AdfAnnotationIdentity[] | undefined {
  const node = nodes[index];
  if (!node || !("annotations" in node) || !node.annotations) return undefined;
  const next = nodes[index + 1];
  const nextIds = new Set(
    next && "annotations" in next
      ? (next.annotations ?? []).map((annotation) => annotation.id)
      : [],
  );
  return node.annotations.filter((annotation) => !nextIds.has(annotation.id));
}

function serializeCommentAppendix(
  comments: PdfCommentRegistry,
  catalogDesign: ResolvedPdfDesign,
): string {
  const entries = comments.entries();
  if (entries.length === 0) return "";
  const replyIndent = designLength(catalogDesign, "listBodyIndent");
  const itemSpacing = designLength(catalogDesign, "paragraphSpacing");
  const items = entries.map(({ number, annotation }) => {
    const resource = annotation.comment;
    const status = resource.status === "resolved" ? "Resolved — " : "";
    const replies = resource.replies
      .map((reply) =>
        `#block(inset: (left: ${replyIndent}))[#emph[Reply:] ${literalText(reply.bodyText)}]`
      )
      .join("\n");
    return `#block(above: ${itemSpacing})[#strong[${literalText(`[${number}]`)}] ` +
      `${literalText(`${status}${resource.bodyText}`)}${replies ? `\n${replies}` : ""}]`;
  }).join("\n");
  return `\n#pagebreak()\n#heading(level: 1, outlined: false)[Comments]\n${items}\n`;
}

function serializeInline(
  nodes: PreparedPdfInlineNode[],
  labels: Map<string, string>,
  notes: ExportNote[],
  context: RenderContext
): string {
  return nodes
    .map((node, index) => {
      switch (node.type) {
        case "text": {
          return serializeText(node, context) +
            annotationMarkers(endingAnnotations(nodes, index), context.comments);
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
          const color = statusColor(node.color, context.catalogDesign);
          if (context.availableWidth) {
            return `#dense-status-badge(${context.availableWidth}, ${typstString(label)}, ${typstString(denseStatusLabel(label))}, color: ${typstString(color)})`;
          }
          return `#status-badge(${typstString(label)}, color: ${typstString(color)})`;
        }
        case "smartCard":
          return serializeSmartCardInline(node.card, labels, context.catalogDesign);
        case "media": {
          let rendered: string;
          if (node.assetPath) {
            const dimensions = [
              node.width !== undefined ? `width: ${node.width * 0.75}pt` : undefined,
              node.height !== undefined ? `height: ${node.height * 0.75}pt` : undefined,
            ].filter((value): value is string => value !== undefined);
            const image =
              `#image(${typstString(node.assetPath)}, alt: ${typstString(node.alt ?? node.fallbackLabel)}` +
              `${dimensions.length ? `, ${dimensions.join(", ")}` : ""})`;
            const border = node.border
              ? `, stroke: ${node.border.size}pt + rgb(${typstString(node.border.color.slice(0, 7))})`
              : "";
            const drawing =
              `#box(baseline: ${designLength(context.catalogDesign, "inlineMediaBaseline")}${border}, ` +
              `inset: ${designLength(context.catalogDesign, "inlineMediaInset")})[${image}]`;
            if (!node.link) rendered = drawing;
            else {
              const href = resolveLink(node.link.target, labels);
              rendered = href
              ? href.startsWith("<")
                ? `#link(${href})[${drawing}]`
                : `#link(${typstString(href)})[${drawing}]`
              : drawing;
            }
            return rendered + annotationMarkers(
              endingAnnotations(nodes, index),
              context.comments,
            );
          }
          const label = literalText(`[${inlineMediaDisplayText(node)}]`);
          const color = node.border?.color.slice(0, 7) ?? context.catalogDesign.tokens.colors.hairline;
          const size = node.border?.size ?? 1;
          const chip =
            `#box(stroke: ${size}pt + rgb(${typstString(color)}), ` +
            `inset: (x: ${designLength(context.catalogDesign, "inlineMediaChipInsetX")}, ` +
            `y: ${designLength(context.catalogDesign, "inlineMediaChipInsetY")}), ` +
            `radius: ${designLength(context.catalogDesign, "inlineMediaChipRadius")})` +
            `[${label}]`;
          if (!node.link) rendered = chip;
          else {
            const href = resolveLink(node.link.target, labels);
            rendered = href
            ? href.startsWith("<")
              ? `#link(${href})[${chip}]`
              : `#link(${typstString(href)})[${chip}]`
            : chip;
          }
          return rendered + annotationMarkers(
            endingAnnotations(nodes, index),
            context.comments,
          );
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
  catalogDesign: ResolvedPdfDesign;
  /** BCP-47 locale for semantic inline dates. */
  locale: string;
  comments: PdfCommentRegistry;
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
  const role = writer.catalogDesign.typography.roles.taskMarker!;
  const fontRole = role.font ?? "heading";
  const font = writer.catalogDesign.typography.fonts[fontRole];
  const weight = role.weight ? `, weight: ${typstString(role.weight)}` : "";
  return `#grid(
  columns: (${writer.catalogDesign.tokens.layout.taskGridMarker}, 1fr),
  column-gutter: ${writer.catalogDesign.tokens.layout.taskGridGutter},
  align: top,
  text(
    font: (${typstString(font)}, "Noto Sans Symbols2", "Noto Emoji"),
    size: ${role.size}${weight},
    fill: rgb(${typstString(writer.catalogDesign.tokens.colors.taskChecked)}),
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
  content: PreparedPdfInlineNode[],
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
  catalogDesign: ResolvedPdfDesign,
): string {
  if (!presentation) return value;
  let presented = value;
  if (presentation.alignment !== undefined) {
    presented = `#align(${presentation.alignment})[${presented}]`;
  }
  if (presentation.fontSize === "small") {
    const smallTextSize = readPdfDesignCapability<string>(
      catalogDesign,
      "typography.roles.adfSmallText.size"
    );
    presented = `#text(size: ${smallTextSize})[${presented}]`;
  }
  if (presentation.indentation !== undefined) {
    const level = Math.max(1, Math.min(6, presentation.indentation));
    presented =
      `#block(inset: (left: ${catalogDesign.tokens.layout.adfBlockIndentStep} * ${level}))[${presented}]`;
  }
  return presented;
}

/** Match DOCX's Shiki normalization: canonical RGB, dropping an alpha byte. */
function shikiRgb(value: string, fallback: string): string {
  const raw = value.startsWith("#") ? value : `#${value}`;
  const alpha = raw.match(/^(#[0-9a-f]{6})[0-9a-f]{2}$/i);
  return alpha ? alpha[1]!.toUpperCase() : safeColor(raw, fallback);
}

/**
 * Render the shared Shiki projection without asking Typst to choose syntax
 * colors. Each source line remains a distinct grid row, including trailing
 * empty lines, while token text stays literal and copyable.
 */
function serializeHighlightedCodeBlock(
  block: Extract<PreparedPdfBlock, { type: "codeBlock" }>,
  writer: Writer,
): string {
  const mono = writer.catalogDesign.typography.fonts.mono;
  const size = writer.catalogDesign.typography.roles.code!.size;
  const firstLineNumber = block.firstLineNumber ?? 1;
  const lastLineNumber = firstLineNumber + Math.max(0, block.highlight.lines.length - 1);
  const lineNumberWidth = String(lastLineNumber).length;
  const rows = block.highlight.lines.map((tokens, index) => {
    const spans = tokens.length === 0 || tokens.every((token) => token.text.length === 0)
      ? `#box(height: ${size})[]`
      : tokens.map((token) =>
          `#text(font: ${typstString(mono)}, size: ${size}, fill: rgb(${typstString(
            shikiRgb(
              token.color ?? block.highlight.theme.foreground,
              block.highlight.theme.foreground,
            ),
          )}), ${typstString(token.text)})`
        ).join("");
    const body = `#box(width: 100%)[${spans}]`;
    if (block.hideLineNumbers !== false) return `[${body}]`;
    const number = String(firstLineNumber + index).padStart(lineNumberWidth);
    return `[#grid(columns: (auto, 1fr), column-gutter: ${writer.catalogDesign.tokens.layout.codeInset}, ` +
      `[${`#text(font: ${typstString(mono)}, size: ${size}, fill: rgb(${typstString(writer.catalogDesign.tokens.colors.muted)}), ${typstString(number)})`}], ` +
      `[${body}])]`;
  });
  const background = shikiRgb(
    block.highlight.theme.background,
    block.highlight.theme.background,
  );
  return (
    `block(width: 100%, fill: rgb(${typstString(background)}), ` +
    `inset: ${writer.catalogDesign.tokens.layout.codeInset}, ` +
    `radius: ${writer.catalogDesign.tokens.layout.codeRadius})[` +
    `#grid(columns: (1fr), row-gutter: ${size} * 0.35, ${rows.join(", ")})]`
  );
}

function serializeBlocks(
  blocks: PreparedPdfBlock[],
  writer: Writer,
  parentPath = "blocks",
  context: RenderContext = rootContext(writer.catalogDesign, writer.locale, writer.comments),
  startIndex = 0,
): string {
  const serialized: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const path = `${parentPath}[${index + startIndex}]`;
    const presentation =
      block.type === "image" || block.type === "mediaFallback"
        ? block.mediaPresentation
        : undefined;
    const layout = presentation?.layout;
    const following = blocks[index + 1];
    if (
      (block.type === "image" || block.type === "mediaFallback") &&
      (layout === "wrap-left" || layout === "wrap-right") &&
      following?.type === "paragraph" &&
      !context.inTable
    ) {
      const mediaTrack =
        presentation?.widthType === "pixel" && presentation.width !== undefined
          ? `${presentation.width * 0.75}pt`
          : presentation?.width !== undefined
            ? `${presentation.width}%`
            : "40%";
      const boundedContext = {
        ...context,
        mediaInWrapGrid: true,
        mediaWidthOverride: "100%",
      };
      const media = serializeBlock(block, writer, path, boundedContext);
      const paragraph = serializeBlock(
        following,
        writer,
        `${parentPath}[${index + 1 + startIndex}]`,
        boundedContext,
      );
      const cells =
        layout === "wrap-left"
          ? `[${media}], [${paragraph}]`
          : `[${paragraph}], [${media}]`;
      const columns =
        layout === "wrap-left"
          ? `(${mediaTrack}, 1fr)`
          : `(1fr, ${mediaTrack})`;
      serialized.push(
        `#grid(columns: ${columns}, column-gutter: ${designLength(context.catalogDesign, "mediaWrapColumnGutter")}, ${cells})`,
      );
      index += 1;
      continue;
    }
    serialized.push(serializeBlock(block, writer, path, context));
  }
  return serialized.join("\n");
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
      value = applyBlockPresentation(value, block.presentation, writer.catalogDesign);
      break;
    }
    case "paragraph":
      value = applyBlockPresentation(
        serializeParagraphInline(block.content, writer, context, true),
        block.presentation,
        writer.catalogDesign,
      );
      break;
    case "smartCard": {
      const prefix = block.card.appearance === "embed" ? "Embedded content: " : "";
      value =
        `#block(width: 100%, fill: rgb(${typstString(designColor(writer.catalogDesign, "smartCardBlockBackground"))}), ` +
        `stroke: rgb(${typstString(designColor(writer.catalogDesign, "smartCardBlockStroke"))}), ` +
        `radius: ${designLength(writer.catalogDesign, "smartCardBlockRadius")}, ` +
        `inset: ${designLength(writer.catalogDesign, "smartCardBlockInset")})[#strong[${literalText(prefix)}]` +
        `${serializeSmartCardInline(block.card, writer.labels, writer.catalogDesign)}]`;
      break;
    }
    case "codeBlock": {
      if (block.initiallyCollapsed === true) {
        writer.notes.push({
          level: "info",
          code: "code-collapse-static",
          message:
            "A code block was initially collapsed in Confluence; the static PDF export rendered its complete source.",
          source: { blockPath: path },
        });
      }
      if (block.wrap === false) {
        writer.notes.push({
          level: "info",
          code: "code-nowrap-page-bounded",
          message:
            "A code block requested no wrapping; the bounded PDF page keeps all source text and may wrap long lines instead of clipping them.",
          source: { blockPath: path },
        });
      }
      // The figure body is a bare expression because figure arguments are
      // Typst code mode. Colors and fill come exclusively from the prepared
      // Shiki projection; no renderer-specific `raw(lang:)` highlighting runs.
      const highlighted = serializeHighlightedCodeBlock(block, writer);
      const code = block.caption
        ? `#figure(${highlighted}, ${captionFigureArgs(block.caption, writer)})`
        : `#${highlighted}`;
      value = serializeCodeTitle(block.title, writer.catalogDesign) + code;
      break;
    }
    case "diagram": {
      if (block.initiallyCollapsed === true) {
        writer.notes.push({
          level: "info",
          code: "code-collapse-static",
          message:
            "A code block was initially collapsed in Confluence; the static PDF export rendered its complete diagram.",
          source: { blockPath: path },
        });
      }
      // Keep exported content in source order. `placement: auto` turns figures
      // into top/bottom floats, which can move a diagram before its heading or
      // collect multiple headings away from their diagrams in real documents.
      const img = `image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? "Diagram")})`;
      const diagram = block.caption
        ? `#figure(${img}, ${captionFigureArgs(block.caption, writer)})`
        : `#figure(${img})`;
      value = serializeCodeTitle(block.title, writer.catalogDesign) + diagram;
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
        const width = mediaImageWidth(block, context);
        const img =
          `image(${typstString(block.assetPath)}, alt: ${typstString(block.alt ?? block.fallbackLabel)}` +
          `${width ? `, width: ${width}` : ""})`;
        value = block.caption
          ? `#figure(${img}, ${captionFigureArgs(block.caption, writer)})`
          : `#figure(${img})`;
      }
      break;
    case "mediaFallback": {
      const fallbackExpr =
        `emph[${literalText(`[${mediaFallbackDisplayText(block)}]`)}]`;
      value = block.caption
        ? `#figure(${fallbackExpr}, ${captionFigureArgs(block.caption, writer)})`
        : `#par[#${fallbackExpr}]`;
      break;
    }
    case "callout": {
      const title = block.title ? `[${literalText(block.title)}]` : "none";
      const panelColor =
        block.panelColor && /^#[0-9a-f]{6}$/iu.test(block.panelColor)
          ? safeColor(block.panelColor)
          : undefined;
      const resolvedIcon = resolveCalloutIcon(block);
      const icon =
        resolvedIcon?.source === "explicit"
          ? `, icon: [${literalText(resolvedIcon.text)}]`
          : resolvedIcon?.source === "semantic-default"
            ? (
                `, icon: [${literalText(resolvedIcon.icon.symbol)}]` +
                `, icon_alt: ${typstString(resolvedIcon.icon.label)}`
              )
            : "";
      const presentation =
        (panelColor ? `, custom_color: rgb(${typstString(panelColor)})` : "")
        + icon;
      const calloutContext: RenderContext = { ...context, container: "calloutCell" };
      value = `#callout(kind: ${typstString(block.kind)}, title: ${title}${presentation})[\n${serializeBlocks(block.content, writer, `${path}.content`, calloutContext)}\n]`;
      break;
    }
    case "expand": {
      const titleText = block.title === undefined ? "[-]" : `[-] ${block.title}`;
      const calloutContext: RenderContext = { ...context, container: "calloutCell" };
      const disclosure =
        `#callout(kind: "panel", title: [${literalText(titleText)}])[\n` +
        `${serializeBlocks(block.content, writer, `${path}.content`, calloutContext)}\n]`;
      value = block.nested
        ? `#block(inset: (left: ${writer.catalogDesign.tokens.layout.adfBlockIndentStep}))[${disclosure}]`
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
        ? `marker: none, body-indent: ${writer.catalogDesign.tokens.layout.taskListBodyIndent}, `
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
      const columnGutter = designLength(
        writer.catalogDesign,
        "pageLayoutColumnGutter"
      );
      const insetX = designLength(writer.catalogDesign, "pageLayoutInsetX");
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
        catalogDesign: context.catalogDesign,
        locale: context.locale,
        comments: context.comments,
      };
      const columns = tableColumns(columnCount, block.columnWidths, block.rows);
      const serializedRows = grid.rows.map((row, rowIndex) => {
        const cells = row.map(({ cell, cellIndex, columnIndex }) => {
          const backgroundColor =
            cell.backgroundColor ??
            (cell.header ? writer.catalogDesign.tokens.colors.tableHeaderBackground : undefined);
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
      const tableMarkup = `#table(columns: ${columns}, inset: (x: ${horizontalInset}pt, y: ${writer.catalogDesign.tokens.layout.tableCellInsetY}), stroke: rgb(${typstString(writer.catalogDesign.tokens.colors.tableStroke)}),\n${rows.join(",\n")}\n)`;
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
    case "chart": {
      // Embed the shared deterministic SVG visual and retain the semantic table
      // immediately below it for tagged-PDF consumers and copy/paste fallback.
      const rows = chartRows(block.chart);
      const columns = Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0));
      // `table(...)` arguments are Typst code mode. Each cell therefore needs
      // a content block around its markup expression; emitting a bare
      // `#text(...)` here makes Typst reject the `#` as invalid code.
      const cells = rows.flatMap((row) => Array.from(
        { length: columns },
        (_, index) => `[${literalText(row[index] ?? "")}]`,
      ));
      const table = `#table(columns: ${columns}, stroke: rgb(${typstString(writer.catalogDesign.tokens.colors.tableStroke)}), ${cells.join(", ")})`;
      const title = block.chart.title ? `#par[${literalText(block.chart.title)}]\n` : "";
      const subtitleSize = readPdfDesignCapability<string>(
        writer.catalogDesign,
        "typography.roles.adfSmallText.size",
      );
      const subtitle = block.chart.subtitle
        ? `#par[#text(size: ${subtitleSize}, style: "italic", fill: rgb(${typstString(writer.catalogDesign.tokens.colors.muted)}))[${literalText(block.chart.subtitle)}]]\n`
        : "";
      const warningPalette = writer.catalogDesign.semanticPalettes.callouts.warning;
      const diagnostics = block.diagnostics?.length
        ? `#block(width: 100%, inset: (x: ${designLength(writer.catalogDesign, "calloutInsetX")}, y: ${designLength(writer.catalogDesign, "calloutInsetY")}), fill: rgb(${typstString(warningPalette.background)}), stroke: rgb(${typstString(warningPalette.foreground)}), radius: ${designLength(writer.catalogDesign, "calloutRadius")})[#text(weight: "bold", fill: rgb(${typstString(warningPalette.foreground)}))[${literalText(`Chart data note: ${block.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}`)}]]\n`
        : "";
      const visual = block.visualAssetPath
        ? `#image(${typstString(block.visualAssetPath)}, width: 100%, alt: ${typstString(block.chart.title ?? "Chart") })\n`
        : "";
      const figureBody = `block(width: 100%)[\n${visual}${table}\n]`;
      value = title + subtitle + diagnostics + (block.caption
        ? `#figure(${figureBody}, ${captionFigureArgs(block.caption, writer)})`
        : `#${figureBody}`);
      break;
    }
    case "divider":
      value = `#line(length: 100%, stroke: rgb(${typstString(writer.catalogDesign.tokens.colors.tableStroke)}))`;
      break;
    case "unknown": {
      // Placeholder floor (spec 004): render a visible placeholder line, then
      // the preserved body/plainBody, instead of silently omitting content.
      const fallbackLabel = block.unsupportedAdf
        ? `Unsupported ADF block: ${block.unsupportedAdf.nodeType}`
        : block.adfExtension
        ? `Extension: ${block.adfExtension.extensionKey}`
        : `${block.macroName} macro not rendered`;
      const placeholder = `#text(style: "italic", fill: rgb(${typstString(writer.catalogDesign.tokens.colors.placeholder)}))[${escapeTypstContent(
        `[${fallbackLabel}]`
      )}]`;
      const parts = [`#par[${placeholder}]`];
      if (block.extensionFrames) {
        block.extensionFrames.forEach((frame, index) => {
          parts.push(
            `#par[#text(style: "italic", fill: rgb(${typstString(writer.catalogDesign.tokens.colors.muted)}))[${literalText(`Frame ${index + 1}`)}]]`,
          );
          parts.push(serializeBlocks(
            frame.content,
            writer,
            `${path}.extensionFrames[${index}].content`,
            context,
          ));
        });
      } else if (block.body && block.body.length > 0) {
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
          serializeBlocks([{
            type: "codeBlock",
            code: text,
            highlight: block.plainBodyHighlight ?? {
              theme: resolveCodeTheme(DEFAULT_CODE_THEME),
              lines: text.split("\n").map((line) => [{ text: line }]),
              skipped: null,
            },
          }], writer, `${path}.plainBody`, context)
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
  if (block.type === "image" || block.type === "mediaFallback") {
    value = mediaFrame(value, block, context);
  }
  if ((block.type === "image" || block.type === "mediaFallback") && block.link) {
    const href = resolveLink(block.link.target, writer.labels);
    if (href) {
      value = href.startsWith("<")
        ? `#link(${href})[${value}]`
        : `#link(${typstString(href)})[${value}]`;
    } else {
      const blocked =
        block.link.target.kind === "external" &&
        !isSafeLinkScheme(block.link.target.href);
      writer.notes.push({
        level: blocked ? "warning" : "info",
        code: blocked ? UNSAFE_LINK_NOTE_CODE : "pdf-link-unresolved",
        message: blocked
          ? `A media link used a blocked scheme and was kept without a clickable target: ${blocksPlainText([block])}`
          : `Media link target could not be represented in PDF: ${blocksPlainText([block])}`,
        source: { blockPath: path },
      });
    }
  }
  if (block.type === "image" || block.type === "mediaFallback") {
    value += annotationMarkers(block.annotations, context.comments);
  }
  return writeMapped(block, writer, path, value, summary);
}

function chartPlainText(chart: import("@atlcli/export-blocks").ChartModelV1): string {
  const data = chart.data;
  if (data.mode === "categories") {
    return [chart.title, ...data.labels, ...data.series.flatMap((series) => [series.label, ...series.values.map(String)])]
      .filter(Boolean).join(" ");
  }
  if (data.mode === "points") {
    return [chart.title, ...data.series.flatMap((series) => [series.label, ...series.points.flatMap((point) => [String(point.x), String(point.y)])])]
      .filter(Boolean).join(" ");
  }
  return [chart.title, ...data.tasks.flatMap((task) => [task.label, task.start, task.end, task.progress === undefined ? "" : `${task.progress * 100}%`])]
    .filter(Boolean).join(" ");
}

function chartRows(chart: import("@atlcli/export-blocks").ChartModelV1): string[][] {
  const data = chart.data;
  if (data.mode === "categories") {
    return [
      ["Label", ...data.series.map((series) => series.label)],
      ...data.labels.map((label, index) => [label, ...data.series.map((series) => String(series.values[index] ?? ""))]),
    ];
  }
  if (data.mode === "points") {
    const keys = [...new Set(data.series.flatMap((series) => series.points.map((point) => `${typeof point.x}:${String(point.x)}`)))];
    const valueAt = (series: (typeof data.series)[number], key: string): string | number => {
      const point = series.points.find((candidate) => `${typeof candidate.x}:${String(candidate.x)}` === key);
      return point?.y ?? "";
    };
    return [
      ["X", ...data.series.map((series) => series.label)],
      ...keys.map((key) => [
        key.slice(key.indexOf(":") + 1),
        ...data.series.map((series) => String(valueAt(series, key))),
      ]),
    ];
  }
  return [
    ["Task", "Start", "End", "Progress"],
    ...data.tasks.map((task) => [task.label, task.start, task.end, task.progress === undefined ? "" : `${Math.round(task.progress * 100)}%`]),
  ];
}

function mediaImageWidth(
  block: Extract<PreparedPdfBlock, { type: "image" }>,
  context: RenderContext,
): string | undefined {
  if (context.mediaWidthOverride) return context.mediaWidthOverride;
  const presentation = block.mediaPresentation;
  if (presentation?.layout === "wide" || presentation?.layout === "full-width") {
    return "100%";
  }
  if (presentation?.width !== undefined) {
    return presentation.widthType === "pixel"
      ? `${presentation.width * 0.75}pt`
      : `${presentation.width}%`;
  }
  return block.width !== undefined ? `${block.width * 0.75}pt` : undefined;
}

function mediaFrame(
  value: string,
  block: Extract<PreparedPdfBlock, { type: "image" | "mediaFallback" }>,
  context: RenderContext,
): string {
  let framed = value;
  if (block.border || block.mediaGroup) {
    const color = block.border?.color.slice(0, 7) ?? context.catalogDesign.tokens.colors.hairline;
    const size =
      block.border?.size !== undefined
        ? `${block.border.size}pt`
        : designLength(context.catalogDesign, "mediaFrameDefaultStroke");
    framed =
      `#block(stroke: ${size} + rgb(${typstString(color)}), ` +
      `inset: ${designLength(context.catalogDesign, "mediaFrameInset")}` +
      `${block.mediaGroup
        ? `, fill: rgb(${typstString(designColor(context.catalogDesign, "mediaGroupBackground"))})`
        : ""})` +
      `[${framed}]`;
  }
  const layout = block.mediaPresentation?.layout;
  if (layout === "wrap-left" || layout === "wrap-right") {
    const side = layout === "wrap-left" ? "left" : "right";
    return context.mediaInWrapGrid ? framed : `#align(${side})[${framed}]`;
  }
  const alignment =
    layout === "align-start"
      ? "left"
      : layout === "align-end"
        ? "right"
        : layout
          ? "center"
          : undefined;
  return alignment ? `#align(${alignment})[${framed}]` : framed;
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
    ...(options.templatePack !== undefined ? { templatePack: options.templatePack } : {}),
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
    catalogDesign: projectPdfDesignThroughCatalog(settings.design),
    locale: documentLocale(options.metadata.language, options.metadata.region),
    comments: new PdfCommentRegistry(),
  };
  const body = serializeBlocks(
    document.blocks,
    writer,
    "blocks",
    rootContext(writer.catalogDesign, writer.locale, writer.comments),
  );
  const commentAppendix = serializeCommentAppendix(writer.comments, writer.catalogDesign);
  // The validated logo travels as a virtual asset file the compiler maps into
  // its filesystem — the same path-emission pattern prepared image assets use.
  // The "atlcli-logo" name cannot collide with prepared assets, whose paths
  // always carry a numeric index and content hash.
  // Issue #118 Phase 1: the settings logo is the fourth asset source (it
  // bypasses preparation), so an explicit profile normalizes it here — same
  // pinned pipeline, SVG logos stay untouched by construction. Template-pack
  // logos are curated, hash-verified payloads and are never re-encoded.
  const logoPpi = options.imageQuality ? resolveEffectivePpi(options.imageQuality) : null;
  const normalizedLogo =
    settings.logo && logoPpi !== null && settings.logo.mediaType === "image/png"
      ? normalizeRasterAssetV1({
          bytes: settings.logo.bytes,
          mediaType: settings.logo.mediaType,
          renderEnvelopeWidthPt: PORTRAIT_TEXT_WIDTH_PT,
          ppi: logoPpi,
        })
      : null;
  const packLogo =
    options.settings?.logo === undefined
      ? options.templatePack?.assets["asset.logo"]
      : undefined;
  const logoAsset: PreparedPdfAsset | undefined = packLogo
    ? {
        path: packLogo.vfsPath,
        bytes: packLogo.bytes,
        mediaType: packLogo.descriptor.mediaType,
      }
    : settings.logo
    ? {
        path:
          settings.logo.mediaType === "image/png"
            ? "assets/atlcli-logo.png"
            : "assets/atlcli-logo.svg",
        bytes:
          normalizedLogo?.kind === "normalized" ? normalizedLogo.bytes : settings.logo.bytes,
        mediaType: settings.logo.mediaType,
      }
    : undefined;
  const templateAssets: PreparedPdfAsset[] = [];
  const mounted = new Set<string>(logoAsset ? [logoAsset.path] : []);
  for (const asset of Object.values(options.templatePack?.assets ?? {})) {
    if (!asset || mounted.has(asset.vfsPath)) continue;
    mounted.add(asset.vfsPath);
    templateAssets.push({
      path: asset.vfsPath,
      bytes: asset.bytes,
      mediaType: asset.descriptor.mediaType,
    });
  }
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

${body}${commentAppendix}
`;

  return {
    main,
    // A pack reaches this branch only after the loader regenerated and
    // byte-compared its canonical source. Locale labels and declared runtime
    // bindings travel through `settings`; the static source is never generated
    // again per document locale.
    template:
      options.templatePack?.canonicalSource.source ??
      createAtlcliTypstTemplate(
        settings.design,
        settings.labels,
        settings.templateVisuals
      ),
    assets: [
      ...document.assets,
      ...(logoAsset ? [logoAsset] : []),
      ...templateAssets,
    ],
    sourceMap: resolveSourceMap(main, writer.sourceMap),
    notes: writer.notes,
    fontRequirements: resolvePdfFontRequirementsV1({
      document,
      metadata: options.metadata,
      settings,
      ...(options.templatePack?.manifest
        ? { manifest: options.templatePack.manifest }
        : options.templateManifest
          ? { manifest: options.templateManifest }
          : {}),
    }),
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

/**
 * ExportBlock[] → OOXML body serializer (spec 004 Task 5).
 *
 * Turns the isomorphic {@link ExportBlock} model (Task 2) into a
 * WordprocessingML fragment for injection at `$scroll.content`. Async because
 * code blocks are colored via lazily-loaded Shiki ({@link highlightCode}); every
 * other block builds synchronously.
 *
 * Image handling is **deferred (v1)**: an `image` block emits NO OOXML and adds
 * a report note ("image skipped — embedding not yet available"), so the output
 * never carries a dangling relationship (PLAN Task 5 / Decision F3).
 */
import type {
  ExportBlock,
  InlineNode,
  ExportNote,
  ListItem,
  TableRow,
} from "@atlcli/confluence/browser";
import { highlightCode } from "./highlight.js";
import {
  calloutTable,
  codeLineParagraph,
  dataTable,
  dividerParagraph,
  hyperlinkField,
  lineBreakRun,
  paragraph,
  resolveHeadingStyleId,
  run,
  statusBadgeRun,
  tableCell,
  type RunStyle,
} from "./ooxml.js";

export interface SerializeContext {
  /** Lower-cased style-name → styleId map from the template's styles.xml. */
  styleNames: Map<string, string>;
}

export interface SerializeResult {
  xml: string;
  notes: ExportNote[];
}

/** Twips of indent per list nesting level. */
const INDENT_STEP = 360;

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function styleFromInline(node: Extract<InlineNode, { type: "text" }>): RunStyle {
  const marks = node.marks ?? [];
  return {
    bold: marks.includes("bold"),
    italic: marks.includes("italic"),
    code: marks.includes("code"),
    strike: marks.includes("strike"),
    underline: marks.includes("underline"),
    subscript: marks.includes("subscript"),
    superscript: marks.includes("superscript"),
    color: node.color,
  };
}

/** Serialize inline nodes to run XML. */
export function serializeInline(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += run(node.text, styleFromInline(node));
        break;
      case "lineBreak":
        out += lineBreakRun();
        break;
      case "status":
        out += statusBadgeRun(node.text || node.color, node.color);
        break;
      case "mention":
        out += run(`@${node.displayName ?? node.accountId}`, { color: "0747A6" });
        break;
      case "link": {
        const innerRuns = serializeInline(
          node.content.length ? node.content : [{ type: "text", text: "" }]
        );
        if (node.target.kind === "external" && node.target.href) {
          // Style inner runs link-like by re-emitting as hyperlink-colored.
          out += hyperlinkField(node.target.href, linkStyledRuns(node.content));
        } else {
          out += linkStyledRuns(node.content) || innerRuns;
        }
        break;
      }
    }
  }
  return out;
}

/** Render link content as underlined blue runs (Word Hyperlink look). */
function linkStyledRuns(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += run(node.text, { ...styleFromInline(node), color: "0563C1", underline: true });
    } else {
      out += serializeInline([node]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paragraph-property injection (indent / borders / marker)
// ---------------------------------------------------------------------------

/**
 * Insert `propsXml` (e.g. `<w:ind/>`, `<w:pBdr/>`) into every paragraph of a
 * fragment. Paragraphs that already carry a `<w:pPr>` (headings, code lines)
 * have the props merged in AFTER an existing `<w:pStyle>` (keeping the schema
 * order pStyle → … → pBdr → ind sane); bare paragraphs get a fresh `<w:pPr>`.
 * Rewriting only bare `<w:p>` — the old behavior — silently skipped styled
 * paragraphs, so a heading inside a blockquote/list lost its indent.
 */
function addParagraphProps(frag: string, propsXml: string): string {
  return frag
    .replace(
      /(<w:p\b[^>]*><w:pPr>)(<w:pStyle\b[^>]*\/>)?/g,
      (_m, open: string, pStyle: string | undefined) => `${open}${pStyle ?? ""}${propsXml}`
    )
    .replace(/(<w:p\b[^>]*>)(?!<w:pPr>)/g, `$1<w:pPr>${propsXml}</w:pPr>`);
}

/**
 * Place a list marker at the start of the first block of an item, regardless of
 * that block's type: for a paragraph/heading (`<w:p …>`) the marker run is
 * inserted after its `<w:pPr>`; when the first block is not a paragraph (a
 * callout table, say) the marker is emitted as its own leading paragraph.
 */
function placeMarker(frag: string, markerRun: string): string {
  if (frag.startsWith("<w:p")) {
    return frag.replace(
      /^(<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?)/,
      `$1${markerRun}`
    );
  }
  return paragraph(markerRun) + frag;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Serialize a block list into an OOXML fragment + report notes. */
export async function serializeBlocks(
  blocks: ExportBlock[],
  ctx: SerializeContext
): Promise<SerializeResult> {
  const notes: ExportNote[] = [];
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(await serializeBlock(block, ctx, notes, 0));
  }
  return { xml: parts.join(""), notes };
}

async function serializeBlock(
  block: ExportBlock,
  ctx: SerializeContext,
  notes: ExportNote[],
  depth: number
): Promise<string> {
  switch (block.type) {
    case "heading":
      return paragraph(serializeInline(block.content), {
        styleId: resolveHeadingStyleId(ctx.styleNames, block.level),
      });

    case "paragraph":
      return paragraph(serializeInline(block.content));

    case "codeBlock": {
      const { lines, skipped } = await highlightCode(block.code, block.language);
      if (skipped) {
        notes.push({
          level: "info",
          code: "code-highlight-skipped",
          message: `Code block${block.language ? ` (${block.language})` : ""} was not syntax-highlighted (${skipped}); rendered as plain monospace.`,
        });
      }
      return lines.map((tokens) => codeLineParagraph(tokens)).join("");
    }

    case "callout": {
      const title = block.title ? run(block.title, { bold: true }) : null;
      const body = await serializeChildren(block.content, ctx, notes, depth + 1);
      return calloutTable(block.kind, title, body);
    }

    case "list":
      return serializeList(block, ctx, notes, depth);

    case "table":
      return serializeTable(block.rows, ctx, notes);

    case "blockquote": {
      const inner = await serializeChildren(block.content, ctx, notes, depth + 1);
      // Indent + left accent bar on EVERY paragraph, including styled ones
      // (headings) that already carry a <w:pPr>.
      const pBdr = `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="DFE1E6"/></w:pBdr>`;
      const ind = `<w:ind w:left="${INDENT_STEP}"/>`;
      return addParagraphProps(inner, `${pBdr}${ind}`);
    }

    case "divider":
      return dividerParagraph();

    case "image":
      notes.push({
        level: "info",
        code: "image-skipped",
        message: `Image ${describeImage(block)} skipped — embedding not yet available.`,
      });
      return "";

    case "unknown":
      return paragraph(run(`[${block.macroName} macro not rendered]`, { italic: true, color: "97A0AF" }));

    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function describeImage(block: Extract<ExportBlock, { type: "image" }>): string {
  return block.source.kind === "attachment" ? `"${block.source.filename}"` : `"${block.source.url}"`;
}

/** Serialize child blocks, joining their fragments. */
async function serializeChildren(
  blocks: ExportBlock[],
  ctx: SerializeContext,
  notes: ExportNote[],
  depth: number
): Promise<string> {
  const parts: string[] = [];
  for (const b of blocks) parts.push(await serializeBlock(b, ctx, notes, depth));
  return parts.join("");
}

// ---- Lists ----------------------------------------------------------------

async function serializeList(
  list: Extract<ExportBlock, { type: "list" }>,
  ctx: SerializeContext,
  notes: ExportNote[],
  level: number
): Promise<string> {
  let out = "";
  let index = 1;
  for (const item of list.items) {
    out += await serializeListItem(item, list.ordered, index, level, ctx, notes);
    index += 1;
  }
  return out;
}

async function serializeListItem(
  item: ListItem,
  ordered: boolean,
  index: number,
  level: number,
  ctx: SerializeContext,
  notes: ExportNote[]
): Promise<string> {
  const marker =
    item.checked === true ? "☑" : item.checked === false ? "☐" : ordered ? `${index}.` : "•";
  const markerRun = run(`${marker} `);
  const indent = INDENT_STEP + level * INDENT_STEP;
  let out = "";
  let markerPlaced = false;

  for (const block of item.content) {
    if (block.type === "list") {
      // Nested lists carry their own (deeper) indent; never the item marker.
      out += await serializeList(block, ctx, notes, level + 1);
      continue;
    }
    // Indent the block under the bullet, then attach the marker to the FIRST
    // rendered block regardless of its type (heading-first items must not get a
    // trailing marker-only paragraph).
    let frag = addParagraphProps(
      await serializeBlock(block, ctx, notes, level + 1),
      `<w:ind w:left="${indent}"/>`
    );
    if (!markerPlaced) {
      frag = placeMarker(frag, markerRun);
      markerPlaced = true;
    }
    out += frag;
  }

  if (!markerPlaced) {
    out += paragraph(markerRun, { extraPPr: `<w:ind w:left="${indent}"/>` });
  }
  return out;
}

// ---- Tables ---------------------------------------------------------------

interface Carry {
  colspan: number;
  rowsRemaining: number;
}

async function serializeTable(
  rows: TableRow[],
  ctx: SerializeContext,
  notes: ExportNote[]
): Promise<string> {
  // The grid grows as needed: a row's width is the columns carried in by
  // rowspans from above PLUS this row's own cells. The naive "widest row by
  // summed colspan" undercounts when a carried rowspan pushes later cells past
  // that width, which dropped those cells. Here every source cell is emitted;
  // rows shorter than the final grid are padded so the table stays rectangular.
  const carry: (Carry | null)[] = [];
  const rowCells: string[] = [];
  const rowWidths: number[] = [];
  let gridCols = 0;

  for (const r of rows) {
    let col = 0;
    let sourceIdx = 0;
    let cellsXml = "";

    // A row is done once every source cell is placed AND no carried rowspan
    // still occupies a column at or beyond the cursor.
    while (sourceIdx < r.cells.length || hasCarryFrom(carry, col)) {
      const active = carry[col];
      if (active) {
        cellsXml += tableCell("", { colspan: active.colspan, vMerge: "continue" });
        active.rowsRemaining -= 1;
        const span = active.colspan;
        if (active.rowsRemaining <= 0) {
          for (let k = col; k < col + span; k++) carry[k] = null;
        }
        col += span;
        continue;
      }

      if (sourceIdx >= r.cells.length) break;
      const cell = r.cells[sourceIdx++];
      const colspan = Math.max(1, cell.colspan);
      const body = await serializeChildren(cell.content, ctx, notes, 1);
      cellsXml += tableCell(body || paragraph(run("")), {
        colspan,
        vMerge: cell.rowspan > 1 ? "restart" : undefined,
        header: cell.header,
      });
      if (cell.rowspan > 1) {
        for (let k = col; k < col + colspan; k++) {
          carry[k] = { colspan, rowsRemaining: cell.rowspan - 1 };
        }
      }
      col += colspan;
    }

    rowCells.push(cellsXml);
    rowWidths.push(col);
    gridCols = Math.max(gridCols, col);
  }
  gridCols = Math.max(1, gridCols);

  // A rowspan that reaches past the last row leaves an active carry: the shape
  // can't be fully represented, so note it rather than corrupt anything.
  if (carry.some((c) => c)) {
    notes.push({
      level: "info",
      code: "table-shape-approximated",
      message: "A table cell's rowspan extended beyond the table; the merge was truncated to the available rows.",
    });
  }

  let rowsXml = "";
  for (let i = 0; i < rowCells.length; i++) {
    let cells = rowCells[i];
    for (let k = rowWidths[i]; k < gridCols; k++) cells += tableCell(paragraph(run("")), {});
    rowsXml += `<w:tr>${cells}</w:tr>`;
  }

  return dataTable(gridCols, rowsXml);
}

/** True if any carried rowspan still occupies a column at or beyond `col`. */
function hasCarryFrom(carry: (Carry | null)[], col: number): boolean {
  for (let k = col; k < carry.length; k++) if (carry[k]) return true;
  return false;
}

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
      const lines = await highlightCode(block.code, block.language);
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
      // Indent the quoted block and add a left bar via each paragraph's pPr is
      // heavy; a single indent conveys the quote acceptably for v1.
      return inner.replace(
        /<w:p>(?!<w:pPr>)/g,
        `<w:p><w:pPr><w:ind w:left="${INDENT_STEP}"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="DFE1E6"/></w:pBdr></w:pPr>`
      );
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
  const indent = INDENT_STEP + level * INDENT_STEP;
  let out = "";
  let firstLineEmitted = false;

  for (const block of item.content) {
    if (block.type === "list") {
      out += await serializeList(block, ctx, notes, level + 1);
      continue;
    }
    if (block.type === "paragraph" && !firstLineEmitted) {
      const runs = `${run(`${marker} `)}${serializeInline(block.content)}`;
      out += paragraph(runs, { extraPPr: `<w:ind w:left="${indent}"/>` });
      firstLineEmitted = true;
      continue;
    }
    // Additional content in the item: indent under the bullet.
    const frag = await serializeBlock(block, ctx, notes, level + 1);
    out += indentFragment(frag, indent);
  }

  if (!firstLineEmitted) {
    out += paragraph(run(`${marker} `), { extraPPr: `<w:ind w:left="${indent}"/>` });
  }
  return out;
}

/** Add a left indent to bare paragraphs of a fragment (best-effort). */
function indentFragment(frag: string, indent: number): string {
  return frag.replace(/<w:p>(?!<w:pPr>)/g, `<w:p><w:pPr><w:ind w:left="${indent}"/></w:pPr>`);
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
  // Total grid columns = widest row by summed colspan.
  let gridCols = 0;
  for (const r of rows) {
    let sum = 0;
    for (const c of r.cells) sum += c.colspan;
    gridCols = Math.max(gridCols, sum);
  }
  gridCols = Math.max(1, gridCols);

  const carry: (Carry | null)[] = new Array(gridCols).fill(null);
  let rowsXml = "";

  for (const r of rows) {
    let col = 0;
    let sourceIdx = 0;
    let cellsXml = "";

    while (col < gridCols) {
      const active = carry[col];
      if (active) {
        // Continuation of a rowspan started above.
        cellsXml += tableCell("", { colspan: active.colspan, vMerge: "continue" });
        active.rowsRemaining -= 1;
        const span = active.colspan;
        if (active.rowsRemaining <= 0) {
          for (let k = col; k < col + span; k++) carry[k] = null;
        }
        col += span;
        continue;
      }

      const cell = r.cells[sourceIdx++];
      if (!cell) {
        cellsXml += tableCell("", {});
        col += 1;
        continue;
      }
      const body = await serializeChildren(cell.content, ctx, notes, 1);
      const colspan = Math.max(1, cell.colspan);
      cellsXml += tableCell(body || paragraph(run("")), {
        colspan,
        vMerge: cell.rowspan > 1 ? "restart" : undefined,
        header: cell.header,
      });
      if (cell.rowspan > 1) {
        for (let k = col; k < col + colspan; k++) carry[k] = { colspan, rowsRemaining: cell.rowspan - 1 };
      }
      col += colspan;
    }
    rowsXml += `<w:tr>${cellsXml}</w:tr>`;
  }

  return dataTable(gridCols, rowsXml);
}

/**
 * ExportBlock[] → OOXML body serializer (spec 004 Task 5).
 *
 * Turns the isomorphic {@link ExportBlock} model (Task 2) into a
 * WordprocessingML fragment for injection at `$scroll.content`. Async because
 * code blocks are colored via lazily-loaded Shiki ({@link highlightCode}); every
 * other block builds synchronously.
 *
 * Image handling goes through the optional {@link SerializeContext.images}
 * seam (spec 005): when a host wires an embedder, an `image` block becomes an
 * inline `<w:drawing>`; when the seam is absent or an embed fails, the block
 * emits NO OOXML and adds a report note instead — so the output never carries
 * a dangling relationship (the spec-004 skip-path invariant).
 */
import type {
  ExportBlock,
  InlineNode,
  ExportNote,
  ListItem,
  TableRow,
} from "@atlcli/confluence";
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

/** The `image` variant of {@link ExportBlock}. */
export type ImageBlock = Extract<ExportBlock, { type: "image" }>;

/** The `codeBlock` variant of {@link ExportBlock} (carries mermaid source). */
export type CodeBlock = Extract<ExportBlock, { type: "codeBlock" }>;

/** Result of one image-embed attempt (spec 005). */
export type ImageEmbedOutcome = { ok: true; xml: string } | { ok: false; reason: string };

/**
 * The serializer's image seam (spec 005): turns an `image` block into an
 * inline-drawing fragment, or reports why it could not. The implementation
 * (asset fetch + zip surgery) lives with the export orchestrator — the
 * serializer stays free of IO and zip state.
 */
export interface ImageEmbedSeam {
  embed(block: ImageBlock): Promise<ImageEmbedOutcome>;
}

/**
 * Result of one diagram-embed attempt (spec 005a). The two non-ok routes are
 * distinguished so the report can name an unsupported diagram TYPE (info)
 * separately from a genuine render/raster/embed failure (warning).
 */
export type DiagramEmbedOutcome =
  | { ok: true; xml: string }
  | { ok: false; route: "unsupported"; diagramType: string }
  | { ok: false; route: "failed"; reason: string };

/**
 * The serializer's diagram seam (spec 005a): turns a mermaid `codeBlock` into
 * an inline-drawing fragment (svgBlip + PNG fallback), or says why it could
 * not. Render + rasterize + zip surgery live with the export orchestrator.
 */
export interface DiagramEmbedSeam {
  embed(block: CodeBlock): Promise<DiagramEmbedOutcome>;
}

export interface SerializeContext {
  /** Lower-cased style-name → styleId map from the template's styles.xml. */
  styleNames: Map<string, string>;
  /** Image embedding seam; absent → images degrade to report notes. */
  images?: ImageEmbedSeam;
  /** Diagram embedding seam; absent → mermaid stays a source code block. */
  diagrams?: DiagramEmbedSeam;
}

/** {@link SerializeContext} plus the document-wide heading promotion offset. */
interface InternalContext extends SerializeContext {
  /**
   * Subtracted from every heading's source `level` so the SHALLOWEST heading in
   * the document maps to Heading 1 ("promotion"; see {@link computeHeadingOffset}).
   */
  headingOffset: number;
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

/**
 * Heading-level normalization ("promotion"), matching Scroll Office.
 *
 * Confluence pages usually omit H1 (the page title is the implicit Heading 1)
 * and start their body headings at H2. Preserving levels would leave the top
 * TOC level empty, so Scroll promotes the SHALLOWEST heading in the document to
 * Heading 1. We do the same: `offset = minLevel - 1`, and every heading's
 * effective level is `block.level - offset` (shallowest → 1).
 *
 * The scan spans the WHOLE block tree — headings nested in callouts,
 * blockquotes, list items and table cells count — so a single document-wide
 * offset governs every heading. A document with no headings yields offset 0
 * (no-op); one already starting at H1 (minLevel 1) also yields offset 0.
 */
function computeHeadingOffset(blocks: ExportBlock[]): number {
  const min = minHeadingLevel(blocks);
  return min === Infinity ? 0 : min - 1;
}

/** Smallest heading `level` anywhere in the tree, or `Infinity` if none. */
function minHeadingLevel(blocks: ExportBlock[]): number {
  let min = Infinity;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        if (block.level < min) min = block.level;
        break;
      case "callout":
      case "blockquote":
        min = Math.min(min, minHeadingLevel(block.content));
        break;
      case "list":
        for (const item of block.items) min = Math.min(min, minHeadingLevel(item.content));
        break;
      case "table":
        for (const row of block.rows)
          for (const cell of row.cells) min = Math.min(min, minHeadingLevel(cell.content));
        break;
    }
  }
  return min;
}

/** Serialize a block list into an OOXML fragment + report notes. */
export async function serializeBlocks(
  blocks: ExportBlock[],
  ctx: SerializeContext
): Promise<SerializeResult> {
  const notes: ExportNote[] = [];
  const parts: string[] = [];
  const internal: InternalContext = { ...ctx, headingOffset: computeHeadingOffset(blocks) };
  for (const block of blocks) {
    parts.push(await serializeBlock(block, internal, notes, 0));
  }
  return { xml: parts.join(""), notes };
}

async function serializeBlock(
  block: ExportBlock,
  ctx: InternalContext,
  notes: ExportNote[],
  depth: number
): Promise<string> {
  switch (block.type) {
    case "heading": {
      // Promote to match Scroll Office: the shallowest heading in the document
      // becomes Heading 1 (see computeHeadingOffset). The EFFECTIVE level drives
      // BOTH the mapped style id and the outline level.
      const effective = block.level - ctx.headingOffset;
      // Clamp the style level to 1..6 (the range template heading styles cover).
      const styleLevel = Math.max(1, Math.min(6, effective));
      // Stamp an explicit outline level IN ADDITION to the template style id.
      // `TOC \o "1-3"` collects paragraphs by OUTLINE LEVEL, not by style name,
      // so a template whose only heading style is a custom name (e.g.
      // `Heading1TOC`) still populates a native Word TOC — the style id supplies
      // the visual look, the outline level supplies the TOC membership (spec 004
      // E2E finding: empty TOC on custom-heading-style templates). Outline levels
      // are 0-based (Heading 1 → 0), clamped to the OOXML 0–8 range.
      const outlineLvl = Math.max(0, Math.min(8, effective - 1));
      return paragraph(serializeInline(block.content), {
        styleId: resolveHeadingStyleId(ctx.styleNames, styleLevel),
        extraPPr: `<w:outlineLvl w:val="${outlineLvl}"/>`,
      });
    }

    case "paragraph":
      return paragraph(serializeInline(block.content));

    case "codeBlock": {
      // A ```mermaid block takes the diagram path (spec 005a); every other
      // language is untouched by this branch.
      if ((block.language ?? "").trim().toLowerCase() === "mermaid") {
        return serializeMermaid(block, ctx, notes);
      }
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

    case "image": {
      if (!ctx.images) {
        notes.push({
          level: "info",
          code: "image-skipped",
          message: `Image ${describeImage(block)} skipped — image embedding is unavailable in this export.`,
        });
        return "";
      }
      const outcome = await ctx.images.embed(block);
      if (outcome.ok) return outcome.xml;
      // Failure branch: no OOXML, so no dangling relationship — the export
      // still succeeds with a report line (spec 005 / 004-F3 invariant).
      notes.push({
        level: "warning",
        code: "image-embed-failed",
        message: `Image ${describeImage(block)} could not be embedded (${outcome.reason}).`,
      });
      return "";
    }

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

/**
 * A mermaid code block: try the diagram path (spec 005a); every non-ok route
 * degrades to the spec-004 pinned fallback — the source as plain monospace
 * code paragraphs, NO `<w:drawing>` ("the reader sees readable diagram
 * source, never a broken image") — plus a report note naming the route.
 */
async function serializeMermaid(
  block: CodeBlock,
  ctx: InternalContext,
  notes: ExportNote[]
): Promise<string> {
  if (!ctx.diagrams) {
    notes.push({
      level: "info",
      code: "diagram-skipped",
      message: "A mermaid diagram was rendered as source — diagram rendering is unavailable in this export.",
    });
    return plainCodeParagraphs(block.code);
  }
  const outcome = await ctx.diagrams.embed(block);
  if (outcome.ok) return outcome.xml;
  if (outcome.route === "unsupported") {
    notes.push({
      level: "info",
      code: "diagram-unsupported",
      message: `${outcome.diagramType} diagrams are not supported; the diagram was rendered as source.`,
    });
  } else {
    notes.push({
      level: "warning",
      code: "diagram-render-failed",
      message: `A mermaid diagram could not be rendered (${outcome.reason}); it was rendered as source.`,
    });
  }
  return plainCodeParagraphs(block.code);
}

/** The diagram fallback: source lines as uncolored monospace code paragraphs. */
function plainCodeParagraphs(code: string): string {
  return code
    .split("\n")
    .map((line) => codeLineParagraph([{ text: line }]))
    .join("");
}

/** Serialize child blocks, joining their fragments. */
async function serializeChildren(
  blocks: ExportBlock[],
  ctx: InternalContext,
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
  ctx: InternalContext,
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
  ctx: InternalContext,
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
  ctx: InternalContext,
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

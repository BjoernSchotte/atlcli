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
  BlockPresentation,
  ExportBlock,
  InlineNode,
  ExportNote,
  ListItem,
  TableCell,
  TablePresentation,
  TableRow,
} from "@atlcli/confluence";
import {
  computeHeadingOffset,
  formatAdfDateTimestamp,
  materializeTable,
  readableTextColor,
  sanitizeAnchorId,
  statusDisplayText,
  uniqueAnchorId,
} from "@atlcli/confluence";
import { highlightCode, warmHighlight } from "./highlight.js";
import {
  bookmarkEnd,
  bookmarkStart,
  calloutTable,
  captionParagraph,
  captionSeqName,
  codeLineParagraph,
  dataTable,
  dividerParagraph,
  hyperlinkField,
  internalHyperlink,
  lineBreakRun,
  pageBreakParagraph,
  paragraph,
  resolveCaptionStyleId,
  resolveHeadingStyleId,
  resolveListStyleId,
  run,
  sectPrParagraph,
  statusBadgeRun,
  synthesizeA4SectPr,
  tableCell,
  toLandscapeSectPr,
  toPortraitSectPr,
  type CaptionLang,
  type RunStyle,
  type TableStyleSource,
} from "./ooxml.js";
import type { Caption } from "@atlcli/confluence";
import { MAX_ILVL, NumberingAllocator } from "./numbering.js";

/** The `image` variant of {@link ExportBlock}. */
export type ImageBlock = Extract<ExportBlock, { type: "image" }>;

/** The `codeBlock` variant of {@link ExportBlock} (carries mermaid source). */
export type CodeBlock = Extract<ExportBlock, { type: "codeBlock" }>;

/**
 * Result of one image-embed attempt (spec 005). A success may carry side
 * notes (spec 006 G4: an SVG that used its default size emits an info note yet
 * still embeds); a failure may name a specific note code + level (spec 006 G4:
 * `image-svg-no-rasterizer` / `image-svg-oversized`) so the report can
 * distinguish them from the generic `image-embed-failed`.
 */
export type ImageEmbedOutcome =
  | { ok: true; xml: string; notes?: ExportNote[] }
  | { ok: false; reason: string; code?: ExportNote["code"]; level?: "info" | "warning" };

/**
 * The serializer's image seam (spec 005): turns an `image` block into an
 * inline-drawing fragment, or reports why it could not. The implementation
 * (asset fetch + zip surgery) lives with the export orchestrator — the
 * serializer stays free of IO and zip state.
 */
export interface ImageEmbedSeam {
  embed(block: ImageBlock): Promise<ImageEmbedOutcome>;
  /**
   * Optional perf hook: start the block's asset fetch NOW, ahead of its
   * document-order {@link embed} call, so downloads overlap each other and
   * the export's other round-trips. Must be side-effect-free on the archive
   * (bytes only) — embedding (and thus relationship-id allocation) still
   * happens in document order via {@link embed}. Never throws.
   */
  prefetch?(block: ImageBlock): void;
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
  /**
   * Optional perf hook: start the block's render + rasterize NOW so the CPU
   * work overlaps the export's network round-trips. Must not touch the
   * archive — embedding stays in document order via {@link embed}. Never
   * throws.
   */
  prefetch?(block: CodeBlock): void;
}

export interface SerializeContext {
  /** Lower-cased style-name → styleId map from the template's styles.xml. */
  styleNames: Map<string, string>;
  /**
   * Native list-numbering allocator (spec 006 G2). Threaded so `w:numPr` /
   * `word/numbering.xml` ids stay export-wide unique. Absent → `serializeBlocks`
   * constructs a zero-based allocator (the standalone-serializer path); the
   * export orchestrator passes one pre-based on the template's existing
   * numbering part so ids never collide.
   */
  numbering?: NumberingAllocator;
  /** Image embedding seam; absent → images degrade to report notes. */
  images?: ImageEmbedSeam;
  /** Diagram embedding seam; absent → mermaid stays a source code block. */
  diagrams?: DiagramEmbedSeam;
  /**
   * The template's body-level `<w:sectPr>` (portrait), cloned by the export
   * orchestrator (spec 003 C6). Threaded so an `orientation` region can emit a
   * section sandwich whose landscape `pgSz` swaps THIS template's actual page
   * dimensions. Absent → the region synthesizes an A4 fallback.
   */
  bodySectPr?: string;
  /**
   * Resolved caption locale (spec 003 C3): explicit option > host locale >
   * `"en"`. Undefined → `"en"`. Drives {@link captionParagraph}'s SEQ label.
   */
  captionLang?: CaptionLang;
  /**
   * BCP-47 locale used for semantic ADF dates. Unlike `captionLang`, this is
   * not narrowed to the currently translated caption-label set.
   */
  dateLocale?: string;
  /**
   * Table style source (spec 006 G3b / B9): `"confluence"` (default) keeps the
   * built-in grid + borders + per-cell shading; `"template"` defers appearance
   * to the resolved template style id. The export orchestrator resolves the
   * style name (`Scroll Table Normal`) to an id before passing it here.
   */
  tableStyle?: TableStyleSource;
}

/** {@link SerializeContext} plus the document-wide heading promotion offset. */
interface InternalContext extends SerializeContext {
  /**
   * Subtracted from every heading's source `level` so the SHALLOWEST heading in
   * the document maps to Heading 1 ("promotion"; see {@link computeHeadingOffset}).
   */
  headingOffset: number;
  /** The active numbering allocator (always present inside the walk). */
  numbering: NumberingAllocator;
  /** Default ink inherited by plain text inside a colored table cell. */
  defaultTextColor?: string;
  /**
   * Per-export bookmark state (spec 002 anchors): the numeric id counter and
   * the set of bookmark NAMES already emitted. A mutable object so the state
   * stays shared when a derived context is spread (`{ ...ctx }`). `used` is
   * what keeps single-page exports (no compose-time registry) free of duplicate
   * bookmark names when two raw anchor names sanitize to the same id.
   */
  bookmarks: { next: number; used: Set<string> };
  /**
   * Per-document caption ordinals: SEQ SEQUENCE NAME → how many captions of
   * that sequence have been emitted so far. Read + incremented by
   * {@link captionXml}, which stamps the next value into the caption's SEQ
   * field as its cached result.
   *
   * Keyed by {@link captionSeqName}, not by {@link Caption.kind}, because that
   * is how WORD scopes a sequence: `code` and `equation` captions both emit
   * `SEQ Listing`, so they share ONE counter and Word's own refresh agrees with
   * what we cached. Figures and tables are independent sequences.
   *
   * A per-context field, deliberately not a module-level counter: a module
   * counter would pass a single-document test and then number the second export
   * in the same process from wherever the first one stopped — a tree export's
   * captions would silently continue a previous export's sequence. Like
   * {@link InternalContext.bookmarks} it is a MUTABLE reference so the state
   * stays shared when a derived context is spread (`{ ...ctx }`) for a table
   * cell or callout — a caption inside a container numbers in document order
   * with the rest.
   */
  captionSeq: Map<string, number>;
  /** Distinct heading style ids emitted so far (spec 006 G1 STYLEREF check). */
  emittedHeadingStyles: Set<string>;
  /**
   * The layout container the current block renders inside (spec 003 C6/C5).
   * `pageBreak`/`orientation` render at `"body"` scope (list items inherit it —
   * lists don't constrain layout controls) but are suppressed (children kept,
   * layout side-effect skipped, note emitted) in `"tableCell"`/`"calloutCell"`,
   * where a section break / page break would split the row.
   */
  container: "body" | "tableCell" | "calloutCell";
}

export interface SerializeResult {
  xml: string;
  notes: ExportNote[];
  /**
   * The distinct heading paragraph style ids the body actually emitted
   * (spec 006 G1). Used to validate STYLEREF fields against the styles this
   * particular export produced after promotion — a template field can name a
   * style no heading in THIS export ends up using.
   */
  headingStyleIds: string[];
}

/** Twips of indent per list nesting level. */
const INDENT_STEP = 360;
/** Half an inch per authored ADF indentation level. */
const ADF_BLOCK_INDENT_STEP = 720;
/** Atlassian Body Small is 12 px, which maps to 9 pt / 18 OOXML half-points. */
const ADF_SMALL_TEXT_HALF_POINTS = 18;
/** Neutral background used when ADF/Storage code marks carry no explicit fill. */
const INLINE_CODE_BACKGROUND = "F4F5F7";

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function styleFromInline(
  node: Extract<InlineNode, { type: "text" }>,
  defaultTextColor?: string,
  fontSizeHalfPoints?: number,
): RunStyle {
  const marks = node.marks ?? [];
  const code = marks.includes("code");
  return {
    bold: marks.includes("bold"),
    italic: marks.includes("italic"),
    code,
    strike: marks.includes("strike"),
    underline: marks.includes("underline"),
    subscript: marks.includes("subscript"),
    superscript: marks.includes("superscript"),
    color: node.color ?? defaultTextColor,
    backgroundColor: node.backgroundColor ?? (code ? INLINE_CODE_BACKGROUND : undefined),
    fontSizeHalfPoints,
  };
}

/** Serialize inline nodes to run XML. */
export function serializeInline(
  nodes: InlineNode[],
  defaultTextColor?: string,
  fontSizeHalfPoints?: number,
  dateLocale = "en",
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += run(node.text, styleFromInline(node, defaultTextColor, fontSizeHalfPoints));
        break;
      case "lineBreak":
        out += lineBreakRun();
        break;
      case "date":
        out += run(` ${formatAdfDateTimestamp(node.timestamp, dateLocale)} `, {
          backgroundColor: "DFE1E6",
          fontSizeHalfPoints,
        });
        break;
      case "status":
        out += statusBadgeRun(statusDisplayText(node), node.color, fontSizeHalfPoints);
        break;
      case "placeholder":
        break;
      case "mention":
        out += run(`@${node.displayName ?? node.accountId}`, {
          color: "0747A6",
          fontSizeHalfPoints,
        });
        break;
      case "link": {
        const innerRuns = serializeInline(
          node.content.length ? node.content : [{ type: "text", text: "" }],
          defaultTextColor,
          fontSizeHalfPoints,
          dateLocale,
        );
        const styled = linkStyledRuns(node.content, fontSizeHalfPoints, dateLocale) || innerRuns;
        if (node.target.kind === "external" && node.target.href) {
          // Style inner runs link-like by re-emitting as hyperlink-colored.
          out += hyperlinkField(node.target.href, linkStyledRuns(node.content, fontSizeHalfPoints, dateLocale));
        } else if (node.target.kind === "anchor") {
          // Internal anchor link → a real in-document jump (spec 002). The
          // anchor is the sanitized destination id compose-document assigned;
          // re-sanitize defensively so a raw single-page anchor still matches
          // the bookmark name the anchor/heading emits.
          out += internalHyperlink(sanitizeAnchorId(node.target.anchor), styled);
        } else {
          out += styled;
        }
        break;
      }
    }
  }
  return out;
}

/** Render link content as underlined blue runs (Word Hyperlink look). */
function linkStyledRuns(nodes: InlineNode[], fontSizeHalfPoints?: number, dateLocale = "en"): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += run(node.text, {
        ...styleFromInline(node, undefined, fontSizeHalfPoints),
        color: "0563C1",
        underline: true,
      });
    } else {
      out += serializeInline([node], undefined, fontSizeHalfPoints, dateLocale);
    }
  }
  return out;
}

function blockPresentationPPr(
  presentation: BlockPresentation | undefined,
): string {
  if (!presentation) return "";
  const indentation = presentation.indentation === undefined
    ? ""
    : `<w:ind w:start="${Math.max(1, Math.min(6, presentation.indentation)) * ADF_BLOCK_INDENT_STEP}"/>`;
  const alignment = presentation.alignment === undefined
    ? ""
    : `<w:jc w:val="${presentation.alignment}"/>`;
  return `${indentation}${alignment}`;
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

// Heading-level promotion ("promotion", matching Scroll Office) now lives once
// in `@atlcli/confluence` (`computeHeadingOffset`, imported above) — the single
// home of the min-heading scan both this engine and the PDF engine consume.

/**
 * Kick off every deferrable cost up front (perf): image asset fetches and
 * diagram render/rasterize runs start through the seams' `prefetch` hooks,
 * and Shiki grammar loading starts for every code-block language — all
 * BEFORE the document-order serialization walk begins. The walk then awaits
 * work that is already in flight instead of paying each cost sequentially.
 * Archive mutation order (and thus relationship-id allocation) is untouched:
 * prefetch hooks produce bytes/fragments only.
 */
function prefetchBlocks(blocks: ExportBlock[], ctx: SerializeContext): void {
  const languages: string[] = [];
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          try {
            ctx.images?.prefetch?.(block);
          } catch {
            // prefetch is best-effort; embed() handles + reports failures
          }
          break;
        case "codeBlock": {
          const lang = (block.language ?? "").trim().toLowerCase();
          if (lang === "mermaid") {
            try {
              ctx.diagrams?.prefetch?.(block);
            } catch {
              // best-effort, see above
            }
          } else if (lang) {
            languages.push(lang);
          }
          break;
        }
        case "callout":
        case "expand":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "layout":
          for (const column of block.columns) walk(column.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  if (languages.length) warmHighlight(languages);
}

/** Serialize a block list into an OOXML fragment + report notes. */
export async function serializeBlocks(
  blocks: ExportBlock[],
  ctx: SerializeContext
): Promise<SerializeResult> {
  const notes: ExportNote[] = [];
  const parts: string[] = [];
  const internal: InternalContext = {
    ...ctx,
    headingOffset: computeHeadingOffset(blocks),
    numbering: ctx.numbering ?? new NumberingAllocator({ abstractNumId: 0, numId: 0 }),
    bookmarks: { next: 1, used: new Set() },
    captionSeq: new Map<string, number>(),
    emittedHeadingStyles: new Set<string>(),
    container: "body",
  };
  prefetchBlocks(blocks, internal);
  for (const block of blocks) {
    parts.push(await serializeBlock(block, internal, notes, 0));
  }
  return {
    xml: coalesceSectPrParagraphs(parts.join("")),
    notes,
    headingStyleIds: [...internal.emittedHeadingStyles],
  };
}

/**
 * One section-closing paragraph immediately followed by another creates an
 * EMPTY section — a spurious blank page (the first closer forces `nextPage`).
 * Two adjacent orientation regions produce exactly that shape: region 1's
 * closing `sectPr` paragraph directly precedes region 2's base-restoring one.
 * Keep the FIRST closer (the region's own) and drop the redundant second: the
 * following content then belongs to the next real section, which carries the
 * correct properties (spec 003 C6 review fix).
 */
const SECTPR_PARA_SRC = String.raw`<w:p><w:pPr>(?:<w:sectPr\b[^>]*\/>|<w:sectPr\b[^>]*>[\s\S]*?<\/w:sectPr>)<\/w:pPr><\/w:p>`;

export function coalesceSectPrParagraphs(xml: string): string {
  const pair = new RegExp(`(${SECTPR_PARA_SRC})(?:${SECTPR_PARA_SRC})`);
  let previous: string;
  do {
    previous = xml;
    xml = xml.replace(pair, "$1");
  } while (xml !== previous);
  return xml;
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
      const headingStyleId = resolveHeadingStyleId(ctx.styleNames, styleLevel);
      ctx.emittedHeadingStyles.add(headingStyleId);
      const headingPara = paragraph(serializeInline(block.content, ctx.defaultTextColor, undefined, ctx.dateLocale), {
        styleId: headingStyleId,
        extraPPr: `${blockPresentationPPr(block.presentation)}<w:outlineLvl w:val="${outlineLvl}"/>`,
      });
      // An explicit anchor (chapter start / in-page heading anchor, spec 002)
      // wraps the heading paragraph in a real bookmark so `w:hyperlink w:anchor`
      // jumps land here. `uniqueAnchorId` sanitizes (composed ids pass through
      // unchanged) AND dedupes per document, so two single-page anchors whose
      // raw names sanitize identically never emit duplicate bookmark names.
      if (block.explicitAnchor) {
        const id = ctx.bookmarks.next++;
        const name = uniqueAnchorId(block.explicitAnchor, ctx.bookmarks.used);
        ctx.bookmarks.used.add(name);
        return `${bookmarkStart(id, name)}${headingPara}${bookmarkEnd(id)}`;
      }
      return headingPara;
    }

    case "paragraph":
      return paragraph(serializeInline(
        block.content,
        ctx.defaultTextColor,
        block.presentation?.fontSize === "small" ? ADF_SMALL_TEXT_HALF_POINTS : undefined,
        ctx.dateLocale,
      ), {
        extraPPr: blockPresentationPPr(block.presentation),
      });

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
      if (block.wrap === false) {
        notes.push({
          level: "info",
          code: "code-nowrap-page-bounded",
          message:
            "A code block requested no wrapping; the bounded DOCX page keeps all source text and may wrap long lines instead of clipping them.",
        });
      }
      const firstLineNumber = block.firstLineNumber ?? 1;
      const lastLineNumber = firstLineNumber + Math.max(0, lines.length - 1);
      const lineNumberWidth = String(lastLineNumber).length;
      const codeXml = lines
        .map((tokens, index) =>
          codeLineParagraph(
            tokens,
            block.hideLineNumbers === false ? firstLineNumber + index : undefined,
            lineNumberWidth,
          )
        )
        .join("");
      // Caption below code (established convention).
      return block.caption ? codeXml + captionXml(block.caption, ctx) : codeXml;
    }

    case "callout": {
      const title = block.title ? run(block.title, { bold: true }) : null;
      const panelColor = block.panelColor?.match(/^#[0-9a-f]{6}$/iu)?.[0].toUpperCase();
      const panelIcon = block.panelIconText || block.panelIcon;
      const body = await serializeChildren(
        block.content,
        { ...ctx, container: "calloutCell" },
        notes,
        depth + 1
      );
      return calloutTable(block.kind, title, body, {
        ...(panelColor !== undefined ? { color: panelColor } : {}),
        ...(panelIcon ? { iconRunsXml: run(panelIcon, { bold: true }) } : {}),
      });
    }

    case "expand": {
      const label = block.title === undefined ? "[-]" : `[-] ${block.title}`;
      const body = await serializeChildren(
        block.content,
        { ...ctx, container: "calloutCell" },
        notes,
        depth + 1
      );
      return calloutTable("panel", run(label, { bold: true }), body);
    }

    case "list":
      // `listLevel` starts at 0 for every list, independent of container
      // `depth` (callouts/blockquotes/table cells don't deepen list nesting).
      return serializeList(block, ctx, notes, depth, 0);

    case "layout":
      return serializeLayout(block, ctx, notes, depth);

    case "table": {
      const materialized = materializeTable(block);
      const tableXml = await serializeTable(
        materialized.rows,
        materialized.columnWidths,
        block.presentation,
        { ...ctx, defaultTextColor: undefined },
        notes
      );
      // Caption above tables (established convention).
      return block.caption ? captionXml(block.caption, ctx) + tableXml : tableXml;
    }

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
      // A captioned image that fails to embed still emits a numbered figure
      // fallback (italic placeholder + the SAME caption paragraph), so the SEQ
      // number is not skipped and downstream captions stay correctly numbered
      // (spec 003 C3). Caption below figures (established convention).
      const cap = block.caption ? captionXml(block.caption, ctx) : "";
      const fallback = () => (block.caption ? imageUnavailablePara(block) + cap : "");
      // DOCX-ONLY fact (spec 010): NO image pipeline was configured for this
      // export, so every image degrades at once. It is `info`, not `warning`,
      // because nothing went wrong — the export was asked to run this way.
      // Deliberately NOT unified with the PDF engine's per-image failure code
      // despite the similar name: PDF cannot reach this state (its
      // `preparePdfDocument` takes a required resolver). The PDF counterpart of
      // the per-image failure below is `image-embed-failed`, which PDF now
      // emits too.
      if (!ctx.images) {
        notes.push({
          level: "info",
          code: "image-skipped",
          message: `Image ${describeImage(block)} skipped — image embedding is unavailable in this export.`,
        });
        return fallback();
      }
      const outcome = await ctx.images.embed(block);
      if (outcome.ok) {
        if (outcome.notes) notes.push(...outcome.notes);
        return outcome.xml + cap;
      }
      // Failure branch: no drawing (no dangling relationship, spec 005 / 004-F3),
      // but keep a numbered fallback when a caption is present. The seam may name
      // a specific code (spec 006 G4 SVG codes) — else the generic one.
      //
      // `image-embed-failed` is the CROSS-ENGINE generic (spec 010): the PDF
      // engine emits the same code from `packages/pdf/src/prepare.ts` when
      // `resolver.resolve` throws. Keep them the same — a consumer counting
      // "images that did not make it into the document" must not need one key
      // per output format.
      notes.push({
        level: outcome.level ?? "warning",
        code: outcome.code ?? "image-embed-failed",
        message: `Image ${describeImage(block)} could not be embedded (${outcome.reason}).`,
      });
      return fallback();
    }

    case "mediaFallback": {
      const fallback = mediaFallbackUnavailablePara(block);
      return block.caption ? fallback + captionXml(block.caption, ctx) : fallback;
    }

    case "unknown": {
      // Stage-4 placeholder floor (spec 004): the placeholder line, followed by
      // the preserved body/plainBody so an unresolved third-party macro never
      // silently drops content ("never silently drop" is spec 004's invariant).
      const placeholder = paragraph(
        run(`[${block.macroName} macro not rendered]`, { italic: true, color: "97A0AF" })
      );
      const MAX_BODY_DEPTH = 20;
      if (block.body && block.body.length > 0) {
        if (depth >= MAX_BODY_DEPTH) {
          notes.push({
            level: "warning",
            code: "macro-body-truncated",
            message: `The "${block.macroName}" macro body was too deeply nested and was truncated.`,
            macroName: block.macroName,
          });
          return placeholder;
        }
        const body = await serializeChildren(block.body, ctx, notes, depth + 1);
        return placeholder + body;
      }
      if (block.plainBody) {
        const MAX_PLAIN = 20000;
        let text = block.plainBody;
        if (text.length > MAX_PLAIN) {
          text = text.slice(0, MAX_PLAIN);
          notes.push({
            level: "warning",
            code: "macro-body-truncated",
            message: `The "${block.macroName}" macro body was truncated at ${MAX_PLAIN} characters.`,
            macroName: block.macroName,
          });
        }
        const code = await serializeBlock({ type: "codeBlock", code: text }, ctx, notes, depth + 1);
        return placeholder + code;
      }
      return placeholder;
    }

    // Real renderings (spec 002 / T1.3).
    case "pageBreak":
      if (ctx.container === "tableCell" || ctx.container === "calloutCell") {
        // A `<w:br w:type="page"/>` inside a `<w:tc>` splits the row/callout,
        // not the page — suppress it (spec 003 C5 container matrix).
        notes.push({
          level: "info",
          code: "pagebreak-suppressed-in-container",
          message: `A page break inside a ${ctx.container === "tableCell" ? "table cell" : "callout"} was suppressed (it would split the layout, not the page).`,
        });
        return "";
      }
      return pageBreakParagraph();

    case "anchor": {
      // A standalone named anchor → a zero-width bookmark at this position, so
      // `page-<id>` chapter-start links and in-page anchor links resolve here.
      // Sanitized + per-document deduped like heading anchors (see above).
      const id = ctx.bookmarks.next++;
      const name = uniqueAnchorId(block.name, ctx.bookmarks.used);
      ctx.bookmarks.used.add(name);
      return `${bookmarkStart(id, name)}${bookmarkEnd(id)}`;
    }

    case "orientation": {
      const children = await serializeChildren(block.content, ctx, notes, depth);
      if (ctx.container === "tableCell" || ctx.container === "calloutCell") {
        // A DOCX section break cannot live inside a `<w:tc>`/`<w:tbl>` — keep
        // the children unstyled and skip the section sandwich (spec 003 C6).
        notes.push({
          level: "info",
          code: "orientation-suppressed-in-container",
          message: `An orientation region inside a ${ctx.container === "tableCell" ? "table cell" : "callout"} was rendered without an orientation change (a section break cannot live there).`,
        });
        return children;
      }
      // Section sandwich: a paragraph carrying the cloned portrait sectPr closes
      // the preceding section, the region's children follow, then a paragraph
      // carrying the landscape/portrait-flipped sectPr closes the region. The
      // pgSz swap reads the template's ACTUAL dimensions (Letter, A4, …).
      const baseSectPr = ctx.bodySectPr ?? synthesizeA4SectPr();
      const regionSectPr = block.landscape
        ? toLandscapeSectPr(baseSectPr)
        : toPortraitSectPr(baseSectPr);
      return sectPrParagraph(baseSectPr) + children + sectPrParagraph(regionSectPr);
    }

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
 * Render a {@link Caption} to a caption paragraph (spec 003 C3), consuming the
 * next ordinal of its SEQ sequence.
 *
 * The SINGLE place a caption ordinal is allocated, and the reason the counters
 * live on the context: this function is called from the walk, so "next ordinal"
 * is by construction "next in document order". Callers must call it exactly
 * once per emitted caption — the `image` branch relies on that by computing the
 * caption ONCE and reusing the same string on both the embedded and the
 * degraded path, so a figure that fails to embed still consumes its number and
 * every later figure keeps the number Word will compute.
 */
function captionXml(caption: Caption, ctx: InternalContext): string {
  const sequence = captionSeqName(caption.kind);
  const ordinal = (ctx.captionSeq.get(sequence) ?? 0) + 1;
  ctx.captionSeq.set(sequence, ordinal);
  return captionParagraph(
    resolveCaptionStyleId(ctx.styleNames),
    caption.kind,
    ctx.captionLang ?? "en",
    serializeInline(caption.content, undefined, undefined, ctx.dateLocale),
    ordinal
  );
}

/** The italic placeholder paragraph for an image that could not be embedded. */
function imageUnavailablePara(block: ImageBlock): string {
  const label = block.alt ?? (block.source.kind === "attachment" ? block.source.filename : block.source.url);
  return paragraph(run(`[Image unavailable: ${label}]`, { italic: true, color: "97A0AF" }));
}

/** Visible non-fetching placeholder for an uncorrelated ADF media identity. */
function mediaFallbackUnavailablePara(
  block: Extract<ExportBlock, { type: "mediaFallback" }>
): string {
  return paragraph(
    run(`[Media unavailable: ${block.alt ?? block.label}]`, {
      italic: true,
      color: "97A0AF",
    })
  );
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

// ---- Lists (spec 006 G2: native w:numPr numbering) ------------------------

/** dxa left indent for a list level's continuation content (matches numbering.xml). */
function listIndent(ilvl: number): number {
  return (ilvl + 1) * 720;
}

/**
 * Serialize one list NODE. `listLevel` is the SEMANTIC nesting depth (drives
 * bullet `w:ilvl`, ordered-list definition indent/format, and one `numId`
 * acquisition per node); `depth` is the generic container depth threaded to
 * child blocks for their own recursion limits.
 *
 * `ctx.numbering.acquire(list.ordered, list.start, listLevel)` runs once per node, lazily (only when a
 * non-task item actually needs a `numId`) — so a nested `<ol>` inside a `<ul>`,
 * or a second logically-separate `<ol>` at the same position, each gets its own
 * type-correct `numId`. Bullets share one multilevel instance; every ordered
 * node restarts at its authored value through a self-contained single-level
 * definition and therefore references `w:ilvl=0`.
 */
async function serializeList(
  list: Extract<ExportBlock, { type: "list" }>,
  ctx: InternalContext,
  notes: ExportNote[],
  depth: number,
  listLevel: number
): Promise<string> {
  if (listLevel > MAX_ILVL && !notes.some((n) => n.code === "list-nesting-clamped")) {
    notes.push({
      level: "info",
      code: "list-nesting-clamped",
      message: `List nesting deeper than ${MAX_ILVL + 1} levels was clamped to level ${MAX_ILVL + 1} (Word's list-level limit); visual indentation is preserved.`,
    });
  }
  let numId: number | undefined;
  const acquire = (): number =>
    (numId ??= ctx.numbering.acquire(list.ordered, list.start ?? 1, Math.min(listLevel, MAX_ILVL)));
  let out = "";
  for (const item of list.items) {
    out += await serializeListItem(item, list.ordered, listLevel, depth, acquire, ctx, notes);
  }
  return out;
}

async function serializeListItem(
  item: ListItem,
  ordered: boolean,
  listLevel: number,
  depth: number,
  acquireNumId: () => number,
  ctx: InternalContext,
  notes: ExportNote[]
): Promise<string> {
  const ilvl = Math.min(listLevel, MAX_ILVL);
  const numberingIlvl = ordered ? 0 : ilvl;
  const semanticMarker = listItemMarker(item);
  const hasSemanticMarker = semanticMarker !== undefined;
  const styleId = resolveListStyleId(ctx.styleNames, ordered, ilvl);
  const contIndent = `<w:ind w:left="${listIndent(ilvl)}"/>`;
  let out = "";
  let firstPlaced = false;

  for (const block of item.content) {
    if (block.type === "list") {
      // A nested list node is its own level — never the item marker/numId.
      out += await serializeList(block, ctx, notes, depth + 1, listLevel + 1);
      continue;
    }
    const frag = await serializeBlock(block, ctx, notes, depth + 1);
    if (!firstPlaced) {
      firstPlaced = true;
      if (hasSemanticMarker) {
        // Task/decision items keep their semantic glyph (Word has no checkbox
        // or decision numbering) but adopt the resolved list paragraph style
        // and level indent.
        const marker = run(semanticMarker);
        out += placeMarker(applyFirstListProps(frag, styleId, undefined, contIndent), marker);
      } else {
        // Numbered/bulleted: real w:numPr, no literal marker, indent from
        // the numbering definition.
        const numPr = `<w:numPr><w:ilvl w:val="${numberingIlvl}"/><w:numId w:val="${acquireNumId()}"/></w:numPr>`;
        out += applyFirstListProps(frag, styleId, numPr, undefined);
      }
    } else {
      // Continuation blocks: level-matched visual indent only, no numPr.
      out += addParagraphProps(frag, contIndent);
    }
  }

  if (!firstPlaced) {
    // An empty item still needs a marked line so numbering is not skipped.
    if (hasSemanticMarker) {
      out += paragraph(run(semanticMarker), {
        styleId,
        extraPPr: contIndent,
      });
    } else {
      const numPr = `<w:numPr><w:ilvl w:val="${numberingIlvl}"/><w:numId w:val="${acquireNumId()}"/></w:numPr>`;
      out += paragraph(run(""), { styleId, extraPPr: numPr });
    }
  }
  return out;
}

function listItemMarker(item: ListItem): string | undefined {
  if (item.kind === "decision") {
    const state = item.state ?? "";
    return state.toUpperCase() === "DECIDED"
      ? "◆ "
      : `◇ [${state}] `;
  }
  if (item.kind === "task" || item.checked !== undefined) {
    const checked = item.checked ?? (item.state === "DONE");
    return `${checked ? "☑" : "☐"} `;
  }
  return undefined;
}

/**
 * Apply list paragraph properties to the FIRST paragraph of an item's first
 * block: a `<w:pStyle>` (unless the paragraph already carries one — a heading
 * keeps its own) plus `propsXml` (either a `<w:numPr>` for numbered/bulleted
 * items or a `<w:ind>` for task items). When the first block is not a
 * paragraph (a callout table), an empty styled paragraph is prepended so the
 * marker/number has somewhere to live (the `placeMarker` special case).
 */
function applyFirstListProps(
  frag: string,
  styleId: string,
  numPrXml: string | undefined,
  indXml: string | undefined
): string {
  const extra = numPrXml ?? indXml ?? "";
  if (!frag.startsWith("<w:p")) {
    return paragraph(run(""), { styleId, extraPPr: extra }) + frag;
  }
  // Insert into the FIRST paragraph only.
  const pStyleTag = `<w:pStyle w:val="${styleId}"/>`;
  // Case: <w:p ...><w:pPr><w:pStyle .../>…  → keep existing pStyle, add extra after it.
  if (/^<w:p\b[^>]*><w:pPr><w:pStyle\b/.test(frag)) {
    return frag.replace(/^(<w:p\b[^>]*><w:pPr><w:pStyle\b[^>]*\/>)/, `$1${extra}`);
  }
  // Case: <w:p ...><w:pPr>… (no pStyle) → add our pStyle + extra at pPr start.
  if (/^<w:p\b[^>]*><w:pPr>/.test(frag)) {
    return frag.replace(/^(<w:p\b[^>]*><w:pPr>)/, `$1${pStyleTag}${extra}`);
  }
  // Case: <w:p ...> (no pPr) → add a fresh pPr.
  return frag.replace(/^(<w:p\b[^>]*>)/, `$1<w:pPr>${pStyleTag}${extra}</w:pPr>`);
}

// ---- Tables ---------------------------------------------------------------

interface Carry {
  colspan: number;
  rowsRemaining: number;
  backgroundColor?: string;
  verticalAlignment?: TableCell["verticalAlignment"];
}

/** Budget caps against malformed/pathological table geometry (spec 006 G3). */
const MAX_TABLE_COLUMNS = 200;
const MAX_TABLE_SPAN = 200;

/** One laid-out cell descriptor (no XML yet — emitted in the render phase). */
interface CellDesc {
  colStart: number;
  colspan: number;
  kind: "source" | "carry" | "padding";
  body?: string;
  header?: boolean;
  backgroundColor?: string;
  verticalAlignment?: TableCell["verticalAlignment"];
  vMerge?: "restart" | "continue";
}

async function serializeLayout(
  block: Extract<ExportBlock, { type: "layout" }>,
  ctx: InternalContext,
  notes: ExportNote[],
  depth: number,
): Promise<string> {
  if (block.columns.length === 0) {
    notes.push({
      level: "warning",
      code: "layout-geometry-fallback",
      message: "An empty page layout produced no visible columns.",
    });
    return "";
  }
  const widthsDxa = layoutWidthsDxa(block.columns.map((column) => column.width));
  const cells = await Promise.all(block.columns.map(async (column, index) => {
    const body = await serializeChildren(
      column.content,
      { ...ctx, container: "tableCell" },
      notes,
      depth + 1,
    );
    return tableCell(body || paragraph(run("")), {
      widthDxa: widthsDxa[index],
      verticalAlignment: column.verticalAlignment,
    });
  }));
  return dataTable(block.columns.length, `<w:tr>${cells.join("")}</w:tr>`, {
    widthsDxa,
    widthDxa: widthsDxa.reduce((sum, width) => sum + width, 0),
    fixedLayout: true,
    borderless: true,
    cellMarginDxa: 120,
  });
}

function layoutWidthsDxa(widths: readonly number[]): number[] {
  if (widths.length === 0) return [];
  const safe = widths.map((width) =>
    Number.isFinite(width) && width > 0 ? width : 0
  );
  const total = safe.reduce((sum, width) => sum + width, 0);
  const weights = total > 0 ? safe : safe.map(() => 1);
  const weightTotal = total > 0 ? total : weights.length;
  const targetWidth = Math.max(9000, widths.length);
  const distributable = targetWidth - widths.length;
  const resolved = weights.map((weight) =>
    1 + Math.round((weight / weightTotal) * distributable)
  );
  const remainder = targetWidth - resolved.reduce((sum, width) => sum + width, 0);
  const adjustmentIndex = resolved.findIndex((width) => width + remainder > 0);
  resolved[adjustmentIndex >= 0 ? adjustmentIndex : 0] += remainder;
  return resolved;
}

/**
 * Serialize a table in two phases (spec 006 G3): a LAYOUT phase produces
 * per-cell descriptors and discovers `gridCols` (colspan/rowspan/carry
 * bookkeeping, budget-guarded), then a RENDER phase — once `gridCols` and the
 * derived width array are final — emits `w:tcW`/`w:gridCol` from the source
 * `columnWidths`. Splitting the passes is required because a cell's `w:tcW`
 * depends on the FINAL grid width, unknown until the last row is laid out.
 */
async function serializeTable(
  rows: TableRow[],
  columnWidths: number[] | undefined,
  presentation: TablePresentation | undefined,
  ctx: InternalContext,
  notes: ExportNote[]
): Promise<string> {
  const carry: (Carry | null)[] = [];
  const rowDescs: CellDesc[][] = [];
  const rowWidths: number[] = [];
  let gridCols = 0;
  let budgetNoted = false;
  const noteBudget = (): void => {
    if (budgetNoted) return;
    budgetNoted = true;
    notes.push({
      level: "warning",
      code: "table-geometry-clamped",
      message: `A table cell's span or the table's column count exceeded safe limits (max ${MAX_TABLE_COLUMNS} columns, span ${MAX_TABLE_SPAN}) and was clamped.`,
    });
  };
  const safeSpan = (raw: number): number => {
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_TABLE_SPAN) {
      if (raw > MAX_TABLE_SPAN || !Number.isSafeInteger(raw)) noteBudget();
      return 1;
    }
    return raw;
  };

  for (const r of rows) {
    let col = 0;
    let sourceIdx = 0;
    const descs: CellDesc[] = [];

    while (sourceIdx < r.cells.length || hasCarryFrom(carry, col)) {
      if (col >= MAX_TABLE_COLUMNS) {
        noteBudget();
        break;
      }
      const active = carry[col];
      if (active) {
        descs.push({
          colStart: col,
          colspan: active.colspan,
          kind: "carry",
          vMerge: "continue",
          backgroundColor: active.backgroundColor,
          verticalAlignment: active.verticalAlignment,
        });
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
      const colspan = safeSpan(Math.max(1, cell.colspan));
      const rowspan = safeSpan(Math.max(1, cell.rowspan));
      const defaultTextColor = cell.backgroundColor
        ? readableTextColor(cell.backgroundColor).slice(1)
        : undefined;
      const body = await serializeChildren(
        cell.content,
        { ...ctx, defaultTextColor, container: "tableCell" },
        notes,
        1
      );
      descs.push({
        colStart: col,
        colspan,
        kind: "source",
        body: body || paragraph(run("")),
        header: cell.header,
        backgroundColor: cell.backgroundColor,
        verticalAlignment: cell.verticalAlignment,
        vMerge: rowspan > 1 ? "restart" : undefined,
      });
      if (rowspan > 1) {
        for (let k = col; k < col + colspan; k++) {
          carry[k] = {
            colspan,
            rowsRemaining: rowspan - 1,
            backgroundColor: cell.backgroundColor,
            verticalAlignment: cell.verticalAlignment,
          };
        }
      }
      col += colspan;
    }

    rowDescs.push(descs);
    rowWidths.push(col);
    gridCols = Math.max(gridCols, col);
  }
  gridCols = Math.max(1, Math.min(gridCols, MAX_TABLE_COLUMNS));

  if (carry.some((c) => c)) {
    notes.push({
      level: "info",
      code: "table-shape-approximated",
      message: "A table cell's rowspan extended beyond the table; the merge was truncated to the available rows.",
    });
  }

  // Render phase: widths are now final. Derive the dxa width array; each cell
  // gets the sum of its spanned columns so the fixed layout is not repaired.
  const widthDxa = tableWidthDxa(presentation);
  const widthsDxa = columnWidthsDxa(columnWidths, gridCols, widthDxa);
  const templateStyle = ctx.tableStyle?.source === "template" && ctx.tableStyle.styleId;
  const spanWidth = (colStart: number, colspan: number): number | undefined => {
    if (!widthsDxa) return undefined;
    let sum = 0;
    for (let k = colStart; k < colStart + colspan && k < widthsDxa.length; k++) sum += widthsDxa[k];
    return sum;
  };
  const emit = (d: CellDesc): string =>
    tableCell(d.kind === "padding" ? paragraph(run("")) : d.body ?? "", {
      colspan: d.colspan,
      vMerge: d.vMerge,
      // Template style mode suppresses inline header/background shading.
      header: templateStyle ? false : d.header,
      backgroundColor: templateStyle ? undefined : d.backgroundColor,
      verticalAlignment: d.verticalAlignment,
      ...(spanWidth(d.colStart, d.colspan) !== undefined ? { widthDxa: spanWidth(d.colStart, d.colspan) } : {}),
    });

  let rowsXml = "";
  for (let i = 0; i < rowDescs.length; i++) {
    let cells = rowDescs[i].map(emit).join("");
    for (let k = rowWidths[i]; k < gridCols; k++) {
      cells += emit({ colStart: k, colspan: 1, kind: "padding" });
    }
    rowsXml += `<w:tr>${cells}</w:tr>`;
  }

  const alignment = tableAlignment(presentation);
  return dataTable(gridCols, rowsXml, {
    ...(widthsDxa ? { widthsDxa } : {}),
    widthDxa,
    ...(alignment ? { alignment } : {}),
    ...(presentation?.displayMode === "fixed" ? { fixedLayout: true } : {}),
    ...(ctx.tableStyle ? { tableStyle: ctx.tableStyle } : {}),
  });
}

/**
 * Scale source `columnWidths` to the fixed 9000-dxa table width (spec 006 G3),
 * or `undefined` for an even split. Mirrors the PDF engine's validation
 * (`packages/pdf/src/serialize.ts` `tableColumns`): length must equal
 * `gridCols`, every width finite and > 0, and the max/min SPREAD must exceed
 * 1.05 — near-equal widths keep the clean even split. Unlike PDF, DOCX does
 * NOT port the `inferredTableTracks` content-length heuristic (predictability
 * over content-sniffing): near-equal/absent-width tables may render differently
 * across the two engines — a documented divergence, not a bug. The rounding
 * remainder is corrected on the last column so the widths sum to exactly 9000.
 */
export function columnWidthsDxa(
  columnWidths: number[] | undefined,
  gridCols: number,
  tableWidthDxa = 9000,
): number[] | undefined {
  if (!Number.isSafeInteger(tableWidthDxa) || tableWidthDxa < 1) return undefined;
  if (!columnWidths || columnWidths.length !== gridCols) return undefined;
  if (!columnWidths.every((w) => Number.isFinite(w) && w > 0)) return undefined;
  const spread = Math.max(...columnWidths) / Math.min(...columnWidths);
  if (spread <= 1.05) return undefined;
  const total = columnWidths.reduce((s, w) => s + w, 0);
  const dxa = columnWidths.map((w) => Math.max(1, Math.round((w / total) * tableWidthDxa)));
  const sum = dxa.reduce((s, w) => s + w, 0);
  dxa[dxa.length - 1] += tableWidthDxa - sum; // absorb the rounding remainder
  if (dxa[dxa.length - 1] < 1) dxa[dxa.length - 1] = 1;
  return dxa;
}

function tableWidthDxa(presentation: TablePresentation | undefined): number {
  const authoredPixels = presentation?.width;
  if (authoredPixels !== undefined && Number.isFinite(authoredPixels) && authoredPixels > 0) {
    return Math.max(1, Math.min(9000, Math.round(authoredPixels * 15)));
  }
  return 9000;
}

function tableAlignment(
  presentation: TablePresentation | undefined,
): "start" | "center" | "end" | undefined {
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
      return undefined;
  }
}

/** True if any carried rowspan still occupies a column at or beyond `col`. */
function hasCarryFrom(carry: (Carry | null)[], col: number): boolean {
  for (let k = col; k < carry.length; k++) if (carry[k]) return true;
  return false;
}

/**
 * Intermediate export model (spec 004 Task 2, also consumed by spec 005 Typst).
 *
 * The markdown converter (`storageToMarkdown`) is a lossy intermediate for
 * document-export purposes: it flattens marks to `**`/`*`, drops table
 * colspan/rowspan, loses status colors, and cannot express Word heading styles.
 * Rich exporters (DOCX, PDF/Typst) instead walk a **structured intermediate
 * model** — {@link ExportBlock}[] with typed inline runs — that both serializers
 * consume. `@atlcli/export-blocks` owns and this module compatibility-re-exports
 * that model; this module owns only the Storage→blocks adapter.
 *
 * Design constraints:
 * - **Isomorphic.** No `node:`/`bun:` specifiers; buildable for the browser
 *   panel (gated via `packages/confluence/src/index.browser.ts`). The parser is
 *   a small self-contained XML tokenizer — no DOMParser (unavailable in bun/MV3
 *   service workers) and no node deps.
 * - **Consumer-neutral.** No DOCX-isms bake in here (no OOXML, no EMU sizing).
 *   The model describes *content*, serializers decide *presentation*.
 * - **Shared macro vocabulary.** Reuses {@link KNOWN_MACROS} from the markdown
 *   converter. Unlike markdown, the rich export model deliberately retains
 *   modern-Cloud `<colgroup>` widths so DOCX/PDF serializers can preserve the
 *   author's table geometry.
 * - **Never silently drop.** Unknown macros become an explicit
 *   {@link UnknownBlock} plus an {@link ExportNote}; raw storage XML is never
 *   passed through verbatim.
 */

import { decodeHTML } from "entities";
import { KNOWN_MACROS } from "./markdown.js";
import { UNSAFE_LINK_NOTE_CODE, sanitizeLinkHref, unsafeLinkMessage } from "./link-safety.js";
import { translateDatasourceLink } from "./datasource.js";
import type { AdfJsonValue } from "./adf-types.js";
import type { BlocksResult } from "./page-body.js";
import {
  isColonEmojiShortName,
  projectTypedEmoji,
  type PortableEmojiProjection,
} from "./emoji-projection.js";

import {
  EXPORT_NOTE_CODES,
  RETIRED_EXPORT_NOTE_CODES,
  SEMANTIC_CALLOUT_ICONS,
  canonicalExportNoteCode,
  formatAdfDateTimestamp,
  inlineMediaDisplayText,
  macroParamText,
  materializeTable,
  mediaFallbackDisplayText,
  mentionDisplayText,
  panelIconDisplayText,
  parseAdfDateTimestamp,
  resolveCalloutIcon,
  smartCardDisplayText,
  statusDisplayText,
  type AdfAnnotationComment,
  type AdfAnnotationIdentity,
  type AdfAnnotationReply,
  type AdfDataConsumerProvenance,
  type AdfExtensionFrame,
  type AdfExtensionIdentity,
  type AdfFragmentIdentity,
  type AdfLinkAttributes,
  type AdfUnsupportedAttribute,
  type AdfUnsupportedMark,
  type AdfUnsupportedNodeProvenance,
  type BlockPresentation,
  type CalloutKind,
  type Caption,
  type CaptionKind,
  type EmojiSemantics,
  type ExportBlock,
  type ExportLink,
  type ExportNote,
  type ExportNoteCode,
  type ExportNoteSource,
  type ImageSource,
  type InlineMark,
  type InlineNode,
  type LayoutBreakout,
  type LayoutColumn,
  type LinkTarget,
  type ListItem,
  type MacroParameter,
  type MacroParamRef,
  type MaterializedTable,
  type MediaBorder,
  type MediaGroupPosition,
  type MediaLayout,
  type MediaPresentation,
  type PageLayout,
  type ResolvedCalloutIcon,
  type SemanticCalloutIcon,
  type SmartCardAppearance,
  type SmartCardSemantics,
  type StandardCalloutKind,
  type SyncedContentProvenance,
  type TableCell,
  type TableDisplayMode,
  type TableLayout,
  type TablePresentation,
  type TableRow,
  type TableVerticalAlignment,
  type UnresolvedMediaIdentity,
} from "@atlcli/export-blocks";

export * from "@atlcli/export-blocks";

export type StorageToBlocksResult = BlocksResult;

/** Options for {@link storageToBlocks}. */
export interface StorageToBlocksOptions {
  /**
   * Exporter identity for `scroll-only` / `scroll-ignore` scoping (spec 003 C4).
   * Answers "which target format is this?" and decides match/mismatch for a
   * macro's own `exporter` parameter. Undefined → apply both macros
   * unconditionally (a macro's `exporter` param cannot mismatch an absent
   * identity), matching the pre-003 default.
   */
  exporter?: "pdf" | "word";
  /**
   * Whether the export-control macros (`scroll-only`/`scroll-ignore`, spec 003
   * C4) filter at all. `"apply"` (default) runs the C4 truth table; the
   * orthogonal `"passthrough"` (CLI `--keep-ignored`) keeps BOTH macro bodies
   * so nothing is dropped — for debugging "why is section X missing?". This is
   * a DIFFERENT axis from {@link exporter}: `exporter` alone cannot implement
   * passthrough, because a `scroll-ignore` with no `exporter` param drops its
   * body regardless of exporter identity.
   */
  exportControls?: "apply" | "passthrough";
  /**
   * The page whose storage is being walked, in a multi-page (tree/space)
   * export. When set, attachment {@link ImageSource}s get `pageId` and every
   * `unknown` block gets `sourcePage`, so a downstream asset resolver / macro
   * renderer can bind to the correct page (spec 002). Unset for single-page
   * export (fields stay absent — output is byte-identical to before).
   *
   * `title`/`url` are additive (spec 003 provenance): when a host threads
   * them, every {@link ExportNote.source} carries `pageTitle`/`pageUrl` too.
   */
  pageContext?: { id: string; version?: number; spaceKey?: string; title?: string; url?: string };
  /**
   * Override the {@link DEFAULT_STORAGE_PARSE_BUDGET} applied while parsing this
   * page's storage (spec 011). Exceeding it throws a {@link StorageParseError},
   * which a tree export can catch per page and degrade to a note.
   */
  parseBudget?: StorageParseBudget;
}

// ---------------------------------------------------------------------------
// Minimal isomorphic XML parser
// ---------------------------------------------------------------------------

export interface XmlText {
  type: "text";
  text: string;
}
export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlText | XmlElement;

/**
 * Resource budget for {@link parseXml} (spec 011 security hardening).
 *
 * `maxPages` (spec 002) bounds how many pages a tree export walks; it says
 * nothing about ONE pathological page. Before this budget existed, a single
 * page whose storage nested 50 000 elements deep would recurse
 * {@link storageToBlocks}'s walkers past the JS stack limit and take the whole
 * process down with a `RangeError` no caller could meaningfully catch.
 *
 * Capping DEPTH at the parse boundary is what makes the walkers safe: the
 * walkers (`walkBlocks` / `handleBlockElement` / `walkInline`) recurse strictly
 * along the tree `parseXml` produced, so a tree that cannot exceed
 * {@link maxDepth} cannot drive them past a few thousand frames. They need no
 * depth counter of their own.
 */
export interface StorageParseBudget {
  /** Maximum total nodes (elements + text) materialized. */
  maxNodes: number;
  /** Maximum element nesting depth. */
  maxDepth: number;
  /** Maximum cumulative decoded text length across all text nodes. */
  maxTextLength: number;
}

/**
 * Default {@link StorageParseBudget}.
 *
 * The budget MUST clear anything Confluence itself accepts. A limit below the
 * platform's own is not a security control, it is an availability bug: an
 * ordinary page that exported yesterday starts throwing, and in a tree export
 * one such page can take the whole run with it.
 *
 * `maxNodes` is therefore DERIVED from measured density rather than guessed.
 * Node counts for 1 MiB of each realistic storage shape, counting exactly what
 * {@link parseXml} materializes (elements + non-empty text nodes):
 *
 * | Shape                              | nodes / MiB |
 * |------------------------------------|-------------|
 * | Colour-span-heavy prose            |      56 375 |
 * | Rich text (marks + links)          |      74 415 |
 * | Nested lists                       |     109 553 |
 * | Tables (3 columns)                 |     126 333 |
 * | Dense tables (4 narrow columns)    |     177 029 |
 *
 * Confluence Cloud accepts a page body of roughly 5 MB. At the densest measured
 * shape that is 177 029 x 5 = 885 145 nodes, so:
 *
 *   maxNodes = 2 000 000  (~2.3x the worst realistic 5 MB page)
 *
 * The previous value of 400 000 sat BELOW the platform limit and rejected a
 * 4 MiB table-heavy page outright — measured, not theorised.
 *
 * The other two:
 *  - `maxDepth: 256` — the deepest real storage is a layout > table > cell >
 *    list > list chain around 20 levels. 256 is far beyond any authored page and
 *    keeps walker recursion in the low thousands of frames. This is the limit
 *    that actually prevents the stack overflow; `maxNodes` only bounds memory.
 *  - `maxTextLength: 16 MiB` — above the platform body limit, so it only fires
 *    on input that was never a real page.
 *
 * At 2 000 000 nodes the materialized tree can reach a few hundred MB, which is
 * the honest cost of accepting every page the platform accepts. Callers that
 * want a tighter bound pass their own budget via
 * {@link StorageToBlocksOptions.parseBudget}.
 */
export const DEFAULT_STORAGE_PARSE_BUDGET: StorageParseBudget = {
  maxNodes: 2_000_000,
  maxDepth: 256,
  maxTextLength: 16 * 1024 * 1024,
};

/** Which {@link StorageParseBudget} limit a {@link StorageParseError} hit. */
export type StorageParseErrorKind = "too-many-nodes" | "too-deep" | "text-too-long";

/**
 * Thrown by {@link parseXml} when a storage fragment exceeds
 * {@link StorageParseBudget}. A typed, catchable error on purpose: a host can
 * degrade one bad page to a visible note and keep exporting the rest of the
 * tree, which a stack overflow never allowed.
 */
export class StorageParseError extends Error {
  constructor(
    readonly kind: StorageParseErrorKind,
    message: string
  ) {
    super(message);
    this.name = "StorageParseError";
  }
}

/**
 * Characters that are illegal in XML 1.0 text: the C0 controls except tab (09),
 * line feed (0A) and carriage return (0D), plus DEL and the two permanently
 * unassigned noncharacters.
 *
 * Confluence storage can carry these via numeric charrefs (`&#x1;`), and they
 * survive entity decoding. They are dropped HERE, at the single parse boundary,
 * because every downstream serializer would otherwise emit them verbatim: an
 * unescaped U+0001 inside a `<w:t>` run produces a `.docx` Word refuses to open
 * with "unreadable content", which is a corrupt-output bug reachable from page
 * content alone.
 */
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;

/**
 * Decode the XML/HTML entities that appear in Confluence storage.
 *
 * Confluence storage is XHTML and may carry any of the ~2000 HTML5 named
 * entities (`&uuml;`, `&szlig;`, `&eacute;`, `&mdash;`, `&hellip;`, ...) plus
 * numeric decimal/hex charrefs. We delegate to `entities` (the isomorphic
 * decoder used by turndown/markdown-it) so the full set resolves; the previous
 * hand-maintained table silently dropped everything outside a dozen names.
 *
 * Note: `&nbsp;` decodes to a real non-breaking space (U+00A0), not a plain
 * 0x20 space -- this is the correct character for Word/DOCX output.
 */
function decodeEntities(text: string): string {
  return decodeHTML(text);
}

/**
 * Parse a Confluence storage fragment into a lightweight node tree.
 *
 * Handles elements (namespaced names like `ac:structured-macro`), attributes,
 * self-closing tags, CDATA sections, comments, XML declarations/DOCTYPE, and
 * entity decoding. Tolerant of unclosed tags (auto-closes at end of input).
 *
 * Exported because a real tree is the only safe way to read nestable storage
 * constructs: a regex that hunts for the next `</ac:structured-macro>` stops at
 * the close tag of a *nested* macro and silently mis-slices the outer one — the
 * same class of bug that the non-greedy `<w:p>` regex caused in the DOCX text-box
 * finding. Reuse this instead of writing another matcher.
 *
 * Bounded by {@link StorageParseBudget} (spec 011): node count, nesting depth
 * and cumulative text length. Text is additionally stripped of characters
 * illegal in XML 1.0 (see {@link XML_ILLEGAL_CHARS}).
 *
 * @throws {StorageParseError} when the fragment exceeds `budget`.
 */
export function parseXml(
  input: string,
  budget: StorageParseBudget = DEFAULT_STORAGE_PARSE_BUDGET
): XmlNode[] {
  const root: XmlElement = { type: "element", name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = input.length;
  let nodeCount = 0;
  let textLength = 0;

  const countNode = () => {
    if (++nodeCount > budget.maxNodes) {
      throw new StorageParseError(
        "too-many-nodes",
        `Page storage exceeds the ${budget.maxNodes}-node parse limit.`
      );
    }
  };

  const pushText = (raw: string, literal: boolean) => {
    if (raw === "") return;
    const decoded = literal ? raw : decodeEntities(raw);
    // Strip AFTER decoding: a control character smuggled in as `&#x1;` is only
    // a control character once decoded.
    const text = decoded.replace(XML_ILLEGAL_CHARS, "");
    if (text === "") return;
    textLength += text.length;
    if (textLength > budget.maxTextLength) {
      throw new StorageParseError(
        "text-too-long",
        `Page storage exceeds the ${budget.maxTextLength}-character text limit.`
      );
    }
    countNode();
    stack[stack.length - 1].children.push({ type: "text", text });
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      pushText(input.slice(i), false);
      break;
    }
    if (lt > i) pushText(input.slice(i, lt), false);

    // CDATA
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const stop = end === -1 ? n : end;
      pushText(input.slice(lt + 9, stop), true);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Comment
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    // Declaration / DOCTYPE / processing instruction
    if (input[lt + 1] === "!" || input[lt + 1] === "?") {
      const end = input.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      pushText(input.slice(lt), false);
      break;
    }
    let tag = input.slice(lt + 1, gt).trim();

    // Closing tag
    if (tag[0] === "/") {
      const name = tag.slice(1).trim().toLowerCase();
      // Pop to the matching open element if present; ignore stray closers.
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    // Opening / self-closing tag
    const selfClosing = tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1).trim();

    const nameMatch = tag.match(/^([A-Za-z][\w:.-]*)/);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const attrs = parseAttributes(tag.slice(nameMatch[1].length));
    countNode();
    const el: XmlElement = { type: "element", name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && !VOID_ELEMENTS.has(name)) {
      stack.push(el);
      // `stack` includes the synthetic `#root`, so its length is depth + 1.
      if (stack.length - 1 > budget.maxDepth) {
        throw new StorageParseError(
          "too-deep",
          `Page storage nests deeper than the ${budget.maxDepth}-level parse limit.`
        );
      }
    }
    i = gt + 1;
  }

  return root.children;
}

/** HTML void elements that never have a closing tag. */
const VOID_ELEMENTS = new Set(["br", "hr", "img", "col", "wbr"]);

/** Parse the attribute portion of a start tag into a lowercased-key map. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const key = m[1].toLowerCase();
    let value = m[2] ?? "";
    if (value && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    // Same XML-1.0 normalization as text nodes: attribute values reach
    // serializers too (link hrefs, macro parameters, anchor names).
    attrs[key] = decodeEntities(value).replace(XML_ILLEGAL_CHARS, "");
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Walk context threaded through the whole storage→blocks traversal. Beyond the
 * note sink it carries the {@link StorageToBlocksOptions.exporter} identity for
 * exporter-scoped decisions (T1.4). A scratch walk replaces ONLY the note sink;
 * it inherits every other field via {@link forkWalkCtx}.
 */
interface WalkCtx {
  notes: ExportNote[];
  /** Exporter identity (from options); undefined for hosts that don't set it. */
  exporter?: "pdf" | "word";
  /**
   * Export-control filtering mode (from options). `"apply"` (default) runs the
   * C4 truth table; `"passthrough"` keeps both `scroll-only`/`scroll-ignore`
   * bodies. An INDEPENDENT field from {@link exporter} — never collapse the two.
   */
  exportControls: "apply" | "passthrough";
  /**
   * Source-page context (from options); undefined for single-page export.
   * Threaded into attachment {@link ImageSource}s and `unknown` blocks.
   */
  pageContext?: { id: string; version?: number; spaceKey?: string; title?: string; url?: string };
  /** True while walking direct content of a Storage table cell/header. */
  inTableCell?: boolean;
  /** True while walking the rich-text body of a Storage expand macro. */
  inExpand?: boolean;
  /**
   * The tree position of the block currently being walked (spec 003
   * provenance), e.g. `blocks[3]` / `blocks[3].content[0]`. Maintained by
   * {@link walkBlocks} (save/restore around each block element); read by
   * {@link noteSource} so notes carry `source.blockPath`.
   */
  blockPath?: string;
}

/**
 * Build a scratch {@link WalkCtx} that reuses every field of `ctx` but swaps in
 * a fresh note sink. The ONLY sanctioned way to construct a scratch context —
 * a hand-built `{ notes: [] }` literal would silently drop `exporter` (and any
 * field added to `WalkCtx` later), producing exporter-blind decisions inside
 * whatever body it walks.
 */
function forkWalkCtx(ctx: WalkCtx, notes: ExportNote[]): WalkCtx {
  return { ...ctx, notes };
}

const HEADING_TAGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** Inline-level element tags (everything else at block scope flushes the buffer). */
const INLINE_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "code",
  "u",
  "s",
  "del",
  "strike",
  "sub",
  "sup",
  "sup",
  "span",
  "a",
  "br",
  "ac:link",
  "ac:emoticon",
  "ac:placeholder",
  "time",
]);

/** Container tags we descend into transparently (their children are block-level). */
const TRANSPARENT_BLOCK_TAGS = new Set([
  "div",
  "ac:layout",
  "ac:layout-cell",
  "ac:adf-extension",
  "ac:adf-node",
  "ac:adf-content",
]);

/**
 * Convert a Confluence storage fragment to the intermediate export model.
 *
 * @param storage - Confluence storage-format XML (a fragment, not a full doc).
 * @param options - Optional exporter identity ({@link StorageToBlocksOptions}).
 * @returns The block tree plus any {@link ExportNote}s for the export report.
 */
export function storageToBlocks(
  storage: string,
  options?: StorageToBlocksOptions
): StorageToBlocksResult {
  const ctx: WalkCtx = {
    notes: [],
    exporter: options?.exporter,
    exportControls: options?.exportControls ?? "apply",
    pageContext: options?.pageContext,
  };
  const nodes = parseXml(storage, options?.parseBudget ?? DEFAULT_STORAGE_PARSE_BUDGET);
  const blocks = walkBlocks(nodes, ctx);
  return { blocks, notes: ctx.notes };
}

/** Flatten an inline list to its plain text (for note messages). */
function inlineText(nodes: InlineNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : "")).join("");
}

/** True if the inline list has any renderable content (not just whitespace). */
function hasMeaningfulInline(nodes: InlineNode[]): boolean {
  return nodes.some((node) => node.type !== "text" || node.text.trim() !== "");
}

/**
 * Trim block-edge whitespace from an inline list: drop whitespace-only runs at
 * the boundaries, then trim the leading/trailing whitespace of the first/last
 * text runs. Interior spacing between runs is preserved.
 */
function trimInline(nodes: InlineNode[]): InlineNode[] {
  const out = nodes.slice();
  while (out.length && out[0].type === "text" && out[0].text.trim() === "") out.shift();
  while (out.length && out[out.length - 1].type === "text" && (out[out.length - 1] as { text: string }).text.trim() === "")
    out.pop();
  if (out.length && out[0].type === "text") {
    const trimmed = out[0].text.replace(/^\s+/, "");
    out[0] = { ...out[0], text: trimmed };
  }
  const last = out.length - 1;
  if (out.length && out[last].type === "text") {
    const node = out[last] as { type: "text"; text: string; marks?: InlineMark[]; color?: string };
    out[last] = { ...node, text: node.text.replace(/\s+$/, "") };
  }
  return out;
}

/**
 * Walk a node list at block scope. Loose inline content (text, marks, links) is
 * grouped into implicit paragraphs; block elements flush the pending buffer.
 * Shared by the fragment root, list items, table cells, callout/quote bodies.
 */
function walkBlocks(nodes: XmlNode[], ctx: WalkCtx): ExportBlock[] {
  const out: ExportBlock[] = [];
  let inlineBuf: XmlNode[] = [];
  // Provenance path prefix (spec 003): the enclosing block's path plus
  // `.content`, or the root `blocks`. Saved/restored around each element so
  // sibling walks after a nested walk see their own prefix again.
  const parentPath = ctx.blockPath === undefined ? "blocks" : `${ctx.blockPath}.content`;
  const savedPath = ctx.blockPath;

  const flush = () => {
    if (inlineBuf.length === 0) return;
    ctx.blockPath = `${parentPath}[${out.length}]`;
    const inline = trimInline(walkInline(inlineBuf, ctx));
    ctx.blockPath = savedPath;
    if (hasMeaningfulInline(inline)) out.push({ type: "paragraph", content: inline });
    inlineBuf = [];
  };

  for (const node of nodes) {
    if (node.type === "text") {
      inlineBuf.push(node);
      continue;
    }
    // A datasource smart link is block-level content wearing an `<a>` tag
    // (`data-card-appearance="block"`). It has to be intercepted HERE, before
    // the inline classification below claims it: the inline `<a>` handler is
    // exactly what produced the raw percent-encoded URL blob this feature
    // replaces. Flushing first keeps any surrounding prose in its own
    // paragraph, the same way an `<ac:image>` inside a `<p>` is split out.
    if (isDatasourceLink(node)) {
      flush();
      ctx.blockPath = `${parentPath}[${out.length}]`;
      out.push(...walkDatasourceLink(node, ctx));
      ctx.blockPath = savedPath;
      continue;
    }
    if (node.name === "ac:adf-node" && storageAdfNodeIsInline(node)) {
      inlineBuf.push(node);
      continue;
    }
    if (INLINE_TAGS.has(node.name) || isInlineMacro(node)) {
      inlineBuf.push(node);
      continue;
    }
    flush();
    ctx.blockPath = `${parentPath}[${out.length}]`;
    out.push(...handleBlockElement(node, ctx));
    ctx.blockPath = savedPath;
  }
  flush();
  // C6 marker shape: convert scroll-landscape/scroll-portrait marker sequences
  // in this sibling stream into body-wrapped orientation regions, so engines
  // consume ONE shape regardless of how the source expressed the region.
  return normalizeOrientationMarkers(out, ctx);
}

/**
 * Marker-shaped orientation blocks (a `scroll-landscape`/`scroll-portrait`
 * macro with NO `ac:rich-text-body`): stateful open/close markers that orient
 * everything up to the matching counter-marker, per the K15t-documented
 * behavior. Tagged here so {@link normalizeOrientationMarkers} can tell a
 * marker from a genuinely empty body-wrapped region.
 */
const ORIENTATION_MARKERS = new WeakSet<object>();

/**
 * C6 marker-sequence normalization (spec 003): fold a marker-shaped
 * `scroll-landscape` … `scroll-portrait` sequence in a sibling block stream
 * into the same body-wrapped `orientation { landscape, content }` block the
 * body-wrapped macro produces — a landscape marker opens a region, a portrait
 * marker ends it, and an unterminated region closes at end-of-stream with the
 * base orientation restored (info note). A portrait marker with no open region
 * matches nothing and is dropped with an info note. No markers → the input
 * array is returned unchanged (byte-identical fast path).
 */
function normalizeOrientationMarkers(blocks: ExportBlock[], ctx: WalkCtx): ExportBlock[] {
  if (!blocks.some((block) => ORIENTATION_MARKERS.has(block))) return blocks;
  const out: ExportBlock[] = [];
  let open: { landscape: boolean; content: ExportBlock[] } | null = null;
  const closeOpen = () => {
    if (!open) return;
    out.push({ type: "orientation", landscape: open.landscape, content: open.content });
    open = null;
  };
  for (const block of blocks) {
    if (ORIENTATION_MARKERS.has(block) && block.type === "orientation") {
      if (block.landscape) {
        // A landscape marker while a region is open closes it first (markers
        // cannot nest — the stateful semantics are strictly sequential).
        closeOpen();
        open = { landscape: true, content: [] };
      } else if (open) {
        closeOpen();
      } else {
        ctx.notes.push(
          withSource(ctx, {
            level: "info",
            code: "orientation-marker-unmatched",
            message: "A scroll-portrait marker had no open landscape region to close; it was ignored.",
            macroName: "scroll-portrait",
          })
        );
      }
      continue;
    }
    if (open) open.content.push(block);
    else out.push(block);
  }
  if (open) {
    closeOpen();
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "orientation-marker-unterminated",
        message: "A scroll-landscape marker region was not closed; it was ended at the end of its content and the base orientation restored.",
        macroName: "scroll-landscape",
      })
    );
  }
  return out;
}

/** The inline-level `scroll-*` export-control macros (C4). */
const INLINE_SCROLL_MACROS = new Set(["scroll-only-inline", "scroll-ignore-inline"]);

/**
 * Inline-level structured macros: `status`, legacy `date`, and the C4
 * export-control inline variants (`scroll-only-inline`/`scroll-ignore-inline`).
 * A block-level walk buffers these into the enclosing implicit paragraph
 * instead of flushing.
 */
function isInlineMacro(node: XmlElement): boolean {
  if (node.name !== "ac:structured-macro") return false;
  const name = (node.attrs["ac:name"] ?? "").toLowerCase();
  return name === "status" || name === "date" || INLINE_SCROLL_MACROS.has(name);
}

function storageLocalId(el: XmlElement): string | undefined {
  return el.attrs["ac:local-id"] ?? el.attrs["local-id"];
}

/** Dispatch a single block-level element to zero or more {@link ExportBlock}s. */
function handleBlockElement(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const name = el.name;

  const headingLevel = HEADING_TAGS[name];
  if (headingLevel) {
    const localId = storageLocalId(el);
    return [{
      type: "heading",
      level: headingLevel,
      content: trimInline(walkInline(el.children, ctx)),
      ...(localId !== undefined ? { localId } : {}),
    }];
  }

  switch (name) {
    case "p": {
      const blocks = walkBlocks(el.children, ctx);
      const localId = storageLocalId(el);
      if (localId !== undefined && blocks.length === 1 && blocks[0]?.type === "paragraph") {
        return [{ ...blocks[0], localId }];
      }
      return blocks;
    }
    case "ac:layout-cell":
      // A paragraph is a transparent block container: this splits an image (or
      // any embedded block) inside a <p> out into its own block while a plain
      // text paragraph collapses back to a single paragraph.
      return walkBlocks(el.children, ctx);
    case "ul":
    case "ol":
      return [walkList(el, ctx)];
    case "ac:task-list":
      return [walkTaskList(el, ctx)];
    case "ac:layout-section":
      return [walkLayoutSection(el, ctx)];
    case "table":
      return [walkTable(el, ctx)];
    case "blockquote":
      return [{ type: "blockquote", content: walkBlocks(el.children, ctx) }];
    case "hr":
      return [{ type: "divider" }];
    case "ac:image":
      return walkImage(el, ctx);
    case "pre":
      // Plain Storage <pre> has no line-number control and historically renders
      // without a gutter. Materialize that source-specific default instead of
      // letting the renderer confuse it with ADF's opposite default.
      return [{ type: "codeBlock", code: elementText(el), hideLineNumbers: true }];
    case "ac:structured-macro":
      return walkMacro(el, ctx);
    case "ac:adf-node":
      return [walkUnsupportedStorageAdfBlock(el, ctx)];
    default:
      if (TRANSPARENT_BLOCK_TAGS.has(name)) return walkBlocks(el.children, ctx);
      // Unknown block-level element: descend rather than drop its content.
      return walkBlocks(el.children, ctx);
  }
}

function storageAdfNodeType(el: XmlElement): string {
  return el.attrs.type?.trim() || "ac:adf-node";
}

function storageAdfNodeIsInline(el: XmlElement): boolean {
  const type = storageAdfNodeType(el).toLowerCase();
  return type === "unsupportedinline" ||
    type === "inlineextension" ||
    type === "inlinecard" ||
    type === "mediainline";
}

function storageAdfValue(el: XmlElement): AdfJsonValue {
  const structured = el.children.filter(
    (child): child is XmlElement =>
      child.type === "element" &&
      (child.name === "ac:adf-attribute" || child.name === "ac:adf-parameter"),
  );
  if (structured.length === 0) return elementText(el);
  return structured.map((child) => ({
    name: child.attrs.key ?? child.attrs["ac:key"] ?? "",
    value: storageAdfValue(child),
  }));
}

function storageAdfProvenance(el: XmlElement): AdfUnsupportedNodeProvenance {
  const attributes: AdfUnsupportedAttribute[] = [];
  for (const [name, value] of Object.entries(el.attrs)) {
    if (name !== "type") attributes.push({ name, value });
  }
  for (const child of el.children) {
    if (child.type !== "element" || child.name !== "ac:adf-attribute") continue;
    attributes.push({
      name: child.attrs.key ?? child.attrs["ac:key"] ?? "",
      value: storageAdfValue(child),
    });
  }
  return {
    nodeType: storageAdfNodeType(el),
    sourceRepresentation: "storage",
    ...(attributes.length > 0 ? { attributes } : {}),
  };
}

function storageAdfContent(el: XmlElement): XmlNode[] {
  const wrapper = childByName(el, "ac:adf-content");
  if (wrapper) return wrapper.children;
  return el.children.filter(
    (child) => child.type !== "element" || child.name !== "ac:adf-attribute",
  );
}

function reportUnsupportedStorageAdf(
  el: XmlElement,
  ctx: WalkCtx,
  placement: "block" | "inline",
): void {
  ctx.notes.push(withSource(ctx, {
    level: "warning",
    code: "adf-node-degraded",
    message:
      `Storage ADF ${placement} wrapper ${storageAdfNodeType(el)} retained its ` +
      "typed provenance and visible fallback.",
  }));
}

function walkUnsupportedStorageAdfBlock(el: XmlElement, ctx: WalkCtx): Extract<ExportBlock, { type: "unknown" }> {
  reportUnsupportedStorageAdf(el, ctx, "block");
  const body = walkBlocks(storageAdfContent(el), ctx);
  return {
    type: "unknown",
    macroName: storageAdfNodeType(el),
    unsupportedAdf: storageAdfProvenance(el),
    ...(body.length > 0 ? { body } : {}),
  };
}

function walkUnsupportedStorageAdfInline(el: XmlElement, ctx: WalkCtx): InlineNode[] {
  reportUnsupportedStorageAdf(el, ctx, "inline");
  const provenance = storageAdfProvenance(el);
  const content = walkInline(storageAdfContent(el), ctx);
  let attached = false;
  const visit = (nodes: InlineNode[]): InlineNode[] =>
    nodes.map((node): InlineNode => {
      if (attached) return node;
      if (node.type === "text") {
        attached = true;
        return {
          ...node,
          unsupportedAdf: [...(node.unsupportedAdf ?? []), provenance],
        };
      }
      if (node.type === "link") return { ...node, content: visit(node.content) };
      return node;
    });
  const retained = visit(content);
  return attached
    ? retained
    : [{
        type: "text",
        text: `[Unsupported ADF inline: ${provenance.nodeType}]`,
        unsupportedAdf: [provenance],
      }, ...retained];
}

const STORAGE_LAYOUT_WIDTHS: Readonly<Record<string, readonly number[]>> = {
  single: [100],
  two_equal: [50, 50],
  two_left_sidebar: [30, 70],
  two_right_sidebar: [70, 30],
  three_equal: [100 / 3, 100 / 3, 100 / 3],
  three_with_sidebars: [20, 60, 20],
};

function walkLayoutSection(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const cells = childrenByName(el, "ac:layout-cell");
  const layoutType = el.attrs["ac:type"]?.trim().toLowerCase();
  const authoredWidths = layoutType ? STORAGE_LAYOUT_WIDTHS[layoutType] : undefined;
  const widths = authoredWidths?.length === cells.length
    ? authoredWidths
    : cells.length > 0
      ? Array.from({ length: cells.length }, () => 100 / cells.length)
      : [];
  if (!authoredWidths || authoredWidths.length !== cells.length) {
    ctx.notes.push(withSource(ctx, {
      level: "warning",
      code: "layout-geometry-fallback",
      message: layoutType
        ? `Storage layout "${layoutType}" has ${cells.length} cells; equal portable widths were used.`
        : "Storage layout has no recognized type; equal portable widths were used.",
    }));
  }
  return {
    type: "layout",
    columns: cells.map((cell, index) => ({
      width: widths[index] ?? 0,
      ...(tableCellVerticalAlignment(cell)
        ? { verticalAlignment: tableCellVerticalAlignment(cell) }
        : {}),
      ...(cell.attrs["ac:local-id"] !== undefined
        ? { localId: cell.attrs["ac:local-id"] }
        : {}),
      content: walkBlocks(cell.children, ctx),
    })),
    ...(el.attrs["ac:local-id"] !== undefined
      ? { localId: el.attrs["ac:local-id"] }
      : {}),
  };
}

/** Collect the concatenated raw text of an element subtree (for code bodies). */
function elementText(el: XmlNode): string {
  if (el.type === "text") return el.text;
  return el.children.map(elementText).join("");
}

/** Find the first direct child element with the given (lowercased) tag name. */
function childByName(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c): c is XmlElement => c.type === "element" && c.name === name);
}

/** All direct child elements with the given tag name. */
function childrenByName(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.type === "element" && c.name === name);
}

/** Read an `<ac:parameter ac:name="…">value</ac:parameter>` off a macro element. */
function macroParam(macro: XmlElement, paramName: string): string | undefined {
  for (const p of childrenByName(macro, "ac:parameter")) {
    if ((p.attrs["ac:name"] ?? "").toLowerCase() === paramName.toLowerCase()) {
      return elementText(p).trim();
    }
  }
  return undefined;
}

/**
 * Build the {@link ExportNoteSource} for a note emitted during this walk from
 * the available page context (spec 003 provenance contract). Returns `undefined`
 * for single-page export (no page context), keeping that output byte-identical.
 */
function noteSource(ctx: WalkCtx): ExportNoteSource | undefined {
  if (!ctx.pageContext) return undefined;
  const source: ExportNoteSource = { pageId: ctx.pageContext.id };
  if (ctx.pageContext.title !== undefined) source.pageTitle = ctx.pageContext.title;
  if (ctx.pageContext.url !== undefined) source.pageUrl = ctx.pageContext.url;
  if (ctx.blockPath !== undefined) source.blockPath = ctx.blockPath;
  return source;
}

/** Attach a provenance source to a note when page context is available. */
function withSource(ctx: WalkCtx, note: ExportNote): ExportNote {
  const source = noteSource(ctx);
  return source ? { ...note, source } : note;
}

// ---- Caption-kind normalization (C3) --------------------------------------

/**
 * Known {@link CaptionKind} values and their case-insensitive aliases. Maps a
 * `scroll-title` `type` parameter (free text) to a closed enum so DOCX's SEQ
 * label and PDF's `figure(kind:)` never diverge. `equation` is deliberately
 * absent — it is rejected until a real math block exists.
 */
const CAPTION_KIND_ALIASES: Readonly<Record<string, CaptionKind>> = {
  figure: "figure",
  fig: "figure",
  image: "figure",
  picture: "figure",
  photo: "figure",
  table: "table",
  tbl: "table",
  code: "code",
  codeblock: "code",
  "code block": "code",
  listing: "code",
  snippet: "code",
};

/** The block types a {@link Caption} can attach to. */
export type CaptionableBlockType = "image" | "table" | "codeBlock";

/** The natural caption kind for a captionable block type. */
function naturalCaptionKind(blockType: CaptionableBlockType): CaptionKind {
  switch (blockType) {
    case "image":
      return "figure";
    case "table":
      return "table";
    case "codeBlock":
      return "code";
  }
}

/**
 * Resolve a free-text caption kind (a `scroll-title` `type` parameter) against a
 * closed {@link CaptionKind} enum (spec 003 C3). Pure and standalone-testable —
 * returns the resolved kind plus an optional warning {@link ExportNote} the
 * caller pushes into the report.
 *
 * - Empty/absent input → the target block's natural kind, no note.
 * - A known value/alias (case-insensitive) → that kind wins even when it
 *   conflicts with the target block type (e.g. `type="table"` on an image), so
 *   DOCX SEQ labels and PDF figure kinds agree on ONE resolved kind.
 * - `equation` (or an unknown value) → falls back to the natural kind + a
 *   warning note. `equation` is rejected until a real math block exists.
 */
export function normalizeCaptionKind(
  raw: string | undefined,
  targetBlockType: CaptionableBlockType
): { kind: CaptionKind; note?: ExportNote } {
  const natural = naturalCaptionKind(targetBlockType);
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { kind: natural };
  const key = trimmed.toLowerCase();
  const mapped = CAPTION_KIND_ALIASES[key];
  if (mapped) return { kind: mapped };
  if (key === "equation" || key === "formula" || key === "math") {
    return {
      kind: natural,
      note: {
        level: "warning",
        code: "caption-kind-unsupported",
        message: `Caption kind "${trimmed}" is not supported yet (no math block exists); it was labeled as "${natural}".`,
      },
    };
  }
  return {
    kind: natural,
    note: {
      level: "warning",
      code: "caption-kind-unknown",
      message: `Unknown caption kind "${trimmed}"; it was labeled as "${natural}".`,
    },
  };
}

// ---- Exporter-parameter matching (C4) -------------------------------------

/** Normalize a macro `exporter` parameter value to a known exporter or null. */
function normalizeExporterValue(raw: string): "pdf" | "word" | null {
  const key = raw.trim().toLowerCase();
  switch (key) {
    case "pdf":
    case "scroll-pdf":
    case "scrollpdf":
      return "pdf";
    case "word":
    case "office":
    case "scroll-word":
    case "scroll-office":
    case "scrollword":
    case "scrolloffice":
    case "docx":
    case "microsoft word":
      return "word";
    default:
      return null;
  }
}

/**
 * Classify a macro's `exporter` parameter against the active exporter identity
 * (spec 003 C4 truth table). `"absent"` covers both a missing parameter and the
 * case where no exporter identity is set (the pre-003 "apply both
 * unconditionally" default — a param cannot mismatch an unknown identity).
 */
function classifyExporterParam(
  raw: string | undefined,
  ctx: WalkCtx
): "absent" | "match" | "mismatch" | "unknown" {
  if (raw === undefined || raw.trim() === "") return "absent";
  const normalized = normalizeExporterValue(raw);
  if (normalized === null) return "unknown";
  if (ctx.exporter === undefined) return "absent";
  return normalized === ctx.exporter ? "match" : "mismatch";
}

// ---- Lists ----------------------------------------------------------------

function walkList(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const ordered = el.name === "ol";
  const items: ListItem[] = [];
  for (const li of childrenByName(el, "li")) {
    const localId = storageLocalId(li);
    items.push({
      content: walkBlocks(li.children, ctx),
      ...(localId !== undefined ? { localId } : {}),
    });
  }
  const rawStart = ordered ? el.attrs.start?.trim() : undefined;
  const parsedStart = rawStart !== undefined && /^\d+$/u.test(rawStart)
    ? Number.parseInt(rawStart, 10)
    : undefined;
  const start = parsedStart !== undefined && Number.isSafeInteger(parsedStart) && parsedStart <= 2_147_483_647
    ? parsedStart
    : undefined;
  return { type: "list", ordered, items, ...(start !== undefined && start !== 1 ? { start } : {}) };
}

function walkTaskList(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const items: ListItem[] = [];
  for (const task of childrenByName(el, "ac:task")) {
    const statusEl = childByName(task, "ac:task-status");
    const statusText = (statusEl ? elementText(statusEl) : "").trim().toLowerCase();
    const body = childByName(task, "ac:task-body");
    const content = body ? walkBlocks(body.children, ctx) : [];
    const checked = statusText === "complete";
    const localIdEl = childByName(task, "ac:task-id");
    const localId = localIdEl ? elementText(localIdEl).trim() : "";
    items.push({
      content,
      kind: "task",
      state: checked ? "DONE" : "TODO",
      ...(localId ? { localId } : {}),
      checked,
    });
  }
  const localId = el.attrs["ac:local-id"]?.trim();
  return {
    type: "list",
    ordered: false,
    listKind: "task",
    ...(localId ? { localId } : {}),
    items,
  };
}

// ---- Tables ---------------------------------------------------------------

/** Convert a CSS absolute length to a common pixel-like weight. */
function parseColumnWidth(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(px|pt|pc|in|cm|mm|%)?$/i);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  switch ((match[2] ?? "px").toLowerCase()) {
    case "pt": return amount * (96 / 72);
    case "pc": return amount * 16;
    case "in": return amount * 96;
    case "cm": return amount * (96 / 2.54);
    case "mm": return amount * (96 / 25.4);
    case "%":
    case "px":
    default: return amount;
  }
}

function tableColumnWidths(table: XmlElement): number[] | undefined {
  const colgroup = table.children.find(
    (child): child is XmlElement => child.type === "element" && child.name === "colgroup"
  );
  if (!colgroup) return undefined;
  const widths: number[] = [];
  for (const child of colgroup.children) {
    if (child.type !== "element" || child.name !== "col") continue;
    const styleWidth = child.attrs.style?.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1];
    const width = parseColumnWidth(styleWidth ?? child.attrs.width);
    if (width === undefined) return undefined;
    const span = parsePositiveInt(child.attrs.span) ?? 1;
    for (let index = 0; index < span; index += 1) widths.push(width);
  }
  return widths.length > 0 ? widths : undefined;
}

const EXPORT_NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  white: "#FFFFFF",
  maroon: "#800000",
  red: "#FF0000",
  purple: "#800080",
  fuchsia: "#FF00FF",
  green: "#008000",
  lime: "#00FF00",
  olive: "#808000",
  yellow: "#FFFF00",
  navy: "#000080",
  blue: "#0000FF",
  teal: "#008080",
  aqua: "#00FFFF",
  orange: "#FFA500",
};

/** Normalize an export color to `#RRGGBB`; invalid/transparent values are omitted. */
export function normalizeExportColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "transparent") return undefined;

  const hex = raw.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (hex) return `#${hex[1].toUpperCase()}`;

  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    const expanded = short[1].split("").map((digit) => `${digit}${digit}`).join("");
    return `#${expanded.toUpperCase()}`;
  }

  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i);
  if (rgb) {
    const channels = rgb.slice(1, 4).map((channel) => Number.parseInt(channel!, 10));
    if (channels.some((channel) => channel < 0 || channel > 255)) return undefined;
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }

  return EXPORT_NAMED_COLORS[raw.toLowerCase()];
}

/** Choose the document's light/dark ink for readable text on a source cell fill. */
export function readableTextColor(backgroundColor: string): "#FFFFFF" | "#172B4D" {
  const normalized = normalizeExportColor(backgroundColor) ?? "#FFFFFF";
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  // YIQ matches the editor's practical light/dark split for its muted table palette.
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness < 160 ? "#FFFFFF" : "#172B4D";
}

function tableCellBackground(cell: XmlElement): string | undefined {
  const styleColor = (cell.attrs.style ?? "")
    .match(/(?:^|;)\s*background-color\s*:\s*([^;]+)/i)?.[1];
  return normalizeExportColor(
    cell.attrs["data-highlight-colour"]
      ?? cell.attrs["data-highlight-color"]
      ?? cell.attrs["data-background-color"]
      ?? styleColor
      ?? cell.attrs.bgcolor
  );
}

function tableCellVerticalAlignment(cell: XmlElement): TableVerticalAlignment | undefined {
  const styleAlignment = (cell.attrs.style ?? "")
    .match(/(?:^|;)\s*vertical-align\s*:\s*([^;]+)/i)?.[1]
    ?.trim()
    .toLowerCase();
  const value = (cell.attrs.valign ?? styleAlignment)?.trim().toLowerCase();
  if (value === "top" || value === "middle" || value === "bottom") return value;
  return undefined;
}

function tableLayout(value: string | undefined): TableLayout | undefined {
  if (
    value === "default" ||
    value === "wide" ||
    value === "full-width" ||
    value === "center" ||
    value === "align-start" ||
    value === "align-end"
  ) return value;
  return undefined;
}

function walkTable(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const rows: TableRow[] = [];
  const rowEls: XmlElement[] = [];
  // Rows may sit under <thead>/<tbody> or directly under <table>.
  const collectRows = (parent: XmlElement) => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      if (child.name === "tr") rowEls.push(child);
      else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") collectRows(child);
    }
  };
  collectRows(el);

  for (const tr of rowEls) {
    const cells: TableCell[] = [];
    for (const cell of tr.children) {
      if (cell.type !== "element") continue;
      if (cell.name !== "td" && cell.name !== "th") continue;
      const backgroundColor = tableCellBackground(cell);
      const verticalAlignment = tableCellVerticalAlignment(cell);
      cells.push({
        header: cell.name === "th",
        colspan: parsePositiveInt(cell.attrs.colspan) ?? 1,
        rowspan: parsePositiveInt(cell.attrs.rowspan) ?? 1,
        ...(backgroundColor ? { backgroundColor } : {}),
        ...(verticalAlignment ? { verticalAlignment } : {}),
        ...(cell.attrs["ac:local-id"] !== undefined ? { localId: cell.attrs["ac:local-id"] } : {}),
        content: walkBlocks(cell.children, { ...ctx, inTableCell: true }),
      });
    }
    rows.push({
      cells,
      ...(tr.attrs["ac:local-id"] !== undefined ? { localId: tr.attrs["ac:local-id"] } : {}),
    });
  }
  const columnWidths = tableColumnWidths(el);
  const layout = tableLayout(el.attrs["data-layout"]);
  const localId = el.attrs["ac:local-id"];
  const presentation: TablePresentation = {
    ...(layout !== undefined ? { layout } : {}),
    ...(localId !== undefined ? { localId } : {}),
  };
  return {
    type: "table",
    rows,
    ...(columnWidths ? { columnWidths } : {}),
    ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---- Images ---------------------------------------------------------------

function walkImage(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const attachment = childByName(el, "ri:attachment");
  const url = childByName(el, "ri:url");
  const alt = el.attrs["ac:alt"] ?? el.attrs["ac:title"] ?? undefined;
  const width = parsePositiveInt(el.attrs["ac:width"]);
  const height = parsePositiveInt(el.attrs["ac:height"]);

  let source: ImageSource | undefined;
  if (attachment && attachment.attrs["ri:filename"]) {
    // In a multi-page export, bind the attachment to its source page so a
    // multiplexing asset resolver fetches from the right page. Only set the
    // field when a page context is present, so single-page output is unchanged.
    source = ctx.pageContext
      ? { kind: "attachment", filename: attachment.attrs["ri:filename"], pageId: ctx.pageContext.id }
      : { kind: "attachment", filename: attachment.attrs["ri:filename"] };
  } else if (url && url.attrs["ri:value"]) {
    source = { kind: "external", url: url.attrs["ri:value"] };
  }

  if (!source) {
    ctx.notes.push({
      level: "warning",
      code: "image-unresolved",
      message: "An <ac:image> had no resolvable attachment or URL reference and was skipped.",
    });
    return [];
  }
  return [{ type: "image", source, alt: alt || undefined, width, height }];
}

// ---- Macros (block) -------------------------------------------------------

const CALLOUT_KINDS = new Set<CalloutKind>([
  "info",
  "note",
  "warning",
  "tip",
  "success",
  "error",
  "panel",
]);

function walkMacro(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const macroName = (el.attrs["ac:name"] ?? "").toLowerCase();

  // Callouts + generic panel.
  if (CALLOUT_KINDS.has(macroName as CalloutKind)) {
    const body = childByName(el, "ac:rich-text-body");
    const title = macroParam(el, "title");
    const suppressDefaultIcon =
      macroName !== "panel" && macroParam(el, "icon")?.trim().toLowerCase() === "false";
    return [
      {
        type: "callout",
        kind: macroName as CalloutKind,
        ...(title ? { title } : {}),
        ...(suppressDefaultIcon ? { suppressDefaultIcon: true } : {}),
        content: body ? walkBlocks(body.children, ctx) : [],
      },
    ];
  }

  // Code / noformat → code block (language preserved).
  if (macroName === "code" || macroName === "noformat") {
    const bodyEl = childByName(el, "ac:plain-text-body") ?? childByName(el, "ac:rich-text-body");
    const code = bodyEl ? elementText(bodyEl) : "";
    const language = macroName === "code" ? macroParam(el, "language") : undefined;
    const title = macroName === "code" ? macroParam(el, "title") : undefined;
    const collapse = macroName === "code" ? macroParam(el, "collapse") : undefined;
    const lineNumbers = macroName === "code" && macroParam(el, "linenumbers")?.toLowerCase() === "true";
    const firstLineNumber =
      lineNumbers ? parsePositiveInt(macroParam(el, "firstline")) ?? 1 : undefined;
    return [{
      type: "codeBlock",
      language: language || undefined,
      code,
      ...(title !== undefined ? { title } : {}),
      ...(collapse !== undefined
        ? { initiallyCollapsed: collapse.trim().toLowerCase() === "true" }
        : {}),
      hideLineNumbers: !lineNumbers,
      ...(firstLineNumber !== undefined ? { firstLineNumber } : {}),
      ...(storageLocalId(el) !== undefined ? { localId: storageLocalId(el) } : {}),
    }];
  }

  // Expand: retain the disclosure boundary and title. Static targets render
  // the body open; an expand inside a table cell or another expand is the
  // Storage counterpart of ADF `nestedExpand`.
  if (macroName === "expand") {
    const body = childByName(el, "ac:rich-text-body");
    ctx.notes.push(withSource(ctx, {
      level: "info",
      code: "expand-static",
      message: "Interactive expand content was rendered open in the static export.",
    }));
    return [{
      type: "expand",
      nested: ctx.inTableCell === true || ctx.inExpand === true,
      ...(macroParam(el, "title") !== undefined ? { title: macroParam(el, "title") } : {}),
      ...(el.attrs["ac:local-id"] !== undefined
        ? { localId: el.attrs["ac:local-id"] }
        : {}),
      ...(el.attrs["ac:macro-id"] !== undefined
        ? { macroId: el.attrs["ac:macro-id"] }
        : {}),
      content: body ? walkBlocks(body.children, { ...ctx, inExpand: true }) : [],
    }];
  }

  // Legacy Confluence layout macros are structural containers, not document
  // content. Flatten them exactly like modern `<ac:layout>` cells: a `section`
  // contains one or more `column` macros, and each column contributes its rich
  // body in source order. Sending either wrapper through the unknown-macro
  // fallback leaked user-visible "[section/column macro not rendered]" lines
  // into DOCX/PDF even though all nested content was available.
  if (macroName === "section" || macroName === "column") {
    const body = childByName(el, "ac:rich-text-body");
    return body ? walkBlocks(body.children, ctx) : [];
  }

  // Multiexcerpt DEFINITION (`multiexcerpt-macro`/`multiexcerpt`, spec 004 E4):
  // the macro that defines a named excerpt on its page renders its body
  // transparently, same one-line treatment as `expand`. The *include*-side
  // macros are resolved by the spec-004 renderer registry, not here.
  if (macroName === "multiexcerpt-macro" || macroName === "multiexcerpt") {
    const body = childByName(el, "ac:rich-text-body");
    return body ? walkBlocks(body.children, ctx) : [];
  }

  // Anchor macro (`<ac:structured-macro ac:name="anchor">`): the anchor name is
  // the macro's first (unnamed) parameter. Map it to the typed `anchor` block so
  // the composition anchor rewrite (spec 002) can register it as a jump target,
  // instead of dropping it into the unknown-macro placeholder branch below (which
  // silently loses every explicit Scroll/Confluence anchor).
  if (macroName === "anchor") {
    const name = macroParam(el, "");
    if (name) return [{ type: "anchor", name }];
    // A nameless anchor macro anchors nothing — fall through to unknown capture.
  }

  // C4: scroll-only / scroll-ignore export-control macros. The filter is a
  // content decision made ONCE here (BASELINE-DESIGN C4b) so the engines never
  // duplicate identical drop-logic for a block that never renders.
  if (macroName === "scroll-only" || macroName === "scroll-ignore") {
    return walkExportControlMacro(el, macroName, ctx);
  }

  // C5: scroll-pagebreak → a hard page break the engines render natively.
  if (macroName === "scroll-pagebreak") {
    return [{ type: "pageBreak" }];
  }

  // C6: scroll-landscape / scroll-portrait → an orientation region. Body-wrapped
  // shape (verified assumption, see fixtures); nested regions collapse to the
  // outer one + a warning note.
  if (macroName === "scroll-landscape" || macroName === "scroll-portrait") {
    return walkOrientationMacro(el, macroName === "scroll-landscape", ctx);
  }

  // C3: scroll-title → a Caption attached to the first captionable block of its
  // body (native numbering: Word SEQ fields, Typst figure counters).
  if (macroName === "scroll-title") {
    return walkScrollTitleMacro(el, ctx);
  }

  // Anything else is an unknown/unhandled macro → explicit block + note. We
  // consult KNOWN_MACROS (shared with the converter) only to grade the note.
  const known = KNOWN_MACROS.includes(macroName);
  ctx.notes.push({
    level: known ? "info" : "warning",
    code: known ? "macro-not-rendered" : "unknown-macro",
    message: known
      ? `The "${macroName}" macro is recognized but has no rich-export rendering; it was emitted as a placeholder.`
      : `Unknown macro "${macroName}" was emitted as a placeholder (no raw XML passthrough).`,
    macroName,
  });

  // Lossless capture: keep parameters (typed, ordered), the plain-text body,
  // the recursively-walked rich-text body, and the macro id — so any future
  // renderer (Lane E) can act on the macro instead of only its name.
  const block: Extract<ExportBlock, { type: "unknown" }> = {
    type: "unknown",
    macroName: macroName || "unknown",
  };

  const params = captureMacroParams(el);
  if (params.length > 0) block.params = params;

  const plainBodyEl = childByName(el, "ac:plain-text-body");
  if (plainBodyEl) block.plainBody = elementText(plainBodyEl);

  const bodyEl = childByName(el, "ac:rich-text-body");
  if (bodyEl) {
    const scratchNotes: ExportNote[] = [];
    const body = walkBlocks(bodyEl.children, forkWalkCtx(ctx, scratchNotes));
    if (body.length > 0) block.body = body;
    // Keep the scratch observations on the block (never merged into ctx.notes,
    // so the top-level report stays byte-identical) rather than discarding them.
    if (scratchNotes.length > 0) block.bodyNotes = scratchNotes;
  }

  const macroId = el.attrs["ac:macro-id"];
  if (macroId !== undefined) block.macroId = macroId;

  // Cross-plan sync point (specs 004/010): bind the macro to its source page in
  // a multi-page export so page-context resolution targets the right page. Only
  // set when a page context is present, keeping single-page output unchanged.
  if (ctx.pageContext) {
    block.sourcePage = {
      id: ctx.pageContext.id,
      ...(ctx.pageContext.version !== undefined ? { version: ctx.pageContext.version } : {}),
      ...(ctx.pageContext.spaceKey !== undefined ? { spaceKey: ctx.pageContext.spaceKey } : {}),
    };
  }

  return [block];
}

// ---------------------------------------------------------------------------
// Datasource smart links
// ---------------------------------------------------------------------------

/** True for an `<a>` carrying a non-empty `data-datasource` attribute. */
function isDatasourceLink(node: XmlElement): boolean {
  return node.name === "a" && (node.attrs["data-datasource"] ?? "").trim() !== "";
}

/**
 * Render a datasource smart link's fallback: the link itself, exactly as the
 * inline `<a>` handler would have produced it (same scheme policy, same display
 * text). Used both as the degradation output and as the `body` of the emitted
 * macro block — so if the macro chain later cannot reach Jira, the placeholder
 * floor still shows the user a working link instead of a bare placeholder.
 */
function datasourceFallbackBlocks(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const href = el.attrs.href ?? "";
  const inner = walkInline(el.children, ctx);
  const display = hasMeaningfulInline(inner) ? inner : [{ type: "text" as const, text: href }];
  const verdict = sanitizeLinkHref(href);
  if (!verdict.safe) {
    ctx.notes.push(
      withSource(ctx, {
        level: "warning",
        code: UNSAFE_LINK_NOTE_CODE,
        message: unsafeLinkMessage(verdict, inlineText(display)),
      })
    );
    return hasMeaningfulInline(display) ? [{ type: "paragraph", content: display }] : [];
  }
  return [
    {
      type: "paragraph",
      content: [{ type: "link", target: { kind: "external", href }, content: display }],
    },
  ];
}

/**
 * Walk an `<a data-datasource>` element (spec SUPPORT-DATASOURCE-JIRA).
 *
 * A supported provider becomes the SAME `{ type: "unknown", macroName, params }`
 * shape the macro extractor emits, so the existing spec-004 fallback chain —
 * renderer, `sourcePage` binding, dedup cache, circuit breaker, session ports —
 * renders it with no second code path. Everything else keeps the link and says
 * why in a typed note; nothing here is ever silent, and nothing here throws.
 */
function walkDatasourceLink(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const href = el.attrs.href ?? "";
  const outcome = translateDatasourceLink(el.attrs["data-datasource"] ?? "", href);

  if (outcome.kind === "degrade") {
    ctx.notes.push(
      withSource(ctx, {
        level: outcome.level,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.provider ? { macroName: outcome.provider.macroName ?? outcome.provider.id } : {}),
      })
    );
    return datasourceFallbackBlocks(el, ctx);
  }

  const macroName = outcome.macroName;
  // The macro-resolution pass pairs the i-th walker macro note with the i-th
  // `unknown` block POSITIONALLY (`resolve.ts`, reconcileNotes). Emitting an
  // unknown block without its paired note here would shift every later macro's
  // note onto the wrong instance — so this note is structural, not decorative.
  //
  // Always the RECOGNIZED-macro note: this branch is reachable only for a
  // `supported` provider, i.e. only when a renderer for `macroName` exists by
  // construction. `KNOWN_MACROS` is deliberately NOT consulted — it is the
  // *markdown* converter's vocabulary of real Confluence macros, and
  // `confluence-list` is a synthetic routing name with no macro behind it.
  ctx.notes.push(
    withSource(ctx, {
      level: "info",
      code: "macro-not-rendered",
      message: `A datasource smart link was captured as a "${macroName}" macro; it renders as a live table when dynamic macro resolution runs.`,
      macroName,
    })
  );

  const block: Extract<ExportBlock, { type: "unknown" }> = {
    type: "unknown",
    macroName,
    params: outcome.params,
    // Deliberately the link, not an empty body: this is what the placeholder
    // floor renders when Jira is unreachable or `--no-live-macros` is set, and
    // it is never worse than the pre-change output.
    body: datasourceFallbackBlocks(el, ctx),
  };
  // No `macroId`: a datasource is not a macro server-side, so the export_view
  // catch-all must not try to fetch one (it skips on a missing macroId).
  if (ctx.pageContext) {
    block.sourcePage = {
      id: ctx.pageContext.id,
      ...(ctx.pageContext.version !== undefined ? { version: ctx.pageContext.version } : {}),
      ...(ctx.pageContext.spaceKey !== undefined ? { spaceKey: ctx.pageContext.spaceKey } : {}),
    };
  }
  return [block];
}

/**
 * C4: apply a `scroll-only` / `scroll-ignore` macro per the truth table
 * (Architecture). Returns the walked body (kept) or `[]` (dropped), always with
 * a report note. `exportControls: "passthrough"` keeps both bodies unconditionally.
 */
function walkExportControlMacro(
  el: XmlElement,
  macroName: "scroll-only" | "scroll-ignore",
  ctx: WalkCtx
): ExportBlock[] {
  const isIgnore = macroName === "scroll-ignore";
  const bodyEl = childByName(el, "ac:rich-text-body");
  const walkBody = (): ExportBlock[] => (bodyEl ? walkBlocks(bodyEl.children, ctx) : []);

  if (ctx.exportControls === "passthrough") {
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "export-controls-passthrough",
        message: `"${macroName}" was kept unmodified (--keep-ignored); this export is not representative of a normal run.`,
        macroName,
      })
    );
    return walkBody();
  }

  const classification = classifyExporterParam(macroParam(el, "exporter"), ctx);

  if (classification === "unknown") {
    // Fail-safe: never drop content on an unrecognized exporter value.
    ctx.notes.push(
      withSource(ctx, {
        level: "warning",
        code: isIgnore ? "scroll-ignore-unknown-exporter" : "scroll-only-unknown-exporter",
        message: `"${macroName}" has an unrecognized exporter value; its content was kept to avoid data loss.`,
        macroName,
      })
    );
    return walkBody();
  }

  if (isIgnore) {
    // scroll-ignore: drop on absent/match, keep on mismatch.
    if (classification === "mismatch") {
      ctx.notes.push(
        withSource(ctx, {
          level: "info",
          code: "scroll-ignore-skipped-other-exporter",
          message: `"scroll-ignore" targets a different exporter; its content was kept.`,
          macroName,
        })
      );
      return walkBody();
    }
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "scroll-ignore-applied",
        message: `"scroll-ignore" content was omitted from this export.`,
        macroName,
      })
    );
    return [];
  }

  // scroll-only: keep on absent/match, drop on mismatch.
  if (classification === "mismatch") {
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "scroll-only-skipped-other-exporter",
        message: `"scroll-only" is exclusive to a different exporter; its content was omitted.`,
        macroName,
      })
    );
    return [];
  }
  ctx.notes.push(
    withSource(ctx, {
      level: "info",
      code: "scroll-only-applied",
      message: `"scroll-only" content was included in this export.`,
      macroName,
    })
  );
  return walkBody();
}

/**
 * C6: build an `orientation` region from a `scroll-landscape`/`scroll-portrait`
 * macro. Two source shapes normalize to the SAME downstream block:
 *
 * - **Body-wrapped** (`ac:rich-text-body` contains the region content): walked
 *   directly. Any orientation region nested ANYWHERE in the body — including
 *   inside lists, blockquotes, callouts, and table cells — is unwrapped into
 *   its children (outer wins) with a warning note, so the engines never have to
 *   reason about nested `set page`/section breaks.
 * - **Marker** (no body): a stateful open/close marker. Emitted as a tagged
 *   empty region that {@link normalizeOrientationMarkers} folds into a real
 *   region over the sibling stream.
 */
function walkOrientationMacro(el: XmlElement, landscape: boolean, ctx: WalkCtx): ExportBlock[] {
  const bodyEl = childByName(el, "ac:rich-text-body");
  if (!bodyEl) {
    const marker: ExportBlock = { type: "orientation", landscape, content: [] };
    ORIENTATION_MARKERS.add(marker);
    return [marker];
  }
  const content = walkBlocks(bodyEl.children, ctx);
  const { blocks: flattened, found: nested } = stripNestedOrientation(content);
  if (nested) {
    ctx.notes.push(
      withSource(ctx, {
        level: "warning",
        code: "orientation-nested-collapsed",
        message: "A nested orientation region was collapsed into its enclosing region (outer orientation wins).",
        macroName: landscape ? "scroll-landscape" : "scroll-portrait",
      })
    );
  }
  return [{ type: "orientation", landscape, content: flattened }];
}

/**
 * Unwrap every orientation region in a block tree into its children — a DEEP
 * scan through lists, blockquotes, callouts, and table cells, not just direct
 * children (an inner region nested one level down would otherwise survive and
 * fight the outer region's section/page state in the engines).
 */
function stripNestedOrientation(blocks: ExportBlock[]): { blocks: ExportBlock[]; found: boolean } {
  let found = false;
  const walk = (list: ExportBlock[]): ExportBlock[] =>
    list.flatMap((block): ExportBlock[] => {
      switch (block.type) {
        case "orientation":
          found = true;
          return walk(block.content);
        case "callout":
        case "expand":
        case "blockquote":
          return [{ ...block, content: walk(block.content) }];
        case "list":
          return [
            { ...block, items: block.items.map((item) => ({ ...item, content: walk(item.content) })) },
          ];
        case "layout":
          return [{
            ...block,
            columns: block.columns.map((column) => ({ ...column, content: walk(column.content) })),
          }];
        case "table":
          return [
            {
              ...block,
              rows: block.rows.map((row) => ({
                ...row,
                cells: row.cells.map((cell) => ({ ...cell, content: walk(cell.content) })),
              })),
            },
          ];
        default:
          return [block];
      }
    });
  const result = walk(blocks);
  return { blocks: result, found };
}

/**
 * C3: build a {@link Caption} from a `scroll-title` macro and attach it to the
 * first captionable block (`image`/`table`/`codeBlock`) in the macro body. When
 * the body has no captionable block, fall back to an italic caption paragraph
 * plus an info note so the title text is never silently lost.
 */
function walkScrollTitleMacro(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const bodyEl = childByName(el, "ac:rich-text-body");
  const inner = bodyEl ? walkBlocks(bodyEl.children, ctx) : [];
  const rawKind = macroParam(el, "type");
  // The title text is the macro's `title` param, else its unnamed first param.
  const titleText = macroParam(el, "title") ?? macroParam(el, "");
  const content: InlineNode[] = titleText ? [{ type: "text", text: titleText }] : [];

  const targetIndex = inner.findIndex(
    (block) => block.type === "image" || block.type === "table" || block.type === "codeBlock"
  );

  if (targetIndex === -1) {
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "scroll-title-caption-fallback",
        message: "A scroll-title had no figure/table/code to caption; its text was rendered as an italic caption paragraph.",
        macroName: "scroll-title",
      })
    );
    if (content.length === 0) return inner;
    const italic: InlineNode[] = content.map((node) =>
      node.type === "text" ? { ...node, marks: [...(node.marks ?? []), "italic"] } : node
    );
    return [...inner, { type: "paragraph", content: italic }];
  }

  const target = inner[targetIndex] as Extract<ExportBlock, { type: "image" | "table" | "codeBlock" }>;
  const { kind, note } = normalizeCaptionKind(rawKind, target.type);
  if (note) ctx.notes.push(withSource(ctx, note));
  inner[targetIndex] = { ...target, caption: { kind, content } };
  return inner;
}

/** The `ri:*` child names {@link captureMacroParams} recognizes as references. */
function captureMacroRef(el: XmlElement): MacroParamRef | undefined {
  switch (el.name) {
    case "ri:page": {
      const ref: Extract<MacroParamRef, { kind: "page" }> = { kind: "page" };
      const contentId = el.attrs["ri:content-id"];
      const contentTitle = el.attrs["ri:content-title"];
      const spaceKey = el.attrs["ri:space-key"];
      if (contentId) ref.contentId = contentId;
      if (contentTitle) ref.contentTitle = contentTitle;
      if (spaceKey) ref.spaceKey = spaceKey;
      return ref;
    }
    case "ri:attachment": {
      const filename = el.attrs["ri:filename"];
      return filename ? { kind: "attachment", filename } : undefined;
    }
    case "ri:url": {
      const value = el.attrs["ri:value"];
      return value ? { kind: "url", value } : undefined;
    }
    case "ri:user": {
      const accountId = el.attrs["ri:account-id"] ?? el.attrs["ri:userkey"];
      return accountId ? { kind: "user", accountId } : undefined;
    }
    case "ri:space": {
      const spaceKey = el.attrs["ri:space-key"];
      return spaceKey ? { kind: "space", spaceKey } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Capture every `<ac:parameter>` of a macro as a {@link MacroParameter}. `text`
 * is trimmed text content (when non-empty); `refs` is one typed reference per
 * recognized `ri:*` element child (in document order, multiple allowed).
 * Unrecognized `ri:*` names are skipped rather than misclassified. A parameter
 * with neither text nor refs is omitted entirely.
 *
 * `elementText` is deliberately NOT the sole read path: it returns `""` for an
 * element-only parameter (e.g. `<ac:parameter><ri:page .../></ac:parameter>`),
 * which would drop the reference silently.
 */
/**
 * Wrapper elements whose `ri:*` children are still parameter references.
 * Confluence's OWN storage for `include`/`excerpt-include` wraps the page ref
 * in a link element — `<ac:parameter ac:name=""><ac:link><ri:page …/></ac:link>
 * </ac:parameter>` (e2e-observed on Cloud, space DOCSY) — and image-shaped
 * parameters analogously wrap `ri:attachment`/`ri:url` in `<ac:image>`. A
 * direct-children-only scan misses both, silently dropping the reference.
 */
const PARAM_REF_WRAPPERS = new Set(["ac:link", "ac:image"]);

function captureMacroParams(macro: XmlElement): MacroParameter[] {
  const params: MacroParameter[] = [];
  for (const p of childrenByName(macro, "ac:parameter")) {
    const name = (p.attrs["ac:name"] ?? "").toLowerCase();
    const text = elementText(p).trim();
    const refs: MacroParamRef[] = [];
    for (const child of p.children) {
      if (child.type !== "element") continue;
      const ref = captureMacroRef(child);
      if (ref) {
        refs.push(ref);
        continue;
      }
      // One level into known wrappers only (never a general deep scan — an
      // `ri:page` nested in unrelated rich content is not a parameter ref).
      if (PARAM_REF_WRAPPERS.has(child.name)) {
        for (const inner of child.children) {
          if (inner.type !== "element") continue;
          const wrapped = captureMacroRef(inner);
          if (wrapped) refs.push(wrapped);
        }
      }
    }
    const param: MacroParameter = { name };
    if (text) param.text = text;
    if (refs.length > 0) param.refs = refs;
    if (param.text !== undefined || param.refs !== undefined) params.push(param);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Inline walking
// ---------------------------------------------------------------------------

const MARK_TAGS: Record<string, InlineMark> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  code: "code",
  u: "underline",
  s: "strike",
  del: "strike",
  strike: "strike",
  sub: "subscript",
  sup: "superscript",
};

/** Walk a node list at inline scope into typed {@link InlineNode}s. */
function walkInline(nodes: XmlNode[], ctx: WalkCtx): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text !== "") out.push({ type: "text", text: node.text });
      continue;
    }
    out.push(...walkInlineElement(node, ctx));
  }
  return out;
}

/** Normalize Storage's calendar-date representations to ADF epoch milliseconds. */
function storageDateTimestamp(value: string): string {
  const source = value.trim();
  if (parseAdfDateTimestamp(source)) return source;
  const calendar = source.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (calendar) {
    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    const milliseconds = date.getTime();
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return String(milliseconds);
    }
  }
  // Accept only ISO timestamps with an explicit zone. Date.parse() also
  // accepts locale-shaped and implementation-specific values (for example
  // 03/04/2024), which would make an export depend on the host environment.
  const zonedIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!zonedIso.test(source)) return source;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? String(milliseconds) : source;
}

function storageDateInline(value: string, ctx: WalkCtx): InlineNode[] {
  const source = value.trim();
  if (!source) return [];
  const timestamp = storageDateTimestamp(source);
  if (!parseAdfDateTimestamp(timestamp)) {
    ctx.notes.push(withSource(ctx, {
      level: "warning",
      code: "date-invalid",
      message: "A semantic date timestamp was invalid; its exact source text was preserved.",
    }));
  }
  return [{ type: "date", timestamp }];
}

function walkInlineElement(el: XmlElement, ctx: WalkCtx): InlineNode[] {
  const name = el.name;

  if (name === "ac:adf-node") return walkUnsupportedStorageAdfInline(el, ctx);

  const mark = MARK_TAGS[name];
  if (mark) return addMark(walkInline(el.children, ctx), mark);

  if (name === "br") return [{ type: "lineBreak" }];

  if (name === "span") {
    const style = el.attrs.style ?? "";
    const color = inlineCssColor(style, "color");
    const backgroundColor = inlineCssColor(style, "background-color");
    const inner = walkInline(el.children, ctx);
    return color || backgroundColor
      ? applyInlineColors(inner, { color, backgroundColor })
      : inner;
  }

  if (name === "a") {
    const href = el.attrs.href ?? "";
    const content = walkInline(el.children, ctx);
    const display = hasMeaningfulInline(content) ? content : [{ type: "text" as const, text: href }];
    // Shared scheme policy (spec 011). Storage `<a href>` used to flow verbatim
    // into a live Word HYPERLINK field / Typst #link(); the DOCX and PDF
    // serializers each re-check as defense in depth, but degrading HERE is what
    // makes the two engines agree and what produces a note the user can see.
    const verdict = sanitizeLinkHref(href);
    if (!verdict.safe) {
      ctx.notes.push(
        withSource(ctx, {
          level: "warning",
          code: UNSAFE_LINK_NOTE_CODE,
          message: unsafeLinkMessage(verdict, inlineText(display)),
        })
      );
      return display;
    }
    return [{ type: "link", target: { kind: "external", href }, content: display }];
  }

  if (name === "ac:link") return walkAcLink(el, ctx);

  if (name === "ac:emoticon") {
    // The explicit short-name is authoritative. Only when it is absent may
    // the legacy ac:name identity participate in catalog normalization.
    const sourceShortName =
      el.attrs["ac:emoji-shortname"] ??
      el.attrs["ac:name"] ??
      "";
    // Empty is schema-representable but is not an emoji notation. Keep the
    // existing visible invalid-node floor in parity with the ADF decoder.
    const shortName = sourceShortName || "[emoji]";
    const sourceText = el.attrs["ac:emoji-fallback"];
    const result = projectTypedEmoji({ shortName, sourceText });
    const renderedFrom =
      result.kind === "source-text"
        ? "source-text"
        : result.kind === "known"
          ? "catalog-projection"
          : "short-name";
    const text = result.text;
    if (!text) return [];
    if (result.kind === "unresolved") {
      ctx.notes.push(withSource(ctx, {
        level: "warning",
        code: "emoji-text-fallback",
        message: "An emoji had no portable Unicode text; its textual short-name fallback was preserved.",
      }));
    }
    return [{
      type: "text",
      text,
      emoji: {
        shortName,
        ...(sourceText !== undefined ? { text: sourceText } : {}),
        renderedFrom,
        ...(result.kind === "known" ? { projection: result.projection } : {}),
      },
    }];
  }

  if (name === "time") {
    const datetime = el.attrs.datetime ?? elementText(el).trim();
    return storageDateInline(datetime, ctx);
  }

  if (name === "ac:placeholder") {
    return [{
      type: "placeholder",
      text: elementText(el),
      ...(el.attrs["ac:type"] !== undefined ? { placeholderType: el.attrs["ac:type"] } : {}),
    }];
  }

  if (name === "ac:structured-macro") {
    const macroName = (el.attrs["ac:name"] ?? "").toLowerCase();
    if (macroName === "status") {
      const color = (macroParam(el, "colour") ?? macroParam(el, "color") ?? "grey").toLowerCase();
      const title = macroParam(el, "title") ?? "";
      const style =
        macroParam(el, "style") ??
        (macroParam(el, "subtle")?.toLowerCase() === "true" ? "subtle" : undefined);
      return [{
        type: "status",
        text: title,
        color,
        ...(style !== undefined ? { style } : {}),
      }];
    }
    if (macroName === "date") {
      const value =
        macroParam(el, "date") ??
        macroParam(el, "") ??
        elementText(el);
      return storageDateInline(value, ctx);
    }
    if (INLINE_SCROLL_MACROS.has(macroName)) {
      return walkInlineExportControlMacro(
        el,
        macroName as "scroll-only-inline" | "scroll-ignore-inline",
        ctx
      );
    }
  }

  if (name === "ac:image") {
    ctx.notes.push({
      level: "info",
      code: "inline-image-skipped",
      message: "An inline <ac:image> was encountered in inline context; images render as blocks.",
    });
    const alt = el.attrs["ac:alt"];
    return alt ? [{ type: "text", text: alt }] : [];
  }

  // Unknown inline element: recurse transparently so text is not lost.
  return walkInline(el.children, ctx);
}

/**
 * Resolve an `<ac:link>` to inline node(s): user mention, page, attachment,
 * external URL, or in-page anchor. Body text comes from
 * `<ac:plain-text-link-body>` or `<ac:link-body>`.
 */
function walkAcLink(el: XmlElement, ctx: WalkCtx): InlineNode[] {
  const user = childByName(el, "ri:user");
  const page = childByName(el, "ri:page");
  const attachment = childByName(el, "ri:attachment");
  const url = childByName(el, "ri:url");
  const anchorAttr = el.attrs["ac:anchor"];

  const plainBody = childByName(el, "ac:plain-text-link-body");
  const richBody = childByName(el, "ac:link-body");
  const bodyText = plainBody ? elementText(plainBody).trim() : richBody ? elementText(richBody).trim() : "";
  const bodyInline: InlineNode[] = richBody
    ? walkInline(richBody.children, ctx)
    : bodyText
      ? [{ type: "text", text: bodyText }]
      : [];

  if (user) {
    const accountId = user.attrs["ri:account-id"] ?? user.attrs["ri:userkey"] ?? "";
    const displayName = bodyText || undefined;
    return [{ type: "mention", accountId, displayName }];
  }

  if (page) {
    const contentTitle = page.attrs["ri:content-title"] ?? "";
    const contentId = page.attrs["ri:content-id"] || undefined;
    const spaceKey = page.attrs["ri:space-key"] || undefined;
    const anchor = anchorAttr || undefined;
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: contentTitle }];
    const target: Extract<LinkTarget, { kind: "page" }> = { kind: "page", contentTitle };
    if (contentId) target.contentId = contentId;
    if (spaceKey) target.spaceKey = spaceKey;
    if (anchor) target.anchor = anchor;
    return [{ type: "link", target, content }];
  }

  if (attachment) {
    const filename = attachment.attrs["ri:filename"] ?? "";
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: filename }];
    return [{ type: "link", target: { kind: "attachment", filename }, content }];
  }

  // Confluence represents pasted / editor-created external links as
  // `<ac:link><ri:url ri:value="…"/>…</ac:link>` as well as ordinary HTML
  // `<a href="…">`. Without this branch the target element was ignored and
  // only `bodyInline` survived, so both PDF and DOCX received plain text even
  // though the link was clickable on the source page.
  if (url) {
    const href = url.attrs["ri:value"] ?? "";
    const verdict = sanitizeLinkHref(href);
    if (!verdict.safe) {
      const content = hasMeaningfulInline(bodyInline)
        ? bodyInline
        : [{ type: "text" as const, text: href }];
      ctx.notes.push(
        withSource(ctx, {
          level: "warning",
          code: UNSAFE_LINK_NOTE_CODE,
          message: unsafeLinkMessage(verdict, inlineText(content)),
        })
      );
      return content;
    }
    const content = hasMeaningfulInline(bodyInline)
      ? bodyInline
      : [{ type: "text" as const, text: verdict.href }];
    return [{ type: "link", target: { kind: "external", href: verdict.href }, content }];
  }

  if (anchorAttr) {
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: anchorAttr }];
    return [{ type: "link", target: { kind: "anchor", anchor: anchorAttr }, content }];
  }

  // Degenerate ac:link with no recognizable target — keep any body text.
  return bodyInline;
}

/**
 * C4 inline variant: apply `scroll-only-inline` / `scroll-ignore-inline` per the
 * same truth table as the block form. Returns the walked inline body (kept) or
 * `[]` (dropped), always with a report note; `passthrough` keeps both bodies.
 */
function walkInlineExportControlMacro(
  el: XmlElement,
  macroName: "scroll-only-inline" | "scroll-ignore-inline",
  ctx: WalkCtx
): InlineNode[] {
  const isIgnore = macroName === "scroll-ignore-inline";
  const bodyEl = childByName(el, "ac:rich-text-body");
  // A body-less inline control keeps NOTHING: walking `el.children` here would
  // descend into `<ac:parameter>` elements and leak parameter text into the
  // document (the block form has the same safe empty fallback).
  const walkBody = (): InlineNode[] => (bodyEl ? walkInline(bodyEl.children, ctx) : []);

  if (ctx.exportControls === "passthrough") {
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "export-controls-passthrough",
        message: `"${macroName}" was kept unmodified (--keep-ignored); this export is not representative of a normal run.`,
        macroName,
      })
    );
    return walkBody();
  }

  const classification = classifyExporterParam(macroParam(el, "exporter"), ctx);

  if (classification === "unknown") {
    ctx.notes.push(
      withSource(ctx, {
        level: "warning",
        code: isIgnore ? "scroll-ignore-unknown-exporter" : "scroll-only-unknown-exporter",
        message: `"${macroName}" has an unrecognized exporter value; its content was kept to avoid data loss.`,
        macroName,
      })
    );
    return walkBody();
  }

  if (isIgnore) {
    if (classification === "mismatch") {
      ctx.notes.push(
        withSource(ctx, {
          level: "info",
          code: "scroll-ignore-skipped-other-exporter",
          message: `"scroll-ignore-inline" targets a different exporter; its content was kept.`,
          macroName,
        })
      );
      return walkBody();
    }
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "scroll-ignore-applied",
        message: `"scroll-ignore-inline" content was omitted from this export.`,
        macroName,
      })
    );
    return [];
  }

  if (classification === "mismatch") {
    ctx.notes.push(
      withSource(ctx, {
        level: "info",
        code: "scroll-only-skipped-other-exporter",
        message: `"scroll-only-inline" is exclusive to a different exporter; its content was omitted.`,
        macroName,
      })
    );
    return [];
  }
  ctx.notes.push(
    withSource(ctx, {
      level: "info",
      code: "scroll-only-applied",
      message: `"scroll-only-inline" content was included in this export.`,
      macroName,
    })
  );
  return walkBody();
}

/** Return a copy of `nodes` with `mark` added to every text run (recursing into links). */
function addMark(nodes: InlineNode[], mark: InlineMark): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === "text") {
      const marks = node.marks ? [...node.marks] : [];
      if (!marks.includes(mark)) marks.push(mark);
      return { ...node, marks };
    }
    if (node.type === "link") {
      return { ...node, content: addMark(node.content, mark) };
    }
    return node;
  });
}

function inlineCssColor(style: string, property: "color" | "background-color"): string | undefined {
  const escaped = property.replace("-", "\\-");
  const value = style.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "i"))?.[1];
  return normalizeExportColor(value);
}

/** Apply span colors to every nested text run, including link labels. */
function applyInlineColors(
  nodes: InlineNode[],
  colors: { color?: string; backgroundColor?: string }
): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === "text") {
      return {
        ...node,
        ...(colors.color && !node.color ? { color: colors.color } : {}),
        ...(colors.backgroundColor && !node.backgroundColor
          ? { backgroundColor: colors.backgroundColor }
          : {}),
      };
    }
    if (node.type === "link") {
      return { ...node, content: applyInlineColors(node.content, colors) };
    }
    return node;
  });
}

/**
 * Intermediate export model (spec 004 Task 2, also consumed by spec 005 Typst).
 *
 * The markdown converter (`storageToMarkdown`) is a lossy intermediate for
 * document-export purposes: it flattens marks to `**`/`*`, drops table
 * colspan/rowspan, loses status colors, and cannot express Word heading styles.
 * Rich exporters (DOCX, PDF/Typst) instead walk a **structured intermediate
 * model** — {@link ExportBlock}[] with typed inline runs — that both serializers
 * consume. This module owns that model and the storage→blocks walker.
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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Inline text formatting marks. Modeled as a set, not pre-rendered delimiters. */
export type InlineMark =
  | "bold"
  | "italic"
  | "code"
  | "strike"
  | "underline"
  | "subscript"
  | "superscript";

/** Where a link points. External URLs, Confluence page refs, attachments, in-page anchors. */
export type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "page"; contentTitle: string; spaceKey?: string; anchor?: string }
  | { kind: "attachment"; filename: string }
  | { kind: "anchor"; anchor: string };

/**
 * A typed inline node. Serializers render these to runs/spans; the model never
 * pre-renders formatting into strings.
 */
export type InlineNode =
  | { type: "text"; text: string; marks?: InlineMark[]; color?: string }
  | { type: "link"; target: LinkTarget; content: InlineNode[] }
  /**
   * A user mention. Carries `accountId` always; `displayName` is optional and is
   * the clean slot for the upcoming display-name resolution feature — when the
   * storage lacks a name the serializer/resolver fills it from `accountId`.
   */
  | { type: "mention"; accountId: string; displayName?: string }
  | { type: "status"; text: string; color: string }
  | { type: "lineBreak" };

/** A table cell. Confluence `<th>` → `header: true`. colspan/rowspan default to 1. */
export interface TableCell {
  header: boolean;
  colspan: number;
  rowspan: number;
  content: ExportBlock[];
}

export interface TableRow {
  cells: TableCell[];
}

/**
 * A list item. `checked` is present only for task-list items (`true`/`false`);
 * a normal bullet/number item leaves it `undefined`.
 */
export interface ListItem {
  content: ExportBlock[];
  checked?: boolean;
}

/** Where an image's bytes come from. */
export type ImageSource =
  | { kind: "attachment"; filename: string }
  | { kind: "external"; url: string };

/** Confluence callout kinds plus the generic titled panel. */
export type CalloutKind = "info" | "note" | "warning" | "tip" | "panel";

/**
 * A block-level element. Discriminated on `type`. This is the unit both the
 * DOCX and Typst serializers iterate.
 */
export type ExportBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[] }
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "codeBlock"; language?: string; code: string }
  | { type: "callout"; kind: CalloutKind; title?: string; content: ExportBlock[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "table"; rows: TableRow[]; columnWidths?: number[] }
  | { type: "image"; source: ImageSource; alt?: string; width?: number; height?: number }
  | { type: "blockquote"; content: ExportBlock[] }
  | { type: "divider" }
  /** An unrecognized macro. Never carries raw XML; the macro name is enough for a report line. */
  | { type: "unknown"; macroName: string };

/** A non-fatal observation surfaced in the export report (never thrown). */
export interface ExportNote {
  level: "info" | "warning";
  /** Stable machine code, e.g. `"unknown-macro"`, `"inline-image-skipped"`. */
  code: string;
  message: string;
  macroName?: string;
}

/** Result of {@link storageToBlocks}: the block tree plus report notes. */
export interface StorageToBlocksResult {
  blocks: ExportBlock[];
  notes: ExportNote[];
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
 */
export function parseXml(input: string): XmlNode[] {
  const root: XmlElement = { type: "element", name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = input.length;

  const pushText = (raw: string, literal: boolean) => {
    if (raw === "") return;
    const text = literal ? raw : decodeEntities(raw);
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
    const el: XmlElement = { type: "element", name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && !VOID_ELEMENTS.has(name)) stack.push(el);
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
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

interface WalkCtx {
  notes: ExportNote[];
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
  "time",
]);

/** Container tags we descend into transparently (their children are block-level). */
const TRANSPARENT_BLOCK_TAGS = new Set([
  "div",
  "ac:layout",
  "ac:layout-section",
  "ac:layout-cell",
  "ac:adf-extension",
  "ac:adf-node",
  "ac:adf-content",
]);

/**
 * Convert a Confluence storage fragment to the intermediate export model.
 *
 * @param storage - Confluence storage-format XML (a fragment, not a full doc).
 * @returns The block tree plus any {@link ExportNote}s for the export report.
 */
export function storageToBlocks(storage: string): StorageToBlocksResult {
  const ctx: WalkCtx = { notes: [] };
  const nodes = parseXml(storage);
  const blocks = walkBlocks(nodes, ctx);
  return { blocks, notes: ctx.notes };
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

  const flush = () => {
    if (inlineBuf.length === 0) return;
    const inline = trimInline(walkInline(inlineBuf, ctx));
    if (hasMeaningfulInline(inline)) out.push({ type: "paragraph", content: inline });
    inlineBuf = [];
  };

  for (const node of nodes) {
    if (node.type === "text") {
      inlineBuf.push(node);
      continue;
    }
    if (INLINE_TAGS.has(node.name) || isInlineMacro(node)) {
      inlineBuf.push(node);
      continue;
    }
    flush();
    out.push(...handleBlockElement(node, ctx));
  }
  flush();
  return out;
}

/** A `status` structured-macro is the only inline-level macro. */
function isInlineMacro(node: XmlElement): boolean {
  return node.name === "ac:structured-macro" && (node.attrs["ac:name"] ?? "").toLowerCase() === "status";
}

/** Dispatch a single block-level element to zero or more {@link ExportBlock}s. */
function handleBlockElement(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const name = el.name;

  const headingLevel = HEADING_TAGS[name];
  if (headingLevel) {
    return [{ type: "heading", level: headingLevel, content: trimInline(walkInline(el.children, ctx)) }];
  }

  switch (name) {
    case "p":
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
    case "table":
      return [walkTable(el, ctx)];
    case "blockquote":
      return [{ type: "blockquote", content: walkBlocks(el.children, ctx) }];
    case "hr":
      return [{ type: "divider" }];
    case "ac:image":
      return walkImage(el, ctx);
    case "pre":
      return [{ type: "codeBlock", code: elementText(el) }];
    case "ac:structured-macro":
      return walkMacro(el, ctx);
    default:
      if (TRANSPARENT_BLOCK_TAGS.has(name)) return walkBlocks(el.children, ctx);
      // Unknown block-level element: descend rather than drop its content.
      return walkBlocks(el.children, ctx);
  }
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

// ---- Lists ----------------------------------------------------------------

function walkList(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const ordered = el.name === "ol";
  const items: ListItem[] = [];
  for (const li of childrenByName(el, "li")) {
    items.push({ content: walkBlocks(li.children, ctx) });
  }
  return { type: "list", ordered, items };
}

function walkTaskList(el: XmlElement, ctx: WalkCtx): ExportBlock {
  const items: ListItem[] = [];
  for (const task of childrenByName(el, "ac:task")) {
    const statusEl = childByName(task, "ac:task-status");
    const statusText = (statusEl ? elementText(statusEl) : "").trim().toLowerCase();
    const body = childByName(task, "ac:task-body");
    const content = body ? walkBlocks(body.children, ctx) : [];
    items.push({ content, checked: statusText === "complete" });
  }
  return { type: "list", ordered: false, items };
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
      cells.push({
        header: cell.name === "th",
        colspan: parsePositiveInt(cell.attrs.colspan) ?? 1,
        rowspan: parsePositiveInt(cell.attrs.rowspan) ?? 1,
        content: walkBlocks(cell.children, ctx),
      });
    }
    rows.push({ cells });
  }
  const columnWidths = tableColumnWidths(el);
  return { type: "table", rows, ...(columnWidths ? { columnWidths } : {}) };
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
    source = { kind: "attachment", filename: attachment.attrs["ri:filename"] };
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

const CALLOUT_KINDS = new Set<CalloutKind>(["info", "note", "warning", "tip", "panel"]);

function walkMacro(el: XmlElement, ctx: WalkCtx): ExportBlock[] {
  const macroName = (el.attrs["ac:name"] ?? "").toLowerCase();

  // Callouts + generic panel.
  if (CALLOUT_KINDS.has(macroName as CalloutKind)) {
    const body = childByName(el, "ac:rich-text-body");
    const title = macroParam(el, "title");
    return [
      {
        type: "callout",
        kind: macroName as CalloutKind,
        title: title || undefined,
        content: body ? walkBlocks(body.children, ctx) : [],
      },
    ];
  }

  // Code / noformat → code block (language preserved).
  if (macroName === "code" || macroName === "noformat") {
    const bodyEl = childByName(el, "ac:plain-text-body") ?? childByName(el, "ac:rich-text-body");
    const code = bodyEl ? elementText(bodyEl) : "";
    const language = macroName === "code" ? macroParam(el, "language") : undefined;
    return [{ type: "codeBlock", language: language || undefined, code }];
  }

  // Expand: no dedicated block type — surface its body transparently.
  if (macroName === "expand") {
    const body = childByName(el, "ac:rich-text-body");
    return body ? walkBlocks(body.children, ctx) : [];
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
  return [{ type: "unknown", macroName: macroName || "unknown" }];
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

function walkInlineElement(el: XmlElement, ctx: WalkCtx): InlineNode[] {
  const name = el.name;

  const mark = MARK_TAGS[name];
  if (mark) return addMark(walkInline(el.children, ctx), mark);

  if (name === "br") return [{ type: "lineBreak" }];

  if (name === "span") {
    const colorMatch = (el.attrs.style ?? "").match(/color:\s*([^;]+)/i);
    const color = colorMatch ? colorMatch[1].trim() : undefined;
    const inner = walkInline(el.children, ctx);
    return color ? inner.map((n) => (n.type === "text" ? { ...n, color } : n)) : inner;
  }

  if (name === "a") {
    const href = el.attrs.href ?? "";
    const content = walkInline(el.children, ctx);
    return [
      {
        type: "link",
        target: { kind: "external", href },
        content: hasMeaningfulInline(content) ? content : [{ type: "text", text: href }],
      },
    ];
  }

  if (name === "ac:link") return walkAcLink(el, ctx);

  if (name === "ac:emoticon") {
    const emoji = el.attrs["ac:emoji-fallback"] ?? el.attrs["ac:name"] ?? "";
    return emoji ? [{ type: "text", text: emoji }] : [];
  }

  if (name === "time") {
    const datetime = el.attrs.datetime ?? elementText(el).trim();
    return datetime ? [{ type: "text", text: datetime }] : [];
  }

  if (name === "ac:structured-macro" && (el.attrs["ac:name"] ?? "").toLowerCase() === "status") {
    const color = (macroParam(el, "colour") ?? macroParam(el, "color") ?? "grey").toLowerCase();
    const title = macroParam(el, "title") ?? "";
    return [{ type: "status", text: title, color }];
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
 * Resolve an `<ac:link>` to inline node(s): user mention, page link, attachment
 * link, or in-page anchor. Body text comes from `<ac:plain-text-link-body>` or
 * `<ac:link-body>`.
 */
function walkAcLink(el: XmlElement, ctx: WalkCtx): InlineNode[] {
  const user = childByName(el, "ri:user");
  const page = childByName(el, "ri:page");
  const attachment = childByName(el, "ri:attachment");
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
    const spaceKey = page.attrs["ri:space-key"] || undefined;
    const anchor = anchorAttr || undefined;
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: contentTitle }];
    return [{ type: "link", target: { kind: "page", contentTitle, spaceKey, anchor }, content }];
  }

  if (attachment) {
    const filename = attachment.attrs["ri:filename"] ?? "";
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: filename }];
    return [{ type: "link", target: { kind: "attachment", filename }, content }];
  }

  if (anchorAttr) {
    const content = hasMeaningfulInline(bodyInline) ? bodyInline : [{ type: "text" as const, text: anchorAttr }];
    return [{ type: "link", target: { kind: "anchor", anchor: anchorAttr }, content }];
  }

  // Degenerate ac:link with no recognizable target — keep any body text.
  return bodyInline;
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

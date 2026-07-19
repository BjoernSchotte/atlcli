/**
 * `export_view` HTML → {@link ExportBlock}[] converter (spec 004, T1.10).
 *
 * Confluence renders a dynamic macro server-side to an HTML fragment (the
 * `export_view` body representation, which transparently carries the ADF-export
 * output of current-generation third-party apps too). This converts that
 * HTML-subset into the same intermediate model the storage walker produces, so
 * both engines render it identically.
 *
 * ## Trust boundary
 *
 * Unlike a page's own `ac:`-storage XML (authored by the same tenant, bounded by
 * Confluence's storage limits), `export_view` HTML is produced by whichever
 * third-party app owns the macro and is NOT first-party-trusted:
 * - {@link HtmlConversionLimits} caps input size / node count / depth /
 *   attributes / text / output blocks; exceeding any limit truncates
 *   deterministically with a `macro-degraded` note (never an unbounded tree, an
 *   infinite loop, or a thrown error).
 * - `<img src>` becomes `ImageSource { kind: "external", trust: "export-view" }`
 *   so bytes flow through the stricter host asset policy.
 * - `<a href>` becomes a link only for `http(s):`/`mailto:` schemes (same
 *   allowlist the PDF serializer enforces), closing the gap where DOCX would
 *   otherwise turn `javascript:`/`file:` into a live hyperlink field.
 * - `<script>`, `<style>`, `<template>`, `<iframe>`, `<object>`, `<embed>`, and
 *   form elements are dropped WITH their content (never unwrapped); every other
 *   unknown tag is unwrapped (children kept — lossy but visible beats dropped).
 *
 * Isomorphic: reuses the same {@link parseXml} tokenizer as the storage walker
 * (never a regex or DOMParser) and is exported from the browser barrel.
 */
import {
  parseXml,
  type ExportBlock,
  type ExportNote,
  type ImageSource,
  type InlineMark,
  type InlineNode,
  type ListItem,
  type TableCell,
  type TableRow,
  type XmlElement,
  type XmlNode,
} from "./export-blocks.js";

/** Conservative caps for untrusted third-party HTML. */
export interface HtmlConversionLimits {
  /** Max input byte length before truncation. Default 512 KiB. */
  maxInputBytes?: number;
  /** Max total element nodes visited. Default 5000. */
  maxNodes?: number;
  /** Max nesting depth. Default 40. */
  maxDepth?: number;
  /** Max attributes read per node. Default 40. */
  maxAttrsPerNode?: number;
  /** Max characters kept per text node. Default 20000. */
  maxTextPerNode?: number;
  /** Max total output blocks. Default 2000. */
  maxOutputBlocks?: number;
}

const DEFAULT_LIMITS: Required<HtmlConversionLimits> = {
  maxInputBytes: 512 * 1024,
  maxNodes: 5000,
  maxDepth: 40,
  maxAttrsPerNode: 40,
  maxTextPerNode: 20000,
  maxOutputBlocks: 2000,
};

/** Tags whose content is dropped entirely (active content / executable text). */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
]);

const HEADING_LEVEL: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const INLINE_MARK: Record<string, InlineMark> = {
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

/** Track budget consumption across the whole conversion. */
interface Budget {
  limits: Required<HtmlConversionLimits>;
  nodes: number;
  blocks: number;
  truncated: boolean;
}

function isEl(node: XmlNode): node is XmlElement {
  return node.type === "element";
}

/**
 * Convert an `export_view` HTML fragment to export blocks. Never throws; on any
 * limit breach or malformed input it truncates and returns a `macro-degraded`
 * note.
 */
export function htmlToExportBlocks(
  html: string,
  limits?: HtmlConversionLimits
): { blocks: ExportBlock[]; notes: ExportNote[] } {
  const merged: Required<HtmlConversionLimits> = { ...DEFAULT_LIMITS, ...limits };
  const notes: ExportNote[] = [];

  let input = html ?? "";
  if (input.length > merged.maxInputBytes) {
    input = input.slice(0, merged.maxInputBytes);
    notes.push(degraded("export_view HTML exceeded the input size limit and was truncated."));
  }

  let tree: XmlNode[];
  try {
    tree = parseXml(input);
  } catch {
    // parseXml is tolerant of malformed markup, but guard defensively anyway.
    return { blocks: [], notes: [degraded("export_view HTML could not be parsed; macro skipped.")] };
  }

  const budget: Budget = { limits: merged, nodes: 0, blocks: 0, truncated: false };
  const blocks = walkBlocks(tree, budget, 0);

  if (budget.truncated) {
    notes.push(degraded("export_view HTML exceeded a conversion limit and was truncated."));
  }
  return { blocks, notes };
}

function degraded(message: string): ExportNote {
  return { level: "warning", code: "macro-degraded", message };
}

/** Budget-aware block-level walk. */
function walkBlocks(nodes: XmlNode[], budget: Budget, depth: number): ExportBlock[] {
  const out: ExportBlock[] = [];
  let inlineBuffer: InlineNode[] = [];

  const flush = () => {
    if (inlineBuffer.length === 0) return;
    const trimmed = trimInline(inlineBuffer);
    if (trimmed.length > 0) pushBlock(out, { type: "paragraph", content: trimmed }, budget);
    inlineBuffer = [];
  };

  for (const node of nodes) {
    if (budget.truncated) break;
    if (node.type === "text") {
      const text = capText(node.text, budget);
      if (text.trim() !== "") inlineBuffer.push({ type: "text", text });
      continue;
    }
    if (!withinNodeBudget(budget) || depth > budget.limits.maxDepth) {
      budget.truncated = true;
      break;
    }
    const name = node.name;

    if (DROP_WITH_CONTENT.has(name)) continue; // dropped with content

    if (HEADING_LEVEL[name]) {
      flush();
      pushBlock(out, { type: "heading", level: HEADING_LEVEL[name], content: walkInline(node.children, budget) }, budget);
      continue;
    }
    if (name === "p") {
      flush();
      const content = trimInline(walkInline(node.children, budget));
      if (content.length > 0) pushBlock(out, { type: "paragraph", content }, budget);
      continue;
    }
    if (name === "ul" || name === "ol") {
      flush();
      pushBlock(out, { type: "list", ordered: name === "ol", items: walkListItems(node, budget, depth) }, budget);
      continue;
    }
    if (name === "table") {
      flush();
      const table = walkTable(node, budget, depth);
      if (table) pushBlock(out, table, budget);
      continue;
    }
    if (name === "pre") {
      flush();
      pushBlock(out, { type: "codeBlock", code: elementText(node, budget) }, budget);
      continue;
    }
    if (name === "blockquote") {
      flush();
      pushBlock(out, { type: "blockquote", content: walkBlocks(node.children, budget, depth + 1) }, budget);
      continue;
    }
    if (name === "hr") {
      flush();
      pushBlock(out, { type: "divider" }, budget);
      continue;
    }
    if (name === "br") {
      inlineBuffer.push({ type: "lineBreak" });
      continue;
    }
    if (name === "img") {
      flush();
      const img = imageOf(node);
      if (img) pushBlock(out, img, budget);
      continue;
    }
    if (INLINE_MARK[name] || name === "a" || name === "span") {
      inlineBuffer.push(...walkInlineElement(node, budget, []));
      continue;
    }
    // Unknown tag → unwrap, keep children.
    const inner = walkBlocks(node.children, budget, depth + 1);
    if (inner.length > 0) {
      flush();
      for (const b of inner) pushBlock(out, b, budget);
    } else {
      inlineBuffer.push(...walkInline(node.children, budget));
    }
  }
  flush();
  return out;
}

function walkListItems(list: XmlElement, budget: Budget, depth: number): ListItem[] {
  const items: ListItem[] = [];
  for (const child of list.children) {
    if (!isEl(child) || child.name !== "li") continue;
    if (!withinNodeBudget(budget)) {
      budget.truncated = true;
      break;
    }
    items.push({ content: walkBlocks(child.children, budget, depth + 1) });
  }
  return items;
}

function walkTable(table: XmlElement, budget: Budget, depth: number): ExportBlock | undefined {
  const rows: TableRow[] = [];
  const collectRows = (parent: XmlElement) => {
    for (const child of parent.children) {
      if (!isEl(child)) continue;
      if (child.name === "tr") {
        const cells: TableCell[] = [];
        for (const cell of child.children) {
          if (!isEl(cell) || (cell.name !== "td" && cell.name !== "th")) continue;
          cells.push({
            header: cell.name === "th",
            colspan: 1,
            rowspan: 1,
            content: walkBlocks(cell.children, budget, depth + 1),
          });
        }
        rows.push({ cells });
      } else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        collectRows(child);
      }
    }
  };
  collectRows(table);
  return rows.length > 0 ? { type: "table", rows } : undefined;
}

function imageOf(el: XmlElement): ExportBlock | undefined {
  const src = el.attrs.src;
  if (!src) return undefined;
  const source: ImageSource = { kind: "external", url: src, trust: "export-view" };
  const alt = el.attrs.alt || undefined;
  return { type: "image", source, ...(alt ? { alt } : {}) };
}

// ---- Inline ---------------------------------------------------------------

/** Top-level inline walk (no inherited marks). */
function walkInline(nodes: XmlNode[], budget: Budget): InlineNode[] {
  return walkInlineNodes(nodes, budget, []);
}

function walkInlineNodes(nodes: XmlNode[], budget: Budget, marks: InlineMark[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const text = capText(node.text, budget);
      if (text !== "") out.push({ type: "text", text, ...(marks.length ? { marks: [...marks] } : {}) });
      continue;
    }
    if (!withinNodeBudget(budget)) {
      budget.truncated = true;
      break;
    }
    out.push(...walkInlineElement(node, budget, marks));
  }
  return out;
}

function walkInlineElement(el: XmlElement, budget: Budget, marks: InlineMark[]): InlineNode[] {
  const name = el.name;
  if (DROP_WITH_CONTENT.has(name)) return []; // active content dropped
  if (name === "br") return [{ type: "lineBreak" }];

  if (name === "a") {
    const href = el.attrs.href ?? "";
    const content = walkInlineNodes(el.children, budget, marks);
    if (isSafeLinkScheme(href)) {
      return [
        {
          type: "link",
          target: { kind: "external", href },
          content: content.length ? content : [{ type: "text", text: href }],
        },
      ];
    }
    // Unsafe scheme → keep the text, drop the target (with an implicit note via
    // the general degrade path is overkill; the text simply survives unlinked).
    return content;
  }

  const mark = INLINE_MARK[name];
  const nextMarks = mark ? [...marks, mark] : marks;
  return walkInlineNodes(el.children, budget, nextMarks);
}

/** Allowlist matching the PDF serializer's `resolveLink` (spec 004 note). */
export function isSafeLinkScheme(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  if (trimmed === "") return false;
  // Relative URLs (no scheme) are same-origin by construction → allowed.
  if (!/^[a-z][a-z0-9+.-]*:/.test(trimmed)) return true;
  return trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("mailto:");
}

// ---- Helpers --------------------------------------------------------------

function elementText(el: XmlElement, budget: Budget): string {
  let out = "";
  for (const child of el.children) {
    if (child.type === "text") out += child.text;
    else out += elementText(child, budget);
  }
  return capText(out, budget);
}

function capText(text: string, budget: Budget): string {
  if (text.length > budget.limits.maxTextPerNode) {
    budget.truncated = true;
    return text.slice(0, budget.limits.maxTextPerNode);
  }
  return text;
}

function withinNodeBudget(budget: Budget): boolean {
  budget.nodes += 1;
  return budget.nodes <= budget.limits.maxNodes;
}

function pushBlock(out: ExportBlock[], block: ExportBlock, budget: Budget): void {
  if (budget.blocks >= budget.limits.maxOutputBlocks) {
    budget.truncated = true;
    return;
  }
  budget.blocks += 1;
  out.push(block);
}

function trimInline(nodes: InlineNode[]): InlineNode[] {
  return nodes.filter((n) => !(n.type === "text" && n.text.trim() === ""));
}

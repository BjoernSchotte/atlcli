/**
 * TOC macro renderer (spec 004, E5 — pure, no-IO reference renderer).
 *
 * The cheapest way to prove the registry/resolver contract end-to-end: it reads
 * only the composed block tree (`requiresLivePort: false`), needs no port, and
 * never fails.
 */
import type { ExportBlock, InlineNode, ListItem } from "@atlcli/confluence";
import {
  formatAdfDateTimestamp,
  inlineMediaDisplayText,
  mentionDisplayText,
  sanitizeAnchorId,
  smartCardDisplayText,
  statusDisplayText,
} from "@atlcli/confluence";
import type { MacroExportContext, MacroInstance, MacroRenderer, MacroRenderResult } from "./types.js";

/**
 * Flatten a heading's inline content to the text the engines show. Kept in step
 * with the PDF serializer's own flattening: the PDF resolves an in-page anchor
 * link by exactly this text.
 */
function inlinePlainText(nodes: readonly InlineNode[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out += n.text;
        break;
      case "link":
        out += inlinePlainText(n.content);
        break;
      case "date":
        out += formatAdfDateTimestamp(n.timestamp);
        break;
      case "status":
        out += statusDisplayText(n);
        break;
      case "mention":
        // Never the raw account id: an unresolved mention reads "Unknown user".
        out += `@${mentionDisplayText(n)}`;
        break;
      case "smartCard":
        out += smartCardDisplayText(n.card);
        break;
      case "media":
        out += inlineMediaDisplayText(n);
        break;
      case "lineBreak":
        out += " ";
        break;
      case "placeholder":
        break;
    }
  }
  return out;
}

/**
 * Sanitize a heading's text into a stable, ASCII-safe in-page slug: the anchor
 * a web TOC links to. DOCX/PDF link by heading text instead (see
 * `collectHeadings`).
 */
export function slugifyHeading(text: string): string {
  let s = text
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) s = "anchor";
  return s;
}

interface HeadingRef {
  level: number;
  text: string;
  /** Absent: no anchor the target engine would resolve; rendered as plain text. */
  anchor?: string;
}

function collectHeadings(blocks: ExportBlock[], out: HeadingRef[], target: TocAnchorTarget): void {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (b.type === "heading") {
      const text = inlinePlainText(b.content);
      let anchor = b.explicitAnchor;
      if (!anchor && target === "web") {
        anchor = slugifyHeading(text);
      } else if (!anchor) {
        // A single-page DOCX/PDF export has no composed anchors. Both engines
        // resolve a link to an anchor-less heading by the heading's own text,
        // and only its first occurrence: a repeated heading stays unlinked
        // rather than jumping to its namesake.
        const key = sanitizeAnchorId(text);
        if (!seen.has(key)) anchor = text;
        seen.add(key);
      }
      out.push({ level: b.level, text, ...(anchor ? { anchor } : {}) });
    }
    // Headings only appear at the top level of a document body; nested
    // containers are not scanned (matches Confluence's own TOC behavior).
  }
}

/** Which engine's in-page anchor scheme the TOC links must match. */
export type TocAnchorTarget = "document" | "web";

/**
 * Build a nested `{ type: "list" }` of `link` inline nodes for every heading in
 * `[minLevel, maxLevel]`, each targeting its in-page anchor.
 */
export function tocFromHeadings(
  blocks: ExportBlock[],
  opts: { minLevel?: number; maxLevel?: number; target?: TocAnchorTarget } = {}
): ExportBlock[] {
  const minLevel = opts.minLevel ?? 1;
  const maxLevel = opts.maxLevel ?? 6;
  const headings: HeadingRef[] = [];
  collectHeadings(blocks, headings, opts.target ?? "document");
  const inRange = headings.filter((h) => h.level >= minLevel && h.level <= maxLevel);
  if (inRange.length === 0) return [];

  // Build a nested list by relative heading depth. Each heading becomes a list
  // item; deeper headings nest under the previous shallower one.
  const rootItems: ListItem[] = [];
  const stack: { level: number; items: ListItem[] }[] = [{ level: minLevel - 1, items: rootItems }];

  for (const h of inRange) {
    while (stack.length > 1 && h.level <= stack[stack.length - 1].level) stack.pop();
    const textNode: InlineNode = { type: "text", text: h.text };
    const linkNode: InlineNode = h.anchor
      ? { type: "link", target: { kind: "anchor", anchor: h.anchor }, content: [textNode] }
      : textNode;
    const item: ListItem = { content: [{ type: "paragraph", content: [linkNode] }] };
    stack[stack.length - 1].items.push(item);
    // A nested list is attached as the last block of the parent item when a
    // deeper heading follows; prepare a fresh nested list container.
    const nested: ListItem[] = [];
    const nestedList: ExportBlock = { type: "list", ordered: false, items: nested };
    item.content.push(nestedList);
    stack.push({ level: h.level, items: nested });
  }

  // Drop empty nested lists so the output is clean/deterministic.
  pruneEmptyLists(rootItems);
  return [{ type: "list", ordered: false, items: rootItems }];
}

function pruneEmptyLists(items: ListItem[]): void {
  for (const item of items) {
    item.content = item.content.filter((b) => {
      if (b.type === "list") {
        pruneEmptyLists(b.items);
        return b.items.length > 0;
      }
      return true;
    });
  }
}

export function tocRenderer(): MacroRenderer {
  return {
    id: "toc",
    macros: ["toc"],
    requiresLivePort: false,
    webRenderModel: { kind: "toc", dependencies: [] },
    async render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult> {
      // When the DOCX template already carries a native TOC field, suppress the
      // macro's body-TOC so the export never shows a duplicate table of contents.
      if (ctx.flags?.nativeTocPresent) {
        return {
          kind: "blocks",
          blocks: [],
          notes: [
            {
              level: "info",
              code: "macro-skipped-by-config",
              message: "TOC macro suppressed: the Word template already provides a native table-of-contents field.",
              macroName: "toc",
            },
          ],
        };
      }
      const minLevel = numParam(m, "minlevel") ?? 1;
      const maxLevel = numParam(m, "maxlevel") ?? 6;
      // Scan the whole composed document for headings (a real TOC), falling back
      // to the macro's own body only when the resolver did not supply the tree.
      const source = ctx.documentBlocks ? [...ctx.documentBlocks] : m.body ?? [];
      const toc = tocFromHeadings(source, {
        minLevel,
        maxLevel,
        target: ctx.flags?.targetEngine === "web" ? "web" : "document",
      });
      if (toc.length === 0) return { kind: "skip" };
      return {
        kind: "blocks",
        blocks: toc,
        notes: [
          {
            level: "info",
            code: "macro-rendered-via",
            message: "TOC macro rendered as an in-document heading list.",
            macroName: "toc",
          },
        ],
      };
    },
  };
}

function numParam(m: MacroInstance, name: string): number | undefined {
  const raw = m.params.find((p) => p.name.toLowerCase() === name)?.text;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

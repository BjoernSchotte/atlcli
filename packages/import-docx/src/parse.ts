/**
 * Semantic DOCX body parse for the vertical slice: headings, paragraphs,
 * inline marks, hyperlinks, bullet/ordered lists (nested), and tables.
 *
 * Safety: bytes enter exclusively through `unzipDocx` (`@atlcli/docx/scan`),
 * which enforces the archive budget, entry-name safety, and active-content
 * rejection before anything is inflated here.
 *
 * Every construct outside the slice surfaces as an ImportIssue (§2.4).
 */
import { unzipDocx, readPartText, DOCX_TEMPLATE_INTAKE_BUDGET } from "@atlcli/docx/scan";
import type {
  ImportBlock,
  ImportIssue,
  ImportListBlock,
  ImportListItem,
  ImportRun,
  ImportRunMarks,
  ImportTableRow,
  ImportedDocument,
} from "./model.js";
import { attr, childElements, firstChild, parseXmlTree, textContent, type XmlElement } from "./xml.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Paragraph-level children that are markers/metadata, not content. */
const IGNORED_PARAGRAPH_MARKERS = new Set([
  "pPr",
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "commentRangeStart",
  "commentRangeEnd",
]);

/** Body-level children that are layout/metadata, not content. */
const IGNORED_BODY_MARKERS = new Set(["sectPr", "bookmarkStart", "bookmarkEnd", "proofErr"]);

interface ParseContext {
  issues: ImportIssue[];
  /** styleId → heading level (1-6). */
  headingStyles: Map<string, number>;
  /** numId → ilvl → ordered? */
  numbering: Map<string, Map<number, boolean>>;
  /** relationship id → external URL. */
  hyperlinks: Map<string, string>;
  /** issue codes already reported once (deduplicated counters). */
  reported: Map<string, number>;
}

function report(
  ctx: ParseContext,
  code: string,
  severity: "info" | "warning",
  outcome: "approximated" | "reported",
  message: string,
  context?: Record<string, string | number>,
): void {
  const count = (ctx.reported.get(code) ?? 0) + 1;
  ctx.reported.set(code, count);
  if (count === 1) {
    ctx.issues.push({ code, severity, outcome, message, context });
  } else {
    // Keep one issue per code and count occurrences instead of flooding.
    const existing = ctx.issues.find((i) => i.code === code);
    if (existing) existing.context = { ...existing.context, occurrences: count };
  }
}

/** Parse `word/styles.xml` into styleId → heading level. */
function parseHeadingStyles(stylesXml: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!stylesXml) return map;
  const root = parseXmlTree(stylesXml);
  for (const style of childElements(root)) {
    if (style.local !== "style" || attr(style, "type", W_NS) !== "paragraph") continue;
    const styleId = attr(style, "styleId", W_NS);
    if (!styleId) continue;

    let level: number | undefined;
    const pPr = firstChild(style, "pPr");
    const outline = pPr ? firstChild(pPr, "outlineLvl") : undefined;
    const outlineVal = outline ? Number(attr(outline, "val", W_NS)) : NaN;
    if (Number.isInteger(outlineVal) && outlineVal >= 0 && outlineVal <= 5) {
      level = outlineVal + 1;
    }
    if (level === undefined) {
      const name = firstChild(style, "name");
      const nameVal = name ? (attr(name, "val", W_NS) ?? "") : "";
      const match = /^heading ([1-6])$/i.exec(nameVal) ?? /^Heading([1-6])$/.exec(styleId);
      if (match) level = Number(match[1]);
    }
    if (level !== undefined) map.set(styleId, level);
  }
  return map;
}

/** Parse `word/numbering.xml` into numId → ilvl → ordered?. */
function parseNumbering(numberingXml: string | undefined): Map<string, Map<number, boolean>> {
  const map = new Map<string, Map<number, boolean>>();
  if (!numberingXml) return map;
  const root = parseXmlTree(numberingXml);

  const abstractLevels = new Map<string, Map<number, boolean>>();
  for (const el of childElements(root)) {
    if (el.local === "abstractNum") {
      const id = attr(el, "abstractNumId", W_NS);
      if (!id) continue;
      const levels = new Map<number, boolean>();
      for (const lvl of childElements(el)) {
        if (lvl.local !== "lvl") continue;
        const ilvl = Number(attr(lvl, "ilvl", W_NS));
        const numFmt = firstChild(lvl, "numFmt");
        const fmt = numFmt ? attr(numFmt, "val", W_NS) : undefined;
        if (Number.isInteger(ilvl)) levels.set(ilvl, fmt !== "bullet" && fmt !== "none");
      }
      abstractLevels.set(id, levels);
    }
  }
  for (const el of childElements(root)) {
    if (el.local === "num") {
      const numId = attr(el, "numId", W_NS);
      const abstractRef = firstChild(el, "abstractNumId");
      const abstractId = abstractRef ? attr(abstractRef, "val", W_NS) : undefined;
      if (numId && abstractId && abstractLevels.has(abstractId)) {
        map.set(numId, abstractLevels.get(abstractId)!);
      }
    }
  }
  return map;
}

/** Parse `word/_rels/document.xml.rels` into rId → external hyperlink URL. */
function parseHyperlinkRels(relsXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const root = parseXmlTree(relsXml);
  for (const rel of childElements(root)) {
    if (rel.local !== "Relationship" || rel.uri !== REL_NS) continue;
    if (attr(rel, "Type") !== HYPERLINK_REL) continue;
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id && target && attr(rel, "TargetMode") === "External") map.set(id, target);
  }
  return map;
}

function parseRuns(el: XmlElement, ctx: ParseContext, inherited?: ImportRunMarks): ImportRun[] {
  const runs: ImportRun[] = [];
  for (const child of childElements(el)) {
    switch (child.local) {
      case "r":
        runs.push(...parseRun(child, ctx, inherited));
        break;
      case "hyperlink": {
        const relId = attr(child, "id", R_NS);
        const anchor = attr(child, "anchor", W_NS);
        const href = relId ? ctx.hyperlinks.get(relId) : undefined;
        let marks = inherited;
        if (href) {
          let scheme: string | undefined;
          try {
            scheme = new URL(href).protocol;
          } catch {
            scheme = undefined;
          }
          if (scheme && SAFE_LINK_SCHEMES.has(scheme)) {
            marks = { ...inherited, link: { href } };
          } else {
            report(
              ctx,
              "docx-import/unsafe-link-scheme-dropped",
              "warning",
              "reported",
              "A hyperlink with a non-http(s)/mailto target was kept as plain text.",
            );
          }
        } else if (anchor) {
          report(
            ctx,
            "docx-import/internal-link-not-mapped",
            "warning",
            "reported",
            "An internal bookmark link was kept as plain text; anchor mapping arrives with the page-tree plan.",
          );
        }
        runs.push(...parseRuns(child, ctx, marks));
        break;
      }
      case "ins":
        // Accepted insertion: content survives, provenance is out of slice scope.
        report(
          ctx,
          "docx-import/revision-insertion-accepted",
          "info",
          "approximated",
          "Tracked insertions were accepted into the imported content.",
        );
        runs.push(...parseRuns(child, ctx, inherited));
        break;
      case "del":
        report(
          ctx,
          "docx-import/revision-deletion-dropped",
          "warning",
          "reported",
          "Tracked deletions were dropped (the deleted text is not imported).",
        );
        break;
      case "fldSimple":
        report(
          ctx,
          "docx-import/field-flattened",
          "info",
          "approximated",
          "A Word field was flattened to its cached display text.",
        );
        runs.push(...parseRuns(child, ctx, inherited));
        break;
      case "commentReference":
        report(
          ctx,
          "docx-import/comment-dropped",
          "warning",
          "reported",
          "Word comments are not imported by this slice.",
        );
        break;
      case "smartTag":
        runs.push(...parseRuns(child, ctx, inherited));
        break;
      default:
        if (!IGNORED_PARAGRAPH_MARKERS.has(child.local)) {
          report(
            ctx,
            `docx-import/unsupported-inline:${child.local}`,
            "warning",
            "reported",
            `Unsupported inline element <${child.local}> was omitted from the page.`,
            { element: child.local },
          );
        }
    }
  }
  return runs;
}

function parseRun(run: XmlElement, ctx: ParseContext, inherited?: ImportRunMarks): ImportRun[] {
  const marks: ImportRunMarks = { ...inherited };
  const rPr = firstChild(run, "rPr");
  if (rPr) {
    for (const prop of childElements(rPr)) {
      const off = attr(prop, "val", W_NS) === "false" || attr(prop, "val", W_NS) === "0";
      if (prop.local === "b" && !off) marks.bold = true;
      if (prop.local === "i" && !off) marks.italic = true;
      if (prop.local === "rStyle" && attr(prop, "val", W_NS)?.toLowerCase().includes("code")) {
        marks.code = true;
      }
    }
  }
  const cleaned: ImportRunMarks | undefined =
    marks.bold || marks.italic || marks.code || marks.link ? marks : undefined;

  const runs: ImportRun[] = [];
  for (const child of childElements(run)) {
    switch (child.local) {
      case "t":
        runs.push({ kind: "text", text: textContent(child), marks: cleaned });
        break;
      case "br":
        runs.push({ kind: "hard-break" });
        break;
      case "tab":
        runs.push({ kind: "text", text: "\t", marks: cleaned });
        break;
      case "drawing":
      case "pict":
      case "object":
        report(
          ctx,
          "docx-import/image-not-supported",
          "warning",
          "reported",
          "Images/drawings are not imported by this slice (media identity gate pending).",
        );
        break;
      case "rPr":
      case "lastRenderedPageBreak":
      case "noBreakHyphen":
      case "softHyphen":
        break;
      case "delText":
        // Only reachable inside w:del, which is dropped before runs are read.
        break;
      case "commentReference":
        report(
          ctx,
          "docx-import/comment-dropped",
          "warning",
          "reported",
          "Word comments are not imported by this slice.",
        );
        break;
      default:
        report(
          ctx,
          `docx-import/unsupported-run-content:${child.local}`,
          "warning",
          "reported",
          `Unsupported run content <${child.local}> was omitted from the page.`,
          { element: child.local },
        );
    }
  }
  return runs;
}

interface NumberedParagraph {
  ilvl: number;
  ordered: boolean;
  runs: ImportRun[];
}

function paragraphNumbering(
  p: XmlElement,
  ctx: ParseContext,
): { ilvl: number; ordered: boolean } | undefined {
  const pPr = firstChild(p, "pPr");
  const numPr = pPr ? firstChild(pPr, "numPr") : undefined;
  if (!numPr) return undefined;
  const numIdEl = firstChild(numPr, "numId");
  const ilvlEl = firstChild(numPr, "ilvl");
  const numId = numIdEl ? attr(numIdEl, "val", W_NS) : undefined;
  // numId 0 means "no numbering" (an override that removes list membership).
  if (!numId || numId === "0") return undefined;
  const ilvl = ilvlEl ? Number(attr(ilvlEl, "val", W_NS)) : 0;
  const levels = ctx.numbering.get(numId);
  const ordered = levels?.get(Number.isInteger(ilvl) ? ilvl : 0);
  if (ordered === undefined) {
    report(
      ctx,
      "docx-import/unknown-numbering-definition",
      "info",
      "approximated",
      "A list level had no numbering definition; it was imported as a bullet list.",
    );
  }
  return { ilvl: Number.isInteger(ilvl) && ilvl >= 0 ? ilvl : 0, ordered: ordered ?? false };
}

function headingLevel(p: XmlElement, ctx: ParseContext): number | undefined {
  const pPr = firstChild(p, "pPr");
  const pStyle = pPr ? firstChild(pPr, "pStyle") : undefined;
  const styleId = pStyle ? attr(pStyle, "val", W_NS) : undefined;
  if (!styleId) return undefined;
  return ctx.headingStyles.get(styleId);
}

/** Convert a run of consecutive numbered paragraphs into a nested list block. */
function buildList(paragraphs: NumberedParagraph[]): ImportListBlock {
  const base = Math.min(...paragraphs.map((p) => p.ilvl));
  const root: ImportListBlock = { type: "list", ordered: paragraphs[0].ordered, items: [] };
  // Stack of lists by depth; index 0 is `root` at `base`.
  const stack: ImportListBlock[] = [root];

  for (const p of paragraphs) {
    const depth = Math.max(0, p.ilvl - base);
    while (stack.length - 1 > depth) stack.pop();
    while (stack.length - 1 < depth) {
      const parent = stack[stack.length - 1];
      if (parent.items.length === 0) {
        // A child level cannot exist without a parent item; synthesize one.
        parent.items.push({ blocks: [{ type: "paragraph", runs: [] }] });
      }
      const parentItem = parent.items[parent.items.length - 1];
      const child: ImportListBlock = { type: "list", ordered: p.ordered, items: [] };
      parentItem.child = child;
      stack.push(child);
    }
    const target = stack[stack.length - 1];
    if (target.items.length === 0) target.ordered = p.ordered;
    const item: ImportListItem = { blocks: [{ type: "paragraph", runs: p.runs }] };
    target.items.push(item);
  }
  return root;
}

function parseTable(tbl: XmlElement, ctx: ParseContext, depth: number): ImportBlock[] {
  if (depth > 0) {
    report(
      ctx,
      "docx-import/nested-table-flattened",
      "warning",
      "approximated",
      "A table nested inside a table cell was flattened to paragraphs (Cloud nested-table acceptance is an open gate).",
    );
    const blocks: ImportBlock[] = [];
    for (const tr of childElements(tbl).filter((c) => c.local === "tr")) {
      for (const tc of childElements(tr).filter((c) => c.local === "tc")) {
        blocks.push(...parseBlocks(tc, ctx, depth));
      }
    }
    return blocks;
  }

  const rows: ImportTableRow[] = [];
  for (const tr of childElements(tbl).filter((c) => c.local === "tr")) {
    const trPr = firstChild(tr, "trPr");
    const isHeaderRow = trPr !== undefined && firstChild(trPr, "tblHeader") !== undefined;
    const cells = childElements(tr)
      .filter((c) => c.local === "tc")
      .map((tc) => {
        const vMerge = firstChild(tc, "tcPr") && firstChild(firstChild(tc, "tcPr")!, "vMerge");
        if (vMerge) {
          report(
            ctx,
            "docx-import/merged-cells-flattened",
            "warning",
            "approximated",
            "Vertically merged table cells were imported as separate cells.",
          );
        }
        return { header: isHeaderRow, blocks: parseBlocks(tc, ctx, depth + 1) };
      });
    if (cells.length > 0) rows.push({ cells });
  }
  return rows.length > 0 ? [{ type: "table", rows }] : [];
}

/** Parse the block children of a container (body, table cell). */
function parseBlocks(container: XmlElement, ctx: ParseContext, tableDepth: number): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  let pendingList: NumberedParagraph[] = [];

  const flushList = () => {
    if (pendingList.length > 0) {
      blocks.push(buildList(pendingList));
      pendingList = [];
    }
  };

  for (const child of childElements(container)) {
    switch (child.local) {
      case "p": {
        const numbering = paragraphNumbering(child, ctx);
        const runs = parseRuns(child, ctx);
        if (numbering) {
          pendingList.push({ ...numbering, runs });
          break;
        }
        flushList();
        const level = headingLevel(child, ctx);
        if (level !== undefined) {
          blocks.push({ type: "heading", level: level as 1 | 2 | 3 | 4 | 5 | 6, runs });
        } else if (runs.length > 0 || tableDepth > 0) {
          // Keep empty paragraphs inside table cells (cell shape), drop empty
          // body paragraphs (Word's spacing artifacts).
          blocks.push({ type: "paragraph", runs });
        }
        break;
      }
      case "tbl":
        flushList();
        blocks.push(...parseTable(child, ctx, tableDepth));
        break;
      case "sdt": {
        // Structured document tag: unwrap its content container.
        const content = firstChild(child, "sdtContent");
        if (content) {
          flushList();
          report(
            ctx,
            "docx-import/sdt-unwrapped",
            "info",
            "approximated",
            "A structured document tag (content control) was unwrapped to its plain content.",
          );
          blocks.push(...parseBlocks(content, ctx, tableDepth));
        }
        break;
      }
      case "tcPr":
        break;
      default:
        if (!IGNORED_BODY_MARKERS.has(child.local)) {
          report(
            ctx,
            `docx-import/unsupported-block:${child.local}`,
            "warning",
            "reported",
            `Unsupported block element <${child.local}> was omitted from the page.`,
            { element: child.local },
          );
        }
    }
  }
  flushList();
  return blocks;
}

function runsPlainText(runs: ImportRun[]): string {
  return runs
    .map((r) => (r.kind === "text" ? r.text : " "))
    .join("")
    .trim();
}

/**
 * Parse DOCX bytes into the neutral import document.
 *
 * @throws DocxError (from `unzipDocx`) for oversized, non-zip, non-DOCX, or
 * active-content packages — these are `rejected` outcomes, the import stops.
 */
export function parseDocx(bytes: Uint8Array): ImportedDocument {
  const zip = unzipDocx(bytes, DOCX_TEMPLATE_INTAKE_BUDGET);

  const readOptional = (part: string): string | undefined =>
    zip.file(part) ? readPartText(zip, part) : undefined;

  const ctx: ParseContext = {
    issues: [],
    headingStyles: parseHeadingStyles(readOptional("word/styles.xml")),
    numbering: parseNumbering(readOptional("word/numbering.xml")),
    hyperlinks: parseHyperlinkRels(readOptional("word/_rels/document.xml.rels")),
    reported: new Map(),
  };

  const documentXml = readPartText(zip, "word/document.xml");
  const root = parseXmlTree(documentXml);
  const body = firstChild(root, "body");
  if (!body) throw new Error("word/document.xml has no <w:body> element.");

  const blocks = parseBlocks(body, ctx, 0);

  const firstH1 = blocks.find(
    (b): b is Extract<ImportBlock, { type: "heading" }> => b.type === "heading" && b.level === 1,
  );
  const titleCandidate = firstH1 ? runsPlainText(firstH1.runs) || undefined : undefined;

  return { titleCandidate, blocks, issues: ctx.issues };
}

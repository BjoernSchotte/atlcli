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
  ImportAsset,
  ImportImageBlock,
  ImportIssue,
  ImportListBlock,
  ImportListItem,
  ImportRun,
  ImportRunMarks,
  ImportTableRow,
} from "@atlcli/import-core";
import { IMPORT_DOCUMENT_SCHEMA_V2 } from "@atlcli/import-core";
import type {
  DocxImportBlock as ImportBlock,
  ImportedDocument,
  ImportComment,
} from "./model.js";
import { attr, childElements, firstChild, parseXmlTree, textContent, type XmlElement } from "./xml.js";
import type { StyleMappingTarget } from "./overrides.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const IMAGE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** EMU per CSS pixel (914400 EMU/inch ÷ 96 px/inch). */
const EMU_PER_PX = 9525;

/** Raster/vector formats Confluence can attach AND render in a media node. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Paragraph-level children that are markers/metadata, not content. */
const IGNORED_PARAGRAPH_MARKERS = new Set(["pPr", "bookmarkEnd", "proofErr"]);

/** Body-level children that are layout/metadata, not content. */
const IGNORED_BODY_MARKERS = new Set(["sectPr", "bookmarkEnd", "proofErr"]);

interface ParseContext {
  issues: ImportIssue[];
  /** Effective revisions policy (plan 007 options). */
  revisions: "accept" | "reject";
  /** styleId → heading level (1-6). */
  styles: ParagraphStyles;
  /** numId → ilvl → resolved level definition. */
  numbering: Map<string, Map<number, NumberingLevel>>;
  /** numId → live counters (index = ilvl), advanced in document order. */
  numberingCounters: Map<string, number[]>;
  /** relationship id → external URL. */
  hyperlinks: Map<string, string>;
  /** relationship id → internal image part path (word/-relative resolved). */
  imageRels: Map<string, string>;
  /** Extracted assets, keyed by asset id (one per referenced part). */
  assets: Map<string, ImportAsset>;
  /** Reads image part bytes; returns undefined for missing parts. */
  readImagePart: (part: string) => Uint8Array | undefined;
  /**
   * Images collected while walking the current paragraph's runs; drained by
   * the paragraph handler into block-level image nodes.
   */
  pendingImages: ImportImageBlock[];
  /** Bookmark names awaiting attachment to the next produced block. */
  pendingBookmarks: string[];
  /** Comment ranges currently open (id → text collected so far). */
  openCommentAnchors: Map<string, string>;
  /** Finished comment ranges (id → exact anchored text). */
  commentAnchors: Map<string, string>;
  /** Comment ids whose range STARTED in the current paragraph. */
  pendingCommentStarts: string[];
  /** Comment id → the top-level block owning its range start (split owner). */
  commentOwnerBlocks: Map<string, ImportBlock>;
  /** footnote id → `<w:footnote>` element from word/footnotes.xml. */
  footnotes: Map<string, XmlElement>;
  /** Footnote ids in first-reference order (1-based numbering source). */
  footnoteRefs: string[];
  /** issue codes already reported once (deduplicated counters). */
  reported: Map<string, number>;
  /** Deterministic traversal identity counter for target blocks and cells. */
  nextNodeId: number;
}

function nodeId(ctx: ParseContext, kind: string): string {
  const id = `docx:${kind}:${ctx.nextNodeId}`;
  ctx.nextNodeId += 1;
  return id;
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

interface ParagraphStyles {
  /** styleId → heading level (1-6). */
  headings: Map<string, number>;
  /** styleIds whose paragraphs are quotations. */
  quotes: Set<string>;
  /** styleIds whose paragraphs are preformatted code. */
  code: Set<string>;
}

const QUOTE_STYLE_NAME = /^(intense\s+)?quote$|^(intensives\s+)?zitat$|^block\s*quote/i;
const CODE_STYLE_NAME = /^(source\s+)?code|^html\s+preformatted|^preformatted|^macro\s*text/i;

/**
 * Parse `word/styles.xml` into heading/quote/code paragraph-style maps.
 *
 * Explicit style mappings (plan 007 baseline overrides, keyed by lowercased
 * styleId OR display name) win over the built-in heuristics; `paragraph`
 * suppresses a heuristic classification entirely.
 */
function parseParagraphStyles(
  stylesXml: string | undefined,
  styleMappings: Record<string, StyleMappingTarget> = {},
): ParagraphStyles & { matchedMappingKeys: Set<string> } {
  const styles: ParagraphStyles & { matchedMappingKeys: Set<string> } = {
    headings: new Map(),
    quotes: new Set(),
    code: new Set(),
    matchedMappingKeys: new Set(),
  };
  if (!stylesXml) return styles;
  const root = parseXmlTree(stylesXml);
  for (const style of childElements(root)) {
    if (style.local !== "style" || attr(style, "type", W_NS) !== "paragraph") continue;
    const styleId = attr(style, "styleId", W_NS);
    if (!styleId) continue;
    const name = firstChild(style, "name");
    const nameVal = name ? (attr(name, "val", W_NS) ?? "") : "";

    const mappingKey = [styleId.toLowerCase(), nameVal.toLowerCase()].find(
      (key) => key && key in styleMappings,
    );
    if (mappingKey) {
      styles.matchedMappingKeys.add(mappingKey);
      const target = styleMappings[mappingKey];
      const headingMatch = /^heading-([1-6])$/.exec(target);
      if (headingMatch) styles.headings.set(styleId, Number(headingMatch[1]));
      else if (target === "blockquote") styles.quotes.add(styleId);
      else if (target === "code") styles.code.add(styleId);
      // "paragraph": no classification — heuristic suppressed.
      continue;
    }

    let level: number | undefined;
    const pPr = firstChild(style, "pPr");
    const outline = pPr ? firstChild(pPr, "outlineLvl") : undefined;
    const outlineVal = outline ? Number(attr(outline, "val", W_NS)) : NaN;
    if (Number.isInteger(outlineVal) && outlineVal >= 0 && outlineVal <= 5) {
      level = outlineVal + 1;
    }
    if (level === undefined) {
      const match = /^heading ([1-6])$/i.exec(nameVal) ?? /^Heading([1-6])$/.exec(styleId);
      if (match) level = Number(match[1]);
    }
    if (level !== undefined) {
      styles.headings.set(styleId, level);
      continue;
    }
    if (QUOTE_STYLE_NAME.test(nameVal) || /^(Intense)?Quote$/.test(styleId)) {
      styles.quotes.add(styleId);
    } else if (CODE_STYLE_NAME.test(nameVal) || /^(Source)?Code|^HTMLPreformatted$/.test(styleId)) {
      styles.code.add(styleId);
    }
  }
  return styles;
}

/** One resolved `w:lvl` definition. */
interface NumberingLevel {
  /** False for `bullet`/`none` formats. */
  ordered: boolean;
  /** OOXML `numFmt` value (`decimal`, `lowerLetter`, `upperRoman`, …). */
  numFmt: string;
  /** `lvlText` pattern with `%1`…`%9` placeholders, when declared. */
  lvlText?: string;
  /** Counter start value (default 1). */
  start: number;
}

/** Parse `word/numbering.xml` into numId → ilvl → level definition. */
function parseNumbering(
  numberingXml: string | undefined,
): Map<string, Map<number, NumberingLevel>> {
  const map = new Map<string, Map<number, NumberingLevel>>();
  if (!numberingXml) return map;
  const root = parseXmlTree(numberingXml);

  const abstractLevels = new Map<string, Map<number, NumberingLevel>>();
  for (const el of childElements(root)) {
    if (el.local === "abstractNum") {
      const id = attr(el, "abstractNumId", W_NS);
      if (!id) continue;
      const levels = new Map<number, NumberingLevel>();
      for (const lvl of childElements(el)) {
        if (lvl.local !== "lvl") continue;
        const ilvl = Number(attr(lvl, "ilvl", W_NS));
        if (!Number.isInteger(ilvl)) continue;
        const fmtEl = firstChild(lvl, "numFmt");
        const numFmt = (fmtEl ? attr(fmtEl, "val", W_NS) : undefined) ?? "decimal";
        const lvlTextEl = firstChild(lvl, "lvlText");
        const lvlText = lvlTextEl ? attr(lvlTextEl, "val", W_NS) : undefined;
        const startEl = firstChild(lvl, "start");
        const startVal = startEl ? Number(attr(startEl, "val", W_NS)) : NaN;
        levels.set(ilvl, {
          ordered: numFmt !== "bullet" && numFmt !== "none",
          numFmt,
          lvlText,
          start: Number.isInteger(startVal) && startVal >= 0 ? startVal : 1,
        });
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

const ROMAN_NUMERALS: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** Render one counter value in an OOXML `numFmt`. */
function formatCounter(numFmt: string, value: number): string {
  const n = Math.max(1, value);
  switch (numFmt) {
    case "lowerLetter":
    case "upperLetter": {
      // 1→a … 26→z, 27→aa (OOXML wraps alphabetically).
      let out = "";
      let v = n;
      while (v > 0) {
        out = String.fromCharCode(97 + ((v - 1) % 26)) + out;
        v = Math.floor((v - 1) / 26);
      }
      return numFmt === "upperLetter" ? out.toUpperCase() : out;
    }
    case "lowerRoman":
    case "upperRoman": {
      let out = "";
      let v = n;
      for (const [num, sym] of ROMAN_NUMERALS) {
        while (v >= num) {
          out += sym;
          v -= num;
        }
      }
      return numFmt === "upperRoman" ? out.toUpperCase() : out;
    }
    default:
      return String(n);
  }
}

/**
 * Advance the numbering state for one numbered paragraph and return its
 * visible label, or undefined for bullet/undefined levels.
 *
 * Word restarts deeper levels whenever a shallower level advances; shallower
 * placeholders that were never hit render at their start value.
 */
function advanceNumbering(ctx: ParseContext, numId: string, ilvl: number): string | undefined {
  const levels = ctx.numbering.get(numId);
  if (!levels) return undefined;

  let counters = ctx.numberingCounters.get(numId);
  if (!counters) {
    counters = Array.from({ length: 9 }, (_, i) => (levels.get(i)?.start ?? 1) - 1);
    ctx.numberingCounters.set(numId, counters);
  }
  counters[ilvl] += 1;
  for (let i = ilvl + 1; i < counters.length; i++) {
    counters[i] = (levels.get(i)?.start ?? 1) - 1;
  }

  const level = levels.get(ilvl);
  if (!level || !level.ordered) return undefined;

  const pattern = level.lvlText ?? `%${ilvl + 1}.`;
  const label = pattern
    .replace(/%(\d)/g, (_, digit: string) => {
      const idx = Number(digit) - 1;
      const fmt = levels.get(idx)?.numFmt ?? "decimal";
      const value = Math.max(counters![idx], levels.get(idx)?.start ?? 1);
      return formatCounter(fmt, value);
    })
    .trim();
  // Word suffixes most heading patterns with a trailing dot; the citable
  // identifier is the bare label ("1.2", not "1.2.").
  return label.replace(/\.$/, "") || undefined;
}

interface DocumentRels {
  /** rId → external hyperlink URL. */
  hyperlinks: Map<string, string>;
  /** rId → zip part path of an internal image (e.g. `word/media/image1.png`). */
  images: Map<string, string>;
}

/** Resolve a word/-relative rels target to a normalized zip part path. */
function resolveWordRelTarget(target: string): string {
  const joined = target.startsWith("/") ? target.slice(1) : `word/${target}`;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Parse `word/_rels/document.xml.rels` into hyperlink and image maps. */
function parseDocumentRels(relsXml: string | undefined): DocumentRels {
  const rels: DocumentRels = { hyperlinks: new Map(), images: new Map() };
  if (!relsXml) return rels;
  const root = parseXmlTree(relsXml);
  for (const rel of childElements(root)) {
    if (rel.local !== "Relationship" || rel.uri !== REL_NS) continue;
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    const type = attr(rel, "Type");
    if (type === HYPERLINK_REL && external) {
      rels.hyperlinks.set(id, target);
    } else if (type === IMAGE_REL && !external) {
      rels.images.set(id, resolveWordRelTarget(target));
    }
  }
  return rels;
}

/** Depth-first search for the first descendant element with a local name. */
function findDescendant(el: XmlElement, local: string): XmlElement | undefined {
  for (const child of childElements(el)) {
    if (child.local === local) return child;
    const found = findDescendant(child, local);
    if (found) return found;
  }
  return undefined;
}

/**
 * Extract a DrawingML image reference from a `w:drawing` and register its
 * bytes as an asset. Returns undefined (with a reported issue) when the
 * drawing carries no importable raster/vector image.
 */
function extractDrawing(drawing: XmlElement, ctx: ParseContext): ImportImageBlock | undefined {
  const blip = findDescendant(drawing, "blip");
  const relId = blip ? attr(blip, "embed", R_NS) : undefined;
  const part = relId ? ctx.imageRels.get(relId) : undefined;
  if (!part) {
    report(
      ctx,
      "docx-import/drawing-without-image",
      "warning",
      "reported",
      "A drawing without an embedded local image (shape, chart, or linked picture) was omitted.",
    );
    return undefined;
  }

  const extension = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[extension];
  if (!mediaType) {
    report(
      ctx,
      "docx-import/image-format-not-supported",
      "warning",
      "reported",
      `Embedded images of type .${extension} (e.g. EMF/WMF) are not imported.`,
      { extension },
    );
    return undefined;
  }

  if (!ctx.assets.has(part)) {
    const bytes = ctx.readImagePart(part);
    if (!bytes) {
      report(
        ctx,
        "docx-import/image-part-missing",
        "warning",
        "reported",
        "An image relationship points at a missing package part; the image was omitted.",
      );
      return undefined;
    }
    const fileName = part.slice(part.lastIndexOf("/") + 1);
    ctx.assets.set(part, { id: part, fileName, mediaType, bytes });
  }

  const extent = findDescendant(drawing, "extent");
  const cx = extent ? Number(attr(extent, "cx")) : NaN;
  const cy = extent ? Number(attr(extent, "cy")) : NaN;
  const docPr = findDescendant(drawing, "docPr");
  const alt = docPr ? (attr(docPr, "descr") ?? attr(docPr, "name")) : undefined;

  return {
    id: nodeId(ctx, "image"),
    type: "image",
    assetId: part,
    ...(alt ? { alt } : {}),
    ...(Number.isFinite(cx) && cx > 0 ? { width: Math.round(cx / EMU_PER_PX) } : {}),
    ...(Number.isFinite(cy) && cy > 0 ? { height: Math.round(cy / EMU_PER_PX) } : {}),
  };
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
          } else if (
            scheme === undefined &&
            /^[^\\:*?"<>|]+\.docx(#[^#]*)?$/i.test(href) &&
            !href.startsWith("/")
          ) {
            // Relative link to a sibling DOCX (plan 010 cross-file links).
            const hash = href.indexOf("#");
            marks = {
              ...inherited,
              reference: {
                namespace: "docx-file",
                target: (hash === -1 ? href : href.slice(0, hash)).replace(/\\/g, "/"),
                ...(hash !== -1 && href.slice(hash + 1) ? { fragment: href.slice(hash + 1) } : {}),
              },
            };
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
          // Cross-reference to a bookmark: carried as a typed mark and
          // resolved to a page link at encode time (plan 009 link rewrite).
          marks = { ...inherited, reference: { namespace: "docx-bookmark", target: anchor } };
        }
        runs.push(...parseRuns(child, ctx, marks));
        break;
      }
      case "ins":
        if (ctx.revisions === "reject") {
          report(
            ctx,
            "docx-import/revision-insertion-rejected",
            "warning",
            "reported",
            "Tracked insertions were rejected (policy revisions=reject); the inserted text is not imported.",
          );
          break;
        }
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
        if (ctx.revisions === "reject") {
          report(
            ctx,
            "docx-import/revision-deletion-kept",
            "info",
            "approximated",
            "Tracked deletions were kept (policy revisions=reject); the deleted text remains in the content.",
          );
          runs.push(...parseRuns(child, ctx, inherited));
          break;
        }
        report(
          ctx,
          "docx-import/revision-deletion-dropped",
          "warning",
          "reported",
          "Tracked deletions were dropped (the deleted text is not imported).",
        );
        break;
      case "fldSimple": {
        // REF/PAGEREF fields are cross-references to a bookmark — keep the
        // cached display text AND the typed anchor for link rewriting.
        const instr = attr(child, "instr", W_NS) ?? "";
        const refMatch = /^\s*(?:REF|PAGEREF)\s+([^\s\\]+)/.exec(instr);
        if (refMatch) {
          runs.push(...parseRuns(child, ctx, {
            ...inherited,
            reference: { namespace: "docx-bookmark", target: refMatch[1] },
          }));
          break;
        }
        report(
          ctx,
          "docx-import/field-flattened",
          "info",
          "approximated",
          "A Word field was flattened to its cached display text.",
        );
        runs.push(...parseRuns(child, ctx, inherited));
        break;
      }
      case "commentReference":
        break;
      case "smartTag":
        runs.push(...parseRuns(child, ctx, inherited));
        break;
      case "bookmarkStart": {
        const name = attr(child, "name", W_NS);
        if (name && !name.startsWith("_GoBack")) ctx.pendingBookmarks.push(name);
        break;
      }
      case "commentRangeStart": {
        const id = attr(child, "id", W_NS);
        if (id) {
          ctx.openCommentAnchors.set(id, "");
          ctx.pendingCommentStarts.push(id);
        }
        break;
      }
      case "commentRangeEnd": {
        const id = attr(child, "id", W_NS);
        if (id && ctx.openCommentAnchors.has(id)) {
          ctx.commentAnchors.set(id, ctx.openCommentAnchors.get(id)!.trim());
          ctx.openCommentAnchors.delete(id);
        }
        break;
      }
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
    marks.bold || marks.italic || marks.code || marks.link || marks.reference
      ? marks
      : undefined;

  const appendToOpenAnchors = (text: string): void => {
    for (const [id, collected] of ctx.openCommentAnchors) {
      ctx.openCommentAnchors.set(id, collected + text);
    }
  };

  const runs: ImportRun[] = [];
  for (const child of childElements(run)) {
    switch (child.local) {
      case "t": {
        const text = textContent(child);
        appendToOpenAnchors(text);
        runs.push({ kind: "text", text, marks: cleaned });
        break;
      }
      case "br":
        runs.push({ kind: "hard-break" });
        break;
      case "tab":
        runs.push({ kind: "text", text: "\t", marks: cleaned });
        break;
      case "drawing": {
        const image = extractDrawing(child, ctx);
        if (image) ctx.pendingImages.push(image);
        break;
      }
      case "pict":
      case "object":
        report(
          ctx,
          "docx-import/legacy-image-not-supported",
          "warning",
          "reported",
          "Legacy VML pictures/embedded objects are not imported.",
        );
        break;
      case "rPr":
      case "lastRenderedPageBreak":
      case "noBreakHyphen":
      case "softHyphen":
        break;
      case "delText":
        // Only reachable inside w:del when revisions=reject keeps deletions.
        runs.push({ kind: "text", text: textContent(child), marks: cleaned });
        break;
      case "commentReference":
        // Comments are imported via word/comments.xml (parseComments); the
        // inline reference marker itself produces no page content.
        break;
      case "footnoteReference": {
        const id = attr(child, "id", W_NS);
        if (id && ctx.footnotes.has(id)) {
          let index = ctx.footnoteRefs.indexOf(id);
          if (index === -1) {
            ctx.footnoteRefs.push(id);
            index = ctx.footnoteRefs.length - 1;
          }
          runs.push({ kind: "text", text: `[${index + 1}]` });
        } else {
          report(
            ctx,
            "docx-import/footnote-missing",
            "warning",
            "reported",
            "A footnote reference points at a missing footnote definition.",
          );
        }
        break;
      }
      case "endnoteReference":
        report(
          ctx,
          "docx-import/endnote-dropped",
          "warning",
          "reported",
          "Endnotes are not imported yet; the endnote marker was omitted.",
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

const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

/**
 * Parse word/comments.xml (+ optional word/commentsExtended.xml for reply
 * threading and resolved state) into the comment tree. Thread metadata maps
 * through the LAST paragraph's `w14:paraId` of each comment body — the
 * documented `commentsExtended` join key.
 */
function parseComments(
  commentsXml: string | undefined,
  commentsExtendedXml: string | undefined,
  anchors: Map<string, string>,
  ctx: ParseContext,
): ImportComment[] {
  if (!commentsXml) return [];
  const root = parseXmlTree(commentsXml);

  interface RawComment {
    comment: ImportComment;
    /** w14:paraId of the last body paragraph (commentsExtended join key). */
    lastParaId?: string;
  }
  const raw: RawComment[] = [];
  for (const el of childElements(root)) {
    if (el.local !== "comment") continue;
    const id = attr(el, "id", W_NS);
    if (!id) continue;
    const paragraphs = childElements(el).filter((c) => c.local === "p");
    const text = paragraphs
      .map((p) => textContent(p).trim())
      .filter(Boolean)
      .join("\n");
    const last = paragraphs[paragraphs.length - 1];
    raw.push({
      comment: {
        id,
        author: attr(el, "author", W_NS) ?? "unknown",
        ...(attr(el, "date", W_NS) ? { date: attr(el, "date", W_NS) } : {}),
        text,
        resolved: false,
        replies: [],
        ...(anchors.has(id) && anchors.get(id) ? { anchorText: anchors.get(id) } : {}),
      },
      lastParaId: last ? attr(last, "paraId", W14_NS) : undefined,
    });
  }
  if (raw.length === 0) return [];

  // Thread metadata: paraId → { parentParaId, done }.
  const threads = new Map<string, { parent?: string; done: boolean }>();
  if (commentsExtendedXml) {
    const extRoot = parseXmlTree(commentsExtendedXml);
    for (const el of childElements(extRoot)) {
      if (el.local !== "commentEx") continue;
      const paraId = attr(el, "paraId", W15_NS);
      if (!paraId) continue;
      threads.set(paraId, {
        parent: attr(el, "paraIdParent", W15_NS),
        done: attr(el, "done", W15_NS) === "1",
      });
    }
  } else {
    report(
      ctx,
      "docx-import/comment-threads-unavailable",
      "info",
      "approximated",
      "commentsExtended.xml is missing; comments import unthreaded and unresolved.",
    );
  }

  const byParaId = new Map<string, RawComment>();
  for (const item of raw) if (item.lastParaId) byParaId.set(item.lastParaId, item);

  const topLevel: ImportComment[] = [];
  for (const item of raw) {
    const thread = item.lastParaId ? threads.get(item.lastParaId) : undefined;
    if (thread?.done) item.comment.resolved = true;
    const parent = thread?.parent ? byParaId.get(thread.parent) : undefined;
    if (parent && parent !== item) parent.comment.replies.push(item.comment);
    else topLevel.push(item.comment);
  }
  return topLevel;
}

/** Parse word/footnotes.xml into id → footnote element (separators skipped). */
function parseFootnotes(footnotesXml: string | undefined): Map<string, XmlElement> {
  const map = new Map<string, XmlElement>();
  if (!footnotesXml) return map;
  const root = parseXmlTree(footnotesXml);
  for (const fn of childElements(root)) {
    if (fn.local !== "footnote") continue;
    const type = attr(fn, "type", W_NS);
    if (type === "separator" || type === "continuationSeparator") continue;
    const id = attr(fn, "id", W_NS);
    if (id) map.set(id, fn);
  }
  return map;
}

interface NumberedParagraph {
  ilvl: number;
  ordered: boolean;
  runs: ImportRun[];
}

function paragraphNumbering(
  p: XmlElement,
  ctx: ParseContext,
): { numId: string; ilvl: number; ordered: boolean } | undefined {
  const pPr = firstChild(p, "pPr");
  const numPr = pPr ? firstChild(pPr, "numPr") : undefined;
  if (!numPr) return undefined;
  const numIdEl = firstChild(numPr, "numId");
  const ilvlEl = firstChild(numPr, "ilvl");
  const numId = numIdEl ? attr(numIdEl, "val", W_NS) : undefined;
  // numId 0 means "no numbering" (an override that removes list membership).
  if (!numId || numId === "0") return undefined;
  const rawIlvl = ilvlEl ? Number(attr(ilvlEl, "val", W_NS)) : 0;
  const ilvl = Number.isInteger(rawIlvl) && rawIlvl >= 0 ? rawIlvl : 0;
  const level = ctx.numbering.get(numId)?.get(ilvl);
  if (level === undefined) {
    report(
      ctx,
      "docx-import/unknown-numbering-definition",
      "info",
      "approximated",
      "A list level had no numbering definition; it was imported as a bullet list.",
    );
  }
  return { numId, ilvl, ordered: level?.ordered ?? false };
}

function paragraphStyleId(p: XmlElement): string | undefined {
  const pPr = firstChild(p, "pPr");
  const pStyle = pPr ? firstChild(pPr, "pStyle") : undefined;
  return pStyle ? attr(pStyle, "val", W_NS) : undefined;
}

function headingLevel(p: XmlElement, ctx: ParseContext): number | undefined {
  const styleId = paragraphStyleId(p);
  return styleId ? ctx.styles.headings.get(styleId) : undefined;
}

/** Convert a run of consecutive numbered paragraphs into a nested list block. */
function buildList(paragraphs: NumberedParagraph[], ctx: ParseContext): ImportListBlock {
  const base = Math.min(...paragraphs.map((p) => p.ilvl));
  const root: ImportListBlock = { id: nodeId(ctx, "list"), type: "list", ordered: paragraphs[0].ordered, items: [] };
  // Stack of lists by depth; index 0 is `root` at `base`.
  const stack: ImportListBlock[] = [root];

  for (const p of paragraphs) {
    const depth = Math.max(0, p.ilvl - base);
    while (stack.length - 1 > depth) stack.pop();
    while (stack.length - 1 < depth) {
      const parent = stack[stack.length - 1];
      if (parent.items.length === 0) {
        // A child level cannot exist without a parent item; synthesize one.
        parent.items.push({ blocks: [{ id: nodeId(ctx, "paragraph"), type: "paragraph", runs: [] }] });
      }
      const parentItem = parent.items[parent.items.length - 1];
      const child: ImportListBlock = { id: nodeId(ctx, "list"), type: "list", ordered: p.ordered, items: [] };
      parentItem.child = child;
      stack.push(child);
    }
    const target = stack[stack.length - 1];
    if (target.items.length === 0) target.ordered = p.ordered;
    const item: ImportListItem = { blocks: [{ id: nodeId(ctx, "paragraph"), type: "paragraph", runs: p.runs }] };
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
        return { id: nodeId(ctx, "table-cell"), header: isHeaderRow, blocks: parseBlocks(tc, ctx, depth + 1) };
      });
    if (cells.length > 0) rows.push({ cells });
  }
  return rows.length > 0 ? [{ id: nodeId(ctx, "table"), type: "table", rows }] : [];
}

function runsToPlainText(runs: ImportRun[]): string {
  return runs.map((r) => (r.kind === "text" ? r.text : "\n")).join("");
}

/** Parse the block children of a container (body, table cell). */
function parseBlocks(container: XmlElement, ctx: ParseContext, tableDepth: number): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  let pendingList: NumberedParagraph[] = [];
  let pendingQuote: ImportBlock[] = [];
  let pendingCode: string[] = [];

  const flushPending = () => {
    if (pendingList.length > 0) {
      blocks.push(buildList(pendingList, ctx));
      pendingList = [];
    }
    if (pendingQuote.length > 0) {
      blocks.push({ id: nodeId(ctx, "blockquote"), type: "blockquote", blocks: pendingQuote });
      pendingQuote = [];
    }
    if (pendingCode.length > 0) {
      blocks.push({ id: nodeId(ctx, "code"), type: "code", text: pendingCode.join("\n") });
      pendingCode = [];
    }
  };

  for (const child of childElements(container)) {
    switch (child.local) {
      case "p": {
        const numbering = paragraphNumbering(child, ctx);
        const level = headingLevel(child, ctx);
        const runs = parseRuns(child, ctx);
        // Images are block-level in the IR: a paragraph's embedded drawings
        // surface as image blocks right after (or instead of) the paragraph.
        const images = ctx.pendingImages.splice(0, ctx.pendingImages.length);

        // A numbered paragraph advances the shared counters regardless of
        // whether the label is used (heading) or rendered natively (list).
        const label = numbering
          ? advanceNumbering(ctx, numbering.numId, numbering.ilvl)
          : undefined;

        // Heading semantics win over list membership: Word's multilevel
        // heading numbering attaches w:numPr to heading paragraphs, and
        // importing them as list items would destroy the document structure
        // (specs/import-docx/002-heading-numbering).
        const bookmarks = ctx.pendingBookmarks.splice(0, ctx.pendingBookmarks.length);
        const commentStarts = ctx.pendingCommentStarts.splice(0, ctx.pendingCommentStarts.length);
        const ownBlock = (block: ImportBlock): ImportBlock => {
          for (const id of commentStarts) {
            if (!ctx.commentOwnerBlocks.has(id)) ctx.commentOwnerBlocks.set(id, block);
          }
          return block;
        };
        if (level !== undefined) {
          flushPending();
          blocks.push(
            ownBlock({
              id: nodeId(ctx, "heading"),
              type: "heading",
              level: level as 1 | 2 | 3 | 4 | 5 | 6,
              runs,
              ...(label ? { label } : {}),
              ...(bookmarks.length > 0 ? { bookmarks } : {}),
            }),
          );
          blocks.push(...images);
          break;
        }
        if (numbering) {
          pendingList.push({ ilvl: numbering.ilvl, ordered: numbering.ordered, runs });
          if (images.length > 0) {
            flushPending();
            blocks.push(...images);
          }
          break;
        }

        // Quote/code styled paragraphs group with their neighbors.
        const styleId = paragraphStyleId(child);
        if (styleId && ctx.styles.quotes.has(styleId)) {
          // Only list/code groups can be open here; flushing them cannot
          // touch an open quote group (groups are mutually exclusive).
          if (pendingList.length > 0 || pendingCode.length > 0) flushPending();
          pendingQuote.push({ id: nodeId(ctx, "paragraph"), type: "paragraph", runs });
          blocks.push(...images);
          break;
        }
        if (styleId && ctx.styles.code.has(styleId)) {
          if (pendingList.length > 0 || pendingQuote.length > 0) flushPending();
          pendingCode.push(runsToPlainText(runs));
          blocks.push(...images);
          break;
        }

        flushPending();
        if (runs.length > 0 || (tableDepth > 0 && images.length === 0)) {
          // Keep empty paragraphs inside table cells (cell shape), drop empty
          // body paragraphs (Word's spacing artifacts).
          blocks.push(
            ownBlock({
              id: nodeId(ctx, "paragraph"),
              type: "paragraph",
              runs,
              ...(bookmarks.length > 0 ? { bookmarks } : {}),
            }),
          );
        } else if (bookmarks.length > 0) {
          // Bookmark on a dropped empty paragraph: re-queue for the next block.
          ctx.pendingBookmarks.push(...bookmarks);
        }
        blocks.push(...images);
        break;
      }
      case "tbl":
        flushPending();
        blocks.push(...parseTable(child, ctx, tableDepth));
        break;
      case "sdt": {
        // Structured document tag: unwrap its content container.
        const content = firstChild(child, "sdtContent");
        if (content) {
          flushPending();
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
      case "bookmarkStart": {
        const name = attr(child, "name", W_NS);
        if (name && !name.startsWith("_GoBack")) ctx.pendingBookmarks.push(name);
        break;
      }
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
  flushPending();
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
export interface ParseDocxPolicy {
  /** Lowercased style key (styleId or name) → mapping target (plan 007). */
  styleMappings?: Record<string, StyleMappingTarget>;
  revisions?: "accept" | "reject";
}

export function parseDocx(bytes: Uint8Array, policy: ParseDocxPolicy = {}): ImportedDocument {
  const zip = unzipDocx(bytes, DOCX_TEMPLATE_INTAKE_BUDGET);

  const readOptional = (part: string): string | undefined =>
    zip.file(part) ? readPartText(zip, part) : undefined;

  const rels = parseDocumentRels(readOptional("word/_rels/document.xml.rels"));
  const styles = parseParagraphStyles(readOptional("word/styles.xml"), policy.styleMappings ?? {});
  const ctx: ParseContext = {
    issues: [],
    revisions: policy.revisions ?? "accept",
    styles,
    numbering: parseNumbering(readOptional("word/numbering.xml")),
    numberingCounters: new Map(),
    hyperlinks: rels.hyperlinks,
    imageRels: rels.images,
    assets: new Map(),
    readImagePart: (part) => {
      const file = zip.file(part);
      if (!file) return undefined;
      return new Uint8Array(file.asUint8Array());
    },
    pendingImages: [],
    pendingBookmarks: [],
    openCommentAnchors: new Map(),
    commentAnchors: new Map(),
    pendingCommentStarts: [],
    commentOwnerBlocks: new Map(),
    footnotes: parseFootnotes(readOptional("word/footnotes.xml")),
    footnoteRefs: [],
    reported: new Map(),
    nextNodeId: 1,
  };

  for (const key of Object.keys(policy.styleMappings ?? {})) {
    if (!styles.matchedMappingKeys.has(key)) {
      report(
        ctx,
        "docx-import/style-mapping-unmatched",
        "info",
        "reported",
        `Style mapping "${key}" matched no paragraph style in this document.`,
        { style: key },
      );
    }
  }

  const documentXml = readPartText(zip, "word/document.xml");
  const root = parseXmlTree(documentXml);
  const body = firstChild(root, "body");
  if (!body) throw new Error("word/document.xml has no <w:body> element.");

  const blocks = parseBlocks(body, ctx, 0);

  // Referenced footnotes append as a trailing section in reference order,
  // matching the [n] markers emitted inline (Confluence has no native
  // footnote node).
  if (ctx.footnoteRefs.length > 0) {
    const footnoteRels = parseDocumentRels(readOptional("word/_rels/footnotes.xml.rels"));
    const footnoteCtx: ParseContext = {
      ...ctx,
      hyperlinks: footnoteRels.hyperlinks,
      imageRels: new Map(),
      pendingImages: [],
    };
    for (const [index, id] of ctx.footnoteRefs.entries()) {
      const fn = ctx.footnotes.get(id)!;
      const runs: ImportRun[] = [{ kind: "text", text: `[${index + 1}] ` }];
      let first = true;
      for (const para of childElements(fn).filter((c) => c.local === "p")) {
        if (!first) runs.push({ kind: "hard-break" });
        first = false;
        runs.push(...parseRuns(para, footnoteCtx));
      }
      blocks.push({ id: nodeId(ctx, "paragraph"), type: "paragraph", runs });
    }
    report(
      ctx,
      "docx-import/footnotes-appended",
      "info",
      "approximated",
      "Footnotes were appended as a trailing section with inline [n] markers (Confluence has no native footnotes).",
      { count: ctx.footnoteRefs.length },
    );
  }

  const firstH1 = blocks.find(
    (b): b is Extract<ImportBlock, { type: "heading" }> => b.type === "heading" && b.level === 1,
  );
  const firstH1Text = firstH1 ? runsPlainText(firstH1.runs) : "";
  const titleCandidate = firstH1 && firstH1Text
    ? firstH1.label
      ? `${firstH1.label} ${firstH1Text}`
      : firstH1Text
    : undefined;

  const comments = parseComments(
    readOptional("word/comments.xml"),
    readOptional("word/commentsExtended.xml"),
    ctx.commentAnchors,
    ctx,
  );

  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "docx",
    titleCandidate,
    blocks,
    assets: [...ctx.assets.values()],
    comments,
    commentOwners: ctx.commentOwnerBlocks,
    issues: ctx.issues,
  };
}

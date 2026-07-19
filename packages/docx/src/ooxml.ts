/**
 * OOXML fragment builders + template style detection (spec 004 Task 5).
 *
 * Pure string builders that turn the intermediate {@link ExportBlock} model into
 * WordprocessingML paragraphs/tables that are spliced in place of the
 * `$scroll.content` paragraph as raw XML. No zip / no IO here — the export
 * orchestrator (export.ts) owns the splice and the settings/styles surgery.
 *
 * Heading styles map to the template's own style ids so a native Word TOC field
 * resolves: `Scroll Heading N` → else `Heading N` → else the builtin `HeadingN`
 * id ({@link resolveHeadingStyleId}). Code blocks reference a synthesized
 * `AtlcliCode` paragraph style; callouts are self-styled single-cell tables.
 */
import { normalizeExportColor } from "@atlcli/confluence";
import { encodeXmlText } from "./ooxml-text.js";

/** Escape text for a `<w:t>` / attribute value. */
export function esc(s: string): string {
  return encodeXmlText(s);
}

// ---------------------------------------------------------------------------
// Style detection (styles.xml)
// ---------------------------------------------------------------------------

/** Map of lower-cased style *name* → styleId parsed from a styles.xml part. */
export function parseStyleNames(stylesXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const styleRe = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(stylesXml)) !== null) {
    const styleId = m[1];
    const nameMatch = m[2].match(/<w:name\b[^>]*w:val="([^"]+)"/);
    if (nameMatch) map.set(nameMatch[1].toLowerCase(), styleId);
    // Also index by styleId itself (some templates omit <w:name>).
    if (!map.has(styleId.toLowerCase())) map.set(styleId.toLowerCase(), styleId);
  }
  return map;
}

/**
 * Resolve the paragraph style id for a heading `level` against a template's
 * style-name map. Fallback chain (PLAN §2.3):
 *   `Scroll Heading N` → `Heading N` → builtin `HeadingN`.
 */
export function resolveHeadingStyleId(styleNames: Map<string, string>, level: number): string {
  const scroll = styleNames.get(`scroll heading ${level}`);
  if (scroll) return scroll;
  const heading = styleNames.get(`heading ${level}`);
  if (heading) return heading;
  return `Heading${level}`;
}

/** The synthesized code-block paragraph style id. */
export const CODE_STYLE_ID = "AtlcliCode";

/**
 * A `<w:style>` definition for the code block, injected into styles.xml when the
 * template lacks it (shaded background + monospace).
 */
export function codeStyleXml(): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${CODE_STYLE_ID}">` +
    `<w:name w:val="Atlcli Code"/>` +
    `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>` +
    `<w:spacing w:before="0" w:after="0"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr>` +
    `</w:style>`
  );
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

export interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
  subscript?: boolean;
  superscript?: boolean;
  /** Hex color without leading `#`. */
  color?: string;
}

function runPropsXml(style: RunStyle): string {
  const parts: string[] = [];
  if (style.bold) parts.push("<w:b/>");
  if (style.italic) parts.push("<w:i/>");
  if (style.strike) parts.push("<w:strike/>");
  if (style.underline) parts.push('<w:u w:val="single"/>');
  if (style.subscript) parts.push('<w:vertAlign w:val="subscript"/>');
  if (style.superscript) parts.push('<w:vertAlign w:val="superscript"/>');
  if (style.code) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (style.color) parts.push(`<w:color w:val="${normalizeColor(style.color)}"/>`);
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

/** Normalize a CSS color (`#rgb`, `#rrggbb`, `rgb(...)`, name) to a 6-hex value. */
export function normalizeColor(color: string): string {
  const c = color.trim();
  // 8-hex (#rrggbbaa, e.g. Shiki themed tokens) — drop the alpha.
  const hex8 = c.match(/^#?([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/);
  if (hex8) return hex8[1].toUpperCase();
  const hex = c.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) return hex[1].toUpperCase();
  const short = c.match(/^#?([0-9a-fA-F]{3})$/);
  if (short) {
    return short[1]
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase();
  }
  const rgb = c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  const NAMED: Record<string, string> = {
    red: "FF0000",
    green: "008000",
    blue: "0000FF",
    grey: "808080",
    gray: "808080",
    yellow: "BF8F00",
    purple: "800080",
  };
  return NAMED[c.toLowerCase()] ?? "000000";
}

/** A single run with the given (already-escaped-safe) text and style. */
export function run(text: string, style: RunStyle = {}): string {
  return `<w:r>${runPropsXml(style)}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** A line break run. */
export function lineBreakRun(): string {
  return "<w:r><w:br/></w:r>";
}

/**
 * Escape a value for use as a single quoted argument inside a Word field code.
 *
 * Word field instructions are a distinct grammar from XML: a `"` closes the
 * quoted argument and a `\` introduces a field switch (`\l`, `\o`, …). Without
 * neutralizing them, a crafted URL like `x" \l "Injected` would inject a switch
 * and a second argument. Inside a quoted field argument, `\\` is a literal
 * backslash and `\"` a literal quote, so doubling backslashes and escaping
 * quotes keeps the whole URL as one argument. The result is still XML-escaped by
 * the caller for the `<w:instrText>` body.
 */
export function escapeFieldArgument(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A hyperlink built as a Word `HYPERLINK` field (no relationship needed), with
 * the given inner runs. The URL is neutralized against field-code injection
 * (see {@link escapeFieldArgument}) then XML-escaped for the instruction body.
 */
export function hyperlinkField(url: string, innerRuns: string): string {
  const instr = esc(escapeFieldArgument(url));
  return (
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> HYPERLINK "${instr}" </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    innerRuns +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  );
}

/**
 * A `<w:bookmarkStart>` element (spec 002 anchors). `name` MUST be a legal
 * OOXML bookmark name (≤40 chars, no spaces) — the caller sanitizes via
 * `sanitizeAnchorId` before passing it here. `id` is the serializer's per-export
 * counter value; `bookmarkEnd` must reuse the same id.
 */
export function bookmarkStart(id: number, name: string): string {
  return `<w:bookmarkStart w:id="${id}" w:name="${esc(name)}"/>`;
}

/** The `<w:bookmarkEnd>` matching a {@link bookmarkStart} with the same `id`. */
export function bookmarkEnd(id: number): string {
  return `<w:bookmarkEnd w:id="${id}"/>`;
}

/**
 * A real in-document jump: `<w:hyperlink w:anchor="…" w:history="1">…</w:hyperlink>`
 * carrying the given inner runs. `anchor` names a bookmark in this document
 * (spec 002 anchor rewrite). Previously internal links were only styled blue —
 * they now navigate.
 */
export function internalHyperlink(anchor: string, innerRuns: string): string {
  return `<w:hyperlink w:anchor="${esc(anchor)}" w:history="1">${innerRuns}</w:hyperlink>`;
}

/** A hard page break paragraph (`pageBreak` block → `<w:br w:type="page"/>`). */
export function pageBreakParagraph(): string {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A paragraph wrapping the given run XML, optionally with a pStyle. */
export function paragraph(runsXml: string, opts: { styleId?: string; extraPPr?: string } = {}): string {
  const ppr =
    opts.styleId || opts.extraPPr
      ? `<w:pPr>${opts.styleId ? `<w:pStyle w:val="${opts.styleId}"/>` : ""}${opts.extraPPr ?? ""}</w:pPr>`
      : "";
  return `<w:p>${ppr}${runsXml}</w:p>`;
}

/** An empty paragraph with a bottom border — the `divider` block. */
export function dividerParagraph(): string {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>`;
}

/**
 * A callout as a single-cell table: colored fill + a thick colored left accent
 * border; an optional bold title paragraph then the body paragraphs.
 */
export function calloutTable(
  kind: string,
  titleRunsXml: string | null,
  bodyParagraphs: string
): string {
  const palette: Record<string, { fill: string; accent: string }> = {
    info: { fill: "DEEBFF", accent: "2684FF" },
    note: { fill: "EAE6FF", accent: "6554C0" },
    warning: { fill: "FFFAE6", accent: "FFAB00" },
    tip: { fill: "E3FCEF", accent: "36B37E" },
    panel: { fill: "F4F5F7", accent: "97A0AF" },
  };
  const c = palette[kind] ?? palette.panel;
  const title = titleRunsXml ? `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>${titleRunsXml}</w:p>` : "";
  return (
    `<w:tbl>` +
    `<w:tblPr><w:tblW w:w="9000" w:type="dxa"/>` +
    `<w:tblBorders><w:left w:val="single" w:sz="24" w:color="${c.accent}"/></w:tblBorders>` +
    `<w:tblCellMar><w:left w:w="144" w:type="dxa"/><w:right w:w="144" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>` +
    `<w:tr><w:tc>` +
    `<w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${c.fill}"/></w:tcPr>` +
    title +
    (bodyParagraphs || "<w:p/>") +
    `</w:tc></w:tr>` +
    `</w:tbl>`
  );
}

/** Build a data table from row/cell OOXML with a light grid + header shading. */
export function dataTable(gridCols: number, rowsXml: string): string {
  const grid = Array.from({ length: Math.max(1, gridCols) }, () => `<w:gridCol w:w="${Math.floor(9000 / Math.max(1, gridCols))}"/>`).join("");
  return (
    `<w:tbl>` +
    `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/>` +
    `<w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:color="AAAAAA"/><w:left w:val="single" w:sz="4" w:color="AAAAAA"/>` +
    `<w:bottom w:val="single" w:sz="4" w:color="AAAAAA"/><w:right w:val="single" w:sz="4" w:color="AAAAAA"/>` +
    `<w:insideH w:val="single" w:sz="4" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:color="AAAAAA"/>` +
    `</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    rowsXml +
    `</w:tbl>`
  );
}

/** A table cell with colspan (gridSpan), rowspan (vMerge), header shading. */
export function tableCell(
  paragraphsXml: string,
  opts: { colspan?: number; vMerge?: "restart" | "continue"; header?: boolean; backgroundColor?: string } = {}
): string {
  const props: string[] = [];
  if (opts.colspan && opts.colspan > 1) props.push(`<w:gridSpan w:val="${opts.colspan}"/>`);
  if (opts.vMerge) props.push(`<w:vMerge w:val="${opts.vMerge}"/>`);
  const fill = normalizeExportColor(opts.backgroundColor)?.slice(1) ?? (opts.header ? "F4F5F7" : undefined);
  if (fill) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
  const body = paragraphsXml || "<w:p/>";
  return `<w:tc><w:tcPr>${props.join("")}</w:tcPr>${body}</w:tc>`;
}

/** Status badge as a shaded, colored inline run inside its own paragraph. */
export function statusBadgeRun(text: string, color: string): string {
  const fillByColor: Record<string, string> = {
    grey: "DFE1E6",
    gray: "DFE1E6",
    green: "E3FCEF",
    red: "FFEBE6",
    yellow: "FFFAE6",
    blue: "DEEBFF",
    purple: "EAE6FF",
  };
  const fill = fillByColor[color.toLowerCase()] ?? "DFE1E6";
  return (
    `<w:r><w:rPr><w:b/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:rPr>` +
    `<w:t xml:space="preserve"> ${esc(text)} </w:t></w:r>`
  );
}

/** One colored code line: a paragraph in the code style with per-token runs. */
export function codeLineParagraph(tokens: { text: string; color?: string }[]): string {
  const runs = tokens
    .map((t) => run(t.text, { code: true, color: t.color }))
    .join("");
  return paragraph(runs || run("", { code: true }), { styleId: CODE_STYLE_ID });
}

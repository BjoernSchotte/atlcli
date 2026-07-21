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
import type { CaptionKind, ExportNote } from "@atlcli/confluence";
import { isSafeLinkScheme, normalizeExportColor } from "@atlcli/confluence";
import { encodeXmlText } from "./ooxml-text.js";

/** Resolved caption locale (spec 003 C3). Only the two shipped label sets. */
export type CaptionLang = "en" | "de";

/**
 * Resolve a host-supplied locale (a BCP-47 language tag, e.g. `de`, `de-DE`,
 * `en_US`) to a shipped {@link CaptionLang}. Case-insensitive on the primary
 * subtag; anything that is not English or German falls back to `"en"` with a
 * warning note (spec 003 C3 locale precedence: explicit option > host locale >
 * `"en"`). Absent/empty input → `"en"`, no note.
 */
export function resolveCaptionLang(raw: string | undefined): { lang: CaptionLang; note?: ExportNote } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { lang: "en" };
  const primary = trimmed.toLowerCase().split(/[-_]/, 1)[0];
  if (primary === "de") return { lang: "de" };
  if (primary === "en") return { lang: "en" };
  return {
    lang: "en",
    note: {
      level: "warning",
      code: "caption-lang-fallback",
      message: `Caption language "${trimmed}" has no label set (supported: en, de); captions use English labels.`,
    },
  };
}

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

/** The builtin fallback list paragraph style id (spec 006 G2). */
export const LIST_PARAGRAPH_STYLE_ID = "ListParagraph";

/**
 * Resolve the paragraph style id for a list level against a template's
 * style-name map (spec 006 G2). The real Scroll naming convention is
 * asymmetric (`spec/scroll-word-exporter-features.md` §3): level 1 (`ilvl 0`)
 * is SUFFIXLESS — `Scroll List Bullet` / `Scroll List Number` — and only
 * levels 2–8 (`ilvl 1–7`) carry the numeric suffix `2`…`8`. Fallback chain:
 *   `Scroll List {Bullet|Number}[ N]` → builtin `List {Bullet|Number}[ N]`
 *   → `ListParagraph`.
 * Names are matched case-insensitively against `parseStyleNames` output; the
 * template's own visual control (font/spacing) stays with the style, while the
 * indent + number format live in the synthesized `w:lvl` definitions.
 */
export function resolveListStyleId(
  styleNames: Map<string, string>,
  ordered: boolean,
  ilvl: number
): string {
  const kind = ordered ? "number" : "bullet";
  // ilvl 0 → no suffix; ilvl 1..7 → suffix 2..8. Deeper levels clamp to 8.
  const level = Math.min(Math.max(ilvl, 0), 7);
  const suffix = level === 0 ? "" : ` ${level + 1}`;
  const scroll = styleNames.get(`scroll list ${kind}${suffix}`);
  if (scroll) return scroll;
  const builtin = styleNames.get(`list ${kind}${suffix}`);
  if (builtin) return builtin;
  return styleNames.get("listparagraph") ?? styleNames.get("list paragraph") ?? LIST_PARAGRAPH_STYLE_ID;
}

/**
 * A `<w:style>` for the fallback list paragraph, injected into styles.xml when
 * the template lacks a `ListParagraph` style AND no template list style matched
 * (spec 006 G2). Visual control normally lives in the template; this exists so
 * a bare template still produces a defined, indent-only list style.
 */
export function listParagraphStyleXml(): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${LIST_PARAGRAPH_STYLE_ID}">` +
    `<w:name w:val="List Paragraph"/>` +
    `<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr>` +
    `</w:style>`
  );
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
 * Defense-in-depth scheme allowlist for {@link hyperlinkField}.
 *
 * A THIN WRAPPER over the canonical policy in `@atlcli/confluence`'s
 * `link-safety` module (spec 011) — it used to be a hand-copied duplicate of
 * `isSafeLinkScheme`, which meant two policies that could silently drift apart.
 * The name is kept because callers and the published API surface depend on it.
 *
 * The converters upstream already degrade unsafe targets to plain text and emit
 * an `unsafe-link-skipped` note; this re-check means a future caller (or a
 * bypassed converter) can still never turn `javascript:`/`file:` into a live
 * Word HYPERLINK field.
 */
export function isSafeHyperlinkUrl(url: string): boolean {
  return isSafeLinkScheme(url);
}

/**
 * A hyperlink built as a Word `HYPERLINK` field (no relationship needed), with
 * the given inner runs. The URL is neutralized against field-code injection
 * (see {@link escapeFieldArgument}) then XML-escaped for the instruction body.
 * URLs failing {@link isSafeHyperlinkUrl} degrade to the plain inner runs —
 * the link text survives, the live field target does not.
 */
export function hyperlinkField(url: string, innerRuns: string): string {
  if (!isSafeHyperlinkUrl(url)) return innerRuns;
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
// Captions (spec 003 C3)
// ---------------------------------------------------------------------------

/** The synthesized caption paragraph style id (matches Word's builtin name). */
export const CAPTION_STYLE_ID = "Caption";

/**
 * Resolve the caption paragraph style id against a template's style-name map,
 * falling back to the builtin `Caption` id (synthesized when the template lacks
 * it, see {@link captionStyleXml}). Mirrors {@link resolveHeadingStyleId}.
 */
export function resolveCaptionStyleId(styleNames: Map<string, string>): string {
  return styleNames.get("caption") ?? CAPTION_STYLE_ID;
}

/** A `<w:style>` for the caption paragraph, injected when the template lacks it. */
export function captionStyleXml(): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${CAPTION_STYLE_ID}">` +
    `<w:name w:val="Caption"/>` +
    `<w:pPr><w:spacing w:before="60" w:after="120"/></w:pPr>` +
    `<w:rPr><w:i/><w:iCs/><w:color w:val="44546A"/><w:sz w:val="18"/></w:rPr>` +
    `</w:style>`
  );
}

/** The stable SEQ sequence identifier per caption kind (language-independent). */
export function captionSeqName(kind: CaptionKind): string {
  switch (kind) {
    case "figure":
      return "Figure";
    case "table":
      return "Table";
    case "code":
    case "equation":
      return "Listing";
  }
}

/** The localized visible caption prefix (`Figure`/`Abbildung`, …). */
export function captionSeqLabel(kind: CaptionKind, lang: CaptionLang): string {
  const labels: Record<CaptionLang, Record<CaptionKind, string>> = {
    en: { figure: "Figure", table: "Table", code: "Listing", equation: "Equation" },
    de: { figure: "Abbildung", table: "Tabelle", code: "Listing", equation: "Gleichung" },
  };
  return labels[lang][kind];
}

/**
 * A caption paragraph: `<pStyle Caption>` + `"<Label> "` + a live SEQ field
 * (`SEQ <name> \* ARABIC`, so Word owns the numbering natively and a manual F9
 * still produces the right answer) + `": "` + the caption's inline runs.
 *
 * `ordinal` is the field's CACHED RESULT — the number between `fldChar
 * separate` and `fldChar end`. It used to be hard-coded to `1`, which made a
 * document with three tables read "Table 1" three times until someone pressed
 * F9, and made every export with a single caption ask its reader to refresh
 * (see {@link import("./scan.js").REFRESH_SENSITIVE_FIELDS}).
 *
 * The cached result is not a cosmetic detail. It is what Word shows before any
 * refresh, and it is all a consumer that reads `<w:t>` runs without evaluating
 * fields ever sees — pandoc, python-docx, most search indexers. MEASURED on a
 * real three-caption export: `pandoc -f docx -t plain` printed "Tabelle 1"
 * three times from the old output and "Tabelle 1/2/3" from this one.
 * LibreOffice is NOT such a consumer, and an earlier version of this comment
 * wrongly named it: LibreOffice recomputes `SEQ` on import, and its converted
 * PDF read correctly even from the old, all-`1` file.
 *
 * The FIELD stays: replacing it with a plain number would break cross-references
 * (`REF`), Word's own caption tooling and a table of figures. Only the cached
 * result changes. The caller ({@link import("./serialize.js").serializeBlocks})
 * owns one counter per sequence name, incremented in document order.
 */
export function captionParagraph(
  styleId: string,
  kind: CaptionKind,
  lang: CaptionLang,
  contentRunsXml: string,
  ordinal: number
): string {
  const label = captionSeqLabel(kind, lang);
  const seqName = captionSeqName(kind);
  // A non-positive or non-finite ordinal would put `NaN`/`0`/`-1` in front of a
  // reader as if it were a caption number. Fall back to Word's own first value
  // rather than emit nonsense; the serializer never produces one.
  const cached = Number.isFinite(ordinal) && ordinal >= 1 ? String(Math.trunc(ordinal)) : "1";
  const seqField =
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> SEQ ${esc(seqName)} \\* ARABIC </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>${cached}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  return (
    `<w:p><w:pPr><w:pStyle w:val="${esc(styleId)}"/></w:pPr>` +
    run(`${label} `) +
    seqField +
    run(": ") +
    contentRunsXml +
    `</w:p>`
  );
}

// ---------------------------------------------------------------------------
// Orientation regions — section sandwich (spec 003 C6)
// ---------------------------------------------------------------------------

/** Wrap a `<w:sectPr>` in an (empty) paragraph so it closes the preceding section. */
export function sectPrParagraph(sectPr: string): string {
  return `<w:p><w:pPr>${sectPr}</w:pPr></w:p>`;
}

/** A synthesized standard A4 portrait `<w:sectPr>` (no-template fallback only). */
export function synthesizeA4SectPr(): string {
  return (
    `<w:sectPr>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr>`
  );
}

/**
 * Clone a portrait `<w:sectPr>` into its landscape counterpart: the `<w:pgSz>`
 * `w:w`/`w:h` VALUES are read from the source and swapped (never a hard-coded
 * A4 constant — the repo's own template is Letter), `w:orient="landscape"` is
 * set, and a `nextPage` section type is ensured. Margins, header/footer
 * references and every other property are preserved.
 */
export function toLandscapeSectPr(baseSectPr: string): string {
  return orientSectPr(baseSectPr, "landscape");
}

/**
 * Clone a `<w:sectPr>` into a portrait counterpart — the mirror of
 * {@link toLandscapeSectPr}. A `scroll-portrait` region flips back to portrait
 * even when the base section is landscape, so it is not merely a no-op.
 */
export function toPortraitSectPr(baseSectPr: string): string {
  return orientSectPr(baseSectPr, "portrait");
}

/**
 * Re-orient a `<w:sectPr>` to the target orientation: read the `<w:pgSz>`
 * `w:w`/`w:h` values, order them so width < height for portrait and width >
 * height for landscape, set/clear `w:orient`, and ensure a `nextPage` break.
 */
function orientSectPr(baseSectPr: string, target: "portrait" | "landscape"): string {
  let out = baseSectPr.replace(/<w:pgSz\b[^>]*\/>/, (m) => {
    const a = Number(m.match(/w:w="(\d+)"/)?.[1]);
    const b = Number(m.match(/w:h="(\d+)"/)?.[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return m;
    const short = Math.min(a, b);
    const long = Math.max(a, b);
    return target === "landscape"
      ? `<w:pgSz w:w="${long}" w:h="${short}" w:orient="landscape"/>`
      : `<w:pgSz w:w="${short}" w:h="${long}"/>`;
  });
  // Ensure a nextPage section break, placed right before <w:pgSz> so the child
  // order stays schema-legal (headerReference/footerReference precede <w:type>).
  if (/<w:type\b/.test(out)) {
    out = out.replace(/<w:type\b[^>]*\/>/, '<w:type w:val="nextPage"/>');
  } else {
    out = out.replace(/(<w:pgSz\b)/, '<w:type w:val="nextPage"/>$1');
  }
  return out;
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

/**
 * Table style source (spec 006 G3b / B9). `"confluence"` (default) keeps the
 * built-in `TableGrid` + hard-coded borders + per-cell shading — today's
 * behavior, byte-identical. `"template"` emits only the named style + a
 * `w:tblLook` (first-row banding) and omits inline borders/shading so a
 * template's house table style controls appearance.
 */
export interface TableStyleSource {
  source: "template" | "confluence";
  /** The resolved style id, used only in `"template"` mode. */
  styleId?: string;
}

export interface DataTableOptions {
  /** Per-column `w:gridCol` widths in dxa (spec 006 G3). Absent → even split. */
  widthsDxa?: number[];
  /** Table style source (spec 006 G3b). Defaults to `"confluence"`. */
  tableStyle?: TableStyleSource;
}

/**
 * Build a data table from row/cell OOXML. With `widthsDxa` (spec 006 G3) the
 * `w:tblGrid` carries real per-column widths and a `w:tblLayout w:type="fixed"`
 * so Word does not re-autofit; without it the grid is an even 9000-dxa split
 * (pre-006 behavior). The table style is either the built-in confluence grid or
 * a template style (spec 006 G3b).
 */
export function dataTable(gridCols: number, rowsXml: string, opts: DataTableOptions = {}): string {
  const cols = Math.max(1, gridCols);
  const widths = opts.widthsDxa;
  const even = Math.floor(9000 / cols);
  const grid = Array.from({ length: cols }, (_, i) => `<w:gridCol w:w="${widths?.[i] ?? even}"/>`).join("");
  const fixedLayout = widths ? `<w:tblLayout w:type="fixed"/>` : "";
  const style = opts.tableStyle ?? { source: "confluence" as const };
  let tblPrInner: string;
  if (style.source === "template" && style.styleId) {
    // Template style controls borders/shading; emit only the style ref + look.
    tblPrInner =
      `<w:tblStyle w:val="${esc(style.styleId)}"/>` +
      `<w:tblW w:w="9000" w:type="dxa"/>` +
      fixedLayout +
      `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>`;
  } else {
    // Schema order matters (CT_TblPrBase, ECMA-376 §17.4.60): tblBorders (seq 11)
    // MUST precede tblLayout (seq 13), so fixedLayout goes AFTER tblBorders here.
    tblPrInner =
      `<w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/>` +
      `<w:tblBorders>` +
      `<w:top w:val="single" w:sz="4" w:color="AAAAAA"/><w:left w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `<w:bottom w:val="single" w:sz="4" w:color="AAAAAA"/><w:right w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `<w:insideH w:val="single" w:sz="4" w:color="AAAAAA"/><w:insideV w:val="single" w:sz="4" w:color="AAAAAA"/>` +
      `</w:tblBorders>` +
      fixedLayout;
  }
  return (
    `<w:tbl>` +
    `<w:tblPr>${tblPrInner}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    rowsXml +
    `</w:tbl>`
  );
}

/**
 * A table cell with an optional fixed width (spec 006 G3 — `w:tcW`, emitted as
 * the FIRST `tcPr` child per schema order), colspan (gridSpan), rowspan
 * (vMerge), and header/background shading. Passing no `backgroundColor`/`header`
 * (template table-style mode) omits `w:shd` so the template style's fills win.
 */
export function tableCell(
  paragraphsXml: string,
  opts: {
    colspan?: number;
    vMerge?: "restart" | "continue";
    header?: boolean;
    backgroundColor?: string;
    widthDxa?: number;
  } = {}
): string {
  const props: string[] = [];
  // Schema order: tcW must precede gridSpan.
  if (opts.widthDxa !== undefined) props.push(`<w:tcW w:w="${opts.widthDxa}" w:type="dxa"/>`);
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

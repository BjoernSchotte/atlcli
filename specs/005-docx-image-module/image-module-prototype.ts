/**
 * PRESERVED SPIKE ARTIFACT — reference prototype for the deferred DOCX image-module task.
 *
 * This is the OOXML *image module* prototype extracted from the (now-removed) spec-004
 * engine spike: a self-built image insertion (media part + relationship + content-type
 * plumbing + drawing/EMU) that works on a raw PizZip instance — exactly the effort the
 * docxtemplater free tier needs for image embedding. It is NOT compiled or imported by any
 * product code; it is kept here as the starting point the follow-up image-module task builds
 * on. See `image-module-research.md` (§5 diffs this prototype against the old open module and
 * lists the gaps the real module must close: unique element ids, generic content-types,
 * effectExtent/aspect-locks, svgBlip). Image embedding is deferred per PLAN.md Decision F3.
 *
 * (Also contains the spike's hand-written OOXML fragment builders for the content zoo — those
 * are superseded by the product serializer in apps/extension/utils/docx and are here only as
 * historical context.)
 */
import type PizZip from "pizzip";

const EMU_PER_PX = 9525; // 96 dpi

// ---------------------------------------------------------------------------
// Inline content fragments (return <w:p>… paragraph-level OOXML strings)
// ---------------------------------------------------------------------------

export function heading(level: number, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

export function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/** Paragraph with an external hyperlink (uses HYPERLINK field, no rel needed). */
export function paragraphWithLink(pre: string, linkText: string, url: string, post: string): string {
  return (
    `<w:p>` +
    `<w:r><w:t xml:space="preserve">${esc(pre)}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> HYPERLINK "${esc(url)}" </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">${esc(linkText)}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${esc(post)}</w:t></w:r>` +
    `</w:p>`
  );
}

/** Nested list (numbering omitted for spike; indent conveys nesting). */
export function nestedList(items: { text: string; level: number; ordered: boolean }[]): string {
  return items
    .map((it) => {
      const bullet = it.ordered ? `${it.level + 1}. ` : "• ";
      const indent = 360 + it.level * 360;
      return `<w:p><w:pPr><w:ind w:left="${indent}"/></w:pPr><w:r><w:t xml:space="preserve">${bullet}${esc(it.text)}</w:t></w:r></w:p>`;
    })
    .join("");
}

/** A merged-cell table: row 1 is a single cell spanning 3 columns (gridSpan). */
export function mergedTable(): string {
  const cell = (text: string, span?: number, bold?: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${span ? 6000 : 2000}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ""}${bold ? '<w:shd w:val="clear" w:fill="D9E2F3"/>' : ""}</w:tcPr><w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
  return (
    `<w:tbl>` +
    `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:color="808080"/>` +
    `</w:tblBorders></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
    `<w:tr>${cell("Merged header spanning 3 columns", 3, true)}</w:tr>` +
    `<w:tr>${cell("A1")}${cell("B1")}${cell("C1")}</w:tr>` +
    `<w:tr>${cell("A2")}${cell("B2")}${cell("C2")}</w:tr>` +
    `</w:tbl>`
  );
}

/** Callout box: single-cell table, coloured fill + coloured left accent border. */
export function calloutBox(kind: string, title: string, body: string): string {
  const palette: Record<string, { fill: string; accent: string }> = {
    info: { fill: "DEEBFF", accent: "2684FF" },
    note: { fill: "EAE6FF", accent: "6554C0" },
    warning: { fill: "FFFAE6", accent: "FFAB00" },
    tip: { fill: "E3FCEF", accent: "36B37E" },
  };
  const c = palette[kind] ?? palette.info;
  return (
    `<w:tbl>` +
    `<w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>` +
    `<w:left w:val="single" w:sz="24" w:color="${c.accent}"/>` +
    `</w:tblBorders></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>` +
    `<w:tr><w:tc>` +
    `<w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:shd w:val="clear" w:fill="${c.fill}"/></w:tcPr>` +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(title)}</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">${esc(body)}</w:t></w:r></w:p>` +
    `</w:tc></w:tr>` +
    `</w:tbl>`
  );
}

/** Multi-coloured code paragraph: one <w:r> per token, mono font, shaded. */
export function coloredCodeBlock(tokens: { text: string; color: string }[]): string {
  const runs = tokens
    .map(
      (t) =>
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="${t.color}"/></w:rPr><w:t xml:space="preserve">${esc(t.text)}</w:t></w:r>`,
    )
    .join("");
  return `<w:p><w:pPr><w:shd w:val="clear" w:fill="F4F5F7"/></w:pPr>${runs}</w:p>`;
}

/** Status macro equivalent: a shaded, coloured inline "badge" run. */
export function statusBadge(text: string, fill: string, color: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">Status: </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="${color}"/><w:shd w:val="clear" w:fill="${fill}"/></w:rPr><w:t xml:space="preserve"> ${esc(text)} </w:t></w:r></w:p>`;
}

/** Inline image drawing referencing a relationship id, sized in px. */
export function imageDrawing(relId: string, wPx: number, hPx: number, name: string, docPrId: number): string {
  const cx = wPx * EMU_PER_PX;
  const cy = hPx * EMU_PER_PX;
  return (
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${docPrId}" name="${esc(name)}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

// ---------------------------------------------------------------------------
// Self-built image module (media part + rel + content-type) on a PizZip zip.
// This is the concrete effort a docxtemplater-free image path would need.
// ---------------------------------------------------------------------------

let mediaCounter = 0;

/** Ensure [Content_Types].xml declares the png default. */
export function ensurePngContentType(zip: PizZip): void {
  const ctPath = "[Content_Types].xml";
  let ct = zip.file(ctPath)!.asText();
  if (!/Extension="png"/.test(ct)) {
    ct = ct.replace(/<\/Types>/, `<Default Extension="png" ContentType="image/png"/></Types>`);
    zip.file(ctPath, ct);
  }
}

/** Add a png as a media part + document relationship, returning the rId. */
export function addImageRel(zip: PizZip, png: Buffer): string {
  ensurePngContentType(zip);
  mediaCounter += 1;
  const fname = `spikeImage${mediaCounter}.png`;
  zip.file(`word/media/${fname}`, png);

  const relsPath = "word/_rels/document.xml.rels";
  let rels = zip.file(relsPath)?.asText();
  if (!rels) {
    rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  }
  // Find a free rId.
  const existing = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rid = `rId${(existing.length ? Math.max(...existing) : 0) + 1}`;
  rels = rels.replace(
    /<\/Relationships>/,
    `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fname}"/></Relationships>`,
  );
  zip.file(relsPath, rels);
  return rid;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

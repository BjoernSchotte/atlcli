/**
 * Deterministic in-memory DOCX builder for tests. Produces a minimal but
 * OPC-valid package so tests exercise the real `unzipDocx` boundary instead
 * of mocking it.
 */
import PizZip from "pizzip";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

/** 1×1 red PNG, the smallest embeddable raster fixture. */
export const TINY_PNG: Uint8Array = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export const DEFAULT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Ueberschrift3">
    <w:name w:val="Überschrift 3"/>
    <w:pPr><w:outlineLvl w:val="2"/></w:pPr>
  </w:style>
</w:styles>`;

export const DEFAULT_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export interface FixtureOptions {
  /** Inner XML of <w:body>. */
  body: string;
  styles?: string;
  numbering?: string;
  /** Extra document-level relationships (e.g. hyperlinks, images). */
  documentRels?: string;
  /** Extra binary parts, e.g. `{ "word/media/image1.png": TINY_PNG }`. */
  parts?: Record<string, Uint8Array>;
}

export function buildDocxFixture(options: FixtureOptions): Uint8Array {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${options.body}</w:body>
</w:document>`,
  );
  zip.file("word/styles.xml", options.styles ?? DEFAULT_STYLES);
  zip.file("word/numbering.xml", options.numbering ?? DEFAULT_NUMBERING);
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.documentRels ?? ""}</Relationships>`,
  );
  for (const [name, bytes] of Object.entries(options.parts ?? {})) {
    zip.file(name, bytes);
  }
  const out = zip.generate({ type: "uint8array", compression: "DEFLATE" });
  return out;
}

export function hyperlinkRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`;
}

export function imageRel(id: string, target: string): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
}

/** Minimal inline DrawingML picture run referencing an image relationship. */
export function drawing(
  relId: string,
  opts: { cx?: number; cy?: number; descr?: string } = {},
): string {
  const cx = opts.cx ?? 952500; // 100 px
  const cy = opts.cy ?? 476250; // 50 px
  return (
    `<w:r><w:drawing>` +
    `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="1" name="Picture 1"${opts.descr ? ` descr="${opts.descr}"` : ""}/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

export function p(inner: string, opts: { style?: string; numId?: string; ilvl?: number } = {}): string {
  const pPrParts: string[] = [];
  if (opts.style) pPrParts.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.numId !== undefined) {
    pPrParts.push(
      `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`,
    );
  }
  const pPr = pPrParts.length > 0 ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  return `<w:p>${pPr}${inner}</w:p>`;
}

export function r(text: string, opts: { bold?: boolean; italic?: boolean } = {}): string {
  const props: string[] = [];
  if (opts.bold) props.push("<w:b/>");
  if (opts.italic) props.push("<w:i/>");
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

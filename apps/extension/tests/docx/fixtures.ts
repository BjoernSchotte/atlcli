/**
 * In-test `.docx` fixture builders (spec 004 Tasks 3–5).
 *
 * Real, minimal OOXML packages assembled with PizZip — no binary fixture files
 * checked in. `buildDocx` produces a valid enough Word package (content types,
 * rels, document, styles) that both the scan and docxtemplater accept; helpers
 * layer in run-split placeholders, headers/footers and named styles for the
 * various test scenarios.
 */
import PizZip from "pizzip";

const CONTENT_TYPES = (parts: { header: boolean; footer: boolean; settings: boolean }) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  (parts.settings
    ? `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`
    : "") +
  (parts.header
    ? `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`
    : "") +
  (parts.footer
    ? `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`
    : "") +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

function docRels(header: boolean, footer: boolean, settings: boolean): string {
  let rels = "";
  let n = 1;
  if (header) rels += `<Relationship Id="rIdH${n++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`;
  if (footer) rels += `<Relationship Id="rIdF${n++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`;
  if (settings) rels += `<Relationship Id="rIdS${n++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  );
}

/** Wrap body inner XML into a full `word/document.xml`. */
export function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyInner}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
  );
}

/** A simple paragraph with the given text in one run. */
export function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * A paragraph whose text is split across multiple runs (simulating Word's
 * rsid-driven run splitting). `segments` are concatenated across `<w:r><w:t>`.
 */
export function runSplitPara(segments: string[]): string {
  const runs = segments
    .map((s) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr><w:t xml:space="preserve">${s}</w:t></w:r>`)
    .join("");
  return `<w:p>${runs}</w:p>`;
}

/** styles.xml with optional extra <w:style> definitions. */
export function stylesXml(extraStyles = ""): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    extraStyles +
    `</w:styles>`
  );
}

/** A named heading style definition (name → styleId). */
export function headingStyle(styleId: string, name: string): string {
  return `<w:style w:type="paragraph" w:styleId="${styleId}"><w:name w:val="${name}"/></w:style>`;
}

export interface BuildDocxOptions {
  body: string;
  styles?: string;
  header?: string;
  footer?: string;
  settings?: string | null;
}

/** Assemble a valid minimal `.docx` and return its bytes. */
export function buildDocx(opts: BuildDocxOptions): Uint8Array {
  const zip = new PizZip();
  const hasHeader = opts.header != null;
  const hasFooter = opts.footer != null;
  const hasSettings = opts.settings !== null; // default: include settings

  zip.file("[Content_Types].xml", CONTENT_TYPES({ header: hasHeader, footer: hasFooter, settings: hasSettings }));
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", documentXml(opts.body));
  zip.file("word/_rels/document.xml.rels", docRels(hasHeader, hasFooter, hasSettings));
  zip.file("word/styles.xml", opts.styles ?? stylesXml());
  if (hasSettings) {
    zip.file(
      "word/settings.xml",
      opts.settings ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>`
    );
  }
  if (hasHeader) {
    zip.file(
      "word/header1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${opts.header}</w:hdr>`
    );
  }
  if (hasFooter) {
    zip.file(
      "word/footer1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${opts.footer}</w:ftr>`
    );
  }
  return zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
}

/** Unzip bytes and read a part's text (for output assertions). */
export function readPart(bytes: Uint8Array, part: string): string {
  const zip = new PizZip(bytes);
  return zip.file(part)?.asText() ?? "";
}

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

/**
 * The namespace declarations Word carries on document/header/footer roots. The
 * text-box fixtures use `mc:`/`wps:`/`v:`/`w14:`, so declaring them keeps the
 * packages genuinely well-formed (and keeps docxtemplater's xmldom parse clean).
 */
export const OOXML_NS =
  `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
  `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
  `xmlns:v="urn:schemas-microsoft-com:vml" ` +
  `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"`;

/** Wrap body inner XML into a full `word/document.xml`. */
export function documentXml(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${OOXML_NS}>` +
    `<w:body>${bodyInner}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
  );
}

/**
 * A generic well-formedness (tag-balance) check — no external XML parser needed.
 * Catches exactly the desync class of bug this fix targets: a mis-segmented
 * paragraph produces unbalanced output. Ignores the XML declaration, comments,
 * and self-closing tags; namespace prefixes are treated as opaque names.
 */
export function assertBalancedXml(xml: string): void {
  const stripped = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)(?:"[^"]*"|'[^']*'|[^>"'])*?(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(stripped)) !== null) {
    const closing = m[1] === "/";
    const name = m[2];
    const selfClose = m[3] === "/";
    if (selfClose) continue;
    if (closing) {
      const top = stack.pop();
      if (top !== name) throw new Error(`unbalanced XML: </${name}> closes <${top ?? "nothing"}>`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`unclosed XML tags: ${stack.join(", ")}`);
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

/**
 * A cover-page paragraph whose title lives INSIDE a text box, provided twice via
 * `mc:AlternateContent` — a modern DrawingML `wps:txbx` (`mc:Choice`) and a VML
 * `v:textbox` fallback (`mc:Fallback`). Each `<w:txbxContent>` holds its own
 * NESTED `<w:p>`, reproducing the real customer (Mayflower letterhead) shape (a).
 * The whole thing is a single run in the outer paragraph.
 */
export function textBoxTitlePara(text: string): string {
  const innerPara = (rpr: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading1TOC"/></w:pPr>` +
    `<w:r${rpr}><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  return (
    `<w:p w14:paraId="6C4FCF91"><w:r><mc:AlternateContent>` +
    `<mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>` +
    innerPara(' w:rsidRPr="00372A13"') +
    `</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>` +
    innerPara("") +
    `</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>` +
    `</mc:AlternateContent></w:r></w:p>`
  );
}

/**
 * A footer paragraph where a picture run (a text box inside `mc:AlternateContent`
 * / `w:pict`) is followed in the SAME paragraph by a CLEAN `<w:t>` run holding
 * the placeholder — real customer shape (b). The drawing run is a non-mergeable
 * boundary; the trailing clean run must still be resolved.
 */
export function drawingAdjacentPara(text: string): string {
  return (
    `<w:p>` +
    `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>` +
    `<w:p><w:r><w:t xml:space="preserve">logo</w:t></w:r></w:p>` +
    `</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>` +
    `<w:p><w:r><w:t xml:space="preserve">logo</w:t></w:r></w:p>` +
    `</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>` +
    `<w:r w:rsidR="003D31B6" w:rsidRPr="00327E6D"><w:t xml:space="preserve">${text}</w:t></w:r>` +
    `</w:p>`
  );
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
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${OOXML_NS}>${opts.header}</w:hdr>`
    );
  }
  if (hasFooter) {
    zip.file(
      "word/footer1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${OOXML_NS}>${opts.footer}</w:ftr>`
    );
  }
  return zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
}

/** Unzip bytes and read a part's text (for output assertions). */
export function readPart(bytes: Uint8Array, part: string): string {
  const zip = new PizZip(bytes);
  return zip.file(part)?.asText() ?? "";
}

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

interface DocumentRelationships {
  xml: string;
  headerId?: string;
  footerId?: string;
}

function docRels(header: boolean, footer: boolean, settings: boolean): DocumentRelationships {
  // `styles.xml` is a required dependency of every package this builder emits.
  // Keep the id non-numeric so feature-specific relationship allocators can
  // continue issuing compact `rId1`, `rId2`, ... ids without collisions.
  let rels =
    `<Relationship Id="rIdStyles" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` +
    `Target="styles.xml"/>`;
  let n = 1;
  const headerId = header ? `rIdH${n++}` : undefined;
  const footerId = footer ? `rIdF${n++}` : undefined;
  if (headerId) rels += `<Relationship Id="${headerId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`;
  if (footerId) rels += `<Relationship Id="${footerId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`;
  if (settings) rels += `<Relationship Id="rIdS${n++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>`;
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    headerId,
    footerId,
  };
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
  return documentXmlWithStoryReferences(bodyInner, {});
}

function documentXmlWithStoryReferences(
  bodyInner: string,
  refs: Pick<DocumentRelationships, "headerId" | "footerId">
): string {
  const hasStoryReference = refs.headerId != null || refs.footerId != null;
  const relationshipNamespace = hasStoryReference
    ? ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
    : "";
  const sectionReferences =
    (refs.headerId ? `<w:headerReference w:type="default" r:id="${refs.headerId}"/>` : "") +
    (refs.footerId ? `<w:footerReference w:type="default" r:id="${refs.footerId}"/>` : "");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${OOXML_NS}${relationshipNamespace}>` +
    `<w:body>${bodyInner}<w:sectPr>${sectionReferences}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
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

/** Split a string roughly in half (to simulate Word's rsid run splitting). */
function splitHalf(s: string): [string, string] {
  const i = Math.ceil(s.length / 2);
  return [s.slice(0, i), s.slice(i)];
}

// ---------------------------------------------------------------------------
// Shape ① — SmartArt / chart DrawingML `<a:t>` text
// ---------------------------------------------------------------------------

/**
 * A DrawingML `<a:p>` whose text is split across two `<a:t>` runs (rsid-style
 * split, to exercise `<a:t>` run-normalization). The `a:` namespace makes this
 * structurally distinct from the `<w:p>`/`<w:t>` tree — the shape used by
 * SmartArt (`<dgm:t>`) and chart rich text (`<c:rich>`).
 */
export function smartArtTitlePara(text: string): string {
  const [a, b] = splitHalf(text);
  return (
    `<a:p><a:r><a:t>${a}</a:t></a:r><a:r><a:t>${b}</a:t></a:r></a:p>`
  );
}

/** Namespaces DrawingML chart / diagram parts declare. */
const DML_NS =
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ` +
  `xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

/**
 * A full `word/charts/chart1.xml` whose chart TITLE holds `text` in a
 * `<c:tx><c:rich>` run (split across `<a:t>` runs). Structural chart XML around
 * the title (`<c:plotArea>` etc.) must survive untouched.
 */
export function chartTitlePart(text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace ${DML_NS}><c:chart><c:title><c:tx><c:rich>` +
    `<a:bodyPr/><a:lstStyle/>` +
    smartArtTitlePara(text) +
    `</c:rich></c:tx></c:title>` +
    `<c:plotArea><c:layout/></c:plotArea>` +
    `</c:chart></c:chartSpace>`
  );
}

/** A full `word/diagrams/data1.xml` (SmartArt) with `text` in a `<dgm:t>` run. */
export function smartArtDataPart(text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<dgm:dataModel ${DML_NS}><dgm:ptLst><dgm:pt><dgm:t>` +
    `<a:bodyPr/><a:lstStyle/>` +
    smartArtTitlePara(text) +
    `</dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`
  );
}

// ---------------------------------------------------------------------------
// Shape ② — field-code placeholders
// ---------------------------------------------------------------------------

/**
 * A `<w:fldSimple>` field: `instr` is the field INSTRUCTION (an attribute that
 * must never be rewritten), `result` is the cached displayed result in a child
 * `<w:r><w:t>` (where a `$scroll.*` must resolve).
 */
export function fldSimpleResult(instr: string, result: string): string {
  return (
    `<w:p><w:fldSimple w:instr="${instr}">` +
    `<w:r><w:t xml:space="preserve">${result}</w:t></w:r>` +
    `</w:fldSimple></w:p>`
  );
}

/**
 * A complex field: `begin` → `<w:instrText>` (the instruction, never rewritten)
 * → `separate` → cached `result` `<w:r><w:t>` (where a `$scroll.*` resolves) →
 * `end`. The result is split across two runs to prove run-normalization applies
 * to the displayed result too.
 */
export function complexFieldResult(instr: string, result: string): string {
  const [a, b] = splitHalf(result);
  return (
    `<w:p>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t xml:space="preserve">${a}</w:t></w:r>` +
    `<w:r><w:t xml:space="preserve">${b}</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p>`
  );
}

// ---------------------------------------------------------------------------
// Shape ③ — placeholder split across a text-box (story) boundary
// ---------------------------------------------------------------------------

/**
 * A paragraph whose `outer` run text is followed by a nested text box whose run
 * holds `inner`. Used to PROVE the extractor does NOT fuse text across the box
 * (story) boundary — a physically impossible split in real authoring.
 */
export function crossBoundarySplitPara(outer: string, inner: string): string {
  return (
    `<w:p>` +
    `<w:r><w:t xml:space="preserve">${outer}</w:t></w:r>` +
    `<w:r><w:drawing><wps:txbx><w:txbxContent>` +
    `<w:p><w:r><w:t xml:space="preserve">${inner}</w:t></w:r></w:p>` +
    `</w:txbxContent></wps:txbx></w:drawing></w:r>` +
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
  /**
   * Extra raw parts keyed by path, e.g. `word/charts/chart1.xml` or
   * `word/diagrams/data1.xml`. Added verbatim; the `Default Extension="xml"`
   * content type covers them, and docxtemplater leaves non-story `.xml` parts
   * untouched — so they round-trip through the export unchanged.
   */
  extraParts?: Record<string, string>;
  /**
   * Pins every zip entry's DOS timestamp. PizZip stamps each `file()` with
   * `new Date()` (2-second resolution) by default, so two independent builds
   * that straddle a 2-second boundary produce byte-different archives. Passing
   * a fixed `date` makes the output fully byte-reproducible — required whenever
   * a build is treated as a fixed asset that gets byte-compared (e.g. a bundled
   * default template).
   */
  date?: Date;
}

/** Assemble a valid minimal `.docx` and return its bytes. */
export function buildDocx(opts: BuildDocxOptions): Uint8Array {
  const zip = new PizZip();
  const hasHeader = opts.header != null;
  const hasFooter = opts.footer != null;
  const hasSettings = opts.settings !== null; // default: include settings
  const relationships = docRels(hasHeader, hasFooter, hasSettings);
  // A pinned date makes the archive byte-reproducible (see BuildDocxOptions.date).
  // pizzip's runtime `file()` accepts a per-entry options bag (its documented
  // API, `date` included), but this repo's module resolution surfaces an older
  // 2-arg overload, so the options-carrying call is typed explicitly here.
  const fileOpts = opts.date ? { date: opts.date } : undefined;
  const addFileWithOpts = (zip.file as (name: string, data: string, options?: { date: Date }) => unknown).bind(zip);
  const addFile = (name: string, content: string) => addFileWithOpts(name, content, fileOpts);

  addFile("[Content_Types].xml", CONTENT_TYPES({ header: hasHeader, footer: hasFooter, settings: hasSettings }));
  addFile("_rels/.rels", ROOT_RELS);
  addFile("word/document.xml", documentXmlWithStoryReferences(opts.body, relationships));
  addFile("word/_rels/document.xml.rels", relationships.xml);
  addFile("word/styles.xml", opts.styles ?? stylesXml());
  if (hasSettings) {
    addFile(
      "word/settings.xml",
      opts.settings ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>`
    );
  }
  if (hasHeader) {
    addFile(
      "word/header1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${OOXML_NS}>${opts.header}</w:hdr>`
    );
  }
  if (hasFooter) {
    addFile(
      "word/footer1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${OOXML_NS}>${opts.footer}</w:ftr>`
    );
  }
  for (const [path, content] of Object.entries(opts.extraParts ?? {})) {
    addFile(path, content);
  }
  return zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
}

/** Unzip bytes and read a part's text (for output assertions). */
export function readPart(bytes: Uint8Array, part: string): string {
  const zip = new PizZip(bytes);
  return zip.file(part)?.asText() ?? "";
}

/**
 * A structurally valid PNG header (signature + IHDR) with the given pixel
 * size — real bytes for the image-module decoder, no image library needed.
 * `pad` appends zero bytes so two fixtures can share a size yet differ.
 */
export function pngFixtureBytes(width: number, height: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  b[24] = 8; // bit depth
  b[25] = 6; // color type RGBA
  return b;
}

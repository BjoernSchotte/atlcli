#!/usr/bin/env bun
/**
 * Neutral untagged acceptance document, authored for AtlCLI (Apache-2.0).
 *
 * One content model renders the word-processor source
 * (`untagged-source.docx`) and the expected oracle (`untaggedOrderedBlocks`,
 * `UNTAGGED_TABLES`). Word for Mac exports it as an untagged PDF, the producer
 * of most untagged business documents: ruled tables drawn as thin filled
 * rectangles, shaded cells, merged cells, a repeated header row, a shaded
 * note box, a borderless table and a shaded footer on every page.
 *
 *   bun specs/pdf-import-quality/fixtures/untagged-source.ts
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";

export const UNTAGGED_TITLE = "Neutral Supplier Handbook";
export const UNTAGGED_INTRO = "This handbook lists neutral supplier records for import acceptance.";
export const UNTAGGED_INVENTORY_HEADING = "Inventory";
export const UNTAGGED_INVENTORY_HEADER = ["Item", "Quantity", "Remarks"] as const;
export const UNTAGGED_INVENTORY_ROWS = 45;
/** Body row (1-based) whose middle cell is intentionally blank. */
export const UNTAGGED_BLANK_ROW = 9;
export const UNTAGGED_AFTER_INVENTORY = "The inventory ends here.";
export const UNTAGGED_NOTE = "Note: this shaded box holds a neutral reminder.";
export const UNTAGGED_PRICING_HEADING = "Pricing";
export const UNTAGGED_PRICING_ROWS = [["Alpha", "10", "12"], ["Beta", "7", "9"], ["Gamma", "4", "5"]] as const;
export const UNTAGGED_CONTACTS_HEADING = "Contacts";
export const UNTAGGED_CONTACTS = [
  ["Role", "Team", "Hours"],
  ["Buyer", "North", "8-16"],
  ["Planner", "South", "9-17"],
  ["Auditor", "East", "7-15"],
] as const;
export const UNTAGGED_LIST = ["Check every record.", "Confirm the quantity.", "Archive the handbook."];
export const UNTAGGED_END = "End of handbook.";
export const UNTAGGED_FOOTER = "Neutral handbook – page";

export function untaggedInventoryRow(index: number): [string, string, string] {
  return [`Item ${index}`, index === UNTAGGED_BLANK_ROW ? "" : `${index * 3}`, `Remark ${index}, checked.`];
}

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const run = (text: string, bold = false) =>
  `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
export const paragraph = (text: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${text ? run(text) : ""}</w:p>`;
export const heading = (text: string, level: 1 | 2) => paragraph(text, `<w:pStyle w:val="Heading${level}"/>`);
const shade = (fill: string) => `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;

export interface Cell { text: string; bold?: boolean; fill?: string; span?: number; vMerge?: "restart" | "continue" }

/** A WordprocessingML table; `borders: "inside"` draws inside rules only (Word's "no outer border"). */
export function table(rows: readonly (readonly Cell[])[], widths: readonly number[], options: { borders: boolean | "inside"; repeatHeader?: number }): string {
  const sides = ["top", "left", "bottom", "right", "insideH", "insideV"];
  const borders = sides.map((side) => options.borders === true || options.borders === "inside" && side.startsWith("inside")
    ? `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`
    : `<w:${side} w:val="nil"/>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((sum, width) => sum + width, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
    + `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`
    + rows.map((cells, rowIndex) => {
      let column = 0;
      return `<w:tr>${rowIndex < (options.repeatHeader ?? 0) ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`
        + cells.map((cell) => {
          const span = cell.span ?? 1;
          const width = widths.slice(column, column + span).reduce((sum, value) => sum + value, 0);
          column += span;
          const properties = `<w:tcW w:w="${width}" w:type="dxa"/>`
            + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : "")
            + (cell.vMerge === "restart" ? `<w:vMerge w:val="restart"/>` : cell.vMerge === "continue" ? "<w:vMerge/>" : "")
            + (cell.fill ? shade(cell.fill) : "");
          return `<w:tc><w:tcPr>${properties}</w:tcPr><w:p>${cell.text ? run(cell.text, cell.bold) : ""}</w:p></w:tc>`;
        }).join("")
        + "</w:tr>";
    }).join("")
    + "</w:tbl>";
}

export function untaggedDocx(): Uint8Array {
  const header = (text: string): Cell => ({ text, bold: true });
  const inventory = table([
    UNTAGGED_INVENTORY_HEADER.map(header),
    ...Array.from({ length: UNTAGGED_INVENTORY_ROWS }, (_, index) => untaggedInventoryRow(index + 1).map((text) => ({ text }))),
  ], [2600, 2200, 4200], { borders: true, repeatHeader: 1 });
  const note = table([[{ text: UNTAGGED_NOTE, fill: "DDEBF7" }]], [9000], { borders: false });
  const pricing = table([
    [{ text: "Product", bold: true, fill: "D9D9D9", vMerge: "restart" }, { text: "Quarters", bold: true, fill: "D9D9D9", span: 2 }],
    [{ text: "", fill: "D9D9D9", vMerge: "continue" }, { text: "Q1", bold: true, fill: "D9D9D9" }, { text: "Q2", bold: true, fill: "D9D9D9" }],
    ...UNTAGGED_PRICING_ROWS.map((cells) => cells.map((text) => ({ text }))),
  ], [3000, 3000, 3000], { borders: true });
  const contacts = table(UNTAGGED_CONTACTS.map((cells, index) => cells.map((text) => ({ text, bold: index === 0 }))), [3000, 3000, 3000], { borders: false });
  const body = [
    heading(UNTAGGED_TITLE, 1),
    paragraph(UNTAGGED_INTRO),
    heading(UNTAGGED_INVENTORY_HEADING, 2),
    inventory,
    paragraph(UNTAGGED_AFTER_INVENTORY),
    note,
    heading(UNTAGGED_PRICING_HEADING, 2),
    pricing,
    heading(UNTAGGED_CONTACTS_HEADING, 2),
    contacts,
    ...UNTAGGED_LIST.map((item) => paragraph(item, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`)),
    paragraph(UNTAGGED_END),
    `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join("");
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr>${shade("DDEBF7")}<w:jc w:val="center"/></w:pPr>${run(`${UNTAGGED_FOOTER} `)}<w:fldSimple w:instr="PAGE">${run("1")}</w:fldSimple></w:p></w:ftr>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>`
    + `</w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}">`
    + `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`
    + `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`
    + `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const officeRel = (name: string) => `${R}/${name}`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", officeRel("officeDocument"), "word/document.xml")}${rel("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml")}</Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${UNTAGGED_TITLE}</dc:title><dc:creator>AtlCLI neutral fixture generator</dc:creator></cp:coreProperties>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rIdStyles", officeRel("styles"), "styles.xml")}${rel("rIdNumbering", officeRel("numbering"), "numbering.xml")}${rel("rIdFooter", officeRel("footer"), "footer1.xml")}</Relationships>`),
    "word/styles.xml": strToU8(styles),
    "word/numbering.xml": strToU8(numbering),
    "word/footer1.xml": strToU8(footer),
  }, { mtime: new Date("2026-01-01T00:00:00Z") });
}

type OracleBlock = { id: string; type: "heading" | "paragraph" | "list-paragraph" | "table-row"; text: string; table?: number };

/** The document's blocks in reading order, as the quality oracle compares them. The footer is page furniture. */
export function untaggedOrderedBlocks(): OracleBlock[] {
  const row = (cells: readonly string[]) => cells.join(" | ");
  return [
    { id: "title", type: "heading", text: UNTAGGED_TITLE },
    { id: "intro", type: "paragraph", text: UNTAGGED_INTRO },
    { id: "inventory-heading", type: "heading", text: UNTAGGED_INVENTORY_HEADING },
    { id: "inventory-header", type: "table-row", text: row(UNTAGGED_INVENTORY_HEADER), table: 0 },
    ...Array.from({ length: UNTAGGED_INVENTORY_ROWS }, (_, index) => ({
      id: `inventory-${index + 1}`, type: "table-row" as const, text: row(untaggedInventoryRow(index + 1)), table: 0,
    })),
    { id: "after-inventory", type: "paragraph", text: UNTAGGED_AFTER_INVENTORY },
    { id: "note", type: "paragraph", text: UNTAGGED_NOTE },
    { id: "pricing-heading", type: "heading", text: UNTAGGED_PRICING_HEADING },
    // The merged "Product" cell spans both header rows, so the second row has two cells.
    { id: "pricing-header-1", type: "table-row", text: row(["Product", "Quarters"]), table: 1 },
    { id: "pricing-header-2", type: "table-row", text: row(["Q1", "Q2"]), table: 1 },
    ...UNTAGGED_PRICING_ROWS.map((cells, index) => ({ id: `pricing-${index + 1}`, type: "table-row" as const, text: row(cells), table: 1 })),
    { id: "contacts-heading", type: "heading", text: UNTAGGED_CONTACTS_HEADING },
    ...UNTAGGED_CONTACTS.map((cells, index) => ({ id: `contacts-${index}`, type: "table-row" as const, text: row(cells), table: 2 })),
    ...UNTAGGED_LIST.map((text, index) => ({ id: `list-${index + 1}`, type: "list-paragraph" as const, text })),
    { id: "end", type: "paragraph", text: UNTAGGED_END },
  ];
}

/** Table shapes in the model: header rows and blank cells as [row, column]. */
export const UNTAGGED_TABLES = [
  { rows: UNTAGGED_INVENTORY_ROWS + 1, columns: 3, headerRows: 1, blankCells: [[UNTAGGED_BLANK_ROW, 1]] },
  { rows: UNTAGGED_PRICING_ROWS.length + 2, columns: 3, headerRows: 2, blankCells: [] },
  { rows: UNTAGGED_CONTACTS.length, columns: 3, headerRows: 1, blankCells: [] },
];

/** Explicit spans: [row, column, rowspan, colspan]. */
export const UNTAGGED_SPANS = [
  { tableIndex: 1, rowIndex: 0, columnIndex: 0, rowspan: 2, colspan: 1 },
  { tableIndex: 1, rowIndex: 0, columnIndex: 1, rowspan: 1, colspan: 2 },
];

if (import.meta.main) {
  await writeFile(resolve(import.meta.dir, "untagged-source.docx"), untaggedDocx());
  process.stdout.write("wrote untagged-source.docx\n");
}

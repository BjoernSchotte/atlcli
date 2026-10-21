#!/usr/bin/env bun
/**
 * Neutral producer-variety documents, authored for AtlCLI (Apache-2.0).
 *
 * `table-breaks.docx` holds the three ways a table meets a page break: a
 * fully ruled table broken between rows, a table drawn with inside rules only
 * (Word's "no outer border"), and a ruled table whose tall row is split by the
 * break. `contents.docx` holds a table of contents set in the styles of the
 * headings it lists, and numbered headings of two levels in one size, bold
 * and regular. Desktop producers export them; `producers.test.ts` checks
 * every export against the models below. Nothing in the models is taken from
 * importer output.
 *
 *   bun specs/pdf-import-quality/fixtures/producers/source.ts <output-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { type Cell, R, W, heading, paragraph, run, table } from "../untagged-source.js";

export const LEDGER_ROWS = 50;
export const ROSTER_ROWS = 50;
export const SPLIT_BEFORE_ROWS = 25;
export const SPLIT_TEXT = Array.from({ length: 24 }, (_, index) => `Clause ${index + 1} applies to every neutral record.`).join(" ");

export const ledgerRow = (index: number) => [`Entry ${index}`, `${index * 4}`, `Booked ${index}`];
export const rosterRow = (index: number) => [`Member ${index}`, `Team ${index % 5}`, `Shift ${index % 3}`];
export const splitRow = (index: number) => [`Rule ${index}`, `${index}`, `Scope ${index}`];
const HEADER = ["Name", "Value", "Note"];

/** Expected tables, top to bottom, as rows of cell texts. */
export function tableBreakTables(): string[][][] {
  return [
    [HEADER, ...Array.from({ length: LEDGER_ROWS }, (_, index) => ledgerRow(index + 1))],
    [HEADER, ...Array.from({ length: ROSTER_ROWS }, (_, index) => rosterRow(index + 1))],
    [HEADER, ...Array.from({ length: SPLIT_BEFORE_ROWS }, (_, index) => splitRow(index + 1)), ["Clauses", "All", SPLIT_TEXT], splitRow(SPLIT_BEFORE_ROWS + 1)],
  ];
}

export function tableBreaksDocx(): Uint8Array {
  const cells = (texts: readonly string[], bold = false): Cell[] => texts.map((text) => ({ text, bold }));
  const [ledger, roster, split] = tableBreakTables();
  const widths = [2600, 2200, 4200];
  const pageBreak = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  const body = [
    heading("Ledger", 2),
    table(ledger!.map((row, index) => cells(row, index === 0)), widths, { borders: true }),
    pageBreak,
    heading("Roster", 2),
    table(roster!.map((row, index) => cells(row, index === 0)), widths, { borders: "inside" }),
    pageBreak,
    heading("Clauses", 2),
    table(split!.map((row, index) => cells(row, index === 0)), widths, { borders: true }),
    paragraph("End of the table breaks."),
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join("");
  return packageDocx(body, `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>`);
}

export const CONTENTS_TITLE = "Neutral Service Manual";
/** Sections by page: number, title, and the page the section starts on. */
export const CONTENTS_SECTIONS = [
  { number: "1", title: "Scope", page: 2 },
  { number: "1.1", title: "Terms", page: 2 },
  { number: "1.2", title: "Records", page: 2 },
  { number: "2", title: "Process", page: 3 },
  { number: "2.1", title: "Intake", page: 3 },
  { number: "2.2", title: "Review", page: 3 },
  { number: "3", title: "Closure", page: 4 },
  { number: "3.1", title: "Archive", page: 4 },
] as const;
export const contentsBody = (number: string) => `Section ${number} describes how every neutral record is handled.`;

export function contentsDocx(): Uint8Array {
  const pageBreak = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  const entries = CONTENTS_SECTIONS.map(({ number, title, page }) =>
    `<w:p><w:pPr><w:pStyle w:val="TOC${number.includes(".") ? 2 : 1}"/></w:pPr>${run(`${number} ${title}`)}<w:r><w:tab/></w:r>${run(String(page))}</w:p>`
  );
  const sections = CONTENTS_SECTIONS.flatMap(({ number, title }, index) => [
    ...(index > 0 && !number.includes(".") ? [pageBreak] : []),
    heading(`${number} ${title}`, number.includes(".") ? 2 : 1),
    paragraph(contentsBody(number)),
  ]);
  const body = [
    paragraph(CONTENTS_TITLE, `<w:pStyle w:val="Title"/>`),
    ...entries,
    pageBreak,
    ...sections,
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join("");
  const style = (id: string, name: string, properties: string, runProperties: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr>${properties}</w:pPr><w:rPr>${runProperties}</w:rPr></w:style>`;
  const tabs = `<w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs>`;
  return packageDocx(body, [
    style("Title", "Title", `<w:spacing w:after="240"/>`, `<w:b/><w:sz w:val="48"/>`),
    style("Heading1", "heading 1", `<w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/>`, `<w:b/><w:sz w:val="24"/>`),
    style("Heading2", "heading 2", `<w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/>`, `<w:sz w:val="24"/>`),
    style("TOC1", "toc 1", `${tabs}<w:spacing w:after="60"/>`, `<w:b/><w:sz w:val="24"/>`),
    style("TOC2", "toc 2", `${tabs}<w:spacing w:after="60"/><w:ind w:left="220"/>`, `<w:sz w:val="24"/>`),
  ].join(""), 20);
}

/** A DOCX package with Arial body text in `bodySize` half-points and extra paragraph styles. */
function packageDocx(body: string, extraStyles: string, bodySize = 22): Uint8Array {
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="${bodySize}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
    + extraStyles
    + `</w:styles>`;
  const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const relationships = (entries: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(relationships(rel("rId1", `${R}/officeDocument`, "word/document.xml"))),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`),
    "word/_rels/document.xml.rels": strToU8(relationships(rel("rIdStyles", `${R}/styles`, "styles.xml"))),
    "word/styles.xml": strToU8(styles),
  }, { mtime: new Date("2026-01-01T00:00:00Z") });
}

if (import.meta.main) {
  const output = resolve(process.argv[2] ?? ".tmp/producers");
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "table-breaks.docx"), tableBreaksDocx());
  await writeFile(resolve(output, "contents.docx"), contentsDocx());
  process.stdout.write(`wrote ${output}/table-breaks.docx and contents.docx\n`);
}

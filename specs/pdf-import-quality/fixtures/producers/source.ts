#!/usr/bin/env bun
/**
 * Neutral producer-variety documents, authored for AtlCLI (Apache-2.0).
 *
 * `table-breaks.docx` holds the three ways a table meets a page break: a
 * fully ruled table broken between rows, a table drawn with inside rules only
 * (Word's "no outer border"), and a ruled table whose tall row is split by the
 * break. Desktop producers export it; `producers.test.ts` checks every export
 * against the model below. Nothing in the model is taken from importer output.
 *
 *   bun specs/pdf-import-quality/fixtures/producers/source.ts <output-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { type Cell, R, W, heading, paragraph, table } from "../untagged-source.js";

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
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>`
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
  process.stdout.write(`wrote ${output}/table-breaks.docx\n`);
}

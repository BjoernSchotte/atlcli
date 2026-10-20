#!/usr/bin/env bun
/**
 * Neutral PIQ-18 acceptance document, authored for AtlCLI (Apache-2.0).
 *
 * One content model renders the authoring source (`acceptance-source.html`)
 * and the expected oracle (`acceptanceExpectedBlocks`). The oracle comes from
 * this model, never from importer output.
 *
 *   bun specs/pdf-import-quality/fixtures/acceptance-source.ts
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeRgbaPng } from "../../../packages/import-pdf/src/fallbacks.js";

export const ACCEPTANCE_TITLE = "Neutral Acceptance Handbook";
export const ACCEPTANCE_INTRO = "This handbook describes a neutral inventory for import acceptance.";
export const ACCEPTANCE_LIST = ["Count every item once.", "Record the value.", "Publish the summary."];
export const ACCEPTANCE_INVENTORY_HEADING = "Inventory";
/** Header row; the middle header is intentionally blank. */
export const ACCEPTANCE_INVENTORY_HEADER = ["Item", "", "Notes"] as const;
export const ACCEPTANCE_INVENTORY_ROWS = 60;
/** Body row (1-based) whose middle cell is intentionally blank. */
export const ACCEPTANCE_BLANK_ROW = 7;
export const ACCEPTANCE_AFTER_INVENTORY = "The inventory ends here.";
export const ACCEPTANCE_FIGURE_ALT = "Neutral blue gradient";
export const ACCEPTANCE_CAPTION = "Figure 1: Neutral gradient.";
export const ACCEPTANCE_AFTER_FIGURE = "Body text continues after the figure.";
export const ACCEPTANCE_SUMMARY_HEADING = "Summary";
export const ACCEPTANCE_SUMMARY = [["Metric", "Count"], ["Items", "60"], ["Pages", "several"]] as const;
export const ACCEPTANCE_END = "End of handbook.";

export function inventoryRow(index: number): [string, string, string] {
  return [
    `Item ${index}`,
    index === ACCEPTANCE_BLANK_ROW ? "" : `Value ${index}`,
    `Wrapped note ${index} (see item ${index}); continues, with punctuation: done.`,
  ];
}

/** A 160x60 left-to-right gradient, a genuine raster figure. */
export function acceptanceFigurePng(): Uint8Array {
  const width = 160;
  const height = 60;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at] = 30;
      rgba[at + 1] = Math.round(80 + (x / width) * 120);
      rgba[at + 2] = 220;
      rgba[at + 3] = 255;
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function acceptanceHtml(): string {
  const png = Buffer.from(acceptanceFigurePng()).toString("base64");
  const rows = Array.from({ length: ACCEPTANCE_INVENTORY_ROWS }, (_, index) =>
    `<tr>${inventoryRow(index + 1).map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${ACCEPTANCE_TITLE}</title>
<style>
body{font-family:Arial,sans-serif;font-size:11pt}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #333;padding:4px;text-align:left;vertical-align:top}
td:last-child,th:last-child{width:30%}
hr{border:0;border-top:2px solid #888;margin:18px 0}
</style></head><body>
<h1>${ACCEPTANCE_TITLE}</h1>
<p>${ACCEPTANCE_INTRO}</p>
<ul>${ACCEPTANCE_LIST.map((item) => `<li>${item}</li>`).join("")}</ul>
<h2>${ACCEPTANCE_INVENTORY_HEADING}</h2>
<table>
<thead><tr>${ACCEPTANCE_INVENTORY_HEADER.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>
<tbody>
${rows}
</tbody></table>
<p>${ACCEPTANCE_AFTER_INVENTORY}</p>
<hr>
<figure><img alt="${ACCEPTANCE_FIGURE_ALT}" width="160" height="60" src="data:image/png;base64,${png}">
<figcaption>${ACCEPTANCE_CAPTION}</figcaption></figure>
<p>${ACCEPTANCE_AFTER_FIGURE}</p>
<h2>${ACCEPTANCE_SUMMARY_HEADING}</h2>
<table>${ACCEPTANCE_SUMMARY.map((row, index) =>
    `<tr>${row.map((cell) => index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`).join("")}</tr>`
  ).join("")}</table>
<p>${ACCEPTANCE_END}</p>
</body></html>
`;
}

type OracleBlock = { id: string; type: "heading" | "paragraph" | "list-paragraph" | "table-row"; text: string; table?: number };

/** The document's blocks in reading order, as the quality oracle compares them. */
export function acceptanceOrderedBlocks(): OracleBlock[] {
  const row = (cells: readonly string[]) => cells.join(" | ");
  return [
    { id: "title", type: "heading", text: ACCEPTANCE_TITLE },
    { id: "intro", type: "paragraph", text: ACCEPTANCE_INTRO },
    ...ACCEPTANCE_LIST.map((text, index) => ({ id: `list-${index + 1}`, type: "list-paragraph" as const, text })),
    { id: "inventory-heading", type: "heading", text: ACCEPTANCE_INVENTORY_HEADING },
    { id: "inventory-header", type: "table-row", text: row(ACCEPTANCE_INVENTORY_HEADER), table: 0 },
    ...Array.from({ length: ACCEPTANCE_INVENTORY_ROWS }, (_, index) => ({
      id: `inventory-${index + 1}`, type: "table-row" as const, text: row(inventoryRow(index + 1)), table: 0,
    })),
    { id: "after-inventory", type: "paragraph", text: ACCEPTANCE_AFTER_INVENTORY },
    { id: "caption", type: "paragraph", text: ACCEPTANCE_CAPTION },
    { id: "after-figure", type: "paragraph", text: ACCEPTANCE_AFTER_FIGURE },
    { id: "summary-heading", type: "heading", text: ACCEPTANCE_SUMMARY_HEADING },
    ...ACCEPTANCE_SUMMARY.map((cells, index) => ({ id: `summary-${index}`, type: "table-row" as const, text: row(cells), table: 1 })),
    { id: "end", type: "paragraph", text: ACCEPTANCE_END },
  ];
}

/** Table shapes in the model: header rows and blank cells as [row, column]. */
export const ACCEPTANCE_TABLES = [
  { rows: ACCEPTANCE_INVENTORY_ROWS + 1, columns: 3, headerRows: 1, blankCells: [[0, 1], [ACCEPTANCE_BLANK_ROW, 1]] },
  { rows: ACCEPTANCE_SUMMARY.length, columns: 2, headerRows: 1, blankCells: [] },
];

const canonical = (value: string) => value.replace(/[\s\u00ad]/gu, "");

/**
 * Places each oracle block on the source page whose PDFium text shows it,
 * searching forward in reading order. Rows of one logical table carry the
 * page of its first row, as the quality report flattens tables.
 */
export function acceptanceBlockPages(pageTexts: readonly string[]): Array<OracleBlock & { pageIndex: number }> {
  const pages = pageTexts.map(canonical);
  const tablePages = new Map<number, number>();
  let page = 0;
  let offset = 0;
  return acceptanceOrderedBlocks().map((block) => {
    const needle = canonical(block.text.split(" | ").find((cell) => cell.length > 0) ?? block.text);
    for (;;) {
      const found = pages[page]?.indexOf(needle, offset) ?? -1;
      if (found >= 0) {
        offset = found + needle.length;
        break;
      }
      if (page >= pages.length - 1) throw new Error(`Oracle block ${block.id} is not in the PDF text.`);
      page += 1;
      offset = 0;
    }
    if (block.table !== undefined && !tablePages.has(block.table)) tablePages.set(block.table, page);
    return { ...block, pageIndex: block.table === undefined ? page : tablePages.get(block.table)! };
  });
}

if (import.meta.main) {
  await writeFile(resolve(import.meta.dir, "acceptance-source.html"), acceptanceHtml());
  process.stdout.write("wrote acceptance-source.html\n");
}

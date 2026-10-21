/**
 * Pinned neutral exports from desktop producers (see
 * `specs/pdf-import-quality/fixtures/producers/README.md`) and a generated
 * scan with an OCR text layer, checked against their authored models.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type { ImportBlock } from "@atlcli/import-core";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";
import { buildPdfImportReviewV3 } from "./review.js";
import { parsePdfSplitPolicy } from "./split.js";
import { tableBreakTables } from "../../../specs/pdf-import-quality/fixtures/producers/source.js";

const producerRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures/producers");

async function review(bytes: Uint8Array) {
  return buildPdfImportReviewV3(bytes, await createNodePdfiumFactsAdapterV2(), {
    target: { spaceKey: "X", title: "T", deployment: "cloud", supportsPageTree: true, evidence: "profile" },
    splitPolicy: parsePdfSplitPolicy("off"),
  });
}

const text = (block: ImportBlock): unknown => block.type === "table"
  ? block.rows.map((row) => row.cells.map((cell) => cell.blocks.map(text).join("/")))
  : block.type === "list"
    ? block.items.map((item) => item.blocks.map(text).join("/"))
    : "runs" in block ? block.runs.map((run) => run.kind === "text" ? run.text : "").join("") : block.type;

describe("desktop producer exports", () => {
  for (const producer of ["word", "libreoffice"]) {
    it(`reads every table across page breaks in the ${producer} export`, async () => {
      const result = await review(new Uint8Array(await readFile(resolve(producerRoot, `${producer}-table-breaks.pdf`))));
      const blocks = result.document.blocks;
      const [ledger, roster, clauses] = tableBreakTables();

      expect(result.pages.filter((page) => page.fallbackScope !== "none")).toEqual([]);
      expect(blocks.filter((block) => block.type === "heading").map(text)).toEqual(["Ledger", "Roster", "Clauses"]);
      // One heading level for one heading style.
      expect(new Set(blocks.flatMap((block) => block.type === "heading" ? [block.level] : [])).size).toBe(1);
      const tables = blocks.filter((block) => block.type === "table").map(text) as string[][][];
      expect(tables[0]).toEqual(ledger);
      // Drawn with inside rules only: open on every page, rows still complete.
      expect(tables[1]).toEqual(roster);
      // The producer draws the frame across the split row, so its rest is a
      // row of its own whose finished cells are blank; the review says so.
      const clausesRows = tables[2]!;
      expect(clausesRows).toHaveLength(clauses!.length + 1);
      expect(clausesRows.slice(0, -3)).toEqual(clauses!.slice(0, -2));
      expect(clausesRows.at(-2)!.slice(0, 2)).toEqual(["", ""]);
      expect(clausesRows.at(-1)).toEqual(clauses!.at(-1));
      expect(result.document.issues.filter((issue) => issue.code === "pdf-import/table-row-split-unproven")).toHaveLength(1);
    });
  }

  it("reads the slides of a presentation export without duplicating a shaded box as an image", async () => {
    // Regression: a filled text box drawn as moveto, four linetos and a close
    // became a rendered figure that repeated its text.
    const result = await review(new Uint8Array(await readFile(resolve(producerRoot, "libreoffice-deck.pdf"))));

    expect(result.document.blocks.map((block) => [block.type, text(block)])).toEqual([
      ["heading", "Neutral Field Review"],
      ["paragraph", "Quarterly summary for import acceptance"],
      ["heading", "Findings"],
      ["list", ["Every record was checked.", "Quantities match the ledger.", "Archive the review."]],
      ["paragraph", "Note: figures are neutral."],
      ["heading", "Totals"],
      ["table", [["Region", "Items", "State"], ["North", "12", "Open"], ["South", "9", "Done"]]],
    ]);
  });
});

/** One A4 page: a full-page grayscale image with OCR text over it in render mode 3 (invisible). */
function ocrScanPdf(): Uint8Array {
  const width = 120;
  const height = 170;
  const pixels = Uint8Array.from({ length: width * height }, (_, index) => Math.floor(index / width) % 17 < 2 ? 40 : 235);
  const content = "q 595 0 0 842 0 0 cm /Im1 Do Q\n"
    + "BT 3 Tr /F1 18 Tf 72 760 Td (Neutral Scan Report) Tj /F1 11 Tf 0 -40 Td (The scanned page lists neutral records.) Tj ET";
  const encoder = new TextEncoder();
  const objects: Uint8Array[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ].map((object) => encoder.encode(object));
  objects.push(new Uint8Array([
    ...encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),
    ...pixels,
    ...encoder.encode("\nendstream"),
  ]));
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  let length = parts[0]!.length;
  const offsets = objects.map((object, index) => {
    const offset = length;
    const part = new Uint8Array([...encoder.encode(`${index + 1} 0 obj\n`), ...object, ...encoder.encode("\nendobj\n")]);
    parts.push(part);
    length += part.length;
    return offset;
  });
  parts.push(encoder.encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

describe("scanned pages with an OCR text layer", () => {
  it("keeps the scan as a page image instead of trusting its invisible text", async () => {
    const result = await review(ocrScanPdf());

    expect(result.facts.pages[0]!.kind).toBe("mixed");
    expect(result.pages[0]!.fallbackScope).not.toBe("none");
    expect(result.document.blocks.filter((block) => block.type === "paragraph" || block.type === "heading")).toEqual([]);
  });
});

/**
 * Pinned neutral exports from desktop producers (see
 * `specs/pdf-import-quality/fixtures/producers/README.md`) and a generated
 * scan with an OCR text layer, checked against their authored models.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type { ImportBlock } from "@atlcli/import-core";
import { digestPdfFactsV2 } from "./canonical.js";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";
import { attachPdfOcrTextV2 } from "./ocr-text.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";
import { normalizeUntaggedPdfFactsV2 } from "./untagged.js";
import { buildPdfImportReviewV3 } from "./review.js";
import { parsePdfSplitPolicy } from "./split.js";
import {
  CONTENTS_SECTIONS,
  CONTENTS_TITLE,
  contentsBody,
  tableBreakTables,
} from "../../../specs/pdf-import-quality/fixtures/producers/source.js";

const producerRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures/producers");

async function review(bytes: Uint8Array, scanPolicy?: "page-image") {
  return buildPdfImportReviewV3(bytes, await createNodePdfiumFactsAdapterV2(), {
    target: { spaceKey: "X", title: "T", deployment: "cloud", supportsPageTree: true, evidence: "profile" },
    splitPolicy: parsePdfSplitPolicy("off"),
    ...(scanPolicy ? { scanPolicy } : {}),
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
      // row of its own whose finished cells are blank. LibreOffice breaks the
      // clause text mid-sentence, which joins the rest; Word breaks it between
      // sentences, so the rest stays a row and the review says so.
      const split = result.document.issues.filter((issue) => issue.code.startsWith("pdf-import/table-row-split-"));
      if (producer === "libreoffice") {
        expect(tables[2]).toEqual(clauses);
        expect(split.map((issue) => issue.code)).toEqual(["pdf-import/table-row-split-joined"]);
      } else {
        const clausesRows = tables[2]!;
        expect(clausesRows).toHaveLength(clauses!.length + 1);
        expect(clausesRows.slice(0, -3)).toEqual(clauses!.slice(0, -2));
        expect(clausesRows.at(-2)!.slice(0, 2)).toEqual(["", ""]);
        expect(clausesRows.at(-1)).toEqual(clauses!.at(-1));
        expect(split.map((issue) => issue.code)).toEqual(["pdf-import/table-row-split-unproven"]);
      }
    });
  }

  it("reads a table of contents as text and numbered headings by style", async () => {
    // Regression: contents lines set in the heading styles they list became
    // headings with their page numbers as headings of their own, and a bold
    // and a regular heading of one size shared a level.
    const result = await review(new Uint8Array(await readFile(resolve(producerRoot, "libreoffice-contents.pdf"))));
    const blocks = result.document.blocks.map((block) => [block.type === "heading" ? `h${block.level}` : block.type, text(block)]);

    expect(result.pages.filter((page) => page.fallbackScope !== "none")).toEqual([]);
    expect(blocks).toEqual([
      ["h1", CONTENTS_TITLE],
      ...CONTENTS_SECTIONS.map(({ number, title }) => ["paragraph", `${number} ${title}`]),
      ...CONTENTS_SECTIONS.flatMap(({ number, title }) => [
        [number.includes(".") ? "h3" : "h2", `${number} ${title}`],
        ["paragraph", contentsBody(number)],
      ]),
    ]);
    expect(result.evidence.filter((item) => item.decisionCode === "pdf/geometry-contents-page-number-suppressed"))
      .toHaveLength(CONTENTS_SECTIONS.length);
    expect(result.document.issues.map((issue) => issue.code)).not.toContain("pdf-import/heading-numbering-mismatch");
  });

  it("reports headings whose styles disagree with their section numbers", async () => {
    const { facts } = await (await createNodePdfiumFactsAdapterV2())
      .analyze(new Uint8Array(await readFile(resolve(producerRoot, "libreoffice-contents.pdf"))));
    // Set one second-level heading larger than the first-level ones.
    const page = facts.pages[2]!;
    const fragment = analyzeGeometryReadingOrderV2(page, new Set()).ordered.find((item) => item.text === "2.1 Intake")!;
    const enlarged = new Set(fragment.characters.map((character) => character.index));
    for (const character of page.characters) if (enlarged.has(character.index)) character.fontSizePoints = 18;

    const result = await normalizeUntaggedPdfFactsV2(facts, await digestPdfFactsV2(facts));
    const mismatch = result.document.issues.find((issue) => issue.code === "pdf-import/heading-numbering-mismatch");
    const headings = new Map(result.document.blocks.flatMap((block) => block.type === "heading" ? [[block.id, text(block)]] : []));

    expect(mismatch?.sourceRefs?.map((id) => headings.get(id))).toEqual(["2.1 Intake"]);
  });

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

  it("attaches the OCR layer unverified beside the page image", async () => {
    const result = await review(ocrScanPdf(), "page-image");
    const blocks = result.document.blocks;
    const ocr = blocks.find((block) => block.type === "disclosure" && block.title.startsWith("Recognized text"));

    // Page image, its caption, then the OCR text.
    expect(blocks.map((block) => block.type)).toEqual(["image", "paragraph", "disclosure"]);
    expect(ocr?.type === "disclosure" ? ocr.blocks.map(text) : null)
      .toEqual(["Neutral Scan Report", "The scanned page lists neutral records."]);
    expect(result.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/ocr-text-attached",
      severity: "info",
      context: { pageIndex: 0, lines: 2 },
    }));
  });

  it("attaches no OCR text to a page image of visible text", async () => {
    // The fallback page of a digital export holds visible text, not a scan's guess.
    const { facts } = await (await createNodePdfiumFactsAdapterV2()).analyze(ocrScanPdf());
    for (const character of facts.pages[0]!.characters) delete character.invisible;
    const document = { schema: "x", sourceKind: "pdf", blocks: [{ id: "i", type: "image", assetId: "a", presentation: "page-fallback", sourceRefs: ["pdf:p0"] }], assets: [], issues: [] } as never;

    expect(attachPdfOcrTextV2(facts, document)).toBe(document);
  });
});

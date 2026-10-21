import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { zlibSync } from "fflate";
import { classifyMarkedContent, PdfObjectReader } from "./pdf-objects.js";
import {
  correlateDocStructTree,
  elementCharacters,
  readDocStructTree,
  type DocStructElement,
  type DocStructTree,
} from "./struct-tree.js";
import type { PdfFactsV2, PdfStructureNodeFactV2 } from "./contracts.js";
import { createNodePdfiumFactsAdapterV2 } from "./node.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Builds a classic-xref PDF from object bodies (object numbers start at 1). */
function classicPdf(objects: string[], rootNum = 1): Uint8Array {
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(body);
}

/** Builds a PDF whose objects live in an object stream indexed by a PNG-predicted xref stream. */
function compressedPdf(objects: string[]): Uint8Array {
  const n = objects.length;
  let header = "";
  let payload = "";
  objects.forEach((obj, i) => {
    header += `${i + 1} ${payload.length} `;
    payload += `${obj}\n`;
  });
  const objStm = zlibSync(latin1(header + payload));
  let body = "%PDF-1.7\n";
  const objStmNum = n + 1;
  const xrefNum = n + 2;
  const objStmOffset = body.length;
  const head = `${objStmNum} 0 obj\n<< /Type /ObjStm /N ${n} /First ${header.length} /Length ${objStm.length} /Filter /FlateDecode >>\nstream\n`;
  const parts: Uint8Array[] = [latin1(body + head), objStm, latin1("\nendstream\nendobj\n")];
  const xrefOffset = parts.reduce((s, p) => s + p.length, 0);
  // W [1 2 1]; rows for objects 0..xrefNum, PNG "Up" predictor (type 2) per row.
  const rows: number[][] = [[0, 0, 0, 0]];
  for (let i = 0; i < n; i++) rows.push([2, (objStmNum >> 8) & 0xff, objStmNum & 0xff, i]);
  rows.push([1, (objStmOffset >> 8) & 0xff, objStmOffset & 0xff, 0]);
  rows.push([1, (xrefOffset >> 8) & 0xff, xrefOffset & 0xff, 0]);
  const predicted: number[] = [];
  rows.forEach((row, r) => {
    predicted.push(2);
    row.forEach((v, c) => predicted.push((v - (r > 0 ? rows[r - 1][c] : 0)) & 0xff));
  });
  const xrefData = zlibSync(Uint8Array.from(predicted));
  parts.push(
    latin1(
      `${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >> /Length ${xrefData.length} >>\nstream\n`,
    ),
    xrefData,
    latin1(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`),
  );
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Catalog, pages, two pages, a struct tree with a table split across both pages.
const TREE_OBJECTS = [
  "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  "<< /Type /StructTreeRoot /K 6 0 R /RoleMap << /MyTable /Table >> >>",
  "<< /S /MyTable /P 5 0 R /K [7 0 R 8 0 R] >>",
  "<< /S /TR /P 6 0 R /K << /S /TD /Pg 3 0 R /K 0 >> >>",
  "<< /S /TR /P 6 0 R /K [<< /S /TD /Pg 4 0 R /K [<< /Type /MCR /Pg 4 0 R /MCID 3 >>] /A << /O /Table /ColSpan 2 >> >>] >>",
];

function onlyElement(tree: DocStructTree | null): DocStructElement {
  expect(tree).not.toBeNull();
  expect(tree!.roots).toHaveLength(1);
  return tree!.roots[0];
}

describe("PdfObjectReader", () => {
  it("reads a classic cross-reference table", () => {
    const tree = readDocStructTree(classicPdf(TREE_OBJECTS));
    expect(tree?.recoveredByScan).toBe(false);
    const table = onlyElement(tree);
    expect(table.id).toBe("obj:6");
    expect(table.role).toBe("MyTable");
    expect(table.standardRole).toBe("Table");
  });

  it("reads object streams through a PNG-predicted cross-reference stream", () => {
    const reader = new PdfObjectReader(compressedPdf(TREE_OBJECTS));
    expect(reader.recoveredByScan).toBe(false);
    const tree = readDocStructTree(compressedPdf(TREE_OBJECTS));
    expect(tree?.pageCount).toBe(2);
    expect(onlyElement(tree).standardRole).toBe("Table");
  });

  it("recovers by scanning when the cross-reference offset is wrong", () => {
    const bytes = classicPdf(TREE_OBJECTS);
    const text = new TextDecoder("latin1").decode(bytes).replace(/startxref\n\d+/, "startxref\n9");
    const tree = readDocStructTree(latin1(text));
    expect(tree?.recoveredByScan).toBe(true);
    expect(onlyElement(tree).kids).toHaveLength(2);
  });

  it("keeps page identity for content references on different pages", () => {
    const table = onlyElement(readDocStructTree(classicPdf(TREE_OBJECTS)));
    const cells = table.kids.map((row) => (row.kind === "element" ? row.element.kids[0] : null));
    expect(cells.map((c) => (c?.kind === "element" ? c.element.kids[0] : null))).toEqual([
      { kind: "content", pageIndex: 0, mcid: 0, inXObject: false },
      { kind: "content", pageIndex: 1, mcid: 3, inXObject: false },
    ]);
    const second = cells[1];
    expect(second?.kind === "element" ? second.element.attributes.colSpan : null).toBe(2);
  });

  it("reports a structure cycle instead of recursing", () => {
    const objects = [...TREE_OBJECTS];
    objects[6] = "<< /S /TR /P 6 0 R /K 6 0 R >>";
    const table = onlyElement(readDocStructTree(classicPdf(objects)));
    const row = table.kids[0];
    expect(row.kind === "element" ? row.element.kids : null).toEqual([{ kind: "invalid", reason: "cycle" }]);
  });

  it("returns null for a document without a structure tree", () => {
    expect(readDocStructTree(classicPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 >>"]))).toBeNull();
  });
});

describe("classifyMarkedContent", () => {
  const page = (content: string, fontSubtype = "TrueType") =>
    classicPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Type /Font /Subtype /${fontSubtype} >>`,
    ]);
  const classify = (bytes: Uint8Array) => {
    const reader = new PdfObjectReader(bytes);
    return classifyMarkedContent(reader, reader.dict({ kind: "ref", num: 3, gen: 0 })!);
  };

  it("separates space-only, XObject-only and drawing sequences", () => {
    const kinds = classify(
      page("/Span <</MCID 0>> BDC BT /F1 9 Tf ( ) Tj ET EMC /Figure <</MCID 1>> BDC /Fm1 Do EMC /P <</MCID 2>> BDC BT /F1 9 Tf (A) Tj ET EMC"),
    );
    expect([...kinds]).toEqual([[0, "whitespace"], [1, "xobject"], [2, "drawing"]]);
  });

  it("never proves whitespace for a composite font", () => {
    expect(classify(page("/Span <</MCID 0>> BDC BT /F1 9 Tf ( ) Tj ET EMC", "Type0")).get(0)).toBe("drawing");
  });
});

describe("full-document structure tree on neutral producers", () => {
  const load = async (name: string) => {
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, name)));
    const tree = readDocStructTree(bytes)!;
    const { facts } = await (await createNodePdfiumFactsAdapterV2()).analyze(bytes);
    return { tree, facts, correlation: correlateDocStructTree(tree, facts.pages) };
  };
  const pdfiumUnresolved = (facts: PdfFactsV2) => {
    let n = 0;
    const walk = (node: PdfStructureNodeFactV2) => {
      for (const kid of node.kids) {
        if (kid.kind === "unresolved") n++;
        else if (kid.kind === "element") walk(kid.node);
      }
    };
    facts.pages.forEach((p) => p.structures.forEach(walk));
    return n;
  };
  const rows = (table: DocStructElement): DocStructElement[] =>
    table.kids.flatMap((k) =>
      k.kind !== "element" ? [] : k.element.standardRole === "TR" ? [k.element] : ["THead", "TBody", "TFoot"].includes(k.element.standardRole) ? rows(k.element) : [],
    );
  const cells = (row: DocStructElement) => row.kids.flatMap((k) => (k.kind === "element" ? [k.element] : []));
  const tables = (tree: DocStructTree) => {
    const out: DocStructElement[] = [];
    const walk = (el: DocStructElement) => {
      if (el.standardRole === "Table") out.push(el);
      el.kids.forEach((k) => k.kind === "element" && walk(k.element));
    };
    tree.roots.forEach(walk);
    return out;
  };

  for (const name of [
    "independent-fragmented-tagged.pdf",
    "independent-negative-tagged.pdf",
    "independent-structures-tagged.pdf",
    "producer-browser.pdf",
    "producer-libreoffice.pdf",
    "struct-tree/browser-multipage-table.pdf",
    "struct-tree/browser-hard-table.pdf",
  ]) {
    it(`owns every marked PDFium character exactly once: ${name}`, async () => {
      const { correlation: c } = await load(name);
      expect(c.invalidKids).toBe(0);
      expect(c.unmatchedRefs).toBe(0);
      expect(c.refsWithoutPage).toBe(0);
      expect(c.duplicateRefs).toBe(0);
      expect(c.charsOrphaned).toBe(0);
      expect(c.charsOwned).toBe(c.charsWithMcid);
      expect(c.tables.every((t) => t.complete)).toBe(true);
    });
  }

  it("classifies a figure painted through a form XObject as non-text paint", async () => {
    const { correlation } = await load("independent-structures-tagged.pdf");
    expect(correlation.xobjectPaintRefs).toBe(1);
    expect(correlation.tables.map((t) => [t.rows, t.cells])).toEqual([[3, 6], [1, 2]]);
  });

  it("keeps one logical table across three pages where PDFium's page views cannot", async () => {
    const { tree, facts, correlation } = await load("struct-tree/browser-multipage-table.pdf");
    expect(facts.structureSource).toBe("document-tree");
    expect(pdfiumUnresolved(facts)).toBe(0);
    expect(correlation.tables[0]).toEqual({
      id: correlation.tables[0].id,
      pageIndexes: [0, 1, 2],
      rows: 71,
      headerRows: 1,
      cells: 212,
      emptyCells: 1,
      spannedCells: 0,
      columns: 3,
      shortRows: 1,
      shortRowsPlacedByHeaders: 1,
      complete: true,
    });
    const table = tables(tree)[0];
    const header = cells(rows(table)[0]);
    // The repeated page header is tagged as extra content of the same TH on every page.
    const headerPages = header.map((cell) => [...new Set(elementCharacters(cell, facts.pages).map((c) => c.pageIndex))]);
    expect(headerPages).toEqual([[0, 1, 2], [], [0, 1, 2]]);
    const text = (cell: DocStructElement) => elementCharacters(cell, facts.pages).map(({ pageIndex, index }) => facts.pages[pageIndex].characters[index].value).join("");
    expect(cells(rows(table)[1]).map(text)).toEqual(["Item 1", "Value 1", "Note 1"]);
    // The producer omitted the element for the empty cell; /Headers still places the rest.
    expect(cells(rows(table)[7]).map(text)).toEqual(["Item 7", "Note 7"]);
    expect(cells(rows(table)[7]).map((c) => c.attributes.headers?.length)).toEqual([1, 1]);
  });

  it("resolves row and column spans and nested tables from the tree", async () => {
    const { tree, facts, correlation } = await load("struct-tree/browser-hard-table.pdf");
    expect(facts.structureSource).toBe("document-tree");
    expect(pdfiumUnresolved(facts)).toBe(0);
    expect(correlation.tables.map((t) => [t.pageIndexes, t.rows, t.columns, t.spannedCells, t.shortRows])).toEqual([
      [[0, 1], 46, 3, 2, 0],
      [[1], 1, 2, 0, 0],
    ]);
    const outer = tables(tree)[0];
    const text = (cell: DocStructElement) => elementCharacters(cell, facts.pages).map(({ pageIndex, index }) => facts.pages[pageIndex].characters[index].value).join("");
    const spanning = cells(rows(outer)[20]);
    expect(spanning.map(text)).toEqual(["Spanning group", "Row 20", "漢字 20"]);
    expect(spanning[0].attributes.rowSpan).toBe(6);
    expect(cells(rows(outer)[21]).map(text)).toEqual(["Row 21", "Text 21"]);
    const nestedCell = cells(rows(outer)[30])[1];
    expect(nestedCell.attributes.colSpan).toBe(2);
    expect(nestedCell.kids.some((k) => k.kind === "element" && tables({ pageCount: 0, markedContent: [], recoveredByScan: false, roots: [k.element] }).length === 1)).toBe(true);
  });
});

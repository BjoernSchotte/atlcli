/**
 * Native list numbering tests (spec 006 G2). The pure allocator plus the
 * serializer/exporter integration — real zips, real XML assertions, no mocks.
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { MAX_ILVL, MAX_NUM_INSTANCES, NumberingAllocator } from "./numbering.js";
import { serializeBlocks } from "./serialize.js";
import { exportDocx } from "./export.js";
import { buildDocx, headingStyle, para, readPart, stylesXml } from "./fixtures.js";
import type { ConfluencePageDetails, ExportBlock } from "@atlcli/confluence";

const noStyles = new Map<string, string>();

const list = (ordered: boolean, ...items: ExportBlock[][]): ExportBlock => ({
  type: "list",
  ordered,
  items: items.map((content) => ({ content })),
});
const p = (text: string): ExportBlock => ({ type: "paragraph", content: [{ type: "text", text }] });

const numIdsOf = (xml: string) => [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
const ilvlsOf = (xml: string) => [...xml.matchAll(/<w:ilvl w:val="(\d+)"\/>/g)].map((m) => m[1]);

describe("NumberingAllocator", () => {
  it("shares one numId across bullets, a fresh one per ordered node", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    const b1 = a.acquire(false);
    const b2 = a.acquire(false);
    const o1 = a.acquire(true);
    const o2 = a.acquire(true);
    expect(b1).toBe(b2);
    expect(o1).not.toBe(o2);
    expect(o1).not.toBe(b1);
  });

  it("allocates above the template's existing maxima", () => {
    const a = new NumberingAllocator({ abstractNumId: 5, numId: 9 });
    expect(a.acquire(true)).toBe(10);
    expect(a.acquire(true)).toBe(11);
  });

  it("emits one bullet + one decimal abstractNum, and a num per ordered node with a startOverride", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    a.acquire(false);
    a.acquire(true);
    a.acquire(true);
    const { abstractNums, nums } = a.toXml();
    expect((abstractNums.match(/<w:abstractNum\b/g) ?? []).length).toBe(2);
    expect(abstractNums).toContain('<w:numFmt w:val="bullet"/>');
    expect(abstractNums).toContain('<w:numFmt w:val="decimal"/>');
    // Nine levels per abstractNum.
    expect((abstractNums.match(/<w:lvl w:ilvl=/g) ?? []).length).toBe(18);
    // Two ordered num instances, both restart at 1.
    expect((nums.match(/<w:startOverride w:val="1"\/>/g) ?? []).length).toBe(2);
  });

  it("stops allocating at the 2047-instance cap and flips capExceeded (reuse, not invalid file)", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: MAX_NUM_INSTANCES - 1 });
    const first = a.acquire(true); // 2047
    expect(first).toBe(MAX_NUM_INSTANCES);
    expect(a.capExceeded).toBe(false);
    const reused = a.acquire(true); // over the cap → reuse
    expect(reused).toBe(first);
    expect(a.capExceeded).toBe(true);
  });
});

describe("serializeBlocks — native numbering (spec 006 G2)", () => {
  it("two separate <ol>s both restart at 1 with distinct numIds", async () => {
    const { xml } = await serializeBlocks([list(true, [p("a")]), list(true, [p("b")])], {
      styleNames: noStyles,
    });
    const ids = numIdsOf(xml);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    ["<ul><ol>", false, true],
    ["<ol><ul>", true, false],
  ] as const)("mixed nesting %s gives the nested node its own type-correct numId + ilvl 1", async (_l, outer, inner) => {
    const blocks = [list(outer, [p("top"), list(inner, [p("child")])])];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    const ids = numIdsOf(xml);
    expect(new Set(ids).size).toBe(2); // parent + nested are distinct
    expect(ilvlsOf(xml)).toEqual(expect.arrayContaining(["0", "1"]));
  });

  it("two logically separate nested <ol>s at the same depth each restart with a distinct numId", async () => {
    const blocks = [
      list(false, [p("top"), list(true, [p("x")]), list(true, [p("y")])]),
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    // bullet (shared) + two decimal nodes = 3 numIds, the two decimals distinct.
    const ids = numIdsOf(xml);
    const nested = ids.filter((id) => id !== ids[0]);
    expect(new Set(nested).size).toBe(2);
  });

  it("a list first inside a callout starts at ilvl 0 (unaffected by container depth)", async () => {
    const blocks: ExportBlock[] = [
      { type: "callout", kind: "info", content: [list(false, [p("in callout")])] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(ilvlsOf(xml)).toEqual(["0"]);
  });

  it("a list first inside a table cell starts at ilvl 0", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [{ cells: [{ colspan: 1, rowspan: 1, header: false, content: [list(false, [p("in cell")])] }] }],
      },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(ilvlsOf(xml)).toContain("0");
    expect(ilvlsOf(xml)).not.toContain("1");
  });

  it("clamps ilvl at 8 for 10-level nesting and notes it once", async () => {
    // Build a 10-deep nested list.
    let deep: ExportBlock = list(false, [p("leaf")]);
    for (let i = 0; i < 9; i++) deep = list(false, [p(`l${i}`), deep]);
    const { xml, notes } = await serializeBlocks([deep], { styleNames: noStyles });
    const ilvls = ilvlsOf(xml).map(Number);
    expect(Math.max(...ilvls)).toBe(MAX_ILVL);
    expect(notes.filter((n) => n.code === "list-nesting-clamped")).toHaveLength(1);
  });

  it("task-list items keep the ☑/☐ glyph and a list style, no numPr", async () => {
    const blocks: ExportBlock[] = [
      { type: "list", ordered: false, items: [{ content: [p("do")], checked: false }, { content: [p("done")], checked: true }] },
    ];
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles });
    expect(xml).toContain("☐");
    expect(xml).toContain("☑");
    expect(xml).not.toContain("<w:numPr>");
    expect(xml).toContain('<w:pStyle w:val="ListParagraph"/>');
  });

  it.each([
    [0, false, "SLB0"],
    [1, false, "SLB2"],
    [7, false, "SLB8"],
    [0, true, "SLN0"],
    [1, true, "SLN2"],
  ] as const)("maps ilvl %i (ordered=%s) to the asymmetric Scroll style id", async (ilvl, ordered, expectedId) => {
    const styleNames = new Map<string, string>([
      ["scroll list bullet", "SLB0"],
      ["scroll list bullet 2", "SLB2"],
      ["scroll list bullet 8", "SLB8"],
      ["scroll list number", "SLN0"],
      ["scroll list number 2", "SLN2"],
    ]);
    // Build a list nested to the target ilvl.
    let node: ExportBlock = list(ordered, [p("x")]);
    for (let i = 0; i < ilvl; i++) node = list(ordered, [p(`w${i}`), node]);
    const { xml } = await serializeBlocks([node], { styleNames });
    expect(xml).toContain(`<w:pStyle w:val="${expectedId}"/>`);
  });
});

describe("exportDocx — numbering part (spec 006 G2)", () => {
  const details = (storage: string): ConfluencePageDetails => ({
    id: "1",
    title: "Lists",
    url: "u",
    version: 1,
    spaceKey: "DOCSY",
    storage,
    tinyUrl: "t",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    createdBy: { displayName: "A" },
    modifiedBy: { displayName: "B" },
    labels: [],
  });
  const template = { name: "t.docx", modificationDate: new Date(2026, 0, 1) };
  const deps = {
    getSpace: async () => ({ id: "s", key: "DOCSY", name: "S", type: "global" as const }),
    getCurrentUser: async () => ({ accountId: "u", displayName: "U" }),
    getPageOwner: async () => ({ accountId: "o", displayName: "O" }),
  };
  const listTemplate = () =>
    buildDocx({ body: para("$scroll.content"), styles: stylesXml(headingStyle("Heading1", "Heading 1")) });

  it("writes word/numbering.xml with a content-type override + relationship", async () => {
    const { bytes } = await exportDocx({
      templateBytes: listTemplate(),
      details: details("<ol><li><p>one</p></li></ol>"),
      template,
      deps,
    });
    const zip = new PizZip(bytes);
    expect(zip.file("word/numbering.xml")).not.toBeNull();
    expect(readPart(bytes, "word/document.xml")).toContain("<w:numPr>");
    expect(readPart(bytes, "[Content_Types].xml")).toContain("word/numbering.xml");
    expect(readPart(bytes, "word/_rels/document.xml.rels")).toContain("relationships/numbering");
  });

  it("does not write numbering.xml for a list-free page", async () => {
    const { bytes } = await exportDocx({
      templateBytes: listTemplate(),
      details: details("<p>no lists here</p>"),
      template,
      deps,
    });
    expect(new PizZip(bytes).file("word/numbering.xml")).toBeNull();
  });

  it("merges above an existing numbering part's ids (via inspectNumberingPart)", async () => {
    const existingNumbering =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>` +
      `</w:numbering>`;
    const zip = new PizZip(listTemplate());
    zip.file("word/numbering.xml", existingNumbering);
    const withNumbering = zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
    const { bytes } = await exportDocx({
      templateBytes: withNumbering,
      details: details("<ol><li><p>one</p></li></ol>"),
      template,
      deps,
    });
    const numbering = readPart(bytes, "word/numbering.xml");
    // Our decimal num id is allocated above the existing max numId (4).
    const doc = readPart(bytes, "word/document.xml");
    const usedNumId = Number(doc.match(/<w:numId w:val="(\d+)"\/>/)![1]);
    expect(usedNumId).toBeGreaterThan(4);
    // The existing instance survives; the new one was merged in.
    expect(numbering).toContain('w:numId="4"');
    expect(numbering).toContain(`w:numId="${usedNumId}"`);
    // abstractNums precede the first num (schema order).
    expect(numbering.indexOf("<w:abstractNum")).toBeLessThan(numbering.indexOf("<w:num "));
  });
});

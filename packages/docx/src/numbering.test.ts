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
const orderedFrom = (start: number, ...items: ExportBlock[][]): ExportBlock => ({
  type: "list",
  ordered: true,
  start,
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

  it("emits one bullet abstract plus one self-contained abstract/num per ordered node", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    a.acquire(false);
    a.acquire(true);
    a.acquire(true);
    const { abstractNums, nums } = a.toXml();
    expect((abstractNums.match(/<w:abstractNum\b/g) ?? []).length).toBe(3);
    expect(abstractNums).toContain('<w:numFmt w:val="bullet"/>');
    expect(abstractNums).toContain('<w:numFmt w:val="decimal"/>');
    // Nine shared bullet levels plus one level for each ordered node.
    expect((abstractNums.match(/<w:lvl w:ilvl=/g) ?? []).length).toBe(11);
    expect((abstractNums.match(/<w:multiLevelType w:val="singleLevel"\/>/g) ?? []).length).toBe(2);
    expect((abstractNums.match(/<w:start w:val="1"\/>/g) ?? []).length).toBe(11);
    expect(nums).not.toContain("<w:lvlOverride");
    expect((nums.match(/<w:num w:numId=/g) ?? []).length).toBe(3);
  });

  it("binds each ordered start and visual nesting to its own single-level definition", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    a.acquire(true, 4, 0);
    a.acquire(true, 7, 2);
    const { abstractNums, nums } = a.toXml();
    expect(abstractNums).toContain(
      '<w:start w:val="4"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListParagraph"/><w:lvlText w:val="%1."/>',
    );
    expect(abstractNums).toContain(
      '<w:start w:val="7"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListParagraph"/><w:lvlText w:val="%1."/>',
    );
    expect(abstractNums).toContain('<w:ind w:left="720" w:hanging="360"/>');
    expect(abstractNums).toContain('<w:ind w:left="2160" w:hanging="360"/>');
    expect(nums).toContain('<w:num w:numId="1"><w:abstractNumId w:val="2"/></w:num>');
    expect(nums).toContain('<w:num w:numId="2"><w:abstractNumId w:val="3"/></w:num>');
  });

  it("preserves the schema-defined zero start in native numbering", () => {
    const a = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    a.acquire(true, 0, 0);
    expect(a.toXml().abstractNums).toContain('<w:start w:val="0"/><w:numFmt w:val="decimal"/>');
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
  ] as const)("mixed nesting %s gives the nested node its own type-correct numId", async (_l, outer, inner) => {
    const blocks = [list(outer, [p("top"), list(inner, [p("child")])])];
    const numbering = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    const { xml } = await serializeBlocks(blocks, { styleNames: noStyles, numbering });
    const ids = numIdsOf(xml);
    expect(new Set(ids).size).toBe(2); // parent + nested are distinct
    if (inner) {
      expect(ilvlsOf(xml)).toEqual(["0", "0"]);
      expect(numbering.toXml().abstractNums).toContain('<w:ind w:left="1440" w:hanging="360"/>');
    } else {
      expect(ilvlsOf(xml)).toEqual(expect.arrayContaining(["0", "1"]));
    }
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

  it("preserves independent top-level and nested ordered-list starts", async () => {
    const numbering = new NumberingAllocator({ abstractNumId: 0, numId: 0 });
    await serializeBlocks(
      [orderedFrom(3, [p("outer"), orderedFrom(8, [p("inner")])])],
      { styleNames: noStyles, numbering },
    );
    const { abstractNums, nums } = numbering.toXml();
    expect(abstractNums).toContain(
      '<w:start w:val="3"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListParagraph"/><w:lvlText w:val="%1."/>',
    );
    expect(abstractNums).toContain(
      '<w:start w:val="8"/><w:numFmt w:val="decimal"/><w:pStyle w:val="ListParagraph"/><w:lvlText w:val="%1."/>',
    );
    expect(abstractNums).toContain('<w:ind w:left="720" w:hanging="360"/>');
    expect(abstractNums).toContain('<w:ind w:left="1440" w:hanging="360"/>');
    expect(nums).toContain('<w:num w:numId="1"><w:abstractNumId w:val="2"/></w:num>');
    expect(nums).toContain('<w:num w:numId="2"><w:abstractNumId w:val="3"/></w:num>');
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

  // Full 9-level (ilvl 0-8) × {bullet, number} style-chain. The Scroll convention
  // is asymmetric AND capped at "…8": level 1 (ilvl 0) is suffixless, levels 2-8
  // (ilvl 1-7) carry suffix 2..8, and ilvl 8 (a 9th level Word allows but Scroll
  // does not name) reuses the level-8 style. Names are keyed 0..7; the expected
  // id clamps ilvl to 7.
  const SCROLL_STYLES = new Map<string, string>();
  for (const kind of ["bullet", "number"] as const) {
    for (let level = 0; level <= 7; level++) {
      const suffix = level === 0 ? "" : ` ${level + 1}`;
      SCROLL_STYLES.set(`scroll list ${kind}${suffix}`, `S-${kind}-${level}`);
    }
  }
  const expectedScrollId = (kind: "bullet" | "number", ilvl: number): string =>
    `S-${kind}-${Math.min(ilvl, 7)}`;
  const nineLevels = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
  it.each(
    nineLevels.flatMap((ilvl) => [
      [ilvl, false, expectedScrollId("bullet", ilvl)],
      [ilvl, true, expectedScrollId("number", ilvl)],
    ])
  )(
    "maps ilvl %i (ordered=%s) to the asymmetric Scroll style id %s",
    async (ilvl, ordered, expectedId) => {
      let node: ExportBlock = list(ordered as boolean, [p("x")]);
      for (let i = 0; i < (ilvl as number); i++) node = list(ordered as boolean, [p(`w${i}`), node]);
      const { xml } = await serializeBlocks([node], { styleNames: SCROLL_STYLES });
      expect(xml).toContain(`<w:pStyle w:val="${expectedId}"/>`);
    }
  );

  it("falls back to ListParagraph at every level when no Scroll/builtin list styles are defined", async () => {
    let node: ExportBlock = list(true, [p("leaf")]);
    for (let i = 0; i < 8; i++) node = list(true, [p(`w${i}`), node]);
    const { xml } = await serializeBlocks([node], { styleNames: noStyles });
    // Every emitted list paragraph uses ListParagraph (no Scroll/builtin match).
    const pStyles = [...xml.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(pStyles.length).toBeGreaterThanOrEqual(9);
    expect(new Set(pStyles)).toEqual(new Set(["ListParagraph"]));
  });

  it("prefers the builtin List Number/List Bullet name over ListParagraph when present", async () => {
    const styleNames = new Map<string, string>([["list number", "BuiltinLN"]]);
    const { xml } = await serializeBlocks([list(true, [p("x")])], { styleNames });
    expect(xml).toContain('<w:pStyle w:val="BuiltinLN"/>');
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

  /** A list template whose word/numbering.xml already occupies numId `maxNumId`. */
  const templateWithNumbering = (maxNumId: number): Uint8Array => {
    const existing =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="${maxNumId}"><w:abstractNumId w:val="0"/></w:num>` +
      `</w:numbering>`;
    const zip = new PizZip(listTemplate());
    zip.file("word/numbering.xml", existing);
    return zip.generate({ type: "uint8array", compression: "DEFLATE" }) as unknown as Uint8Array;
  };

  it("a near-2047-id template stays collision-free up to the cap, then degrades with a note", async () => {
    // Existing max numId 2046 → our first ordered node gets 2047 (the cap), the
    // second exceeds it and reuses, flagging numbering-cap-reached.
    const { bytes, report } = await exportDocx({
      templateBytes: templateWithNumbering(2046),
      details: details("<ol><li><p>a</p></li></ol><ol><li><p>b</p></li></ol>"),
      template,
      deps,
    });
    const doc = readPart(bytes, "word/document.xml");
    const ids = [...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => Number(m[1]));
    // First ordered node references 2047; none exceed Word's cap.
    expect(ids).toContain(2047);
    expect(Math.max(...ids)).toBeLessThanOrEqual(2047);
    expect(report.notes.some((n) => n.code === "numbering-cap-reached")).toBe(true);
    // The file is still valid: numbering.xml exists and every referenced numId
    // has a matching <w:num> instance.
    const numbering = readPart(bytes, "word/numbering.xml");
    for (const id of new Set(ids)) expect(numbering).toContain(`<w:num w:numId="${id}"`);
  });

  it("a fully-occupied id space (max numId 2047) degrades on the first list without an invalid file", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: templateWithNumbering(2047),
      details: details("<ol><li><p>only</p></li></ol>"),
      template,
      deps,
    });
    expect(report.notes.some((n) => n.code === "numbering-cap-reached")).toBe(true);
    const doc = readPart(bytes, "word/document.xml");
    const ids = [...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    // Every referenced numId still resolves to a defined <w:num> (no dangling ref).
    const numbering = readPart(bytes, "word/numbering.xml");
    for (const id of new Set(ids)) expect(numbering).toContain(`<w:num w:numId="${id}"`);
  });
});

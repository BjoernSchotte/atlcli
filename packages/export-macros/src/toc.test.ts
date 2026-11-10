import { describe, expect, test } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { tocFromHeadings, tocRenderer, slugifyHeading } from "./toc.js";
import type { MacroExportContext } from "./types.js";

function h(level: 1 | 2 | 3 | 4 | 5 | 6, text: string): ExportBlock {
  return { type: "heading", level, content: [{ type: "text", text }] };
}

function ctx(documentBlocks: ExportBlock[]): MacroExportContext {
  return { page: { id: "1" }, depth: 0, visited: new Set(), documentBlocks };
}

describe("tocFromHeadings", () => {
  test("filters by heading level range", () => {
    const blocks = [h(1, "One"), h(2, "Two"), h(3, "Three")];
    const out = tocFromHeadings(blocks, { minLevel: 2, maxLevel: 2 });
    const list = out[0] as Extract<ExportBlock, { type: "list" }>;
    expect(list.items.length).toBe(1);
  });

  test("empty document → empty output", () => {
    expect(tocFromHeadings([], {})).toEqual([]);
    expect(tocFromHeadings([{ type: "paragraph", content: [] }], {})).toEqual([]);
  });

  test("nests deeper headings under shallower ones", () => {
    const out = tocFromHeadings([h(1, "Parent"), h(2, "Child")], {});
    const list = out[0] as Extract<ExportBlock, { type: "list" }>;
    expect(list.items.length).toBe(1);
    // parent item carries a nested list with the child
    const nested = list.items[0].content.find((b) => b.type === "list") as
      | Extract<ExportBlock, { type: "list" }>
      | undefined;
    expect(nested?.items.length).toBe(1);
  });

  const links = (blocks: ExportBlock[]): string => JSON.stringify(blocks);

  test("single-page DOCX/PDF: links by heading text, the anchor both engines resolve", () => {
    const out = tocFromHeadings([h(1, "Über Größe!")], {});
    expect(links(out)).toContain('"target":{"kind":"anchor","anchor":"Über Größe!"}');
  });

  test("a repeated anchor-less heading is listed but not linked to its namesake", () => {
    const out = tocFromHeadings([h(1, "Example"), h(1, "Example")], {});
    const list = out[0] as Extract<ExportBlock, { type: "list" }>;
    const first = (item: (typeof list.items)[number]) =>
      (item.content[0] as Extract<ExportBlock, { type: "paragraph" }>).content[0];
    expect(first(list.items[0]).type).toBe("link");
    expect(first(list.items[1])).toEqual({ type: "text", text: "Example" });
  });

  test("composed and web documents keep their own anchors", () => {
    const composed: ExportBlock = { ...h(1, "One"), explicitAnchor: "p1-one" } as ExportBlock;
    expect(links(tocFromHeadings([composed], {}))).toContain('"anchor":"p1-one"');
    expect(links(tocFromHeadings([h(1, "Über Größe!")], { target: "web" }))).toContain('"anchor":"uber-grosse"');
  });

  test("an unresolved mention never prints its account id", () => {
    const heading: ExportBlock = {
      type: "heading",
      level: 1,
      content: [{ type: "text", text: "Owner " }, { type: "mention", accountId: "acc-123" }],
    };
    const text = links(tocFromHeadings([heading], {}));
    expect(text).not.toContain("acc-123");
    expect(text).toContain("Owner @Unknown user");
  });

  test("slug is stable and ASCII-safe", () => {
    expect(slugifyHeading("Über Größe!")).toBe("uber-grosse");
    expect(slugifyHeading("")).toBe("anchor");
  });
});

describe("tocRenderer", () => {
  test("renders in-document headings", async () => {
    const r = tocRenderer();
    expect(r.requiresLivePort).toBe(false);
    const res = await r.render({ name: "toc", params: [] }, ctx([h(1, "Intro"), h(2, "Details")]));
    expect(res.kind).toBe("blocks");
  });

  test("empty heading set → skip", async () => {
    const res = await tocRenderer().render({ name: "toc", params: [] }, ctx([{ type: "paragraph", content: [] }]));
    expect(res.kind).toBe("skip");
  });

  test("native TOC present → suppressed with note", async () => {
    const c: MacroExportContext = { ...ctx([h(1, "X")]), flags: { nativeTocPresent: true } };
    const res = await tocRenderer().render({ name: "toc", params: [] }, c);
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      expect(res.blocks).toEqual([]);
      expect(res.notes?.[0].code).toBe("macro-skipped-by-config");
    }
  });
});

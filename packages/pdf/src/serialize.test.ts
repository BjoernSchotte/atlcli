import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";

const metadata = {
  title: "PDF # Guide",
  space: "DOCSY",
  version: 7,
  author: "Ada",
  exporter: "Grace",
  language: "en",
  exportedAt: new Date("2026-07-16T12:00:00Z"),
};

describe("PDF preparation and serialization", () => {
  it("promotes headings and serializes every common semantic block", async () => {
    const blocks: ExportBlock[] = [
      { type: "heading", level: 2, content: [{ type: "text", text: "Overview" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Hello ", marks: ["bold"] },
          { type: "status", text: "DONE", color: "#00875A" },
          { type: "lineBreak" },
          { type: "mention", accountId: "a1", displayName: "Ada" },
        ],
      },
      { type: "callout", kind: "info", title: "Note", content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] },
      { type: "list", ordered: false, items: [{ checked: true, content: [{ type: "paragraph", content: [{ type: "text", text: "Task" }] }] }] },
      { type: "table", rows: [{ cells: [{ header: true, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }] }] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
      { type: "divider" },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => {
        throw new Error("unused");
      },
    });
    const bundle = serializePdfDocument(prepared, { metadata });

    expect(bundle.main).toContain("#heading(level: 1");
    expect(bundle.main).toContain('#status-badge("DONE"');
    expect(bundle.main).toContain('#callout(kind: "info"');
    expect(bundle.main).toContain("#list(");
    expect(bundle.main).toContain("table.header(");
    expect(bundle.main).toContain("#quote(block: true)");
    expect(bundle.main).toContain("#line(length: 100%");
    expect(bundle.sourceMap.length).toBeGreaterThanOrEqual(blocks.length);
  });

  it("deduplicates image bytes and reports missing alt text", async () => {
    const blocks: ExportBlock[] = [
      { type: "image", source: { kind: "attachment", filename: "same.png" } },
      { type: "image", source: { kind: "attachment", filename: "same.png" } },
    ];
    const prepared = await preparePdfDocument(blocks, {
      resolve: async () => ({
        bytes: new Uint8Array([137, 80, 78, 71]),
        mediaType: "image/png",
        filename: "same.png",
      }),
    });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.notes.filter((note) => note.code === "pdf-image-alt-fallback")).toHaveLength(2);
  });

  it("renders unsafe links as text and reports them", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "paragraph",
        content: [{ type: "link", target: { kind: "external", href: "javascript:alert(1)" }, content: [{ type: "text", text: "Nope" }] }],
      },
    ];
    const prepared = await preparePdfDocument(blocks, { resolve: async () => { throw new Error("unused"); } });
    const bundle = serializePdfDocument(prepared, { metadata });
    expect(bundle.main).toContain("Nope");
    expect(bundle.main).not.toContain("javascript:");
    expect(bundle.notes.some((note) => note.code === "pdf-link-unresolved")).toBe(true);
  });
});

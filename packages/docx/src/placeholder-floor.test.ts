/**
 * spec 004 stage-4 placeholder floor (DOCX): an unresolved macro renders the
 * placeholder line PLUS its preserved body/plainBody, never silently dropping
 * content.
 */
import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { serializeBlocks } from "./serialize.js";

async function xml(blocks: ExportBlock[]): Promise<string> {
  const { xml } = await serializeBlocks(blocks, { styleNames: new Map() });
  return xml;
}

describe("DOCX placeholder floor", () => {
  it("renders a table inside an unresolved macro body", async () => {
    const out = await xml([
      {
        type: "unknown",
        macroName: "acme",
        body: [
          {
            type: "table",
            rows: [{ cells: [{ header: false, colspan: 1, rowspan: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "CELL" }] }] }] }],
          },
        ],
      },
    ]);
    expect(out).toContain("macro not rendered");
    expect(out).toContain("CELL");
    expect(out).toContain("<w:tbl>");
  });

  it("renders a list inside an unresolved macro body", async () => {
    const out = await xml([
      {
        type: "unknown",
        macroName: "acme",
        body: [{ type: "list", ordered: false, items: [{ content: [{ type: "paragraph", content: [{ type: "text", text: "ITEM" }] }] }] }],
      },
    ]);
    expect(out).toContain("ITEM");
  });

  it("renders a nested unknown macro inside body", async () => {
    const out = await xml([
      {
        type: "unknown",
        macroName: "outer",
        body: [{ type: "unknown", macroName: "inner", plainBody: "INNERTEXT" }],
      },
    ]);
    expect(out).toContain("INNERTEXT");
  });

  it("caps a very large plainBody with a note", async () => {
    const { notes } = await serializeBlocks(
      [{ type: "unknown", macroName: "acme", plainBody: "x".repeat(30000) }],
      { styleNames: new Map() }
    );
    expect(notes.some((n) => n.code === "macro-body-truncated")).toBe(true);
  });
});

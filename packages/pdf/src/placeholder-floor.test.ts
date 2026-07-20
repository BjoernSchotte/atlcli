/**
 * spec 004 stage-4 placeholder floor (PDF): an unresolved macro renders the
 * placeholder line PLUS its preserved body/plainBody instead of being omitted
 * with only a report note.
 */
import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";

const metadata = { title: "T", exportedAt: new Date("2026-07-16T12:00:00Z") };
const noAssets = { resolve: async () => { throw new Error("unused"); } };

async function render(blocks: ExportBlock[]): Promise<{ main: string; notes: { code: string }[] }> {
  const prepared = await preparePdfDocument(blocks, noAssets);
  const bundle = serializePdfDocument(prepared, { metadata });
  return { main: bundle.main, notes: bundle.notes };
}

describe("PDF placeholder floor", () => {
  it("renders a table inside an unresolved macro body", async () => {
    const { main } = await render([
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
    expect(main).toContain("macro not rendered");
    expect(main).toContain("CELL");
    expect(main).toContain("#table(");
  });

  it("renders plainBody as a code block", async () => {
    const { main } = await render([{ type: "unknown", macroName: "acme", plainBody: "SNIPPET" }]);
    expect(main).toContain("SNIPPET");
  });

  it("renders a nested unknown macro inside body", async () => {
    const { main } = await render([
      { type: "unknown", macroName: "outer", body: [{ type: "unknown", macroName: "inner", plainBody: "INNER" }] },
    ]);
    expect(main).toContain("INNER");
  });

  it("caps a very large plainBody with a note", async () => {
    const { notes } = await render([{ type: "unknown", macroName: "acme", plainBody: "x".repeat(30000) }]);
    expect(notes.some((n) => n.code === "macro-body-truncated")).toBe(true);
  });
});

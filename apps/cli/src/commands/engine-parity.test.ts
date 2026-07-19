import { describe, expect, it } from "bun:test";
import { storageToBlocks, type ExportBlock } from "@atlcli/confluence";

/**
 * python→ts engine parity checklist (spec 008 T3.5). Scope is measurement + the
 * migration path — the default-engine flip is its own later PR.
 *
 * Both engines consume the SAME `ExportBlock[]` contract from `storageToBlocks`;
 * this test pins the observable-feature matrix that contract must carry, so a
 * regression in the shared source model (which would silently diverge both
 * engines) is caught offline without Python, a template, or the network.
 *
 * The full dual-engine RENDER comparison (same fixture pages through the python
 * subprocess and the ts engine, diffing produced DOCX features) needs Python +
 * a template + a live page and is gated behind `ATLCLI_PARITY=1`; the
 * orchestrator runs it. Intentional, documented differences (NOT parity gaps):
 *   - Templates: ts uses Scroll placeholders ($scroll.title); python uses Jinja2.
 *   - SVG images: python may embed; ts embeds PNG/JPEG/GIF (SVG pending).
 *   - `--include-children` merge: python legacy behavior; ts uses `--scope tree`.
 *   - List numbering: native numbering parity depends on T1.13 (tracked).
 */

const FIXTURE_STORAGE = `
<h1>Title</h1>
<p>Intro with a <a href="https://example.com">link</a> and <strong>bold</strong>.</p>
<h2>Section</h2>
<ul><li>first</li><li>second</li></ul>
<ol><li>one</li><li>two</li></ol>
<table><tbody>
  <tr><th>Col A</th><th>Col B</th></tr>
  <tr><td>1</td><td>2</td></tr>
</tbody></table>
<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>
`;

function collectTypes(blocks: ExportBlock[]): Set<string> {
  const types = new Set<string>();
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      types.add(block.type);
      switch (block.type) {
        case "callout":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return types;
}

describe("engine parity checklist — shared block model (spec 008 T3.5)", () => {
  it("carries every observable feature both engines must render", () => {
    const { blocks } = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" });
    const types = collectTypes(blocks);
    for (const feature of ["heading", "paragraph", "list", "table", "image", "codeBlock"]) {
      expect(types.has(feature)).toBe(true);
    }
    // Ordered + unordered lists both present.
    const lists = blocks.filter((b): b is Extract<ExportBlock, { type: "list" }> => b.type === "list");
    expect(lists.some((l) => l.ordered)).toBe(true);
    expect(lists.some((l) => !l.ordered)).toBe(true);
    // Heading levels preserved (h1 → level 1, h2 → level 2).
    const headings = blocks.filter((b): b is Extract<ExportBlock, { type: "heading" }> => b.type === "heading");
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
  });

  it("is deterministic — the same storage yields identical blocks across runs", () => {
    const a = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" }).blocks;
    const b = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" }).blocks;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

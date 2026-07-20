import { describe, expect, it } from "bun:test";
import { storageToBlocks, type ExportBlock } from "@atlcli/confluence";

/**
 * python→ts engine parity checklist (spec 008 T3.5). Scope is measurement + the
 * migration path — the default-engine flip is its own later PR. Two layers:
 *
 * 1. OFFLINE (always runs): both engines consume the SAME `ExportBlock[]`
 *    contract from `storageToBlocks`; the tests below pin the
 *    observable-feature matrix that contract must carry, so a regression in the
 *    shared source model (which would silently diverge both engines) is caught
 *    without Python, a template, or the network.
 * 2. LIVE dual-engine render diff (gated `ATLCLI_PARITY=1`, second describe
 *    below): exports the SAME page through `--engine python` and `--engine ts`
 *    and diffs observable DOCX features (tables, heading texts) from the two
 *    produced documents. Needs Python + a template + a live DOCSY page — the
 *    orchestrator runs it.
 *
 * Intentional, documented differences (NOT parity gaps):
 *   - Templates: ts uses Scroll placeholders ($scroll.title); python uses Jinja2.
 *   - SVG images: python may embed; ts embeds PNG/JPEG/GIF (SVG pending) — image
 *     counts are therefore NOT diffed below.
 *   - `--include-children` merge: python legacy behavior; ts uses `--scope tree`.
 *   - List numbering: native numbering parity depends on T1.13 (tracked) —
 *     numbering XML is not diffed below.
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

/**
 * LIVE dual-engine render diff (layer 2). GATED: needs Python (`packages/
 * export` venv or system install), a Scroll-style template, a configured
 * profile, and a live page — which per the project's hard E2E rule MUST live in
 * space DOCSY. Env: ATLCLI_PARITY=1, ATLCLI_PARITY_PAGE_ID (DOCSY page id),
 * ATLCLI_PARITY_TEMPLATE (template path usable by BOTH engines),
 * ATLCLI_PARITY_PROFILE (default "mayflower").
 */
const PARITY = process.env.ATLCLI_PARITY === "1";

describe.skipIf(!PARITY)("dual-engine render diff (live, DOCSY)", () => {
  it("python and ts render the same tables and heading texts from one page", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { unzipDocx } = await import("@atlcli/docx/scan");

    const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
    const pageId = process.env.ATLCLI_PARITY_PAGE_ID!;
    const template = process.env.ATLCLI_PARITY_TEMPLATE!;
    const profile = process.env.ATLCLI_PARITY_PROFILE ?? "mayflower";
    expect(pageId).toBeTruthy();
    expect(template).toBeTruthy();

    const dir = await mkdtemp(join(tmpdir(), "atlcli-parity-"));
    try {
      const outputs: Record<string, string> = {
        python: join(dir, "python.docx"),
        ts: join(dir, "ts.docx"),
      };
      for (const [engine, out] of Object.entries(outputs)) {
        const proc = Bun.spawn(
          ["bun", "--conditions=development", "run", cli, "wiki", "export", pageId, "--profile", profile, "--engine", engine, "--template", template, "-o", out, "--json"],
          { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLCLI_SUPPRESS_ENGINE_NOTICE: "1" } }
        );
        expect(await proc.exited).toBe(0);
      }

      const documentXml = async (path: string): Promise<string> => {
        const zip = unzipDocx(new Uint8Array(await readFile(path)));
        return zip.file("word/document.xml")?.asText() ?? "";
      };
      const [pythonXml, tsXml] = await Promise.all([
        documentXml(outputs.python),
        documentXml(outputs.ts),
      ]);

      // Observable-feature diff. Image counts and numbering XML deliberately
      // excluded (documented intentional differences above).
      const tableCount = (xml: string): number => (xml.match(/<w:tbl[ >]/g) ?? []).length;
      expect(tableCount(tsXml)).toBe(tableCount(pythonXml));

      const headingTexts = (xml: string): string[] =>
        [...xml.matchAll(/<w:p\b[^>]*>(?:(?!<\/w:p>).)*?w:val="Heading[1-6]"(?:(?!<\/w:p>).)*?<\/w:p>/gs)]
          .map((match) => [...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("").trim())
          .filter(Boolean);
      expect(new Set(headingTexts(tsXml))).toEqual(new Set(headingTexts(pythonXml)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

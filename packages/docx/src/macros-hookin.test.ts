/**
 * spec 004 engine hook-in (DOCX): the optional `macros` field resolves dynamic
 * macros on BOTH entry points — `exportDocx(input)` directly and `runExport`
 * with `macros` on the env — and omitting it reproduces today's output.
 */
import { describe, expect, it } from "bun:test";
import { createRegistry, type MacroResolutionOptions, type MacroRenderer } from "@atlcli/export-macros";
import { exportDocx } from "./export.js";
import { runExport } from "./env.js";
import { buildDocx, para } from "./fixtures.js";

const TEMPLATE = buildDocx({ body: para("$scroll.content") });
const STORAGE = `<p>Before</p><ac:structured-macro ac:name="acme-widget" ac:macro-id="m1"/><p>After</p>`;
const WALKER_CODES = ["unknown-macro", "macro-not-rendered"];
const hasWalkerNote = (notes: { code: string }[]) => notes.some((n) => WALKER_CODES.includes(n.code));

function widgetRenderer(): MacroRenderer {
  return {
    id: "widget",
    macros: ["acme-widget"],
    requiresLivePort: false,
    async render() {
      return {
        kind: "blocks",
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "RENDERED-WIDGET" }] }],
      };
    },
  };
}

function macroOptions(): MacroResolutionOptions {
  return {
    registry: createRegistry([widgetRenderer()]),
    contextFor: (page) => ({ page, depth: 0, visited: new Set() }),
  };
}

const details = { id: "1", title: "Root", storage: STORAGE, spaceKey: "DOC" };
const template = { name: "t.docx", modificationDate: new Date(0) };

describe("DOCX macro hook-in", () => {
  it("resolves macros when set on ExportInput (direct exportDocx call)", async () => {
    const { report } = await exportDocx({
      templateBytes: TEMPLATE,
      details,
      template,
      macros: macroOptions(),
    });
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(true);
    expect(hasWalkerNote(report.notes)).toBe(false);
  });

  it("resolves macros identically when set on ExportEnv (runExport)", async () => {
    let bytes: Uint8Array | undefined;
    const report = await runExport(
      { details, template },
      {
        templates: { getBytes: async () => TEMPLATE },
        output: { emit: async (_n, b) => void (bytes = b) },
        macros: macroOptions(),
      }
    );
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(true);
    expect(bytes && bytes.length > 0).toBe(true);
  });

  it("omitting macros reproduces today's placeholder behavior", async () => {
    const { report } = await exportDocx({ templateBytes: TEMPLATE, details, template });
    expect(hasWalkerNote(report.notes)).toBe(true);
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(false);
  });
});

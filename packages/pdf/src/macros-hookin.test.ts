/**
 * spec 004 engine hook-in (PDF): the optional `env.macros` field resolves
 * dynamic macros during the preparing phase; omitting it reproduces today's
 * output (notes unchanged, additive).
 */
import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { createRegistry, type MacroResolutionOptions, type MacroRenderer } from "@atlcli/export-macros";
import { runPdfExport } from "./run-export.js";

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);
const metadata = { title: "Test", exportedAt: new Date("2026-07-17T00:00:00Z") };
const assets = { resolve: async () => { throw new Error("no assets"); } };
const compiler = {
  compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }),
};

const blocks: ExportBlock[] = [
  { type: "unknown", macroName: "acme-widget", macroId: "m1" },
];
const sourceNotes = [
  { level: "warning" as const, code: "unknown-macro", message: "placeholder", macroName: "acme-widget" },
];

function widgetRenderer(): MacroRenderer {
  return {
    id: "widget",
    macros: ["acme-widget"],
    requiresLivePort: false,
    async render() {
      return { kind: "blocks", blocks: [{ type: "paragraph", content: [{ type: "text", text: "R" }] }] };
    },
  };
}

function macroOptions(): MacroResolutionOptions {
  return {
    registry: createRegistry([widgetRenderer()]),
    contextFor: (page) => ({ page, depth: 0, visited: new Set() }),
  };
}

describe("PDF macro hook-in", () => {
  it("resolves macros when env.macros is set", async () => {
    const report = await runPdfExport(
      { blocks, metadata, filename: "T.pdf", sourceNotes, page: { id: "1", spaceKey: "DOC" } },
      { assets, compiler, output: { emit: async () => {} }, macros: macroOptions() }
    );
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(true);
    expect(report.notes.some((n) => n.code === "unknown-macro")).toBe(false);
  });

  it("omitting env.macros leaves the walker note untouched", async () => {
    const report = await runPdfExport(
      { blocks, metadata, filename: "T.pdf", sourceNotes },
      { assets, compiler, output: { emit: async () => {} } }
    );
    expect(report.notes.some((n) => n.code === "unknown-macro")).toBe(true);
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(false);
  });
});

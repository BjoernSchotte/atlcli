import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { PdfExportError, runPdfExport, type PdfExportPhase } from "./run-export.js";

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);
const blocks: ExportBlock[] = [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }];
const metadata = { title: "Test", exportedAt: new Date("2026-07-17T00:00:00Z") };
const assets = { resolve: async () => { throw new Error("no assets"); } };

describe("neutral runPdfExport", () => {
  it("orchestrates phases, preserves theme/profile and emits bytes", async () => {
    const phases: PdfExportPhase[] = [];
    let template = "";
    let emitted = 0;
    const report = await runPdfExport({
      blocks,
      metadata,
      filename: "Test.pdf",
      profile: "pdf-ua-1",
      theme: { colors: { paper: "#FFFDF5" } },
      sourceNotes: [{ level: "info", code: "source", message: "source note" }],
      onPhase: (phase) => phases.push(phase),
    }, {
      assets,
      compiler: { compile: async (bundle) => {
        template = bundle.template;
        return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
      } },
      output: { emit: async () => { emitted += 1; } },
    });
    expect(template).toContain('let cover-paper = rgb("#FFFDF5")');
    expect(report.profile).toBe("pdf-ua-1");
    expect(report.notes[0]?.code).toBe("source");
    expect(phases).toEqual(["preparing", "fetching", "compiling", "validating", "emitting"]);
    expect(emitted).toBe(1);
  });

  it("preserves structured compiler diagnostics and emits nothing", async () => {
    let emitted = 0;
    const diagnostic = { severity: "error" as const, message: "bad", blockPath: "blocks[0]" };
    try {
      await runPdfExport({ blocks, metadata, filename: "Test.pdf" }, {
        assets,
        compiler: { compile: async () => ({ diagnostics: [diagnostic], compilerVersion: "test" }) },
        output: { emit: async () => { emitted += 1; } },
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfExportError);
      expect((error as PdfExportError).phase).toBe("compile");
      expect((error as PdfExportError).diagnostics).toEqual([diagnostic]);
    }
    expect(emitted).toBe(0);
  });

  it("lets abort win after a late compiler result", async () => {
    const controller = new AbortController();
    let emitted = 0;
    await expect(runPdfExport({ blocks, metadata, filename: "Test.pdf", signal: controller.signal }, {
      assets,
      compiler: { compile: async () => {
        controller.abort();
        return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
      } },
      output: { emit: async () => { emitted += 1; } },
    })).rejects.toHaveProperty("name", "AbortError");
    expect(emitted).toBe(0);
  });
});

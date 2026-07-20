import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import { PdfExportError, runPdfExport, type PdfExportPhase } from "./run-export.js";
import { PdfSettingsError } from "./settings.js";

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
      sourceNotes: [{ level: "info", code: "browser-harness", message: "host source note" }],
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
    expect(report.notes[0]?.code).toBe("browser-harness");
    expect(phases).toEqual(["configuration", "preparing", "fetching", "compiling", "validating", "emitting"]);
    expect(emitted).toBe(1);
  });

  it("fails settings validation before any asset fetch", async () => {
    let resolveCalls = 0;
    let emitted = 0;
    try {
      await runPdfExport(
        { blocks, metadata, filename: "Test.pdf", settings: { page: "a3" as never } },
        {
          assets: { resolve: async () => { resolveCalls += 1; throw new Error("no assets"); } },
          compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
          output: { emit: async () => { emitted += 1; } },
        }
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfExportError);
      expect((error as PdfExportError).phase).toBe("configuration");
      expect((error as PdfExportError).cause).toBeInstanceOf(PdfSettingsError);
      expect(((error as PdfExportError).cause as PdfSettingsError).path).toBe("page");
    }
    expect(resolveCalls).toBe(0);
    expect(emitted).toBe(0);
  });

  it("resolves settings exactly once across validation and serialization", async () => {
    let pageReads = 0;
    const settings = {
      get page(): "letter" {
        pageReads += 1;
        return "letter";
      },
    };
    await runPdfExport(
      { blocks, metadata, filename: "Test.pdf", settings },
      {
        assets,
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      }
    );
    expect(pageReads).toBe(1);
  });

  it("does not fail a committed export when the signal fires after emit", async () => {
    const controller = new AbortController();
    let emitted = 0;
    const report = await runPdfExport(
      { blocks, metadata, filename: "Test.pdf", signal: controller.signal },
      {
        assets,
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => { emitted += 1; controller.abort(); } },
      }
    );
    expect(emitted).toBe(1);
    expect(report.filename).toBe("Test.pdf");
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

  it("counts an image nested inside an orientation region (embeddedImages)", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const regionBlocks: ExportBlock[] = [
      {
        type: "orientation",
        landscape: true,
        content: [{ type: "image", source: { kind: "attachment", filename: "wide.png" }, alt: "Wide" }],
      },
    ];
    const report = await runPdfExport(
      { blocks: regionBlocks, metadata, filename: "Test.pdf" },
      {
        assets: { resolve: async () => ({ bytes: png, mediaType: "image/png" }) },
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      }
    );
    expect(report.embeddedImages).toBe(1);
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

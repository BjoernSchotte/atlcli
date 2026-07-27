import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import {
  auditPdfLanguage,
  PdfExportError,
  preparePdfExport,
  renderPreparedPdfExport,
  runPdfExport,
  type PdfExportPhase,
} from "./run-export.js";
import { PdfSettingsError } from "./settings.js";
import {
  BUILTIN_PDF_FALLBACK_LABELS,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
} from "./design-catalog.js";
import {
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  loadPdfTemplatePack,
} from "./template-pack.js";
import { createAtlcliTypstTemplate } from "./template.js";
import { packTemplate, validateManifest } from "@atlcli/template-pack";

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);
const blocks: ExportBlock[] = [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }];
const metadata = { title: "Test", exportedAt: new Date("2026-07-17T00:00:00Z") };
const assets = { resolve: async () => { throw new Error("no assets"); } };

async function canonicalRuntime() {
  const manifest = validateManifest({
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "fixture.run-export-pack",
    name: "Run export pack",
    version: "1.0.0",
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    },
    canonicalSource: {
      api: PDF_CANONICAL_SOURCE_API_V1,
      revision: PDF_CANONICAL_SOURCE_REVISION,
    },
    provenance: undefined,
  });
  const source = createAtlcliTypstTemplate(
    manifest.design!,
    BUILTIN_PDF_FALLBACK_LABELS,
    { assets: {}, decorations: [] }
  );
  const bytes = await packTemplate({
    manifest,
    files: { "atlcli.typ": new TextEncoder().encode(source) },
  });
  return { runtime: await loadPdfTemplatePack(bytes), source };
}

describe("neutral runPdfExport", () => {
  it("keeps the direct path exactly equal to the explicit prepare/render stages", async () => {
    const clock = (): (() => number) => {
      let tick = 0;
      return () => tick++;
    };
    const compile = async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" });
    const directReport = await runPdfExport(
      { blocks, metadata, filename: "Test.pdf", sourceNotes: [] },
      { assets, compiler: { compile }, output: { emit: async () => {} }, now: clock() },
    );

    const splitClock = clock();
    const prepared = await preparePdfExport(
      { blocks, metadata, filename: "Test.pdf", sourceNotes: [] },
      { assets, now: splitClock },
    );
    const stagedReport = await renderPreparedPdfExport(
      structuredClone(prepared),
      {},
      { compiler: { compile }, output: { emit: async () => {} }, now: splitClock },
    );

    expect(stagedReport).toEqual(directReport);
    expect(prepared.schema).toBe("atlcli.prepared-pdf-export/1");
    expect(prepared.codeTheme).toBe("github-light");
    expect(stagedReport.codeTheme).toBe("github-light");
  });

  it("persists and reports a non-default code theme", async () => {
    const prepared = await preparePdfExport(
      {
        blocks: [{ type: "codeBlock", language: "ts", code: "const x = 1;" }],
        metadata,
        filename: "Themed.pdf",
        codeTheme: "github-dark",
      },
      { assets },
    );
    const report = await renderPreparedPdfExport(
      prepared,
      {},
      {
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      },
    );
    expect(prepared.codeTheme).toBe("github-dark");
    expect(report.codeTheme).toBe("github-dark");
  });

  it("resumes a historical /1 checkpoint without a theme as github-light", async () => {
    const prepared = await preparePdfExport(
      { blocks, metadata, filename: "Historical.pdf" },
      { assets },
    );
    delete (prepared as { codeTheme?: string }).codeTheme;
    const report = await renderPreparedPdfExport(
      prepared,
      {},
      {
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      },
    );
    expect(report.codeTheme).toBe("github-light");
  });

  it("consumes each materialized render value and retries from a fresh durable clone", async () => {
    let assetCalls = 0;
    let compileCalls = 0;
    const imageBlocks: ExportBlock[] = [{
      type: "image",
      source: { kind: "attachment", filename: "one.png" },
      alt: "One",
    }];
    const durablePrepared = await preparePdfExport(
      { blocks: imageBlocks, metadata, filename: "Test.pdf" },
      {
        assets: {
          resolve: async () => {
            assetCalls += 1;
            return {
              bytes: new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
                0, 0, 0, 1, 0, 0, 0, 1,
              ]),
              mediaType: "image/png",
            };
          },
        },
      },
    );
    const compiler = {
      compile: async () => {
        compileCalls += 1;
        expect(activeAttempt?.bundle).toBeUndefined();
        if (compileCalls === 1) throw new Error("worker lost");
        return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
      },
    };
    let activeAttempt = structuredClone(durablePrepared);

    await expect(
      renderPreparedPdfExport(activeAttempt, {}, { compiler, output: { emit: async () => {} } }),
    ).rejects.toMatchObject({ phase: "compile" });
    expect(activeAttempt.bundle).toBeUndefined();
    await expect(
      renderPreparedPdfExport(activeAttempt, {}, { compiler, output: { emit: async () => {} } }),
    ).rejects.toThrow("already consumed");

    activeAttempt = structuredClone(durablePrepared);
    const report = await renderPreparedPdfExport(
      activeAttempt,
      {},
      {
        compiler,
        output: {
          emit: async () => {
            expect(activeAttempt.bundle).toBeUndefined();
          },
        },
      },
    );

    expect(report.filename).toBe("Test.pdf");
    expect(activeAttempt.bundle).toBeUndefined();
    expect(durablePrepared.bundle).toBeDefined();
    expect(compileCalls).toBe(2);
    expect(assetCalls).toBe(1);
  });

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

  it("uses one verified static pack source while locale labels and declared Level A bindings travel through settings", async () => {
    const { runtime, source } = await canonicalRuntime();
    const bundles: Array<{ main: string; template: string }> = [];
    const run = (language: "de" | "en", accentColor?: string) =>
      runPdfExport(
        {
          blocks,
          metadata: { ...metadata, language },
          filename: `${language}.pdf`,
          templatePack: runtime,
          ...(accentColor ? { settings: { accentColor } } : {}),
        },
        {
          assets,
          compiler: {
            async compile(bundle) {
              bundles.push({
                main: bundle.main,
                template: bundle.template,
              });
              return {
                pdf: validPdf,
                diagnostics: [],
                compilerVersion: "test",
              };
            },
          },
          output: { emit: async () => {} },
        }
      );

    await run("en");
    await run("de", "#123456");
    expect(bundles.map(({ template }) => template)).toEqual([source, source]);
    expect(bundles[0]!.main).toContain('contents: "Contents"');
    expect(bundles[1]!.main).toContain('contents: "Inhalt"');
    expect(bundles[1]!.main).toContain('"#123456"');
    expect(bundles[0]!.main).not.toContain('"#123456"');
  });

  it("owns the verified runtime before asynchronous preparation can observe mutation", async () => {
    const { runtime, source } = await canonicalRuntime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preparing = preparePdfExport(
      {
        blocks: [
          {
            type: "image",
            source: { kind: "external", url: "https://example.invalid/a.png" },
            alt: "Synthetic",
          },
        ],
        metadata,
        filename: "frozen.pdf",
        templatePack: runtime,
      },
      {
        assets: {
          async resolve() {
            await gate;
            throw new Error("synthetic missing asset");
          },
        },
      }
    );
    runtime.canonicalSource.source = "// caller mutation";
    runtime.entrySource = "// caller mutation";
    release();
    const prepared = await preparing;
    expect(prepared.bundle?.template).toBe(source);
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

/**
 * Language audit (spec 011, PDF/UA 7.2). `auditPdfLanguage` is pure over the
 * two facts that decide it, so the branch table is asserted directly; the
 * wiring test below proves `runPdfExport` feeds it the REAL inspection result
 * rather than re-deriving the answer from the request.
 */
describe("PDF language audit", () => {
  const taggedWithLang = new TextEncoder().encode(
    "%PDF-1.7\n/Type/Page /Type/Catalog /Lang (de-DE) /StructTreeRoot /MarkInfo /FontFile2\n%%EOF\n"
  );

  it("warns when no language was supplied", () => {
    const notes = auditPdfLanguage({ hasLang: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ level: "warning", code: "pdf-language-missing" });
    expect(notes[0]?.message).toContain("no document language");
  });

  it("warns when the supplied language is not a usable tag", () => {
    // normalizePdfLocale would silently coerce this to "en" for rendering; the
    // audit exists precisely to say that the coercion happened.
    const notes = auditPdfLanguage({ language: "Deutsch (Germany)", hasLang: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('"Deutsch (Germany)"');
  });

  it("stays silent for a usable language on a PDF that declares /Lang", () => {
    expect(auditPdfLanguage({ language: "de", hasLang: true })).toEqual([]);
    expect(auditPdfLanguage({ language: "en-GB", hasLang: true })).toEqual([]);
  });

  it("warns about the compiled file separately from the request", () => {
    // A Level-B template can drop /Lang even when the metadata was fine, so
    // these are two independent defects that must both be reportable.
    const notes = auditPdfLanguage({ language: "de", hasLang: false });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("/Lang");
    expect(auditPdfLanguage({ hasLang: false })).toHaveLength(2);
  });

  it("puts the warning on the export report when metadata has no language", async () => {
    const report = await runPdfExport({ blocks, metadata, filename: "Test.pdf" }, {
      assets,
      compiler: { compile: async () => ({ pdf: taggedWithLang, diagnostics: [], compilerVersion: "test" }) },
      output: { emit: async () => {} },
    });
    expect(report.notes.filter((note) => note.code === "pdf-language-missing")).toHaveLength(1);
  });

  it("keeps the report clean when the language is set and the PDF declares it", async () => {
    const report = await runPdfExport(
      { blocks, metadata: { ...metadata, language: "de", region: "DE" }, filename: "Test.pdf" },
      {
        assets,
        compiler: { compile: async () => ({ pdf: taggedWithLang, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      }
    );
    expect(report.notes.filter((note) => note.code === "pdf-language-missing")).toEqual([]);
  });

  it("reads /Lang from the produced bytes, not from the request metadata", async () => {
    // The strongest form of the wiring assertion: metadata says "de", but the
    // compiler returns a file WITHOUT /Lang. A report that stayed silent here
    // would be attesting to a property the file does not have.
    const report = await runPdfExport(
      { blocks, metadata: { ...metadata, language: "de" }, filename: "Test.pdf" },
      {
        assets,
        compiler: { compile: async () => ({ pdf: validPdf, diagnostics: [], compilerVersion: "test" }) },
        output: { emit: async () => {} },
      }
    );
    const notes = report.notes.filter((note) => note.code === "pdf-language-missing");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain("/Lang");
  });
});

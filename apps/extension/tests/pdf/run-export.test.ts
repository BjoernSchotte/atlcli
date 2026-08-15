import { describe, expect, it } from "bun:test";
import { canonicalExportNoteCode } from "@atlcli/confluence/browser";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../../utils/read-path.js";
import { normalizePdfLocale, runPdfExport, type PdfExportPhase } from "../../utils/pdf/run-export.js";

const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);
const page: LoadedPage = {
  details: {
    id: "123",
    title: "Guide: A/B?",
    spaceKey: "DOCSY",
    version: 4,
    modifiedBy: { accountId: "a1", displayName: "Ada" },
    storage: "<h2>Overview</h2><p>Hello <strong>PDF</strong>.</p>",
  },
  markdown: "## Overview\n\nHello **PDF**.",
  wordCount: 4,
  attachments: [],
};

describe("extension PDF page adapter", () => {
  it("normalizes browser locales", () => {
    expect(normalizePdfLocale("de-DE")).toEqual({ language: "de", region: "DE" });
    expect(normalizePdfLocale("pt_BR")).toEqual({ language: "pt", region: "BR" });
    expect(normalizePdfLocale("invalid-locale")).toEqual({ language: "en" });
  });

  it("preserves UI phases, theme/profile, output and report labels", async () => {
    const phases: PdfExportPhase[] = [];
    const emitted: Array<{ name: string; bytes: Uint8Array }> = [];
    let compiledBundle: PdfSourceBundle | undefined;
    let clock = 1_000;
    const report = await runPdfExport({
      page,
      pageUrl: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123/Guide",
      theme: { colors: { paper: "#FFFDF5", ink: "#102040" } },
      profile: "pdf-ua-1",
      onPhase: (phase) => phases.push(phase),
    }, {
      now: () => (clock += 5),
      locale: () => "de-DE",
      resolveMentions: async (blocks) => ({ blocks, unresolved: 0 }),
      resolver: { resolve: async () => { throw new Error("no assets"); } },
      createCompilePort: ({ onQueued, onCompiling }) => ({
        async compile(bundle) {
          compiledBundle = bundle;
          onQueued();
          onCompiling();
          return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
        },
      }),
      // `bytes` is a PdfBytesHandle since spec 010 T5.6; assertions want the array.
      output: { emit: async (name, bytes) => { emitted.push({ name, bytes: await bytes.asUint8Array() }); } },
    });

    expect(compiledBundle?.template).toContain('let cover-paper = rgb("#FFFDF5")');
    expect(compiledBundle?.template).toContain('fill: rgb("#102040")');
    expect(phases).toEqual(["preparing", "fetching", "queued", "compiling", "validating", "downloading"]);
    expect(emitted).toEqual([{ name: "Guide- A-B-.pdf", bytes: validPdf }]);
    expect(report.profile).toBe("pdf-ua-1");
    expect(report.timings.emitMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps unresolved mention warnings ahead of serializer notes", async () => {
    const mentionPage: LoadedPage = {
      ...page,
      details: {
        ...page.details,
        storage: '<p><ac:link><ri:user ri:account-id="a"/></ac:link></p>',
      },
    };
    let compiledBundle: PdfSourceBundle | undefined;
    const report = await runPdfExport({ page: mentionPage, pageUrl: "https://acme.atlassian.net/wiki/x" }, {
      locale: () => "en",
      resolveMentions: async (blocks: ExportBlock[]) => ({
        blocks: [{ type: "paragraph", content: [{ type: "mention", accountId: "a", displayName: "Ada" }] }],
        unresolved: 1,
      }),
      resolver: { resolve: async () => { throw new Error("no assets"); } },
      createCompilePort: ({ onQueued, onCompiling }) => ({
        async compile(bundle) {
          compiledBundle = bundle;
          onQueued();
          onCompiling();
          return { pdf: validPdf, diagnostics: [], compilerVersion: "test" };
        },
      }),
      output: { emit: async () => undefined },
    });
    expect(compiledBundle?.main).toContain("@Ada");
    // CROSS-HOST vocabulary (spec 010). This is the exact condition the CLI's
    // PDF host reports — pinned there by `apps/cli/src/commands/
    // export-source-contract.test.ts` ("counts one unresolvable mention exactly once on
    // both engines"), which asserts `notesByCode["mention-unresolved"] === 1`
    // for `--format pdf`. The extension used to spell the same fact
    // `pdf-mention-unresolved`, so a consumer's filter worked on one host's
    // report and silently matched nothing on the other's.
    expect(report.notes[0]?.code).toBe("mention-unresolved");
    // And the retired spelling still resolves, so a consumer that remembers it
    // has a way back to the code emitted today.
    expect(canonicalExportNoteCode("pdf-mention-unresolved")).toBe(report.notes[0]?.code);
  });
});

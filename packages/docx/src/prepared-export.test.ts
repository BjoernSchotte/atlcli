import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import {
  exportDocx,
  prepareDocxExport,
  renderPreparedDocxExport,
  type ExportInput,
  type ExportReport,
} from "./export.js";
import { runExport } from "./env.js";
import { buildDocx, para } from "./fixtures.js";

const TEMPLATE = buildDocx({ body: para("$scroll.content") });
const BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Prepared export" }] },
  { type: "paragraph", content: [{ type: "text", text: "Same bytes in every host." }] },
];

function input(): ExportInput {
  return {
    templateBytes: TEMPLATE,
    details: { id: "1", title: "Prepared", storage: "", spaceKey: "DOC" },
    template: { name: "template.docx", modificationDate: new Date(0) },
    exportDate: new Date(0),
    blocks: BLOCKS,
  };
}

function stableReport(report: ExportReport): unknown {
  return {
    ...report,
    durationMs: 0,
    timings: {
      resolveMs: 0,
      bodyMs: 0,
      logoFetchMs: 0,
      includeFetchMs: 0,
      renderMs: 0,
      imageFetchMs: 0,
      imageFetches: report.timings.imageFetches,
      diagramRenderMs: 0,
      diagramRasterMs: 0,
    },
    notes: report.notes.filter((note) => note.code !== "perf-timing"),
  };
}

describe("prepared DOCX export", () => {
  it("keeps direct and explicitly staged artifact/report output equal", async () => {
    const direct = await exportDocx(input());
    const prepared = await prepareDocxExport(input());
    const staged = await renderPreparedDocxExport(prepared);

    expect(staged.bytes).toEqual(direct.bytes);
    expect(stableReport(staged.report)).toEqual(stableReport(direct.report));
    expect(prepared.codeTheme).toBe("github-light");
    expect(staged.report.codeTheme).toBe("github-light");
  });

  it("persists and reports a non-default code theme", async () => {
    const themed = input();
    themed.codeTheme = "github-dark";
    themed.blocks = [{ type: "codeBlock", language: "ts", code: "const x = 1;" }];
    const prepared = await prepareDocxExport(themed);
    const report = (await renderPreparedDocxExport(prepared)).report;
    expect(prepared.codeTheme).toBe("github-dark");
    expect(report.codeTheme).toBe("github-dark");
    expect(report.timings.highlightCodeBlocks).toBe(1);
    expect(report.timings.highlightLanguageCount).toBe(1);
    expect(report.timings.highlightTokenizeMs).toBeGreaterThanOrEqual(0);
  });

  it("resumes a historical /1 checkpoint without a theme as github-light", async () => {
    const prepared = await prepareDocxExport(input());
    delete (prepared as { codeTheme?: string }).codeTheme;
    const report = (await renderPreparedDocxExport(prepared)).report;
    expect(report.codeTheme).toBe("github-light");
  });

  it("normalizes highlight timings missing from a historical /1 checkpoint", async () => {
    const prepared = await prepareDocxExport(input());
    const historical = prepared.timings as typeof prepared.timings & {
      highlightEngineInitMs?: number;
      highlightGrammarLoadMs?: number;
      highlightTokenizeMs?: number;
      highlightCodeBlocks?: number;
      highlightLanguageCount?: number;
    };
    delete historical.highlightEngineInitMs;
    delete historical.highlightGrammarLoadMs;
    delete historical.highlightTokenizeMs;
    delete historical.highlightCodeBlocks;
    delete historical.highlightLanguageCount;

    const report = (await renderPreparedDocxExport(prepared)).report;
    expect(report.timings).toMatchObject({
      highlightEngineInitMs: 0,
      highlightGrammarLoadMs: 0,
      highlightTokenizeMs: 0,
      highlightCodeBlocks: 0,
      highlightLanguageCount: 0,
    });
  });

  it("consumes one render state and retries only from a fresh durable clone", async () => {
    const prepared = await prepareDocxExport(input());
    const durableClone = structuredClone(prepared);

    const first = await renderPreparedDocxExport(prepared);
    expect(prepared.renderState).toBeUndefined();
    await expect(renderPreparedDocxExport(prepared)).rejects.toThrow("already consumed");

    const retry = await renderPreparedDocxExport(durableClone);
    expect(retry.bytes).toEqual(first.bytes);
    expect(stableReport(retry.report)).toEqual(stableReport(first.report));
  });

  it("does not consume a render state when cancellation wins before the attempt", async () => {
    const prepared = await prepareDocxExport(input());
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderPreparedDocxExport(prepared, { signal: controller.signal })
    ).rejects.toHaveProperty("name", "AbortError");
    expect(prepared.renderState).toBeDefined();
  });

  it("threads cancellation through template load and rasterization and never emits", async () => {
    const controller = new AbortController();
    let templateSignal: AbortSignal | undefined;
    let rasterSignal: AbortSignal | undefined;
    let emitted = false;
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
    );

    await expect(
      runExport(
        {
          details: { id: "1", title: "Cancelled", storage: "", spaceKey: "DOC" },
          template: { name: "template.docx", modificationDate: new Date(0) },
          blocks: [
            {
              type: "image",
              source: { kind: "attachment", filename: "vector.svg", pageId: "1" },
              alt: "vector",
            },
          ],
          signal: controller.signal,
        },
        {
          templates: {
            getBytes: async (_id, context) => {
              templateSignal = context?.signal;
              return TEMPLATE;
            },
          },
          assets: { fetch: async () => svg },
          rasterizer: {
            rasterize: async (_source, _target, context) => {
              rasterSignal = context?.signal;
              controller.abort();
              return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
            },
          },
          output: {
            emit: async () => {
              emitted = true;
            },
          },
        }
      )
    ).rejects.toHaveProperty("name", "AbortError");

    expect(templateSignal).toBe(controller.signal);
    expect(rasterSignal).toBe(controller.signal);
    expect(emitted).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence";
import PizZip from "pizzip";
import {
  exportDocx,
  prepareDocxExport,
  renderPreparedDocxExport,
  renderPreparedDocxExportStream,
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

async function collect(source: AsyncIterable<Uint8Array>): Promise<{
  bytes: Uint8Array;
  chunks: Uint8Array[];
}> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    const owned = chunk.slice();
    chunks.push(owned);
    byteLength += owned.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, chunks };
}

function expectEquivalentParts(leftBytes: Uint8Array, rightBytes: Uint8Array): void {
  const left = new PizZip(leftBytes);
  const right = new PizZip(rightBytes);
  expect(Object.keys(right.files).sort()).toEqual(Object.keys(left.files).sort());
  for (const [path, entry] of Object.entries(left.files)) {
    if (!entry.dir) {
      expect(right.file(path)?.asUint8Array()).toEqual(entry.asUint8Array());
    }
  }
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

  it("detaches media only when the executor selects streamed packaging", async () => {
    const template = new PizZip(TEMPLATE);
    const media = new Uint8Array(8 * 1024).fill(0x5a);
    template.file("word/media/existing.png", media, { binary: true });
    const templateBytes = template.generate({
      type: "uint8array",
      compression: "DEFLATE",
    }) as unknown as Uint8Array;

    const inMemory = await prepareDocxExport({
      ...input(),
      templateBytes,
      streamingPreparedBytesThreshold: 1024 * 1024,
    });
    expect(inMemory.packagingMode).toBe("memory");
    expect(inMemory.renderState?.mediaParts).toBeUndefined();
    expect(new PizZip(inMemory.renderState!.archiveBytes)
      .file("word/media/existing.png")?.asUint8Array()).toEqual(media);

    const streamed = await prepareDocxExport({
      ...input(),
      templateBytes,
      streamingPreparedBytesThreshold: 1,
    });
    expect(streamed.packagingMode).toBe("stream");
    expect(streamed.renderState?.mediaParts?.[0]?.bytes).toEqual(media);
    expect(new PizZip(streamed.renderState!.archiveBytes)
      .file("word/media/existing.png")?.asUint8Array()).toEqual(new Uint8Array());
  });

  it("streams semantically identical OPC parts and exposes the report only after completion", async () => {
    const preparedForLegacy = await prepareDocxExport(input());
    const preparedForStream = structuredClone(preparedForLegacy);
    const legacy = await renderPreparedDocxExport(preparedForLegacy);
    const streamed = await renderPreparedDocxExportStream(preparedForStream);

    expect(() => streamed.report()).toThrow("only after");
    const output = await collect(streamed.bytes);

    expect(output.chunks.length).toBeGreaterThan(3);
    expect(output.chunks.every((chunk) => chunk.byteLength < output.bytes.byteLength)).toBe(true);
    expectEquivalentParts(legacy.bytes, output.bytes);
    expect(stableReport(streamed.report())).toEqual(stableReport(legacy.report));
  });

  it("streams a body anchored in a header without leaking its random sentinel", async () => {
    const anchored = input();
    anchored.templateBytes = buildDocx({
      body: para("Static main story with {literal} braces"),
      header: para("$scroll.content"),
    });
    anchored.blocks = [{
      type: "paragraph",
      content: [{
        type: "text",
        text: "Header body keeps $scroll.title and {{ customer syntax }} literal.",
      }],
    }];
    const preparedForLegacy = await prepareDocxExport(anchored);
    const preparedForStream = structuredClone(preparedForLegacy);
    const legacy = await renderPreparedDocxExport(preparedForLegacy);
    const streamed = await renderPreparedDocxExportStream(preparedForStream);
    const output = await collect(streamed.bytes);

    expectEquivalentParts(legacy.bytes, output.bytes);
    const zip = new PizZip(output.bytes);
    const header = zip.file("word/header1.xml")?.asText() ?? "";
    const document = zip.file("word/document.xml")?.asText() ?? "";
    expect(header).toContain("Header body keeps $scroll.title");
    expect(header).toContain("{{ customer syntax }}");
    expect(document).toContain("{literal}");
    expect(JSON.stringify({ header, document })).not.toContain("ATLCLI_BODY_");
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

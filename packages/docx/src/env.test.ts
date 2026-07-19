/**
 * runExport host-seam threading (spec 002): the abort signal reaches the asset
 * fetcher and the output sink, progress events fire, and an abort before emit
 * stops the write. Real in-memory ports — no mocks.
 */
import { describe, expect, it } from "bun:test";
import type { ExportBlock, ExportProgressEvent } from "@atlcli/confluence";
import { runExport } from "./env.js";
import { buildDocx, para } from "./fixtures.js";

const TEMPLATE = buildDocx({ body: para("$scroll.content") });

function png(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
}

const imageBlocks: ExportBlock[] = [
  { type: "image", source: { kind: "attachment", filename: "x.png", pageId: "1" }, alt: "x" },
];

describe("runExport — signal + progress threading (spec 002)", () => {
  it("threads the abort signal into the asset fetcher and the output sink", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let emitSignal: AbortSignal | undefined;
    const progress: ExportProgressEvent[] = [];

    await runExport(
      {
        details: { id: "1", title: "Root", storage: "", spaceKey: "DOC" },
        template: { name: "t.docx", modificationDate: new Date(0) },
        blocks: imageBlocks,
        signal: controller.signal,
        onProgress: (e) => progress.push(e),
      },
      {
        templates: { getBytes: async () => TEMPLATE },
        assets: {
          fetch: async (_ref, context) => {
            fetchSignal = context?.signal;
            return png();
          },
        },
        output: {
          emit: async (_name, _bytes, context) => {
            emitSignal = context?.signal;
          },
        },
      }
    );

    expect(fetchSignal).toBe(controller.signal);
    expect(emitSignal).toBe(controller.signal);
    // The asset embed reported an assets-phase event and emit reported its phase.
    expect(progress.some((e) => e.phase === "assets")).toBe(true);
    expect(progress.some((e) => e.phase === "emit" && e.done === 1)).toBe(true);
  });

  it("reports asset progress for FAILED image embeds too (done reaches total)", async () => {
    // Two images, one fetch fails: progress must still advance for the failed
    // one (matching the PDF engine's per-asset reporting), so `done` reaches
    // `total` instead of under-reporting.
    const progress: ExportProgressEvent[] = [];
    const twoImages: ExportBlock[] = [
      { type: "image", source: { kind: "attachment", filename: "ok.png", pageId: "1" }, alt: "ok" },
      { type: "image", source: { kind: "attachment", filename: "broken.png", pageId: "1" }, alt: "nope" },
    ];
    const report = await runExport(
      {
        details: { id: "1", title: "Root", storage: "", spaceKey: "DOC" },
        template: { name: "t.docx", modificationDate: new Date(0) },
        blocks: twoImages,
        onProgress: (e) => progress.push(e),
      },
      {
        templates: { getBytes: async () => TEMPLATE },
        assets: {
          fetch: async (ref) => {
            if (ref.filename === "broken.png") throw new Error("fetch failed");
            return png();
          },
        },
        output: { emit: async () => {} },
      }
    );
    const assetEvents = progress.filter((e) => e.phase === "assets");
    expect(assetEvents.map((e) => e.done)).toEqual([1, 2]);
    expect(assetEvents.every((e) => e.total === 2)).toBe(true);
    // The failed image still degraded to a report note (not a fatal error).
    expect(report.notes.some((n) => n.code === "image-embed-failed")).toBe(true);
  });

  it("aborts before emit and never writes output", async () => {
    const controller = new AbortController();
    controller.abort();
    let emitted = false;
    await expect(
      runExport(
        {
          details: { id: "1", title: "Root", storage: "", spaceKey: "DOC" },
          template: { name: "t.docx", modificationDate: new Date(0) },
          blocks: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          signal: controller.signal,
        },
        {
          templates: { getBytes: async () => TEMPLATE },
          output: { emit: async () => { emitted = true; } },
        }
      )
    ).rejects.toThrow();
    expect(emitted).toBe(false);
  });
});

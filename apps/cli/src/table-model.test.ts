import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createNodePdfiumFactsAdapterV2 } from "@atlcli/import-pdf/node";
import {
  TABLE_TRANSFORMER,
  createTableTransformerProposer,
  decodeTableTransformerOutput,
  executionProviders,
  installedTableModel,
  modelsDirectory,
  preprocessTableImage,
  pruneForeignBinaries,
  pullTableTransformer,
  tableModelPath,
} from "./table-model.js";

/** DETR-style outputs for queries given as [class, cx, cy, w, h]; 7 logits per query. */
function outputs(queries: Array<[number, number, number, number, number]>) {
  const logits = new Float32Array(queries.length * 7).fill(-10);
  const boxes = new Float32Array(queries.length * 4);
  queries.forEach(([label, cx, cy, w, h], query) => {
    logits[query * 7 + label] = 10;
    boxes.set([cx, cy, w, h], query * 4);
  });
  return { logits, boxes };
}

describe("Table Transformer postprocessing", () => {
  it("maps rows, columns, headers and spanning cells to image-relative boxes", () => {
    const { logits, boxes } = outputs([
      [2, 0.5, 0.25, 1, 0.5], [2, 0.5, 0.75, 1, 0.5],
      [1, 0.25, 0.5, 0.5, 1], [1, 0.75, 0.5, 0.5, 1],
      [3, 0.5, 0.25, 1, 0.5], [5, 0.5, 0.25, 1, 0.5],
      [6, 0.5, 0.5, 1, 1], // no object
    ]);
    const proposal = decodeTableTransformerOutput(logits, boxes);
    expect(proposal.rows).toEqual(expect.arrayContaining([{ x: 0, y: 0, width: 1, height: 0.5 }, { x: 0, y: 0.5, width: 1, height: 0.5 }]));
    expect(proposal.columns).toHaveLength(2);
    expect(proposal.columnHeaders).toHaveLength(1);
    expect(proposal.spanningCells).toHaveLength(1);
  });

  it("keeps the more confident of two overlapping detections", () => {
    const { logits, boxes } = outputs([[2, 0.5, 0.25, 1, 0.5], [2, 0.5, 0.26, 1, 0.5]]);
    logits[7 + 2] = 3; // the second row is less confident
    expect(decodeTableTransformerOutput(logits, boxes).rows).toEqual([{ x: 0, y: 0, width: 1, height: 0.5 }]);
  });
});

describe("Table Transformer preprocessing", () => {
  it("resizes the longest edge to 1000 and normalizes a white page", () => {
    const pixels = new Uint8Array(200 * 100 * 4).fill(255);
    const input = preprocessTableImage({ pixels, width: 200, height: 100, hasAlpha: false });
    expect([input.width, input.height]).toEqual([1000, 500]);
    expect(input.data[0]).toBeCloseTo((1 - 0.485) / 0.229, 4);
    expect(input.data[2 * 1000 * 500]).toBeCloseTo((1 - 0.406) / 0.225, 4);
  });
});

describe("table model installation", () => {
  it("chooses a GPU execution provider per platform and keeps CPU as the fallback", () => {
    expect(executionProviders("auto")).toEqual(["cpu"]);
    expect(executionProviders("gpu", "darwin")).toEqual(["coreml", "cpu"]);
    expect(executionProviders("gpu", "linux")).toEqual(["cuda", "cpu"]);
  });

  it("writes nothing when a downloaded model does not match its pinned digest", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "atlcli-models-"));
    try {
      const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
      await expect(pullTableTransformer({ variant: "quantized", root, fetchImpl })).rejects.toThrow(/digest mismatch/);
      expect(existsSync(tableModelPath("quantized", root))).toBe(false);
      expect(installedTableModel(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a runtime package whose integrity does not match", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "atlcli-models-"));
    try {
      // The model is present already; only the runtime is fetched.
      await mkdir(join(tableModelPath("fp32", root), ".."), { recursive: true });
      await writeFile(tableModelPath("fp32", root), "model");
      const fetchImpl = (async () => new Response(new Uint8Array([9]))) as unknown as typeof fetch;
      await expect(pullTableTransformer({ variant: "fp32", root, fetchImpl })).rejects.toThrow(/integrity mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps only this platform's runtime binaries", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "atlcli-runtime-"));
    try {
      for (const path of ["darwin/arm64", "linux/x64", "linux/arm64", "win32/x64"]) await mkdir(join(root, "bin/napi-v6", path), { recursive: true });
      await pruneForeignBinaries(root, "linux", "x64");
      expect(await readdir(join(root, "bin/napi-v6"))).toEqual(["linux"]);
      expect(await readdir(join(root, "bin/napi-v6/linux"))).toEqual(["x64"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses ATLCLI_MODELS_DIR and pins the model revision", () => {
    expect(modelsDirectory({ ATLCLI_MODELS_DIR: "/models" })).toBe("/models");
    expect(tableModelPath("fp32", "/models")).toBe(`/models/table-transformer/${TABLE_TRANSFORMER.revision}/model.onnx`);
  });
});

// Runs only where `atlcli models pull table-transformer` was done.
const installed = installedTableModel() !== null;
describe.skipIf(!installed)("Table Transformer on the neutral untagged fixture", () => {
  it("proposes the borderless contacts table: four rows, three columns", async () => {
    const bytes = new Uint8Array(await readFile(resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures/untagged-word.pdf")));
    // The contacts table with the 0.03 candidate margin.
    const bbox = { x: 0.09, y: 0.631, width: 0.617, height: 0.136 };
    const [image] = await (await createNodePdfiumFactsAdapterV2()).materialize(bytes, [{ id: "contacts", pageIndex: 1, kind: "rendered-region", bbox, dpi: 150 }]);
    const proposer = await createTableTransformerProposer({ device: "cpu" });
    const proposal = await proposer.propose({ pageIndex: 1, bbox, image: image! });
    expect(proposal?.rows).toHaveLength(4);
    expect(proposal?.columns).toHaveLength(3);
  });
});

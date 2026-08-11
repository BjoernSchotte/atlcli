import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";

const EXTENSION_ROOT = join(import.meta.dir, "..");
const REPOSITORY_ROOT = join(EXTENSION_ROOT, "..", "..");

describe("Gemma 4 E4B G0 manifest", () => {
  test("pins the selected runtime, model, task, class, dtype, and device", () => {
    expect(LOCAL_GEMMA_G0_MANIFEST_V1).toMatchObject({
      schema: "atlcli.browser-local-model-manifest/v1",
      modelId: "onnx-community/gemma-4-E4B-it-ONNX",
      modelRevision: "843f250f23bc91754def1e0f0db390dacd1e6b05",
      sourceModelId: "google/gemma-4-E4B-it",
      task: "text-generation",
      modelClass: "Gemma4ForCausalLM",
      dtype: "q4f16",
      device: "webgpu",
      runtime: {
        transformersJs: "4.1.0",
        onnxRuntimeWeb: "1.26.0-dev.20260410-5e55544225",
      },
      license: {
        spdx: "Apache-2.0",
      },
    });
  });

  test("contains only the pinned nine-file text-generation inventory", () => {
    expect(LOCAL_GEMMA_G0_MANIFEST_V1.files.map((file) => file.path)).toEqual([
      "config.json",
      "onnx/embed_tokens_q4f16.onnx",
      "onnx/embed_tokens_q4f16.onnx_data",
      "onnx/decoder_model_merged_q4f16.onnx",
      "onnx/decoder_model_merged_q4f16.onnx_data",
      "onnx/decoder_model_merged_q4f16.onnx_data_1",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    expect(LOCAL_GEMMA_G0_MANIFEST_V1.files.every((file) =>
      !/(?:audio|vision|image|fp16|quantized|_q4\.)/.test(file.path)
    )).toBe(true);
  });

  test("pins valid per-file SHA-256 values and the exact aggregate size", () => {
    const paths = new Set<string>();
    let aggregate = 0;
    for (const file of LOCAL_GEMMA_G0_MANIFEST_V1.files) {
      expect(paths.has(file.path), `duplicate manifest path: ${file.path}`).toBe(false);
      expect(file.byteLength).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      paths.add(file.path);
      aggregate += file.byteLength;
    }
    expect(aggregate).toBe(4_924_946_442);
    expect(LOCAL_GEMMA_G0_MANIFEST_V1.aggregateByteLength).toBe(aggregate);
  });

  test("matches the exact extension dependency and resolved ORT lock entry", () => {
    const manifest = JSON.parse(
      readFileSync(join(EXTENSION_ROOT, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    const lockfile = readFileSync(join(REPOSITORY_ROOT, "bun.lock"), "utf8");

    expect(manifest.dependencies["@huggingface/transformers"]).toBe(
      LOCAL_GEMMA_G0_MANIFEST_V1.runtime.transformersJs
    );
    expect(lockfile).toContain(
      `"onnxruntime-web@${LOCAL_GEMMA_G0_MANIFEST_V1.runtime.onnxRuntimeWeb}"`
    );
  });
});

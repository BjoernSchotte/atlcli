import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "..", "workers", "local-model.ts"),
  "utf8",
);

describe("local Gemma offscreen runtime bootstrap", () => {
  it("uses Transformers.js' text-only Gemma class", () => {
    expect(source).toContain("Gemma4ForCausalLM.from_pretrained");
    expect(source).not.toContain("Gemma4ForConditionalGeneration");
    expect(source).not.toContain("audio_encoder");
    expect(source).not.toContain("vision_encoder");
  });

  it("keeps ORT single-threaded inside the offscreen WebGPU host", () => {
    expect(source).toContain("onnxWasmEnv.numThreads = 1");
    expect(source).toContain("onnxWasmEnv.proxy = false");
  });

  it("releases generation inputs and outputs before the next tool-loop call", () => {
    expect(source).toContain("disposeLocalModelValueV1(output)");
    expect(source).toContain("disposeLocalModelInputsV1(inputs");
  });
});

import { describe, expect, test } from "bun:test";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";
import {
  pinTransformersRegistryUrlV1,
  proveLocalModelManifestWithRegistryV1,
  type LocalModelRegistryPortV1,
} from "../utils/local-model/registry.js";

function fakeRegistry(
  files = LOCAL_GEMMA_G0_MANIFEST_V1.files.map((file) => file.path),
  dtypes = ["fp32", "fp16", "q8", "q4", "q4f16"],
): LocalModelRegistryPortV1 {
  return {
    async getPipelineFiles(task, modelId, options) {
      expect(task).toBe("text-generation");
      expect(modelId).toBe(LOCAL_GEMMA_G0_MANIFEST_V1.modelId);
      expect(options).toEqual({ dtype: "q4f16", device: "webgpu" });
      return files;
    },
    async getAvailableDtypes(modelId, options) {
      expect(modelId).toBe(LOCAL_GEMMA_G0_MANIFEST_V1.modelId);
      expect(options).toEqual({
        revision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
      });
      return dtypes;
    },
  };
}

describe("Transformers.js Gemma registry proof", () => {
  test("accepts only the exact pinned text-generation inventory and dtype", async () => {
    const proof = await proveLocalModelManifestWithRegistryV1(
      LOCAL_GEMMA_G0_MANIFEST_V1,
      fakeRegistry(),
    );
    expect(proof.files).toEqual(
      LOCAL_GEMMA_G0_MANIFEST_V1.files.map((file) => file.path),
    );
    expect(proof.dtypes).toContain("q4f16");
  });

  test("rejects an extra vision component", async () => {
    const files = [
      ...LOCAL_GEMMA_G0_MANIFEST_V1.files.map((file) => file.path),
      "onnx/vision_encoder_q4f16.onnx",
    ];
    await expect(
      proveLocalModelManifestWithRegistryV1(
        LOCAL_GEMMA_G0_MANIFEST_V1,
        fakeRegistry(files),
      ),
    ).rejects.toThrow("extra=[onnx/vision_encoder_q4f16.onnx]");
  });

  test("rejects missing files and unavailable q4f16", async () => {
    const files = LOCAL_GEMMA_G0_MANIFEST_V1.files
      .map((file) => file.path)
      .slice(1);
    await expect(
      proveLocalModelManifestWithRegistryV1(
        LOCAL_GEMMA_G0_MANIFEST_V1,
        fakeRegistry(files),
      ),
    ).rejects.toThrow("missing=[config.json]");
    await expect(
      proveLocalModelManifestWithRegistryV1(
        LOCAL_GEMMA_G0_MANIFEST_V1,
        fakeRegistry(undefined, ["fp32", "fp16", "q4"]),
      ),
    ).rejects.toThrow("does not expose the pinned dtype q4f16");
  });

  test("pins only this model's main-revision Hub requests", () => {
    const source =
      "https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/config.json";
    expect(pinTransformersRegistryUrlV1(
      source,
      LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
      LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
    )).toBe(
      `https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/` +
        `${LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision}/config.json`,
    );
    expect(pinTransformersRegistryUrlV1(
      "https://huggingface.co/another/model/resolve/main/config.json",
      LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
      LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
    )).toBe("https://huggingface.co/another/model/resolve/main/config.json");
  });

  test.skipIf(process.env.ATLCLI_GEMMA_REGISTRY_LIVE !== "1")(
    "matches the real pinned Transformers.js ModelRegistry response",
    async () => {
      const proof = await proveLocalModelManifestWithRegistryV1(
        LOCAL_GEMMA_G0_MANIFEST_V1,
      );
      expect(proof.files).toEqual(
        LOCAL_GEMMA_G0_MANIFEST_V1.files.map((file) => file.path),
      );
      expect(proof.dtypes).toContain("q4f16");
    },
    30_000,
  );
});

import { describe, expect, it } from "bun:test";
import type { LocalModelManifestV1 } from "../utils/local-model/manifest.js";
import {
  configureVerifiedLocalModelRuntimeV1,
  type TransformersLocalOnlyEnvironmentV1,
} from "../utils/local-model/runtime-cache.js";
import {
  LOCAL_MODEL_CACHE_NAME_V1,
  localModelRemoteUrlV1,
  type LocalModelCacheV1,
} from "../utils/local-model/storage.js";

const MANIFEST: LocalModelManifestV1 = {
  schema: "atlcli.browser-local-model-manifest/v1",
  modelId: "fixture/local-model",
  modelRevision: "0123456789abcdef",
  sourceModelId: "fixture/source",
  task: "text-generation",
  modelClass: "Gemma4ForConditionalGeneration",
  dtype: "q4f16",
  device: "webgpu",
  aggregateByteLength: 3,
  files: [{ path: "config.json", byteLength: 3, sha256: "0".repeat(64) }],
  runtime: { transformersJs: "4.2.0", onnxRuntimeWeb: "fixture" },
  license: {
    spdx: "Apache-2.0",
    url: "https://example.invalid/license",
    attribution: "fixture",
  },
};

function environmentFixture(): TransformersLocalOnlyEnvironmentV1 {
  return {
    allowRemoteModels: true,
    allowLocalModels: false,
    useBrowserCache: true,
    useFS: true,
    useFSCache: true,
    useCustomCache: false,
    customCache: null,
    experimental_useCrossOriginStorage: true,
    fetch: async () => new Response("network"),
  };
}

describe("verified local Transformers.js model resolution", () => {
  it("allows only exact manifest URLs from the named installer cache", async () => {
    const environment = environmentFixture();
    const expectedUrl = localModelRemoteUrlV1(MANIFEST, "config.json");
    const opened: string[] = [];
    const cache: LocalModelCacheV1 = {
      async match(request) {
        return String(request) === expectedUrl
          ? new Response(Uint8Array.of(1, 2, 3), {
              headers: { "content-length": "3" },
            })
          : undefined;
      },
      async put() { throw new Error("not used"); },
      async delete() { return false; },
    };

    const localCache = await configureVerifiedLocalModelRuntimeV1({
      manifest: MANIFEST,
      environment,
      openCache: async (name) => {
        opened.push(name);
        return cache;
      },
    });

    expect(opened).toEqual([LOCAL_MODEL_CACHE_NAME_V1]);
    expect(await localCache.match(expectedUrl)).toBeInstanceOf(Response);
    expect(await localCache.match(`${expectedUrl}.unexpected`)).toBeUndefined();
    expect(environment).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      useBrowserCache: false,
      useFS: false,
      useFSCache: false,
      useCustomCache: true,
      customCache: localCache,
      experimental_useCrossOriginStorage: false,
    });
  });

  it("rejects network fallback, writes, and invalid cached length metadata", async () => {
    const environment = environmentFixture();
    const expectedUrl = localModelRemoteUrlV1(MANIFEST, "config.json");
    const localCache = await configureVerifiedLocalModelRuntimeV1({
      manifest: MANIFEST,
      environment,
      openCache: async () => ({
        async match() {
          return new Response(Uint8Array.of(1, 2), {
            headers: { "content-length": "2" },
          });
        },
        async put() { throw new Error("not used"); },
        async delete() { return false; },
      }),
    });

    await expect(environment.fetch("https://huggingface.co/anything")).rejects.toThrow(
      "Local-only model resolution rejected fetch",
    );
    await expect(localCache.put(expectedUrl, new Response())).rejects.toThrow("read-only");
    await expect(localCache.match(expectedUrl)).rejects.toThrow("length metadata");
  });
});

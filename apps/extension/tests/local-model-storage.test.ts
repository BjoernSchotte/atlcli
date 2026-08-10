import { describe, expect, it } from "bun:test";
import type { LocalModelManifestV1 } from "../utils/local-model/manifest.js";
import {
  createBrowserLocalModelPortV1,
  LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
  LOCAL_MODEL_CACHE_NAME_V1,
  localModelRemoteUrlV1,
  type LocalModelActivationStoreV1,
  type LocalModelActivationV1,
  type LocalModelCacheV1,
} from "../utils/local-model/storage.js";
import { LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1 } from "../utils/local-model/selection.js";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function fixtureManifest(sha256 = ABC_SHA256): LocalModelManifestV1 {
  return {
    schema: "atlcli.browser-local-model-manifest/v1",
    modelId: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1.modelId,
    modelRevision: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1.modelRevision,
    sourceModelId: "google/gemma-4-E4B-it",
    task: "text-generation",
    modelClass: "Gemma4ForConditionalGeneration",
    dtype: "q4f16",
    device: "webgpu",
    aggregateByteLength: 3,
    files: [{ path: "config.json", byteLength: 3, sha256 }],
    runtime: { transformersJs: "4.2.0", onnxRuntimeWeb: "test" },
    license: {
      spdx: "Apache-2.0",
      url: "https://example.invalid/license",
      attribution: "fixture",
    },
  };
}

function memoryCache(): LocalModelCacheV1 & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    async match(request) {
      const value = values.get(String(request));
      return value ? new Response(value.slice()) : undefined;
    },
    async put(request, response) {
      values.set(String(request), new Uint8Array(await response.arrayBuffer()));
    },
    async delete(request) {
      return values.delete(String(request));
    },
  };
}

function memoryActivationStore(): LocalModelActivationStoreV1 & {
  current?: LocalModelActivationV1;
} {
  return {
    current: undefined,
    async load() { return this.current; },
    async save(value) { this.current = value; },
    async clear() { this.current = undefined; },
  };
}

function chunkedAbcResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(97));
      controller.enqueue(Uint8Array.of(98, 99));
      controller.close();
    },
  }), { headers: { "content-length": "3" } });
}

describe("browser-local model installation", () => {
  it("streams, verifies, and activates the exact manifest only after cache commit", async () => {
    const manifest = fixtureManifest();
    const cache = memoryCache();
    const activationStore = memoryActivationStore();
    const states: string[] = [];
    const port = createBrowserLocalModelPortV1({
      manifest,
      fetch: async () => chunkedAbcResponse(),
      openCache: async () => cache,
      activationStore,
      estimateStorage: async () => ({ quota: 1_000_000_000, usage: 0 }),
      requestPersistence: async () => true,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    port.subscribe((state) => states.push(state.status));

    expect(await port.install()).toEqual({ status: "ready", aggregateByteLength: 3 });
    expect(states).toContain("installing");
    expect(states.at(-1)).toBe("ready");
    expect(activationStore.current).toMatchObject({
      schema: LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
      cacheName: LOCAL_MODEL_CACHE_NAME_V1,
      installedAt: "2026-08-10T12:00:00.000Z",
      aggregateByteLength: 3,
    });
    const cached = cache.values.get(localModelRemoteUrlV1(manifest, "config.json"));
    expect(cached).toEqual(Uint8Array.of(97, 98, 99));
    expect(await port.status()).toEqual({ status: "ready", aggregateByteLength: 3 });
  });

  it("fails closed and leaves no activation or corrupt cache entry", async () => {
    const manifest = fixtureManifest("0".repeat(64));
    const cache = memoryCache();
    const activationStore = memoryActivationStore();
    const port = createBrowserLocalModelPortV1({
      manifest,
      fetch: async () => chunkedAbcResponse(),
      openCache: async () => cache,
      activationStore,
    });

    expect(await port.install()).toMatchObject({
      status: "error",
      message: expect.stringContaining("digest"),
    });
    expect(activationStore.current).toBeUndefined();
    expect(cache.values.size).toBe(0);
  });

  it("refuses a ready marker when a pinned cache entry is missing", async () => {
    const manifest = fixtureManifest();
    const cache = memoryCache();
    const activationStore = memoryActivationStore();
    activationStore.current = {
      schema: LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
      selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
      cacheName: LOCAL_MODEL_CACHE_NAME_V1,
      installedAt: "2026-08-10T12:00:00.000Z",
      aggregateByteLength: 3,
      files: manifest.files,
    };
    const port = createBrowserLocalModelPortV1({
      manifest,
      fetch: async () => { throw new Error("must not fetch"); },
      openCache: async () => cache,
      activationStore,
    });

    expect(await port.status()).toMatchObject({
      status: "error",
      message: expect.stringContaining("missing"),
    });
    expect(activationStore.current).toBeUndefined();
  });
});

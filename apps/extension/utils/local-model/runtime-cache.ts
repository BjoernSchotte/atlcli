import type { LocalModelManifestV1 } from "./manifest.js";
import {
  LOCAL_MODEL_CACHE_NAME_V1,
  localModelRemoteUrlV1,
  type LocalModelCacheV1,
} from "./storage.js";

export interface TransformersLocalOnlyCacheV1 {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface TransformersLocalOnlyEnvironmentV1 {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  useBrowserCache: boolean;
  useFS: boolean;
  useFSCache: boolean;
  useCustomCache: boolean;
  // Transformers.js permits additional cache return types in Node; the
  // browser binding installed below deliberately returns only Responses.
  customCache: unknown;
  experimental_useCrossOriginStorage: boolean;
  fetch(input: string | URL, init?: unknown): Promise<unknown>;
}

export interface ConfigureLocalModelRuntimeDepsV1 {
  manifest: LocalModelManifestV1;
  environment: TransformersLocalOnlyEnvironmentV1;
  openCache(name: string): Promise<LocalModelCacheV1>;
}

export async function readVerifiedLocalModelJsonV1(input: {
  manifest: LocalModelManifestV1;
  cache: TransformersLocalOnlyCacheV1;
  path: string;
}): Promise<Record<string, unknown>> {
  const response = await input.cache.match(
    localModelRemoteUrlV1(input.manifest, input.path),
  );
  if (!response) {
    throw new Error(`Installed local model file is unavailable: ${input.path}.`);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Installed local model JSON is invalid: ${input.path}.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Installed local model JSON is invalid: ${input.path}.`);
  }
  return value as Record<string, unknown>;
}

function exactManifestUrlInventoryV1(manifest: LocalModelManifestV1): Map<string, number> {
  return new Map(
    manifest.files.map((file) => [
      localModelRemoteUrlV1(manifest, file.path),
      file.byteLength,
    ]),
  );
}

/**
 * Bind Transformers.js to the installer-owned, verified cache and disable
 * every fallback that could resolve a missing model file over the network.
 *
 * Transformers.js probes a browser-local path before its remote cache key.
 * `allowLocalModels` therefore remains true (required by `local_files_only`),
 * while the replacement `fetch` rejects that probe. A verified remote-key
 * cache hit occurs first and is the only successful resolution path.
 */
export async function configureVerifiedLocalModelRuntimeV1(
  deps: ConfigureLocalModelRuntimeDepsV1,
): Promise<TransformersLocalOnlyCacheV1> {
  const { manifest, environment } = deps;
  const cache = await deps.openCache(LOCAL_MODEL_CACHE_NAME_V1);
  const allowed = exactManifestUrlInventoryV1(manifest);
  const readOnlyCache: TransformersLocalOnlyCacheV1 = {
    async match(request) {
      const expectedLength = allowed.get(request);
      if (expectedLength === undefined) return undefined;
      const response = await cache.match(request);
      if (!response) return undefined;
      if (response.headers.get("content-length") !== String(expectedLength)) {
        throw new Error(`Installed local model length metadata is invalid for ${request}.`);
      }
      return response;
    },
    async put() {
      throw new Error("The verified local model cache is read-only during inference.");
    },
  };

  environment.allowRemoteModels = false;
  environment.allowLocalModels = true;
  environment.useBrowserCache = false;
  environment.useFS = false;
  environment.useFSCache = false;
  environment.experimental_useCrossOriginStorage = false;
  environment.useCustomCache = true;
  environment.customCache = readOnlyCache;
  environment.fetch = async (input) => {
    throw new Error(`Local-only model resolution rejected fetch: ${String(input)}`);
  };
  return readOnlyCache;
}

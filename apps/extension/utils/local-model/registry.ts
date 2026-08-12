import { env, ModelRegistry } from "@huggingface/transformers";
import type { LocalModelManifestV1 } from "./manifest.js";

export interface LocalModelRegistryPortV1 {
  getPipelineFiles(
    task: string,
    modelId: string,
    options: { dtype: string; device: string },
  ): Promise<string[]>;
  getAvailableDtypes(
    modelId: string,
    options: { revision: string },
  ): Promise<string[]>;
}

export interface LocalModelRegistryProofV1 {
  files: readonly string[];
  dtypes: readonly string[];
}

const HUGGING_FACE_ORIGIN = "https://huggingface.co";
let transformersRegistryProbeActive = false;

export function pinTransformersRegistryUrlV1(
  input: string | URL,
  modelId: string,
  revision: string,
): string | URL {
  const url = new URL(input.toString());
  const mainPrefix = `/${modelId}/resolve/main/`;
  if (url.origin !== HUGGING_FACE_ORIGIN || !url.pathname.startsWith(mainPrefix)) {
    return input;
  }
  url.pathname = `/${modelId}/resolve/${revision}/${url.pathname.slice(mainPrefix.length)}`;
  return input instanceof URL ? url : url.toString();
}

async function withPinnedTransformersRegistryV1<T>(
  manifest: LocalModelManifestV1,
  operation: (registry: LocalModelRegistryPortV1) => Promise<T>,
): Promise<T> {
  if (transformersRegistryProbeActive) {
    throw new Error("A Transformers.js model-registry probe is already active.");
  }
  transformersRegistryProbeActive = true;

  const previousFetch = env.fetch;
  const previousUseBrowserCache = env.useBrowserCache;
  const previousUseFsCache = env.useFSCache;
  const previousAllowRemoteModels = env.allowRemoteModels;
  env.fetch = (input, init) => previousFetch(
    pinTransformersRegistryUrlV1(input, manifest.modelId, manifest.modelRevision),
    init,
  );
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.allowRemoteModels = true;

  const registry: LocalModelRegistryPortV1 = {
    getPipelineFiles: (task, modelId, options) =>
      ModelRegistry.get_pipeline_files(task, modelId, {
        dtype: options.dtype as "q4f16",
        device: options.device as "webgpu",
      }),
    getAvailableDtypes: (modelId, options) =>
      ModelRegistry.get_available_dtypes(modelId, options),
  };

  try {
    return await operation(registry);
  } finally {
    env.fetch = previousFetch;
    env.useBrowserCache = previousUseBrowserCache;
    env.useFSCache = previousUseFsCache;
    env.allowRemoteModels = previousAllowRemoteModels;
    transformersRegistryProbeActive = false;
  }
}

export async function proveLocalModelManifestWithRegistryV1(
  manifest: LocalModelManifestV1,
  registry?: LocalModelRegistryPortV1,
): Promise<LocalModelRegistryProofV1> {
  const prove = async (activeRegistry: LocalModelRegistryPortV1) => {
    const [files, dtypes] = await Promise.all([
      activeRegistry.getPipelineFiles(manifest.task, manifest.modelId, {
        dtype: manifest.dtype,
        device: manifest.device,
      }),
      activeRegistry.getAvailableDtypes(manifest.modelId, {
        revision: manifest.modelRevision,
      }),
    ]);
    const expectedFiles = manifest.files.map((file) => file.path);
    const missing = expectedFiles.filter((file) => !files.includes(file));
    const extra = files.filter((file) => !expectedFiles.includes(file));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `Transformers.js model file drift: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
      );
    }
    if (!dtypes.includes(manifest.dtype)) {
      throw new Error(`Transformers.js does not expose the pinned dtype ${manifest.dtype}.`);
    }
    if (files.some((file) => /(?:audio|vision|image)/i.test(file))) {
      throw new Error("Transformers.js selected non-text model components.");
    }

    return { files, dtypes };
  };

  return registry
    ? prove(registry)
    : withPinnedTransformersRegistryV1(manifest, prove);
}

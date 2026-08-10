import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LocalModelManifestFileV1, LocalModelManifestV1 } from "./manifest.js";
import { LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1 } from "./selection.js";

export const LOCAL_MODEL_CACHE_NAME_V1 = "atlcli-browser-models-v1";
export const LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1 = "browser-local-model-active-v1";
export const LOCAL_MODEL_ACTIVATION_SCHEMA_V1 =
  "atlcli.browser-local-model-activation/v1" as const;

export type BrowserLocalModelStateV1 =
  | { status: "not-installed" }
  | {
      status: "installing";
      receivedBytes: number;
      totalBytes: number;
      currentFile: string;
    }
  | { status: "ready"; aggregateByteLength: number }
  | { status: "error"; message: string };

export interface BrowserLocalModelPortV1 {
  status(): Promise<BrowserLocalModelStateV1>;
  install(): Promise<BrowserLocalModelStateV1>;
  subscribe(listener: (state: BrowserLocalModelStateV1) => void): () => void;
}

export interface LocalModelActivationV1 {
  schema: typeof LOCAL_MODEL_ACTIVATION_SCHEMA_V1;
  selection: typeof LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1;
  cacheName: typeof LOCAL_MODEL_CACHE_NAME_V1;
  installedAt: string;
  aggregateByteLength: number;
  files: readonly LocalModelManifestFileV1[];
}

export interface LocalModelCacheV1 {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface LocalModelActivationStoreV1 {
  load(): Promise<unknown>;
  save(activation: LocalModelActivationV1): Promise<void>;
  clear(): Promise<void>;
}

export interface BrowserLocalModelInstallerDepsV1 {
  manifest: LocalModelManifestV1;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openCache(): Promise<LocalModelCacheV1>;
  activationStore: LocalModelActivationStoreV1;
  estimateStorage?(): Promise<{ quota?: number; usage?: number }>;
  requestPersistence?(): Promise<boolean>;
  now?(): Date;
}

const INSTALL_STORAGE_HEADROOM_BYTES_V1 = 256 * 1024 * 1024;

export function localModelRemoteUrlV1(
  manifest: LocalModelManifestV1,
  path: string,
): string {
  return `https://huggingface.co/${manifest.modelId}/resolve/${manifest.modelRevision}/${path}`;
}

function isExactFileInventory(
  value: unknown,
  manifest: LocalModelManifestV1,
): value is readonly LocalModelManifestFileV1[] {
  if (!Array.isArray(value) || value.length !== manifest.files.length) return false;
  return value.every((candidate, index) => {
    const expected = manifest.files[index];
    return Boolean(
      expected &&
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as LocalModelManifestFileV1).path === expected.path &&
      (candidate as LocalModelManifestFileV1).byteLength === expected.byteLength &&
      (candidate as LocalModelManifestFileV1).sha256 === expected.sha256,
    );
  });
}

function isExactLocalGemmaSelection(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1;
  return (
    Object.keys(candidate).length === Object.keys(expected).length &&
    candidate.schema === expected.schema &&
    candidate.providerId === expected.providerId &&
    candidate.modelId === expected.modelId &&
    candidate.modelRevision === expected.modelRevision &&
    candidate.dtype === expected.dtype
  );
}

export function isLocalModelActivationV1(
  value: unknown,
  manifest: LocalModelManifestV1,
): value is LocalModelActivationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<LocalModelActivationV1>;
  return (
    candidate.schema === LOCAL_MODEL_ACTIVATION_SCHEMA_V1 &&
    candidate.cacheName === LOCAL_MODEL_CACHE_NAME_V1 &&
    typeof candidate.installedAt === "string" &&
    !Number.isNaN(Date.parse(candidate.installedAt)) &&
    candidate.aggregateByteLength === manifest.aggregateByteLength &&
    isExactLocalGemmaSelection(candidate.selection) &&
    isExactFileInventory(candidate.files, manifest)
  );
}

async function verifyCachedActivationV1(
  deps: BrowserLocalModelInstallerDepsV1,
): Promise<BrowserLocalModelStateV1> {
  const activation = await deps.activationStore.load();
  if (activation === undefined || activation === null) return { status: "not-installed" };
  if (!isLocalModelActivationV1(activation, deps.manifest)) {
    await deps.activationStore.clear();
    return { status: "error", message: "The installed model record is invalid." };
  }
  const cache = await deps.openCache();
  for (const file of deps.manifest.files) {
    if (!await cache.match(localModelRemoteUrlV1(deps.manifest, file.path))) {
      await deps.activationStore.clear();
      return { status: "error", message: `The installed model is missing ${file.path}.` };
    }
  }
  return { status: "ready", aggregateByteLength: deps.manifest.aggregateByteLength };
}

async function assertStorageCapacityV1(
  deps: BrowserLocalModelInstallerDepsV1,
  missingBytes: number,
): Promise<void> {
  await deps.requestPersistence?.().catch(() => false);
  const estimate = await deps.estimateStorage?.();
  if (!estimate || estimate.quota === undefined) return;
  const free = estimate.quota - (estimate.usage ?? 0);
  const required = missingBytes === 0
    ? 0
    : missingBytes + INSTALL_STORAGE_HEADROOM_BYTES_V1;
  if (free < required) {
    throw new Error(
      `Not enough browser storage. Gemma needs ${required.toLocaleString("en-US")} free bytes.`,
    );
  }
}

async function reuseVerifiedCachedFileV1(input: {
  cache: LocalModelCacheV1;
  manifest: LocalModelManifestV1;
  file: LocalModelManifestFileV1;
}): Promise<boolean> {
  const { cache, manifest, file } = input;
  const url = localModelRemoteUrlV1(manifest, file.path);
  const response = await cache.match(url);
  if (!response?.body) return false;

  const hash = sha256.create();
  const reader = response.body.getReader();
  let fileBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      fileBytes += chunk.value.byteLength;
      if (fileBytes > file.byteLength) return false;
    }
    return fileBytes === file.byteLength && bytesToHex(hash.digest()) === file.sha256;
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function streamFileIntoCacheV1(input: {
  deps: BrowserLocalModelInstallerDepsV1;
  cache: LocalModelCacheV1;
  file: LocalModelManifestFileV1;
  previouslyReceived: number;
  onProgress(state: BrowserLocalModelStateV1): void;
}): Promise<number> {
  const { deps, cache, file, previouslyReceived, onProgress } = input;
  const url = localModelRemoteUrlV1(deps.manifest, file.path);
  const response = await deps.fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${file.path} (HTTP ${response.status}).`);
  }
  const [cacheStream, verificationStream] = response.body.tee();
  const headers = new Headers(response.headers);
  headers.set("content-length", String(file.byteLength));
  await cache.delete(url);
  const cacheWrite = cache
    .put(url, new Response(cacheStream, { status: 200, headers }))
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  const hash = sha256.create();
  const reader = verificationStream.getReader();
  let fileBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      fileBytes += chunk.value.byteLength;
      if (fileBytes > file.byteLength) {
        throw new Error(`The download for ${file.path} exceeds the pinned size.`);
      }
      onProgress({
        status: "installing",
        receivedBytes: previouslyReceived + fileBytes,
        totalBytes: deps.manifest.aggregateByteLength,
        currentFile: file.path,
      });
    }
    const cacheError = await cacheWrite;
    if (cacheError !== undefined) throw cacheError;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await cacheWrite;
    await cache.delete(url).catch(() => false);
    throw error;
  }

  if (fileBytes !== file.byteLength || bytesToHex(hash.digest()) !== file.sha256) {
    await cache.delete(url).catch(() => false);
    throw new Error(`The download digest for ${file.path} does not match the pinned manifest.`);
  }
  return fileBytes;
}

export function createBrowserLocalModelPortV1(
  deps: BrowserLocalModelInstallerDepsV1,
): BrowserLocalModelPortV1 {
  let state: BrowserLocalModelStateV1 = { status: "not-installed" };
  let installation: Promise<BrowserLocalModelStateV1> | undefined;
  const listeners = new Set<(value: BrowserLocalModelStateV1) => void>();
  const publish = (next: BrowserLocalModelStateV1): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  return {
    async status() {
      if (installation) return state;
      const next = await verifyCachedActivationV1(deps);
      publish(next);
      return next;
    },

    async install() {
      if (installation) return installation;
      installation = (async () => {
        try {
          await deps.activationStore.clear();
          const cache = await deps.openCache();
          let receivedBytes = 0;
          publish({
            status: "installing",
            receivedBytes,
            totalBytes: deps.manifest.aggregateByteLength,
            currentFile: deps.manifest.files[0]?.path ?? "",
          });
          const reusableFiles = new Set<string>();
          for (const file of deps.manifest.files) {
            if (await reuseVerifiedCachedFileV1({ cache, manifest: deps.manifest, file })) {
              reusableFiles.add(file.path);
              receivedBytes += file.byteLength;
              publish({
                status: "installing",
                receivedBytes,
                totalBytes: deps.manifest.aggregateByteLength,
                currentFile: file.path,
              });
            } else {
              await cache.delete(localModelRemoteUrlV1(deps.manifest, file.path))
                .catch(() => false);
            }
          }
          await assertStorageCapacityV1(
            deps,
            deps.manifest.aggregateByteLength - receivedBytes,
          );
          for (const file of deps.manifest.files) {
            if (reusableFiles.has(file.path)) continue;
            receivedBytes += await streamFileIntoCacheV1({
              deps,
              cache,
              file,
              previouslyReceived: receivedBytes,
              onProgress: publish,
            });
          }
          const activation: LocalModelActivationV1 = {
            schema: LOCAL_MODEL_ACTIVATION_SCHEMA_V1,
            selection: LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
            cacheName: LOCAL_MODEL_CACHE_NAME_V1,
            installedAt: (deps.now?.() ?? new Date()).toISOString(),
            aggregateByteLength: deps.manifest.aggregateByteLength,
            files: deps.manifest.files,
          };
          await deps.activationStore.save(activation);
          const ready: BrowserLocalModelStateV1 = {
            status: "ready",
            aggregateByteLength: deps.manifest.aggregateByteLength,
          };
          publish(ready);
          return ready;
        } catch (error) {
          await deps.activationStore.clear().catch(() => undefined);
          const failed: BrowserLocalModelStateV1 = {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          };
          publish(failed);
          return failed;
        } finally {
          installation = undefined;
        }
      })();
      return installation;
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
}

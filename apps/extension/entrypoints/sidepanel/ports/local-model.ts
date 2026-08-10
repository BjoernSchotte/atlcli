import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../../../utils/local-model/manifest.js";
import {
  createBrowserLocalModelPortV1,
  LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1,
  LOCAL_MODEL_CACHE_NAME_V1,
  type BrowserLocalModelPortV1,
} from "../../../utils/local-model/storage.js";

export function chromeBrowserLocalModelPortV1(): BrowserLocalModelPortV1 {
  return createBrowserLocalModelPortV1({
    manifest: LOCAL_GEMMA_G0_MANIFEST_V1,
    fetch: globalThis.fetch.bind(globalThis),
    openCache: () => caches.open(LOCAL_MODEL_CACHE_NAME_V1),
    activationStore: {
      async load() {
        const stored = await chrome.storage.local.get(
          LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1,
        );
        return stored[LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1];
      },
      async save(activation) {
        await chrome.storage.local.set({
          [LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1]: activation,
        });
      },
      async clear() {
        await chrome.storage.local.remove(LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1);
      },
    },
    estimateStorage: () => navigator.storage.estimate(),
    requestPersistence: () => navigator.storage.persist(),
  });
}

/// <reference lib="webworker" />

import {
  AutoTokenizer,
  env,
  Gemma4ForConditionalGeneration,
} from "@huggingface/transformers";
import ortJsepFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url&no-inline";
import ortJsepWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url&no-inline";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";
import { configureVerifiedLocalModelRuntimeV1 } from "../utils/local-model/runtime-cache.js";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// Both URLs are emitted by WXT into the extension package. Disabling the TJS
// WASM cache avoids its blob-module preloader, which would violate the strict
// MV3 `script-src 'self'` policy; ORT imports the packaged module directly.
const onnxWasmEnv = env.backends.onnx.wasm;
if (!onnxWasmEnv) throw new Error("ONNX Runtime Web WASM configuration is unavailable.");
onnxWasmEnv.wasmPaths = {
  mjs: ortJsepFactoryUrl,
  wasm: ortJsepWasmUrl,
};
env.useWasmCache = false;

const localOnlyRuntimeReady = configureVerifiedLocalModelRuntimeV1({
  manifest: LOCAL_GEMMA_G0_MANIFEST_V1,
  environment: env,
  openCache: async (name) => caches.open(name),
});

export const LOCAL_MODEL_RUNTIME_BOOTSTRAP_V1 = {
  transformersJs: env.version,
  onnxRuntimeWeb: LOCAL_GEMMA_G0_MANIFEST_V1.runtime.onnxRuntimeWeb,
  modelClass: Gemma4ForConditionalGeneration.name,
  tokenizerClass: AutoTokenizer.name,
  wasmFactoryUrl: ortJsepFactoryUrl,
  wasmBinaryUrl: ortJsepWasmUrl,
} as const;

workerScope.addEventListener("message", async (event: MessageEvent<unknown>) => {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    (event.data as { kind?: unknown }).kind !== "local-model:runtime-info"
  ) {
    return;
  }
  await localOnlyRuntimeReady;
  workerScope.postMessage({
    kind: "local-model:runtime-info-result",
    runtime: LOCAL_MODEL_RUNTIME_BOOTSTRAP_V1,
  });
});

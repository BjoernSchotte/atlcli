/// <reference lib="webworker" />

import {
  AutoTokenizer,
  env,
  Gemma4ForConditionalGeneration,
  InterruptableStoppingCriteria,
  TextStreamer,
} from "@huggingface/transformers";
import ortJsepFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url&no-inline";
import ortJsepWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url&no-inline";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";
import { configureVerifiedLocalModelRuntimeV1 } from "../utils/local-model/runtime-cache.js";
import { parseGemma4ResponseV1 } from "../utils/local-model/gemma-response.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  assertLocalModelGenerateRequestV1,
  localModelRequestIdV1,
  type LocalModelPortRequestV1,
  type LocalModelPortResponseV1,
  type LocalModelWorkerConnectV1,
} from "../utils/local-model/protocol.js";

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

let loadedRuntime: Promise<{
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
}> | undefined;

async function loadRuntimeV1() {
  await localOnlyRuntimeReady;
  loadedRuntime ??= (async () => {
    const options = {
      revision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
      local_files_only: true,
    } as const;
    const tokenizer = await AutoTokenizer.from_pretrained(
      LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
      options,
    );
    const model = await Gemma4ForConditionalGeneration.from_pretrained(
      LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
      {
        ...options,
        dtype: LOCAL_GEMMA_G0_MANIFEST_V1.dtype,
        device: LOCAL_GEMMA_G0_MANIFEST_V1.device,
      },
    );
    return { tokenizer, model };
  })();
  return loadedRuntime;
}

const activeCriteria = new Map<string, InterruptableStoppingCriteria>();
const cancelledRequests = new Set<string>();
let generationQueue = Promise.resolve();

function postPortV1(port: MessagePort, response: LocalModelPortResponseV1): void {
  port.postMessage(response);
}

async function generateV1(
  port: MessagePort,
  request: Extract<LocalModelPortRequestV1, { kind: "generate" }>,
): Promise<void> {
  assertLocalModelGenerateRequestV1(request);
  if (cancelledRequests.has(request.requestId)) {
    postPortV1(port, {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "error",
      requestId: request.requestId,
      code: "cancelled",
      error: "Local Gemma generation was cancelled.",
    });
    cancelledRequests.delete(request.requestId);
    return;
  }
  const { tokenizer, model } = await loadRuntimeV1();
  const inputs = tokenizer.apply_chat_template(request.messages, {
    tools: request.tools,
    add_generation_prompt: true,
    tokenize: true,
    return_tensor: true,
    return_dict: true,
  });
  const criterion = new InterruptableStoppingCriteria();
  if (cancelledRequests.has(request.requestId)) criterion.interrupt();
  activeCriteria.set(request.requestId, criterion);
  const generatedTokens: bigint[] = [];
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: () => undefined,
    token_callback_function: (tokens) => generatedTokens.push(...tokens),
  });
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: request.maxOutputTokens,
      do_sample: false,
      streamer,
      stopping_criteria: [criterion],
    });
    if (criterion.interrupted) {
      postPortV1(port, {
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "error",
        requestId: request.requestId,
        code: "cancelled",
        error: "Local Gemma generation was cancelled.",
      });
      return;
    }
    const raw = tokenizer.decode(generatedTokens, { skip_special_tokens: false });
    const parsed = parseGemma4ResponseV1({
      requestId: request.requestId,
      raw,
      allowedToolNames: new Set(request.tools.map((tool) => tool.function.name)),
    });
    postPortV1(port, {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "complete",
      requestId: request.requestId,
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      inputTokens: inputs.input_ids.dims.at(-1) ?? 0,
      outputTokens: generatedTokens.length,
    });
  } finally {
    activeCriteria.delete(request.requestId);
    cancelledRequests.delete(request.requestId);
  }
}

function connectPortV1(port: MessagePort): void {
  port.onmessage = (event: MessageEvent<unknown>) => {
    const request = event.data;
    const requestId = localModelRequestIdV1(request);
    if (
      typeof request === "object" && request !== null &&
      (request as { schema?: unknown }).schema === LOCAL_MODEL_PROTOCOL_SCHEMA_V1 &&
      (request as { kind?: unknown }).kind === "cancel" && requestId
    ) {
      cancelledRequests.add(requestId);
      activeCriteria.get(requestId)?.interrupt();
      return;
    }
    try {
      assertLocalModelGenerateRequestV1(request);
    } catch (error) {
      if (requestId) {
        postPortV1(port, {
          schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
          kind: "error",
          requestId,
          code: "invalid-request",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    generationQueue = generationQueue.then(
      () => generateV1(port, request),
      () => generateV1(port, request),
    ).catch((error) => {
      postPortV1(port, {
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "error",
        requestId: request.requestId,
        code: "model-error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  port.start();
}

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
    typeof event.data === "object" && event.data !== null &&
    (event.data as Partial<LocalModelWorkerConnectV1>).kind === "local-model:connect" &&
    (event.data as Partial<LocalModelWorkerConnectV1>).port instanceof MessagePort
  ) {
    connectPortV1((event.data as LocalModelWorkerConnectV1).port);
    return;
  }
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

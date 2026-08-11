/// <reference lib="webworker" />

import {
  env,
  Gemma4ForCausalLM,
  GemmaTokenizer,
  InterruptableStoppingCriteria,
  LogitsProcessorList,
  TextStreamer,
} from "@huggingface/transformers";
import ortWebgpuFactoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url&no-inline";
import ortWebgpuWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url&no-inline";
import { LOCAL_GEMMA_G0_MANIFEST_V1 } from "../utils/local-model/manifest.js";
import {
  localGemmaContextOverflowMessageV1,
} from
  "../utils/local-model/model-profile.js";
import {
  configureVerifiedLocalModelRuntimeV1,
  readVerifiedLocalModelJsonV1,
} from "../utils/local-model/runtime-cache.js";
import { parseGemma4ResponseV1 } from "../utils/local-model/gemma-response.js";
import {
  disposeLocalModelInputsV1,
  disposeLocalModelValueV1,
} from "../utils/local-model/runtime-lifecycle.js";
import { TokenSequenceStoppingCriteriaV1 } from
  "../utils/local-model/stopping.js";
import { RequiredToolPrefixLogitsProcessorV1 } from
  "../utils/local-model/stopping.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  assertLocalModelGenerateRequestV1,
  localModelRequestIdV1,
  type LocalModelPortRequestV1,
  type LocalModelPortResponseV1,
  type LocalModelWorkerConnectV1,
} from "../utils/local-model/protocol.js";

// Both URLs are emitted by WXT into the extension package. Disabling the TJS
// WASM cache avoids its blob-module preloader, which would violate the strict
// MV3 `script-src 'self'` policy; ORT imports the packaged module directly.
const onnxWasmEnv = env.backends.onnx.wasm;
if (!onnxWasmEnv) throw new Error("ONNX Runtime Web WASM configuration is unavailable.");
// The model runs in the extension's offscreen document. Keep ORT's WASM/JSEP
// control plane single-threaded so it does not create pthread workers around
// the WebGPU device. Besides avoiding redundant memory, this prevents V8
// atomic alignment traps observed in MV3 execution.
onnxWasmEnv.numThreads = 1;
onnxWasmEnv.proxy = false;
onnxWasmEnv.wasmPaths = {
  mjs: ortWebgpuFactoryUrl,
  wasm: ortWebgpuWasmUrl,
};
env.useWasmCache = false;

const localOnlyRuntimeReady = configureVerifiedLocalModelRuntimeV1({
  manifest: LOCAL_GEMMA_G0_MANIFEST_V1,
  environment: env,
  openCache: async (name) => caches.open(name),
});

let loadedRuntime: Promise<{
  tokenizer: GemmaTokenizer;
  model: Awaited<ReturnType<typeof Gemma4ForCausalLM.from_pretrained>>;
}> | undefined;

async function loadRuntimeV1() {
  loadedRuntime ??= (async () => {
    const cache = await localOnlyRuntimeReady;
    const options = {
      revision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
      local_files_only: true,
    } as const;
    // Transformers.js 4.1.0 tokenizer discovery probes metadata without
    // forwarding the caller's pinned revision. That default-branch probe must
    // not weaken our immutable cache boundary, so construct the known Gemma
    // tokenizer from the two already verified revision-keyed JSON artifacts.
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      readVerifiedLocalModelJsonV1({
        manifest: LOCAL_GEMMA_G0_MANIFEST_V1,
        cache,
        path: "tokenizer.json",
      }),
      readVerifiedLocalModelJsonV1({
        manifest: LOCAL_GEMMA_G0_MANIFEST_V1,
        cache,
        path: "tokenizer_config.json",
      }),
    ]);
    const tokenizer = new GemmaTokenizer(tokenizerJson, tokenizerConfig);
    // Gemma 4's repository config names the native multimodal
    // ForConditionalGeneration architecture. Loading it through the
    // Transformers.js ForCausalLM class is the library-supported text-only
    // path: it selects only embed_tokens + decoder_model_merged and does not
    // request the unused audio/vision encoders.
    const model = await Gemma4ForCausalLM.from_pretrained(
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
  const inputTokens = inputs.input_ids.dims.at(-1) ?? 0;
  const contextOverflow = localGemmaContextOverflowMessageV1(inputTokens);
  if (contextOverflow) {
    disposeLocalModelInputsV1(inputs as unknown as Record<string, unknown>);
    postPortV1(port, {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "error",
      requestId: request.requestId,
      code: "context-overflow",
      error: contextOverflow,
    });
    return;
  }
  const criterion = new InterruptableStoppingCriteria();
  const toolResponseCriterion = new TokenSequenceStoppingCriteriaV1([
    tokenizer.encode("<|tool_response>", { add_special_tokens: false }),
  ]);
  if (cancelledRequests.has(request.requestId)) criterion.interrupt();
  activeCriteria.set(request.requestId, criterion);
  const generatedTokens: bigint[] = [];
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: () => undefined,
    token_callback_function: (tokens) => generatedTokens.push(...tokens),
  });
  let output: unknown;
  const logitsProcessors = new LogitsProcessorList();
  if (request.requiredToolName) {
    logitsProcessors.push(new RequiredToolPrefixLogitsProcessorV1(
      inputTokens,
      tokenizer.encode(`<|tool_call>call:${request.requiredToolName}`, {
        add_special_tokens: false,
      }),
    ));
  }
  try {
    try {
      output = await model.generate({
        ...inputs,
        max_new_tokens: request.maxOutputTokens,
        do_sample: false,
        streamer,
        // Gemma 4 defines <|tool_response> as an additional inference stop.
        // Stop immediately after the model requests a host tool instead of
        // letting it hallucinate the unavailable result until max_new_tokens.
        stopping_criteria: [criterion, toolResponseCriterion],
        ...(request.requiredToolName ? { logits_processor: logitsProcessors } : {}),
      });
    } catch (error) {
      const footprint = request.messages.map((message) =>
        `${message.role}:${message.content.length}`
      ).join(",");
      throw new Error(
        `Local Gemma inference failed at ${inputTokens} input tokens (${footprint}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
      allowedToolNames: new Set(
        request.tools.map((tool) => tool.function.name),
      ),
    });
    postPortV1(port, {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "complete",
      requestId: request.requestId,
      text: parsed.text,
      ...(parsed.thought ? { thought: parsed.thought } : {}),
      toolCalls: parsed.toolCalls,
      inputTokens,
      outputTokens: generatedTokens.length,
    });
  } finally {
    disposeLocalModelValueV1(output);
    disposeLocalModelInputsV1(inputs as unknown as Record<string, unknown>);
    activeCriteria.delete(request.requestId);
    cancelledRequests.delete(request.requestId);
  }
}

export function connectLocalModelPortV1(port: MessagePort): void {
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
  modelClass: Gemma4ForCausalLM.name,
  tokenizerClass: GemmaTokenizer.name,
  wasmFactoryUrl: ortWebgpuFactoryUrl,
  wasmBinaryUrl: ortWebgpuWasmUrl,
} as const;

const workerScope = typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope
  ? self as unknown as DedicatedWorkerGlobalScope
  : undefined;

workerScope?.addEventListener("message", async (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === "object" && event.data !== null &&
    (event.data as Partial<LocalModelWorkerConnectV1>).kind === "local-model:connect" &&
    (event.data as Partial<LocalModelWorkerConnectV1>).port instanceof MessagePort
  ) {
    connectLocalModelPortV1((event.data as LocalModelWorkerConnectV1).port);
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

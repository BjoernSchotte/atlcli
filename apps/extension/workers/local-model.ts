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
import {
  isCompleteGemmaToolCallV1,
  LOCAL_GEMMA_FIRST_ANSWER_PREVIEW_TOKEN_V1,
  localGemmaAnswerToolPrefillV1,
  nextLocalGemmaAnswerPreviewTokenV1,
  parseGemma4ResponseV1,
  projectPartialGemmaAnswerMarkdownV1,
} from "../utils/local-model/gemma-response.js";
import {
  disposeLocalModelInputsV1,
  disposeLocalModelValueV1,
} from "../utils/local-model/runtime-lifecycle.js";
import {
  CompleteToolCallStoppingCriteriaV1,
  LOCAL_GEMMA_TOOL_STOP_MARKERS_V1,
  TokenSequenceStoppingCriteriaV1,
} from
  "../utils/local-model/stopping.js";
import { RequiredToolPrefixLogitsProcessorV1 } from
  "../utils/local-model/stopping.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  assertLocalModelGenerateRequestV1,
  localModelRequestIdV1,
  type LocalModelPortRequestV1,
  type LocalModelPortResponseV1,
  type LocalModelInferencePerformanceV1,
  type LocalModelPrewarmReceiptV1,
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
let runtimePrewarmed = false;
let prewarmPromise: Promise<LocalModelPrewarmReceiptV1> | undefined;

async function loadRuntimeV1() {
  loadedRuntime ??= (async () => {
    const startedAt = Date.now();
    console.info("[local-gemma/worker] loading verified runtime", {
      modelId: LOCAL_GEMMA_G0_MANIFEST_V1.modelId,
      revision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
      device: LOCAL_GEMMA_G0_MANIFEST_V1.device,
      dtype: LOCAL_GEMMA_G0_MANIFEST_V1.dtype,
    });
    const cache = await localOnlyRuntimeReady;
    const options = {
      revision: LOCAL_GEMMA_G0_MANIFEST_V1.modelRevision,
      local_files_only: true,
    } as const;
    // Transformers.js 4.2.0 tokenizer discovery probes metadata without
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
    console.info("[local-gemma/worker] runtime ready", {
      durationMs: Date.now() - startedAt,
    });
    return { tokenizer, model };
  })();
  return loadedRuntime;
}

const activeCriteria = new Map<string, InterruptableStoppingCriteria>();
const cancelledRequests = new Set<string>();
let generationQueue = Promise.resolve();

async function runPrewarmV1(
  queuedAt: number,
): Promise<LocalModelPrewarmReceiptV1> {
  if (runtimePrewarmed) {
    return {
      runtimeState: "already-warm",
      runtimeLoadMs: 0,
      compileMs: 0,
      totalMs: Math.max(0, performance.now() - queuedAt),
    };
  }
  const loadStartedAt = performance.now();
  const { tokenizer, model } = await loadRuntimeV1();
  const loadedAt = performance.now();
  const inputs = tokenizer.apply_chat_template([
    { role: "user", content: "Ready." },
  ], {
    add_generation_prompt: true,
    tokenize: true,
    return_tensor: true,
    return_dict: true,
  });
  let output: unknown;
  const compileStartedAt = performance.now();
  try {
    // One deterministic token exercises the embedding and decoder WebGPU
    // pipelines without using any user or tenant content.
    output = await model.generate({
      ...inputs,
      max_new_tokens: 1,
      do_sample: false,
    });
    runtimePrewarmed = true;
  } finally {
    disposeLocalModelValueV1(output);
    disposeLocalModelInputsV1(inputs as unknown as Record<string, unknown>);
  }
  const completedAt = performance.now();
  return {
    runtimeState: "prewarmed",
    runtimeLoadMs: Math.max(0, loadedAt - loadStartedAt),
    compileMs: Math.max(0, completedAt - compileStartedAt),
    totalMs: Math.max(0, completedAt - queuedAt),
  };
}

/** Preload weights and compile WebGPU kernels in this retained offscreen realm. */
export function prewarmLocalModelRuntimeV1(): Promise<LocalModelPrewarmReceiptV1> {
  if (runtimePrewarmed) {
    return Promise.resolve({
      runtimeState: "already-warm",
      runtimeLoadMs: 0,
      compileMs: 0,
      totalMs: 0,
    });
  }
  if (prewarmPromise) return prewarmPromise;
  const queuedAt = performance.now();
  const task = generationQueue.then(
    () => runPrewarmV1(queuedAt),
    () => runPrewarmV1(queuedAt),
  );
  generationQueue = task.then(() => undefined, () => undefined);
  prewarmPromise = task.finally(() => {
    prewarmPromise = undefined;
  });
  return prewarmPromise;
}

function postPortV1(port: MessagePort, response: LocalModelPortResponseV1): void {
  port.postMessage(response);
}

async function generateV1(
  port: MessagePort,
  request: Extract<LocalModelPortRequestV1, { kind: "generate" }>,
  queuedAt: number,
): Promise<void> {
  const dispatchedAt = performance.now();
  const generationStartedAt = Date.now();
  assertLocalModelGenerateRequestV1(request);
  console.info("[local-gemma/worker] generation queued", {
    requestId: request.requestId,
    requiredToolName: request.requiredToolName,
    streamAnswerPreview: request.streamAnswerPreview === true,
    thinkingMode: request.thinkingMode,
    requestedMaxOutputTokens: request.maxOutputTokens,
    tools: request.tools.map((tool) => tool.function.name),
    messages: request.messages.map((message, index) => ({
      index,
      role: message.role,
      chars: message.content.length,
      preview: message.content.slice(-320),
    })),
  });
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
  const runtimeState: LocalModelInferencePerformanceV1["runtimeState"] =
    loadedRuntime === undefined ? "cold" : "warm";
  const runtimeLoadStartedAt = performance.now();
  const { tokenizer, model } = await loadRuntimeV1();
  const runtimeLoadedAt = performance.now();
  const tokenizeStartedAt = performance.now();
  const responsePrefill = localGemmaAnswerToolPrefillV1(request);
  const chatTemplateOptions = {
    tools: request.tools,
    add_generation_prompt: true,
  } as const;
  const inputs = responsePrefill
    ? tokenizer(
        `${tokenizer.apply_chat_template(request.messages, {
          ...chatTemplateOptions,
          tokenize: false,
        })}${responsePrefill}`,
        {
          add_special_tokens: false,
          return_tensor: true,
        },
      )
    : tokenizer.apply_chat_template(request.messages, {
        ...chatTemplateOptions,
        tokenize: true,
        return_tensor: true,
        return_dict: true,
      });
  const tokenizedAt = performance.now();
  const inputTokens = inputs.input_ids.dims.at(-1) ?? 0;
  console.info("[local-gemma/worker] prompt tokenized", {
    requestId: request.requestId,
    inputTokens,
    durationMs: Date.now() - generationStartedAt,
  });
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
  const toolBoundaryCriterion = new TokenSequenceStoppingCriteriaV1(
    LOCAL_GEMMA_TOOL_STOP_MARKERS_V1.map((marker) =>
      tokenizer.encode(marker, { add_special_tokens: false })
    ),
  );
  const completeRequiredToolCriterion = request.requiredToolName
    ? new CompleteToolCallStoppingCriteriaV1(
        inputTokens,
        request.requiredToolName,
        (tokenIds) => tokenizer.decode(tokenIds, { skip_special_tokens: false }),
        responsePrefill,
      )
    : undefined;
  if (cancelledRequests.has(request.requestId)) criterion.interrupt();
  activeCriteria.set(request.requestId, criterion);
  const generatedTokens: bigint[] = [];
  let nextProgressToken = 32;
  let nextPreviewToken = LOCAL_GEMMA_FIRST_ANSWER_PREVIEW_TOKEN_V1;
  let emittedAnswerPreview = "";
  let firstTokenAt: number | undefined;
  let firstPreviewAt: number | undefined;
  let firstPreviewOutputTokens: number | undefined;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: () => undefined,
    token_callback_function: (tokens) => {
      firstTokenAt ??= performance.now();
      generatedTokens.push(...tokens);
      if (
        request.streamAnswerPreview &&
        request.requiredToolName === "ChatAnswerDraftV2" &&
        generatedTokens.length >= nextPreviewToken
      ) {
        const rawSnapshot = `${responsePrefill}${tokenizer.decode(generatedTokens, {
          skip_special_tokens: false,
        })}`;
        const markdown = projectPartialGemmaAnswerMarkdownV1(
          rawSnapshot,
          request.requiredToolName,
        );
        if (markdown && markdown !== emittedAnswerPreview) {
          const firstPreview = emittedAnswerPreview.length === 0;
          firstPreviewAt ??= performance.now();
          firstPreviewOutputTokens ??= generatedTokens.length;
          emittedAnswerPreview = markdown;
          console.debug("[local-gemma/worker] answer preview emitted", {
            requestId: request.requestId,
            firstPreview,
            outputTokens: generatedTokens.length,
            markdownChars: markdown.length,
          });
          postPortV1(port, {
            schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
            kind: "answer-preview",
            requestId: request.requestId,
            markdown,
          });
        }
        nextPreviewToken = nextLocalGemmaAnswerPreviewTokenV1(
          generatedTokens.length,
          emittedAnswerPreview.length > 0,
        );
      }
      if (generatedTokens.length < nextProgressToken) return;
      const tail = tokenizer.decode(generatedTokens.slice(-192), {
        skip_special_tokens: false,
      });
      console.debug("[local-gemma/worker] generation progress", {
        requestId: request.requestId,
        outputTokens: generatedTokens.length,
        durationMs: Date.now() - generationStartedAt,
        tail: tail.slice(-1_200),
      });
      nextProgressToken = generatedTokens.length + 32;
    },
  });
  let output: unknown;
  const logitsProcessors = new LogitsProcessorList();
  if (request.requiredToolName && !responsePrefill) {
    logitsProcessors.push(new RequiredToolPrefixLogitsProcessorV1(
      inputTokens,
      tokenizer.encode(`<|tool_call>call:${request.requiredToolName}`, {
        add_special_tokens: false,
      }),
    ));
  }
  try {
    const modelGenerationStartedAt = performance.now();
    let modelGenerationCompletedAt = modelGenerationStartedAt;
    try {
      output = await model.generate({
        ...inputs,
        max_new_tokens: request.maxOutputTokens,
        do_sample: false,
        streamer,
        // A complete native tool call is the end of this model turn. The host
        // owns execution and the following tool-result message; letting Gemma
        // continue until a hypothetical response marker can burn the entire
        // output corridor after the useful JSON is already complete.
        stopping_criteria: [
          criterion,
          toolBoundaryCriterion,
          ...(completeRequiredToolCriterion ? [completeRequiredToolCriterion] : []),
        ],
        ...(request.requiredToolName ? { logits_processor: logitsProcessors } : {}),
      });
      modelGenerationCompletedAt = performance.now();
      runtimePrewarmed = true;
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
    const raw = `${responsePrefill}${tokenizer.decode(generatedTokens, {
      skip_special_tokens: false,
    })}`;
    if (request.streamAnswerPreview &&
        request.requiredToolName === "ChatAnswerDraftV2") {
      const finalMarkdownPreview = projectPartialGemmaAnswerMarkdownV1(
        raw,
        request.requiredToolName,
      );
      if (finalMarkdownPreview && finalMarkdownPreview !== emittedAnswerPreview) {
        firstPreviewAt ??= performance.now();
        firstPreviewOutputTokens ??= generatedTokens.length;
        emittedAnswerPreview = finalMarkdownPreview;
        console.debug("[local-gemma/worker] final answer preview emitted", {
          requestId: request.requestId,
          outputTokens: generatedTokens.length,
          markdownChars: finalMarkdownPreview.length,
        });
        postPortV1(port, {
          schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
          kind: "answer-preview",
          requestId: request.requestId,
          markdown: finalMarkdownPreview,
        });
      }
      console.debug("[local-gemma/worker] answer preview projection completed", {
        requestId: request.requestId,
        enabled: request.streamAnswerPreview === true,
        outputTokens: generatedTokens.length,
        markdownChars: finalMarkdownPreview.length,
      });
    }
    console.info("[local-gemma/worker] generation stopped", {
      requestId: request.requestId,
      inputTokens,
      outputTokens: generatedTokens.length,
      durationMs: Date.now() - generationStartedAt,
      interrupted: criterion.interrupted,
      hitConfiguredLimit: generatedTokens.length >= (
        request.maxOutputTokens
      ),
      hasToolBoundary: LOCAL_GEMMA_TOOL_STOP_MARKERS_V1.some((marker) => raw.includes(marker)),
      hasCompleteRequiredTool: request.requiredToolName
        ? isCompleteGemmaToolCallV1(raw, request.requiredToolName)
        : undefined,
      rawHead: raw.slice(0, 1_200),
      rawTail: raw.slice(-1_200),
    });
    let parsed: ReturnType<typeof parseGemma4ResponseV1>;
    try {
      parsed = parseGemma4ResponseV1({
        requestId: request.requestId,
        raw,
        allowedToolNames: new Set(
          request.tools.map((tool) => tool.function.name),
        ),
      });
    } catch (error) {
      console.error("[local-gemma/worker] response parse failed", {
        requestId: request.requestId,
        requiredToolName: request.requiredToolName,
        outputTokens: generatedTokens.length,
        error: error instanceof Error ? error.message : String(error),
        rawHead: raw.slice(0, 2_000),
        rawTail: raw.slice(-2_000),
      });
      if (!request.requiredToolName) throw error;
      throw new Error(
        `Local Gemma diagnostic after ${generatedTokens.length} output tokens: ${
          error instanceof Error ? error.message : String(error)
        }; generated=${JSON.stringify(raw.slice(0, 1_600))}`,
      );
    }
    const performanceReceipt: LocalModelInferencePerformanceV1 = {
      runtimeState,
      ...(request.requiredToolName
        ? { requiredToolName: request.requiredToolName }
        : {}),
      queuedMs: Math.max(0, dispatchedAt - queuedAt),
      runtimeLoadMs: Math.max(0, runtimeLoadedAt - runtimeLoadStartedAt),
      tokenizeMs: Math.max(0, tokenizedAt - tokenizeStartedAt),
      ...(firstTokenAt === undefined
        ? {}
        : { firstTokenMs: Math.max(0, firstTokenAt - queuedAt) }),
      ...(firstPreviewAt === undefined
        ? {}
        : {
            firstPreviewMs: Math.max(0, firstPreviewAt - queuedAt),
            firstPreviewOutputTokens,
          }),
      generationMs: Math.max(0, modelGenerationCompletedAt - modelGenerationStartedAt),
      totalMs: Math.max(0, performance.now() - queuedAt),
    };
    postPortV1(port, {
      schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
      kind: "complete",
      requestId: request.requestId,
      text: parsed.text,
      ...(parsed.thought ? { thought: parsed.thought } : {}),
      toolCalls: parsed.toolCalls,
      inputTokens,
      outputTokens: generatedTokens.length,
      performance: performanceReceipt,
    });
    console.info("[local-gemma/worker] generation completed", {
      requestId: request.requestId,
      inputTokens,
      outputTokens: generatedTokens.length,
      toolCalls: parsed.toolCalls.map((call) => call.name),
      toolCallShapes: parsed.toolCalls.map((call) => {
        const blocks = Array.isArray(call.arguments.blocks)
          ? call.arguments.blocks
          : undefined;
        return {
          name: call.name,
          argumentKeys: Object.keys(call.arguments),
          blocks: blocks?.map((block) => {
            if (!block || typeof block !== "object" || Array.isArray(block)) {
              return { type: typeof block };
            }
            const candidate = block as Record<string, unknown>;
            return {
              keys: Object.keys(candidate),
              markdownChars: typeof candidate.markdown === "string"
                ? candidate.markdown.length
                : undefined,
              sourceRefs: Array.isArray(candidate.sourceRefs)
                ? candidate.sourceRefs
                : undefined,
              assertion: candidate.assertion,
              scope: candidate.scope,
            };
          }),
          gaps: Array.isArray(call.arguments.gaps)
            ? call.arguments.gaps.length
            : typeof call.arguments.gaps,
        };
      }),
      textChars: parsed.text.length,
      durationMs: Date.now() - generationStartedAt,
      performance: performanceReceipt,
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
    const queuedAt = performance.now();
    generationQueue = generationQueue.then(
      () => generateV1(port, request, queuedAt),
      () => generateV1(port, request, queuedAt),
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

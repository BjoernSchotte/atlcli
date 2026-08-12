import {
  LogitsProcessor,
  type Tensor,
  StoppingCriteria,
} from "@huggingface/transformers";
import { isCompleteGemmaToolCallV1 } from "./gemma-response.js";

/** Native Gemma tool-turn boundaries that end one model invocation. */
export const LOCAL_GEMMA_TOOL_STOP_MARKERS_V1 = [
  // The model has finished serializing the requested tool call. Waiting for a
  // later tool-response marker makes it continue generating host-owned turns.
  "<tool_call|>",
  // Defensive boundary for malformed continuations from an already-complete
  // tool request.
  "<|tool_response>",
] as const;

/**
 * Force the smallest provider-owned prefix needed to keep Gemma on the
 * selected tool grammar. Agentic eval is a local schema projection, so start
 * its required task graph before the model can prematurely serialize only an
 * optional retrieval plan.
 */
export function localGemmaRequiredToolPrefixV1(
  requiredToolName: string,
  agenticProposal = false,
): string {
  return agenticProposal
    ? "<|tool_call>call:eval{tasks:"
    : `<|tool_call>call:${requiredToolName}`;
}

/**
 * Enforce only a host-selected tool-call prefix. The model remains responsible
 * for producing schema-valid arguments; this mirrors provider tool_choice
 * without turning generated prose into a synthetic tool call.
 */
export class RequiredToolPrefixLogitsProcessorV1 extends LogitsProcessor {
  constructor(
    readonly promptTokenCount: number,
    readonly prefixTokens: readonly number[],
  ) {
    super();
    if (promptTokenCount < 1 || prefixTokens.length === 0) {
      throw new Error("A required local tool prefix needs prompt and prefix tokens.");
    }
  }

  override _call(inputIds: bigint[][], logits: Tensor): Tensor {
    const vocabularySize = logits.dims.at(-1) ?? 0;
    if (vocabularySize < 1) throw new Error("Local model logits have no vocabulary axis.");
    inputIds.forEach((ids, batchIndex) => {
      const generatedTokenCount = ids.length - this.promptTokenCount;
      const requiredToken = this.prefixTokens[generatedTokenCount];
      if (requiredToken === undefined) return;
      const offset = batchIndex * vocabularySize;
      logits.data.fill(-Infinity, offset, offset + vocabularySize);
      logits.data[offset + requiredToken] = 0;
    });
    return logits;
  }
}

/** Stop once every sequence in the batch ends in one pinned token sequence. */
export class TokenSequenceStoppingCriteriaV1 extends StoppingCriteria {
  constructor(readonly tokenSequences: readonly (readonly number[])[]) {
    super();
    if (tokenSequences.length === 0 || tokenSequences.some((value) => value.length === 0)) {
      throw new Error("A local model stop criterion requires non-empty token sequences.");
    }
  }

  override _call(inputIds: number[][]): boolean[] {
    return inputIds.map((ids) => this.tokenSequences.some((sequence) =>
      ids.length >= sequence.length && sequence.every((token, index) =>
        // Transformers.js may represent generated token IDs as number or
        // bigint depending on the underlying tensor implementation.
        ids[ids.length - sequence.length + index] == token
      )
    ));
  }
}

/** Stop a forced tool invocation once its complete argument object exists. */
export class CompleteToolCallStoppingCriteriaV1 extends StoppingCriteria {
  constructor(
    readonly promptTokenCount: number,
    readonly requiredToolName: string,
    readonly decode: (tokenIds: number[]) => string,
    readonly responsePrefix = "",
    readonly maximumImplicitObjectSeparators = 0,
    readonly maximumTrailingStructuralClosers = 0,
    readonly bareStringEnumValues: ReadonlySet<string> = new Set(),
  ) {
    super();
    if (promptTokenCount < 1 || requiredToolName.length === 0) {
      throw new Error("A complete local tool-call criterion needs a prompt and tool name.");
    }
  }

  override _call(inputIds: number[][]): boolean[] {
    return inputIds.map((ids) => isCompleteGemmaToolCallV1(
      `${this.responsePrefix}${this.decode(ids.slice(this.promptTokenCount))}`,
      this.requiredToolName,
      this.maximumImplicitObjectSeparators,
      this.maximumTrailingStructuralClosers,
      this.bareStringEnumValues,
    ));
  }
}

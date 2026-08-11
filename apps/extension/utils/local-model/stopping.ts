import {
  LogitsProcessor,
  type Tensor,
  StoppingCriteria,
} from "@huggingface/transformers";

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

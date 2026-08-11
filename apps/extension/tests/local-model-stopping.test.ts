import { describe, expect, it } from "bun:test";
import { Tensor } from "@huggingface/transformers";
import {
  CompleteToolCallStoppingCriteriaV1,
  LOCAL_GEMMA_TOOL_STOP_MARKERS_V1,
  RequiredToolPrefixLogitsProcessorV1,
  TokenSequenceStoppingCriteriaV1,
} from
  "../utils/local-model/stopping.js";

describe("Gemma required tool prefix", () => {
  it("forces only the selected prefix and then releases generation", () => {
    const processor = new RequiredToolPrefixLogitsProcessorV1(3, [2, 4]);
    const first = new Tensor("float32", new Float32Array(6).fill(1), [1, 6]);
    processor._call([[1n, 2n, 3n]], first);
    expect([...first.data]).toEqual([-Infinity, -Infinity, 0, -Infinity, -Infinity, -Infinity]);

    const second = new Tensor("float32", new Float32Array(6).fill(1), [1, 6]);
    processor._call([[1n, 2n, 3n, 2n]], second);
    expect([...second.data]).toEqual([-Infinity, -Infinity, -Infinity, -Infinity, 0, -Infinity]);

    const released = new Tensor("float32", new Float32Array(6).fill(1), [1, 6]);
    processor._call([[1n, 2n, 3n, 2n, 4n]], released);
    expect([...released.data]).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("Gemma native tool-call stopping", () => {
  it("stops a forced tool call as soon as its argument object is complete", () => {
    const prompt = [1, 2, 3];
    const partial = "<|tool_call>call:ChatAnswerDraftV2{blocks:[{markdown:<|\"|>Budget";
    const complete = `${partial}<|\"|>,sourceRefs:[],assertion:<|\"|>none<|\"|>,scope:<|\"|>none<|\"|>}],gaps:[]}`;
    const criterion = new CompleteToolCallStoppingCriteriaV1(
      prompt.length,
      "ChatAnswerDraftV2",
      (tokens) => String.fromCodePoint(...tokens),
    );

    expect(criterion._call([[...prompt, ...[...partial].map((value) => value.codePointAt(0)!)]])).toEqual([false]);
    expect(criterion._call([[...prompt, ...[...complete].map((value) => value.codePointAt(0)!)]])).toEqual([true]);
  });

  it("pins the completed native tool-call marker as a terminal boundary", () => {
    expect(LOCAL_GEMMA_TOOL_STOP_MARKERS_V1).toContain("<tool_call|>");
    const markerTokens = LOCAL_GEMMA_TOOL_STOP_MARKERS_V1.map((marker, index) =>
      marker === "<tool_call|>" ? [31, 32, 33] : [41 + index]
    );
    const criterion = new TokenSequenceStoppingCriteriaV1(markerTokens);

    expect(criterion._call([[7, 31, 32, 33]])).toEqual([true]);
    expect(criterion._call([[7, 31, 32]])).toEqual([false]);
  });

  it("stops only when a complete configured token sequence is at the tail", () => {
    const criterion = new TokenSequenceStoppingCriteriaV1([[7, 8], [11]]);

    expect(criterion._call([
      [1, 7],
      [1, 7, 8],
      [1, 11],
      [7, 8, 9],
    ])).toEqual([false, true, true, false]);
  });

  it("rejects an empty stop contract", () => {
    expect(() => new TokenSequenceStoppingCriteriaV1([])).toThrow("non-empty");
    expect(() => new TokenSequenceStoppingCriteriaV1([[]])).toThrow("non-empty");
  });
});

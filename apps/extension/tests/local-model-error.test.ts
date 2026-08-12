import { describe, expect, it } from "bun:test";
import { classifyLocalGemmaHostErrorV1 } from "../utils/local-model/error.js";

describe("local Gemma host error classification", () => {
  it("surfaces a redacted local browser-runtime detail", () => {
    expect(classifyLocalGemmaHostErrorV1(
      new TypeError("Worker startup failed with x-api-key=secret-value"),
      true,
    )).toEqual({
      code: "provider-error",
      message: "Local Gemma browser host failed: Worker startup failed with x-api-key=[REDACTED]",
    });
  });

  it("keeps the remote-provider redaction contract unchanged", () => {
    expect(classifyLocalGemmaHostErrorV1(
      new TypeError("Worker startup failed"),
      false,
    )).toEqual({
      code: "provider-error",
      message: "The research provider failed.",
    });
  });
});

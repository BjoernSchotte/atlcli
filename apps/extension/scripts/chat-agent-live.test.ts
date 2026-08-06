import { describe, expect, test } from "bun:test";
import { parseChatAgentLiveArgumentsV1 } from "./chat-agent-live.js";

describe("synthetic provider-backed Chat live harness", () => {
  test("defaults to Deep without embedding tenant input", () => {
    const parsed = parseChatAgentLiveArgumentsV1([]);
    expect(parsed.mode).toBe("deep");
    expect(parsed.question).toContain("synthetic");
    expect(parsed.exactPage).toBe(false);
    expect(parsed.summaryOnly).toBe(false);
  });

  test("accepts one explicit quality mode and rejects unknown options", () => {
    expect(parseChatAgentLiveArgumentsV1(["--thinking", "auto", "Compare", "sources"]))
      .toEqual({
        mode: "auto",
        question: "Compare sources",
        exactPage: false,
        summaryOnly: false,
      });
    expect(() => parseChatAgentLiveArgumentsV1(["--thinking", "maximum"]))
      .toThrow("--thinking must be quick, auto, or deep.");
    expect(() => parseChatAgentLiveArgumentsV1(["--private-scope"]))
      .toThrow("Unknown option");
  });

  test("selects the synthetic exact-page streaming proof", () => {
    expect(parseChatAgentLiveArgumentsV1(["--exact-page"])).toMatchObject({
      mode: "deep",
      exactPage: true,
      question: expect.stringContaining("attached synthetic Confluence page"),
    });
  });

  test("supports compact live-proof output without changing the run", () => {
    expect(parseChatAgentLiveArgumentsV1(["--summary-only", "Compare", "sources"]))
      .toMatchObject({ summaryOnly: true, question: "Compare sources" });
  });
});

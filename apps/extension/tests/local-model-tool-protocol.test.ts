import { describe, expect, it } from "bun:test";
import type {
  LocalModelChatMessageV1,
  LocalModelToolV1,
} from "../utils/local-model/protocol.js";
import {
  LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
  projectLocalGemmaToolProtocolV1,
} from "../utils/local-model/tool-protocol.js";

const tools: LocalModelToolV1[] = [
  {
    type: "function",
    function: {
      name: "eval",
      description: "Run JavaScript.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ChatAnswerDraftV2",
      parameters: { type: "object", properties: {} },
    },
  },
];

function project(system: string): LocalModelChatMessageV1[] {
  return projectLocalGemmaToolProtocolV1([
    { role: "system", content: system },
    { role: "user", content: "User question and exact opaque anchorRef." },
  ], tools);
}

describe("local Gemma prompt projection", () => {
  it("replaces the oversized direct root prompt with a bounded equivalent", () => {
    const projected = project([
      "You are Kiteweave Chat, a conversational read-only Jira and Confluence assistant.",
      "Write the user-facing answer and all provider-visible reasoning summaries in German.",
      "This is the Quick direct-only root.",
      "The host-selected conversational quality mode is quick.",
      "x".repeat(90_000),
    ].join("\n\n"));

    expect(projected[0]!.content.length).toBeLessThanOrEqual(
      LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
    );
    expect(projected[0]!.content).toContain("Write the user-facing answer in German");
    expect(projected[0]!.content).toContain(
      'invoke `eval` with `{"code":"await tools.atlassianBoundRead({anchorRef:',
    );
    expect(projected[0]!.content).toContain(
      "Never emit `tools`, `tools.atlassianBoundRead`",
    );
    expect(projected[0]!.content).toContain(
      "Never emit a tool call whose function name is `tools` or starts with `tools.`.",
    );
    expect(projected[0]!.content).toContain("call `ChatAnswerDraftV2` exactly once");
    expect(projected[0]!.content).toContain(
      "The complete list of functions you may call directly is: `eval`, `ChatAnswerDraftV2`.",
    );
    expect(projected[0]!.content).not.toContain("x".repeat(1_000));
    expect(projected[1]).toEqual({
      role: "user",
      content: "User question and exact opaque anchorRef.",
    });
  });

  it("retains the exact dynamic profile allowlist for an agentic root", () => {
    const projected = project([
      "You are Kiteweave Chat, a conversational read-only Jira and Confluence assistant.",
      "The host requires an agentic Chat workflow for this turn.",
      "For this exact turn, the complete model-selectable profile set is: exact-context-reader, comparison-analyst, answer-drafter, answer-critic, chat-synthesizer.",
      "The host-selected conversational quality mode is deep.",
      "y".repeat(90_000),
    ].join("\n\n"));

    expect(projected[0]!.content.length).toBeLessThanOrEqual(
      LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
    );
    expect(projected[0]!.content).toContain("tools.chatWorkflowPropose");
    expect(projected[0]!.content).toContain("tools.chatWorkflowRun({})");
    expect(projected[0]!.content).toContain(
      "exact-context-reader, comparison-analyst, answer-drafter, answer-critic, chat-synthesizer",
    );
    expect(projected[0]!.content).not.toContain("relationship-tracer");
    expect(projected[0]!.content).toContain(
      "host-selected conversational quality mode is deep",
    );
  });

  it("leaves specialist prompts intact and only adds the tool boundary", () => {
    const specialist = "Compare accepted claim references and return one packet.";
    const projected = project(specialist);

    expect(projected[0]!.content).toStartWith(specialist);
    expect(projected[0]!.content).toContain("Local Gemma tool-call boundary");
  });

  it("uses a smaller finalization prompt after a tool result", () => {
    const projected = projectLocalGemmaToolProtocolV1([
      {
        role: "system",
        content: [
          "You are Kiteweave Chat, a conversational read-only Jira and Confluence assistant.",
          "The host-selected conversational quality mode is quick.",
          "x".repeat(90_000),
        ].join("\n"),
      },
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "eval", arguments: { code: "return 1" } },
        }],
      },
      { role: "tool", content: "evidence", name: "eval", tool_call_id: "call-1" },
    ], tools);

    expect(projected[0]!.content.length).toBeLessThan(2_000);
    expect(projected[0]!.content).toContain("tool result already present");
    expect(projected[0]!.content).toContain("ChatAnswerDraftV2");
    expect(projected[0]!.content).toContain(
      "never use it for success, language/style commentary, or validation notes",
    );
  });

  it("uses only the terminal contract once the host selects the answer tool", () => {
    const projected = projectLocalGemmaToolProtocolV1([
      {
        role: "system",
        content: [
          "You are Kiteweave Chat, a conversational read-only Jira and Confluence assistant.",
          "Write the user-facing answer and all provider-visible reasoning summaries in German.",
          "The host-selected conversational quality mode is auto.",
          "x".repeat(90_000),
        ].join("\n"),
      },
      { role: "user", content: "Question" },
      { role: "tool", content: "evidence", name: "eval", tool_call_id: "call-1" },
    ], [tools[1]!], "low", "ChatAnswerDraftV2");

    expect(projected[0]!.content.length).toBeLessThan(1_200);
    expect(projected[0]!.content).toContain("Call `ChatAnswerDraftV2` once");
    expect(projected[0]!.content).toContain("reserve blocks for explicitly requested examples");
    expect(projected[0]!.content).toContain("at most 140 visible words and 5 blocks");
    expect(projected[0]!.content).toContain("one concise block per requested facet");
    expect(projected[0]!.content).toContain("Do not repeat the question or evidence wording");
    expect(projected[0]!.content).toContain("not a usage quota");
    expect(projected[0]!.content).toContain("Return gaps=[]");
    expect(projected[0]!.content).toContain("Return only `<|tool_call>call:ChatAnswerDraftV2`");
    expect(projected[0]!.content).not.toContain("complete list of functions");
    expect(projected[0]!.content).not.toContain("x".repeat(1_000));
  });
});

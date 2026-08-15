import { describe, expect, test } from "bun:test";
import { createMemoryResearchWorkspace } from "../workspace.js";
import { ChatContractError } from "./contracts.js";
import {
  CHAT_ANSWER_FEEDBACK_JOURNAL_PATH_V1,
  WorkspaceChatAnswerFeedbackJournalV1,
  normalizeChatAnswerFeedbackV1,
} from "./feedback.js";

describe("privacy-safe Chat answer feedback", () => {
  test("stores only closed, body-free feedback fields and replaces one turn atomically", async () => {
    const workspace = createMemoryResearchWorkspace();
    const journal = await WorkspaceChatAnswerFeedbackJournalV1.open({
      workspace,
      conversationId: "research-session:feedback",
    });

    await journal.record({
      turnId: "research-turn:one",
      rating: "not-helpful",
      reasonCodes: ["wrong-source", "incorrect", "wrong-source"],
      updatedAt: "2026-08-07T15:00:00.000Z",
    });
    const replacement = await journal.record({
      turnId: "research-turn:one",
      rating: "helpful",
      updatedAt: "2026-08-07T15:01:00.000Z",
    });

    expect(replacement).toMatchObject({
      revision: 2,
      rating: "helpful",
      reasonCodes: [],
    });
    const serialized = (await workspace.readFile(CHAT_ANSWER_FEEDBACK_JOURNAL_PATH_V1))!;
    const stored = JSON.parse(serialized);
    expect(Object.keys(stored.feedback[0]).sort()).toEqual([
      "conversationId",
      "rating",
      "reasonCodes",
      "revision",
      "schema",
      "turnId",
      "updatedAt",
    ]);
    expect(stored.feedback).toHaveLength(1);
  });

  test("rejects unknown fields, free text and unknown reason codes", () => {
    expect(() => normalizeChatAnswerFeedbackV1({
      schema: "atlcli.chat-answer-feedback/v1",
      conversationId: "research-session:feedback",
      turnId: "research-turn:one",
      revision: 1,
      updatedAt: "2026-08-07T15:00:00.000Z",
      rating: "not-helpful",
      reasonCodes: ["made-up"],
      comment: "private content",
    })).toThrow(ChatContractError);
  });

  test("rejects a journal bound to another conversation", async () => {
    const workspace = createMemoryResearchWorkspace();
    const first = await WorkspaceChatAnswerFeedbackJournalV1.open({
      workspace,
      conversationId: "research-session:first",
    });
    await first.record({
      turnId: "research-turn:one",
      rating: "helpful",
      updatedAt: "2026-08-07T15:00:00.000Z",
    });
    await expect(WorkspaceChatAnswerFeedbackJournalV1.open({
      workspace,
      conversationId: "research-session:second",
    })).rejects.toThrow("different conversation");
  });
});

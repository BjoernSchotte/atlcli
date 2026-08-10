import { describe, expect, test } from "bun:test";
import { createMemoryResearchWorkspace } from "../workspace.js";
import {
  CHAT_ACTIVITY_JOURNAL_PATH_V1,
  WorkspaceChatActivityJournalV1,
  normalizeChatActivityJournalV1,
} from "./activity.js";

describe("durable Chat activity journal", () => {
  test("replays only body-free semantic milestones after host recreation", async () => {
    const workspace = createMemoryResearchWorkspace();
    const first = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId: "conversation:activity",
    });
    const strategy = first.record({
      turnId: "turn:one",
      at: "2026-08-06T10:00:00.000Z",
      code: "strategy",
      status: "completed",
    });
    const reading = first.record({
      turnId: "turn:one",
      at: "2026-08-06T10:00:01.000Z",
      code: "direct-read",
      status: "started",
    });
    await first.flush();

    const reopened = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId: "conversation:activity",
    });
    expect(reopened.referencesForTurn("turn:one")).toEqual([strategy, reading]);
    expect(reopened.eventsForReferences([reading, strategy])).toEqual([
      expect.objectContaining({ id: strategy, code: "strategy", status: "completed" }),
      expect.objectContaining({ id: reading, code: "direct-read", status: "started" }),
    ]);
    const serialized = (await workspace.readFile(CHAT_ACTIVITY_JOURNAL_PATH_V1))!;
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("sourceBody");
    expect(serialized).not.toContain("credential");
  });

  test("rejects private or debug fields instead of retaining them", () => {
    expect(() => normalizeChatActivityJournalV1({
      schema: "atlcli.chat-activity-journal/v1",
      conversationId: "conversation:activity",
      revision: 1,
      events: [{
        schema: "atlcli.chat-activity-event/v1",
        id: "chat-activity:turn:one:1",
        conversationId: "conversation:activity",
        turnId: "turn:one",
        revision: 1,
        at: "2026-08-06T10:00:00.000Z",
        code: "strategy",
        status: "completed",
        reasoning: "private reasoning",
      }],
    })).toThrow("invalid");
  });

  test("deduplicates an identical consecutive milestone", async () => {
    const journal = await WorkspaceChatActivityJournalV1.open({
      workspace: createMemoryResearchWorkspace(),
      conversationId: "conversation:dedupe",
    });
    const first = journal.record({
      turnId: "turn:dedupe",
      at: "2026-08-06T10:00:00.000Z",
      code: "search",
      status: "started",
    });
    const duplicate = journal.record({
      turnId: "turn:dedupe",
      at: "2026-08-06T10:00:01.000Z",
      code: "search",
      status: "started",
    });
    expect(duplicate).toBe(first);
    expect(journal.referencesForTurn("turn:dedupe")).toEqual([first]);
  });

  test("can inspect a legacy conversation without creating an activity file", async () => {
    const workspace = createMemoryResearchWorkspace();
    const journal = await WorkspaceChatActivityJournalV1.open({
      workspace,
      conversationId: "conversation:legacy",
      persistIfMissing: false,
    });

    expect(journal.referencesForTurn("turn:legacy")).toEqual([]);
    expect(await workspace.readFile(CHAT_ACTIVITY_JOURNAL_PATH_V1)).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";
import { InMemoryResearchSessionStoreV1 } from "@atlcli/research";
import { openDurableChatConversationWorkspaceV1 } from "../utils/research/chat-conversation.js";

describe("durable browser chat conversation", () => {
  it("creates the owning session before opening its workspace and reuses it", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const sessionId = "research-session:chat-regression";
    const first = await openDurableChatConversationWorkspaceV1({
      store,
      sessionId,
      ownerId: "owner:browser-chat-first",
      createdAt: "2026-08-03T15:00:00.000Z",
      leaseExpiresAt: "2026-08-03T15:10:00.000Z",
    });
    await first.writeFile("/conversation/state.txt", "durable context");

    const second = await openDurableChatConversationWorkspaceV1({
      store,
      sessionId,
      ownerId: "owner:browser-chat-second",
      createdAt: "2026-08-03T15:01:00.000Z",
      leaseExpiresAt: "2026-08-03T15:11:00.000Z",
    });

    expect(await second.readFile("/conversation/state.txt")).toBe("durable context");
    expect((await store.list()).sessions).toHaveLength(1);
  });
});

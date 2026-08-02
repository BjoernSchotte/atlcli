import { describe, expect, test } from "bun:test";
import {
  RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1,
  WorkspaceResearchMessageLineageStoreV1,
} from "./message-lineage.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

describe("research message lineage store", () => {
  test("persists complete LangGraph messages and body-free host events across a fresh store", async () => {
    const workspace = createMemoryResearchWorkspace();
    const first = new WorkspaceResearchMessageLineageStoreV1(workspace);
    const messages = await first.appendMessages({
      batchId: "checkpoint:research-turn:1:wave:1",
      createdAt: "2026-08-02T10:00:00.000Z",
      links: { turnId: "research-turn:1", graphRevision: 2, packetRefs: ["packet:alpha"] },
      messages: [
        { type: "human", content: "Find the synthetic relationship." },
        { type: "ai", content: [{ type: "text", text: "I will use the bounded tools." }], tool_calls: [] },
      ],
    });
    const events = await first.appendHostEvents({
      batchId: "event-stream:research-turn:1:1",
      createdAt: "2026-08-02T10:00:01.000Z",
      links: { turnId: "research-turn:1", graphRevision: 2 },
      events: [{ kind: "phase", phase: "researching", seq: 1 }],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      schema: RESEARCH_MESSAGE_LINEAGE_EVENT_SCHEMA_V1,
      source: "langgraph",
      kind: "message",
      payloadJson: JSON.stringify({ type: "human", content: "Find the synthetic relationship." }),
    });
    expect(events[0]).toMatchObject({ source: "host", kind: "host_event" });

    const second = new WorkspaceResearchMessageLineageStoreV1(workspace);
    expect(await second.describe()).toEqual({
      eventCount: 3,
      summaryCount: 0,
      newestEventAt: "2026-08-02T10:00:01.000Z",
    });
    await expect(second.expand(messages[1]!.id)).resolves.toMatchObject({
      payloadJson: JSON.stringify({ type: "ai", content: [{ type: "text", text: "I will use the bounded tools." }], tool_calls: [] }),
      graphRevision: 2,
      packetRefs: ["packet:alpha"],
    });
  });

  test("is batch-idempotent, immutable, and leaves an interrupted index publication invisible", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    const stable = new WorkspaceResearchMessageLineageStoreV1(durableWorkspace);
    const input = {
      batchId: "checkpoint:research-turn:1:wave:1",
      createdAt: "2026-08-02T10:00:00.000Z",
      messages: [{ type: "human", content: "Original complete prompt" }],
    };
    const [event] = await stable.appendMessages(input);
    await expect(stable.appendMessages(input)).resolves.toEqual([event]);
    await expect(stable.appendMessages({ ...input, messages: [{ type: "human", content: "Mutated prompt" }] }))
      .rejects.toThrow("collides with a different event");

    let indexWrites = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      writeFile: async (path: string, contents: string) => {
        if (path === "/.atlcli/message-lineage/v1/index.json" && indexWrites++ >= 0) {
          throw new Error("injected lineage index interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const interrupted = new WorkspaceResearchMessageLineageStoreV1(interruptedWorkspace);
    await expect(interrupted.appendHostEvents({
      batchId: "event-stream:research-turn:1:2",
      createdAt: "2026-08-02T10:00:02.000Z",
      events: [{ kind: "progress", completed: 1 }],
    })).rejects.toThrow("injected lineage index interruption");
    const recovered = new WorkspaceResearchMessageLineageStoreV1(durableWorkspace);
    expect(await recovered.describe()).toEqual({
      eventCount: 1,
      summaryCount: 0,
      newestEventAt: "2026-08-02T10:00:00.000Z",
    });
  });

  test("retains a non-authoritative hierarchical summary DAG with exact event lineage", async () => {
    const store = new WorkspaceResearchMessageLineageStoreV1(createMemoryResearchWorkspace());
    const events = await store.appendMessages({
      batchId: "checkpoint:research-turn:2:wave:1",
      createdAt: "2026-08-02T11:00:00.000Z",
      links: { turnId: "research-turn:2", graphRevision: 3, artifactIds: ["artifact:brief"] },
      messages: [
        { type: "human", content: "A planted early fact is Orion." },
        { type: "tool", content: "Validated packet packet:orion." },
      ],
    });
    const turnSummary = await store.appendSummary({
      kind: "turn",
      createdAt: "2026-08-02T11:00:01.000Z",
      author: "model",
      summary: "A non-authoritative pointer says the early fact is Orion.",
      sourceEventIds: events.map((event) => event.id),
      links: { turnId: "research-turn:2", graphRevision: 3, artifactIds: ["artifact:brief"] },
    });
    const branchSummary = await store.appendSummary({
      kind: "branch",
      createdAt: "2026-08-02T11:00:02.000Z",
      author: "host",
      summary: "Closed branch summary; recover original messages through its event IDs.",
      sourceEventIds: [events[1]!.id],
      parentSummaryIds: [turnSummary.id],
      links: { turnId: "research-turn:2", graphRevision: 3, packetRefs: ["packet:orion"] },
    });
    expect(branchSummary).toMatchObject({
      nonAuthoritative: true,
      parentSummaryIds: [turnSummary.id],
      sourceEventIds: [events[1]!.id],
      packetRefs: ["packet:orion"],
    });
    await expect(store.search({ query: "orion", limit: 10 })).resolves.toMatchObject({
      exhaustive: true,
      matches: expect.arrayContaining([
        expect.objectContaining({ id: events[0]!.id, type: "event" }),
        expect.objectContaining({ id: turnSummary.id, type: "summary" }),
      ]),
    });
    await expect(store.appendSummary({
      kind: "session",
      createdAt: "2026-08-02T11:00:03.000Z",
      author: "model",
      summary: "Invalid dangling summary.",
      sourceEventIds: ["lineage-event:000000000000000000000000000000000000000000000000"],
    })).rejects.toThrow("is not retained");
  });

  test("bounds search explicitly instead of silently treating a partial scan as complete", async () => {
    const store = new WorkspaceResearchMessageLineageStoreV1(createMemoryResearchWorkspace());
    const large = "x".repeat(1_400_000);
    await store.appendMessages({
      batchId: "checkpoint:research-turn:3:wave:1",
      createdAt: "2026-08-02T12:00:00.000Z",
      messages: [
        { type: "human", content: large },
        { type: "human", content: large },
        { type: "human", content: large },
        { type: "human", content: large },
      ],
    });
    await expect(store.search({ query: "not-present" })).resolves.toMatchObject({
      matches: [],
      exhaustive: false,
    });
  });
});

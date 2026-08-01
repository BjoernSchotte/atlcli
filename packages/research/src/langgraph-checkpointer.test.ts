import { describe, expect, test } from "bun:test";
import {
  ResearchSessionMemoryCheckpointerV1,
  researchCheckpointConfigV1,
  researchThreadIdForSessionV1,
} from "./langgraph-checkpointer.js";

const sessionId = "research-session:checkpoint-test";

describe("research LangGraph checkpointer adapter", () => {
  test("derives one stable LangGraph thread ID from one durable research session", () => {
    expect(researchThreadIdForSessionV1(sessionId)).toBe("atlcli:research:research-session:checkpoint-test");
    expect(researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research", checkpointId: "checkpoint:1" }))
      .toMatchObject({ configurable: { thread_id: researchThreadIdForSessionV1(sessionId), checkpoint_ns: "research", checkpoint_id: "checkpoint:1" } });
  });

  test("supports checkpoint, pending-write, lookup, history, and bounded deletion operations", async () => {
    const saver = new ResearchSessionMemoryCheckpointerV1(sessionId);
    const config = researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" });
    const saved = await saver.put(config, {
      v: 4,
      id: "checkpoint:1",
      ts: "2026-08-01T12:00:00.000Z",
      channel_values: { durable_state: { revision: 1 } },
      channel_versions: { durable_state: 1 },
      versions_seen: {},
    }, {
      source: "input",
      step: -1,
      parents: {},
    }, { durable_state: 1 });
    await saver.putWrites(saved, [["durable_write", { revision: 2 }]], "task:checkpoint");

    const tuple = await saver.getTuple(saved);
    expect(tuple).toMatchObject({
      checkpoint: { id: "checkpoint:1", channel_values: { durable_state: { revision: 1 } } },
      pendingWrites: [["task:checkpoint", "durable_write", { revision: 2 }]],
    });
    const history = [];
    for await (const item of saver.list(config)) history.push(item);
    expect(history).toHaveLength(1);
    expect((await saver.getDeltaChannelHistory({ config: saved, channels: ["durable_write"] })).durable_write?.writes)
      .toEqual([]);

    await saver.deleteThread(researchThreadIdForSessionV1(sessionId));
    expect(await saver.getTuple(saved)).toBeUndefined();
  });

  test("rejects foreign session configs and deletes", async () => {
    const saver = new ResearchSessionMemoryCheckpointerV1(sessionId);
    const foreign = researchCheckpointConfigV1({ sessionId: "research-session:other" });
    await expect(saver.getTuple(foreign)).rejects.toThrow("outside the research session thread");
    await expect(saver.deleteThread(researchThreadIdForSessionV1("research-session:other"))).rejects.toThrow("outside the research session thread");
  });
});

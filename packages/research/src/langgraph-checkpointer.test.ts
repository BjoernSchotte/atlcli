import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { createDeepAgent } from "deepagents/node";
import {
  ResearchSessionMemoryCheckpointerV1,
} from "./langgraph-checkpointer.js";
import { ResearchSessionWorkspaceCheckpointerV1 } from "./workspace-checkpointer.js";
import { createMemoryResearchWorkspace } from "./workspace.js";
import {
  researchCheckpointConfigV1,
  researchThreadIdForSessionV1,
} from "./checkpoint-identity.js";

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

  test("replays checkpoint and pending-write bytes from a durable workspace after a host restart", async () => {
    const workspace = createMemoryResearchWorkspace();
    const config = researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" });
    const firstHost = new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace);
    const saved = await firstHost.put(config, {
      v: 4,
      id: "checkpoint:durable-1",
      ts: "2026-08-01T12:00:00.000Z",
      channel_values: { durable_state: { revision: 1, note: "resumable" } },
      channel_versions: { durable_state: 1 },
      versions_seen: {},
    }, {
      source: "input",
      step: -1,
      parents: {},
    });
    await firstHost.putWrites(saved, [["durable_write", { revision: 2 }]], "task:durable");

    const secondHost = new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace);
    await expect(secondHost.getTuple(saved)).resolves.toMatchObject({
      checkpoint: { id: "checkpoint:durable-1", channel_values: { durable_state: { note: "resumable" } } },
      pendingWrites: [["task:durable", "durable_write", { revision: 2 }]],
    });
    expect(await workspace.list("/.atlcli/langgraph-checkpoints/v1")).not.toHaveLength(0);
  });

  test("restores one native DeepAgent conversation in a fresh host for the same session thread", async () => {
    const workspace = createMemoryResearchWorkspace();
    const threadId = researchThreadIdForSessionV1(sessionId);
    const firstModel = fakeModel().respond(new AIMessage("First durable answer."));
    const firstHost = createDeepAgent({
      name: "research-thread-proof",
      model: firstModel,
      checkpointer: new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace),
      tools: [],
    });
    await firstHost.invoke(
      { messages: [new HumanMessage("First durable user turn.")] },
      { configurable: { thread_id: threadId } },
    );

    const resumedModel = fakeModel().respond(new AIMessage("Second durable answer."));
    const resumedHost = createDeepAgent({
      name: "research-thread-proof",
      model: resumedModel,
      checkpointer: new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace),
      tools: [],
    });
    await resumedHost.invoke(
      { messages: [new HumanMessage("Second durable user turn.")] },
      { configurable: { thread_id: threadId } },
    );

    const resumedInput = resumedModel.calls[0]?.messages ?? [];
    expect(resumedInput.map((message) => message.text)).toEqual([
      "First durable user turn.",
      "First durable answer.",
      "Second durable user turn.",
    ]);
  });

  test("fails closed when a workspace checkpoint index belongs to another session", async () => {
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile("/.atlcli/langgraph-checkpoints/v1/index.json", JSON.stringify({
      schema: "atlcli.research-langgraph-workspace-checkpoints/v1",
      threadId: researchThreadIdForSessionV1("research-session:other"),
      payloadBytes: 0,
      operations: [],
    }));
    const saver = new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace);
    await expect(saver.getTuple(researchCheckpointConfigV1({ sessionId }))).rejects.toThrow("does not match this research session");
  });

  test("retains the prior complete checkpoint when publishing a later index fails", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    let indexWrites = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      async writeFile(path: string, contents: string) {
        if (path === "/.atlcli/langgraph-checkpoints/v1/index.json" && indexWrites++ > 0) {
          throw new Error("injected checkpoint index interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const config = researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" });
    const saver = new ResearchSessionWorkspaceCheckpointerV1(sessionId, interruptedWorkspace);
    const first = await saver.put(config, {
      v: 4,
      id: "checkpoint:complete-1",
      ts: "2026-08-01T12:00:00.000Z",
      channel_values: { durable_state: { revision: 1 } },
      channel_versions: { durable_state: 1 },
      versions_seen: {},
    }, { source: "input", step: -1, parents: {} });
    await expect(saver.put(first, {
      v: 4,
      id: "checkpoint:interrupted-2",
      ts: "2026-08-01T12:00:01.000Z",
      channel_values: { durable_state: { revision: 2 } },
      channel_versions: { durable_state: 2 },
      versions_seen: {},
    }, { source: "loop", step: 0, parents: {} })).rejects.toThrow("injected checkpoint index interruption");

    const recovered = new ResearchSessionWorkspaceCheckpointerV1(sessionId, durableWorkspace);
    await expect(recovered.getTuple(config)).resolves.toMatchObject({
      checkpoint: { id: "checkpoint:complete-1", channel_values: { durable_state: { revision: 1 } } },
    });
  });
});

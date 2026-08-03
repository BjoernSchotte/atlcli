import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { fakeModel } from "@langchain/core/testing";
import { createDeepAgent, createSummarizationMiddleware } from "deepagents/node";
import { createResearchDurableSummarizationMiddleware } from "./agent-runtime-core.js";
import {
  ResearchSessionMemoryCheckpointerV1,
} from "./langgraph-checkpointer.js";
import { ResearchSessionWorkspaceCheckpointerV1 } from "./workspace-checkpointer.js";
import { createMemoryResearchWorkspace } from "./workspace.js";
import {
  researchCheckpointConfigV1,
  researchSupervisorThreadIdForSessionV1,
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

  test("isolates and replays one host-authorized supervisor phase", async () => {
    const workspace = createMemoryResearchWorkspace();
    const phaseId = "continuation:research-continuation:1.1";
    const threadId = researchSupervisorThreadIdForSessionV1(sessionId, phaseId);
    const config: RunnableConfig = { configurable: { thread_id: threadId } };
    const firstHost = new ResearchSessionWorkspaceCheckpointerV1(
      sessionId,
      workspace,
      { supervisorPhaseId: phaseId },
    );
    const saved = await firstHost.put(config, {
      v: 4,
      id: "checkpoint:supervisor-phase",
      ts: "2026-08-03T12:00:00.000Z",
      channel_values: { evaluator: { stage: "continuation" } },
      channel_versions: { evaluator: 1 },
      versions_seen: {},
    }, { source: "input", step: -1, parents: {} });

    const resumedHost = new ResearchSessionWorkspaceCheckpointerV1(
      sessionId,
      workspace,
      { supervisorPhaseId: phaseId },
    );
    await expect(resumedHost.getTuple(saved)).resolves.toMatchObject({
      checkpoint: {
        id: "checkpoint:supervisor-phase",
        channel_values: { evaluator: { stage: "continuation" } },
      },
    });
    const initialHost = new ResearchSessionWorkspaceCheckpointerV1(
      sessionId,
      workspace,
      { supervisorPhaseId: "initial" },
    );
    await expect(initialHost.getTuple({
      configurable: {
        thread_id: researchSupervisorThreadIdForSessionV1(sessionId, "initial"),
      },
    })).resolves.toBeUndefined();
  });

  test("compacts completed checkpoint history without losing the newest restart point", async () => {
    const workspace = createMemoryResearchWorkspace();
    const canonicalEvidence = JSON.stringify({
      schema: "atlcli.research-evidence-record/v1",
      id: "evidence:compaction-proof",
      fact: "Canonical evidence remains outside the LangGraph journal.",
    });
    const acceptedReport = "# Accepted report\n\n## Sources\n\n1. Canonical evidence\n";
    await workspace.writeFile("/.atlcli/evidence/v1/records/evidence-compaction-proof.json", canonicalEvidence);
    await workspace.writeFile("/artifacts/report.md", acceptedReport);
    const saver = new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace);
    let config: RunnableConfig = researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" });

    for (let index = 0; index <= 2_000; index += 1) {
      const checkpointId = `checkpoint:tail-${String(index).padStart(4, "0")}`;
      config = await saver.put(config, {
        v: 4,
        id: checkpointId,
        ts: `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        channel_values: { durable_state: { index } },
        channel_versions: { durable_state: index + 1 },
        versions_seen: {},
      }, {
        source: "loop",
        step: index,
        parents: {},
      });
    }

    const indexContents = await workspace.readFile("/.atlcli/langgraph-checkpoints/v1/index.json");
    const compacted = JSON.parse(indexContents ?? "{}") as { operations?: unknown[] };
    expect(compacted.operations?.length).toBeLessThanOrEqual(64);

    const resumed = new ResearchSessionWorkspaceCheckpointerV1(sessionId, workspace);
    await expect(resumed.getTuple(researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" })))
      .resolves.toMatchObject({
        checkpoint: {
          id: "checkpoint:tail-2000",
          channel_values: { durable_state: { index: 2_000 } },
        },
      });
    expect(await workspace.readFile("/.atlcli/evidence/v1/records/evidence-compaction-proof.json"))
      .toBe(canonicalEvidence);
    expect(await workspace.readFile("/artifacts/report.md")).toBe(acceptedReport);
  });

  test("recovers the last complete checkpoint when compacted-index publication is interrupted", async () => {
    const durableWorkspace = createMemoryResearchWorkspace();
    let indexWrites = 0;
    const interruptedWorkspace = {
      readFile: (path: string) => durableWorkspace.readFile(path),
      async writeFile(path: string, contents: string) {
        // The first 2,000 appends are complete. The next write attempts the
        // replacement index after it has prepared a compacted journal.
        if (path === "/.atlcli/langgraph-checkpoints/v1/index.json" && indexWrites++ >= 2_000) {
          throw new Error("injected compacted index interruption");
        }
        await durableWorkspace.writeFile(path, contents);
      },
      remove: (path: string) => durableWorkspace.remove(path),
      list: (prefix?: string) => durableWorkspace.list(prefix),
    };
    const baseConfig = researchCheckpointConfigV1({ sessionId, checkpointNamespace: "research" });
    const saver = new ResearchSessionWorkspaceCheckpointerV1(sessionId, interruptedWorkspace);
    let config: RunnableConfig = baseConfig;
    for (let index = 0; index < 2_000; index += 1) {
      config = await saver.put(config, {
        v: 4,
        id: `checkpoint:complete-${String(index).padStart(4, "0")}`,
        ts: "2026-08-01T12:00:00.000Z",
        channel_values: { durable_state: { index } },
        channel_versions: { durable_state: index + 1 },
        versions_seen: {},
      }, { source: "loop", step: index, parents: {} });
    }

    await expect(saver.put(config, {
      v: 4,
      id: "checkpoint:interrupted-compaction",
      ts: "2026-08-01T12:00:01.000Z",
      channel_values: { durable_state: { index: 2_000 } },
      channel_versions: { durable_state: 2_001 },
      versions_seen: {},
    }, { source: "loop", step: 2_000, parents: {} })).rejects.toThrow("injected compacted index interruption");

    const recovered = new ResearchSessionWorkspaceCheckpointerV1(sessionId, durableWorkspace);
    await expect(recovered.getTuple(baseConfig)).resolves.toMatchObject({
      checkpoint: {
        id: "checkpoint:complete-1999",
        channel_values: { durable_state: { index: 1_999 } },
      },
    });

    const recovery = await recovered.put(baseConfig, {
      v: 4,
      id: "checkpoint:recovered-after-compaction",
      ts: "2026-08-01T12:00:02.000Z",
      channel_values: { durable_state: { index: 2_001 } },
      channel_versions: { durable_state: 2_002 },
      versions_seen: {},
    }, { source: "loop", step: 2_001, parents: {} });
    const freshHost = new ResearchSessionWorkspaceCheckpointerV1(sessionId, durableWorkspace);
    await expect(freshHost.getTuple(recovery)).resolves.toMatchObject({
      checkpoint: {
        id: "checkpoint:recovered-after-compaction",
        channel_values: { durable_state: { index: 2_001 } },
      },
    });
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

  test("runs one thousand native DeepAgents turns across fresh hosts with compact durable checkpoints", async () => {
    const durableSessionId = "research-session:one-thousand-turns";
    const workspace = createMemoryResearchWorkspace();
    const threadId = researchThreadIdForSessionV1(durableSessionId);
    const mainModel = fakeModel();
    const summaryModel = fakeModel();
    // The fresh resume can prompt the native agent twice while it restores a
    // completed checkpoint, so queue a small deterministic tail as well.
    for (let index = 0; index <= 1_127; index += 1) {
      mainModel.respond(new AIMessage(`Synthetic answer ${index + 1}.`));
    }
    for (let index = 0; index < 64; index += 1) {
      summaryModel.respond(new AIMessage(`Synthetic operational summary ${index + 1}.`));
    }
    const createHost = () => createDeepAgent({
      name: "research-one-thousand-turn-proof",
      model: mainModel,
      checkpointer: new ResearchSessionWorkspaceCheckpointerV1(durableSessionId, workspace),
      tools: [],
      middleware: [createResearchDurableSummarizationMiddleware(
        { createSummarizationMiddleware },
        { workspace, model: summaryModel },
      )],
    });
    let host = createHost();

    for (let index = 1; index <= 1_000; index += 1) {
      await host.invoke({
        messages: [new HumanMessage(
          `Turn ${index}: durable fact marker ORION-${String(index).padStart(4, "0")}.`,
        )],
      }, { configurable: { thread_id: threadId } });
      // A new saver and graph emulate a resumed CLI process or a restarted
      // MV3 worker, while the workspace remains the only durable owner.
      if (index % 100 === 0 && index < 1_000) host = createHost();
    }

    const indexContents = await workspace.readFile("/.atlcli/langgraph-checkpoints/v1/index.json");
    const checkpointIndex = JSON.parse(indexContents ?? "{}") as {
      operations?: Array<{ id?: string }>;
    };
    const visibleContext = mainModel.calls.map((call) => new TextEncoder().encode(
      call.messages.map((message) => String(message.content)).join("\n"),
    ).byteLength);
    expect(mainModel.callCount).toBeGreaterThanOrEqual(1_000);
    expect(mainModel.callCount).toBeLessThanOrEqual(1_100);
    expect(Math.max(...visibleContext)).toBeLessThanOrEqual(48_000);
    expect(checkpointIndex.operations?.length).toBeLessThanOrEqual(2_000);
    expect(checkpointIndex.operations?.some((entry) => Number.parseInt(
      entry.id?.slice("operation-".length) ?? "0",
      10,
    ) > 2_000)).toBe(true);
    expect(await workspace.list("/.atlcli/deepagents-summarization/v1")).not.toHaveLength(0);

    const resumedHost = createHost();
    const callsBeforeResume = mainModel.callCount;
    await resumedHost.invoke(
      { messages: [new HumanMessage("Recover the current durable marker after restart.")] },
      { configurable: { thread_id: threadId } },
    );
    const resumedInputs = mainModel.calls.slice(callsBeforeResume).map((call) =>
      call.messages.map((message) => message.text).join("\n"),
    );
    expect(resumedInputs.some((input) => input.includes("ORION-1000"))).toBe(true);
  }, 120_000);

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

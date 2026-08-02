import { afterEach, describe, expect, test } from "bun:test";
import { ReplSession } from "@langchain/quickjs";
import {
  DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY,
  RESEARCH_TASK_ID_CONFIG_KEY,
  ResearchDispatchError,
  createResearchDispatchInterceptionAdapter,
  encodeResearchTaskDescriptionV1,
  type ResearchDispatchDiagnosticV1,
  type ResearchTaskAdmissionV1,
} from "@atlcli/research";
import { runDeclarativeDispatchCharacterization } from "./research/dispatch-adapter-declarative-harness.js";

const PACKET_SCHEMA = {
  title: "DispatchPacketV1",
  type: "object",
  additionalProperties: false,
  required: ["taskId", "answer"],
  properties: {
    taskId: { type: "string" },
    answer: { type: "string" },
  },
};

function admission(
  taskId: string,
  grants: readonly string[] = [],
  overrides: Partial<ResearchTaskAdmissionV1> = {},
): ResearchTaskAdmissionV1 {
  return {
    taskId,
    subagentType: "focused-researcher",
    grantedCapabilityIds: grants,
    responseSchema: PACKET_SCHEMA,
    maxResultBytes: 1_024,
    maxDurationMs: 5_000,
    ...overrides,
  };
}

function guestTask(taskId: string): string {
  return `task({ description: ${JSON.stringify(encodeResearchTaskDescriptionV1({
    taskId,
    objective: `Research ${taskId}`,
  }))}, subagentType: "focused-researcher", responseSchema: ${JSON.stringify(PACKET_SCHEMA)} })`;
}

function sessionFor(
  adapter: ReturnType<typeof createResearchDispatchInterceptionAdapter>,
  maxConcurrency = 4,
): ReplSession {
  return new ReplSession(`dispatch-adapter-${crypto.randomUUID()}`, {
    captureConsole: false,
    subagentBridge: {
      maxConcurrency,
      dispatch: ({ description, subagentType, responseSchema }) =>
        adapter.invoke(
          { description, subagent_type: subagentType },
          {
            configurable: {
              [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: responseSchema,
            },
          },
        ),
    },
  });
}

afterEach(() => {
  ReplSession.clearCache();
  ReplSession.resetSharedModule();
});

describe("research-owned native task dispatch interception", () => {
  test("replaces candidate admissions exactly once before dispatch observation", async () => {
    const calls: string[] = [];
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("candidate")],
      maxTasks: 2,
      maxConcurrency: 1,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        calls.push(taskId);
        return { taskId, answer: "accepted" };
      },
    });
    adapter.replaceAdmissions([admission("selected", [], {
      objective: "Research selected",
    })]);
    await expect(adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: "selected",
        objective: "Research selected",
      }),
      subagent_type: "focused-researcher",
    }, {
      configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
    })).resolves.toEqual({ taskId: "selected", answer: "accepted" });
    expect(calls).toEqual(["selected"]);
    expect(() => adapter.replaceAdmissions([admission("late")]))
      .toThrow("immutable after dispatch observation");
  });

  test("awaits durable admission before upstream work and durable result acceptance before publication", async () => {
    const lifecycle: string[] = [];
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("durable-task")],
      maxTasks: 1,
      maxConcurrency: 1,
      beforeInvoke: async ({ taskId }) => {
        lifecycle.push(`admit:${taskId}`);
        await Promise.resolve();
        lifecycle.push(`started:${taskId}`);
      },
      async invokeUpstream(_input, config) {
        lifecycle.push(`upstream:${String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY])}`);
        return { taskId: "durable-task", answer: "accepted" };
      },
      async projectResult(value) {
        lifecycle.push("normalizing");
        await Promise.resolve();
        lifecycle.push("normalized");
        return { ...value as Record<string, unknown>, answer: "accepted-by-host" };
      },
      acceptResult: async (taskId) => {
        lifecycle.push(`accept:${taskId}`);
        await Promise.resolve();
        lifecycle.push(`committed:${taskId}`);
      },
    });

    await expect(adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: "durable-task",
        objective: "Research durable-task",
      }),
      subagent_type: "focused-researcher",
    }, {
      configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
    })).resolves.toEqual({ taskId: "durable-task", answer: "accepted" });

    expect(lifecycle).toEqual([
      "admit:durable-task",
      "started:durable-task",
      "upstream:durable-task",
      "normalizing",
      "normalized",
      "accept:durable-task",
      "committed:durable-task",
    ]);
    expect(adapter.snapshot().taskStatuses["durable-task"]).toBe("completed");
  });

  test("does not start provider work when durable admission fails", async () => {
    let upstreamCalls = 0;
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("journal-failure")],
      maxTasks: 1,
      maxConcurrency: 1,
      beforeInvoke: () => {
        throw new Error("durable store unavailable");
      },
      async invokeUpstream() {
        upstreamCalls += 1;
        return { taskId: "journal-failure", answer: "must not run" };
      },
    });

    await expect(adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: "journal-failure",
        objective: "Research journal-failure",
      }),
      subagent_type: "focused-researcher",
    }, {
      configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
    })).rejects.toThrow("durable store unavailable");
    expect(upstreamCalls).toBe(0);
    expect(adapter.snapshot().taskStatuses["journal-failure"]).toBe("failed");
  });

  test("validates replacement dependencies and locks after a rejected observation", async () => {
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("candidate")],
      maxTasks: 2,
      maxConcurrency: 1,
      async invokeUpstream() {
        return { taskId: "candidate", answer: "unused" };
      },
    });
    expect(() => adapter.replaceAdmissions([
      admission("dependent", [], { dependsOnTaskIds: ["missing"] }),
    ])).toThrow("Invalid research task dependencies");
    await expect(adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: "unknown",
        objective: "Research unknown",
      }),
      subagent_type: "focused-researcher",
    }, {
      configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
    })).rejects.toMatchObject({ code: "unknown-task" });
    expect(() => adapter.replaceAdmissions([admission("replacement")]))
      .toThrow("immutable after dispatch observation");
  });

  test("validates host task IDs and counts task dispatches outside maxPtcCalls", async () => {
    const calls: string[] = [];
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("task-1"), admission("task-2")],
      maxTasks: 1,
      maxConcurrency: 2,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        calls.push(taskId);
        return { taskId, answer: "bounded" };
      },
    });
    const session = sessionFor(adapter);
    try {
      expect(await session.eval(`${guestTask("task-1")}`, 5_000)).toMatchObject({
        ok: true,
        value: { taskId: "task-1", answer: "bounded" },
      });
      const overBudget = await session.eval(`${guestTask("task-2")}`, 5_000);
      expect(overBudget.ok).toBe(false);
      expect(overBudget.error?.message).toContain("task budget exceeded");

      const unknown = await session.eval(`${guestTask("invented-task")}`, 5_000);
      expect(unknown.ok).toBe(false);
      expect(unknown.error?.message).toContain("not admitted");
      expect(calls).toEqual(["task-1"]);
      expect(adapter.snapshot().dispatchedTasks).toBe(1);
      const duplicate = await session.eval(`${guestTask("task-1")}`, 5_000);
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error?.message).toContain("already dispatched");
      expect(adapter.snapshot().taskStatuses["task-1"]).toBe("completed");
    } finally {
      session.dispose();
    }
  });

  test("admits concurrency before upstream work begins", async () => {
    let upstreamCalls = 0;
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("parallel-1"), admission("parallel-2")],
      maxTasks: 2,
      maxConcurrency: 1,
      async invokeUpstream(_input, config) {
        upstreamCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        return {
          taskId: String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]),
          answer: "bounded",
        };
      },
    });
    const session = sessionFor(adapter, 2);
    try {
      const result = await session.eval(
        `await Promise.all([${guestTask("parallel-1")}, ${guestTask("parallel-2")}])`,
        5_000,
      );
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("concurrency exceeded");
      expect(upstreamCalls).toBe(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } finally {
      session.dispose();
    }
  });

  test("rejects an oversized task result before it reaches the guest", async () => {
    const diagnostics: ResearchDispatchDiagnosticV1[] = [];
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("large-result", [], { maxResultBytes: 64 })],
      maxTasks: 1,
      maxConcurrency: 1,
      async invokeUpstream() {
        return { taskId: "large-result", answer: "x".repeat(200) };
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = sessionFor(adapter);
    try {
      const result = await session.eval(`${guestTask("large-result")}`, 5_000);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("exceeds 64 bytes");
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          taskId: "large-result",
          status: "failed",
          code: "result-too-large",
        }),
      );
    } finally {
      session.dispose();
    }
  });

  test("classifies upstream subagent failures without exposing provider details", async () => {
    const diagnostics: ResearchDispatchDiagnosticV1[] = [];
    const outcomes: string[] = [];
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("provider-failure")],
      maxTasks: 1,
      maxConcurrency: 1,
      async invokeUpstream() {
        throw new Error("private provider response body");
      },
      onUncommittedOutcome: ({ reason }) => {
        outcomes.push(reason);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = sessionFor(adapter);
    try {
      const result = await session.eval(`${guestTask("provider-failure")}`, 5_000);
      expect(result.ok).toBe(false);
      expect(diagnostics).toContainEqual({
        taskId: "provider-failure",
        status: "failed",
        code: "subagent-provider-error",
      });
      expect(JSON.stringify(diagnostics)).not.toContain("private provider response body");
      expect(outcomes).toEqual(["upstream-error"]);
    } finally {
      session.dispose();
    }
  });

  test("propagates abort and quarantines a deliberately late result", async () => {
    const controller = new AbortController();
    const diagnostics: ResearchDispatchDiagnosticV1[] = [];
    const outcomes: string[] = [];
    const lateOutcomes: string[] = [];
    let upstreamSignalAborted = false;
    let upstreamStarted!: () => void;
    const upstreamReady = new Promise<void>((resolve) => {
      upstreamStarted = resolve;
    });
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("late-task")],
      maxTasks: 1,
      maxConcurrency: 1,
      signal: controller.signal,
      async invokeUpstream(_input, config) {
        config.signal?.addEventListener(
          "abort",
          () => {
            upstreamSignalAborted = true;
          },
          { once: true },
        );
        upstreamStarted();
        await late;
        return { taskId: "late-task", answer: "too late" };
      },
      onUncommittedOutcome: ({ reason }) => {
        outcomes.push(reason);
      },
      onLateResult: ({ taskId }) => {
        lateOutcomes.push(taskId);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = sessionFor(adapter);
    try {
      const evaluation = session.eval(`${guestTask("late-task")}`, 5_000);
      await upstreamReady;
      controller.abort("operator-cancelled");
      const result = await evaluation;
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("was aborted");
      expect(upstreamSignalAborted).toBe(true);
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(diagnostics.map(({ status }) => status)).toEqual([
        "started",
        "cancelled",
        "quarantined",
      ]);
      expect(adapter.snapshot().taskStatuses["late-task"]).toBe("quarantined");
      expect(outcomes).toEqual(["aborted"]);
      expect(lateOutcomes).toEqual(["late-task"]);
    } finally {
      session.dispose();
    }
  });

  test("classifies a host timeout and quarantines its deliberately late result", async () => {
    const diagnostics: ResearchDispatchDiagnosticV1[] = [];
    let upstreamSignalAborted = false;
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [admission("timeout-task", [], { maxDurationMs: 10 })],
      maxTasks: 1,
      maxConcurrency: 1,
      async invokeUpstream(_input, config) {
        config.signal?.addEventListener(
          "abort",
          () => {
            upstreamSignalAborted = true;
          },
          { once: true },
        );
        await late;
        return { taskId: "timeout-task", answer: "too late" };
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = sessionFor(adapter);
    try {
      const result = await session.eval(`${guestTask("timeout-task")}`, 5_000);
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("timed out after 10 ms");
      expect(upstreamSignalAborted).toBe(true);
      expect(diagnostics).toEqual([
        { taskId: "timeout-task", status: "started" },
        { taskId: "timeout-task", status: "cancelled", code: "timeout" },
      ]);

      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(diagnostics.at(-1)).toEqual(expect.objectContaining({
        taskId: "timeout-task",
        status: "quarantined",
        code: "late-result",
      }));
      expect(adapter.snapshot().taskStatuses["timeout-task"]).toBe("quarantined");
    } finally {
      session.dispose();
    }
  });

  test("keeps disjoint grants isolated for two nodes using the same role", async () => {
    const providerCalls = { jira: 0, wiki: 0 };
    const denied: string[] = [];
    let adapter!: ReturnType<typeof createResearchDispatchInterceptionAdapter>;
    adapter = createResearchDispatchInterceptionAdapter({
      admissions: [
        admission("jira-node", ["jira.issue.search"]),
        admission("wiki-node", ["wiki.search"]),
      ],
      maxTasks: 2,
      maxConcurrency: 2,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        for (const [capability, provider] of [
          ["jira.issue.search", "jira"],
          ["wiki.search", "wiki"],
        ] as const) {
          try {
            adapter.assertCapability(taskId, capability);
            providerCalls[provider] += 1;
          } catch (error) {
            expect(error).toBeInstanceOf(ResearchDispatchError);
            denied.push(`${taskId}:${capability}`);
          }
        }
        return { taskId, answer: "grant checked" };
      },
    });
    const session = sessionFor(adapter, 2);
    try {
      const result = await session.eval(
        `await Promise.all([${guestTask("jira-node")}, ${guestTask("wiki-node")}])`,
        5_000,
      );
      expect(result.ok).toBe(true);
      expect(providerCalls).toEqual({ jira: 1, wiki: 1 });
      expect(denied.sort()).toEqual([
        "jira-node:wiki.search",
        "wiki-node:jira.issue.search",
      ]);
    } finally {
      session.dispose();
    }
  });

  test("admits a dependency only after completion and only with its unchanged typed result", async () => {
    const firstResult = { taskId: "first", answer: "accepted packet" };
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [
        admission("first", [], { objective: "Research first" }),
        admission("dependent", [], {
          objective: "Research dependent",
          dependsOnTaskIds: ["first"],
        }),
        admission("tampered", [], {
          objective: "Research tampered",
          dependsOnTaskIds: ["first"],
        }),
      ],
      maxTasks: 3,
      maxConcurrency: 1,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        return taskId === "first" ? firstResult : { taskId, answer: "bounded" };
      },
    });
    const invoke = (taskId: string, dependencyResults?: Array<{ taskId: string; result: unknown }>) =>
      adapter.invoke({
        description: encodeResearchTaskDescriptionV1({
          taskId,
          objective: `Research ${taskId}`,
          ...(dependencyResults ? { dependencyResults } : {}),
        }),
        subagent_type: "focused-researcher",
      }, {
        configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
      });

    await expect(invoke("dependent", [{ taskId: "first", result: firstResult }]))
      .rejects.toMatchObject({ code: "dependency-not-ready" });

    const fresh = createResearchDispatchInterceptionAdapter({
      admissions: [
        admission("first", [], { objective: "Research first" }),
        admission("dependent", [], { objective: "Research dependent", dependsOnTaskIds: ["first"] }),
        admission("tampered", [], { objective: "Research tampered", dependsOnTaskIds: ["first"] }),
      ],
      maxTasks: 3,
      maxConcurrency: 1,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        return taskId === "first" ? firstResult : { taskId, answer: "bounded" };
      },
    });
    const invokeFresh = (taskId: string, dependencyResults?: Array<{ taskId: string; result: unknown }>) =>
      fresh.invoke({
        description: encodeResearchTaskDescriptionV1({
          taskId,
          objective: `Research ${taskId}`,
          ...(dependencyResults ? { dependencyResults } : {}),
        }),
        subagent_type: "focused-researcher",
      }, { configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA } });

    await expect(invokeFresh("first")).resolves.toEqual(firstResult);
    await expect(invokeFresh("dependent", [{ taskId: "first", result: firstResult }]))
      .resolves.toEqual({ taskId: "dependent", answer: "bounded" });
    await expect(invokeFresh("tampered", [{ taskId: "first", result: { ...firstResult, answer: "changed" } }]))
      .rejects.toMatchObject({ code: "dependency-result-mismatch" });
  });

  test("returns only the host-projected dependency record to the QuickJS caller", async () => {
    const rawResult = {
      taskId: "first",
      answer: "RAW_CHILD_TRAJECTORY_SENTINEL",
    };
    const dependencyRecord = {
      schema: "atlcli.research-dependency-packet/v1",
      taskId: "first",
      sourceIds: ["jira:DEMO-1"],
    };
    const adapter = createResearchDispatchInterceptionAdapter({
      admissions: [
        admission("first", [], { objective: "Research first" }),
        admission("dependent", [], {
          objective: "Research dependent",
          dependsOnTaskIds: ["first"],
        }),
        admission("tampered", [], {
          objective: "Research tampered",
          dependsOnTaskIds: ["first"],
        }),
      ],
      maxTasks: 3,
      maxConcurrency: 1,
      projectDependencyResult: (taskId, result) => taskId === "first"
        ? dependencyRecord
        : result,
      async invokeUpstream(_input, config) {
        const taskId = String(config.configurable?.[RESEARCH_TASK_ID_CONFIG_KEY]);
        return taskId === "first" ? rawResult : { taskId, answer: "bounded" };
      },
    });
    const invoke = (taskId: string, dependencyResults?: Array<{ taskId: string; result: unknown }>) =>
      adapter.invoke({
        description: encodeResearchTaskDescriptionV1({
          taskId,
          objective: `Research ${taskId}`,
          ...(dependencyResults ? { dependencyResults } : {}),
        }),
        subagent_type: "focused-researcher",
      }, {
        configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: PACKET_SCHEMA },
      });

    await expect(invoke("first")).resolves.toEqual(dependencyRecord);
    await expect(invoke("dependent", [{ taskId: "first", result: dependencyRecord }]))
      .resolves.toEqual({ taskId: "dependent", answer: "bounded" });
    expect(JSON.stringify(adapter.snapshot())).not.toContain("RAW_CHILD_TRAJECTORY_SENTINEL");
    await expect(invoke("tampered", [{ taskId: "first", result: rawResult }]))
      .rejects.toMatchObject({ code: "dependency-result-mismatch" });
  });

  test("intercepts the actual declarative DeepAgents dynamic-responseSchema path", async () => {
    const result = await runDeclarativeDispatchCharacterization();

    expect(result.messages.some((message) => message.includes("deep-jira"))).toBe(true);
    expect(result.messages.some((message) => message.includes("deep-wiki"))).toBe(true);
    expect(result.providerCalls).toEqual({ jira: 1, wiki: 1 });
    expect(result.denied).toEqual([
      "deep-jira:wiki.search",
      "deep-wiki:jira.issue.search",
    ]);
    expect(result.subagentModelCalls).toBe(2);
    expect(result.ptcConfigTaskId).toBe("ptc-browser-task");
    expect(result.taskStatuses).toEqual({
      "deep-jira": "completed",
      "deep-wiki": "completed",
    });
    expect(result.productionSchemas.metrics).toEqual({
      ResearchPacketBodyV1: {
        serializedBytes: 2_494,
        propertyCount: 27,
        nestingDepth: 4,
      },
      ResearchPacketBodyV2: {
        serializedBytes: 3_051,
        propertyCount: 32,
        nestingDepth: 5,
      },
      ResearchPacketReferenceModelV2: {
        serializedBytes: 2_463,
        propertyCount: 26,
        nestingDepth: 4,
      },
      ReconciliationBodyV1: {
        serializedBytes: 1_929,
        propertyCount: 19,
        nestingDepth: 5,
      },
    });
    expect(result.productionSchemas.admittedRoles).toEqual([
      "contradiction-verifier",
      "coverage-moderator",
      "document-distiller",
      "focused-researcher",
      "outline-planner",
      "reconciler",
    ]);
    expect(result.modelScript).toEqual({
      schema: "atlcli.deterministic-research-model-script/v1",
      id: "parallel-cross-product-acquisition",
      codeBytes: 779,
      taskIds: ["deep-jira", "deep-wiki"],
    });
  });
});

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
} from "../utils/research/dispatch-adapter.js";
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

  test("propagates abort and quarantines a deliberately late result", async () => {
    const controller = new AbortController();
    const diagnostics: ResearchDispatchDiagnosticV1[] = [];
    let upstreamSignalAborted = false;
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
        await late;
        return { taskId: "late-task", answer: "too late" };
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const session = sessionFor(adapter);
    try {
      const evaluation = session.eval(`${guestTask("late-task")}`, 5_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
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
        serializedBytes: 2_140,
        propertyCount: 23,
        nestingDepth: 4,
      },
      ResearchPacketBodyV2: {
        serializedBytes: 2_806,
        propertyCount: 31,
        nestingDepth: 4,
      },
      ReconciliationBodyV1: {
        serializedBytes: 1_638,
        propertyCount: 16,
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

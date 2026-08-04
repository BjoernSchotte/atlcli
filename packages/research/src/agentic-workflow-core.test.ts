import { describe, expect, test } from "bun:test";
import {
  AGENTIC_WORKFLOW_SCHEMA_V1,
  bindAgenticWorkflowRunV1,
  compileAgenticWorkflowV1,
  createAgenticDispatchControlHookV1,
  readyAgenticFrontierV1,
  resolveAgenticCompletionObjectiveV1,
} from "./agentic-workflow-core.js";
import {
  DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY,
  createAgenticDispatchInterceptionAdapter,
  encodeResearchTaskDescriptionV1,
} from "./dispatch-adapter.js";

const responseSchema = { type: "object", additionalProperties: false };
const admission = {
  taskId: "task:reader:1",
  subagentType: "focused-reader",
  objective: "Read the admitted source.",
  grantedCapabilityIds: ["wiki.page.get"],
  responseSchema,
  maxResultBytes: 1_024,
  maxDurationMs: 1_000,
} as const;

describe("shared agentic workflow core", () => {
  test("compiles immutable provider- and host-neutral structure", () => {
    const compiled = compileAgenticWorkflowV1({
      schema: AGENTIC_WORKFLOW_SCHEMA_V1,
      id: "read-only-answer",
      completionObjective: "conversation-answer",
      profiles: [{
        subagentType: "answer-writer",
        roleId: "synthesizer",
        phase: "synthesis",
        dependsOnSubagentTypes: [],
      }],
      maxTasks: 2,
      maxConcurrency: 1,
    });

    expect(compiled.reuseEligible).toBe(false);
    expect(compiled.compatibilityFingerprint).toMatch(/^fnv1a32:/);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.profiles)).toBe(true);
    expect(Object.isFrozen(compiled.profiles[0])).toBe(true);
    expect(Reflect.set(compiled.profiles[0]!, "subagentType", "mutated"))
      .toBe(false);
  });

  test("binds fresh run identity without cross-user, thread, scope, cache, steering, or abort leakage", () => {
    const compiled = compileAgenticWorkflowV1({
      schema: AGENTIC_WORKFLOW_SCHEMA_V1,
      id: "shared-descriptor",
      completionObjective: "research-report",
      profiles: [
        {
          subagentType: "researcher",
          roleId: "reader",
          phase: "acquisition",
          dependsOnSubagentTypes: [],
        },
        {
          subagentType: "report-writer",
          roleId: "synthesizer",
          phase: "synthesis",
          dependsOnSubagentTypes: ["researcher"],
        },
      ],
      maxTasks: 2,
      maxConcurrency: 2,
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = bindAgenticWorkflowRunV1(compiled, {
      userId: "user-a",
      threadId: "thread-a",
      turnId: "turn-a",
      revision: 1,
      scopeFingerprint: "scope-a",
      providerCacheIdentity: "cache-a",
    }, firstAbort.signal);
    const second = bindAgenticWorkflowRunV1(compiled, {
      userId: "user-b",
      threadId: "thread-b",
      turnId: "turn-b",
      revision: 2,
      scopeFingerprint: "scope-b",
      providerCacheIdentity: "cache-b",
    }, secondAbort.signal);

    firstAbort.abort("stop-first-run");
    expect(first.compiled).toBe(second.compiled);
    expect(first.identity).not.toEqual(second.identity);
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    expect(second.identity.revision).toBe(2);
    expect(compiled.reuseEligible).toBe(false);
    expect(readyAgenticFrontierV1(compiled, {
      completedSubagentTypes: new Set(),
    }).map((profile) => profile.subagentType)).toEqual(["researcher"]);
    expect(readyAgenticFrontierV1(compiled, {
      completedSubagentTypes: new Set(["researcher"]),
    }).map((profile) => profile.subagentType)).toEqual(["report-writer"]);
  });

  test("uses separate terminal objectives for Chat answers and research reports", () => {
    expect(resolveAgenticCompletionObjectiveV1({ hasWorkflowGraph: false }))
      .toBe("conversation-answer");
    expect(resolveAgenticCompletionObjectiveV1({ hasWorkflowGraph: true }))
      .toBe("research-report");
    expect(() => resolveAgenticCompletionObjectiveV1({
      requested: "conversation-answer",
      hasWorkflowGraph: true,
    })).toThrow("incompatible");
  });

  test("runs authorization, HITL, budget, and journal gates before the provider", async () => {
    const order: string[] = [];
    const adapter = createAgenticDispatchInterceptionAdapter({
      admissions: [admission],
      maxTasks: 1,
      maxConcurrency: 1,
      beforeInvoke: createAgenticDispatchControlHookV1({
        authorize: () => { order.push("authorize"); },
        requireHumanApproval: () => { order.push("hitl"); },
        reserveBudget: () => { order.push("budget"); },
        journalStart: () => { order.push("journal"); },
      }),
      invokeUpstream: async () => {
        order.push("provider");
        return { accepted: true };
      },
    });

    await adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: admission.taskId,
        objective: admission.objective,
      }),
      subagent_type: admission.subagentType,
    }, {
      configurable: {
        [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: responseSchema,
      },
    });

    expect(order).toEqual(["authorize", "hitl", "budget", "journal", "provider"]);
  });

  test("rejects an unknown subagent type before control gates or provider work", async () => {
    let invoked = false;
    let gated = false;
    const adapter = createAgenticDispatchInterceptionAdapter({
      admissions: [admission],
      maxTasks: 1,
      maxConcurrency: 1,
      beforeInvoke: () => { gated = true; },
      invokeUpstream: async () => {
        invoked = true;
        return {};
      },
    });

    await expect(adapter.invoke({
      description: encodeResearchTaskDescriptionV1({
        taskId: admission.taskId,
        objective: admission.objective,
      }),
      subagent_type: "model-invented-agent",
    }, {
      configurable: {
        [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: responseSchema,
      },
    })).rejects.toMatchObject({ code: "subagent-type-mismatch" });
    expect(gated).toBe(false);
    expect(invoked).toBe(false);
  });
});

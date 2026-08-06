import { expect, test } from "bun:test";
import {
  DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY,
  createResearchDispatchInterceptionAdapter,
  encodeResearchTaskDescriptionV1,
  type ResearchDispatchDiagnosticV1,
} from "./dispatch-adapter.js";

test("records a body-free HTTP status when a subagent provider fails", async () => {
  const responseSchema = { type: "object" };
  const diagnostics: ResearchDispatchDiagnosticV1[] = [];
  const adapter = createResearchDispatchInterceptionAdapter({
    admissions: [{
      taskId: "task:provider-failure",
      subagentType: "researcher",
      objective: "Read one admitted source.",
      grantedCapabilityIds: [],
      responseSchema,
      maxResultBytes: 1_024,
      maxDurationMs: 1_000,
    }],
    maxTasks: 1,
    maxConcurrency: 1,
    invokeUpstream: async () => {
      const error = Object.assign(new Error("transient provider failure"), { status: 529 });
      throw error;
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await expect(adapter.invoke({
    description: encodeResearchTaskDescriptionV1({
      taskId: "task:provider-failure",
      objective: "Read one admitted source.",
    }),
    subagent_type: "researcher",
  }, {
    configurable: { [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: responseSchema },
  })).rejects.toThrow("transient provider failure");

  expect(diagnostics).toContainEqual({
    taskId: "task:provider-failure",
    status: "failed",
    code: "subagent-provider-error",
    providerStatus: 529,
  });
});

test("host response-schema hydration ignores an untrusted guest copy", async () => {
  const responseSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };
  let received: unknown;
  const adapter = createResearchDispatchInterceptionAdapter({
    admissions: [{
      taskId: "task:chat-draft",
      subagentType: "chat-drafter",
      objective: "Draft the admitted answer.",
      grantedCapabilityIds: [],
      responseSchema,
      maxResultBytes: 1_024,
      maxDurationMs: 1_000,
    }],
    maxTasks: 1,
    maxConcurrency: 1,
    allowHostResponseSchemaHydration: true,
    invokeUpstream: async (_input, config) => {
      received = config.configurable?.[DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY];
      return { answer: "host bound" };
    },
  });

  await expect(adapter.invoke({
    description: encodeResearchTaskDescriptionV1({
      taskId: "task:chat-draft",
      objective: "Draft the admitted answer.",
    }),
    subagent_type: "chat-drafter",
  }, {
    configurable: {
      [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: { type: "array" },
    },
  })).resolves.toEqual({ answer: "host bound" });
  expect(received).toEqual(responseSchema);
});

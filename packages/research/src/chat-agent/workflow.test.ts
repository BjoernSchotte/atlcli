import { describe, expect, test } from "bun:test";
import { ResearchRunBudget } from "../budget.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "../contracts.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import {
  CHAT_SUBAGENT_PROFILES_V1,
  CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
  admitChatWorkflowProposalV1,
  createChatWorkflowProposalControllerV1,
  parseChatSubagentResultV1,
  type ChatWorkflowProposalV1,
} from "./workflow.js";

const direct: ChatStrategyDecisionV1 = {
  schema: "atlcli.chat-strategy-decision/v1",
  qualityMode: "quick",
  execution: "direct",
  reasonCodes: ["single-exact-context"],
  ambiguityDisposition: "none",
  requiredCapabilities: ["exact-read"],
  expectedComplexity: "simple",
  qualityRisks: [],
};

const agentic: ChatStrategyDecisionV1 = {
  schema: "atlcli.chat-strategy-decision/v1",
  qualityMode: "deep",
  execution: "agentic",
  reasonCodes: ["cross-product-relationship"],
  ambiguityDisposition: "none",
  requiredCapabilities: ["jira-discovery", "confluence-discovery", "relationship-tracing"],
  expectedComplexity: "complex",
  qualityRisks: ["multiple-sources"],
};

function proposal(tasks: ChatWorkflowProposalV1["tasks"]): ChatWorkflowProposalV1 {
  return {
    schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
    maxConcurrency: Math.min(3, tasks.length),
    tasks,
  };
}

describe("Chat dynamic workflow admission", () => {
  test("registers the exact host-owned profile catalog with least-privilege capabilities", () => {
    expect(CHAT_SUBAGENT_PROFILES_V1.map((entry) => entry.id)).toEqual([
      "exact-context-reader",
      "confluence-search-reader",
      "jira-search-reader",
      "relationship-tracer",
      "comparison-analyst",
      "contradiction-checker",
      "answer-critic",
      "chat-synthesizer",
    ]);
    expect(CHAT_SUBAGENT_PROFILES_V1.find((entry) => entry.id === "jira-search-reader")
      ?.grantedCapabilityIds).toEqual([
        "jira.issue.search",
        "research.candidate.rank",
        "jira.issue.get",
      ]);
    expect(CHAT_SUBAGENT_PROFILES_V1.find((entry) => entry.id === "confluence-search-reader")
      ?.grantedCapabilityIds).toEqual([
        "wiki.search",
        "research.candidate.rank",
        "wiki.page.get",
      ]);
    for (const id of [
      "relationship-tracer",
      "comparison-analyst",
      "contradiction-checker",
      "answer-critic",
      "chat-synthesizer",
    ]) {
      expect(CHAT_SUBAGENT_PROFILES_V1.find((entry) => entry.id === id)
        ?.grantedCapabilityIds).toEqual([]);
    }
    expect(JSON.stringify(CHAT_SUBAGENT_PROFILES_V1.map((entry) => entry.responseSchema))).not.toMatch(
      /sourceBody|rawBody|credential|fetch|graphql|mutation/iu,
    );
  });

  test("keeps a direct strategy free of ceremonial children", () => {
    expect(admitChatWorkflowProposalV1({ strategy: direct })).toBeUndefined();
    expect(() => admitChatWorkflowProposalV1({
      strategy: direct,
      proposal: proposal([
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write an answer.",
          dependencyTaskIds: [],
        },
      ]),
    })).toThrow("direct Chat strategy");
  });

  test("admits a dynamic two-sibling parallel frontier and one synthesizer", () => {
    const accepted = admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        {
          taskId: "task:jira",
          profileId: "jira-search-reader",
          objective: "Find relevant Jira detail evidence.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:wiki",
          profileId: "confluence-search-reader",
          objective: "Find relevant Confluence detail evidence.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the conversational answer.",
          dependencyTaskIds: ["task:jira", "task:wiki"],
        },
      ]),
    });

    expect(accepted?.compiled.completionObjective).toBe("conversation-answer");
    expect(accepted?.compiled.maxConcurrency).toBe(3);
    expect(accepted?.synthesizerTaskId).toBe("task:synth");
    expect(accepted?.admissions.filter((entry) =>
      entry.subagentType === "chat-synthesizer-v1"
    )).toHaveLength(1);
  });

  test("admits dependency-driven analysis, optional critique, and final synthesis", () => {
    const accepted = admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        {
          taskId: "task:exact",
          profileId: "exact-context-reader",
          objective: "Read the attached page.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:jira",
          profileId: "jira-search-reader",
          objective: "Read explicitly related Jira issues.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:relationships",
          profileId: "relationship-tracer",
          objective: "Trace explicit cross-product relationships.",
          dependencyTaskIds: ["task:exact", "task:jira"],
        },
        {
          taskId: "task:critic",
          profileId: "answer-critic",
          objective: "Check grounding and coverage.",
          dependencyTaskIds: ["task:relationships"],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the conversational answer.",
          dependencyTaskIds: ["task:critic"],
        },
      ]),
    });

    expect(accepted?.tasks.map((entry) => entry.profileId)).toEqual([
      "exact-context-reader",
      "jira-search-reader",
      "relationship-tracer",
      "answer-critic",
      "chat-synthesizer",
    ]);
    expect(accepted?.admissions.find((entry) => entry.taskId === "task:critic")
      ?.dependsOnTaskIds).toEqual([
        "task:relationships",
        "task:exact",
        "task:jira",
      ]);
    expect(accepted?.admissions.find((entry) => entry.taskId === "task:synth")
      ?.dependsOnTaskIds).toEqual([
        "task:critic",
        "task:exact",
        "task:jira",
        "task:relationships",
      ]);
  });

  test("rejects forged fields, unknown profiles, duplicate profiles, and invalid phase dependencies", () => {
    const base = [
      {
        taskId: "task:jira",
        profileId: "jira-search-reader" as const,
        objective: "Read Jira.",
        dependencyTaskIds: [],
      },
      {
        taskId: "task:synth",
        profileId: "chat-synthesizer" as const,
        objective: "Write answer.",
        dependencyTaskIds: ["task:jira"],
      },
    ];
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([{ ...base[0]!, secret: "forged" } as never, base[1]!]),
    })).toThrow("outside the host contract");
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([{ ...base[0]!, profileId: "invented" as never }, base[1]!]),
    })).toThrow("unknown profile");
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        base[0]!,
        { ...base[0]!, taskId: "task:jira:2" },
        { ...base[1]!, dependencyTaskIds: ["task:jira", "task:jira:2"] },
      ]),
    })).toThrow("at most once");
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        { ...base[0]!, dependencyTaskIds: ["task:synth"] },
        { ...base[1]!, dependencyTaskIds: [] },
      ]),
    })).toThrow(/phase order|cycle/u);
    const augmented = admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        base[0]!,
        {
          taskId: "task:orphan",
          profileId: "confluence-search-reader",
          objective: "Unused work.",
          dependencyTaskIds: [],
        },
        base[1]!,
      ]),
    });
    expect(augmented?.admissions.find((entry) => entry.taskId === "task:synth")
      ?.dependsOnTaskIds).toEqual(["task:jira", "task:orphan"]);
  });

  test("admits one model proposal into exact generic dispatch envelopes after the strategy checkpoint", async () => {
    let strategyAcknowledged = false;
    const accepted: string[] = [];
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      taskContext: JSON.stringify({ question: "Compare the two approved sources." }),
      beforeProposal: () => {
        if (!strategyAcknowledged) throw new Error("strategy pending");
      },
      onAccepted: (workflow) => {
        accepted.push(workflow.synthesizerTaskId);
      },
    });
    const proposed = {
      tasks: [
        {
          taskId: "task:compare",
          profileId: "comparison-analyst" as const,
          objective: "Compare the accepted claims.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer" as const,
          objective: "Write the answer.",
          dependencyTaskIds: ["task:compare"],
        },
      ],
      maxConcurrency: 2,
    };
    await expect(controller.tool.invoke(proposed)).rejects.toThrow("strategy pending");
    strategyAcknowledged = true;
    const response = JSON.parse(await controller.tool.invoke(proposed));
    expect(response).toMatchObject({
      schema: "atlcli.chat-workflow-admission/v1",
      completionObjective: "conversation-answer",
      synthesizerTaskId: "task:synth",
    });
    expect(response.dispatches).toHaveLength(2);
    expect(JSON.parse(response.dispatches[0].description)).toMatchObject({
      schema: "atlcli.agentic-task-dispatch/v1",
      taskId: "task:compare",
    });
    expect(response.dispatches[0].objective).toContain("Host-bound turn context");
    expect(accepted).toEqual(["task:synth"]);
    controller.assertAccepted();
    await expect(controller.tool.invoke(proposed)).rejects.toThrow("already been accepted");
  });

  test("validates a bounded retrieval proposal before freezing dynamic task context", async () => {
    let context = JSON.stringify({ retrieval: { variants: ["initial"] } });
    const seenVariants: string[] = [];
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      taskContext: () => context,
      beforeAdmission: (workflowProposal) => {
        seenVariants.push(...(workflowProposal.retrievalPlan?.searches?.[0]?.variants
          .map((variant) => variant.variantId) ?? []));
        context = JSON.stringify({ retrieval: { variants: seenVariants } });
      },
    });
    const response = JSON.parse(await controller.tool.invoke({
      tasks: [
        {
          taskId: "task:wiki",
          profileId: "confluence-search-reader",
          objective: "Find the relevant evidence.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the answer.",
          dependencyTaskIds: ["task:wiki"],
        },
      ],
      maxConcurrency: 1,
      retrievalPlan: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "alternate-title", query: { text: "absence process" } },
            { variantId: "synonym", query: { text: "vacation workflow" } },
          ],
          maxPages: 2,
        }],
        relationshipTraversals: [],
        unresolvedTerms: [],
      },
    }));

    expect(seenVariants).toEqual(["alternate-title", "synonym"]);
    expect(response.dispatches[0].objective).toContain(
      '\"variants\":[\"alternate-title\",\"synonym\"]',
    );
  });

  test("rejects unavailable acquisition profiles and malformed child packets", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      allowedProfileIds: ["answer-critic", "chat-synthesizer"],
    });
    await expect(controller.tool.invoke({
      tasks: [
        {
          taskId: "task:jira",
          profileId: "jira-search-reader",
          objective: "Search Jira.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the answer.",
          dependencyTaskIds: ["task:jira"],
        },
      ],
      maxConcurrency: 1,
    })).rejects.toThrow("capabilities are unavailable");
    expect(() => parseChatSubagentResultV1("answer-critic", {
      schema: "atlcli.chat-critique-packet/v1",
      defects: [],
      readyForSynthesis: true,
      rawBody: "forbidden",
    })).toThrow("invalid structured packet");
  });

  test("accepts packet field limits and rejects item, character, and nested-shape overflow", () => {
    const accepted = parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: Array.from({ length: 100 }, (_, index) => `source:${index}`),
      claims: Array.from({ length: 80 }, (_, index) => ({
        text: index === 0 ? "x".repeat(1_000) : `Claim ${index}`,
        sourceIds: [],
      })),
      relationships: [],
      gaps: Array.from({ length: 40 }, (_, index) =>
        index === 0 ? "g".repeat(600) : `Gap ${index}`
      ),
    });
    expect(accepted).toMatchObject({
      schema: "atlcli.chat-evidence-packet/v1",
    });

    expect(() => parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: Array.from({ length: 101 }, (_, index) => `source:${index}`),
      claims: [],
      relationships: [],
      gaps: [],
    })).toThrow("invalid structured packet");
    expect(() => parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: [],
      claims: [{ text: "x".repeat(1_001), sourceIds: [] }],
      relationships: [],
      gaps: [],
    })).toThrow("invalid structured packet");
    expect(() => parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: [],
      claims: [{ text: { nested: "forbidden" }, sourceIds: [] }],
      relationships: [],
      gaps: [],
    })).toThrow("invalid structured packet");
  });
});

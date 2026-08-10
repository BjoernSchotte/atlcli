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
  type ChatWorkflowDispatchV1,
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
  qualityRisks: ["multiple-sources", "cross-product"],
};

const comparisonAgentic: ChatStrategyDecisionV1 = {
  ...agentic,
  reasonCodes: ["multi-source-comparison"],
  requiredCapabilities: ["comparison-analysis", "quality-review", "chat-answer"],
  qualityRisks: ["multiple-sources"],
};

const comparisonContradictionAgentic: ChatStrategyDecisionV1 = {
  ...comparisonAgentic,
  reasonCodes: ["multi-source-comparison", "contradiction-risk"],
  requiredCapabilities: [
    "comparison-analysis",
    "contradiction-check",
    "quality-review",
    "chat-answer",
  ],
  qualityRisks: ["multiple-sources", "contradictory-evidence"],
};

const relationshipAgentic: ChatStrategyDecisionV1 = {
  ...comparisonAgentic,
  reasonCodes: ["cross-product-relationship"],
  requiredCapabilities: ["relationship-tracing", "quality-review", "chat-answer"],
  qualityRisks: ["cross-product"],
};

const contradictionAgentic: ChatStrategyDecisionV1 = {
  ...comparisonAgentic,
  reasonCodes: ["contradiction-risk"],
  requiredCapabilities: ["contradiction-check", "quality-review", "chat-answer"],
  qualityRisks: ["contradictory-evidence"],
};

function proposal(tasks: ChatWorkflowProposalV1["tasks"]): ChatWorkflowProposalV1 {
  return {
    schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
    maxConcurrency: Math.min(3, tasks.length),
    tasks,
  };
}

function qualityWorkflowTasks(
  leading: ChatWorkflowProposalV1["tasks"],
): ChatWorkflowProposalV1["tasks"] {
  const leadingIds = leading.map((task) => task.taskId);
  return [
    ...leading,
    {
      taskId: "task:draft",
      profileId: "answer-drafter",
      objective: "Draft a provisional evidence-backed answer.",
      dependencyTaskIds: leadingIds,
    },
    {
      taskId: "task:critic",
      profileId: "answer-critic",
      objective: "Check the provisional answer independently.",
      dependencyTaskIds: ["task:draft"],
    },
    {
      taskId: "task:synth",
      profileId: "chat-synthesizer",
      objective: "Write the accepted conversational answer.",
      dependencyTaskIds: ["task:critic"],
    },
  ];
}

describe("Chat dynamic workflow admission", () => {
  test("isolates exact anchors while keeping same-product search acquisition bounded", () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
    });
    expect(controller.tool.description).toContain(
      "host deterministically packs up to three small exact anchors",
    );
    expect(controller.tool.description).toContain(
      "Keep admitted search variants for the same product in one search-reader task",
    );
  });

  test("requires synthesis to omit irrelevant side facts and auxiliary gaps", () => {
    const synthesizer = CHAT_SUBAGENT_PROFILES_V1.find((entry) =>
      entry.id === "chat-synthesizer"
    );
    expect(synthesizer?.systemPrompt).toContain(
      "Every factual block must answer the user's question",
    );
    expect(synthesizer?.systemPrompt).toContain(
      "Include only material gaps that could change the answer",
    );
    expect(synthesizer?.systemPrompt).toContain("do not invent auxiliary gaps");
  });

  test("carries explicit ranking direction through drafting, critique, repair, and synthesis", () => {
    const prompt = (id: "answer-drafter" | "answer-critic" | "answer-repairer" | "chat-synthesizer") =>
      CHAT_SUBAGENT_PROFILES_V1.find((entry) => entry.id === id)?.systemPrompt ?? "";
    expect(prompt("answer-drafter")).toContain("order them descending");
    expect(prompt("answer-critic")).toContain("not ordered in the direction requested");
    expect(prompt("answer-repairer")).toContain("ordered descending");
    expect(prompt("chat-synthesizer")).toContain("ordered descending");
  });

  test("registers the exact host-owned profile catalog with least-privilege capabilities", () => {
    expect(CHAT_SUBAGENT_PROFILES_V1.map((entry) => entry.id)).toEqual([
      "exact-context-reader",
      "confluence-search-reader",
      "jira-search-reader",
      "relationship-tracer",
      "comparison-analyst",
      "contradiction-checker",
      "answer-drafter",
      "answer-critic",
      "answer-repairer",
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
    expect(CHAT_SUBAGENT_PROFILES_V1.filter((entry) =>
      entry.id === "confluence-search-reader" || entry.id === "jira-search-reader"
    ).map((entry) => entry.maxDurationMs)).toEqual([240_000, 240_000]);
    const exactReader = CHAT_SUBAGENT_PROFILES_V1.find((entry) =>
      entry.id === "exact-context-reader"
    );
    expect(exactReader?.maxDurationMs).toBe(240_000);
    expect(exactReader?.systemPrompt).toContain(
      "Every claim must name its canonical sourceIds and exact sourceRefs",
    );
    for (const id of [
      "relationship-tracer",
      "comparison-analyst",
      "contradiction-checker",
      "answer-drafter",
      "answer-critic",
      "answer-repairer",
      "chat-synthesizer",
    ]) {
      expect(CHAT_SUBAGENT_PROFILES_V1.find((entry) => entry.id === id)
        ?.grantedCapabilityIds).toEqual([]);
    }
    const synthesizer = CHAT_SUBAGENT_PROFILES_V1.find((entry) =>
      entry.id === "chat-synthesizer"
    );
    expect(synthesizer).toMatchObject({
      modelPreference: "thorough",
      maxResultBytes: 32_000,
      maxDurationMs: 180_000,
    });
    expect(CHAT_SUBAGENT_PROFILES_V1.find((entry) =>
      entry.id === "answer-repairer"
    )).toMatchObject({ maxDurationMs: 180_000 });
    expect(synthesizer?.systemPrompt).toContain("below 700 words");
    expect(synthesizer?.systemPrompt).toContain("do not re-run the analysis");
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

  test("admits distinct minimal graphs for comparison, contradiction, relationship, and combined risk", async () => {
    const combined: ChatStrategyDecisionV1 = {
      ...comparisonContradictionAgentic,
      reasonCodes: [
        "multi-source-comparison",
        "cross-product-relationship",
        "contradiction-risk",
      ],
      requiredCapabilities: [
        "comparison-analysis",
        "relationship-tracing",
        "contradiction-check",
        "quality-review",
        "chat-answer",
      ],
      qualityRisks: ["multiple-sources", "cross-product", "contradictory-evidence"],
    };
    const cases = [
      { strategy: comparisonAgentic, profiles: ["comparison-analyst"] as const },
      { strategy: contradictionAgentic, profiles: ["contradiction-checker"] as const },
      { strategy: relationshipAgentic, profiles: ["relationship-tracer"] as const },
      {
        strategy: combined,
        profiles: [
          "comparison-analyst",
          "relationship-tracer",
          "contradiction-checker",
        ] as const,
      },
    ];
    for (const [caseIndex, gold] of cases.entries()) {
      const controller = createChatWorkflowProposalControllerV1({
        strategy: gold.strategy,
        budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      });
      const leading = gold.profiles.map((profileId, profileIndex) => ({
        taskId: `task:gold:${caseIndex}:${profileIndex}`,
        profileId,
        objective: `Perform the required ${profileId} work.`,
        dependencyTaskIds: [],
      }));
      const response = JSON.parse(await controller.tool.invoke({
        tasks: qualityWorkflowTasks(leading),
        maxConcurrency: Math.min(3, leading.length),
      }));
      expect(response.normalization).toMatchObject({
        schema: "atlcli.chat-workflow-normalization/v1",
        proposedTaskCount: leading.length + 3,
        admittedTaskCount: leading.length + 3,
        reasonCodes: [],
      });
      expect(response.normalization.admittedProfileIds).toEqual([
        ...gold.profiles,
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ]);
    }
  });

  test("removes unrequired specialists and rejects duplicate readers with privacy-safe reason codes", async () => {
    const unnecessaryRelationship = createChatWorkflowProposalControllerV1({
      strategy: comparisonAgentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
    });
    const normalized = JSON.parse(await unnecessaryRelationship.tool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:compare",
          profileId: "comparison-analyst",
          objective: "Compare accepted evidence.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:relationship",
          profileId: "relationship-tracer",
          objective: "Perform ceremonial relationship work.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 2,
    }));
    expect(normalized.normalization).toMatchObject({
      proposedTaskCount: 5,
      admittedTaskCount: 4,
      reasonCodes: ["dominated-specialists-removed"],
    });
    expect(normalized.normalization.admittedProfileIds).not.toContain("relationship-tracer");

    const duplicateReader = createChatWorkflowProposalControllerV1({
      strategy: relationshipAgentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
    });
    await expect(duplicateReader.tool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:wiki:a",
          profileId: "confluence-search-reader",
          objective: "Search the first equivalent facet.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:wiki:b",
          profileId: "confluence-search-reader",
          objective: "Search the second equivalent facet.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:relationship",
          profileId: "relationship-tracer",
          objective: "Trace explicit relationships.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 2,
    })).rejects.toThrow("duplicate-reader");
  });

  test("admits a dynamic two-sibling parallel frontier and one synthesizer", () => {
    const accepted = admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal(qualityWorkflowTasks([
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
      ])),
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
          taskId: "task:draft",
          profileId: "answer-drafter",
          objective: "Draft the evidence-backed answer.",
          dependencyTaskIds: ["task:relationships"],
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
      "answer-drafter",
      "answer-critic",
      "chat-synthesizer",
    ]);
    expect(accepted?.admissions.find((entry) => entry.taskId === "task:critic")
      ?.dependsOnTaskIds).toEqual([
        "task:relationships",
        "task:exact",
        "task:jira",
        "task:draft",
      ]);
    expect(accepted?.admissions.find((entry) => entry.taskId === "task:synth")
      ?.dependsOnTaskIds).toEqual([
        "task:critic",
        "task:exact",
        "task:jira",
        "task:relationships",
        "task:draft",
      ]);
  });

  test("rejects forged fields, unknown profiles, and invalid phase dependencies", () => {
    const base = qualityWorkflowTasks([
      {
        taskId: "task:jira",
        profileId: "jira-search-reader" as const,
        objective: "Read Jira.",
        dependencyTaskIds: [],
      },
    ]);
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([{ ...base[0]!, secret: "forged" } as never, ...base.slice(1)]),
    })).toThrow("outside the host contract");
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([{ ...base[0]!, profileId: "invented" as never }, ...base.slice(1)]),
    })).toThrow("unknown profile");
    const repeatedReaderWorkflow = admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        base[0]!,
        { ...base[0]!, taskId: "task:jira:2" },
        ...base.slice(1).map((task) => task.taskId === "task:draft"
          ? { ...task, dependencyTaskIds: ["task:jira", "task:jira:2"] }
          : task),
      ]),
    });
    expect(repeatedReaderWorkflow?.tasks.filter((task) =>
      task.profileId === "jira-search-reader"
    )).toHaveLength(2);
    expect(repeatedReaderWorkflow?.admissions.filter((admission) =>
      admission.subagentType === "chat-jira-search-reader-v1"
    )).toHaveLength(2);
    expect(() => admitChatWorkflowProposalV1({
      strategy: agentic,
      proposal: proposal([
        { ...base[0]!, dependencyTaskIds: ["task:synth"] },
        ...base.slice(1),
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
        ...base.slice(1),
      ]),
    });
    expect(augmented?.admissions.find((entry) => entry.taskId === "task:synth")
      ?.dependsOnTaskIds).toEqual(expect.arrayContaining([
        "task:jira",
        "task:orphan",
        "task:draft",
        "task:critic",
      ]));
  });

  test("admits one model proposal into exact generic dispatch envelopes after the strategy checkpoint", async () => {
    let strategyAcknowledged = false;
    const accepted: string[] = [];
    const controller = createChatWorkflowProposalControllerV1({
      strategy: comparisonAgentic,
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
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:compare",
          profileId: "comparison-analyst" as const,
          objective: "Compare the accepted claims.",
          dependencyTaskIds: [],
        },
      ]),
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
    expect(response.dispatches).toHaveLength(3);
    expect(JSON.parse(response.dispatches[0].description)).toMatchObject({
      schema: "atlcli.agentic-task-dispatch/v1",
      taskId: "task:compare",
    });
    expect(response.dispatches[0].objective).toContain("Host-bound turn context");
    expect(accepted).toEqual(["task:synth"]);
    controller.assertAccepted();
    await expect(controller.tool.invoke(proposed)).rejects.toThrow("already been accepted");
  });

  test("repairs model-proposed backward phase edges without changing dynamic task selection", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: comparisonContradictionAgentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
    });
    await controller.tool.invoke({
      tasks: [
        {
          taskId: "task:wiki",
          profileId: "confluence-search-reader",
          objective: "Read the bounded Confluence evidence.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:compare",
          profileId: "comparison-analyst",
          objective: "Compare the admitted claims.",
          dependencyTaskIds: ["task:wiki", "task:contradiction"],
        },
        {
          taskId: "task:contradiction",
          profileId: "contradiction-checker",
          objective: "Reconcile material contradictions.",
          dependencyTaskIds: ["task:wiki", "task:compare"],
        },
        {
          taskId: "task:draft",
          profileId: "answer-drafter",
          objective: "Draft a provisional answer.",
          dependencyTaskIds: ["task:compare", "task:contradiction"],
        },
        {
          taskId: "task:critic",
          profileId: "answer-critic",
          objective: "Critique the provisional answer.",
          dependencyTaskIds: ["task:draft"],
        },
        {
          taskId: "task:synth",
          profileId: "chat-synthesizer",
          objective: "Write the final answer.",
          dependencyTaskIds: ["task:critic"],
        },
      ],
      maxConcurrency: 2,
    });

    expect(controller.acceptedWorkflow()?.tasks.find((task) =>
      task.taskId === "task:compare"
    )?.dependencyTaskIds).toEqual(["task:wiki"]);
    expect(controller.acceptedWorkflow()?.tasks.map((task) => task.profileId)).toEqual([
      "confluence-search-reader",
      "comparison-analyst",
      "contradiction-checker",
      "answer-drafter",
      "answer-critic",
      "chat-synthesizer",
    ]);
  });

  test("binds task-specific child context and orders analysis after every acquisition task", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: {
        ...agentic,
        requiredCapabilities: ["exact-read", "comparison-analysis", "quality-review", "chat-answer"],
      },
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      allowedProfileIds: [
        "exact-context-reader",
        "comparison-analyst",
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ],
      taskContext: (task) => JSON.stringify({ assignedTaskId: task.taskId }),
    });
    await controller.tool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:first-reader",
          profileId: "exact-context-reader",
          objective: "Read the first exact source.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:second-reader",
          profileId: "exact-context-reader",
          objective: "Read the second exact source.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:compare",
          profileId: "comparison-analyst",
          objective: "Compare the acquired evidence.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 2,
    });

    const workflow = controller.acceptedWorkflow()!;
    expect(workflow.tasks.find((task) => task.taskId === "task:compare")?.dependencyTaskIds)
      .toEqual(["task:first-reader", "task:second-reader"]);
    expect(workflow.tasks.find((task) => task.taskId === "task:first-reader")?.objective)
      .toContain('"assignedTaskId":"task:first-reader"');
    expect(workflow.tasks.find((task) => task.taskId === "task:second-reader")?.objective)
      .toContain('"assignedTaskId":"task:second-reader"');
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
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:wiki",
          profileId: "confluence-search-reader",
          objective: "Find the relevant evidence.",
          dependencyTaskIds: [],
        },
      ]),
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

  test("merges duplicate model searches for one product before strict retrieval admission", async () => {
    let admittedSearches: ChatWorkflowProposalV1["retrievalPlan"];
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      beforeAdmission: (workflowProposal) => {
        admittedSearches = workflowProposal.retrievalPlan;
      },
    });

    await expect(controller.tool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:wiki",
        profileId: "confluence-search-reader",
        objective: "Find relevant evidence.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
      retrievalPlan: {
        searches: [
          {
            searchId: "search:wiki:first",
            product: "confluence",
            variants: [
              { variantId: "primary", query: { text: "installation" }, expectedInformationGain: "high" },
              { variantId: "duplicate", query: { text: "installation" }, expectedInformationGain: "low" },
            ],
            maxPages: 1,
          },
          {
            searchId: "search:wiki:second",
            product: "confluence",
            variants: [
              { variantId: "alternate", query: { text: "setup guide" }, expectedInformationGain: "medium" },
            ],
            maxPages: 2,
          },
        ],
      },
    })).resolves.toBeString();

    expect(admittedSearches?.searches).toHaveLength(1);
    expect(admittedSearches?.searches?.[0]).toEqual(expect.objectContaining({
      searchId: "search:wiki:first",
      product: "confluence",
      maxPages: 2,
    }));
    expect(admittedSearches?.searches?.[0]?.variants.map((variant) => variant.variantId))
      .toEqual(["primary", "alternate"]);
  });

  test("retains five explicit title variants for one product", async () => {
    let admittedSearches: ChatWorkflowProposalV1["retrievalPlan"];
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      beforeAdmission: (workflowProposal) => {
        admittedSearches = workflowProposal.retrievalPlan;
      },
    });

    await controller.tool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:wiki",
        profileId: "confluence-search-reader",
        objective: "Read every explicitly named page.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
      retrievalPlan: {
        searches: [{
          searchId: "search:wiki:titles",
          product: "confluence",
          variants: Array.from({ length: 5 }, (_, index) => ({
            variantId: `title-${index + 1}`,
            query: { text: `Explicit page ${index + 1}` },
            expectedInformationGain: "high",
          })),
          maxPages: 1,
        }],
      },
    });

    expect(admittedSearches?.searches?.[0]?.variants.map((variant) => variant.variantId))
      .toEqual(["title-1", "title-2", "title-3", "title-4", "title-5"]);
  });

  test("rejects unavailable acquisition profiles and malformed child packets", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: agentic,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      allowedProfileIds: ["answer-drafter", "answer-critic", "chat-synthesizer"],
    });
    await expect(controller.tool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:jira",
          profileId: "jira-search-reader",
          objective: "Search Jira.",
          dependencyTaskIds: [],
        },
      ]),
      maxConcurrency: 1,
    })).rejects.toThrow(
      "unavailable profiles (jira-search-reader). Use only: answer-drafter, answer-critic, chat-synthesizer",
    );
    expect(() => parseChatSubagentResultV1("answer-critic", {
      schema: "atlcli.chat-critique-packet/v1",
      defects: [],
      readyForSynthesis: true,
      rawBody: "forbidden",
    })).toThrow("invalid structured packet");
  });

  test("requires the dynamic graph to cover every available strategy capability", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: {
        ...agentic,
        requiredCapabilities: ["exact-read", "quality-review", "chat-answer"],
      },
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      allowedProfileIds: [
        "exact-context-reader",
        "comparison-analyst",
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ],
    });
    await expect(controller.tool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:analysis",
        profileId: "comparison-analyst",
        objective: "Compare the retained sources after acquisition.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    })).rejects.toThrow(
      "Add the required profiles: exact-context-reader",
    );
    expect(controller.tool.description).toContain(
      "requires these profiles in this proposal: exact-context-reader",
    );
    const accepted = JSON.parse(await controller.tool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:exact",
        profileId: "exact-context-reader",
        objective: "Read the retained exact evidence needed for this follow-up.",
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    })) as { dispatches: Array<{ subagentType: string }> };
    expect(accepted.dispatches.map((entry) => entry.subagentType)).toContain(
      "chat-exact-context-reader-v1",
    );
  });

  test("splits oversized exact-source assignments before child dispatch", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: {
        ...agentic,
        requiredCapabilities: ["exact-read", "quality-review", "chat-answer"],
      },
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      allowedProfileIds: [
        "exact-context-reader",
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ],
    });
    const anchors = Array.from(
      { length: 5 },
      (_, index) => `research-anchor:synthetic-${index + 1}`,
    );
    await expect(controller.tool.invoke({
      tasks: qualityWorkflowTasks([{
        taskId: "task:exact",
        profileId: "exact-context-reader",
        objective: `Read ${anchors.join(", ")}.`,
        dependencyTaskIds: [],
      }]),
      maxConcurrency: 1,
    })).rejects.toThrow(
      "Each exact-context-reader may receive at most 3 assigned anchorRefs",
    );
    expect(controller.tool.description).toContain(
      "Assign at most 3 explicit opaque anchorRefs",
    );
  });

  test("packs two small exact-reader proposals into one deterministic host task", async () => {
    const controller = createChatWorkflowProposalControllerV1({
      strategy: {
        ...agentic,
        requiredCapabilities: ["exact-read", "comparison-analysis", "quality-review", "chat-answer"],
      },
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      exactAnchorRefs: [
        "research-anchor:synthetic-a",
        "research-anchor:synthetic-b",
      ],
      allowedProfileIds: [
        "exact-context-reader",
        "comparison-analyst",
        "answer-drafter",
        "answer-critic",
        "chat-synthesizer",
      ],
    });
    const response = JSON.parse(await controller.tool.invoke({
      tasks: qualityWorkflowTasks([
        {
          taskId: "task:reader:b",
          profileId: "exact-context-reader",
          objective: "Read the second attached exact source.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:reader:a",
          profileId: "exact-context-reader",
          objective: "Read research-anchor:synthetic-a.",
          dependencyTaskIds: [],
        },
        {
          taskId: "task:compare",
          profileId: "comparison-analyst",
          objective: "Compare both exact sources.",
          dependencyTaskIds: ["task:reader:a", "task:reader:b"],
        },
      ]),
      maxConcurrency: 2,
    })) as {
      dispatches: ChatWorkflowDispatchV1[];
      normalization: {
        proposedTaskCount: number;
        admittedTaskCount: number;
        reasonCodes: string[];
      };
    };
    const exactDispatches = response.dispatches.filter((dispatch) =>
      dispatch.subagentType === "chat-exact-context-reader-v1"
    );
    expect(exactDispatches).toHaveLength(1);
    const exactDispatch = exactDispatches[0];
    if (!exactDispatch) throw new Error("missing packed exact dispatch");
    expect(exactDispatch).toMatchObject({
      taskId: "task:reader:a",
      objective: expect.stringContaining("research-anchor:synthetic-a"),
    });
    expect(JSON.stringify(exactDispatch)).toContain("research-anchor:synthetic-b");
    expect(response.dispatches.find((dispatch) => dispatch.taskId === "task:compare")
      ?.dependencyTaskIds).toEqual(["task:reader:a"]);
    expect(response.normalization).toMatchObject({
      proposedTaskCount: 6,
      admittedTaskCount: 5,
      reasonCodes: ["host-exact-anchors-bound", "exact-readers-packed"],
    });
    expect(controller.tool.description).toContain(
      "host deterministically packs up to three small exact anchors",
    );
  });

  test("accepts packet field limits and rejects item, character, and nested-shape overflow", () => {
    const accepted = parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: Array.from({ length: 100 }, (_, index) => `source:${index}`),
      claims: Array.from({ length: 80 }, (_, index) => ({
        text: index === 0 ? "x".repeat(1_000) : `Claim ${index}`,
        sourceIds: [],
        sourceRefs: [],
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
      claims: [{ text: "x".repeat(1_001), sourceIds: [], sourceRefs: [] }],
      relationships: [],
      gaps: [],
    })).toThrow("invalid structured packet");
    expect(() => parseChatSubagentResultV1("exact-context-reader", {
      schema: "atlcli.chat-evidence-packet/v1",
      sourceIds: [],
      claims: [{ text: { nested: "forbidden" }, sourceIds: [], sourceRefs: [] }],
      relationships: [],
      gaps: [],
    })).toThrow("invalid structured packet");
  });
});

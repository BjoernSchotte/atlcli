import {
  CHAT_EVALUATION_SCHEMA_V1,
  normalizeChatEvaluationScenarioV1,
  type ChatEvaluationGoldV1,
  type ChatEvaluationScenarioV1,
  type ChatEvaluationSourceV1,
} from "../evaluation.js";

const TENANT = "https://chat-eval.atlassian.net";

const DEFAULT_BUDGET = {
  maxModelCalls: 12,
  maxPtcCalls: 24,
  maxHttpCalls: 24,
  maxInputTokens: 80_000,
  maxOutputTokens: 12_000,
  maxDurationMs: 180_000,
} as const;

function wiki(id: string): ChatEvaluationSourceV1 {
  return {
    id: `wiki:${id}`,
    product: "confluence",
    canonicalUrl: `${TENANT}/wiki/spaces/KB/pages/${id}`,
    contentFingerprint: `sha256:synthetic-wiki-${id}`,
  };
}

function jira(key: string): ChatEvaluationSourceV1 {
  return {
    id: `jira:${key}`,
    product: "jira",
    canonicalUrl: `${TENANT}/browse/${key}`,
    contentFingerprint: `sha256:synthetic-jira-${key.toLocaleLowerCase("en-US")}`,
  };
}

function scenario(input: {
  id: string;
  question: string;
  sources: ChatEvaluationSourceV1[];
  exactAnchorSourceIds?: string[];
  jiraProjectKeys?: string[];
  confluenceSpaceKeys?: string[];
  gold: ChatEvaluationGoldV1;
}): ChatEvaluationScenarioV1 {
  return normalizeChatEvaluationScenarioV1({
    schema: CHAT_EVALUATION_SCHEMA_V1,
    id: input.id,
    question: input.question,
    tenantOrigin: TENANT,
    scope: {
      exactAnchorSourceIds: input.exactAnchorSourceIds ?? [],
      jiraProjectKeys: input.jiraProjectKeys ?? [],
      confluenceSpaceKeys: input.confluenceSpaceKeys ?? [],
    },
    sources: input.sources,
    budget: { ...DEFAULT_BUDGET },
    gold: input.gold,
  });
}

const directStrategies = {
  quick: "direct",
  auto: "direct",
  deep: "direct",
} as const;

const complexStrategies = {
  quick: "direct",
  auto: "agentic",
  deep: "agentic",
} as const;

/**
 * Customer-free C0 gold set. It contains only metadata and support labels; the
 * synthetic provider fixtures own source bodies and may evolve independently.
 */
export const CHAT_RECOVERY_GOLD_SCENARIOS_V1 = [
  scenario({
    id: "chat-gold:attached-page",
    question: "Summarize the attached release checklist and cite its scope.",
    sources: [wiki("1001"), wiki("1999")],
    exactAnchorSourceIds: ["wiki:1001"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1001"],
      requiredDetailSourceIds: ["wiki:1001"],
      forbiddenSourceIds: ["wiki:1999"],
      assertionSupport: { "assertion:release-scope": ["wiki:1001"] },
      requiredGapIds: [],
      expectedStrategyByMode: directStrategies,
    },
  }),
  scenario({
    id: "chat-gold:attached-issue",
    question: "What is the attached issue expected to deliver?",
    sources: [jira("DEMO-17"), jira("DEMO-99")],
    exactAnchorSourceIds: ["jira:DEMO-17"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["jira:DEMO-17"],
      requiredDetailSourceIds: ["jira:DEMO-17"],
      forbiddenSourceIds: ["jira:DEMO-99"],
      assertionSupport: { "assertion:issue-delivery": ["jira:DEMO-17"] },
      requiredGapIds: [],
      expectedStrategyByMode: directStrategies,
    },
  }),
  scenario({
    id: "chat-gold:long-page",
    question: "Which approval step appears in the final section of the attached handbook page?",
    sources: [wiki("1002")],
    exactAnchorSourceIds: ["wiki:1002"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1002"],
      requiredDetailSourceIds: ["wiki:1002"],
      forbiddenSourceIds: [],
      assertionSupport: { "assertion:late-approval-step": ["wiki:1002"] },
      requiredGapIds: [],
      expectedStrategyByMode: directStrategies,
    },
  }),
  scenario({
    id: "chat-gold:follow-up",
    question: "Who owns the approval step we just discussed?",
    sources: [wiki("1001")],
    exactAnchorSourceIds: ["wiki:1001"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1001"],
      requiredDetailSourceIds: ["wiki:1001"],
      forbiddenSourceIds: [],
      assertionSupport: { "assertion:follow-up-owner": ["wiki:1001"] },
      requiredGapIds: [],
      expectedStrategyByMode: directStrategies,
    },
  }),
  scenario({
    id: "chat-gold:jira-reference-in-page",
    question: "Which implementation issue is explicitly linked from the attached design page?",
    sources: [wiki("1003"), jira("DEMO-23"), jira("DEMO-24")],
    exactAnchorSourceIds: ["wiki:1003"],
    jiraProjectKeys: ["DEMO"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["jira:DEMO-23", "wiki:1003"],
      requiredDetailSourceIds: ["jira:DEMO-23", "wiki:1003"],
      forbiddenSourceIds: ["jira:DEMO-24"],
      assertionSupport: {
        "assertion:page-issue-relationship": ["jira:DEMO-23", "wiki:1003"],
      },
      requiredGapIds: [],
      expectedStrategyByMode: complexStrategies,
    },
  }),
  scenario({
    id: "chat-gold:multi-source-comparison",
    question: "Compare the rollout criteria in the two approved design pages.",
    sources: [wiki("1004"), wiki("1005"), wiki("1998")],
    confluenceSpaceKeys: ["KB"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1004", "wiki:1005"],
      requiredDetailSourceIds: ["wiki:1004", "wiki:1005"],
      forbiddenSourceIds: ["wiki:1998"],
      assertionSupport: {
        "assertion:rollout-commonality": ["wiki:1004", "wiki:1005"],
        "assertion:rollout-difference": ["wiki:1004", "wiki:1005"],
      },
      requiredGapIds: [],
      expectedStrategyByMode: complexStrategies,
    },
  }),
  scenario({
    id: "chat-gold:contradiction",
    question: "Do the two current policy pages agree on the review interval?",
    sources: [wiki("1006"), wiki("1007")],
    confluenceSpaceKeys: ["KB"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1006", "wiki:1007"],
      requiredDetailSourceIds: ["wiki:1006", "wiki:1007"],
      forbiddenSourceIds: [],
      assertionSupport: {
        "assertion:review-interval-conflict": ["wiki:1006", "wiki:1007"],
      },
      requiredGapIds: ["gap:unresolved-authority"],
      expectedStrategyByMode: complexStrategies,
    },
  }),
  scenario({
    id: "chat-gold:no-evidence",
    question: "Does the attached empty placeholder define an escalation owner?",
    sources: [wiki("1008")],
    exactAnchorSourceIds: ["wiki:1008"],
    gold: {
      expectedOutcome: "abstained",
      relevantSourceIds: ["wiki:1008"],
      requiredDetailSourceIds: ["wiki:1008"],
      forbiddenSourceIds: [],
      assertionSupport: {},
      requiredGapIds: ["gap:no-evidence"],
      expectedStrategyByMode: directStrategies,
    },
  }),
  scenario({
    id: "chat-gold:context-switch",
    question: "Summarize the newly attached operating guide, not the page from the previous turn.",
    sources: [wiki("1009"), wiki("1010")],
    exactAnchorSourceIds: ["wiki:1010"],
    gold: {
      expectedOutcome: "answer",
      relevantSourceIds: ["wiki:1010"],
      requiredDetailSourceIds: ["wiki:1010"],
      forbiddenSourceIds: ["wiki:1009"],
      assertionSupport: { "assertion:new-context-guide": ["wiki:1010"] },
      requiredGapIds: [],
      expectedStrategyByMode: directStrategies,
    },
  }),
] as const satisfies readonly ChatEvaluationScenarioV1[];

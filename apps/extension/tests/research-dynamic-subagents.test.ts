import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { composeResearchGraphV1, type ResearchBriefV1 } from "@atlcli/research/graph";
import { ResearchCapabilityBroker } from "../utils/research/broker.js";
import { compileDynamicResearchSubagents } from "../utils/research/dynamic-subagents.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "Which Confluence content relates to Jira tickets?",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

const broker = new ResearchCapabilityBroker(request, {
  jira: { async searchPage() { return { items: [] }; }, async getIssue() { throw new Error("unused"); } },
  wiki: { async searchPage() { return { items: [] }; }, async getPage() { throw new Error("unused"); } },
});

const model = {
  invoke: async () => undefined,
} as unknown as BaseChatModel;

describe("dynamic DeepAgentsJS subagent composition", () => {
  test("compiles only selected role specs with role-scoped PTC tools", () => {
    const brief: ResearchBriefV1 = {
      schema: "atlcli.research-brief/v1",
      question: "Which Confluence content is related to Jira tickets?",
      products: ["jira", "confluence"],
      effort: "standard",
      reconciliation: "auto",
    };
    const graph = composeResearchGraphV1(brief, {
      grants: {
        "jira-retrieval": ["jira.issue.search"],
        "wiki-retrieval": ["wiki.search"],
      },
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxPacketChars: 8_000,
    });
    expect(specs.map((spec) => spec.name)).toEqual([
      "jira-retrieval",
      "wiki-retrieval",
      "cross-product-join",
      "reconciler",
    ]);
    expect(specs[0]?.tools).toBeUndefined();
    expect(specs[1]?.tools).toBeUndefined();
    expect(specs[0]?.middleware).toHaveLength(5);
    expect(specs[1]?.middleware).toHaveLength(5);
    expect(specs[2]?.middleware).toHaveLength(4);
    expect(specs[3]?.middleware).toHaveLength(4);
    expect(specs[0]?.responseFormat).toBeDefined();
  });

  test("does not expose catalog tools unless the graph explicitly grants them", () => {
    const graph = composeResearchGraphV1({
      schema: "atlcli.research-brief/v1",
      question: "Find the project and space first.",
      products: ["jira", "confluence"],
      effort: "shallow",
      reconciliation: "off",
    });
    const specs = compileDynamicResearchSubagents(graph, {
      model,
      broker,
      maxInterpreterMs: 5_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxPtcCalls: 8,
      maxPacketChars: 8_000,
    });
    expect(specs.flatMap((spec) => spec.tools?.map((tool) => tool.name) ?? [])).not.toContain("jira_project_search");
    expect(specs.flatMap((spec) => spec.tools?.map((tool) => tool.name) ?? [])).not.toContain("wiki_space_search");
  });
});

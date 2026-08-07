import { describe, expect, test } from "bun:test";
import { ResearchRunBudget } from "../budget.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchScopeV1,
} from "../contracts.js";
import { chatQualityPolicyV1 } from "../quality-policy.js";
import { CHAT_RECOVERY_GOLD_SCENARIOS_V1 } from "./testing/gold-scenarios.js";
import {
  assessChatStrategyReviewV1,
  createChatStrategyDecisionControllerV1,
  createChatStrategyReviewControllerV1,
  deriveChatAcquisitionProductsV1,
  deriveChatStrategyDecisionV1,
} from "./strategy.js";

const scope: ResearchScopeV1 = {
  siteOrigin: "https://tenant-a.atlassian.net",
  jiraProjectKeys: [],
  confluenceSpaceKeys: ["SPACE"],
};
const pageAnchor = {
  anchorRef: "research-anchor:page-1",
  product: "confluence" as const,
  entityKind: "page" as const,
  name: "Synthetic page",
};

describe("host-owned Chat strategy decisions", () => {
  test("matches every declared gold-scenario strategy gate", () => {
    for (const scenario of CHAT_RECOVERY_GOLD_SCENARIOS_V1) {
      const anchors = scenario.scope.exactAnchorSourceIds.map((sourceId, index) => {
        const source = scenario.sources.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error(`Missing gold source ${sourceId}`);
        return {
          anchorRef: `research-anchor:gold-${index}`,
          product: source.product,
          entityKind: source.product === "jira" ? "issue" as const : "page" as const,
          name: `Synthetic ${source.product} anchor`,
        };
      });
      const scenarioScope: ResearchScopeV1 = {
        siteOrigin: scenario.tenantOrigin,
        jiraProjectKeys: [...scenario.scope.jiraProjectKeys],
        confluenceSpaceKeys: [...scenario.scope.confluenceSpaceKeys],
      };
      for (const mode of ["quick", "auto", "deep"] as const) {
        const decision = deriveChatStrategyDecisionV1({
          qualityPolicy: chatQualityPolicyV1(mode),
          question: scenario.question,
          scope: scenarioScope,
          anchors,
        });
        expect(decision.execution).toBe(
          scenario.gold.expectedStrategyByMode[mode],
        );
      }
    }
  });

  test("keeps Quick direct regardless of complex intent", () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("quick"),
      question: "Compare the Jira tickets and linked Confluence policies for contradictions.",
      scope: { ...scope, jiraProjectKeys: ["DEMO"] },
      anchors: [pageAnchor],
    });
    expect(decision).toMatchObject({
      qualityMode: "quick",
      execution: "direct",
      expectedComplexity: "complex",
      ambiguityDisposition: "none",
    });
    expect(decision.reasonCodes).toContain("quick-direct");
    expect(decision.qualityRisks).toEqual([
      "multiple-sources",
      "cross-product",
      "contradictory-evidence",
    ]);
  });

  test("provider reasoning preference cannot change the host trajectory", () => {
    const base = {
      question: "Compare the Jira tickets and linked Confluence policies.",
      scope: { ...scope, jiraProjectKeys: ["DEMO"] },
      anchors: [pageAnchor],
    };
    const quick = chatQualityPolicyV1("quick");
    const ordinary = deriveChatStrategyDecisionV1({
      ...base,
      qualityPolicy: quick,
    });
    const providerOverride = deriveChatStrategyDecisionV1({
      ...base,
      qualityPolicy: { ...quick, providerReasoningPreference: "thorough" },
    });
    expect(providerOverride).toEqual(ordinary);
    expect(providerOverride.execution).toBe("direct");
  });

  test("selects direct Auto and Deep for one simple exact context", () => {
    for (const mode of ["auto", "deep"] as const) {
      const decision = deriveChatStrategyDecisionV1({
        qualityPolicy: chatQualityPolicyV1(mode),
        question: "Summarize the attached page.",
        scope,
        anchors: [pageAnchor],
      });
      expect(decision).toMatchObject({
        qualityMode: mode,
        execution: "direct",
        reasonCodes: ["single-exact-context"],
        expectedComplexity: "simple",
        qualityRisks: [],
      });
      expect(decision.requiredCapabilities).toEqual([
        "exact-read",
        "chat-answer",
      ]);
    }
  });

  test("reuses retained exact pages for a follow-up without turning allowed scope into discovery intent", () => {
    for (const question of [
      "Review the previous answer and correct every unsupported claim.",
      "Use the accepted evidence without any new sources.",
      "Prüfe die Zuordnung anhand der akzeptierten Belege. Nutze keine neuen Quellen.",
    ]) {
      const decision = deriveChatStrategyDecisionV1({
        qualityPolicy: chatQualityPolicyV1("deep"),
        question,
        scope,
        anchors: [
          pageAnchor,
          { ...pageAnchor, anchorRef: "research-anchor:page-2", name: "Second synthetic page" },
        ],
      });
      expect(decision).toMatchObject({
        execution: "agentic",
        reasonCodes: ["multi-anchor"],
        expectedComplexity: "moderate",
      });
      expect(decision.requiredCapabilities).toEqual([
        "exact-read",
        "quality-review",
        "chat-answer",
      ]);
      expect(decision.requiredCapabilities).not.toContain("confluence-discovery");
      expect(deriveChatAcquisitionProductsV1({
        decision,
        scope,
        anchors: [pageAnchor],
      })).toEqual({
        searchProducts: [],
        exactContextProducts: ["confluence"],
      });
    }
  });

  test("enables broad discovery when an exact-context question explicitly widens to the space", () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("auto"),
      question: "Search the whole space for related pages and compare them with this page.",
      scope,
      anchors: [pageAnchor],
    });
    expect(decision.execution).toBe("agentic");
    expect(decision.reasonCodes).toContain("broad-scope-discovery");
    expect(decision.requiredCapabilities).toContain("confluence-discovery");
    expect(deriveChatAcquisitionProductsV1({
      decision,
      scope,
      anchors: [pageAnchor],
    })).toEqual({
      searchProducts: ["confluence"],
      exactContextProducts: [],
    });
  });

  test("discovers within a bound space when no exact anchor exists", () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("auto"),
      question: "Where is the installation process documented?",
      scope,
      anchors: [],
    });
    expect(decision.execution).toBe("agentic");
    expect(decision.reasonCodes).toContain("broad-scope-discovery");
    expect(decision.requiredCapabilities).toContain("confluence-discovery");
  });

  test("keeps a single quoted-title lookup direct in Auto and Deep", () => {
    for (const mode of ["auto", "deep"] as const) {
      const decision = deriveChatStrategyDecisionV1({
        qualityPolicy: chatQualityPolicyV1(mode),
        question: "Summarize the page “Synthetic rollout decision”.",
        scope,
        anchors: [],
      });
      expect(decision).toMatchObject({
        execution: "direct",
        reasonCodes: ["single-title-discovery"],
        expectedComplexity: "simple",
        qualityRisks: [],
      });
      expect(decision.requiredCapabilities).toEqual([
        "confluence-discovery",
        "chat-answer",
      ]);
    }
  });

  test("honors an explicit no-new-search instruction even when scope is available", () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("deep"),
      question: "Correct the comparison from the retained evidence. Nutze keine neue Suche.",
      scope,
      anchors: [],
    });
    expect(decision.reasonCodes).toContain("no-atlassian-acquisition");
    expect(decision.requiredCapabilities).not.toContain("confluence-discovery");
    expect(deriveChatAcquisitionProductsV1({
      decision,
      scope,
      anchors: [],
    })).toEqual({
      searchProducts: [],
      exactContextProducts: [],
    });
  });

  test("selects agentic Auto and Deep for comparison, relationship, and contradiction cases", () => {
    for (const question of [
      "Compare the rollout criteria in both pages.",
      "Which Jira tickets are linked to the Confluence decision?",
      "Do the two current policies contradict each other?",
    ]) {
      for (const mode of ["auto", "deep"] as const) {
        const decision = deriveChatStrategyDecisionV1({
          qualityPolicy: chatQualityPolicyV1(mode),
          question,
          scope: { ...scope, jiraProjectKeys: ["DEMO"] },
          anchors: [pageAnchor],
        });
        expect(decision.execution).toBe("agentic");
        expect(decision.expectedComplexity).toBe("complex");
        expect(decision.requiredCapabilities).toContain("quality-review");
      }
    }
  });

  test("records ambiguity disposition but refuses to accept it inside a model run", async () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("deep"),
      question: "Compare the account spaces.",
      scope,
      anchors: [],
      unresolvedAmbiguity: true,
    });
    expect(decision.ambiguityDisposition).toBe("ask-user");
    const controller = createChatStrategyDecisionControllerV1({
      decision,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
    });
    await expect(controller.tool.invoke({})).rejects.toMatchObject({
      code: "clarification-required",
    });
  });

  test("acknowledges one revision-local accepted decision and fences content until then", async () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("auto"),
      question: "Compare the rollout criteria in both pages.",
      scope,
      anchors: [pageAnchor],
    });
    const accepted: string[] = [];
    const controller = createChatStrategyDecisionControllerV1({
      decision,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      onAcknowledged: (value) => {
        accepted.push(value.execution);
      },
    });
    expect(() => controller.assertAcknowledged()).toThrow("before Atlassian content work");
    expect(JSON.parse(await controller.tool.invoke({}))).toEqual(decision);
    expect(controller.acknowledgedDecision()).toEqual(decision);
    expect(accepted).toEqual(["agentic"]);
    expect(() => controller.assertAcknowledged()).not.toThrow();
    await expect(controller.tool.invoke({})).rejects.toThrow("already been acknowledged");
  });

  test("does not expose an acknowledgement when its publication fails", async () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("auto"),
      question: "Summarize the attached page.",
      scope,
      anchors: [pageAnchor],
    });
    const controller = createChatStrategyDecisionControllerV1({
      decision,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      onAcknowledged: () => {
        throw new Error("injected durable write failure");
      },
    });
    await expect(controller.tool.invoke({})).rejects.toThrow("durable write failure");
    expect(controller.acknowledgedDecision()).toBeUndefined();
    expect(() => controller.assertAcknowledged()).toThrow("before Atlassian content work");
  });

  test("reviews an agentic trajectory against the actual detailed evidence ledger", async () => {
    const decision = deriveChatStrategyDecisionV1({
      qualityPolicy: chatQualityPolicyV1("deep"),
      question: "Compare the linked Jira implementation with the Confluence policy.",
      scope: { ...scope, jiraProjectKeys: ["DEMO"] },
      anchors: [pageAnchor],
    });
    const detail = (
      id: string,
      product: "jira" | "confluence",
    ): Parameters<typeof assessChatStrategyReviewV1>[0]["detailEvidence"][number] => ({
      source: {
        id,
        product,
        title: `Synthetic ${product} source`,
        url: product === "jira"
          ? "https://tenant-a.atlassian.net/browse/DEMO-1"
          : "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      },
      content: {
        text: "Synthetic detail evidence.",
        linkTargets: [],
        truncated: false,
        inputBytes: 26,
      },
    });
    const evidence = [detail("wiki:1001", "confluence")];
    const first = assessChatStrategyReviewV1({ decision, detailEvidence: evidence });
    expect(first).toMatchObject({
      readyForAnswer: false,
      detailedProducts: ["confluence"],
      unmetCapabilityClasses: ["jira-discovery", "relationship-tracing", "comparison-analysis"],
    });
    const completeEvidence = [
      ...evidence,
      detail("jira:DEMO-1", "jira"),
    ];
    expect(assessChatStrategyReviewV1({
      decision,
      detailEvidence: completeEvidence,
    })).toMatchObject({ readyForAnswer: true, unmetCapabilityClasses: [] });

    let current = evidence;
    const controller = createChatStrategyReviewControllerV1({
      decision,
      budget: new ResearchRunBudget(DEFAULT_RESEARCH_LIMITS_V1),
      detailEvidence: () => current,
    });
    expect(JSON.parse(await controller.tool.invoke({}))).toMatchObject({
      readyForAnswer: false,
    });
    current = completeEvidence;
    expect(() => controller.assertCurrent()).toThrow("changed after its final");
    expect(JSON.parse(await controller.tool.invoke({}))).toMatchObject({
      readyForAnswer: true,
    });
    expect(() => controller.assertCurrent()).not.toThrow();
  });
});

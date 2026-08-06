import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessage } from "@langchain/core/messages";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ChatPresentationStreamEventV1,
  type ResearchRequestV1,
} from "../contracts.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
} from "../quality-policy.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import { finalizeChatAnswerV1 } from "./answer.js";
import {
  CHAT_SESSION_STATE_PATH_V1,
  ChatContractError,
  normalizeChatGapCodeV1,
  providerCompatibleChatAnswerSchemaV1,
  type ChatTurnRequestV1,
} from "./contracts.js";
import {
  chatRecursionLimitV1,
  createChatDirectToolSurfaceMiddlewareV1,
  createKiteweaveChatAgent,
  streamedJsonStringFieldV1,
  type ChatAgentRuntimeBindings,
} from "./runtime.js";
import {
  CHAT_CANDIDATE_LEDGER_PATH_V1,
  CHAT_RETRIEVAL_ASSESSMENT_PATH_V1,
  CHAT_RETRIEVAL_PLAN_PATH_V1,
} from "./retrieval-plan.js";
import { createKiteweaveResearchAgent } from "../agent-runtime-core.js";

const turn: ChatTurnRequestV1 = {
  schema: "atlcli.chat-turn-request/v1",
  conversationId: "chat-conversation:synthetic",
  turnId: "chat-turn:synthetic",
  question: "What does the attached page establish?",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["SPACE"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 30_000 },
  wikiProvider: "rest",
};

const brokerRequest: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: turn.question,
  scope: turn.scope,
  limits: turn.limits,
  wikiProvider: "rest",
};

const run = {
  model: "synthetic-model",
  startedAt: "2026-08-05T08:00:00.000Z",
  completedAt: "2026-08-05T08:00:01.000Z",
  durationMs: 1_000,
  counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 0, confluenceItems: 1 },
};

const syntheticPageSource = {
  id: "wiki:1001",
  product: "confluence" as const,
  title: "Synthetic page",
  url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
  contentId: "1001",
  spaceKey: "SPACE",
};

const syntheticCompleteContent = {
  text: "Die Seite beschreibt eine belegte Maßnahme.",
  inputBytes: 43,
  truncated: false,
  linkTargets: [] as string[],
};

describe("Chat answer contract", () => {
  test("keeps strict host validation while removing provider-unsupported schema keywords", () => {
    const serialized = JSON.stringify(providerCompatibleChatAnswerSchemaV1());
    for (const keyword of ["maxItems", "maxLength", "minLength", "pattern"]) {
      expect(serialized).not.toContain(`\"${keyword}\"`);
    }
    expect(serialized).toContain("citationSourceIds");
    expect(serialized).toContain("additionalProperties");
    expect(normalizeChatGapCodeV1("search-incomplete")).toBe("incomplete-coverage");
    expect(normalizeChatGapCodeV1("unverified-relationship")).toBe("unresolved-reference");
  });

  test("replaces evidence placeholders only with host-owned canonical links", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The page establishes the synthetic claim. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [{
        id: "wiki:1001",
        product: "confluence",
        title: "Synthetic page",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
        contentId: "1001",
        spaceKey: "SPACE",
      }],
      detailEvidence: [{
        source: {
          id: "wiki:1001",
          product: "confluence",
          title: "Synthetic page",
          url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
          contentId: "1001",
          spaceKey: "SPACE",
        },
        content: {
          text: "Synthetic body",
          inputBytes: 14,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.messageMarkdown).toContain(
      "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)",
    );
    expect(answer.messageMarkdown).not.toContain("[[source:");
    expect(answer.strategy).toEqual({
      qualityMode: "quick",
      path: "direct",
      delegated: false,
      reasonCode: "quick-direct",
      reasonCodes: ["quick-direct"],
      ambiguityDisposition: "none",
      requiredCapabilities: ["exact-read", "chat-answer"],
      expectedComplexity: "simple",
      qualityRisks: [],
    });
  });

  test("preserves validated Confluence section locators as heading deep links", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown:
          "The decision is documented here. [[source:wiki:1001#section:003:top-3-mobile]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        section: {
          sectionId: "section:003:top-3-mobile",
          heading: "TOP 3 — Mobile (10 min, erstmals behandelt)",
          order: 3,
        },
        content: {
          text: "The section records the decision.",
          inputBytes: 33,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    const expectedUrl =
      "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001#TOP-3-%E2%80%94-Mobile-(10-min%2C-erstmals-behandelt)";
    expect(answer.messageMarkdown).toContain(
      `[TOP 3 — Mobile (10 min, erstmals behandelt)](${expectedUrl})`,
    );
    expect(answer.citations).toEqual([{
      sourceId: "wiki:1001",
      title: "TOP 3 — Mobile (10 min, erstmals behandelt)",
      url: expectedUrl,
      product: "confluence",
      section: {
        sectionId: "section:003:top-3-mobile",
        heading: "TOP 3 — Mobile (10 min, erstmals behandelt)",
      },
    }]);
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
  });

  test("preserves a section deep link from a complete page read without a redundant section read", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The complete page establishes this decision. [[source:wiki:1001#section:003:decision]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
        coverage: {
          issues: [],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: false,
          unreadSections: 0,
          completeDocumentRead: true,
        },
      }],
      readSectionReferences: [{
        sourceId: "wiki:1001",
        sectionId: "section:003:decision",
        heading: "Decision",
        order: 3,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    const expectedUrl =
      "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001#Decision";
    expect(answer.messageMarkdown).toContain(`[Decision](${expectedUrl})`);
    expect(answer.citations).toEqual([expect.objectContaining({
      sourceId: "wiki:1001",
      url: expectedUrl,
      section: {
        sectionId: "section:003:decision",
        heading: "Decision",
      },
    })]);
  });

  test("removes a forged Confluence section locator instead of degrading it to a page link", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Unsupported section claim. [[source:wiki:1001#section:999:forged]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        section: {
          sectionId: "section:003:real",
          heading: "Real section",
          order: 3,
        },
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("No detail-backed claim remained");
    expect(answer.citations).toEqual([]);
    expect(answer.gaps).toEqual([expect.objectContaining({ code: "no-detail-evidence" })]);
  });

  test("preserves a supported page claim when its unverified section locator must be downgraded", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "### Relevant topic",
          "The visible page projection supports this useful summary. [[source:wiki:1001#section:999:not-read]]",
        ].join("\n\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.messageMarkdown).toContain("The visible page projection supports this useful summary.");
    expect(answer.messageMarkdown).toContain(
      "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)",
    );
    expect(answer.messageMarkdown).not.toContain("#section:999:not-read");
    expect(answer.messageMarkdown).not.toContain("section reference was not read separately");
    expect(answer.citations).toEqual([{
      sourceId: "wiki:1001",
      title: "Synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      product: "confluence",
    }]);
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "unresolved-reference",
      sourceIds: ["wiki:1001"],
    })]);
  });

  test("omits unsupported citation claims and still rejects unknown gap evidence", () => {
    const base = {
      sources: [],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    const omitted = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "Unsupported. [[source:wiki:missing]]",
        citationSourceIds: ["wiki:missing"],
        gaps: [],
      },
    });
    expect(omitted.messageMarkdown).toContain("No detail-backed claim remained");
    expect(omitted.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
    expect(() => finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "No evidence is available.",
        citationSourceIds: [],
        gaps: [{
          code: "no-detail-evidence",
          message: "No detailed source could be read.",
          sourceIds: ["wiki:missing"],
        }],
      },
    })).toThrow("unknown evidence");
  });

  test("derives citations from validated detail-backed placeholders despite redundant array drift", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Belegte Aussage. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:unused-search-result"],
        gaps: [],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });
    expect(answer.evidenceRefs).toEqual(["wiki:1001"]);
    expect(answer.citations).toEqual([expect.objectContaining({
      sourceId: "wiki:1001",
    })]);
  });

  test("removes Jira-key claims that lack a same-line detailed citation", () => {
    const jiraSource = {
      id: "jira:DEMO-1",
      product: "jira" as const,
      title: "Detailed issue",
      url: "https://tenant-a.atlassian.net/browse/DEMO-1",
      issueKey: "DEMO-1",
      projectKey: "DEMO",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "DEMO-1 belegt die Umsetzung. [[source:jira:DEMO-1]]",
          "DEMO-2 scheint ebenfalls zu passen.",
        ].join("\n"),
        citationSourceIds: ["jira:DEMO-1", "jira:DEMO-2"],
        gaps: [],
      },
      sources: [
        jiraSource,
        {
          id: "jira:DEMO-2",
          product: "jira",
          title: "Search-only issue",
          url: "https://tenant-a.atlassian.net/browse/DEMO-2",
          issueKey: "DEMO-2",
          projectKey: "DEMO",
        },
      ],
      detailEvidence: [{
        source: jiraSource,
        content: {
          text: "Detailed Jira evidence.",
          inputBytes: 23,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
      locale: "de",
    });
    expect(answer.messageMarkdown).toContain("DEMO-1");
    expect(answer.messageMarkdown).not.toContain("DEMO-2");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "no-detail-evidence",
    })]);
  });

  test("allows a gap to identify a discovered source without treating it as citation evidence", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The remaining candidate was not read in detail.",
        citationSourceIds: [],
        gaps: [{
          code: "incomplete-coverage",
          message: "One discovered candidate remains unread.",
          sourceIds: ["wiki:1002"],
        }],
      },
      sources: [{
        id: "wiki:1002",
        product: "confluence",
        title: "Unread synthetic candidate",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1002",
        contentId: "1002",
        spaceKey: "SPACE",
      }],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.citations).toEqual([]);
    expect(answer.gaps[0]?.sourceIds).toEqual(["wiki:1002"]);
  });

  test("requires a material coverage gap for a cited partial document projection", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Long synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const base = {
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "A visible excerpt supports the positive statement.",
          inputBytes: 40_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["projection_limit" as const],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: false,
          unreadSections: 3,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    const bounded = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The complete page contains no other constraint. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
    });
    expect(bounded.messageMarkdown).not.toContain("contains no other constraint");
    expect(bounded.messageMarkdown).toContain("does not establish what is absent");
    expect(bounded.messageMarkdown).toContain("Coverage limit");
    expect(bounded.gaps).toEqual([expect.objectContaining({
      code: "incomplete-coverage",
      sourceIds: ["wiki:1001"],
    })]);

    const answer = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The visible section supports the positive statement. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage",
          message: "Three unrelated sections were not read.",
          sourceIds: ["wiki:1001"],
        }],
      },
    });
    expect(answer.messageMarkdown).toContain("positive statement");
    expect(answer.gaps).toHaveLength(1);
  });

  test("removes only unsupported whole-document negatives from a supported partial answer", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Long synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "The visible section establishes the approved rollout.",
          "The entire page has no other constraint. [[source:wiki:1001]]",
        ].join(" "),
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "The visible section establishes the approved rollout.",
          inputBytes: 50_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["unresolved_include"],
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: true,
          unreadSections: 2,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    });
    expect(answer.messageMarkdown).toContain("visible section establishes");
    expect(answer.messageMarkdown).not.toContain("entire page has no other constraint");
    expect(answer.messageMarkdown).toContain("included Confluence item was not resolved");
  });

  test("renders parser and source limits as a material localized gap", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Bounded synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "Der lesbare Ausschnitt belegt den sichtbaren Beschluss. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "Der sichtbare Beschluss ist freigegeben.",
          inputBytes: 4_500_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          issues: ["parse_budget"],
          sourceTruncated: false,
          outlineTruncated: true,
          projectionTruncated: true,
          unreadSections: 0,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
      locale: "de",
    });
    expect(answer.messageMarkdown).toContain("sichtbaren Beschluss");
    expect(answer.messageMarkdown).toContain("nur teilweise verarbeitet");
    expect(answer.gaps).toEqual([expect.objectContaining({
      code: "incomplete-coverage",
      sourceIds: ["wiki:1001"],
    })]);
  });

  test("turns a missing required product into a search gap instead of an absence claim", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: [
          "Die Confluence-Seite beschreibt eine belegte Maßnahme. [[source:wiki:1001]]",
          "## Vergleich mit dem Jira-Projekt",
          "Keine Übereinstimmungen sind feststellbar.",
          "| Maßnahme | Jira-Status |",
          "|---|---|",
          "| Validierung | Kein Issue |",
          "Im Jira-Projekt existiert kein einziges passendes Ticket.",
          "GROW-42 scheint die Umsetzung zu belegen.",
          "## Verbleibende Einordnung",
          "Die belegte Confluence-Maßnahme bleibt gültig.",
        ].join("\n"),
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage" as const,
          message: "Die Jira-Suche lieferte keine Detailbelege.",
          sourceIds: [],
        }],
      },
      sources: [syntheticPageSource],
      detailEvidence: [{
        source: syntheticPageSource,
        content: syntheticCompleteContent,
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      strategyDecision: {
        schema: "atlcli.chat-strategy-decision/v1",
        qualityMode: "auto",
        execution: "agentic",
        reasonCodes: ["cross-product-relationship"],
        ambiguityDisposition: "none",
        requiredCapabilities: [
          "jira-discovery",
          "confluence-discovery",
          "relationship-tracing",
          "quality-review",
          "chat-answer",
        ],
        expectedComplexity: "complex",
        qualityRisks: ["cross-product"],
      },
      strategyReview: {
        schema: "atlcli.chat-strategy-review/v1",
        execution: "agentic",
        detailedSourceIds: ["wiki:1001"],
        detailedProducts: ["confluence"],
        unmetCapabilityClasses: ["jira-discovery", "relationship-tracing"],
        readyForAnswer: false,
      },
      locale: "de",
      run,
    });
    expect(answer.messageMarkdown).toContain("belegte Maßnahme");
    expect(answer.messageMarkdown).not.toContain("Keine Übereinstimmungen");
    expect(answer.messageMarkdown).not.toContain("Kein Issue");
    expect(answer.messageMarkdown).not.toContain("kein einziges");
    expect(answer.messageMarkdown).not.toContain("GROW-42");
    expect(answer.messageMarkdown).toContain("bleibt gültig");
    expect(answer.messageMarkdown).toContain("belegt weder");
    expect(answer.gaps.some((gap) => gap.message.includes("belegt weder"))).toBe(true);
  });
});

describe("separate Chat root", () => {
  test("projects only complete JSON string units from a streamed answer envelope", () => {
    expect(streamedJsonStringFieldV1('{"messageMarkdown":"Hello\\n**wor', "messageMarkdown"))
      .toBe("Hello\n**wor");
    expect(streamedJsonStringFieldV1('{"messageMarkdown":"Hello\\u2', "messageMarkdown"))
      .toBe("Hello");
    expect(streamedJsonStringFieldV1(
      '{"messageMarkdown":"Hello\\u263a","gaps":[{"message":"secret envelope field"}]}',
      "messageMarkdown",
    )).toBe("Hello☺");
    expect(streamedJsonStringFieldV1('{"gaps":["not an answer"]}', "messageMarkdown"))
      .toBeUndefined();
  });

  test("hides DeepAgents filesystem and task tools from the direct Chat model", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1();
    let visibleNames: string[] = [];
    await middleware.wrapModelCall?.(
      {
        tools: [
          { name: "ls" },
          { name: "task" },
          { name: "eval" },
          { name: "write_file" },
        ],
      } as never,
      async (request) => {
        visibleNames = request.tools.map((candidate) => String(candidate.name));
        return {} as never;
      },
    );
    expect(visibleNames).toEqual(["eval"]);
  });

  test("closes an accepted agentic workflow without a supervisor rewrite", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1(undefined, {
      agenticWorkflowComplete: () => true,
    });
    let providerCalled = false;
    const response = await middleware.wrapModelCall?.(
      { tools: [{ name: "eval" }] } as never,
      async () => {
        providerCalled = true;
        return {} as never;
      },
    );
    expect(providerCalled).toBe(false);
    expect((response as AIMessage).text).toBe("Agentic Chat synthesis accepted.");
  });

  test("derives a bounded graph ceiling from the admitted PTC budget", () => {
    expect(chatRecursionLimitV1(1)).toBe(24);
    expect(chatRecursionLimitV1(16)).toBe(40);
    expect(chatRecursionLimitV1(10_000)).toBe(56);
  });

  function runtimeHarness() {
    let chatRoots = 0;
    let researchRoots = 0;
    const chatRuntime = {
      StateBackend: class {},
      createDeepAgent: (options: { name?: string }) => {
        chatRoots += 1;
        expect(options.name).toBe("kiteweave-chat-agent");
        return {
          streamEvents: async () => ({
            messages: (async function* () {
              yield {
                text: (async function* () {
                  yield '{"messageMarkdown":"No detailed Atlassian ';
                  yield 'evidence was needed for this response.","citationSourceIds":[],"gaps":[]}';
                })(),
                reasoning: (async function* () { yield "Checking the selected evidence."; })(),
              };
            })(),
            output: Promise.resolve({
              messages: [],
              structuredResponse: {
                messageMarkdown: "No detailed Atlassian evidence was needed for this response.",
                citationSourceIds: [],
                gaps: [],
              },
            }),
          }),
        };
      },
      registerHarnessProfile: () => undefined,
    } as unknown as ChatAgentRuntimeBindings;
    const researchRuntime = {
      CompositeBackend: class {},
      StateBackend: class {},
      createDeepAgent: () => {
        researchRoots += 1;
        return { invoke: async () => ({ messages: [] }) };
      },
      createFilesystemMiddleware: () => ({}),
      createSubAgentMiddleware: () => ({}),
      createSummarizationMiddleware: () => ({}),
      registerHarnessProfile: () => undefined,
    } as never;
    return { chatRuntime, researchRuntime, counts: () => ({ chatRoots, researchRoots }) };
  }

  test("constructs exactly one Chat root and does not construct the Research root", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    createKiteweaveResearchAgent(harness.researchRuntime);
    const workspace = createMemoryResearchWorkspace();
    const presentation: ChatPresentationStreamEventV1[] = [];
    const answer = await chat.runChatAgent({
      modelBinding: {
        model: {} as BaseChatModel,
        modelId: "synthetic-streaming-model",
        qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
        structuredOutput: "native",
        reasoningPresentation: "summary",
      },
      turn,
      brokerRequest,
      providers: {
        jira: {
          searchPage: async () => { throw new Error("unexpected Jira search"); },
          getIssue: async () => { throw new Error("unexpected Jira detail"); },
        },
        wiki: {
          searchPage: async () => { throw new Error("unexpected wiki search"); },
          getPage: async () => { throw new Error("unexpected wiki detail"); },
        },
      },
      workspace,
      qualityPolicy: chatQualityPolicyV1("quick"),
      onChatPresentation: (event) => presentation.push(event),
      now: (() => {
        let value = Date.parse("2026-08-05T08:00:00.000Z");
        return () => value++;
      })(),
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.run.retrieval).toMatchObject({
      discoveredCandidates: 0,
      admittedCandidates: 0,
      detailReadCandidates: 0,
      detailReadCoverage: 0,
      canonicalUrlCorrectness: 0,
      atlassianHttpCalls: 0,
    });
    expect(presentation.filter((event) => event.channel === "reasoning-summary")).toEqual([
      expect.objectContaining({ channel: "reasoning-summary", status: "started" }),
      expect.objectContaining({
        channel: "reasoning-summary",
        status: "delta",
        delta: "Checking the selected evidence.",
      }),
      expect.objectContaining({ channel: "reasoning-summary", status: "completed" }),
    ]);
    expect(presentation.filter((event) => event.channel === "answer-markdown")).toEqual([
      expect.objectContaining({ channel: "answer-markdown", status: "started" }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: "No detailed Atlassian ",
      }),
      expect.objectContaining({
        channel: "answer-markdown",
        status: "delta",
        delta: "evidence was needed for this response.",
      }),
      expect.objectContaining({ channel: "answer-markdown", status: "completed" }),
    ]);
    expect(answer.messageMarkdown).not.toMatch(/executive summary|findings|limitations/iu);
    expect(harness.counts()).toEqual({ chatRoots: 1, researchRoots: 0 });
    expect(JSON.parse((await workspace.readFile(CHAT_SESSION_STATE_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-session-state/v1",
      conversationId: turn.conversationId,
    });
    expect(JSON.parse((await workspace.readFile(CHAT_RETRIEVAL_PLAN_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-retrieval-plan/v1",
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      anchors: [],
      resolvedEntities: [{
        product: "confluence",
        entityKind: "space",
        key: "SPACE",
      }],
      searches: [{ product: "confluence" }],
      relationshipTraversals: [{ kind: "confluence-to-jira-reference" }],
    });
    expect(JSON.parse((await workspace.readFile(CHAT_CANDIDATE_LEDGER_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-candidate-ledger/v1",
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      candidates: [],
    });
    expect(JSON.parse((await workspace.readFile(CHAT_RETRIEVAL_ASSESSMENT_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-retrieval-assessment/v1",
      sufficient: false,
      metrics: {
        discoveredCandidates: 0,
        detailReadCandidates: 0,
      },
    });
  });

  test("does not expose reasoning or assistant text without an explicit provider summary grant", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    const presentation: ChatPresentationStreamEventV1[] = [];
    await chat.runChatAgent({
      modelBinding: {
        model: {} as BaseChatModel,
        modelId: "synthetic-ungated-model",
        qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
        structuredOutput: "tool",
      },
      turn,
      brokerRequest,
      providers: {
        jira: {
          searchPage: async () => { throw new Error("unexpected Jira search"); },
          getIssue: async () => { throw new Error("unexpected Jira detail"); },
        },
        wiki: {
          searchPage: async () => { throw new Error("unexpected wiki search"); },
          getPage: async () => { throw new Error("unexpected wiki detail"); },
        },
      },
      workspace: createMemoryResearchWorkspace(),
      qualityPolicy: chatQualityPolicyV1("quick"),
      onChatPresentation: (event) => presentation.push(event),
    });

    expect(presentation).toEqual([]);
  });

  test("rejects an incompatible persisted state before root construction", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile(CHAT_SESSION_STATE_PATH_V1, JSON.stringify({
      schema: "atlcli.research-session/v1",
      conversationId: turn.conversationId,
    }));
    await expect(chat.runChatAgent({
      model: {} as BaseChatModel,
      turn,
      brokerRequest,
      providers: {
        jira: { searchPage: async () => ({ items: [] }), getIssue: async () => { throw new Error(); } },
        wiki: { searchPage: async () => ({ items: [] }), getPage: async () => { throw new Error(); } },
      },
      workspace,
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(harness.counts().chatRoots).toBe(0);
  });

  test("keeps forbidden Research completion modules outside the Chat runtime import boundary", async () => {
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "@langchain/anthropic",
      "../brief.js",
      "../graph.js",
      "../agent-draft.js",
      "../report.js",
      "../report-v2.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("./answer.js");
    expect(source).toContain("./prompts.js");
  });
});

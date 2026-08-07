import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_SCOPE_BINDING_SCHEMA_V1,
  type ResearchScopeBindingV1,
} from "../contracts.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import {
  CHAT_CANDIDATE_LEDGER_PATH_V1,
  CHAT_RETRIEVAL_PLAN_PATH_V1,
  ChatCandidateLedgerControllerV1,
  createChatRetrievalPlanV1,
  type ChatRetrievalPlanProposalV1,
} from "./retrieval-plan.js";

const ORIGIN = "https://tenant-a.atlassian.net";

function binding(input: {
  id: string;
  product: "jira" | "confluence";
  entityKind: "project" | "space" | "issue" | "page";
  key: string;
  name: string;
}): ResearchScopeBindingV1 {
  return {
    schema: RESEARCH_SCOPE_BINDING_SCHEMA_V1,
    id: input.id,
    tenantOrigin: ORIGIN,
    product: input.product,
    entityKind: input.entityKind,
    entityRef: `research-scope-entity:${input.id.replaceAll(":", "-")}`,
    key: input.key,
    name: input.name,
    source: "cli_flag",
    authority: "locked",
  };
}

function plan(input: {
  proposal?: ChatRetrievalPlanProposalV1;
  anchors?: Array<{
    anchorRef: string;
    product: "jira" | "confluence";
    entityKind: "issue" | "page";
    name: string;
  }>;
  searchProducts?: Array<"jira" | "confluence">;
  exactProducts?: Array<"jira" | "confluence">;
  maxPtcCalls?: number;
  relationshipTracing?: boolean;
  scopeBindings?: ResearchScopeBindingV1[];
} = {}) {
  return createChatRetrievalPlanV1({
    conversationId: "conversation:synthetic",
    turnId: "turn:synthetic",
    question: "Compare the quoted decision with its implementation.",
    anchors: input.anchors ?? [],
    scopeBindings: input.scopeBindings ?? [
      binding({
        id: "binding:project",
        product: "jira",
        entityKind: "project",
        key: "DEMO",
        name: "Demo project",
      }),
      binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      }),
    ],
    searchProducts: input.searchProducts ?? ["jira", "confluence"],
    exactContextProducts: input.exactProducts ?? [],
    limits: {
      ...DEFAULT_RESEARCH_LIMITS_V1,
      maxPtcCalls: input.maxPtcCalls ?? DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
    },
    agentic: true,
    ...(input.relationshipTracing === undefined
      ? {}
      : { relationshipTracing: input.relationshipTracing }),
    ...(input.proposal ? { proposal: input.proposal } : {}),
    now: () => Date.parse("2026-08-06T10:00:00.000Z"),
  });
}

function searchResult(input: {
  items: Array<{
    sourceId: string;
    entityRef: string;
    title: string;
    url: string;
    updatedAt?: string;
  }>;
  nextCursor?: string;
  complete: boolean;
  termination?: "index-exhausted" | "page-limit";
}) {
  return {
    schema: "atlcli.ptc/wiki.search.output/v1",
    items: input.items.map((item) => ({ ...item, product: "confluence" as const })),
    page: {
      ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
      complete: input.complete,
      ...(input.termination ? { termination: input.termination } : {}),
    },
    budget: {
      ptcRemaining: 10,
      httpAttemptsRemaining: 10,
      responseBytesRemaining: 10_000,
    },
  };
}

describe("Chat retrieval plan", () => {
  test("accepts the binding ID of a personal Confluence space", () => {
    const result = plan({
      searchProducts: ["confluence"],
      scopeBindings: [binding({
        id: "scope-binding:current_context:confluence:~account-123",
        product: "confluence",
        entityKind: "space",
        key: "~account-123",
        name: "Personal space",
      })],
    });

    expect(result.resolvedEntities).toEqual([
      expect.objectContaining({
        bindingId: "scope-binding:current_context:confluence:~account-123",
        key: "~account-123",
      }),
    ]);
  });

  test("binds anchors and resolved scope before safe focused searches", () => {
    const result = plan({
      anchors: [{
        anchorRef: "research-anchor:page",
        product: "confluence",
        entityKind: "page",
        name: "Attached page",
      }],
      exactProducts: ["confluence"],
    });

    expect(result.anchors).toHaveLength(1);
    expect(result.resolvedEntities.map((entry) => entry.bindingId)).toEqual([
      "binding:project",
      "binding:space",
    ]);
    expect(result.searches.map((entry) => entry.product)).toEqual(["jira"]);
    expect(result.searches[0]?.scopeBindingIds).toEqual(["binding:project"]);
    expect(result.completionSignals).toContain("all-anchors-read");
    expect(result.budgetReservations.supervisorCalls).toBe(12);
    expect(result.budgetReservations.detailCallsByProduct).toEqual({
      jira: 12,
      confluence: 0,
    });
    expect(result.budgetReservations.totalCalls).toBeLessThanOrEqual(
      DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
    );
  });

  test("turns German-quoted titles into exact bounded variants instead of searching instructions", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:quoted-titles",
      turnId: "turn:quoted-titles",
      question: [
        "Wie hängen die Seiten ‚Alpha Modernisierung‘, ‚Content-Pipeline‘,",
        "‚Lead Pipeline‘ und ‚Account Data‘ zusammen? Lies jeden Kandidaten",
        "im Detail und liefere kanonische URLs.",
      ].join(" "),
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      agentic: false,
      now: () => Date.parse("2026-08-06T10:00:00.000Z"),
    });

    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "Alpha Modernisierung",
      "Content-Pipeline",
      "Lead Pipeline",
      "Account Data",
      expect.not.stringContaining("kanonische URLs"),
    ]);
    expect(result.searches[0]?.variants.map((variant) => variant.query.text))
      .not.toContain("urls");
    expect(result.searches[0]?.variants.every((variant) =>
      (variant.query.text?.length ?? 0) < 240
    )).toBe(true);
  });

  test("admits bounded alternate-title and synonym variants without raw JQL or CQL", () => {
    const result = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "title", query: { text: "holiday process" } },
            { variantId: "synonym", query: { text: "vacation absence" } },
          ],
          maxPages: 2,
        }],
        unresolvedTerms: [],
      },
    });
    expect(result.searches[0]?.variants.map((variant) => variant.variantId)).toEqual([
      "title",
      "synonym",
    ]);

    expect(() => plan({
      searchProducts: ["jira"],
      proposal: {
        searches: [{
          searchId: "search:jira",
          product: "jira",
          variants: [{
            variantId: "raw-jql",
            query: { text: "project = DEMO ORDER BY created DESC" },
          }],
          maxPages: 1,
        }],
      },
    })).toThrow("Raw CQL or JQL");
  });

  test("does not let a model proposal displace explicit Confluence titles", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:required-titles",
      turnId: "turn:required-titles",
      question: "Compare ‘Page Alpha’, ‘Page Beta’, ‘Page Gamma’, and ‘Page Delta’.",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [{
            variantId: "model-summary",
            query: { text: "broad comparison" },
            expectedInformationGain: "high",
          }],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
      now: () => Date.parse("2026-08-07T09:00:00.000Z"),
    });

    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "Page Alpha",
      "Page Beta",
      "Page Gamma",
      "Page Delta",
      "broad comparison",
    ]);
  });

  test("does not let a model proposal displace explicit Jira keys", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:required-keys",
      turnId: "turn:required-keys",
      question: "Compare DEMO-7 and DEMO-9 with the release plan.",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:project",
        product: "jira",
        entityKind: "project",
        key: "DEMO",
        name: "Demo project",
      })],
      searchProducts: ["jira"],
      exactContextProducts: [],
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:jira",
          product: "jira",
          variants: [{
            variantId: "model-release",
            query: { text: "release plan" },
            expectedInformationGain: "high",
          }],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
      now: () => Date.parse("2026-08-07T09:00:00.000Z"),
    });

    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "DEMO-7",
      "DEMO-9",
      "release plan",
    ]);
  });

  test("derives relationship traversal direction from the available source product", () => {
    const confluenceOnly = plan({ searchProducts: ["confluence"] });
    expect(confluenceOnly.relationshipTraversals).toEqual([{
      traversalId: "traversal:confluence-to-jira-reference",
      kind: "confluence-to-jira-reference",
      maxDepth: 1,
    }]);

    const jiraOnly = plan({ searchProducts: ["jira"] });
    expect(jiraOnly.relationshipTraversals).toEqual([{
      traversalId: "traversal:jira-to-confluence-remote-link",
      kind: "jira-to-confluence-remote-link",
      maxDepth: 1,
    }]);

    const noRelationshipIntent = plan({
      searchProducts: ["confluence"],
      relationshipTracing: false,
    });
    expect(noRelationshipIntent.relationshipTraversals).toEqual([]);
  });

  test("orders bounded query variants by declared expected information gain", () => {
    const result = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            {
              variantId: "fallback",
              query: { text: "broad fallback wording" },
              expectedInformationGain: "low",
            },
            {
              variantId: "direct-title",
              query: { text: "exact alternate title" },
              expectedInformationGain: "high",
            },
          ],
          maxPages: 1,
        }],
      },
    });
    expect(result.searches[0]?.variants.map((variant) => variant.variantId)).toEqual([
      "direct-title",
      "fallback",
    ]);
  });

  test("clamps per-variant pagination so every admitted query fits the product root budget", () => {
    const result = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "primary", query: { text: "atlcli" } },
            { variantId: "synonym", query: { text: "command line" } },
            { variantId: "title", query: { text: "getting started" } },
          ],
          maxPages: 5,
        }],
      },
    });
    expect(result.searches[0]?.maxPages).toBe(1);
    expect(
      result.searches[0]!.maxPages * result.searches[0]!.variants.length,
    ).toBeLessThanOrEqual(DEFAULT_RESEARCH_LIMITS_V1.maxSearchPagesPerProduct);
  });

  test("adds a concise shared core term when verbose model variants would miss exact content", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:synthetic",
      turnId: "turn:synthetic",
      question: "Welche Inhalte erklären Installation und erste Nutzung von atlcli?",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "de", query: { text: "atlcli Installation erste Nutzung" } },
            { variantId: "en", query: { text: "atlcli installation getting started" } },
            { variantId: "docs", query: { text: "atlcli command line documentation" } },
          ],
          maxPages: 2,
        }],
      },
    });
    expect(result.searches[0]?.variants[0]).toMatchObject({
      variantId: "host-core-term",
      query: { text: "atlcli" },
      expectedInformationGain: "high",
    });
    expect(result.searches[0]?.variants).toHaveLength(3);
  });

  test("preserves a technical identifier as a host core query beside one verbose variant", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:synthetic",
      turnId: "turn:synthetic",
      question: "Vergleiche die dokumentierten Installationswege für atlcli.",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxSearchPagesPerProduct: 2 },
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:confluence",
          product: "confluence",
          variants: [{
            variantId: "model-installation",
            query: { text: "Installation und Konfiguration" },
            expectedInformationGain: "high",
          }],
          maxPages: 2,
        }],
      },
    });
    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "atlcli",
      "Installation und Konfiguration",
    ]);
    expect(result.searches[0]?.maxPages).toBe(1);
  });

  test("prefers an explicit mixed-case product term over a hyphenated scope phrase", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:synthetic",
      turnId: "turn:synthetic",
      question:
        "Welche Prinzipien aus den Plattform-Inhalten zu Adaptive Teams und OrbitStack sind belegt?",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxSearchPagesPerProduct: 2 },
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:confluence",
          product: "confluence",
          variants: [{
            variantId: "verbose",
            query: { text: "rollen dynamische workflows verifikation sandbox observability" },
          }],
          maxPages: 1,
        }],
      },
    });

    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "orbitstack",
      "rollen dynamische workflows verifikation sandbox observability",
    ]);
  });

  test("drops low-value variants that cannot receive one page inside a compact Chat budget", () => {
    const result = createChatRetrievalPlanV1({
      conversationId: "conversation:compact",
      turnId: "turn:compact",
      question: "Welche Inhalte erklären Installation und erste Nutzung von atlcli?",
      anchors: [],
      scopeBindings: [binding({
        id: "binding:space",
        product: "confluence",
        entityKind: "space",
        key: "KB",
        name: "Knowledge base",
      })],
      searchProducts: ["confluence"],
      exactContextProducts: [],
      limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxSearchPagesPerProduct: 2 },
      agentic: true,
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "de", query: { text: "atlcli Installation erste Nutzung" } },
            { variantId: "en", query: { text: "atlcli installation getting started" } },
            { variantId: "docs", query: { text: "atlcli command line documentation" } },
          ],
          maxPages: 2,
        }],
      },
    });
    expect(result.searches[0]?.variants.map((variant) => variant.query.text)).toEqual([
      "atlcli",
      "atlcli Installation erste Nutzung",
    ]);
    expect(result.searches[0]?.maxPages).toBe(1);
  });

  test("rejects traversal depth, scope, cursor-like fields, and capability-budget overflow", () => {
    expect(() => plan({
      proposal: {
        searches: [{
          searchId: "search:unknown",
          product: "jira",
          variants: [{
            variantId: "cursor",
            query: { text: "demo", cursor: "forged" } as never,
          }],
          maxPages: 1,
        }],
      },
    })).toThrow("unsupported fields");
    expect(() => plan({
      proposal: {
        relationshipTraversals: [{
          traversalId: "deep",
          kind: "confluence-to-jira-reference",
          maxDepth: 2,
        } as never],
      },
    })).toThrow("too deep");
    expect(() => plan({ maxPtcCalls: 3 })).toThrow("capability-call budget");
  });
});

describe("Chat candidate ledger", () => {
  test("persists an out-of-scope exact link as approval-only metadata without admitting it", async () => {
    const workspace = createMemoryResearchWorkspace();
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: plan({
        anchors: [{
          anchorRef: "research-anchor:jira",
          product: "jira",
          entityKind: "issue",
          name: "DEMO-42",
        }],
        exactProducts: ["jira"],
        maxPtcCalls: 50,
      }),
      workspace,
      siteOrigin: ORIGIN,
    });
    await ledger.initialize();
    await ledger.observeRelatedScopeCandidate({
      product: "confluence",
      entityKind: "page",
      key: "2003",
      scopeKey: "OTHER",
      name: "Confluence 2003",
      canonicalUrl: `${ORIGIN}/wiki/spaces/OTHER/pages/2003/Foreign+page`,
      discoveredFromProduct: "jira",
      discoveredFromSourceId: "jira:DEMO-42",
      reason: "explicit-link-outside-bound-scope",
    });

    expect(ledger.snapshot()).toMatchObject({
      candidates: [],
      relatedScopeProposals: [{
        product: "confluence",
        key: "2003",
        scopeKey: "OTHER",
        status: "pending-user-approval",
      }],
    });
    expect(ledger.assessment()).toMatchObject({
      sufficient: false,
      reasons: expect.arrayContaining(["related-scope-approval-required"]),
    });
    expect(await workspace.readFile(CHAT_CANDIDATE_LEDGER_PATH_V1)).toContain(
      "pending-user-approval",
    );

    await expect(ledger.observeRelatedScopeCandidate({
      product: "confluence",
      entityKind: "page",
      key: "2004",
      scopeKey: "OTHER",
      name: "Foreign tenant page",
      canonicalUrl: "https://tenant-b.atlassian.net/wiki/spaces/OTHER/pages/2004",
      discoveredFromProduct: "jira",
      discoveredFromSourceId: "jira:DEMO-42",
      reason: "explicit-link-outside-bound-scope",
    })).rejects.toThrow("outside the bound tenant");
  });

  test("accepts one model-proposed bounded replan before acquisition and rejects late replanning", async () => {
    const workspace = createMemoryResearchWorkspace();
    const initial = plan({ searchProducts: ["confluence"] });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: initial,
      workspace,
      siteOrigin: ORIGIN,
      now: () => Date.parse("2026-08-06T10:00:00.000Z"),
    });
    await ledger.initialize();
    const revised = plan({
      searchProducts: ["confluence"],
      proposal: {
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
      },
    });
    await ledger.replacePlan(revised);
    expect(ledger.allowedInitialQueries("confluence")).toEqual([
      { text: "absence process" },
      { text: "vacation workflow" },
    ]);
    const persistedPlan = JSON.parse(
      (await workspace.readFile(CHAT_RETRIEVAL_PLAN_PATH_V1))!,
    );
    expect(persistedPlan.searches[0].variants[0]).toMatchObject({
      variantId: "alternate-title",
    });

    const query = { query: { text: "absence process" } };
    ledger.assertToolInput("wiki.search", query);
    await ledger.observe("wiki.search", searchResult({
      items: [],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:replanned", query);
    await expect(ledger.replacePlan(initial)).rejects.toThrow("after acquisition began");
  });

  test("exposes a terminal empty-search signal only after every admitted variant completes", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retrievalPlan = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [
            { variantId: "primary", query: { text: "atlcli" } },
            { variantId: "alternate", query: { text: "command line documentation" } },
          ],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
    });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace,
      siteOrigin: ORIGIN,
    });
    await ledger.initialize();

    const primary = { query: { text: "atlcli" } };
    ledger.assertToolInput("wiki.search", primary);
    await ledger.observe("wiki.search", searchResult({
      items: [],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:primary", primary);
    expect(ledger.isSearchExhaustedWithoutCandidates("confluence")).toBe(false);

    const alternate = { query: { text: "command line documentation" } };
    ledger.assertToolInput("wiki.search", alternate);
    await ledger.observe("wiki.search", searchResult({
      items: [],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:alternate", alternate);
    expect(ledger.isSearchExhaustedWithoutCandidates("confluence")).toBe(true);
    expect(ledger.isSearchExhaustedWithoutCandidates("jira")).toBe(false);
  });

  test("accounts for later-page discovery, ranking, detail, duplicates, and canonical metrics", async () => {
    let now = Date.parse("2026-08-06T10:00:00.000Z");
    const workspace = createMemoryResearchWorkspace();
    const retrievalPlan = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [{ variantId: "primary", query: { text: "synthetic decision" } }],
          maxPages: 2,
        }],
        relationshipTraversals: [],
      },
    });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace,
      siteOrigin: ORIGIN,
      expectedSourceIds: ["wiki:late"],
      now: () => now,
    });
    await ledger.initialize();
    const query = { query: { text: "synthetic decision" } };
    ledger.assertToolInput("wiki.search", query);
    await ledger.observe("wiki.search", searchResult({
      items: [{
        sourceId: "wiki:early",
        entityRef: "entity:early",
        title: "Older duplicate",
        url: `${ORIGIN}/wiki/spaces/KB/pages/1001`,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
      nextCursor: "cursor:page-2",
      complete: false,
    }), "wiki.search:1", query);
    ledger.assertToolInput("wiki.search", { cursor: "cursor:page-2" });
    await ledger.observe("wiki.search", searchResult({
      items: [
        {
          sourceId: "wiki:early",
          entityRef: "entity:early",
          title: "Updated duplicate",
          url: `${ORIGIN}/wiki/spaces/KB/pages/1001`,
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
        {
          sourceId: "wiki:late",
          entityRef: "entity:late",
          title: "Relevant later-page candidate",
          url: `${ORIGIN}/wiki/spaces/KB/pages/1002`,
        },
      ],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:2", { cursor: "cursor:page-2" });
    await ledger.observe("research.candidate.rank", {
      schema: "atlcli.ptc/research.candidate.rank.output/v1",
      items: [{ entityRef: "entity:late", sourceId: "wiki:late", rank: 1 }],
      budget: {
        ptcRemaining: 8,
        httpAttemptsRemaining: 8,
        responseBytesRemaining: 8_000,
      },
    }, "rank:1");
    await ledger.observe("wiki.page.get", {
      schema: "atlcli.ptc/wiki.page.get.output/v1",
      source: {
        sourceId: "wiki:late",
        product: "confluence",
        title: "Relevant later-page candidate",
        url: `${ORIGIN}/wiki/spaces/KB/pages/1002`,
      },
      content: { text: "Synthetic detail.", linkTargets: [], truncated: false, inputBytes: 17 },
      budget: {
        ptcRemaining: 7,
        httpAttemptsRemaining: 7,
        responseBytesRemaining: 7_000,
      },
    }, "wiki.get:1");
    now += 250;
    const assessment = await ledger.finalize();

    expect(ledger.snapshot().candidates).toEqual([
      expect.objectContaining({
        sourceId: "wiki:early",
        state: "excluded",
        exclusionReason: "not-admitted-by-ranking",
        versionsObserved: [
          "2026-08-01T00:00:00.000Z",
          "2026-08-02T00:00:00.000Z",
        ],
      }),
      expect.objectContaining({ sourceId: "wiki:late", state: "detail-read" }),
    ]);
    expect(ledger.snapshot().lastBudgetSnapshot).toEqual({
      ptcRemaining: 7,
      httpAttemptsRemaining: 7,
      responseBytesRemaining: 7_000,
    });
    expect(assessment).toMatchObject({
      sufficient: true,
      metrics: {
        observedRecall: 1,
        wrongSourceRate: 0.5,
        detailReadCoverage: 1,
        canonicalUrlCorrectness: 1,
        atlassianHttpCalls: 3,
        latencyMs: 250,
      },
    });
    expect(await workspace.readFile(CHAT_RETRIEVAL_PLAN_PATH_V1)).toContain(
      CHAT_RETRIEVAL_PLAN_PATH_V1.split("/").at(-1) ? "chat-retrieval-plan" : "",
    );
    expect(await workspace.readFile(CHAT_CANDIDATE_LEDGER_PATH_V1)).toContain(
      "wiki:late",
    );
  });

  test("excludes ranked candidates outside the bounded detail selection instead of deferring them", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retrievalPlan = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [{ variantId: "primary", query: { text: "design" } }],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
    });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace,
      siteOrigin: ORIGIN,
    });
    await ledger.initialize();
    const query = { query: { text: "design" } };
    await ledger.observe("wiki.search", searchResult({
      items: [
        {
          sourceId: "wiki:one",
          entityRef: "entity:one",
          title: "Primary design",
          url: `${ORIGIN}/wiki/spaces/KB/pages/1001`,
        },
        {
          sourceId: "wiki:two",
          entityRef: "entity:two",
          title: "Secondary design",
          url: `${ORIGIN}/wiki/spaces/KB/pages/1002`,
        },
      ],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:selection", query);
    await ledger.observe("research.candidate.rank", {
      schema: "atlcli.ptc/research.candidate.rank.output/v1",
      items: [
        { entityRef: "entity:one", sourceId: "wiki:one", rank: 1 },
        { entityRef: "entity:two", sourceId: "wiki:two", rank: 2 },
      ],
      budget: {
        ptcRemaining: 8,
        httpAttemptsRemaining: 8,
        responseBytesRemaining: 8_000,
      },
    }, "rank:selection");

    await ledger.retainAdmittedCandidates("confluence", ["wiki:one"]);

    expect(ledger.snapshot().candidates).toEqual([
      expect.objectContaining({ sourceId: "wiki:one", state: "admitted" }),
      expect.objectContaining({
        sourceId: "wiki:two",
        state: "excluded",
        exclusionReason: "outside-bounded-detail-selection",
      }),
    ]);
  });

  test("reconciles equivalent scoped and unscoped Confluence URLs for one canonical source", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retrievalPlan = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [{ variantId: "primary", query: { text: "design" } }],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
    });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace,
      siteOrigin: ORIGIN,
    });
    await ledger.initialize();
    const query = { query: { text: "design" } };
    await ledger.observe("wiki.search", searchResult({
      items: [{
        sourceId: "wiki:1001",
        entityRef: "entity:1001",
        title: "Design",
        url: `${ORIGIN}/wiki/pages/1001`,
      }],
      complete: true,
    }), "wiki.search:1", query);
    await ledger.observe("research.candidate.rank", {
      schema: "atlcli.ptc/research.candidate.rank.output/v1",
      items: [{ entityRef: "entity:1001", sourceId: "wiki:1001", rank: 1 }],
      budget: {
        ptcRemaining: 8,
        httpAttemptsRemaining: 8,
        responseBytesRemaining: 8_000,
      },
    }, "rank:1");
    await ledger.observe("wiki.page.get", {
      schema: "atlcli.ptc/wiki.page.get.output/v1",
      source: {
        sourceId: "wiki:1001",
        product: "confluence",
        title: "Design",
        url: `${ORIGIN}/wiki/spaces/KB/pages/1001/Design`,
      },
      content: { text: "Design detail.", linkTargets: [], truncated: false, inputBytes: 14 },
      budget: {
        ptcRemaining: 7,
        httpAttemptsRemaining: 7,
        responseBytesRemaining: 7_000,
      },
    }, "wiki.get:1");

    expect(ledger.snapshot().candidates).toEqual([
      expect.objectContaining({
        sourceId: "wiki:1001",
        state: "detail-read",
        canonicalUrl: `${ORIGIN}/wiki/spaces/KB/pages/1001/Design`,
      }),
    ]);
  });

  test("does not treat few results, index exhaustion, or an unread admitted cap as sufficient", async () => {
    const workspace = createMemoryResearchWorkspace();
    const retrievalPlan = plan({
      searchProducts: ["confluence"],
      proposal: {
        searches: [{
          searchId: "search:wiki",
          product: "confluence",
          variants: [{ variantId: "primary", query: { text: "rare term" } }],
          maxPages: 1,
        }],
        relationshipTraversals: [],
      },
    });
    const ledger = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace,
      siteOrigin: ORIGIN,
    });
    await ledger.initialize();
    await ledger.observe("wiki.search", searchResult({
      items: [],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:empty", { query: { text: "rare term" } });
    expect((await ledger.finalize()).sufficient).toBe(false);
    expect(ledger.assessment().reasons).toContain(
      "completion-signal:detail-evidence-present",
    );

    const capped = new ChatCandidateLedgerControllerV1({
      plan: retrievalPlan,
      workspace: createMemoryResearchWorkspace(),
      siteOrigin: ORIGIN,
    });
    await capped.initialize();
    await capped.observe("wiki.search", searchResult({
      items: [{
        sourceId: "wiki:unread",
        entityRef: "entity:unread",
        title: "Unread",
        url: `${ORIGIN}/wiki/spaces/KB/pages/1003`,
      }],
      complete: true,
      termination: "index-exhausted",
    }), "wiki.search:unread", { query: { text: "rare term" } });
    await capped.observe("research.candidate.rank", {
      schema: "atlcli.ptc/research.candidate.rank.output/v1",
      items: [{ entityRef: "entity:unread", sourceId: "wiki:unread", rank: 1 }],
      budget: {
        ptcRemaining: 0,
        httpAttemptsRemaining: 0,
        responseBytesRemaining: 0,
      },
    }, "rank:unread");
    const cappedAssessment = await capped.finalize("detail-budget-exhausted");
    expect(cappedAssessment.sufficient).toBe(false);
    expect(cappedAssessment.reasons).toContain("deferred-admitted-candidates");
    expect(capped.snapshot().candidates[0]).toMatchObject({
      state: "deferred",
      deferredReason: "detail-budget-exhausted",
    });
  });
});

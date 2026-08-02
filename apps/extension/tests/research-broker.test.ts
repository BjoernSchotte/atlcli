import { describe, expect, it } from "bun:test";
import {
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  RESEARCH_LANGCHAIN_TOOL_NAMES,
  type ResearchSearchOutputV1,
} from "../utils/research/capability-contracts.js";
import {
  ResearchCapabilityBroker,
  WorkspaceResearchClaimLedgerV1,
  WorkspaceResearchEvidenceStoreV1,
  createResearchClaimV1,
  createMemoryResearchWorkspace,
  type ResearchReadProviders,
} from "@atlcli/research";
import {
  buildResearchCql,
  buildResearchJql,
  jiraResearchTextTerms,
} from "@atlcli/research";

function request(
  limits: Record<string, number> = {}
): ReturnType<typeof normalizeResearchRequestV1> {
  return normalizeResearchRequestV1({
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question:
      "Jira-Projektkey DEMO, Confluence-Spacekey KB: Which pages explain the open work?",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
      timeWindow: { from: "2026-01-01", to: "2026-07-30" },
    },
    limits,
    wikiProvider: "rest",
  });
}

function fakeProviders(): ResearchReadProviders & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    jira: {
      async searchPage(input) {
        calls.push({ product: "jira", ...input, signal: undefined });
        if (!input.providerCursor) {
          return {
            items: [
              {
                issueKey: "DEMO-1",
                projectKey: "DEMO",
                title: "Scoped issue",
                updatedAt: "2026-07-01T10:00:00.000Z",
              },
              {
                issueKey: "OTHER-9",
                projectKey: "OTHER",
                title: "OUT-OF-SCOPE-SENTINEL",
              },
            ],
            nextProviderCursor: "jira-provider-next-1",
          };
        }
        return {
          items: [
            {
              issueKey: "DEMO-2",
              projectKey: "DEMO",
              title: "Second scoped issue",
            },
          ],
        };
      },
      async getIssue(input) {
        calls.push({ product: "jira-detail", ...input, signal: undefined });
        return {
          issueKey: input.issueKey,
          projectKey: "DEMO",
          title: "Scoped issue",
          content: {
            text: "The Jira issue links to the implementation page.",
            linkTargets: [
              "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
            ],
            truncated: false,
            inputBytes: 64,
          },
        };
      },
    },
    wiki: {
      async searchPage(input) {
        calls.push({ product: "wiki", ...input, signal: undefined });
        if (!input.providerCursor) {
          return {
            items: [
              {
                contentId: "1001",
                spaceKey: "KB",
                title: "Implementation page",
              },
              {
                contentId: "9009",
                spaceKey: "OTHER",
                title: "OUT-OF-SCOPE-SENTINEL",
              },
            ],
            nextProviderCursor:
              "https://example.atlassian.net/wiki/rest/api/content/search?cursor=secret",
          };
        }
        return {
          items: [
            {
              contentId: "1002",
              spaceKey: "KB",
              title: "Second implementation page",
            },
          ],
        };
      },
      async getPage(input) {
        calls.push({ product: "wiki-detail", ...input, signal: undefined });
        return {
          contentId: input.contentId,
          spaceKey: "KB",
          title: "Implementation page",
          content: {
            text: "This page names DEMO-1 exactly.",
            linkTargets: [],
            truncated: false,
            inputBytes: 42,
          },
        };
      },
    },
  };
}

async function admitRankedCandidates(
  broker: ResearchCapabilityBroker,
  product: "jira" | "confluence",
  items: readonly { entityRef: string }[],
): Promise<void> {
  await broker.invoke("research.candidate.rank", {
    schema: RESEARCH_CAPABILITY_SCHEMAS["research.candidate.rank"].input,
    product,
    entityRefs: items.map((item) => item.entityRef),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("research query builders", () => {
  it("builds only scoped host-owned JQL and CQL with escaped guest text", () => {
    const scope = request().scope;
    const text = '" OR project = "OTHER"\n';

    expect(buildResearchJql(scope, { text })).toBe(
      'project in ("DEMO") AND updated >= "2026-01-01" AND updated <= "2026-07-30" AND (text ~ "OTHER") ORDER BY updated DESC, key ASC'
    );
    expect(buildResearchCql(scope, { text })).toBe(
      'type = page AND space in ("KB") AND lastmodified >= "2026-01-01" AND lastmodified <= "2026-07-30" AND (title ~ "\\"\\" OR project = \\"OTHER\\"\\"" OR text ~ "\\"\\" OR project = \\"OTHER\\"\\"") ORDER BY lastmodified DESC'
    );
  });

  it("expands a cross-product Jira intent into bounded safe discovery terms", () => {
    expect(
      jiraResearchTextTerms(
        "Jira lead qualification and Account-based Data-Aggregation pilot discovery"
      )
    ).toEqual([
      "lead",
      "qualification",
      "Account-based",
      "Data-Aggregation",
      "pilot",
      "discovery",
    ]);
    expect(
      buildResearchJql(request().scope, {
        text: "lead qualification discovery pilot",
      })
    ).toContain(
      '(text ~ "lead" OR text ~ "qualification" OR text ~ "discovery" OR text ~ "pilot")'
    );
    expect(
      buildResearchCql(request().scope, {
        text: "Lead Pipeline: Modernisierung",
      }),
    ).toContain(
      '(title ~ "\\"Lead Pipeline: Modernisierung\\"" OR text ~ "\\"Lead Pipeline: Modernisierung\\"")',
    );
  });

  it("keeps stable permission ids separate from valid QuickJS tool names", () => {
    expect(RESEARCH_LANGCHAIN_TOOL_NAMES).toEqual({
      "jira.issue.search": "jira_issue_search",
      "jira.issue.get": "jira_issue_get",
      "wiki.search": "wiki_search",
      "wiki.page.get": "wiki_page_get",
      "research.candidate.rank": "research_candidate_rank",
    });
    expect(Object.values(RESEARCH_LANGCHAIN_TOOL_NAMES).every((name) => !name.includes(".")))
      .toBe(true);
  });
});

describe("bounded research capability broker", () => {
  it("reports product-specific search and detail capacity for repair admission", async () => {
    const broker = new ResearchCapabilityBroker(
      request({ maxSearchPagesPerProduct: 1, maxDetailItemsPerProduct: 1 }),
      fakeProviders(),
      { createEntityId: () => "repair-budget-entity" },
    );
    expect(broker.budget.canSearchAnotherPage("jira")).toBe(true);
    expect(broker.budget.canReadAnotherDetail("jira")).toBe(true);

    const page = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    await admitRankedCandidates(broker, "jira", page.items);
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[0]!.entityRef,
    });

    expect(broker.budget.canSearchAnotherPage("jira")).toBe(false);
    expect(broker.budget.canReadAnotherDetail("jira")).toBe(false);
    expect(broker.budget.canSearchAnotherPage("confluence")).toBe(true);
    expect(broker.budget.canReadAnotherDetail("confluence")).toBe(true);
  });

  it("assesses only host-observed ranked retrieval state before another wave", async () => {
    const broker = new ResearchCapabilityBroker(
      request({ maxSearchPagesPerProduct: 1, maxDetailItemsPerProduct: 1 }),
      fakeProviders(),
      { createEntityId: () => "assessment-entity" },
    );
    const page = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    await admitRankedCandidates(broker, "jira", page.items);
    expect(broker.retrievalAssessment(["jira"])).toMatchObject({
      action: "continue",
      reason: "unread_ranked_candidates",
      products: [{ product: "jira", unreadRankedCandidateCount: 1 }],
    });

    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[0]!.entityRef,
    });
    expect(broker.retrievalAssessment(["jira"])).toMatchObject({
      action: "stop",
      reason: "search_budget_exhausted",
      newDetailSourceCount: 1,
    });
    const gapBroker = new ResearchCapabilityBroker(
      request({ maxSearchPagesPerProduct: 1, maxDetailItemsPerProduct: 1 }),
      fakeProviders(),
    );
    expect(gapBroker.retrievalAssessment(["jira"], [], {
      unresolvedCoverageTargetIds: ["coverage-target:approved"],
    })).toMatchObject({
      action: "replan",
      reason: "coverage_gap",
      unresolvedCoverageTargetCount: 1,
    });
  });

  it("persists approved, tenant-bound evidence before publishing a detail body to the broker ledger", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
    const broker = new ResearchCapabilityBroker(request(), fakeProviders(), {
      createEntityId: () => "evidence-entity",
      evidence: {
        store: evidence,
        scopeBindings: [
          {
            schema: "atlcli.research-scope-binding/v1",
            id: "scope-binding:test:jira:DEMO",
            tenantOrigin: "https://example.atlassian.net",
            product: "jira",
            entityKind: "project",
            entityRef: "scope-key:jira:DEMO",
            key: "DEMO",
            name: "DEMO",
            source: "cli_flag",
            authority: "locked",
          },
          {
            schema: "atlcli.research-scope-binding/v1",
            id: "scope-binding:test:confluence:KB",
            tenantOrigin: "https://example.atlassian.net",
            product: "confluence",
            entityKind: "space",
            entityRef: "scope-key:confluence:KB",
            key: "KB",
            name: "KB",
            source: "cli_flag",
            authority: "locked",
          },
        ],
        capturedAt: () => "2026-08-01T12:00:00.000Z",
      },
    });
    const page = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    await admitRankedCandidates(broker, "jira", page.items);
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[0]!.entityRef,
    });

    const retained = await evidence.list();
    expect(retained.records).toMatchObject([{
      source: { id: "jira:DEMO-1" },
      identity: { canonicalId: "https://example.atlassian.net|jira|issue|DEMO-1" },
      authority: { bindingId: "scope-binding:test:jira:DEMO" },
      retrieval: {
        sourceId: "jira:DEMO-1",
        reason: "question_relevance_rank",
        rank: 1,
      },
    }]);
    expect(await evidence.chunks(retained.records[0]!.id)).toMatchObject([
      { text: "The Jira issue links to the implementation page." },
    ]);
    expect(broker.detailEvidenceLedger()).toMatchObject([
      {
        source: { id: "jira:DEMO-1" },
        retrieval: {
          sourceId: "jira:DEMO-1",
          reason: "question_relevance_rank",
          rank: 1,
        },
        evidenceId: retained.records[0]!.id,
      },
    ]);
  });

  it("admits an approved exact issue and page through search-rank-get without widening to their parent scopes", async () => {
    const exactRequest = normalizeResearchRequestV1({
      schema: RESEARCH_REQUEST_SCHEMA_V1,
      question: "Compare the approved exact Jira issue and Confluence page.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
      },
      scopeSeeds: [
        {
          binding: {
            schema: "atlcli.research-scope-binding/v1",
            id: "scope-binding:exact:jira:ATLCLI-42",
            tenantOrigin: "https://example.atlassian.net",
            product: "jira",
            entityKind: "issue",
            entityRef: "research-scope-entity:jira-issue-atlcli-42",
            key: "ATLCLI-42",
            name: "Exact Jira issue",
            source: "exact_link",
            authority: "approved",
          },
          precedence: 400,
        },
        {
          binding: {
            schema: "atlcli.research-scope-binding/v1",
            id: "scope-binding:exact:confluence:1001",
            tenantOrigin: "https://example.atlassian.net",
            product: "confluence",
            entityKind: "page",
            entityRef: "research-scope-entity:confluence-page-1001",
            key: "1001",
            name: "Exact Confluence page",
            source: "exact_link",
            authority: "approved",
          },
          precedence: 400,
        },
      ],
      limits: { maxDetailItemsPerProduct: 1 },
      wikiProvider: "rest",
    });
    const providers = fakeProviders();
    let jiraSearches = 0;
    let wikiSearches = 0;
    providers.jira.searchPage = async () => {
      jiraSearches += 1;
      throw new Error("exact scope must not issue a Jira project search");
    };
    providers.wiki.searchPage = async () => {
      wikiSearches += 1;
      throw new Error("exact scope must not issue a Confluence space search");
    };
    providers.jira.getIssue = async ({ issueKey }) => ({
      issueKey,
      projectKey: "UNSCOPED",
      title: "Exact Jira issue",
      content: { text: "Exact issue evidence.", linkTargets: [], truncated: false, inputBytes: 21 },
    });
    providers.wiki.getPage = async ({ contentId }) => ({
      contentId,
      spaceKey: "UNSCOPED",
      title: "Exact Confluence page",
      content: { text: "Exact page evidence.", linkTargets: [], truncated: false, inputBytes: 20 },
    });
    const evidence = new WorkspaceResearchEvidenceStoreV1(createMemoryResearchWorkspace());
    let entityId = 0;
    const broker = new ResearchCapabilityBroker(exactRequest, providers, {
      createEntityId: () => `exact-entity-${++entityId}`,
      evidence: {
        store: evidence,
        scopeBindings: exactRequest.scopeSeeds!.map((seed) => seed.binding),
        capturedAt: () => "2026-08-02T20:00:00.000Z",
      },
    });

    const jira = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    const wiki = await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    expect(jira.items[0]).toMatchObject({ issueKey: "ATLCLI-42" });
    expect(wiki.items[0]).toMatchObject({ contentId: "1001" });
    expect(jira.items[0]).not.toHaveProperty("projectKey");
    expect(wiki.items[0]).not.toHaveProperty("spaceKey");
    expect(jira.page).toEqual({ complete: true, termination: "index-exhausted" });
    expect(wiki.page).toEqual({ complete: true, termination: "index-exhausted" });
    expect(jiraSearches).toBe(0);
    expect(wikiSearches).toBe(0);

    await admitRankedCandidates(broker, "jira", jira.items);
    await admitRankedCandidates(broker, "confluence", wiki.items);
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: jira.items[0]!.entityRef,
    });
    await broker.invoke("wiki.page.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].input,
      entityRef: wiki.items[0]!.entityRef,
    });

    expect(await evidence.list()).toMatchObject({
      records: [
        { authority: { bindingId: "scope-binding:exact:jira:ATLCLI-42", authorityClass: "exact_entity" } },
        { authority: { bindingId: "scope-binding:exact:confluence:1001", authorityClass: "exact_entity" } },
      ],
    });
  });

  it("invalidates claims that depend on a superseded provider detail version", async () => {
    const workspace = createMemoryResearchWorkspace();
    const evidence = new WorkspaceResearchEvidenceStoreV1(workspace);
    const claims = new WorkspaceResearchClaimLedgerV1(workspace, evidence);
    const providers = fakeProviders();
    let detailReads = 0;
    providers.jira.getIssue = async ({ issueKey }) => {
      detailReads += 1;
      return {
        issueKey,
        projectKey: "DEMO",
        title: "Scoped issue",
        updatedAt: `2026-08-0${detailReads}T12:00:00.000Z`,
        content: {
          text: detailReads === 1
            ? "The first detail version has a direct implementation reference."
            : "The revised detail version changes the implementation reference.",
          linkTargets: [],
          truncated: false,
          inputBytes: 70,
        },
      };
    };
    const broker = new ResearchCapabilityBroker(request({ maxDetailItemsPerProduct: 2 }), providers, {
      createEntityId: () => "claim-invalidation-entity",
      evidence: {
        store: evidence,
        claimLedger: claims,
        scopeBindings: [{
          schema: "atlcli.research-scope-binding/v1",
          id: "scope-binding:test:jira:DEMO",
          tenantOrigin: "https://example.atlassian.net",
          product: "jira",
          entityKind: "project",
          entityRef: "scope-key:jira:DEMO",
          key: "DEMO",
          name: "DEMO",
          source: "cli_flag",
          authority: "locked",
        }],
        capturedAt: () => `2026-08-0${detailReads + 1}T12:01:00.000Z`,
      },
    });
    const page = await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    }) as ResearchSearchOutputV1;
    const entityRef = page.items[0]!.entityRef;
    await admitRankedCandidates(broker, "jira", page.items);
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef,
    });
    const firstEvidence = (await evidence.list()).records[0]!;
    const firstChunk = (await evidence.chunks(firstEvidence.id))[0]!;
    const quote = firstChunk.text.slice(0, 12);
    const claim = await createResearchClaimV1({
      evidenceStore: evidence,
      classification: "fact",
      statement: "The issue has an implementation reference.",
      evidenceSpans: [{
        evidenceId: firstEvidence.id,
        chunkId: firstChunk.id,
        start: firstChunk.start,
        end: firstChunk.start + quote.length,
        textHash: await sha256(quote),
      }],
      createdAt: "2026-08-01T12:02:00.000Z",
    });
    await claims.put(claim);

    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef,
    });
    await expect(claims.get(claim.id)).resolves.toMatchObject({
      freshness: "invalidated",
      invalidationReason: "evidence_changed",
    });
  });

  it("paginates both products without exposing provider cursors or out-of-scope hits", async () => {
    const providers = fakeProviders();
    let cursorId = 0;
    let entityId = 0;
    const broker = new ResearchCapabilityBroker(request(), providers, {
      createCursorId: () => `cursor-${++cursorId}`,
      createEntityId: () => `entity-${++entityId}`,
    });

    const jiraFirst = (await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: { text: "implementation" },
      pageSize: 2,
    })) as ResearchSearchOutputV1;
    const wikiFirst = (await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      query: { text: "implementation" },
      pageSize: 2,
    })) as ResearchSearchOutputV1;

    expect(jiraFirst.items.map((item) => item.issueKey)).toEqual(["DEMO-1"]);
    expect(wikiFirst.items.map((item) => item.contentId)).toEqual(["1001"]);
    expect(JSON.stringify([jiraFirst, wikiFirst])).not.toContain(
      "OUT-OF-SCOPE-SENTINEL"
    );
    expect(jiraFirst.page.nextCursor).toMatch(/^research-cursor:/);
    expect(wikiFirst.page.nextCursor).toMatch(/^research-cursor:/);
    expect(JSON.stringify([jiraFirst, wikiFirst])).not.toContain("provider-next");
    expect(JSON.stringify([jiraFirst, wikiFirst])).not.toContain("cursor=secret");

    const jiraSecond = (await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      cursor: jiraFirst.page.nextCursor,
    })) as ResearchSearchOutputV1;
    const wikiSecond = (await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      cursor: wikiFirst.page.nextCursor,
    })) as ResearchSearchOutputV1;

    expect(jiraSecond.items.map((item) => item.issueKey)).toEqual(["DEMO-2"]);
    expect(wikiSecond.items.map((item) => item.contentId)).toEqual(["1002"]);
    expect(jiraSecond.page).toEqual({
      complete: true,
      termination: "index-exhausted",
    });
    expect(wikiSecond.page).toEqual({
      complete: true,
      termination: "index-exhausted",
    });
    expect(broker.completionStatus()).toEqual({
      complete: true,
      warnings: [],
    });
    expect(providers.calls[0]?.jql).toContain('project in ("DEMO")');
    expect(providers.calls[1]?.cql).toContain('space in ("KB")');
  });

  it("allows details only through search-issued refs and rechecks provider scope", async () => {
    const providers = fakeProviders();
    let cursorId = 0;
    let entityId = 0;
    const broker = new ResearchCapabilityBroker(request(), providers, {
      createCursorId: () => `cursor-${++cursorId}`,
      createEntityId: () => `entity-${++entityId}`,
    });
    const jira = (await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    })) as ResearchSearchOutputV1;
    const wiki = (await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      query: {},
    })) as ResearchSearchOutputV1;

    await expect(
      broker.invoke("jira.issue.get", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
        entityRef: jira.items[0]!.entityRef,
      }),
    ).rejects.toThrow("candidate reference admitted by research.candidate.rank");
    await admitRankedCandidates(broker, "jira", jira.items);
    await admitRankedCandidates(broker, "confluence", wiki.items);

    const jiraDetail = await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: jira.items[0]!.entityRef,
    });
    const wikiDetail = await broker.invoke("wiki.page.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].input,
      entityRef: wiki.items[0]!.entityRef,
    });
    expect(JSON.stringify(jiraDetail)).toContain("implementation page");
    expect(JSON.stringify(wikiDetail)).toContain("DEMO-1");

    await expect(
      broker.invoke("jira.issue.get", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
        entityRef: "DEMO-999",
      })
    ).rejects.toThrow("Entity reference is invalid");
    await expect(
      broker.invoke("wiki.page.get", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].input,
        entityRef: jira.items[0]!.entityRef,
      })
    ).rejects.toThrow("another capability");

    const escapingProviders = fakeProviders();
    escapingProviders.jira.getIssue = async (input) => ({
      issueKey: input.issueKey,
      projectKey: "OTHER",
      title: "OUT-OF-SCOPE-SENTINEL",
      content: {
        text: "OUT-OF-SCOPE-SENTINEL",
        linkTargets: [],
        truncated: false,
        inputBytes: 1,
      },
    });
    const guarded = new ResearchCapabilityBroker(request(), escapingProviders, {
      createCursorId: () => "cursor",
      createEntityId: () => "entity",
    });
    const found = (await guarded.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    })) as ResearchSearchOutputV1;
    await admitRankedCandidates(guarded, "jira", found.items);
    await expect(
      guarded.invoke("jira.issue.get", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
        entityRef: found.items[0]!.entityRef,
      })
    ).rejects.toThrow("outside the run scope");
  });

  it("ranks complete opaque candidate sets on the host before detail access", async () => {
    const providers = fakeProviders();
    providers.jira.searchPage = async () => ({
      items: [
        {
          issueKey: "DEMO-1",
          projectKey: "DEMO",
          title: "Background discovery",
          excerpt: "internal-only-excerpt-a",
        },
        {
          issueKey: "DEMO-2",
          projectKey: "DEMO",
          title: "Open work delivery plan",
          excerpt: "internal-only-excerpt-b",
        },
      ],
    });
    let entityId = 0;
    const broker = new ResearchCapabilityBroker(request(), providers, {
      createEntityId: () => `rank-${++entityId}`,
    });
    const page = (await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: {},
    })) as ResearchSearchOutputV1;

    const ranked = await broker.invoke("research.candidate.rank", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["research.candidate.rank"].input,
      product: "jira",
      entityRefs: [...page.items].reverse().map((item) => item.entityRef),
    });

    expect(ranked).toMatchObject({
      schema: "atlcli.ptc/research.candidate.rank.output/v1",
      items: [
        { entityRef: page.items[1]!.entityRef, sourceId: "jira:DEMO-2", rank: 1 },
        { entityRef: page.items[0]!.entityRef, sourceId: "jira:DEMO-1", rank: 2 },
      ],
    });
    expect(JSON.stringify(ranked)).not.toContain("internal-only-excerpt");

    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[1]!.entityRef,
    });
    expect(providers.calls.filter((call) => call.product === "jira-detail")).toHaveLength(1);
    expect(broker.detailEvidenceLedger()).toMatchObject([{
      source: { id: "jira:DEMO-2" },
      retrieval: {
        sourceId: "jira:DEMO-2",
        reason: "question_relevance_rank",
        rank: 1,
      },
    }]);
  });

  it("rejects raw query languages and terminates an incomplete pagination budget visibly", async () => {
    const providers = fakeProviders();
    let entityId = 0;
    const broker = new ResearchCapabilityBroker(
      request({ maxSearchPagesPerProduct: 1 }),
      providers,
      {
        createCursorId: () => "cursor",
        createEntityId: () => `entity-${++entityId}`,
      }
    );

    await expect(
      broker.invoke("jira.issue.search", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
        query: {},
        jql: 'project = "OTHER"',
      })
    ).rejects.toThrow("unknown fields");

    const result = (await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      query: {},
    })) as ResearchSearchOutputV1;
    expect(result.page).toEqual({ complete: false, termination: "page-limit" });
    expect(broker.completionStatus()).toEqual({
      complete: false,
      warnings: [
        "Jira search did not reach a terminal page.",
        "Confluence search incomplete: page-limit.",
      ],
    });
    expect(broker.completionStatus(["confluence"])).toEqual({
      complete: false,
      warnings: ["Confluence search incomplete: page-limit."],
    });
  });

  it("counts invalid PTC calls and enforces HTTP attempts synchronously", async () => {
    const providers = fakeProviders();
    const broker = new ResearchCapabilityBroker(
      request({ maxPtcCalls: 4, maxHttpCalls: 4 }),
      providers,
      {
        createCursorId: () => "cursor",
        createEntityId: () => "entity",
      }
    );
    for (let count = 0; count < 4; count += 1) {
      await expect(
        broker.invoke("jira.issue.search", { schema: "wrong", query: {} })
      ).rejects.toBeInstanceOf(ResearchContractError);
    }
    await expect(
      broker.invoke("jira.issue.search", { schema: "wrong", query: {} })
    ).rejects.toThrow("PTC call budget");

    for (let count = 0; count < 4; count += 1) {
      broker.budget.guardTransport({ type: "attempt" });
    }
    expect(() => broker.budget.guardTransport({ type: "attempt" })).toThrow(
      "HTTP attempt budget"
    );
  });
});

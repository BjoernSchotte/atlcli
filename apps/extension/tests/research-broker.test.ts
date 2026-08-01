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
    await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: page.items[0]!.entityRef,
    });

    expect(broker.budget.canSearchAnotherPage("jira")).toBe(false);
    expect(broker.budget.canReadAnotherDetail("jira")).toBe(false);
    expect(broker.budget.canSearchAnotherPage("confluence")).toBe(true);
    expect(broker.budget.canReadAnotherDetail("confluence")).toBe(true);
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
    await expect(
      guarded.invoke("jira.issue.get", {
        schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
        entityRef: found.items[0]!.entityRef,
      })
    ).rejects.toThrow("outside the run scope");
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

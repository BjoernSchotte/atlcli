import { afterEach, describe, expect, test } from "bun:test";
import { ReplSession } from "@langchain/quickjs";
import { ResearchScopeCatalogBroker } from "@atlcli/research/scope-catalog-broker";
import { createResearchScopeCatalogPtcTools, RESEARCH_SCOPE_CATALOG_TOOL_NAMES } from "@atlcli/research/browser/agent";
import type { ResearchPtcDiagnosticV1 } from "@atlcli/research/browser/agent";

const tenantOrigin = "https://tenant-a.atlassian.net";

afterEach(() => {
  ReplSession.clearCache();
  ReplSession.resetSharedModule();
});

function candidate(key: string, product: "jira" | "confluence", entityKind: "project" | "space") {
  return {
    schema: "atlcli.research-scope-candidate/v1" as const,
    id: `research-scope-candidate:${product}-${entityKind}-${key.toLowerCase()}`,
    tenantOrigin,
    product,
    entityKind,
    entityRef: `research-scope-entity:${product}-${entityKind}-${key.toLowerCase()}`,
    key,
    name: key === "ATLCLI" ? "atlcli" : "Documentation",
    status: "current" as const,
    accessible: true as const,
    providerFreshnessAt: "2026-07-31T12:00:00.000Z",
  };
}

describe("scope catalog PTC tools", () => {
  test("keeps schema and tenant binding host-owned while exposing an opaque cursor", async () => {
    const diagnostics: ResearchPtcDiagnosticV1[] = [];
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin,
      providers: {
        jira: {
          async listProjects() {
            return {
              candidates: [candidate("ATLCLI", "jira", "project")],
              nextProviderCursor: "provider-secret",
            };
          },
        },
        confluence: { async listSpaces() { return { candidates: [] }; } },
        async resolveReference() { return undefined; },
      },
    });
    const tools = createResearchScopeCatalogPtcTools(broker, {
      tenantOrigin,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const jira = tools.find((item) => item.name === RESEARCH_SCOPE_CATALOG_TOOL_NAMES["jira.project.search"]);
    expect(jira).toBeDefined();

    const result = JSON.parse(String(await jira!.invoke({ query: "ATLCLI" })));
    expect(result.candidates[0].key).toBe("ATLCLI");
    expect(result.nextCursorRef).toMatch(/^research-scope-cursor:/);
    expect(result.candidates[0].tenantOrigin).toBe(tenantOrigin);
    expect(diagnostics.map((entry) => ({
      tool: entry.tool,
      inputKind: entry.inputKind,
      outcome: entry.outcome,
      inputKeys: entry.inputKeys,
      itemCount: entry.itemCount,
      complete: entry.complete,
    }))).toEqual([
      {
        tool: "jira.project.search",
        inputKind: "search",
        outcome: "started",
        inputKeys: ["query"],
        itemCount: undefined,
        complete: undefined,
      },
      {
        tool: "jira.project.search",
        inputKind: "search",
        outcome: "success",
        inputKeys: ["query"],
        itemCount: 1,
        complete: false,
      },
    ]);
    expect(diagnostics[1]?.resultBytes).toBeGreaterThan(0);
  });

  test("injects the active tenant when resolving a reference", async () => {
    let observedTenant = "";
    const diagnostics: ResearchPtcDiagnosticV1[] = [];
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin,
      providers: {
        jira: { async listProjects() { return { candidates: [] }; } },
        confluence: { async listSpaces() { return { candidates: [] }; } },
        async resolveReference(input) {
          observedTenant = input.expectedTenantOrigin;
          return candidate("DOCSY", "confluence", "space");
        },
      },
    });
    const tools = createResearchScopeCatalogPtcTools(broker, {
      tenantOrigin,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const resolve = tools.find((item) => item.name === RESEARCH_SCOPE_CATALOG_TOOL_NAMES["atlassian.reference.resolve"]);
    expect(resolve).toBeDefined();

    const result = JSON.parse(
      String(
        await resolve!.invoke({
          reference: `${tenantOrigin}/wiki/spaces/DOCSY`,
          expectedKinds: ["space"],
        }),
      ),
    );
    expect(observedTenant).toBe(tenantOrigin);
    expect(result.unavailable).toBe(false);
    expect(diagnostics.at(-1)).toMatchObject({
      tool: "atlassian.reference.resolve",
      inputKind: "reference",
      outcome: "success",
      inputKeys: ["expectedKinds", "reference"],
    });
    expect(diagnostics.at(-1)).not.toHaveProperty("itemCount");
    expect(diagnostics.at(-1)).not.toHaveProperty("complete");
  });

  test("bridges bounded catalog pagination and exact reference resolution through QuickJS", async () => {
    const providerInputs: Array<{ query?: string; providerCursor?: string; maxCandidates: number }> = [];
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin,
      providers: {
        jira: {
          async listProjects(input) {
            providerInputs.push(input);
            return input.providerCursor
              ? { candidates: [candidate("SECOND", "jira", "project")] }
              : {
                  candidates: [candidate("ATLCLI", "jira", "project")],
                  nextProviderCursor: "provider-secret-cursor",
                };
          },
        },
        confluence: { async listSpaces() { return { candidates: [] }; } },
        async resolveReference() {
          return candidate("DOCSY", "confluence", "space");
        },
      },
      limits: { maxCandidates: 5, maxPages: 3 },
    });
    const session = new ReplSession("scope-catalog-quickjs", {
      tools: createResearchScopeCatalogPtcTools(broker, { tenantOrigin }),
      maxPtcCalls: 3,
      captureConsole: false,
    });
    try {
      const result = await session.eval(`
        const first = JSON.parse(await tools.jiraProjectSearch({}));
        const second = JSON.parse(await tools.jiraProjectSearch({ cursor: first.nextCursorRef }));
        const resolved = JSON.parse(await tools.atlassianReferenceResolve({
          reference: "https://tenant-a.atlassian.net/wiki/spaces/DOCSY",
          expectedKinds: ["space"]
        }));
        ({
          toolNames: Object.keys(tools).sort(),
          firstKey: first.candidates[0].key,
          secondKey: second.candidates[0].key,
          resolvedKey: resolved.candidate.key,
          providerCursorVisible: JSON.stringify([first, second]).includes("provider-secret-cursor"),
          fetchType: typeof fetch
        });
      `, 5_000);
      expect(result).toMatchObject({
        ok: true,
        value: {
          toolNames: [
            "atlassianReferenceResolve",
            "jiraProjectSearch",
            "wikiSpaceSearch",
          ],
          firstKey: "ATLCLI",
          secondKey: "SECOND",
          resolvedKey: "DOCSY",
          providerCursorVisible: false,
          fetchType: "undefined",
        },
      });
      expect(providerInputs.map(({ query, providerCursor, maxCandidates }) => ({
        query,
        providerCursor,
        maxCandidates,
      }))).toEqual([
        { query: undefined, providerCursor: undefined, maxCandidates: 5 },
        { query: undefined, providerCursor: "provider-secret-cursor", maxCandidates: 4 },
      ]);
    } finally {
      session.dispose();
      broker.cancel();
    }
  });
});

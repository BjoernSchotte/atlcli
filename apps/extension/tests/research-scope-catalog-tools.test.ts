import { describe, expect, test } from "bun:test";
import { ResearchScopeCatalogBroker } from "@atlcli/research/scope-catalog-broker";
import { createResearchScopeCatalogPtcTools, RESEARCH_SCOPE_CATALOG_TOOL_NAMES } from "@atlcli/research/browser/agent";

const tenantOrigin = "https://tenant-a.atlassian.net";

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
    const tools = createResearchScopeCatalogPtcTools(broker, { tenantOrigin });
    const jira = tools.find((item) => item.name === RESEARCH_SCOPE_CATALOG_TOOL_NAMES["jira.project.search"]);
    expect(jira).toBeDefined();

    const result = JSON.parse(String(await jira!.invoke({ query: "ATLCLI" })));
    expect(result.candidates[0].key).toBe("ATLCLI");
    expect(result.nextCursorRef).toMatch(/^research-scope-cursor:/);
    expect(result.candidates[0].tenantOrigin).toBe(tenantOrigin);
  });

  test("injects the active tenant when resolving a reference", async () => {
    let observedTenant = "";
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
    const tools = createResearchScopeCatalogPtcTools(broker, { tenantOrigin });
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
  });
});

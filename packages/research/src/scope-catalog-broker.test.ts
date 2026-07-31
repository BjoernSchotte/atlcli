import { describe, expect, test } from "bun:test";
import {
  ResearchScopeCatalogBroker,
  type ResearchScopeCatalogProvidersV1,
} from "./scope-catalog-broker.js";
import { RESEARCH_SCOPE_CATALOG_SCHEMAS } from "./scope-catalog.js";

const baseCandidate = {
  tenantOrigin: "https://mayflower.atlassian.net",
  product: "jira" as const,
  entityKind: "project" as const,
  entityRef: "research-scope-entity:atlcli",
  key: "ATLCLI",
  name: "atlcli",
  accessible: true as const,
  providerFreshnessAt: "2026-07-31T10:00:00.000Z",
};

function providers(): ResearchScopeCatalogProvidersV1 & { seenCursors: string[] } {
  const seenCursors: string[] = [];
  return {
    seenCursors,
    jira: {
      async listProjects(input) {
        seenCursors.push(input.providerCursor ?? "");
        return input.providerCursor
          ? { candidates: [{ ...baseCandidate, id: "research-scope-candidate:second", key: "GROW", name: "Growth" }] }
          : { candidates: [{ ...baseCandidate, id: "research-scope-candidate:first" }], nextProviderCursor: "provider-secret-cursor" };
      },
    },
    confluence: {
      async listSpaces() {
        return { candidates: [] };
      },
    },
    async resolveReference() {
      return undefined;
    },
  };
}

describe("scope catalog broker", () => {
  test("keeps provider pagination cursors opaque", async () => {
    const host = providers();
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin: "https://mayflower.atlassian.net",
      providers: host,
    });
    const first = await broker.invoke("jira.project.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["jira.project.search"].input,
      product: "jira",
      entityKind: "project",
      includeArchived: false,
      maxCandidates: 25,
    });
    expect(first).toMatchObject({ candidates: [{ key: "ATLCLI" }] });
    expect(typeof (first as { nextCursorRef?: unknown }).nextCursorRef).toBe("string");
    expect((first as { nextCursorRef: string }).nextCursorRef).toMatch(/^research-scope-cursor:/);
    expect(JSON.stringify(first)).not.toContain("provider-secret-cursor");

    const nextCursorRef = (first as { nextCursorRef: string }).nextCursorRef;
    const second = await broker.invoke("jira.project.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["jira.project.search"].input,
      product: "jira",
      entityKind: "project",
      includeArchived: false,
      cursorRef: nextCursorRef,
      maxCandidates: 25,
    });
    expect(second).toMatchObject({ candidates: [{ key: "GROW" }] });
    expect(host.seenCursors).toEqual(["", "provider-secret-cursor"]);
  });

  test("fails closed when a provider returns a foreign candidate", async () => {
    const host = providers();
    host.jira.listProjects = async () => ({
      candidates: [{ ...baseCandidate, tenantOrigin: "https://other.atlassian.net" }],
    });
    const broker = new ResearchScopeCatalogBroker({ tenantOrigin: "https://mayflower.atlassian.net", providers: host });
    await expect(broker.invoke("jira.project.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["jira.project.search"].input,
      product: "jira",
      entityKind: "project",
      includeArchived: false,
      maxCandidates: 25,
    })).rejects.toThrow("outside the active tenant");
  });
});

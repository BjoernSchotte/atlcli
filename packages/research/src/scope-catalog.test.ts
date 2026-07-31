import { describe, expect, test } from "bun:test";
import {
  RESEARCH_SCOPE_CATALOG_SCHEMAS,
  decodeResearchReferenceResolveIntentV1,
  decodeResearchScopeCatalogIntentV1,
} from "./scope-catalog.js";

describe("scope catalog capability contracts", () => {
  test("accepts a bounded Jira project search without exposing a transport query", () => {
    const result = decodeResearchScopeCatalogIntentV1("jira.project.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["jira.project.search"].input,
      product: "jira",
      entityKind: "project",
      normalizedQuery: "growth team",
      includeArchived: false,
      maxCandidates: 100,
    }, 50);

    expect(result).toEqual({
      schema: "atlcli.ptc/jira.project.search.input/v1",
      product: "jira",
      entityKind: "project",
      normalizedQuery: "growth team",
      includeArchived: false,
      maxCandidates: 50,
    });
    expect(result).not.toHaveProperty("jql");
  });

  test("requires host-owned opaque cursors for continuation", () => {
    expect(() => decodeResearchScopeCatalogIntentV1("wiki.space.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["wiki.space.search"].input,
      product: "confluence",
      entityKind: "space",
      includeArchived: false,
      cursorRef: "https://mayflower.atlassian.net/wiki/spaces",
      maxCandidates: 25,
    }, 50)).toThrow("cursor");
  });

  test("rejects cross-product capability parameters and unknown fields", () => {
    expect(() => decodeResearchScopeCatalogIntentV1("jira.project.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["jira.project.search"].input,
      product: "confluence",
      entityKind: "space",
      includeArchived: false,
      maxCandidates: 25,
    }, 50)).toThrow("product/entity kind");
    expect(() => decodeResearchScopeCatalogIntentV1("wiki.space.search", {
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["wiki.space.search"].input,
      product: "confluence",
      entityKind: "space",
      includeArchived: false,
      maxCandidates: 25,
      rawCql: "space.title = DOCSY",
    }, 50)).toThrow("unknown fields");
  });

  test("validates exact current-tenant reference resolution intents", () => {
    const result = decodeResearchReferenceResolveIntentV1({
      schema: RESEARCH_SCOPE_CATALOG_SCHEMAS["atlassian.reference.resolve"].input,
      reference: "https://mayflower.atlassian.net/wiki/spaces/DOCSY/pages/123",
      expectedTenantOrigin: "https://mayflower.atlassian.net",
      expectedKinds: ["page", "space"],
    });
    expect(result.expectedKinds).toEqual(["page", "space"]);
    expect(() => decodeResearchReferenceResolveIntentV1({
      schema: result.schema,
      reference: "https://other.atlassian.net/wiki/spaces/DOCSY/pages/123",
      expectedTenantOrigin: "https://mayflower.atlassian.net",
      expectedKinds: ["page"],
    })).not.toThrow();
  });
});


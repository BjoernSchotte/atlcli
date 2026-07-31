import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { createRestScopeCatalogProviders } from "../utils/research/scope-catalog-provider.js";

const originalFetch = globalThis.fetch;
const profile: Profile = {
  name: "mayflower",
  baseUrl: "https://mayflower.atlassian.net",
  auth: { type: "session" },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("REST scope catalog providers", () => {
  test("maps Jira projects and keeps provider pagination private to the adapter", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock((url: string) => {
      requests.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              { id: "1", key: "ATLCLI", name: "atlcli", archived: false },
              { id: "2", key: "OLD", name: "Old", archived: true },
            ],
            total: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const providers = createRestScopeCatalogProviders(profile, "https://mayflower.atlassian.net", {
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const page = await providers.jira.listProjects({
      includeArchived: false,
      maxCandidates: 2,
      signal: new AbortController().signal,
    });

    expect(requests[0]).toContain("/rest/api/3/project/search");
    expect(page.candidates).toEqual([
      {
        id: "research-scope-candidate:jira-project-atlcli",
        tenantOrigin: "https://mayflower.atlassian.net",
        product: "jira",
        entityKind: "project",
        entityRef: "research-scope-entity:jira-project-atlcli",
        key: "ATLCLI",
        name: "atlcli",
        status: "current",
        accessible: true,
        providerFreshnessAt: "2026-07-31T12:00:00.000Z",
      },
    ]);
    expect(page.nextProviderCursor).toBe("jira-projects:2");
  });

  test("walks current and archived Confluence phases without exposing the REST cursor", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock((url: string) => {
      requests.push(url);
      const archived = url.includes("status=archived");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: archived
              ? [{ id: "2", key: "OLD", name: "Old space", status: "archived" }]
              : [{ id: "1", key: "DOCSY", name: "Docs", status: "current" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const providers = createRestScopeCatalogProviders(profile, "https://mayflower.atlassian.net", {
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const first = await providers.confluence.listSpaces({
      includeArchived: true,
      maxCandidates: 2,
      signal: new AbortController().signal,
    });
    const second = await providers.confluence.listSpaces({
      includeArchived: true,
      maxCandidates: 2,
      providerCursor: first.nextProviderCursor,
      signal: new AbortController().signal,
    });

    expect(requests[0]).toContain("/wiki/api/v2/spaces");
    expect(requests[0]).toContain("status=current");
    expect(first.candidates[0]?.key).toBe("DOCSY");
    expect(first.nextProviderCursor).toBe("confluence-spaces:archived:");
    expect(requests[1]).toContain("status=archived");
    expect(second.candidates[0]?.status).toBe("archived");
  });

  test("rejects references outside the bound tenant", async () => {
    const providers = createRestScopeCatalogProviders(profile, "https://mayflower.atlassian.net");
    const resolved = await providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: "https://other.atlassian.net/projects/ATLCLI",
      expectedTenantOrigin: "https://mayflower.atlassian.net",
      expectedKinds: ["project"],
      signal: new AbortController().signal,
    });
    expect(resolved).toBeUndefined();
  });

  test("resolves an exact Jira project reference only after a tenant-bound read", async () => {
    globalThis.fetch = mock((url: string) => {
      expect(url).toContain("/rest/api/3/project/ATLCLI");
      return Promise.resolve(
        new Response(JSON.stringify({ id: "1", key: "ATLCLI", name: "atlcli" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, "https://mayflower.atlassian.net", {
      now: () => "2026-07-31T12:00:00.000Z",
    });

    const resolved = await providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: "https://mayflower.atlassian.net/projects/ATLCLI/summary",
      expectedTenantOrigin: "https://mayflower.atlassian.net",
      expectedKinds: ["project"],
      signal: new AbortController().signal,
    });

    expect(resolved?.key).toBe("ATLCLI");
    expect(resolved?.match).toBe("exact_link");
    expect(resolved?.canonicalUrl).toBe("https://mayflower.atlassian.net/projects/ATLCLI/summary");
  });
});

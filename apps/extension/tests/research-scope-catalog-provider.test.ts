import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { createRestScopeCatalogProviders } from "../utils/research/scope-catalog-provider.js";

const originalFetch = globalThis.fetch;
const profile: Profile = {
  name: "test",
  baseUrl: "https://example.atlassian.net",
  auth: { type: "session" },
};
const tenantOrigin = "https://example.atlassian.net";

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

    const providers = createRestScopeCatalogProviders(profile, tenantOrigin, {
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const page = await providers.jira.listProjects({
      includeArchived: false,
      maxCandidates: 2,
      signal: new AbortController().signal,
    });

    expect(requests[0]).toContain("/rest/api/3/project/search");
    expect(requests[0]).toContain("maxResults=2");
    expect(requests[0]).toContain("orderBy=name");
    expect(page.candidates).toEqual([
      {
        id: "research-scope-candidate:jira-project-atlcli",
        tenantOrigin,
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
              : [{
                  id: "1",
                  key: "DOCSY",
                  name: "Docs",
                  status: "current",
                  currentActiveAlias: "Documentation team",
                }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const providers = createRestScopeCatalogProviders(profile, tenantOrigin, {
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const first = await providers.confluence.listSpaces({
      query: "documentation team",
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
    expect(first.candidates[0]?.aliases).toEqual(["Documentation team"]);
    expect(first.nextProviderCursor).toBe("confluence-spaces:archived:");
    expect(requests[1]).toContain("status=archived");
    expect(second.candidates[0]?.status).toBe("archived");
  });

  test("rejects references outside the bound tenant", async () => {
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);
    const resolved = await providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: "https://other.atlassian.net/projects/ATLCLI",
      expectedTenantOrigin: tenantOrigin,
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
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin, {
      now: () => "2026-07-31T12:00:00.000Z",
    });

    const resolved = await providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: `${tenantOrigin}/projects/ATLCLI/summary`,
      expectedTenantOrigin: tenantOrigin,
      expectedKinds: ["project"],
      signal: new AbortController().signal,
    });

    expect(resolved?.key).toBe("ATLCLI");
    expect(resolved?.match).toBe("exact_link");
    expect(resolved?.canonicalUrl).toBe(`${tenantOrigin}/projects/ATLCLI/summary`);
  });

  test("clamps Jira page size, forwards query, and sorts duplicate names deterministically", async () => {
    let requested = "";
    globalThis.fetch = mock((url: string) => {
      requested = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            values: [
              { id: "2", key: "BETA", name: "Shared" },
              { id: "3", key: "ALPHA", name: "Shared" },
              { id: "1", key: "OTHER", name: "Unrelated" },
            ],
            total: 3,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);

    const page = await providers.jira.listProjects({
      query: "shared",
      includeArchived: false,
      maxCandidates: 100,
      signal: new AbortController().signal,
    });

    expect(requested).toContain("maxResults=50");
    expect(requested).toContain("query=shared");
    expect(page.candidates.map((item) => item.key)).toEqual(["ALPHA", "BETA"]);
  });

  test("filters trashed spaces, preserves archived status, and keeps cursors opaque", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock((url: string) => {
      requests.push(url);
      const archived = url.includes("status=archived");
      const continuedCurrentPage = url.includes("cursor=opaque%2Bcursor");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: archived
              ? [
                  { id: "4", key: "ARCH", name: "Archived", status: "archived" },
                  { id: "5", key: "TRASH", name: "Deleted", status: "trashed" },
                ]
              : continuedCurrentPage
                ? []
              : [
                  { id: "2", key: "BETA", name: "Shared", status: "current" },
                  { id: "1", key: "ALPHA", name: "Shared", status: "current" },
                ],
            ...(!archived && !continuedCurrentPage
              ? { _links: { next: "/wiki/api/v2/spaces?cursor=opaque%2Bcursor" } }
              : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);
    const first = await providers.confluence.listSpaces({
      query: "shared",
      includeArchived: true,
      maxCandidates: 250,
      signal: new AbortController().signal,
    });
    const second = await providers.confluence.listSpaces({
      includeArchived: true,
      maxCandidates: 250,
      providerCursor: first.nextProviderCursor,
      signal: new AbortController().signal,
    });
    const third = await providers.confluence.listSpaces({
      includeArchived: true,
      maxCandidates: 250,
      providerCursor: second.nextProviderCursor,
      signal: new AbortController().signal,
    });

    expect(first.candidates.map((item) => item.key)).toEqual(["ALPHA", "BETA"]);
    expect(first.nextProviderCursor).toBe("confluence-spaces:current:opaque%2Bcursor");
    expect(requests[1]).toContain("cursor=opaque%2Bcursor");
    expect(second.nextProviderCursor).toBe("confluence-spaces:archived:");
    expect(third.candidates.map((item) => [item.key, item.status])).toEqual([
      ["ARCH", "archived"],
    ]);
  });

  test("forwards in-flight cancellation and sanitizes provider failures", async () => {
    const controller = new AbortController();
    globalThis.fetch = mock((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    ) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);
    const pending = providers.jira.listProjects({
      includeArchived: false,
      maxCandidates: 10,
      signal: controller.signal,
    });
    controller.abort(new DOMException("operator cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      message: "The research run was cancelled.",
    });

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("PRIVATE_PROVIDER_PAYLOAD", { status: 403 })),
    ) as unknown as typeof fetch;
    await expect(providers.confluence.listSpaces({
      includeArchived: false,
      maxCandidates: 10,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "access-denied",
      message: "The Atlassian resource is unavailable.",
    });
  });

  test("resolves an exact Confluence link through a cancellable space read", async () => {
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      observedSignal = init.signal;
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: "1", key: "DOCS", name: "Docs", status: "current" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);
    const controller = new AbortController();
    const reference = `${tenantOrigin}/wiki/spaces/DOCS/overview`;

    const resolved = await providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference,
      expectedTenantOrigin: tenantOrigin,
      expectedKinds: ["space"],
      signal: controller.signal,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(resolved).toMatchObject({ key: "DOCS", status: "current", match: "exact_link" });
    expect(resolved?.canonicalUrl).toBe(reference);
  });

  test("rejects malformed provider cursors without making a request", async () => {
    let requests = 0;
    globalThis.fetch = mock(() => {
      requests += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);

    await expect(providers.confluence.listSpaces({
      includeArchived: false,
      maxCandidates: 10,
      providerCursor: "confluence-spaces:current:%E0%A4%A",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(requests).toBe(0);
  });

  test("keeps inaccessible and deleted exact references unselectable", async () => {
    const providers = createRestScopeCatalogProviders(profile, tenantOrigin);
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("PRIVATE_NOT_FOUND_PAYLOAD", { status: 404 })),
    ) as unknown as typeof fetch;

    await expect(providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: `${tenantOrigin}/projects/MISSING/summary`,
      expectedTenantOrigin: tenantOrigin,
      expectedKinds: ["project"],
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id: "9", key: "GONE", name: "Gone", status: "trashed" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;
    await expect(providers.resolveReference({
      schema: "atlcli.ptc/atlassian.reference.resolve.input/v1",
      reference: `${tenantOrigin}/wiki/spaces/GONE/overview`,
      expectedTenantOrigin: tenantOrigin,
      expectedKinds: ["space"],
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
  });
});

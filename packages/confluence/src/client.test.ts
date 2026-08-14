import { describe, test, expect, mock, afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient, escapeCqlValue } from "./client.js";

describe("escapeCqlValue", () => {
  test("passes plain values through unchanged", () => {
    expect(escapeCqlValue("handbook")).toBe("handbook");
    expect(escapeCqlValue("123456")).toBe("123456");
  });

  test("escapes double quotes and backslashes (CQL string-literal break-out)", () => {
    expect(escapeCqlValue('has "quotes"')).toBe('has \\"quotes\\"');
    expect(escapeCqlValue("back\\slash")).toBe("back\\\\slash");
    // Backslash escaped before quote so `\"` cannot be produced from `\` + `"`.
    expect(escapeCqlValue('\\"')).toBe('\\\\\\"');
  });

  test("strips control characters that could smuggle newlines into a query", () => {
    expect(escapeCqlValue("a\nb\tc")).toBe("abc");
    expect(escapeCqlValue("x\u0000y\u007Fz")).toBe("xyz");
  });
});

describe("Confluence v2 space pagination", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("maps a bounded page and extracts the opaque cursor from _links.next", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock((url: string) => {
      requests.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "123",
                key: "DOCSY",
                name: "Documentation",
                type: "global",
                currentActiveAlias: "Docs team",
                _links: { webui: "/spaces/DOCSY" },
              },
              { id: "missing-name", key: "SKIP" },
            ],
            _links: {
              next: "/wiki/api/v2/spaces?cursor=next-page-2&limit=2",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as unknown as typeof fetch;

    const page = await new ConfluenceClient(mockProfile).listSpacesV2({ limit: 2, cursor: "page-1" });

    expect(requests).toEqual([
      "https://test.atlassian.net/wiki/api/v2/spaces?limit=2&cursor=page-1",
    ]);
    expect(page.spaces).toEqual([
      {
        id: "123",
        key: "DOCSY",
        name: "Documentation",
        type: "global",
        aliases: ["Docs team"],
        url: "https://test.atlassian.net/wiki/spaces/DOCSY",
      },
    ]);
    expect(page.nextCursor).toBe("next-page-2");
  });

  test("does not invent a cursor when the v2 response has no next link", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(new ConfluenceClient(mockProfile).listSpacesV2()).resolves.toEqual({
      spaces: [],
      nextCursor: undefined,
    });
  });

  test("clamps the requested page size to the documented client boundary", async () => {
    let requested = "";
    globalThis.fetch = mock((url: string) => {
      requested = url;
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    await new ConfluenceClient(mockProfile).listSpacesV2({ limit: 10_000 });

    expect(requested).toContain("limit=250");
  });

  test("passes bounded exact space keys through the documented v2 filter", async () => {
    let requested = "";
    globalThis.fetch = mock((url: string) => {
      requested = url;
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    await new ConfluenceClient(mockProfile).listSpacesV2({
      limit: 2,
      keys: ["DOCSY", "TEAM"],
    });

    expect(requested).toContain("keys=DOCSY");
    expect(requested).toContain("keys=TEAM");
  });
});

// Mock profile for testing
const mockProfile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: {
    type: "apiToken" as const,
    email: "test@example.com",
    token: "test-token",
  },
};

// Store original fetch once at module level
const originalFetch = globalThis.fetch;
type RetryScheduler = (delayMs: number, signal?: AbortSignal) => Promise<void>;
const retrySchedulerHook = Symbol.for("atlcli.confluence.retry-scheduler.test-hook");
const retrySchedulerHost = globalThis as typeof globalThis &
  Record<symbol, RetryScheduler | undefined>;
const originalRetryScheduler = retrySchedulerHost[retrySchedulerHook];

function installImmediateRetryScheduler(requestedDelays: number[]): void {
  retrySchedulerHost[retrySchedulerHook] = async (delayMs, signal) => {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted");
    }
    requestedDelays.push(delayMs);
  };
}

function restoreRetryScheduler(): void {
  if (originalRetryScheduler) {
    retrySchedulerHost[retrySchedulerHook] = originalRetryScheduler;
  } else {
    delete retrySchedulerHost[retrySchedulerHook];
  }
}

describe("ConfluenceClient", () => {
  // Restore fetch after each test to prevent leaking into other test files
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreRetryScheduler();
  });

  describe("rate limiting", () => {
    const requestedDelays: number[] = [];

    beforeEach(() => {
      requestedDelays.length = 0;
      installImmediateRetryScheduler(requestedDelays);
    });

    test("retries on 429 with Retry-After header", async () => {
      let callCount = 0;
      globalThis.fetch = mock((url: string) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response("Rate limited", {
              status: 429,
              headers: { "Retry-After": "1" },
            })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "<p>content</p>" } },
              version: { number: 1 },
              space: { key: "TEST" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.getPage("123");

      expect(callCount).toBe(2);
      expect(result.id).toBe("123");
      expect(requestedDelays).toEqual([1000]);
    });

    test("retries on 429 with exponential backoff when no Retry-After", async () => {
      let callCount = 0;

      globalThis.fetch = mock((url: string) => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(
            new Response("Rate limited", { status: 429 })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "<p>content</p>" } },
              version: { number: 1 },
              space: { key: "TEST" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.getPage("123");

      expect(callCount).toBe(3);
      expect(result.id).toBe("123");
      expect(requestedDelays).toEqual([1000, 2000]);
    });

    test("throws after max retries on persistent 429", async () => {
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        return Promise.resolve(
          new Response("Rate limited", { status: 429 })
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);

      await expect(client.getPage("123")).rejects.toThrow(
        /rate limited/i
      );
      expect(callCount).toBe(4);
      expect(requestedDelays).toEqual([1000, 2000, 4000]);
    });

    test("retries on 5xx server errors", async () => {
      let callCount = 0;
      globalThis.fetch = mock((url: string) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response("Server error", { status: 500 })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "<p>content</p>" } },
              version: { number: 1 },
              space: { key: "TEST" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.getPage("123");

      expect(callCount).toBe(2);
      expect(result.id).toBe("123");
      expect(requestedDelays).toEqual([1000]);
    });

    test("does not retry on 4xx client errors (except 429)", async () => {
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        return Promise.resolve(
          new Response("Not found", { status: 404 })
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);

      await expect(client.getPage("123")).rejects.toThrow(/404/);
      expect(callCount).toBe(1); // No retry
      expect(requestedDelays).toEqual([]);
    });
  });

  describe("real retry timer abort", () => {
    test("aborts during the production 5xx backoff without retrying", async () => {
      restoreRetryScheduler();
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        return Promise.resolve(new Response("Server error", { status: 500 }));
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      const pending = new ConfluenceClient(mockProfile).getPage("123", {
        signal: controller.signal,
      });

      // Let the response drive the client into its real 1 s timer.
      await Bun.sleep(50);
      expect(callCount).toBe(1);

      const abortedAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });

      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(callCount).toBe(1);
    });
  });

  describe("authentication", () => {
    test("sends Basic auth header", async () => {
      let capturedHeaders: Headers | undefined;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedHeaders = new Headers(options.headers);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "" } },
              version: { number: 1 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.getPage("123");

      expect(capturedHeaders?.get("Authorization")).toMatch(/^Basic /);
    });

    test("throws for non-apiToken auth type", () => {
      const oauthProfile = {
        ...mockProfile,
        auth: { type: "oauth" as const },
      };

      expect(() => new ConfluenceClient(oauthProfile as any)).toThrow(
        /OAuth is not implemented/
      );
    });
  });

  describe("TLS options", () => {
    test("omits the tls field on fetch when the profile has no TLS config", async () => {
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock((_url: string, options: RequestInit) => {
        capturedInit = options;
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: "123", title: "Test", version: { number: 1 }, space: { key: "TEST" } }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.getPage("123");

      expect(capturedInit).toBeDefined();
      expect("tls" in (capturedInit as Record<string, unknown>)).toBe(false);
    });

    test("passes tls options on fetch when the profile skips verification", async () => {
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock((_url: string, options: RequestInit) => {
        capturedInit = options;
        return Promise.resolve(
          new Response(
            JSON.stringify({ id: "123", title: "Test", version: { number: 1 }, space: { key: "TEST" } }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient({ ...mockProfile, tlsSkipVerify: true });
      await client.getPage("123");

      const tls = (capturedInit as unknown as { tls?: { rejectUnauthorized?: boolean } }).tls;
      expect(tls).toBeDefined();
      expect(tls?.rejectUnauthorized).toBe(false);
    });
  });

  describe("API methods", () => {
    test("getPage fetches with correct expand parameters", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test Page",
              body: { storage: { value: "<p>content</p>" } },
              version: { number: 5 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.getPage("123");

      expect(capturedUrl).toContain("/content/123");
      expect(capturedUrl).toContain("expand=body.storage");
      expect(result.id).toBe("123");
      expect(result.title).toBe("Test Page");
      expect(result.version).toBe(5);
    });

    test("searchPages uses CQL query", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { content: { id: "1", title: "Page 1" } },
                { content: { id: "2", title: "Page 2" } },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const results = await client.searchPages("space=TEST");

      expect(capturedUrl).toContain("cql=space%3DTEST");
      expect(results.length).toBe(2);
    });

    test("createPage sends correct payload", async () => {
      let capturedBody: any;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "456",
              title: "New Page",
              version: { number: 1 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.createPage({
        spaceKey: "TEST",
        title: "New Page",
        storage: "<p>content</p>",
      });

      expect(capturedBody.type).toBe("page");
      expect(capturedBody.title).toBe("New Page");
      expect(capturedBody.space.key).toBe("TEST");
      expect(capturedBody.body.storage.value).toBe("<p>content</p>");
      expect(result.id).toBe("456");
    });

    test("updatePage sends version number", async () => {
      let capturedBody: any;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Updated",
              version: { number: 6 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.updatePage({
        id: "123",
        title: "Updated",
        storage: "<p>new content</p>",
        version: 6,
      });

      expect(capturedBody.version.number).toBe(6);
      expect(capturedBody.title).toBe("Updated");
    });
  });

  describe("context path handling (Cloud vs Data Center)", () => {
    // Regression coverage for the hardcoded `/wiki` path. Atlassian Cloud
    // serves Confluence under `/wiki`, while Server/Data Center instances are
    // served from their own context path (e.g. `/confluence`) that is already
    // part of the configured site URL. The client must not blindly append
    // `/wiki` for the latter, otherwise REST requests hit a non-existent path
    // (manifesting as 404/405 page create/update failures).

    // Mock fetch to return `body`, run `call` against a client for `baseUrl`,
    // and return the URL the client actually requested.
    async function captureRequestUrl(
      baseUrl: string,
      body: unknown,
      call: (client: ConfluenceClient) => Promise<unknown>,
      profileOverrides: Partial<Profile> = {}
    ): Promise<string> {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as unknown as typeof fetch;

      await call(new ConfluenceClient({ ...mockProfile, baseUrl, ...profileOverrides }));
      return capturedUrl;
    }

    const pageBody = { id: "123", title: "Test", version: { number: 1 }, space: { key: "TEST" } };

    test("Cloud page-version snapshots use REST v2 and keep large ids as strings", async () => {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify({
          id: "2819653636",
          title: "Design specification",
          version: { number: 17, createdAt: "2026-08-14T05:00:00.000Z" },
        }), { status: 200 }));
      }) as unknown as typeof fetch;

      const snapshot = await new ConfluenceClient(mockProfile).getPageVersion("2819653636");

      const url = new URL(capturedUrl);
      expect(url.pathname).toBe("/wiki/api/v2/pages/2819653636");
      expect(url.searchParams.get("include-version")).toBe("true");
      expect(snapshot).toEqual({
        id: "2819653636",
        title: "Design specification",
        version: 17,
        lastModified: "2026-08-14T05:00:00.000Z",
      });
    });

    test("Cloud page-version snapshots reject a response without a current version", async () => {
      globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        id: "2819653636",
        title: "Design specification",
      }), { status: 200 }))) as unknown as typeof fetch;

      await expect(
        new ConfluenceClient(mockProfile).getPageVersion("2819653636")
      ).rejects.toThrow("without a valid current version");
    });

    test("Data Center page-version snapshots stay on REST v1", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        pageBody,
        (client) => client.getPageVersion("123"),
        { deploymentType: "data-center" },
      );
      expect(url).toContain("/confluence/rest/api/content/123");
      expect(url).not.toContain("/api/v2/");
    });

    test("Cloud space homepage resolution uses REST v2", async () => {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify({
          results: [{ id: "space-1", key: "DOCSY", name: "Docs", homepageId: "2819653636" }],
          _links: {},
        }), { status: 200 }));
      }) as unknown as typeof fetch;

      await expect(new ConfluenceClient(mockProfile).getSpaceHomepageId("DOCSY"))
        .resolves.toBe("2819653636");
      const url = new URL(capturedUrl);
      expect(url.pathname).toBe("/wiki/api/v2/spaces");
      expect(url.searchParams.getAll("keys")).toEqual(["DOCSY"]);
      expect(url.searchParams.get("status")).toBe("current");
    });

    test("Data Center space homepage resolution stays on REST v1", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        { homepage: { id: "123" } },
        (client) => client.getSpaceHomepageId("DOCS"),
        { deploymentType: "data-center" },
      );
      expect(url).toContain("/confluence/rest/api/space/DOCS");
      expect(url).not.toContain("/api/v2/");
    });

    // REST v1 path building: Cloud appends /wiki; a DC context path is honored
    // verbatim; trailing slashes are normalized.
    for (const { name, baseUrl } of [
      { name: "Cloud bare host appends /wiki", baseUrl: "https://test.atlassian.net" },
      { name: "DC context path is honored", baseUrl: "https://confluence.example.com/confluence" },
      { name: "DC trailing slash is normalized", baseUrl: "https://confluence.example.com/confluence/" },
    ]) {
      test(`getPage URL — ${name}`, async () => {
        const isCloud = baseUrl.includes("atlassian.net");
        const expectedBase = isCloud
          ? "https://test.atlassian.net/wiki"
          : "https://confluence.example.com/confluence";
        const url = await captureRequestUrl(baseUrl, pageBody, (c) => c.getPage("123"));
        expect(url).toContain(`${expectedBase}/rest/api/content/123`);
        if (!isCloud) expect(url).not.toContain("/wiki/");
      });
    }

    // A mutation (the originally-reported HTTP 405 failure) must also route
    // through the context path rather than /wiki on Data Center.
    test("updatePage targets the DC context path, not /wiki", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        pageBody,
        (c) => c.updatePage({ id: "123", title: "Updated", storage: "<p>new</p>", version: 2 })
      );
      expect(url).toContain("/confluence/rest/api/content/123");
      expect(url).not.toContain("/wiki/");
    });

    test("v2 API requests honor the DC context path", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        { results: [] },
        (c) => c.getPageDirectChildren("123")
      );
      expect(url).toContain("/confluence/api/v2/pages/123/direct-children");
      expect(url).not.toContain("/wiki/");
    });

    test("an explicit Data Center profile supports a root deployment", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com",
        pageBody,
        (c) => c.getPage("123"),
        { deploymentType: "data-center" }
      );
      expect(url).toContain("https://confluence.example.com/rest/api/content/123");
      expect(url).not.toContain("/wiki/");
    });

    test("Data Center may legitimately use /wiki as its configured context path", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/wiki",
        pageBody,
        (c) => c.getPage("123"),
        { deploymentType: "data-center" }
      );
      expect(url).toContain("https://confluence.example.com/wiki/rest/api/content/123");
      expect(url).not.toContain("/wiki/wiki/");
    });

    test("multipart uploads honor the Data Center context path", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        {
          id: "att123",
          title: "test.txt",
          version: { number: 1 },
          extensions: { fileSize: 4, mediaType: "text/plain" },
          _links: { download: "/download/attachments/123/test.txt" },
        },
        (c) => c.uploadAttachment({
          pageId: "123",
          filename: "test.txt",
          data: new TextEncoder().encode("test"),
        })
      );
      expect(url).toContain("/confluence/rest/api/content/123/child/attachment");
    });

    test("binary downloads honor the Data Center context path", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        "attachment data",
        (c) => c.downloadAttachment({ downloadUrl: "/download/attachments/123/test.txt" })
      );
      expect(url).toContain("/confluence/download/attachments/123/test.txt");
    });

    test("webhook requests honor the Data Center context path", async () => {
      const url = await captureRequestUrl(
        "https://confluence.example.com/confluence",
        { id: "hook-1", name: "Docs", url: "https://hooks.example.com", events: [] },
        (c) => c.registerWebhook({ name: "Docs", url: "https://hooks.example.com", events: [] })
      );
      expect(url).toContain("/confluence/rest/webhooks/1.0/webhook");
    });

    // Web UI links reconstructed from a relative `_links.webui` (v2 endpoints
    // that omit `_links.base`) must use the same context path as REST requests.
    test("web UI links use the DC context path", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { id: "999", title: "Child", type: "page", _links: { webui: "/spaces/TEST/pages/999/Child" } },
              ],
            }),
            { status: 200 }
          )
        )
      ) as unknown as typeof fetch;

      const client = new ConfluenceClient({
        ...mockProfile,
        baseUrl: "https://confluence.example.com/confluence",
      });
      const children = await client.getPageDirectChildren("123");

      expect(children[0]?.url).toBe(
        "https://confluence.example.com/confluence/spaces/TEST/pages/999/Child"
      );
    });

    test("Cloud descendants keeps large page ids as strings and maps child positions", async () => {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify({
          results: [{
            id: "2819653637",
            title: "Child",
            type: "page",
            parentId: "2819653636",
            childPosition: 9,
          }],
        }), { status: 200 }));
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const children = await client.getPageDescendants("2819653636");

      const url = new URL(capturedUrl);
      expect(url.pathname).toBe("/wiki/api/v2/pages/2819653636/descendants");
      expect(url.searchParams.get("depth")).toBe("1");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(children).toEqual([{
        id: "2819653637",
        title: "Child",
        type: "page",
        spaceId: undefined,
        parentId: "2819653636",
        position: 9,
        url: undefined,
      }]);
    });

    test("Cloud direct-children preserves the child content status", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({
          results: [
            { id: "1", title: "Published", type: "page", status: "current", childPosition: 1 },
            { id: "2", title: "Draft", type: "page", status: "draft", childPosition: 2 },
            { id: "3", title: "Untyped", type: "page", childPosition: 3 },
          ],
        }), { status: 200 }))
      ) as unknown as typeof fetch;

      const children = await new ConfluenceClient(mockProfile).getPageDirectChildren("123");
      expect(children.map((child) => ({ id: child.id, status: child.status }))).toEqual([
        { id: "1", status: "current" },
        { id: "2", status: "draft" },
        { id: "3", status: undefined },
      ]);
    });

    test("Cloud bulk page-version snapshots batch ids through the v2 pages listing", async () => {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(new Response(JSON.stringify({
          results: [
            {
              id: "2819653637",
              title: "Child A",
              version: { number: 4, createdAt: "2026-08-14T05:00:00.000Z" },
            },
            // "2819653638" (restricted / draft-only) is deliberately absent.
          ],
        }), { status: 200 }));
      }) as unknown as typeof fetch;

      const versions = await new ConfluenceClient(mockProfile)
        .getPageVersions(["2819653637", "2819653638"]);

      const url = new URL(capturedUrl);
      expect(url.pathname).toBe("/wiki/api/v2/pages");
      expect(url.searchParams.get("id")).toBe("2819653637,2819653638");
      expect(url.searchParams.get("include-version")).toBe("true");
      expect(versions.get("2819653637")).toEqual({
        id: "2819653637",
        title: "Child A",
        version: 4,
        lastModified: "2026-08-14T05:00:00.000Z",
      });
      expect(versions.has("2819653638")).toBe(false);
    });

    test("bulk page-version snapshots refuse to run against Data Center", async () => {
      globalThis.fetch = mock(() => {
        throw new Error("no request must be issued");
      }) as unknown as typeof fetch;
      const client = new ConfluenceClient({
        ...mockProfile,
        baseUrl: "https://confluence.example.com/confluence",
        deploymentType: "data-center",
      } as Profile);
      await expect(client.getPageVersions(["123"])).rejects.toThrow(
        "Bulk page-version snapshots require Confluence Cloud REST v2."
      );
    });
  });

  describe("label operations", () => {
    test("getLabels fetches labels for a page", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { id: "1", name: "architecture", prefix: "global" },
                { id: "2", name: "api-docs", prefix: "global" },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const labels = await client.getLabels("123");

      expect(capturedUrl).toContain("/content/123/label");
      expect(labels.length).toBe(2);
      expect(labels[0].name).toBe("architecture");
      expect(labels[1].name).toBe("api-docs");
    });

    test("addLabels sends correct payload", async () => {
      let capturedBody: any;
      let capturedUrl = "";
      let capturedMethod = "";

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedMethod = options.method ?? "GET";
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { id: "1", name: "new-label", prefix: "global" },
                { id: "2", name: "another-label", prefix: "global" },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.addLabels("123", ["new-label", "another-label"]);

      expect(capturedUrl).toContain("/content/123/label");
      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toEqual([
        { prefix: "global", name: "new-label" },
        { prefix: "global", name: "another-label" },
      ]);
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("new-label");
    });

    test("removeLabel sends DELETE request", async () => {
      let capturedUrl = "";
      let capturedMethod = "";

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedMethod = options.method ?? "GET";
        return Promise.resolve(
          new Response("", { status: 204 })
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.removeLabel("123", "old-label");

      expect(capturedUrl).toContain("/content/123/label/old-label");
      expect(capturedMethod).toBe("DELETE");
    });

    test("removeLabel encodes special characters in label name", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response("", { status: 204 })
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.removeLabel("123", "label with spaces");

      expect(capturedUrl).toContain("label%20with%20spaces");
    });

    test("getPagesByLabel uses CQL with label filter", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  id: "1",
                  title: "Page 1",
                  version: { number: 1 },
                  space: { key: "TEST" },
                },
                {
                  id: "2",
                  title: "Page 2",
                  version: { number: 2 },
                  space: { key: "TEST" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const pages = await client.getPagesByLabel("architecture");

      // URL encoding: spaces become + in query strings
      expect(capturedUrl).toContain('label');
      expect(capturedUrl).toContain('architecture');
      expect(capturedUrl).toContain('type');
      expect(capturedUrl).toContain('page');
      expect(pages.length).toBe(2);
      expect(pages[0].title).toBe("Page 1");
    });

    test("getPagesByLabel filters by space when provided", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [] }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.getPagesByLabel("architecture", { spaceKey: "DEV" });

      // URL encoding: spaces become + in query strings
      expect(capturedUrl).toContain('space');
      expect(capturedUrl).toContain('DEV');
    });
  });

  describe("page history operations", () => {
    test("getPageHistory fetches version history", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  number: 3,
                  when: "2024-01-15T10:00:00Z",
                  message: "Updated content",
                  by: { displayName: "Alice" },
                },
                {
                  number: 2,
                  when: "2024-01-14T10:00:00Z",
                  message: "Initial revision",
                  by: { displayName: "Bob" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const history = await client.getPageHistory("123");

      expect(capturedUrl).toContain("/content/123/version");
      expect(history.versions.length).toBe(2);
      expect(history.versions[0].number).toBe(3);
      expect(history.versions[0].by.displayName).toBe("Alice");
    });

    test("getPageHistory respects limit option", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [] }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.getPageHistory("123", { limit: 5 });

      expect(capturedUrl).toContain("limit=5");
    });

    test("getPageAtVersion fetches specific version", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: {
                id: "123",
                title: "Old Title",
                body: { storage: { value: "<p>Old content</p>" } },
                version: { number: 2 },
                space: { key: "TEST" },
              },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const page = await client.getPageAtVersion("123", 2);

      expect(capturedUrl).toContain("/content/123/version/2");
      expect(capturedUrl).toContain("expand=content");
      expect(page.title).toBe("Old Title");
      expect(page.storage).toBe("<p>Old content</p>");
      expect(page.version).toBe(2);
    });

    test("restorePageVersion creates new version with old content", async () => {
      let capturedUrls: string[] = [];
      let capturedBody: any;
      let callCount = 0;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedUrls.push(url);
        callCount++;

        // First call: get page at version
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                content: {
                  id: "123",
                  title: "Old Title",
                  body: { storage: { value: "<p>Old content</p>" } },
                  version: { number: 2 },
                  space: { key: "TEST" },
                },
              }),
              { status: 200 }
            )
          );
        }

        // Second call: get current page
        if (callCount === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "123",
                title: "Current Title",
                body: { storage: { value: "<p>Current</p>" } },
                version: { number: 5 },
                space: { key: "TEST" },
              }),
              { status: 200 }
            )
          );
        }

        // Third call: update page
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Old Title",
              version: { number: 6 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const result = await client.restorePageVersion("123", 2, "Restored to v2");

      expect(capturedUrls[0]).toContain("/version/2");
      expect(capturedBody.body.storage.value).toBe("<p>Old content</p>");
      expect(capturedBody.version.number).toBe(6);
      expect(capturedBody.version.message).toBe("Restored to v2");
      expect(result.version).toBe(6);
    });

    test("restorePageVersion uses default message when not provided", async () => {
      let capturedBody: any;
      let callCount = 0;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                content: {
                  id: "123",
                  title: "Title",
                  body: { storage: { value: "<p>content</p>" } },
                  version: { number: 2 },
                  space: { key: "TEST" },
                },
              }),
              { status: 200 }
            )
          );
        }

        if (callCount === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "123",
                title: "Title",
                body: { storage: { value: "" } },
                version: { number: 5 },
                space: { key: "TEST" },
              }),
              { status: 200 }
            )
          );
        }

        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Title",
              version: { number: 6 },
              space: { key: "TEST" },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.restorePageVersion("123", 2);

      expect(capturedBody.version.message).toContain("Restored to version 2");
    });
  });

  describe("editor version operations", () => {
    test("getEditorVersion returns v2 for new editor", async () => {
      globalThis.fetch = mock((url: string) => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "" } },
              version: { number: 1 },
              space: { key: "TEST" },
              metadata: {
                properties: {
                  editor: { value: "v2" },
                },
              },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const version = await client.getEditorVersion("123");

      expect(version).toBe("v2");
    });

    test("getEditorVersion returns v1 for legacy editor", async () => {
      globalThis.fetch = mock((url: string) => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "" } },
              version: { number: 1 },
              space: { key: "TEST" },
              metadata: {
                properties: {
                  editor: { value: "v1" },
                },
              },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const version = await client.getEditorVersion("123");

      expect(version).toBe("v1");
    });

    test("getEditorVersion returns null when not set", async () => {
      globalThis.fetch = mock((url: string) => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              body: { storage: { value: "" } },
              version: { number: 1 },
              space: { key: "TEST" },
              metadata: { properties: {} },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const version = await client.getEditorVersion("123");

      expect(version).toBeNull();
    });

    test("getEditorVersion expands metadata.properties.editor", async () => {
      let capturedUrl = "";

      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "123",
              title: "Test",
              metadata: { properties: {} },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.getEditorVersion("123");

      expect(capturedUrl).toContain("expand=metadata.properties.editor");
    });

    test("setEditorVersion creates property when it does not exist", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      let capturedBody: any;
      let callCount = 0;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedUrl = url;
        capturedMethod = options.method ?? "GET";
        callCount++;

        // First call: GET property - returns 404
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: "Not found" }), { status: 404 })
          );
        }

        // Second call: POST to create property
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ key: "editor", value: "v2" }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.setEditorVersion("123", "v2");

      expect(callCount).toBe(2);
      expect(capturedMethod).toBe("POST");
      expect(capturedBody.key).toBe("editor");
      expect(capturedBody.value).toBe("v2");
    });

    test("setEditorVersion updates property when it exists", async () => {
      let capturedMethod = "";
      let capturedBody: any;
      let callCount = 0;

      globalThis.fetch = mock((url: string, options: RequestInit) => {
        capturedMethod = options.method ?? "GET";
        callCount++;

        // First call: GET property - returns existing
        if (callCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ key: "editor", value: "v1", version: { number: 1 } }),
              { status: 200 }
            )
          );
        }

        // Second call: PUT to update property
        if (options.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ key: "editor", value: "v2", version: { number: 2 } }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.setEditorVersion("123", "v2");

      expect(callCount).toBe(2);
      expect(capturedMethod).toBe("PUT");
      expect(capturedBody.key).toBe("editor");
      expect(capturedBody.value).toBe("v2");
      expect(capturedBody.version.number).toBe(2);
    });
  });

  describe("getSpaceIcon (spec 005 logo pass)", () => {
    test("expands icon and returns the path with dimensions", async () => {
      let capturedUrl = "";
      globalThis.fetch = mock((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "1",
              key: "DOCSY",
              name: "Docs",
              icon: {
                path: "/download/attachments/623935492/DOCSY-default?version=1&api=v2",
                width: 48,
                height: 48,
                isDefault: false,
              },
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      const icon = await client.getSpaceIcon("DOCSY");

      expect(capturedUrl).toContain("/rest/api/space/DOCSY");
      expect(capturedUrl).toContain("expand=icon");
      expect(icon).toEqual({
        path: "/download/attachments/623935492/DOCSY-default?version=1&api=v2",
        width: 48,
        height: 48,
        isDefault: false,
      });
    });

    test("returns null when the space carries no icon", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: "1", key: "X", name: "X" }), { status: 200 })
        )
      ) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      expect(await client.getSpaceIcon("X")).toBeNull();
    });
  });

  describe("session auth mode (spec 001 task 5)", () => {
    const sessionProfile: Profile = {
      name: "session",
      baseUrl: "https://test.atlassian.net",
      auth: { type: "session" },
    };

    /** Capture the RequestInit of the last fetch call. */
    function captureFetch(
      response: (url: string, init?: RequestInit) => Response,
    ): { last: () => RequestInit | undefined } {
      let last: RequestInit | undefined;
      globalThis.fetch = mock((_url: string | URL, init: RequestInit) => {
        last = init;
        return Promise.resolve(response(String(_url), init));
      }) as unknown as typeof fetch;
      return { last: () => last };
    }

    const pageResponse = () =>
      new Response(
        JSON.stringify({
          id: "123",
          title: "Test",
          body: { storage: { value: "" } },
          version: { number: 1 },
          space: { key: "TEST" },
        }),
        { status: 200 }
      );

    test("page CRUD (getPage): no Authorization header, credentials include", async () => {
      const cap = captureFetch(pageResponse);
      await new ConfluenceClient(sessionProfile).getPage("123");
      const init = cap.last();
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.credentials).toBe("include");
    });

    test("search: no Authorization header, credentials include", async () => {
      const cap = captureFetch(() =>
        new Response(JSON.stringify({ results: [], size: 0, start: 0, limit: 25 }), { status: 200 })
      );
      await new ConfluenceClient(sessionProfile).search("type=page");
      const init = cap.last();
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.credentials).toBe("include");
    });

    test("attachment upload: no Authorization header, credentials include", async () => {
      const captured: RequestInit[] = [];
      globalThis.fetch = mock((_url: string | URL, init: RequestInit) => {
        captured.push(init);
        const payload = init.method === "GET"
          ? { results: [] }
          : { results: [{ id: "att1", title: "f.png", version: { number: 1 } }] };
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }) as unknown as typeof fetch;
      await new ConfluenceClient(sessionProfile).uploadAttachment({
        pageId: "123",
        filename: "f.png",
        data: new Uint8Array([1, 2, 3]),
      });
      expect(captured).toHaveLength(2);
      for (const init of captured) {
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        expect(init.credentials).toBe("include");
      }
    });

    test("attachment upload preserves the session authentication redirect wording", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: "https://id.atlassian.com/login" },
        }))
      ) as unknown as typeof fetch;

      await expect(
        new ConfluenceClient(sessionProfile).uploadAttachment({
          pageId: "123",
          filename: "f.png",
          data: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow("authentication redirect");
    });

    test("attachment download: no Authorization header, credentials include", async () => {
      const cap = captureFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      await new ConfluenceClient(sessionProfile).downloadAttachment({
        downloadUrl: "/download/attachments/123/f.png",
      });
      const init = cap.last();
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.credentials).toBe("include");
    });

    test("regression: non-session profile keeps Authorization and leaves credentials unset", async () => {
      const cap = captureFetch(pageResponse);
      await new ConfluenceClient(mockProfile).getPage("123");
      const init = cap.last();
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /);
      expect(init?.credentials).toBeUndefined();
    });
  });

  describe("attachment delivery transport", () => {
    test("token client proves Cloud preflight, create, and update-data requests", async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      globalThis.fetch = mock((url: string | URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        if (init.method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ results: [] }), {
            status: 200,
          }));
        }
        const isUpdate = String(url).endsWith("/child/attachment/att-1/data");
        const content = {
          id: "att-1",
          title: "report.pdf",
          metadata: { mediaType: "application/pdf" },
          extensions: { fileSize: 3 },
          version: { number: isUpdate ? 2 : 1 },
          _links: { download: "/download/attachments/123/report.pdf" },
        };
        return Promise.resolve(new Response(JSON.stringify(
          isUpdate ? content : { results: [content] },
        ), { status: 200 }));
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.uploadAttachment({
        pageId: "123",
        filename: "report.pdf",
        data: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
      });
      const updated = await client.updateAttachment({
        pageId: "123",
        attachmentId: "att-1",
        filename: "report.pdf",
        data: new Uint8Array([4, 5, 6]),
        mimeType: "application/pdf",
      });

      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/wiki/api/v2/pages/123/attachments",
        "/wiki/rest/api/content/123/child/attachment",
        "/wiki/rest/api/content/123/child/attachment/att-1/data",
      ]);
      expect(new URL(calls[0]!.url).searchParams.get("filename")).toBe("report.pdf");
      expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("1");
      for (const call of calls) {
        expect(new Headers(call.init.headers).get("Authorization")).toMatch(/^Basic /);
        expect(call.init.credentials).toBeUndefined();
      }
      for (const call of calls.slice(1)) {
        const headers = new Headers(call.init.headers);
        expect(headers.has("Content-Type")).toBe(false);
        const form = call.init.body as FormData;
        expect(form.get("minorEdit")).toBe("true");
      }
      expect(updated.version).toBe(2);
    });

    test("Data Center create stays on v1, sends minorEdit, and is never retried", async () => {
      let calls = 0;
      let capturedInit: RequestInit | undefined;
      globalThis.fetch = mock((_url: string | URL, init: RequestInit) => {
        calls++;
        capturedInit = init;
        return Promise.resolve(new Response("temporary failure", { status: 500 }));
      }) as unknown as typeof fetch;

      await expect(
        new ConfluenceClient({
          ...mockProfile,
          baseUrl: "https://confluence.example.com/confluence",
          deploymentType: "data-center",
        }).uploadAttachment({
          pageId: "123",
          filename: "report.pdf",
          data: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow("Attachment upload error (500)");

      expect(calls).toBe(1);
      expect((capturedInit?.body as FormData).get("minorEdit")).toBe("true");
      expect(new Headers(capturedInit?.headers).has("Content-Type")).toBe(false);
    });
  });

  describe("findPagesByTitle — direct content endpoint (no search-index lag, spec 005 D1)", () => {
    test("hits /content (NOT /content/search) with type=page + title + spaceKey", async () => {
      const urls: string[] = [];
      globalThis.fetch = mock((url: string) => {
        urls.push(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [{ id: "500", title: "Imprint", space: { key: "DOCSY" } }],
              _links: {},
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }) as unknown as typeof fetch;

      const hits = await new ConfluenceClient(mockProfile).findPagesByTitle("Imprint", {
        spaceKey: "DOCSY",
      });
      expect(hits).toEqual([{ id: "500", title: "Imprint", spaceKey: "DOCSY" }]);
      // The regression pin: the DIRECT content endpoint, never the search index.
      expect(urls[0]).toContain("/rest/api/content?");
      expect(urls[0]).not.toContain("/content/search");
      expect(urls[0]).toContain("type=page");
      expect(urls[0]).toContain("title=Imprint");
      expect(urls[0]).toContain("spaceKey=DOCSY");
    });

    test("follows _links.next to completion (title with multiple matches)", async () => {
      let call = 0;
      globalThis.fetch = mock((url: string) => {
        call++;
        const body =
          call === 1
            ? { results: [{ id: "20", title: "Dup", space: { key: "ENG" } }], _links: { next: "/rest/api/content?type=page&title=Dup&start=1" } }
            : { results: [{ id: "10", title: "Dup", space: { key: "ENG" } }], _links: {} };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
        );
      }) as unknown as typeof fetch;

      const hits = await new ConfluenceClient(mockProfile).findPagesByTitle("Dup");
      expect(call).toBe(2);
      expect(hits.map((h) => h.id)).toEqual(["20", "10"]);
    });
  });
});

describe("429 retry delay is bounded (spec 010 wave-1 review, B6)", () => {
  const originalFetchLocal = globalThis.fetch;
  const requestedDelays: number[] = [];

  beforeEach(() => {
    requestedDelays.length = 0;
    installImmediateRetryScheduler(requestedDelays);
  });

  afterEach(() => {
    globalThis.fetch = originalFetchLocal;
    restoreRetryScheduler();
  });

  test("does not retry immediately when Retry-After is unparseable", async () => {
    // Proves the clamp is WIRED INTO the request loop, not merely exported:
    // `parseInt("unavailable", 10) * 1000` is NaN, so the client used to request
    // an immediate timer instead of falling back to its exponential base.
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response("Rate limited", {
            status: 429,
            headers: { "Retry-After": "unavailable" },
          })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "123",
            title: "Test",
            body: { storage: { value: "<p>c</p>" } },
            version: { number: 1 },
            space: { key: "TEST" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    const client = new ConfluenceClient(mockProfile);
    await client.getPage("123");

    expect(callCount).toBe(2);
    expect(requestedDelays).toEqual([1000]);
  });
});

/**
 * Session-mode ATTACHMENT downloads: follow the redirect that delivers the bytes
 * (spec 010 wave 2).
 *
 * The design gap: `applyFetchOptions` set `redirect: "manual"` for every session
 * request and `requestBinary` treated any non-2xx as a download failure. Cloud
 * answers `/download/attachments/…` with a 302 to `api.media.atlassian.com` BY
 * DESIGN, so session-mode attachment downloads could not return bytes at all.
 * Classification is by DESTINATION now: a login bounce still raises the same
 * auth error (there are no attachment bytes at a login page), a media/site hop is
 * followed with the session credential stripped, anything else is refused.
 *
 * Driven against real `Bun.serve` origins so the redirect is a real redirect. The
 * only substitution is a DNS-style resolver mapping the production
 * `https://api.media.atlassian.com` prefix onto the local media server — the
 * hostname the POLICY judges is the production one.
 */
describe("ConfluenceClient session attachment redirects (spec 010 wave 2)", () => {
  const MEDIA_PREFIX = "https://api.media.atlassian.com";
  const realFetch = globalThis.fetch;

  let site: ReturnType<typeof Bun.serve>;
  let media: ReturnType<typeof Bun.serve>;
  let third: ReturnType<typeof Bun.serve>;
  let base = "";
  let mediaBase = "";
  let thirdBase = "";

  const hits: string[] = [];
  const mediaHeaders: Headers[] = [];
  let inits: Array<{ url: string; init: RequestInit | undefined }> = [];

  const BYTES = new Uint8Array([4, 5, 6]);

  beforeAll(() => {
    media = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`media${new URL(req.url).pathname}`);
        mediaHeaders.push(req.headers);
        return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
      },
    });
    mediaBase = `http://127.0.0.1:${media.port}`;

    third = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`third${new URL(req.url).pathname}`);
        return new Response("owned", { status: 200 });
      },
    });
    thirdBase = `http://127.0.0.1:${third.port}`;

    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(`site${pathname}`);
        const redirect = (to: string) =>
          new Response(null, { status: 302, headers: { Location: to } });
        switch (pathname) {
          case "/wiki/download/attachments/1/media.png":
            return redirect(`${MEDIA_PREFIX}/file/abc/binary?token=SECRET`);
          // Server/DC shape: the login bounce is SAME-ORIGIN, so only the path
          // distinguishes it from a legitimate hop.
          case "/wiki/download/attachments/1/expired.png":
            return redirect(`${base}/wiki/login.action?os_destination=%2Fx`);
          case "/wiki/download/attachments/1/evil.png":
            return redirect(`${thirdBase}/steal`);
          case "/wiki/download/attachments/1/moved.png":
            return redirect(`${base}/wiki/download/attachments/1/final.png`);
          case "/wiki/download/attachments/1/final.png":
            return new Response(BYTES, { status: 200 });
          // A JSON endpoint bouncing to the media CDN must STILL be refused.
          case "/wiki/rest/api/content/MEDIA-1":
            return redirect(`${MEDIA_PREFIX}/file/abc/binary`);
          case "/wiki/login.action":
            return new Response("<html>login</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          default:
            if (pathname.startsWith("/wiki/loop/")) {
              const n = Number(pathname.slice("/wiki/loop/".length)) || 0;
              return redirect(`${base}/wiki/loop/${n + 1}`);
            }
            return new Response(BYTES, { status: 200 });
        }
      },
    });
    base = `http://127.0.0.1:${site.port}`;
  });

  afterAll(() => {
    site.stop(true);
    media.stop(true);
    third.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
    mediaHeaders.length = 0;
    inits = [];
    globalThis.fetch = ((input: string, init: RequestInit) => {
      const url = String(input);
      inits.push({ url, init });
      const target = url.startsWith(MEDIA_PREFIX)
        ? `${mediaBase}${url.slice(MEDIA_PREFIX.length)}`
        : url;
      return realFetch(target, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Cloud deployment => the client appends `/wiki` to the base URL.
  const sessionProfile = (): Profile => ({
    name: "session",
    baseUrl: base,
    auth: { type: "session" },
  });
  const tokenProfile = (): Profile => ({
    name: "token",
    baseUrl: base,
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  });

  test("follows the media-CDN redirect and returns the attachment bytes", async () => {
    const bytes = await new ConfluenceClient(sessionProfile()).downloadAttachment({
      downloadUrl: "/download/attachments/1/media.png",
    });

    expect(bytes).toEqual(BYTES);
    expect(hits).toEqual(["site/wiki/download/attachments/1/media.png", "media/file/abc/binary"]);
  });

  test("the media hop carries no session credential", async () => {
    await new ConfluenceClient(sessionProfile()).downloadAttachment({
      downloadUrl: "/download/attachments/1/media.png",
    });

    expect(mediaHeaders).toHaveLength(1);
    expect(mediaHeaders[0]!.get("cookie")).toBeNull();
    expect(mediaHeaders[0]!.get("authorization")).toBeNull();

    expect(inits).toHaveLength(2);
    expect(inits[0]!.init?.credentials).toBe("include");
    expect(inits[1]!.url.startsWith(MEDIA_PREFIX)).toBe(true);
    expect(inits[1]!.init?.credentials).toBe("omit");
  });

  test("a same-origin hop is followed and keeps the session credential", async () => {
    const bytes = await new ConfluenceClient(sessionProfile()).downloadAttachment({
      downloadUrl: "/download/attachments/1/moved.png",
    });

    expect(bytes).toEqual(BYTES);
    expect(inits[1]!.init?.credentials).toBe("include");
  });

  test("a SAME-ORIGIN login bounce is still the auth error, with unchanged wording", async () => {
    let err: unknown;
    try {
      await new ConfluenceClient(sessionProfile()).downloadAttachment({
        downloadUrl: "/download/attachments/1/expired.png",
      });
    } catch (caught) {
      err = caught;
    }

    // Byte-compatible with the JSON path's message: the extension detects
    // session expiry by matching this text.
    expect((err as Error).message).toBe(
      "Confluence API error (302): authentication redirect to Atlassian login (session not logged in)"
    );
    // Never followed: no HTML login form could reach the export as image data.
    expect(hits).toEqual(["site/wiki/download/attachments/1/expired.png"]);
  });

  test("a redirect to a non-allowlisted third party is refused before the request", async () => {
    let err: unknown;
    try {
      await new ConfluenceClient(sessionProfile()).downloadAttachment({
        downloadUrl: "/download/attachments/1/evil.png",
      });
    } catch (caught) {
      err = caught;
    }

    expect((err as Error).name).toBe("SessionRedirectBlockedError");
    expect((err as Error).message).toMatch(/non-allowlisted origin/);
    expect(hits).toEqual(["site/wiki/download/attachments/1/evil.png"]);
    expect((err as Error).message).not.toMatch(
      /non-json|login page|authentication redirect|opaqueredirect/i
    );
  });

  test("the redirect chain is bounded", async () => {
    let err: unknown;
    try {
      await new ConfluenceClient(sessionProfile()).downloadAttachment({
        downloadUrl: "/loop/0",
      });
    } catch (caught) {
      err = caught;
    }

    expect((err as Error).message).toMatch(/more than 5 redirects/);
    expect(hits).toHaveLength(6);
  });

  test("regression: JSON API calls keep the strict no-redirect rule, media CDN included", async () => {
    let err: unknown;
    try {
      await new ConfluenceClient(sessionProfile()).getPage("MEDIA-1");
    } catch (caught) {
      err = caught;
    }

    expect((err as Error).message).toMatch(/authentication redirect to Atlassian login/);
    expect(hits).toEqual(["site/wiki/rest/api/content/MEDIA-1"]);
  });

  test("regression: token auth still follows redirects itself, with no manual handling", async () => {
    const bytes = await new ConfluenceClient(tokenProfile()).downloadAttachment({
      downloadUrl: "/download/attachments/1/moved.png",
    });

    expect(bytes).toEqual(BYTES);
    expect(inits).toHaveLength(1);
    expect(inits[0]!.init?.redirect).toBeUndefined();
    expect(inits[0]!.init?.credentials).toBeUndefined();
  });
});

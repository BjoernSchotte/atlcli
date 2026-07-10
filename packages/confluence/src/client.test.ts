import { describe, test, expect, mock, afterEach } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

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

describe("ConfluenceClient", () => {
  // Restore fetch after each test to prevent leaking into other test files
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("rate limiting", () => {

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
    });

    test("retries on 429 with exponential backoff when no Retry-After", async () => {
      let callCount = 0;
      const timestamps: number[] = [];

      globalThis.fetch = mock((url: string) => {
        timestamps.push(Date.now());
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

      // Verify exponential backoff (delays should increase)
      if (timestamps.length >= 3) {
        const delay1 = timestamps[1] - timestamps[0];
        const delay2 = timestamps[2] - timestamps[1];
        // Second delay should be roughly 2x the first (with some tolerance)
        expect(delay2).toBeGreaterThan(delay1 * 1.5);
      }
    });

    test("throws after max retries on persistent 429", async () => {
      globalThis.fetch = mock(() => {
        return Promise.resolve(
          new Response("Rate limited", { status: 429 })
        );
      }) as unknown as typeof fetch;

      const client = new ConfluenceClient(mockProfile);

      await expect(client.getPage("123")).rejects.toThrow(
        /rate limited/i
      );
    }, 15000); // Longer timeout for exponential backoff retries

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
});

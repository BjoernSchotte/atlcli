import { describe, test, expect, mock, afterEach } from "bun:test";
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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

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
      }) as typeof fetch;

      const client = new ConfluenceClient(mockProfile);
      await client.restorePageVersion("123", 2);

      expect(capturedBody.version.message).toContain("Restored to version 2");
    });
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import {
  Logger,
  type LogEntry,
  type LogSink,
  type Profile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  type ConfluenceTransportEvent,
} from "./client.js";

const profile: Profile = {
  name: "research-test",
  baseUrl: "https://example.atlassian.net",
  auth: { type: "session" },
};

class CaptureSink implements LogSink {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

const originalFetch = globalThis.fetch;

describe("Confluence research read boundary", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Logger.configure({ level: "info" });
  });

  it("keeps search content out of logs and follows only a same-site REST cursor", async () => {
    const sentinel = "PRIVATE-WIKI-CONTENT-must-not-be-logged";
    const sink = new CaptureSink();
    const events: ConfluenceTransportEvent[] = [];
    const urls: string[] = [];
    Logger.configure({ level: "debug", sink });
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      const secondPage = String(url).includes("cursor=next-1");
      return new Response(
        JSON.stringify({
          results: secondPage
            ? []
            : [
                {
                  id: "1001",
                  title: sentinel,
                  space: { key: "KB" },
                  _links: {
                    base: "https://example.atlassian.net/wiki",
                    webui: "/spaces/KB/pages/1001",
                  },
                },
              ],
          _links: secondPage
            ? {}
            : {
                next:
                  "/wiki/rest/api/content/search?cursor=next-1&limit=1",
              },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }) as unknown as typeof fetch;

    const client = new ConfluenceClient(profile, {
      observeTransport: (event) => events.push(event),
    });
    const first = await client.search('space = "KB"', {
      limit: 1,
      detail: "minimal",
    });
    const second = await client.searchNextPage(first.nextLink!);

    expect(first.results[0]?.title).toBe(sentinel);
    expect(second.results).toEqual([]);
    expect(urls[1]).toContain("/wiki/rest/api/content/search?cursor=next-1");
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
    expect(JSON.stringify(sink.entries)).toContain("byteLength");
    expect(events.filter((event) => event.type === "attempt")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("KB");
  });

  it("normalizes a product-relative REST cursor under the configured wiki base", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          results: [],
          _links: {},
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }) as unknown as typeof fetch;
    const client = new ConfluenceClient(profile);

    await client.searchNextPage(
      "/rest/api/content/search?cursor=next-product-relative&limit=1"
    );

    expect(urls).toEqual([
      "https://example.atlassian.net/wiki/rest/api/content/search?cursor=next-product-relative&limit=1",
    ]);
  });

  it("rejects a foreign or non-REST pagination URL before fetching", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ConfluenceClient(profile);

    await expect(
      client.searchNextPage(
        "https://foreign.atlassian.net/wiki/rest/api/content/search?cursor=secret"
      )
    ).rejects.toThrow("outside");
    await expect(
      client.searchNextPage("https://example.atlassian.net/wiki/plugins/servlet")
    ).rejects.toThrow("outside");
    expect(calls).toBe(0);
  });
});

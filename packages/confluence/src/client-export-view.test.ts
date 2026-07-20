/**
 * spec 004 T1.10: the export_view / macro-body REST methods must never persist
 * full page/macro CONTENT to the logs (only metadata), and must return the
 * server-rendered HTML. Uses the repo's transport-boundary test pattern
 * (`globalThis.fetch` stub) plus a capturing LogSink — no API-semantics mock.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Logger, type LogEntry, type LogSink, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const profile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "t@example.com", token: "secret-token" },
};

class CaptureSink implements LogSink {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  dump(): string {
    return JSON.stringify(this.entries);
  }
}

const originalFetch = globalThis.fetch;

describe("export_view REST logging policy", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Logger.configure({ level: "info" });
  });

  test("convertToExportView returns HTML but never logs the response body", async () => {
    const SENTINEL = "SENSITIVE-CONTENT-a1b2c3-do-not-log";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ value: `<p>${SENTINEL}</p>`, representation: "export_view" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const client = new ConfluenceClient(profile);
    const html = await client.convertToExportView(`<p>${SENTINEL}</p>`);

    // The method returns the rendered HTML...
    expect(html).toContain(SENTINEL);
    // ...but the sentinel never lands in any log entry (request or response body).
    expect(sink.dump()).not.toContain(SENTINEL);
    // and a response entry WAS recorded (meta-only), proving logging ran.
    expect(sink.entries.some((e) => JSON.stringify(e).includes("byteLength"))).toBe(true);
  });

  test("getExportViewMacros maps data-macro-id → inner HTML from one request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          body: {
            export_view: {
              value: `<div data-macro-id="m1"><p>One</p></div><div data-macro-id="m2"><p>Two</p></div>`,
            },
          },
          version: { number: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const client = new ConfluenceClient(profile);
    const map = await client.getExportViewMacros("123");
    expect(calls).toBe(1);
    expect(map.get("m1")).toContain("One");
    expect(map.get("m2")).toContain("Two");
  });
});

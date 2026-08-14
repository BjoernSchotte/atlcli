import { afterEach, describe, expect, test } from "bun:test";
import { Logger, type LogEntry, type LogSink, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const profile: Profile = {
  name: "hierarchy-log-test",
  baseUrl: "https://test.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "test@example.invalid", token: "secret-token" },
};

class CaptureSink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void { this.entries.push(entry); }
}

const originalFetch = globalThis.fetch;
const originalSink = Logger.getSink();

afterEach(() => {
  globalThis.fetch = originalFetch;
  Logger.setSink(originalSink);
  Logger.reset();
});

describe("Confluence hierarchy logging", () => {
  test.each([
    ["direct children", (client: ConfluenceClient) => client.getPageDirectChildren("2819653636")],
    ["descendants", (client: ConfluenceClient) => client.getPageDescendants("2819653636")],
    ["folder children", (client: ConfluenceClient) => client.getFolderChildren("folder-1")],
    ["page children", (client: ConfluenceClient) => client.getChildrenWithPosition("2819653636")],
    ["page version", (client: ConfluenceClient) => client.getPageVersion("2819653636")],
    ["space homepage", (client: ConfluenceClient) => client.getSpaceHomepageId("DOCSY")],
  ])("%s records metadata but never source response content", async (_name, call) => {
    const sentinel = "CONFIDENTIAL-HIERARCHY-TITLE-DO-NOT-LOG";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/pages/2819653636?") && !url.includes("/direct-children")) {
        return new Response(JSON.stringify({
          id: "2819653636",
          title: sentinel,
          version: { number: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v2/spaces?")) {
        return new Response(JSON.stringify({
          results: [{
            id: "space-1",
            key: "DOCSY",
            name: sentinel,
            homepageId: "2819653636",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/rest/api/space/")) {
        return new Response(JSON.stringify({ homepage: { id: "2819653636", title: sentinel } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        results: [{
          id: "2819653637",
          title: sentinel,
          type: "page",
          version: { number: 1 },
          extensions: { position: 1 },
          ancestors: [],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await call(new ConfluenceClient(profile));

    const dump = JSON.stringify(sink.entries);
    expect(dump).not.toContain(sentinel);
    expect(dump).toContain("byteLength");
    expect(sink.entries.some((entry) => entry.type === "api.response")).toBe(true);
  });

  test.each([
    ["direct children", (client: ConfluenceClient) => client.getPageDirectChildren("2819653636")],
    ["page children", (client: ConfluenceClient) => client.getChildrenWithPosition("2819653636")],
    ["page version", (client: ConfluenceClient) => client.getPageVersion("2819653636")],
  ])("%s failures expose only status/request correlation", async (_name, call) => {
    const sentinel = "CONFIDENTIAL-HIERARCHY-ERROR-DO-NOT-LOG";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: sentinel }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const failure = await call(new ConfluenceClient(profile)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status: 404, requestId: expect.any(String) });
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
    expect(String(failure)).not.toContain(sentinel);
  });
});

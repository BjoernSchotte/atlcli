import { afterEach, describe, expect, it } from "bun:test";
import {
  Logger,
  type LogEntry,
  type LogSink,
  type Profile,
} from "@atlcli/core";
import { JiraClient, type JiraTransportEvent } from "./client.js";

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

describe("Jira research read boundary", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Logger.configure({ level: "info" });
  });

  it("keeps issue content out of logs while reporting content-free transport metrics", async () => {
    const sentinel = "PRIVATE-ISSUE-CONTENT-must-not-be-logged";
    const sink = new CaptureSink();
    const events: JiraTransportEvent[] = [];
    Logger.configure({ level: "debug", sink });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [
            {
              id: "1",
              key: "DEMO-1",
              fields: {
                summary: sentinel,
                project: { id: "1", key: "DEMO" },
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )) as unknown as typeof fetch;

    const result = await new JiraClient(profile, {
      observeTransport: (event) => events.push(event),
    }).search('project = "DEMO"', { fields: ["summary", "project"] });

    expect(result.issues[0]?.fields.summary).toBe(sentinel);
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
    expect(JSON.stringify(sink.entries)).toContain("byteLength");
    expect(events).toEqual([
      { type: "attempt", method: "POST", attempt: 0 },
      expect.objectContaining({
        type: "response",
        method: "POST",
        attempt: 0,
        status: 200,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("DEMO");
  });

  it("omits a confidential error body from both logs and the thrown error", async () => {
    const sentinel = "PRIVATE-JIRA-ERROR-must-not-escape";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errorMessages: [sentinel] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    let message = "";
    try {
      await new JiraClient(profile).getIssue("DEMO-1");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("response body omitted");
    expect(message).not.toContain(sentinel);
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
  });

  it("lets a synchronous run budget stop an HTTP attempt before fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new JiraClient(profile, {
      guardTransport: (event) => {
        if (event.type === "attempt") throw new Error("HTTP budget exhausted");
      },
    });

    await expect(client.getIssue("DEMO-1")).rejects.toThrow(
      "HTTP budget exhausted"
    );
    expect(calls).toBe(0);
  });
});

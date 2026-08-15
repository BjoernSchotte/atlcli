import { afterEach, describe, expect, test } from "bun:test";
import {
  Logger,
  type LogEntry,
  type LogSink,
  type Profile,
} from "@atlcli/core";
import { ConfluenceClient } from "./client.js";
import {
  buildPageDiffChangeSetV1,
  readPageDiffPair,
  selectPageDiffPair,
  type PageDiffSourceV1,
} from "./page-diff-source.js";

const originalFetch = globalThis.fetch;
const originalSink = Logger.getSink();

function cloudProfile(origin: string): Profile {
  return {
    name: "diff-cloud",
    baseUrl: origin,
    deploymentType: "cloud",
    auth: {
      type: "apiToken",
      email: "fixture@example.invalid",
      token: "fixture-token",
    },
  };
}

function dcProfile(origin: string): Profile {
  return {
    name: "diff-dc",
    baseUrl: origin,
    deploymentType: "data-center",
    auth: { type: "bearer", pat: "fixture-pat" },
  };
}

function historicalStorage(
  version: number,
  value = `<p>Storage ${version}</p>`,
  id = "123",
): Response {
  return new Response(JSON.stringify({
    number: version,
    content: {
      id,
      title: "Synthetic page",
      version: { number: version },
      space: { key: "TEST" },
      ancestors: [],
      body: { storage: { representation: "storage", value } },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function historicalAdf(
  version: number,
  value = `{"version":1,"type":"doc","content":[]}`,
  id = "123",
): Response {
  return new Response(JSON.stringify({
    id,
    title: "Synthetic page",
    version: { number: version },
    body: {
      atlas_doc_format: {
        representation: "atlas_doc_format",
        value,
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Logger.setSink(originalSink);
  Logger.reset();
});

describe("version-bound page diff acquisition", () => {
  test("requests exact Cloud ADF and v1 Storage versions", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.includes("/api/v2/pages/")) {
        return historicalAdf(Number(parsed.searchParams.get("version")));
      }
      return historicalStorage(7);
    }) as typeof fetch;

    const source = await new ConfluenceClient(
      cloudProfile("https://diff-source.example.invalid"),
    ).getPageDiffSource("123", 7);

    expect(source).toEqual({
      id: "123",
      title: "Synthetic page",
      version: 7,
      deployment: "cloud",
      body: {
        representation: "atlas_doc_format",
        value: `{"version":1,"type":"doc","content":[]}`,
      },
      storageSidecar: "<p>Storage 7</p>",
    });
    expect(calls).toHaveLength(2);
    const v2 = new URL(calls.find((url) => url.includes("/api/v2/"))!);
    expect(v2.pathname).toBe("/wiki/api/v2/pages/123");
    expect(v2.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(v2.searchParams.get("version")).toBe("7");
    const v1 = new URL(calls.find((url) => url.includes("/rest/api/"))!);
    expect(v1.pathname).toBe("/wiki/rest/api/content/123/version/7");
    expect(v1.searchParams.get("expand")).toContain("content.body.storage");
  });

  test("uses exact Storage only when versioned ADF is unavailable", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/")) {
        return new Response(JSON.stringify({
          message: "Invalid body-format atlas_doc_format: unsupported value",
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return historicalStorage(4, "<p>Fallback</p>");
    }) as typeof fetch;

    const source = await new ConfluenceClient(
      cloudProfile("https://diff-fallback.example.invalid"),
    ).getPageDiffSource("123", 4);

    expect(source.body).toEqual({
      representation: "storage",
      value: "<p>Fallback</p>",
    });
    expect(source.fallbackReason).toBe("adf-version-unavailable");
  });

  test("treats an omitted exact-version ADF member as unavailable", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/")) {
        return new Response(JSON.stringify({
          id: "123",
          version: { number: 4 },
          body: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return historicalStorage(4, "<p>Fallback</p>");
    }) as typeof fetch;

    const source = await new ConfluenceClient(
      cloudProfile("https://diff-omitted.example.invalid"),
    ).getPageDiffSource("123", 4);
    expect(source.body.representation).toBe("storage");
    expect(source.fallbackReason).toBe("adf-version-unavailable");
  });

  test("does not disguise a malformed ADF response as representation fallback", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/")) {
        return new Response(JSON.stringify({
          id: "123",
          version: { number: 4 },
          body: "malformed",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return historicalStorage(4, "<p>Must not become fallback</p>");
    }) as typeof fetch;

    await expect(new ConfluenceClient(
      cloudProfile("https://diff-malformed.example.invalid"),
    ).getPageDiffSource("123", 4)).rejects.toMatchObject({
      kind: "invalid-adf-response",
    });
  });

  test("fails closed on ADF version mismatch and authorization errors", async () => {
    let mode: "mismatch" | "denied" = "mismatch";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("/api/v2/")) return historicalStorage(5);
      if (mode === "denied") {
        return new Response(JSON.stringify({ message: "denied" }), { status: 403 });
      }
      return historicalAdf(6);
    }) as typeof fetch;
    const client = new ConfluenceClient(
      cloudProfile("https://diff-fail-closed.example.invalid"),
    );

    await expect(client.getPageDiffSource("123", 5)).rejects.toMatchObject({
      kind: "page-version-mismatch",
    });
    mode = "denied";
    const denied = await client.getPageDiffSource("123", 5).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(Error);
    expect(denied).not.toMatchObject({ kind: "adf-representation-unavailable" });
  });

  test("routes Data Center through context-path v1 Storage only", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: String(input), authorization: headers?.Authorization });
      return historicalStorage(3, "<p>DC</p>");
    }) as typeof fetch;

    const source = await new ConfluenceClient(
      dcProfile("https://dc.example.invalid/confluence"),
    ).getPageDiffSource("123", 3);

    expect(calls).toEqual([{
      url: expect.stringContaining("/confluence/rest/api/content/123/version/3"),
      authorization: "Bearer fixture-pat",
    }]);
    expect(calls[0]!.url).not.toContain("/api/v2/");
    expect(source).toMatchObject({
      deployment: "data-center",
      body: { representation: "storage", value: "<p>DC</p>" },
      fallbackReason: "data-center",
    });
  });

  test("keeps all exact body values out of API logs", async () => {
    class CaptureSink implements LogSink {
      readonly entries: LogEntry[] = [];
      write(entry: LogEntry): void { this.entries.push(entry); }
    }
    const sentinel = "PRIVATE-DIFF-BODY-7f42";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    globalThis.fetch = (async (input: string | URL | Request) =>
      String(input).includes("/api/v2/")
        ? historicalAdf(8, `{"version":1,"type":"doc","content":[{"type":"text","text":"${sentinel}"}]}`)
        : historicalStorage(8, `<p>${sentinel}</p>`)) as typeof fetch;

    await new ConfluenceClient(
      cloudProfile("https://diff-logging.example.invalid"),
    ).getPageDiffSource("123", 8);

    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
    expect(sink.entries.filter((entry) => entry.type === "api.response"))
      .toHaveLength(2);
  });

  test("normalizes a mixed Cloud pair to exact Storage on both sides", () => {
    const from: PageDiffSourceV1 = {
      id: "123",
      title: "Synthetic page",
      version: 2,
      deployment: "cloud",
      body: { representation: "atlas_doc_format", value: "adf-2" },
      storageSidecar: "storage-2",
    };
    const to: PageDiffSourceV1 = {
      id: "123",
      title: "Synthetic page",
      version: 5,
      deployment: "cloud",
      body: { representation: "storage", value: "storage-5" },
      fallbackReason: "adf-version-unavailable",
    };

    const pair = selectPageDiffPair(from, to);
    expect(pair.representation).toBe("storage");
    expect(pair.from.body).toEqual({ representation: "storage", value: "storage-2" });
    expect(pair.to.body).toEqual({ representation: "storage", value: "storage-5" });
    expect(pair.from.fallbackReason).toBe("adf-version-unavailable");
    expect(pair.to.fallbackReason).toBe("adf-version-unavailable");
  });

  test("readPageDiffPair retains ADF only when both versions provide it", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const pathVersion = Number(url.pathname.split("/").at(-1));
      const version = url.pathname.includes("/api/v2/")
        ? Number(url.searchParams.get("version"))
        : pathVersion;
      return url.pathname.includes("/api/v2/")
        ? historicalAdf(version)
        : historicalStorage(version);
    }) as typeof fetch;

    const pair = await readPageDiffPair(
      new ConfluenceClient(cloudProfile("https://diff-pair.example.invalid")),
      "123",
      7,
      3,
    );
    expect(pair.representation).toBe("atlas_doc_format");
    expect(pair.from.version).toBe(7);
    expect(pair.to.version).toBe(3);
  });

  test("rejects invalid versions before issuing a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return historicalStorage(1);
    }) as unknown as typeof fetch;

    await expect(new ConfluenceClient(
      cloudProfile("https://diff-invalid-version.example.invalid"),
    ).getPageDiffSource("123", 0)).rejects.toMatchObject({
      kind: "invalid-page-version",
    });
    expect(calls).toBe(0);
  });

  test("builds the same portable ChangeSet from an exact ADF pair", async () => {
    const before: PageDiffSourceV1 = {
      id: "123",
      title: "Synthetic page",
      version: 2,
      deployment: "cloud",
      body: {
        representation: "atlas_doc_format",
        value: JSON.stringify({
          version: 1,
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }],
        }),
      },
      storageSidecar: "<p>Before</p>",
    };
    const after: PageDiffSourceV1 = {
      ...before,
      version: 3,
      body: {
        representation: "atlas_doc_format",
        value: JSON.stringify({
          version: 1,
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "After" }] }],
        }),
      },
      storageSidecar: "<p>After</p>",
    };

    const result = await buildPageDiffChangeSetV1(
      selectPageDiffPair(before, after),
    );

    expect(result.changeSet).toMatchObject({
      schema: "atlcli.change-set/1",
      baseline: { revision: "2", representation: "atlas_doc_format", acquisition: "rest-v2" },
      target: { revision: "3", representation: "atlas_doc_format", acquisition: "rest-v2" },
      summary: { noOp: false },
      completeness: { status: "complete" },
    });
    expect(result.changeSet.operations.length).toBeGreaterThan(0);
  });

  test("makes the common-Storage Cloud fallback visible", async () => {
    const source = (version: number, value: string): PageDiffSourceV1 => ({
      id: "123",
      title: "Synthetic page",
      version,
      deployment: "cloud",
      body: { representation: "storage", value },
      fallbackReason: "adf-version-unavailable",
    });
    const result = await buildPageDiffChangeSetV1({
      from: source(2, "<p>Before</p>"),
      to: source(3, "<p>After</p>"),
      representation: "storage",
    });

    expect(result.changeSet.baseline).toMatchObject({
      representation: "storage",
      deployment: "cloud",
      acquisition: "rest-v1",
    });
    expect(result.changeSet.completeness.diagnostics).toContainEqual({
      code: "source-fallback",
      severity: "warning",
      message: "Historical Cloud ADF was unavailable; both versions use exact Storage.",
      path: [],
    });
  });
});

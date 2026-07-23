import { afterEach, describe, expect, test } from "bun:test";
import {
  Logger,
  type LogEntry,
  type LogSink,
  type Profile,
} from "@atlcli/core";
import { ConfluenceClient } from "./client.js";
import { ExportPageReadError } from "./page-body.js";

const originalFetch = globalThis.fetch;
const originalSink = Logger.getSink();

function cloudProfile(origin: string): Profile {
  return {
    name: "synthetic-cloud",
    baseUrl: origin,
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "fixture@example.invalid", token: "fixture-token" },
  };
}

function storageResponse(id = "123", version = 7, storage = "<p>Storage</p>"): Response {
  return new Response(
    JSON.stringify({
      id,
      title: "Synthetic page",
      version: { number: version },
      space: { key: "TEST" },
      ancestors: [],
      body: { storage: { value: storage } },
      metadata: { labels: { results: [] }, properties: { editor: { value: "v2" } } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function adfResponse(
  id = "123",
  version = 7,
  value = '{"version":1,"type":"doc","content":[]}',
): Response {
  return new Response(
    JSON.stringify({
      id,
      version: { number: version },
      body: {
        atlas_doc_format: { representation: "atlas_doc_format", value },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function routeBodyReads(options: {
  storage?: () => Response | Promise<Response>;
  adf?: () => Response | Promise<Response>;
  calls?: string[];
}): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    options.calls?.push(url);
    if (url.includes("/rest/api/content/")) {
      return (await options.storage?.()) ?? storageResponse();
    }
    if (url.includes("/api/v2/pages/")) {
      return (await options.adf?.()) ?? adfResponse();
    }
    throw new Error(`Unexpected synthetic request: ${url}`);
  }) as typeof fetch;
}

class CaptureSink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Logger.setSink(originalSink);
  Logger.reset();
});

describe("ConfluenceClient ADF page reads", () => {
  test("uses the Cloud v2 page path and preserves ADF as an opaque string", async () => {
    const calls: string[] = [];
    const opaque = "this is deliberately not parsed as JSON here";
    routeBodyReads({ calls, adf: () => adfResponse("123", 11, opaque) });

    const result = await new ConfluenceClient(
      cloudProfile("https://adf-path.example.invalid"),
    ).getPageAdf("123");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/wiki/api/v2/pages/123");
    expect(url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(result).toEqual({
      id: "123",
      version: 11,
      body: { representation: "atlas_doc_format", value: opaque },
    });
  });

  for (const fixture of [
    { name: "non-object root", body: [] },
    { name: "different page id", body: { id: "other", version: { number: 7 }, body: { atlas_doc_format: { representation: "atlas_doc_format", value: "{}" } } } },
    { name: "missing version", body: { id: "123", body: { atlas_doc_format: { representation: "atlas_doc_format", value: "{}" } } } },
    { name: "missing ADF member", body: { id: "123", version: { number: 7 }, body: {} } },
    { name: "wrong representation", body: { id: "123", version: { number: 7 }, body: { atlas_doc_format: { representation: "storage", value: "{}" } } } },
    { name: "non-string value", body: { id: "123", version: { number: 7 }, body: { atlas_doc_format: { representation: "atlas_doc_format", value: {} } } } },
  ] satisfies ReadonlyArray<{ name: string; body: unknown }>) {
    test(`rejects ${fixture.name} without trusting it as ADF`, async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(fixture.body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;

      await expect(
        new ConfluenceClient(cloudProfile(`https://${fixture.name.replaceAll(" ", "-")}.example.invalid`))
          .getPageAdf("123"),
      ).rejects.toMatchObject({ kind: "invalid-adf-response" });
    });
  }

  test("starts Cloud Storage and ADF reads concurrently and binds matching versions", async () => {
    const calls: string[] = [];
    let releaseStorage!: (response: Response) => void;
    let releaseAdf!: (response: Response) => void;
    const storage = new Promise<Response>((resolve) => { releaseStorage = resolve; });
    const adf = new Promise<Response>((resolve) => { releaseAdf = resolve; });
    routeBodyReads({ calls, storage: () => storage, adf: () => adf });

    const pending = new ConfluenceClient(
      cloudProfile("https://dual-read.example.invalid"),
    ).getExportPageDetails("123");
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    releaseStorage(storageResponse("123", 9, "<p>Sidecar</p>"));
    releaseAdf(adfResponse("123", 9, "opaque-adf"));
    const result = await pending;

    expect(result.storage).toBe("<p>Sidecar</p>");
    expect(result.exportSource).toEqual({
      primary: { representation: "atlas_doc_format", value: "opaque-adf" },
      storageSidecar: "<p>Sidecar</p>",
      sourceVersion: 9,
    });
  });

  test("prefetches exact v2 fileId metadata only when ADF contains media", async () => {
    const calls: string[] = [];
    const adf = JSON.stringify({
      type: "doc",
      version: 1,
      content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { id: "file-a", type: "file" } }] }],
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/attachments")) {
        const cursor = new URL(url).searchParams.get("cursor");
        return new Response(JSON.stringify(cursor
          ? {
              results: [
                {
                  id: "content-a-new-version",
                  fileId: "file-a",
                  title: "a.png",
                  mediaType: "image/png",
                  webuiLink: "/wiki/attachments/a",
                  downloadLink: "/download/a",
                },
                {
                  id: "content-b",
                  fileId: "file-b",
                  title: "b.pdf",
                  mediaType: "application/pdf",
                  _links: {
                    webui: "/wiki/attachments/b",
                    download: "/download/b",
                  },
                },
              ],
              _links: {},
            }
          : {
              results: [{
                id: "content-a",
                fileId: "file-a",
                title: "a.png",
                mediaType: "image/png",
                webuiLink: "/wiki/attachments/a",
                downloadLink: "/download/a",
              }],
              _links: { next: "/wiki/api/v2/pages/123/attachments?cursor=next" },
            }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/rest/api/content/")) return storageResponse();
      return adfResponse("123", 7, adf);
    }) as typeof fetch;

    const result = await new ConfluenceClient(
      cloudProfile("https://media-index.example.invalid"),
    ).getExportPageDetailsWithMedia("123");

    expect(result.mediaAttachmentsComplete).toBe(true);
    expect(result.mediaAttachments).toEqual([
      {
        fileId: "file-a",
        filename: "a.png",
        pageId: "123",
        mediaType: "image/png",
        webuiLink: "/wiki/attachments/a",
        downloadLink: "/download/a",
      },
      {
        fileId: "file-b",
        filename: "b.pdf",
        pageId: "123",
        mediaType: "application/pdf",
        webuiLink: "/wiki/attachments/b",
        downloadLink: "/download/b",
      },
    ]);
    expect(calls.filter((url) => url.includes("/attachments"))).toHaveLength(2);
  });

  test("does not add an attachment request to an ADF page without media", async () => {
    const calls: string[] = [];
    routeBodyReads({ calls });

    const result = await new ConfluenceClient(
      cloudProfile("https://media-free.example.invalid"),
    ).getExportPageDetailsWithMedia("123");

    expect(result.mediaAttachments).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.includes("/attachments"))).toBe(false);
  });

  test("prefetches and correlates privacy-safe inline-comment sidecars only for annotated ADF", async () => {
    const sink = new CaptureSink();
    const sentinel = "PRIVATE COMMENT BODY";
    const calls: string[] = [];
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    const adf = JSON.stringify({
      type: "doc",
      version: 1,
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "annotated",
          marks: [{
            type: "annotation",
            attrs: { id: "marker-1", annotationType: "inlineComment" },
          }],
        }],
      }],
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/rest/api/content/")) return storageResponse();
      if (url.includes("/inline-comments/root-1/children")) {
        return new Response(JSON.stringify({
          results: [{
            id: "reply-1",
            body: { storage: { value: "<p>Reply body</p>" } },
            version: { createdAt: "2026-01-02T00:00:00.000Z", authorId: "account-2" },
            resolutionStatus: "open",
            parentCommentId: "root-1",
          }],
          _links: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/pages/123/inline-comments")) {
        return new Response(JSON.stringify({
          results: [{
            id: "root-1",
            body: { storage: { value: `<p>${sentinel}</p>` } },
            version: { createdAt: "2026-01-01T00:00:00.000Z", authorId: "account-1" },
            resolutionStatus: "resolved",
            properties: {
              inlineMarkerRef: "marker-1",
              inlineOriginalSelection: "annotated",
            },
          }],
          _links: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return adfResponse("123", 7, adf);
    }) as typeof fetch;

    const result = await new ConfluenceClient(
      cloudProfile("https://comment-sidecar.example.invalid"),
    ).getExportPageDetailsWithMedia("123");

    expect(result.inlineCommentsComplete).toBe(true);
    expect(result.inlineComments).toEqual([
      expect.objectContaining({
        id: "root-1",
        body: `<p>${sentinel}</p>`,
        status: "resolved",
        inlineMarkerRef: "marker-1",
        inlineOriginalSelection: "annotated",
        replies: [expect.objectContaining({ id: "reply-1", body: "<p>Reply body</p>" })],
      }),
    ]);
    expect(calls.some((url) => url.includes("/attachments"))).toBe(false);
    expect(calls.filter((url) => url.includes("/inline-comments"))).toHaveLength(2);
    expect(calls.filter((url) => url.includes("/inline-comments")).every((url) =>
      new URL(url).searchParams.get("body-format") === "storage"
    )).toBe(true);
    const rootCommentUrl = new URL(
      calls.find((url) => url.includes("/pages/123/inline-comments"))!,
    );
    expect(rootCommentUrl.searchParams.getAll("status")).toEqual(["current"]);
    expect(rootCommentUrl.searchParams.getAll("resolution-status")).toEqual([
      "open",
      "resolved",
    ]);
    const replyUrl = new URL(
      calls.find((url) => url.includes("/inline-comments/root-1/children"))!,
    );
    expect(replyUrl.searchParams.has("status")).toBe(false);
    expect(replyUrl.searchParams.has("resolution-status")).toBe(false);
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
    expect(JSON.stringify(sink.entries)).not.toContain("Reply body");
  });

  test("marks the inline-comment sidecar incomplete at its item budget", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      results: [{
        id: "root-1",
        body: { storage: { value: "<p>One</p>" } },
        properties: { inlineMarkerRef: "marker-1" },
      }],
      _links: { next: "/wiki/api/v2/pages/123/inline-comments?cursor=more" },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await new ConfluenceClient(
      cloudProfile("https://comment-budget.example.invalid"),
    ).listPageInlineCommentsForExport("123", { maxInlineComments: 1 });

    expect(result.comments).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  test("bounds attachment metadata and marks a truncated index incomplete", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      results: [
        { fileId: "file-a", title: "a.png" },
        { fileId: "file-b", title: "b.png" },
      ],
      _links: { next: "/wiki/api/v2/pages/123/attachments?cursor=more" },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await new ConfluenceClient(
      cloudProfile("https://media-budget.example.invalid"),
    ).listPageAttachmentMedia("123", { maxAttachments: 1 });

    expect(result).toEqual({
      attachments: [{ fileId: "file-a", filename: "a.png", pageId: "123" }],
      complete: false,
    });
  });

  test("keeps attachment filenames out of v2 metadata logs", async () => {
    const sink = new CaptureSink();
    const sentinel = "PRIVATE-MEDIA-FILENAME.png";
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      results: [{ fileId: "file-a", title: sentinel }],
      _links: {},
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await new ConfluenceClient(
      cloudProfile("https://media-logging.example.invalid"),
    ).listPageAttachmentMedia("123");

    expect(result.attachments[0]?.filename).toBe(sentinel);
    expect(JSON.stringify(sink.entries)).not.toContain(sentinel);
  });

  test("fails visibly when the ADF and Storage versions differ", async () => {
    routeBodyReads({
      storage: () => storageResponse("123", 8),
      adf: () => adfResponse("123", 9),
    });

    const error = await new ConfluenceClient(
      cloudProfile("https://version-race.example.invalid"),
    ).getExportPageDetails("123").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExportPageReadError);
    expect(error).toMatchObject({
      kind: "page-version-mismatch",
      storageVersion: 8,
      adfVersion: 9,
    });
  });

  test("cancels the sibling Storage read after a terminal ADF failure", async () => {
    let storageAborted = false;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rest/api/content/")) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = (): void => {
            storageAborted = true;
            reject(signal?.reason ?? new Error("aborted"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ message: "denied" }), { status: 403 }));
    }) as typeof fetch;

    await expect(
      new ConfluenceClient(cloudProfile("https://sibling-cancel.example.invalid"))
        .getExportPageDetails("123"),
    ).rejects.toThrow(/403/);
    expect(storageAborted).toBe(true);
  });

  test("propagates external cancellation to both body reads", async () => {
    const observed: AbortSignal[] = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected a signal");
        observed.push(signal);
        const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })) as unknown as typeof fetch;

    const abort = new AbortController();
    const pending = new ConfluenceClient(
      cloudProfile("https://external-cancel.example.invalid"),
    ).getExportPageDetails("123", { signal: abort.signal });
    await Promise.resolve();
    expect(observed).toHaveLength(2);
    abort.abort(new Error("synthetic stop"));

    await expect(pending).rejects.toThrow("synthetic stop");
    expect(observed.every((signal) => signal.aborted)).toBe(true);
  });

  for (const status of [401, 403, 429, 500]) {
    test(`does not turn HTTP ${status} into a Storage fallback`, async () => {
      routeBodyReads({
        storage: () => storageResponse(),
        adf: () => new Response(JSON.stringify({ message: "synthetic failure" }), {
          status,
          headers: status === 429 ? { "Retry-After": "0" } : undefined,
        }),
      });
      const client = new ConfluenceClient(
        cloudProfile(`https://status-${status}.example.invalid`),
      );
      Reflect.set(client, "maxRetries", 0);

      const error = await client.getExportPageDetails("123").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ kind: "adf-representation-unavailable" });
      expect(String((error as Error).message)).toMatch(
        status === 429 ? /rate limited/i : new RegExp(String(status)),
      );
    });
  }

  test("does not classify a generic 400 response as missing ADF capability", async () => {
    routeBodyReads({
      storage: () => storageResponse(),
      adf: () => new Response(JSON.stringify({ message: "Invalid page id" }), { status: 400 }),
    });

    const error = await new ConfluenceClient(
      cloudProfile("https://generic-400.example.invalid"),
    ).getExportPageDetails("123").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ kind: "adf-representation-unavailable" });
  });

  test("does not turn a session login page into a Storage fallback", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>synthetic login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const profile: Profile = {
      name: "synthetic-session",
      baseUrl: "https://session-login.example.invalid",
      deploymentType: "cloud",
      auth: { type: "session" },
    };

    await expect(new ConfluenceClient(profile).getExportPageDetails("123"))
      .rejects.toThrow(/login|non-JSON/i);
  });

  test("never probes the Cloud v2 route for Data Center", async () => {
    const calls: string[] = [];
    routeBodyReads({ calls, storage: () => storageResponse("123", 4, "<p>DC</p>") });
    const profile: Profile = {
      name: "synthetic-dc",
      baseUrl: "https://dc.example.invalid/confluence",
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "fixture-pat" },
    };

    const result = await new ConfluenceClient(profile).getExportPageDetails("123");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/confluence/rest/api/content/123");
    expect(result.exportSource).toEqual({
      primary: { representation: "storage", value: "<p>DC</p>" },
      sourceVersion: 4,
      fallbackReason: "data-center",
    });
  });

  test("uses the one source-policy rollback switch without probing ADF", async () => {
    const calls: string[] = [];
    routeBodyReads({ calls, storage: () => storageResponse("123", 9, "<p>rollback</p>") });

    const result = await new ConfluenceClient(
      cloudProfile("https://source-policy.example.invalid"),
      { exportSourcePolicy: "storage-primary" },
    ).getExportPageDetails("123");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/rest/api/content/123");
    expect(calls[0]).not.toContain("/api/v2/");
    expect(result.exportSource).toEqual({
      primary: { representation: "storage", value: "<p>rollback</p>" },
      sourceVersion: 9,
      fallbackReason: "rollout-storage-primary",
    });
  });

  test("caches only a proven unavailable capability and isolates it by origin", async () => {
    const calls: string[] = [];
    const firstOrigin = "https://capability-a.example.invalid";
    const secondOrigin = "https://capability-b.example.invalid";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/rest/api/content/")) return storageResponse("123", 7, "<p>fallback</p>");
      if (url.startsWith(`${firstOrigin}/`)) {
        return new Response(
          JSON.stringify({ message: "Invalid body-format atlas_doc_format: unsupported value" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return adfResponse();
    }) as typeof fetch;

    const first = new ConfluenceClient(cloudProfile(firstOrigin));
    const fallback = await first.getExportPageDetails("123");
    expect(fallback.exportSource.fallbackReason).toBe("adf-representation-unavailable");
    await new ConfluenceClient(cloudProfile(firstOrigin)).getExportPageDetails("123");
    const native = await new ConfluenceClient(cloudProfile(secondOrigin)).getExportPageDetails("123");

    expect(native.exportSource.primary.representation).toBe("atlas_doc_format");
    expect(calls.filter((url) => url.startsWith(firstOrigin) && url.includes("/api/v2/")))
      .toHaveLength(1);
    expect(calls.filter((url) => url.startsWith(secondOrigin) && url.includes("/api/v2/")))
      .toHaveLength(1);
  });

  test("does not cache capability absence unless the page identity read succeeds", async () => {
    const origin = "https://capability-auth.example.invalid";
    let round = 0;
    let adfCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v2/")) {
        adfCalls += 1;
        if (round === 0) {
          return new Response(
            JSON.stringify({ message: "Invalid body-format atlas_doc_format: unsupported value" }),
            { status: 400 },
          );
        }
        return adfResponse();
      }
      if (round === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response(JSON.stringify({ message: "denied" }), { status: 403 });
      }
      return storageResponse();
    }) as typeof fetch;

    await expect(new ConfluenceClient(cloudProfile(origin)).getExportPageDetails("123"))
      .rejects.toThrow(/403/);
    round = 1;
    const result = await new ConfluenceClient(cloudProfile(origin)).getExportPageDetails("123");

    expect(result.exportSource.primary.representation).toBe("atlas_doc_format");
    expect(adfCalls).toBe(2);
  });

  test("returns both bodies while keeping their distinctive content out of logs", async () => {
    const sentinel = "PRIVATE-FIXTURE-SENTINEL-92f6d7";
    const sink = new CaptureSink();
    Logger.configure({ level: "debug", sink, enableGlobal: false, enableProject: false });
    routeBodyReads({
      storage: () => storageResponse("123", 7, `<p>${sentinel}</p>`),
      adf: () => adfResponse("123", 7, `{"type":"doc","text":"${sentinel}"}`),
    });

    const result = await new ConfluenceClient(
      cloudProfile("https://body-logging.example.invalid"),
    ).getExportPageDetails("123");

    expect(result.storage).toContain(sentinel);
    expect(result.exportSource.primary.value).toContain(sentinel);
    const logged = JSON.stringify(sink.entries);
    expect(logged).not.toContain(sentinel);
    expect(sink.entries.filter((entry) => entry.type === "api.response"))
      .toHaveLength(2);
    expect(logged).toContain("byteLength");
  });
});

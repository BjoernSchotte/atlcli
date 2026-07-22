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

/**
 * Session macro ports (spec 010 T5.4).
 *
 * NO HTTP MOCKING: every case below drives the REAL `ConfluenceClient` (session
 * profile) and the REAL `resolveMacroBlocks` chain from `@atlcli/export-macros`
 * over hand-constructed REAL `Response` objects — the pattern
 * `tests/read-path.test.ts` established and the PLAN explicitly allows. What is
 * substituted is the transport, never the client, the ports, or the resolver.
 *
 * That is also what makes the "thin adapter" assertions meaningful: the request
 * URLs and `RequestInit`s recorded here are produced by `ConfluenceClient`
 * itself (`/wiki/rest/api/content/…`, `credentials: "include"`,
 * `redirect: "manual"`), so a parallel `fetch()` implementation inside the port
 * would fail these tests rather than pass them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  ConfluenceClient,
  storageToBlocks,
  type StorageToBlocksResult,
} from "@atlcli/confluence/browser";
import { resolveMacroBlocks, type MacroExportContext } from "@atlcli/export-macros";
import {
  buildSessionMacroResolutionOptions,
  classifySessionPortError,
  createSessionMacroState,
  sessionExportViewPort,
  sessionJiraIssuePort,
  SESSION_EXPIRED_MESSAGE,
  type JiraClientLike,
  type JiraIssueLike,
} from "../../utils/macros/session-ports.js";

const SITE = "https://fixture.atlassian.net";
const PAGE_URL = `${SITE}/wiki/spaces/DOCSY/pages/1001/Root`;
const ROOT_ID = "1001";
const CHILD_ID = "2002";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

interface FetchLog {
  urls: string[];
  inits: RequestInit[];
}

function installFetch(handler: (url: string, call: number) => Response): FetchLog {
  const log: FetchLog = { urls: [], inits: [] };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call = log.urls.length;
    log.urls.push(url);
    log.inits.push(init ?? {});
    return Promise.resolve(handler(url, call));
  }) as unknown as typeof fetch;
  return log;
}

/**
 * Collapse the clients' exponential backoff so a 5xx-retry case costs
 * milliseconds instead of the real 1s+2s+4s. The transport stays real; only the
 * clock moves faster.
 */
function installFastTimers(): void {
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void) =>
    realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
}

function exportViewJson(macroId: string, inner: string, version = 3): Response {
  return new Response(
    JSON.stringify({
      id: ROOT_ID,
      body: { export_view: { value: `<div data-macro-id="${macroId}">${inner}</div>` } },
      version: { number: version },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function errorJson(status: number, message = "denied"): Response {
  return new Response(JSON.stringify({ statusCode: status, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STORAGE_ONE = `<ac:structured-macro ac:name="fancy-app" ac:macro-id="m1"/>`;

function walk(storage: string): StorageToBlocksResult {
  return storageToBlocks(storage, { exporter: "pdf" });
}

interface RunOptions {
  storage?: string;
  live?: boolean;
  concurrency?: number;
  sourcePages?: (
    | { id: string; version?: number; spaceKey?: string }
    | undefined
  )[];
  jiraClient?: JiraClientLike;
}

/** Drive the real resolver through the real registry + session ports. */
async function run(opts: RunOptions = {}) {
  const input = walk(opts.storage ?? STORAGE_ONE);
  if (opts.sourcePages) {
    let i = 0;
    for (const block of input.blocks) {
      if (block.type !== "unknown") continue;
      const page = opts.sourcePages[i++];
      if (page) (block as { sourcePage?: unknown }).sourcePage = page;
    }
  }
  const built = buildSessionMacroResolutionOptions({
    pageUrl: PAGE_URL,
    targetEngine: "pdf",
    ...(opts.live !== undefined ? { live: opts.live } : {}),
    ...(opts.jiraClient ? { jiraClient: opts.jiraClient } : {}),
  });
  const rootPage = { id: ROOT_ID, version: 3, spaceKey: "DOCSY" };
  const base: MacroExportContext = {
    ...built.options.contextFor(rootPage),
    budget: { concurrency: opts.concurrency ?? 1 },
  };
  // Exactly the call shape both engines use (`packages/pdf/src/run-export.ts:273`,
  // `packages/docx/src/export.ts:356`) — including the `p ?? rootPage` wrapper.
  const result = await resolveMacroBlocks(input, built.options.registry, base, {
    ...(built.options.live !== undefined ? { live: built.options.live } : {}),
    contextFor: (p) => built.options.contextFor(p ?? rootPage),
    targetEngine: "pdf",
  });
  return { result, built };
}

function codes(notes: { code: string }[]): string[] {
  return notes.map((n) => n.code);
}

function messages(notes: { message: string }[]): string {
  return notes.map((n) => n.message).join("\n");
}

// ---------------------------------------------------------------------------

describe("ExportViewPort is a thin adapter over ConfluenceClient", () => {
  it("renders a macro through the client's own session request", async () => {
    const log = installFetch(() => exportViewJson("m1", "<p>Rendered by the app</p>"));
    const { result } = await run();

    // The URL and RequestInit are ConfluenceClient's, not the port's: the
    // `/wiki` context path, the v1 `/rest/api/content/{id}` shape with the
    // export_view expand, and the session fingerprint.
    expect(log.urls).toHaveLength(1);
    expect(log.urls[0]).toStartWith(`${SITE}/wiki/rest/api/content/${ROOT_ID}?`);
    expect(decodeURIComponent(log.urls[0])).toContain("expand=body.export_view,version");
    expect(log.inits[0].credentials).toBe("include");
    // `redirect: "manual"` is what makes assertNotAuthRedirect possible at all;
    // a hand-rolled fetch adapter would have had to reinvent it.
    expect(log.inits[0].redirect).toBe("manual");

    expect(result.blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(codes(result.notes)).toContain("macro-rendered-via");
    expect(messages(result.notes)).toContain("export_view");
  });

  it("batches every macro on a page into ONE export_view request", async () => {
    const log = installFetch(
      () =>
        new Response(
          JSON.stringify({
            id: ROOT_ID,
            body: {
              export_view: {
                value: `<div data-macro-id="m1"><p>One</p></div><div data-macro-id="m2"><p>Two</p></div>`,
              },
            },
            version: { number: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const { result } = await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/>`,
    });
    expect(log.urls).toHaveLength(1);
    expect(codes(result.notes).filter((c) => c === "macro-rendered-via")).toHaveLength(2);
  });
});

describe("response taxonomy", () => {
  it("403 → chain skip with a permission note, export continues", async () => {
    installFetch(() => errorJson(403, "no permission"));
    const { result, built } = await run();
    expect(codes(result.notes)).toContain("macro-degraded");
    expect(messages(result.notes)).toContain("no permission to view this macro's content");
    // The client's redacted internal string never reaches the report.
    expect(messages(result.notes)).not.toContain("logBody policy");
    // Placeholder floor kept the macro visible; the export did not fail.
    expect(result.blocks.some((b) => b.type === "unknown")).toBe(true);
    expect(built.ports.state.expired).toBe(false);
    expect(built.notes()).toHaveLength(0);
  });

  it("404 → chain skip with a not-found note", async () => {
    installFetch(() => errorJson(404, "no such content"));
    const { result, built } = await run();
    expect(messages(result.notes)).toContain("not found (404)");
    expect(built.ports.state.expired).toBe(false);
  });

  it("429 exhausting the client's own retries → degraded note, chain continues", async () => {
    installFastTimers();
    const log = installFetch(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
    );
    const { result, built } = await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/>`,
    });
    // The CLIENT retried (1 + 3 retries) before the port ever saw an error —
    // inherited behaviour, not re-specified in the adapter.
    expect(log.urls.length).toBeGreaterThanOrEqual(4);
    expect(messages(result.notes)).toContain("rate-limited");
    // Both macros still resolved to the placeholder floor: one flaky service
    // never aborts the whole export.
    expect(result.blocks.filter((b) => b.type === "unknown")).toHaveLength(2);
    expect(codes(result.notes).filter((c) => c === "macro-degraded").length).toBeGreaterThanOrEqual(2);
    expect(built.ports.state.expired).toBe(false);
  });

  it("5xx after the client's retries → degraded note, chain continues", async () => {
    installFastTimers();
    const log = installFetch(() => new Response("boom", { status: 503 }));
    const { result, built } = await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/>`,
    });
    expect(log.urls.length).toBeGreaterThanOrEqual(4);
    expect(codes(result.notes)).toContain("macro-degraded");
    expect(result.blocks.filter((b) => b.type === "unknown")).toHaveLength(2);
    expect(built.ports.state.expired).toBe(false);
  });
});

describe("session expiry aborts the live-macro pass (no silent placeholder cascade)", () => {
  it("an opaque redirect stops further port calls and surfaces one distinct note", async () => {
    const log = installFetch(() => {
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      return res;
    });
    const { result, built } = await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/>`,
      sourcePages: [
        { id: ROOT_ID, version: 3, spaceKey: "DOCSY" },
        { id: CHILD_ID, version: 9, spaceKey: "DOCSY" },
      ],
    });

    // ONE request: the second macro (on a different page, so no batch reuse)
    // short-circuited without touching the network.
    expect(log.urls).toHaveLength(1);
    expect(built.ports.state.expired).toBe(true);

    // The distinct, actionable note — not just another "macro-degraded".
    const sessionNotes = built.notes();
    expect(sessionNotes).toHaveLength(1);
    expect(sessionNotes[0].code).toBe("auth-error");
    expect(sessionNotes[0].message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(sessionNotes[0].message).toMatch(/sign in again/i);

    // Both macros still degraded to a visible placeholder, and every degraded
    // note names the session — never a bare "could not be rendered".
    expect(result.blocks.filter((b) => b.type === "unknown")).toHaveLength(2);
    expect(messages(result.notes)).toContain("session expired");
  });

  it("a raw 3xx is classified the same way", async () => {
    installFetch(() => new Response(null, { status: 302, headers: { location: "https://id.atlassian.com/login" } }));
    const { built } = await run();
    expect(built.ports.state.expired).toBe(true);
    expect(codes(built.notes())).toEqual(["auth-error"]);
  });

  it("a 200 login page (non-JSON body) is classified the same way", async () => {
    installFetch(() => new Response("<html><body>Log in</body></html>", { status: 200 }));
    const { built } = await run();
    expect(built.ports.state.expired).toBe(true);
    expect(codes(built.notes())).toEqual(["auth-error"]);
  });

  it("the latch is emitted exactly once across many macros", async () => {
    installFetch(() => new Response(null, { status: 302, headers: { location: "https://id.atlassian.com/" } }));
    const { built } = await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/><ac:structured-macro ac:name="c-app" ac:macro-id="m3"/>`,
      sourcePages: [{ id: "1" }, { id: "2" }, { id: "3" }],
    });
    expect(built.notes()).toHaveLength(1);
  });
});

describe("dynamic-macro toggle OFF", () => {
  it("emits skipped-by-config without a single port call", async () => {
    const log = installFetch(() => exportViewJson("m1", "<p>never reached</p>"));
    const { result, built } = await run({ live: false });
    expect(log.urls).toEqual([]);
    expect(codes(result.notes)).toContain("macro-skipped-by-config");
    expect(codes(result.notes)).not.toContain("macro-degraded");
    expect(built.ports.state.expired).toBe(false);
  });
});

describe("per-source-page context (contextFor passed through unchanged)", () => {
  it("resolves a child page's macro against THAT page, never the export root", async () => {
    const log = installFetch((url) => {
      const id = url.includes(`/content/${CHILD_ID}`) ? CHILD_ID : ROOT_ID;
      return new Response(
        JSON.stringify({
          id,
          body: { export_view: { value: `<div data-macro-id="m${id === ROOT_ID ? 1 : 2}"><p>${id}</p></div>` } },
          version: { number: id === ROOT_ID ? 3 : 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    await run({
      storage: `<ac:structured-macro ac:name="a-app" ac:macro-id="m1"/><ac:structured-macro ac:name="b-app" ac:macro-id="m2"/>`,
      sourcePages: [
        { id: ROOT_ID, version: 3, spaceKey: "DOCSY" },
        { id: CHILD_ID, version: 9, spaceKey: "DOCSY" },
      ],
    });
    expect(log.urls.some((u) => u.includes(`/content/${ROOT_ID}?`))).toBe(true);
    expect(log.urls.some((u) => u.includes(`/content/${CHILD_ID}?`))).toBe(true);
  });

  it("contextFor returns the page it was handed, verbatim", () => {
    const built = buildSessionMacroResolutionOptions({
      pageUrl: PAGE_URL,
      targetEngine: "docx",
    });
    const ctx = built.options.contextFor({ id: CHILD_ID, version: 9, spaceKey: "OTHER" });
    expect(ctx.page).toEqual({ id: CHILD_ID, version: 9, spaceKey: "OTHER" });
    expect(ctx.flags?.targetEngine).toBe("docx");
    expect(ctx.siteId).toBe(SITE);
  });

  it("falls back to the single-macro v1 endpoints when the batch body lacks the macro", async () => {
    const log = installFetch((url) => {
      if (url.includes("/contentbody/convert/export_view")) {
        return new Response(JSON.stringify({ value: "<p>Converted</p>" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/history/9/macro/id/")) {
        return new Response(JSON.stringify({ body: "<ac:structured-macro ac:name=\"x\"/>" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Batch body carries a DIFFERENT macro id.
      return new Response(
        JSON.stringify({
          id: CHILD_ID,
          body: { export_view: { value: `<div data-macro-id="other"><p>x</p></div>` } },
          version: { number: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const { result } = await run({
      sourcePages: [{ id: CHILD_ID, version: 9, spaceKey: "DOCSY" }],
    });
    // The version used is the MACRO'S OWN page version (9), not the root's (3).
    expect(log.urls.some((u) => u.includes(`/content/${CHILD_ID}/history/9/macro/id/m1`))).toBe(true);
    expect(log.urls.some((u) => u.includes("/contentbody/convert/export_view"))).toBe(true);
    expect(codes(result.notes)).toContain("macro-rendered-via");
  });
});

describe("JiraIssuePort is a thin adapter over JiraClient", () => {
  /**
   * A stand-in with `JiraClient`'s exact public signatures (see
   * `packages/jira/src/client.ts#getIssue`/`#search`). It is NOT a fetch mock:
   * the point of these cases is that the port delegates to the client and does
   * no HTTP of its own — asserted by the empty fetch log.
   */
  function recordingJiraClient(
    impl: Partial<JiraClientLike> = {}
  ): JiraClientLike & { calls: string[] } {
    const calls: string[] = [];
    const issue: JiraIssueLike = {
      key: "ATL-1",
      fields: {
        summary: "Ship it",
        status: { name: "In Progress", statusCategory: { colorName: "yellow" } },
        assignee: { displayName: "Ada" },
      },
    };
    return {
      calls,
      async getIssue(key) {
        calls.push(`getIssue:${key}`);
        if (impl.getIssue) return impl.getIssue(key);
        return issue;
      },
      async search(jql, options) {
        calls.push(`search:${jql}`);
        if (impl.search) return impl.search(jql, options);
        return { issues: [issue] };
      },
    };
  }

  it("maps an issue through the client and issues no HTTP of its own", async () => {
    const log = installFetch(() => new Response("should never be called", { status: 500 }));
    const client = recordingJiraClient();
    const state = createSessionMacroState();
    const port = sessionJiraIssuePort(client, `${SITE}/`, { state });

    const ref = await port.getIssue("ATL-1");
    expect(client.calls).toEqual(["getIssue:ATL-1"]);
    expect(log.urls).toEqual([]);
    expect(ref).toEqual({
      key: "ATL-1",
      summary: "Ship it",
      status: "In Progress",
      statusColor: "yellow",
      url: `${SITE}/browse/ATL-1`,
      fields: { assignee: "Ada" },
    });

    const rows = await port.searchJql("project = ATL", { columns: ["key"], maximumIssues: 5 });
    expect(client.calls).toContain("search:project = ATL");
    expect(rows).toHaveLength(1);
  });

  it("classifies the client's own error strings into the port taxonomy", async () => {
    const state = createSessionMacroState();
    const port = sessionJiraIssuePort(
      recordingJiraClient({
        async getIssue() {
          throw new Error("Jira API error (403): forbidden");
        },
      }),
      SITE,
      { state }
    );
    const err = await port.getIssue("ATL-1").then(() => undefined, (e: unknown) => e);
    expect((err as { kind?: string }).kind).toBe("permission");
    expect(state.expired).toBe(false);
  });

  it("latches the session on a Jira 401 and short-circuits later calls", async () => {
    const state = createSessionMacroState();
    const client = recordingJiraClient({
      async getIssue() {
        throw new Error("Jira API error (401): unauthorized");
      },
    });
    const port = sessionJiraIssuePort(client, SITE, { state });

    await port.getIssue("ATL-1").catch(() => undefined);
    expect(state.expired).toBe(true);
    await port.getIssue("ATL-2").catch(() => undefined);
    // Only the first call reached the client.
    expect(client.calls).toEqual(["getIssue:ATL-1"]);
    expect(state.notes()).toHaveLength(1);
  });

  it("honours the export AbortSignal cooperatively", async () => {
    const controller = new AbortController();
    const state = createSessionMacroState();
    const port = sessionJiraIssuePort(recordingJiraClient(), SITE, {
      state,
      signal: controller.signal,
    });
    controller.abort();
    const err = await port.getIssue("ATL-1").then(() => undefined, (e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("classifySessionPortError", () => {
  const state = () => createSessionMacroState();

  it("rethrows an AbortError untouched so the export aborts", () => {
    const abort = new DOMException("stop", "AbortError");
    expect(() => classifySessionPortError(abort, "jira", state())).toThrow(abort);
  });

  it("maps the clients' exhausted-rate-limit message", () => {
    const err = (() => {
      try {
        classifySessionPortError(
          new Error("Rate limited by Confluence API after 3 retries"),
          "confluence",
          state()
        );
      } catch (e) {
        return e as { kind: string; retryAfterMs?: number };
      }
    })();
    expect(err?.kind).toBe("rate-limited");
    expect(err?.retryAfterMs).toBeGreaterThan(0);
  });

  it("maps 5xx to network (degraded, chain continues) not permission", () => {
    const err = (() => {
      try {
        classifySessionPortError(new Error("Confluence API error (503): boom"), "confluence", state());
      } catch (e) {
        return e as { kind: string };
      }
    })();
    expect(err?.kind).toBe("network");
  });
});

describe("ExportViewPort abort", () => {
  it("propagates an abort instead of degrading it to a skip", async () => {
    installFetch(() => exportViewJson("m1", "<p>x</p>"));
    const controller = new AbortController();
    const state = createSessionMacroState();
    const port = sessionExportViewPort(
      new ConfluenceClient({
        name: "session",
        baseUrl: SITE,
        deploymentType: "cloud",
        auth: { type: "session" },
      }),
      { state, signal: controller.signal }
    );
    controller.abort();
    const err = await port.renderMacroHtml(ROOT_ID, "m1").then(() => undefined, (e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

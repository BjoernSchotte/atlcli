import { afterEach, describe, expect, it } from "bun:test";
import { fetchExportTree, type TreeSourceClient } from "@atlcli/confluence/browser";
import {
  combineAbortSignals,
  NOT_ATLASSIAN_HOST_MESSAGE,
  sessionTreeSource,
} from "../../utils/confluence/tree-source.js";

/**
 * No HTTP is mocked here. Every response below is a real `Response` instance
 * handed to a real `ConfluenceClient` through a routing `fetch` stand-in — the
 * repo rule the fixtures follow (see `tests/read-path.test.ts`). What is under
 * test is the *adapter*: that it constructs a session client for the tab's
 * origin, threads the export `AbortSignal` into every port method, and inherits
 * the client's session/redirect/429 behavior instead of re-implementing fetch.
 */

const PAGE_URL = "https://test.atlassian.net/wiki/spaces/DOCSY/pages/1/Root";
const API = "https://test.atlassian.net/wiki";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init: RequestInit;
}

/** Route requests to hand-constructed real `Response` objects; record the calls. */
function route(handler: (url: URL) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(new URL(String(input))));
  }) as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const pageBody = (id: string, title: string, version: number, storage = "<p>hi</p>") => ({
  id,
  title,
  body: { storage: { value: storage } },
  version: { number: version },
  space: { key: "DOCSY" },
  metadata: { labels: { results: [{ name: "handbook" }] } },
});

/**
 * A three-page site: root `1` with children `2` ("Alpha", UI position 0) and
 * `3` ("Beta", UI position 1). The v2 `direct-children` listing deliberately
 * returns them in the OPPOSITE order, so "UI order" can only come from the
 * positions the adapter carries through.
 */
function siteRouter(url: URL): Response {
  const path = url.pathname.replace(`/wiki`, "");
  const expand = url.searchParams.get("expand") ?? "";

  if (path === "/api/v2/pages/1/direct-children") {
    return json({
      results: [
        { id: "3", title: "Beta", type: "page" },
        { id: "2", title: "Alpha", type: "page" },
        { id: "9", title: "Sketches", type: "whiteboard" },
      ],
      _links: {},
    });
  }
  if (path === "/rest/api/content/1/child/page") {
    return json({
      results: [
        { id: "2", title: "Alpha", version: { number: 5 }, extensions: { position: 0 } },
        { id: "3", title: "Beta", version: { number: 7 }, extensions: { position: 1 } },
      ],
      _links: {},
    });
  }
  if (path === "/api/v2/pages/2/direct-children" || path === "/api/v2/pages/3/direct-children") {
    return json({ results: [], _links: {} });
  }
  if (path === "/rest/api/content/2/child/page" || path === "/rest/api/content/3/child/page") {
    return json({ results: [], _links: {} });
  }
  if (path === "/rest/api/space/DOCSY") {
    return json({ homepage: { id: "1" } });
  }
  if (path === "/rest/api/content/search") {
    return json({ results: [{ id: "2", title: "Alpha", type: "page" }], _links: {} });
  }
  const page = path.match(/^\/rest\/api\/content\/(\d+)$/);
  if (page) {
    const id = page[1]!;
    const titles: Record<string, string> = { "1": "Root", "2": "Alpha", "3": "Beta" };
    const versions: Record<string, number> = { "1": 3, "2": 5, "3": 7 };
    const body = pageBody(id, titles[id] ?? id, versions[id] ?? 1);
    // `getPageVersion` asks for a lighter expand than `getPageDetails`; both hit
    // the same path, so route on the expand that carries the body.
    return json(expand.includes("body.storage") ? body : { ...body, body: undefined });
  }
  return json({ message: `unrouted ${path}` }, 404);
}

describe("sessionTreeSource — host gating", () => {
  it("refuses a tab that is not on an approved Atlassian host", () => {
    expect(() => sessionTreeSource("https://evil-atlassian.net/wiki/x")).toThrow(
      NOT_ATLASSIAN_HOST_MESSAGE
    );
    expect(() => sessionTreeSource("not a url")).toThrow(NOT_ATLASSIAN_HOST_MESSAGE);
  });
});

describe("sessionTreeSource — session-backed port methods", () => {
  it("getPage rides the ambient session and maps the port shape", async () => {
    const calls = route(siteRouter);
    const page = await sessionTreeSource(PAGE_URL).getPage("1", {});

    expect(page).toEqual({
      id: "1",
      title: "Root",
      storage: "<p>hi</p>",
      version: 3,
      labels: ["handbook"],
      spaceKey: "DOCSY",
    });
    // Session auth: cookies ride along, no Authorization header is built, and
    // the login bounce is not followed (all three come from ConfluenceClient).
    const init = calls[0]!.init as RequestInit & { redirect?: string };
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(calls[0]!.url.startsWith(`${API}/rest/api/content/1`)).toBe(true);
  });

  it("getChildren carries real UI positions and classifies non-pages honestly", async () => {
    route(siteRouter);
    const children = await sessionTreeSource(PAGE_URL).getChildren({ id: "1", kind: "page" }, {});

    expect(children).toEqual([
      { id: "3", title: "Beta", kind: "page", position: 1, observedVersion: 7 },
      { id: "2", title: "Alpha", kind: "page", position: 0, observedVersion: 5 },
      { id: "9", title: "Sketches", kind: "unsupported", unsupportedKind: "whiteboard", position: null },
    ]);
  });

  it("produces UI order end-to-end through fetchExportTree", async () => {
    route(siteRouter);
    const result = await fetchExportTree(
      sessionTreeSource(PAGE_URL),
      { kind: "tree", rootPageId: "1", maxDepth: 1 },
      { concurrency: 1 }
    );

    // Listing order was Beta-then-Alpha; UI position order is Alpha-then-Beta.
    expect(result.nodes.map((n) => n.title)).toEqual(["Root", "Alpha", "Beta"]);
    expect(result.complete).toBe(true);
    // The whiteboard child is reported, never cast into a page.
    expect(result.notes.some((n) => n.code === "unsupported-child-type")).toBe(true);
  });

  it("getSpaceHomepageId resolves the space root", async () => {
    route(siteRouter);
    const source = sessionTreeSource(PAGE_URL);
    expect(await source.getSpaceHomepageId("DOCSY", {})).toBe("1");
  });

  it("searchPages forwards the CQL batch (label filter lookups)", async () => {
    const calls = route(siteRouter);
    const source = sessionTreeSource(PAGE_URL);
    expect(source.searchPages).toBeDefined();

    const cql = 'id in ("2","3") and label = "internal"';
    expect(await source.searchPages!(cql, {})).toEqual([expect.objectContaining({ id: "2" })]);
    expect(new URL(calls[0]!.url).searchParams.get("cql")).toBe(cql);
  });

  it("getPageVersion returns the lightweight snapshot", async () => {
    route(siteRouter);
    expect(await sessionTreeSource(PAGE_URL).getPageVersion("2", {})).toEqual({
      version: 5,
      title: "Alpha",
    });
  });
});

describe("sessionTreeSource — AbortSignal propagation", () => {
  it("rejects every method on an already-aborted export signal, without any request", async () => {
    const calls = route(siteRouter);
    const controller = new AbortController();
    controller.abort();
    const source = sessionTreeSource(PAGE_URL, { signal: controller.signal });

    await expect(source.getPage("1", {})).rejects.toThrow();
    await expect(source.getPageVersion("1", {})).rejects.toThrow();
    await expect(source.getChildren({ id: "1", kind: "page" }, {})).rejects.toThrow();
    await expect(source.getSpaceHomepageId("DOCSY", {})).rejects.toThrow();
    await expect(source.searchPages!("label = x", {})).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight request when the export signal fires mid-walk", async () => {
    // The response never resolves on its own: only the signal the adapter passed
    // into fetch can end this call.
    const seen: AbortSignal[] = [];
    globalThis.fetch = ((_input: string, init: RequestInit = {}) => {
      const signal = init.signal as AbortSignal;
      seen.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = sessionTreeSource(PAGE_URL, { signal: controller.signal }).getPage("1", {});
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("honors a per-call context signal even without an export signal", async () => {
    const calls = route(siteRouter);
    const controller = new AbortController();
    controller.abort();
    await expect(
      sessionTreeSource(PAGE_URL).getPage("1", { signal: controller.signal })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("combineAbortSignals avoids allocating a composite for the common wiring", () => {
    const a = new AbortController().signal;
    const b = new AbortController().signal;
    expect(combineAbortSignals(a, undefined)).toBe(a);
    expect(combineAbortSignals(undefined, b)).toBe(b);
    // fetchExportTree threads the very signal handed to the factory.
    expect(combineAbortSignals(a, a)).toBe(a);
    // Two distinct signals: either one must abort the combined one.
    const combined = combineAbortSignals(a, b)!;
    expect(combined).not.toBe(a);
    expect(combined.aborted).toBe(false);
  });
});

describe("sessionTreeSource — behavior inherited from ConfluenceClient", () => {
  it("classifies an expired session's login bounce instead of following it", async () => {
    // `redirect: "manual"` surfaces the bounce as an opaque redirect; the client's
    // assertNotAuthRedirect turns it into a classified error. A hand-rolled fetch
    // in the adapter would have to reinvent this.
    route(() => Response.redirect("https://id.atlassian.com/login", 302));
    await expect(sessionTreeSource(PAGE_URL).getPage("1", {})).rejects.toThrow(
      /authentication redirect/i
    );
  });

  it("classifies an HTML login page served with HTTP 200", async () => {
    route(() => new Response("<html>Log in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(sessionTreeSource(PAGE_URL).getPage("1", {})).rejects.toThrow(/login page/i);
  });

  it("retries a 429 using the server's Retry-After instead of failing the walk", async () => {
    let attempts = 0;
    route((url) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      }
      return siteRouter(url);
    });

    const page = await sessionTreeSource(PAGE_URL).getPage("1", {});
    expect(page.title).toBe("Root");
    expect(attempts).toBe(2);
  });
});

describe("sessionTreeSource — injectable client seam", () => {
  it("uses the supplied client factory and the tab's origin as base URL", async () => {
    const seen: string[] = [];
    const fake: TreeSourceClient = {
      getPageDetails: async (id) => {
        seen.push(`details:${id}`);
        return { id, title: "Fake", storage: "", version: 1 };
      },
      getPageVersion: async (id) => ({ title: "Fake", version: 1 }),
      getChildrenWithPosition: async () => [],
      getPageDirectChildren: async () => [],
      getFolderChildren: async () => [],
      getSpaceHomepageId: async () => null,
      searchPages: async () => [],
    };

    let baseUrl = "";
    const source = sessionTreeSource(PAGE_URL, {
      makeClient: (profile) => {
        baseUrl = profile.baseUrl;
        expect(profile.auth.type).toBe("session");
        return fake;
      },
    });

    expect(await source.getPage("42", {})).toEqual({
      id: "42",
      title: "Fake",
      storage: "",
      version: 1,
      labels: undefined,
      spaceKey: undefined,
    });
    expect(seen).toEqual(["details:42"]);
    expect(baseUrl).toBe("https://test.atlassian.net");
  });
});

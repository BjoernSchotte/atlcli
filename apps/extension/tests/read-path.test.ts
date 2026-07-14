import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Profile } from "@atlcli/core";
import {
  classifyThrownError,
  countWords,
  loadConfluencePage,
  ReadError,
  toAttachmentMeta,
} from "../utils/read-path.js";

const sessionProfile: Profile = {
  name: "session",
  baseUrl: "https://test.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "session" },
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock that records every RequestInit and routes by URL. */
function installFetch(handler: (url: string) => Response): { inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    inits.push(init);
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return { inits };
}

const pageJson = () =>
  new Response(
    JSON.stringify({
      id: "123",
      title: "Session Page",
      body: { storage: { value: "<h1>Hello</h1><p>world</p>" } },
      version: { number: 4 },
      space: { key: "DOCSY" },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const attachmentsJson = () =>
  new Response(
    JSON.stringify({
      results: [
        {
          id: "att1",
          title: "diagram.png",
          metadata: { mediaType: "image/png" },
          extensions: { fileSize: 2048 },
          version: { number: 1 },
          _links: { download: "/download/attachments/123/diagram.png" },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

function routeBoth(url: string): Response {
  return url.includes("/child/attachment") ? attachmentsJson() : pageJson();
}

describe("classifyThrownError (pure taxonomy, PLAN §2.3)", () => {
  it("maps 401 to not-logged-in", () => {
    expect(classifyThrownError(new Error("Confluence API error (401): denied"))).toBe(
      "not-logged-in"
    );
  });

  it("maps 403 and 404 to access-denied", () => {
    expect(classifyThrownError(new Error("Confluence API error (403): nope"))).toBe(
      "access-denied"
    );
    expect(classifyThrownError(new Error("Confluence API error (404): gone"))).toBe(
      "access-denied"
    );
  });

  it("maps a v2 error status too", () => {
    expect(classifyThrownError(new Error("Confluence API v2 error (404): gone"))).toBe(
      "access-denied"
    );
  });

  it("maps a fetch TypeError to network", () => {
    expect(classifyThrownError(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("maps a 3xx auth redirect to not-logged-in (finding #4)", () => {
    expect(
      classifyThrownError(new Error("Confluence API error (302): authentication redirect to Atlassian login"))
    ).toBe("not-logged-in");
  });

  it("maps a non-JSON/login-page phrase to not-logged-in (finding #5)", () => {
    expect(
      classifyThrownError(new Error("Confluence API error (login): non-JSON 200 response (login page)"))
    ).toBe("not-logged-in");
  });

  it("maps other HTTP statuses and junk to unknown", () => {
    expect(classifyThrownError(new Error("Confluence API error (500): boom"))).toBe("unknown");
    expect(classifyThrownError("weird")).toBe("unknown");
  });
});

describe("countWords / toAttachmentMeta (pure helpers)", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("hello world  foo\nbar")).toBe(4);
    expect(countWords("   ")).toBe(0);
    expect(countWords("")).toBe(0);
  });

  it("shapes attachment info into panel metadata", () => {
    expect(
      toAttachmentMeta({
        id: "a",
        filename: "f.png",
        mediaType: "image/png",
        fileSize: 10,
        version: 1,
        pageId: "123",
        downloadUrl: "/d/f.png",
      })
    ).toEqual({ name: "f.png", mediaType: "image/png", size: 10, link: "/d/f.png" });
  });
});

describe("loadConfluencePage — session-auth read path (integration, mock fetch)", () => {
  it("sends credentials: include and NO Authorization from the extension call site", async () => {
    const { inits } = installFetch(routeBoth);

    await loadConfluencePage("123", sessionProfile);

    // Both the getPageDetails and listAttachments fetches must be session-mode.
    expect(inits.length).toBeGreaterThanOrEqual(2);
    for (const init of inits) {
      expect(init.credentials).toBe("include");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    }
  });

  it("returns details + converted markdown + word count + attachment metadata", async () => {
    installFetch(routeBoth);

    const loaded = await loadConfluencePage("123", sessionProfile);

    expect(loaded.details.id).toBe("123");
    expect(loaded.details.title).toBe("Session Page");
    expect(loaded.details.version).toBe(4);
    expect(loaded.details.spaceKey).toBe("DOCSY");
    expect(loaded.markdown.toLowerCase()).toContain("hello");
    expect(loaded.wordCount).toBeGreaterThan(0);
    expect(loaded.attachments).toEqual([
      {
        name: "diagram.png",
        mediaType: "image/png",
        size: 2048,
        link: "/download/attachments/123/diagram.png",
      },
    ]);
  });

  it("classifies a 200 HTML login page as not-logged-in (SameSite/session proof)", async () => {
    // Atlassian answers unauthenticated calls on some routes with 200 + HTML.
    installFetch(
      () =>
        new Response("<!DOCTYPE html><html><body>Log in to continue</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );

    const err = await loadConfluencePage("123", sessionProfile).catch((e) => e);
    expect(err).toBeInstanceOf(ReadError);
    expect((err as ReadError).kind).toBe("not-logged-in");
  });

  it("classifies a 401 as not-logged-in", async () => {
    installFetch(() => new Response(JSON.stringify({ message: "no" }), { status: 401 }));
    const err = await loadConfluencePage("123", sessionProfile).catch((e) => e);
    expect((err as ReadError).kind).toBe("not-logged-in");
  });

  it("classifies 403 and 404 as access-denied", async () => {
    installFetch(() => new Response("forbidden", { status: 403 }));
    const e403 = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(e403.kind).toBe("access-denied");

    installFetch(() => new Response("gone", { status: 404 }));
    const e404 = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(e404.kind).toBe("access-denied");
  });

  it("classifies a fetch rejection as network", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("Failed to fetch"))
    ) as unknown as typeof fetch;
    const err = await loadConfluencePage("123", sessionProfile).catch((e) => e);
    expect((err as ReadError).kind).toBe("network");
  });

  it("regression (finding #4): an opaque redirect (logged-out 3xx→id.atlassian.com) → not-logged-in", async () => {
    // With session `redirect: "manual"` a bounce to the login host surfaces as an
    // opaque-redirect response. The client must classify it as an auth redirect —
    // NOT follow it with cookies to a foreign origin, and NOT surface a raw
    // TypeError/network failure.
    let calls = 0;
    const inits: RequestInit[] = [];
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      calls++;
      inits.push(init);
      return Promise.resolve({
        type: "opaqueredirect",
        status: 0,
        ok: false,
        headers: new Headers(),
        text: async () => "",
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const err = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(err).toBeInstanceOf(ReadError);
    expect(err.kind).toBe("not-logged-in");
    // No credentialed follow to the foreign login origin: exactly one fetch, and
    // it went out with manual redirect + session credentials.
    expect(calls).toBe(1);
    expect(inits[0].redirect).toBe("manual");
    expect(inits[0].credentials).toBe("include");
    expect(new Headers(inits[0].headers).has("Authorization")).toBe(false);
  });

  it("regression (finding #4): a raw 302 status is classified as not-logged-in", async () => {
    installFetch(() => new Response(null, { status: 302, headers: { location: "https://id.atlassian.com/login" } }));
    const err = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(err.kind).toBe("not-logged-in");
  });

  it("regression (finding #5): a 200 application/json error envelope ({statusCode:403}) → access-denied", async () => {
    // Keyed only on a missing `id`, this was misclassified as not-logged-in. It
    // is a permission error dressed as a 200, so it must read as access-denied.
    installFetch(
      () =>
        new Response(JSON.stringify({ statusCode: 403, message: "Forbidden" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const err = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(err.kind).toBe("access-denied");
  });

  it("regression (finding #5): a 200 JSON body with neither id nor statusCode → unknown (not not-logged-in)", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ foo: "bar" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const err = (await loadConfluencePage("123", sessionProfile).catch((e) => e)) as ReadError;
    expect(err.kind).toBe("unknown");
  });

  it("keeps the page when attachment listing fails (best-effort)", async () => {
    // 403 (not 5xx) so the client does not retry — keeps the test fast.
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/child/attachment")) {
        return Promise.resolve(new Response("forbidden", { status: 403 }));
      }
      return Promise.resolve(pageJson());
    }) as unknown as typeof fetch;

    const loaded = await loadConfluencePage("123", sessionProfile);
    expect(loaded.details.id).toBe("123");
    expect(loaded.attachments).toEqual([]);
  });
});

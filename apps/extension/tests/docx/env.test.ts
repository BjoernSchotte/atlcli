/**
 * Extension env adapters for the isomorphic export engine (spec 006 Task 3).
 *
 * Per the repo's real-infra directive: the template source runs against
 * fake-indexeddb (spec-complete IndexedDB, real transactions), the download
 * sink against a happy-dom document; only the network `fetch` is stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import {
  canvasSvgRasterizer,
  downloadOutputSink,
  getRasterizerStats,
  idbTemplateSource,
  memoryTemplateSource,
  resetRasterizerStats,
  sessionAssetFetcher,
} from "../../utils/docx/env.js";
import { classifyThrownError } from "../../utils/read-path.js";
import { idbTemplateLibrary } from "../../utils/templates/library.js";

const SITE = "https://mayflower.atlassian.net";

function docxBuffer(body = "$scroll.title"): { docx: Uint8Array; buffer: ArrayBuffer } {
  const docx = buildDocx({ body: para(body) });
  return {
    docx,
    buffer: docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength) as ArrayBuffer,
  };
}

describe("idbTemplateSource", () => {
  it("returns the bytes of the template requested by its logical templateId", async () => {
    const factory = new IDBFactory();
    const { docx, buffer } = docxBuffer();
    const entry = await idbTemplateLibrary({ factory, siteOrigin: SITE }).add({
      name: "t.docx",
      bytes: buffer,
    });

    const bytes = await idbTemplateSource(factory, { siteOrigin: SITE }).getBytes(entry.id);
    expect(bytes).toEqual(docx);
  });

  it("resolves the active selection when no explicit id is given", async () => {
    const factory = new IDBFactory();
    const library = idbTemplateLibrary({ factory, siteOrigin: SITE });
    const other = await library.add({ name: "other.docx", bytes: docxBuffer("$scroll.title").buffer });
    const { docx, buffer } = docxBuffer("$scroll.content");
    const active = await library.add({ name: "active.docx", bytes: buffer });
    await library.setActiveTemplateId("docx", "DOCSY", active.id);
    expect(other.id).not.toBe(active.id);

    const source = idbTemplateSource(factory, { siteOrigin: SITE, spaceKey: "DOCSY" });
    expect(await source.getBytes("")).toEqual(docx);
  });

  it("lets a space-scoped override beat the global entry of the same templateId", async () => {
    const factory = new IDBFactory();
    const library = idbTemplateLibrary({ factory, siteOrigin: SITE });
    const global = await library.add({
      name: "handbook.docx",
      bytes: docxBuffer("$scroll.title").buffer,
    });
    const { docx: spaceDocx, buffer: spaceBuffer } = docxBuffer("$scroll.content");
    // Same logical templateId, space scope — a distinct row, not a replacement.
    await library.add({
      name: "handbook-docsy.docx",
      bytes: spaceBuffer,
      templateId: global.id,
      scope: "space",
      spaceKey: "DOCSY",
    });

    const inSpace = idbTemplateSource(factory, { siteOrigin: SITE, spaceKey: "DOCSY" });
    expect(await inSpace.getBytes(global.id)).toEqual(spaceDocx);
  });

  it("rejects when nothing is stored", async () => {
    const factory = new IDBFactory();
    expect(idbTemplateSource(factory, { siteOrigin: SITE }).getBytes("")).rejects.toThrow(
      "No template selected"
    );
  });

  it("rejects when the requested templateId is not in the library", async () => {
    const factory = new IDBFactory();
    await idbTemplateLibrary({ factory, siteOrigin: SITE }).add({
      name: "t.docx",
      bytes: docxBuffer().buffer,
    });
    expect(idbTemplateSource(factory, { siteOrigin: SITE }).getBytes("missing")).rejects.toThrow(
      'No docx template "missing" in the library'
    );
  });
});

describe("memoryTemplateSource", () => {
  it("serves the panel's already-loaded template bytes", async () => {
    const buffer = new Uint8Array([80, 75, 3, 4]).buffer;
    expect(await memoryTemplateSource(buffer).getBytes("current")).toEqual(
      new Uint8Array([80, 75, 3, 4])
    );
  });
});

describe("sessionAssetFetcher", () => {
  function recordingFetch(payload = new Uint8Array([1, 2, 3])) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(payload.slice());
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  it("fetches with session credentials and returns the bytes", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const { calls, fetchFn } = recordingFetch(payload);

    const bytes = await sessionAssetFetcher(undefined, fetchFn).fetch({
      url: "https://x.atlassian.net/wiki/download/attachments/1/a.png",
      filename: "a.png",
    });

    expect(bytes).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("resolves wiki-base-relative attachment refs against the baseUrl (spec 005)", async () => {
    const { calls, fetchFn } = recordingFetch();
    await sessionAssetFetcher("https://x.atlassian.net/wiki", fetchFn).fetch({
      url: "/download/attachments/123/diagram.png",
      pageId: "123",
      filename: "diagram.png",
    });
    expect(calls[0].url).toBe("https://x.atlassian.net/wiki/download/attachments/123/diagram.png");
  });

  it("passes absolute external URLs through untouched, ignoring the baseUrl", async () => {
    const { calls, fetchFn } = recordingFetch();
    await sessionAssetFetcher("https://x.atlassian.net/wiki", fetchFn).fetch({
      url: "https://cdn.example.com/pic.png",
    });
    expect(calls[0].url).toBe("https://cdn.example.com/pic.png");
  });

  it("isolates versioned asset bytes by canonical site base URL", async () => {
    const ref = {
      url: "/download/attachments/321/logo.png?version=cross-site-regression",
      filename: "logo.png",
    };
    const siteACalls: string[] = [];
    const siteBCalls: string[] = [];
    const fetchA = (async (url: unknown) => {
      siteACalls.push(String(url));
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    const fetchB = (async (url: unknown) => {
      siteBCalls.push(String(url));
      return new Response(new Uint8Array([2]));
    }) as typeof fetch;

    const a = sessionAssetFetcher("https://A.atlassian.net/wiki/", fetchA);
    const b = sessionAssetFetcher("https://b.atlassian.net/wiki", fetchB);
    expect(await a.fetch(ref)).toEqual(new Uint8Array([1]));
    expect(await b.fetch(ref)).toEqual(new Uint8Array([2]));
    // The canonical no-trailing-slash form shares A's entry, but never B's.
    expect(await sessionAssetFetcher("https://a.atlassian.net/wiki", fetchA).fetch(ref)).toEqual(
      new Uint8Array([1])
    );
    expect(siteACalls).toHaveLength(1);
    expect(siteBCalls).toHaveLength(1);
  });

  it("throws with status + filename on a non-OK response", async () => {
    const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect(
      sessionAssetFetcher(undefined, fetchFn).fetch({ url: "https://x/att", filename: "a.png" })
    ).rejects.toThrow("Asset fetch failed (403) for a.png");
  });
});

/**
 * The extension's own attachment path, driven against REAL HTTP servers
 * (spec 010 wave 2).
 *
 * The defect these encode: `sessionAssetFetcher` fetched attachment bytes with a
 * plain `fetch(url, { credentials: "include" })`, which follows ANY redirect with
 * no destination check. An expired Atlassian session bounces to a login host, the
 * HTML login page comes back `ok`, and its bytes were embedded into the export as
 * image data — and cached in the versioned asset cache, so the poison survived
 * the rest of the panel session.
 *
 * Nothing about the HTTP is faked: three real `Bun.serve` origins issue real 302s
 * and record the headers they really received. The only substitution is a
 * DNS-style resolver that maps the PRODUCTION media hostname onto the local media
 * server, so the policy still judges `api.media.atlassian.com` while the bytes
 * come from a real socket — plus a stand-in for the browser cookie jar Bun does
 * not have (see {@link ambientSessionFetch}).
 */
describe("sessionAssetFetcher session redirects (spec 010 wave 2)", () => {
  const MEDIA_PREFIX = "https://api.media.atlassian.com";
  const SESSION_COOKIE = "cloud.session.token=SECRET";
  const BYTES = new Uint8Array([9, 8, 7, 6]);
  const LOGIN_HTML = "<html><body>Log in to your account</body></html>";
  const realFetch = globalThis.fetch;

  let site: ReturnType<typeof Bun.serve>;
  let media: ReturnType<typeof Bun.serve>;
  let third: ReturnType<typeof Bun.serve>;
  let base = "";
  let mediaBase = "";
  let thirdBase = "";

  /** Every request each origin actually served, in order. */
  const hits: string[] = [];
  /** Headers the MEDIA origin actually received, per request. */
  const mediaHeaders: Headers[] = [];
  /** Headers the SITE origin actually received, per request. */
  const siteHeaders: Headers[] = [];
  /** The URL + init handed to `fetch` for every hop. */
  let inits: Array<{ url: string; init: RequestInit | undefined }> = [];
  /** Flipped by the expiry test to make the site bounce to its login endpoint. */
  let sessionExpired = false;

  beforeAll(() => {
    media = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`media${new URL(req.url).pathname}`);
        mediaHeaders.push(req.headers);
        return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
      },
    });
    mediaBase = `http://127.0.0.1:${media.port}`;

    third = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(`third${new URL(req.url).pathname}`);
        return new Response("owned", { status: 200 });
      },
    });
    thirdBase = `http://127.0.0.1:${third.port}`;

    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(`site${pathname}`);
        siteHeaders.push(req.headers);
        const redirect = (to: string) =>
          new Response(null, { status: 302, headers: { Location: to } });
        switch (pathname) {
          // Cloud's by-design hop: attachment content 302s to the media CDN.
          case "/wiki/download/attachments/1/media.png":
            return redirect(`${MEDIA_PREFIX}/file/abc/binary?token=SECRET`);
          // The live defect: while the session is expired this bounces to the
          // login endpoint; once signed in again it serves the real bytes.
          case "/wiki/download/attachments/1/logo.png":
            return sessionExpired
              ? redirect(`${base}/wiki/login.action?os_destination=%2Fx`)
              : new Response(BYTES, { status: 200 });
          case "/wiki/login.action":
            return new Response(LOGIN_HTML, {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          case "/wiki/download/attachments/1/evil.png":
            return redirect(`${thirdBase}/steal`);
          default:
            return new Response(BYTES, { status: 200, headers: { "content-type": "image/png" } });
        }
      },
    });
    base = `http://127.0.0.1:${site.port}`;
  });

  afterAll(() => {
    site.stop(true);
    media.stop(true);
    third.stop(true);
  });

  beforeEach(() => {
    hits.length = 0;
    mediaHeaders.length = 0;
    siteHeaders.length = 0;
    inits = [];
    sessionExpired = false;
  });

  /**
   * Stands in for the BROWSER's cookie jar, which Bun does not have: a browser
   * attaches the ambient Atlassian session cookie to every hop whose credentials
   * mode is not `"omit"`, and that ambient cookie is exactly what must not reach
   * the media CDN. Also resolves the production media hostname onto the local
   * media server, DNS-style, so the policy judges the real hostname. The request
   * itself is a real `fetch` against a real server.
   */
  function ambientSessionFetch(): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      inits.push({ url, init });
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      if (init?.credentials !== "omit") headers.set("Cookie", SESSION_COOKIE);
      const target = url.startsWith(MEDIA_PREFIX)
        ? `${mediaBase}${url.slice(MEDIA_PREFIX.length)}`
        : url;
      return realFetch(target, { ...init, headers });
    }) as typeof fetch;
  }

  const fetcher = () => sessionAssetFetcher(`${base}/wiki`, ambientSessionFetch());

  it("follows the media-CDN redirect and returns the real attachment bytes", async () => {
    const bytes = await fetcher().fetch({
      url: "/download/attachments/1/media.png",
      pageId: "1",
      filename: "media.png",
    });

    expect(bytes).toEqual(BYTES);
    expect(hits).toEqual(["site/wiki/download/attachments/1/media.png", "media/file/abc/binary"]);
    // The policy judged the PRODUCTION hostname, not the local stand-in.
    expect(inits[1]!.url.startsWith(MEDIA_PREFIX)).toBe(true);
  });

  it("sends no session credential to the media CDN, as the CDN itself recorded", async () => {
    await fetcher().fetch({ url: "/download/attachments/1/media.png", filename: "media.png" });

    // Hop 0 really did carry the ambient session — otherwise the CDN assertion
    // below would pass for the wrong reason.
    expect(siteHeaders[0]!.get("cookie")).toBe(SESSION_COOKIE);

    expect(mediaHeaders).toHaveLength(1);
    expect(mediaHeaders[0]!.get("cookie")).toBeNull();
    expect(mediaHeaders[0]!.get("authorization")).toBeNull();
    expect(inits[1]!.init?.credentials).toBe("omit");
  });

  it("raises an EXPIRY-classified error on a login bounce and never fetches the login page", async () => {
    sessionExpired = true;

    const err = await fetcher()
      .fetch({
        url: "/download/attachments/1/logo.png?version=42&modificationDate=1700000000000",
        filename: "logo.png",
      })
      .catch((e: unknown) => e);

    // The decisive assertion: the panel's OWN classifier must read this as a
    // session expiry, not as a generic asset failure.
    expect(classifyThrownError(err)).toBe("not-logged-in");
    expect((err as Error).message).toContain("authentication redirect to Atlassian login");
    // The login page was never requested, so its HTML could not become image data.
    expect(hits).toEqual(["site/wiki/download/attachments/1/logo.png"]);
  });

  it("never lets login-bounce bytes enter the versioned asset cache", async () => {
    // A version-stamped URL is exactly the cacheable shape — the one where a
    // poisoned entry would outlive the expired session.
    const ref = {
      url: "/download/attachments/1/logo.png?version=poison-regression",
      filename: "logo.png",
    };

    sessionExpired = true;
    await expect(fetcher().fetch(ref)).rejects.toThrow(/authentication redirect/i);
    // Still nothing cached: the second attempt goes back to the network.
    await expect(fetcher().fetch(ref)).rejects.toThrow(/authentication redirect/i);
    expect(hits).toEqual([
      "site/wiki/download/attachments/1/logo.png",
      "site/wiki/download/attachments/1/logo.png",
    ]);

    // After signing in again the SAME key must yield the real attachment, not a
    // remembered login page.
    sessionExpired = false;
    const bytes = await fetcher().fetch(ref);
    expect(bytes).toEqual(BYTES);
    expect(new TextDecoder().decode(bytes)).not.toContain("Log in");
  });

  it("refuses a redirect to a non-allowlisted origin without calling it", async () => {
    const err = (await fetcher()
      .fetch({ url: "/download/attachments/1/evil.png", filename: "evil.png" })
      .catch((e: unknown) => e)) as Error;

    expect(err.name).toBe("SessionRedirectBlockedError");
    expect(err.message).toMatch(/non-allowlisted origin/);
    // Refused BEFORE the request: the third party recorded nothing.
    expect(hits).toEqual(["site/wiki/download/attachments/1/evil.png"]);
    // A blocked third-party hop is not a session expiry.
    expect(err.message).not.toMatch(/non-json|login page|authentication redirect|opaqueredirect/i);
    expect(classifyThrownError(err)).not.toBe("not-logged-in");
  });

  it("leaves an ordinary same-origin attachment fetch exactly as it was", async () => {
    const bytes = await fetcher().fetch({
      url: "/download/attachments/1/plain.png",
      pageId: "1",
      filename: "plain.png",
    });

    expect(bytes).toEqual(BYTES);
    expect(hits).toEqual(["site/wiki/download/attachments/1/plain.png"]);
    expect(inits).toHaveLength(1);
    expect(inits[0]!.init?.credentials).toBe("include");
    // The ambient session still rides along on the site's own origin.
    expect(siteHeaders[0]!.get("cookie")).toBe(SESSION_COOKIE);
  });
});

describe("canvasSvgRasterizer", () => {
  beforeEach(() => resetRasterizerStats());

  // happy-dom has no rendering engine: an <img> never fires load/error for a
  // blob SVG, and canvas.getContext("2d") is null — so the REAL rasterization
  // is covered by the manual extension E2E (spec 005a Task 6). What IS
  // testable against a real happy-dom document is the freeze guard: a decode
  // that never settles must reject (→ the engine's code-block fallback route)
  // instead of hanging the whole export.
  it("rejects instead of hanging when the SVG never decodes", async () => {
    const window = new Window();
    const doc = window.document as unknown as Document;
    const rasterizer = canvasSvgRasterizer(doc, 50);
    expect(
      rasterizer.rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', {
        widthPx: 4,
        heightPx: 4,
      })
    ).rejects.toThrow("did not decode within 50 ms");
  });

  it("encodes synchronously without entering the asynchronous toBlob callback path", async () => {
    let toBlobCalled = false;
    let revoked = false;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,AQIDBA==",
      toBlob: () => {
        toBlobCalled = true;
      },
    };
    const doc = {
      defaultView: {
        URL: {
          createObjectURL: () => "blob:test",
          revokeObjectURL: () => {
            revoked = true;
          },
        },
        Blob,
        Image: FakeImage,
        atob,
      },
      createElement: () => canvas,
    } as unknown as Document;

    const bytes = await canvasSvgRasterizer(doc).rasterize("<svg/>", {
      widthPx: 8,
      heightPx: 6,
    });

    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(canvas.width).toBe(8);
    expect(canvas.height).toBe(6);
    expect(toBlobCalled).toBe(false);
    expect(revoked).toBe(true);
  });

  it("keeps exact per-call and summed timing statistics in the extension host", async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,AQIDBA==",
    };
    const doc = {
      defaultView: {
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
        Blob,
        Image: FakeImage,
        atob,
      },
      createElement: () => canvas,
    } as unknown as Document;
    const values = [0, 5, 5, 8, 8, 12, 12, 14, 14, 15, 15, 21];
    const originalNow = Date.now;
    Date.now = () => values.shift()!;
    try {
      const rasterizer = canvasSvgRasterizer(doc);
      await rasterizer.rasterize("<svg/>", { widthPx: 8, heightPx: 6 });
      await rasterizer.rasterize("<svg/>", { widthPx: 8, heightPx: 6 });
    } finally {
      Date.now = originalNow;
    }

    expect(getRasterizerStats()).toEqual({
      calls: 2,
      decodeMs: 7,
      drawMs: 4,
      encodeMs: 10,
      encodeCallsMs: [4, 6],
    });
  });

  it("resets between exports and returns defensive timing snapshots", () => {
    const snapshot = getRasterizerStats();
    snapshot.calls = 9;
    snapshot.encodeCallsMs.push(99);
    expect(getRasterizerStats()).toEqual({
      calls: 0,
      decodeMs: 0,
      drawMs: 0,
      encodeMs: 0,
      encodeCallsMs: [],
    });

    resetRasterizerStats();
    expect(getRasterizerStats()).toEqual({
      calls: 0,
      decodeMs: 0,
      drawMs: 0,
      encodeMs: 0,
      encodeCallsMs: [],
    });
  });

});

describe("downloadOutputSink", () => {
  it("clicks a temporary anchor carrying the filename and blob URL", async () => {
    const window = new Window();
    const doc = window.document as unknown as Document;

    let clicked: HTMLAnchorElement | null = null;
    doc.body.addEventListener("click", (e) => {
      clicked = e.target as HTMLAnchorElement;
      e.preventDefault(); // keep happy-dom from navigating to the blob URL
    });

    await downloadOutputSink(doc).emit("Page.docx", new Uint8Array([80, 75, 3, 4]));

    expect(clicked).not.toBeNull();
    expect(clicked!.download).toBe("Page.docx");
    expect(clicked!.href).toStartWith("blob:");
    // The anchor was transient — removed after the click.
    expect(doc.body.querySelector("a")).toBeNull();
  });
});

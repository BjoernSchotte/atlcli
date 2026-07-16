/**
 * Extension env adapters for the isomorphic export engine (spec 006 Task 3).
 *
 * Per the repo's real-infra directive: the template source runs against
 * fake-indexeddb (spec-complete IndexedDB, real transactions), the download
 * sink against a happy-dom document; only the network `fetch` is stubbed.
 */
import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { Window } from "happy-dom";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import {
  canvasSvgRasterizer,
  downloadOutputSink,
  idbTemplateSource,
  memoryTemplateSource,
  sessionAssetFetcher,
} from "../../utils/docx/env.js";
import { putTemplate } from "../../utils/docx/template-store.js";

describe("idbTemplateSource", () => {
  it("returns the stored template bytes for the requested slot", async () => {
    const factory = new IDBFactory();
    const docx = buildDocx({ body: para("$scroll.title") });
    const buf = docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength) as ArrayBuffer;
    await putTemplate({ id: "current", name: "t.docx", bytes: buf, uploadedAt: 1 }, factory);

    const bytes = await idbTemplateSource(factory).getBytes("current");
    expect(bytes).toEqual(docx);
  });

  it("rejects when no template is stored under the id", async () => {
    const factory = new IDBFactory();
    expect(idbTemplateSource(factory).getBytes("current")).rejects.toThrow(
      'No template stored under id "current"'
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

describe("canvasSvgRasterizer", () => {
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

/**
 * Extension env adapters for the isomorphic export engine (spec 006 Task 3).
 *
 * Per the repo's real-infra directive: the template source runs against
 * fake-indexeddb (spec-complete IndexedDB, real transactions), the download
 * sink against a happy-dom document; only the network `fetch` is stubbed.
 */
import { beforeEach, describe, expect, it } from "bun:test";
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

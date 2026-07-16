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
  downloadOutputSink,
  idbTemplateSource,
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

describe("sessionAssetFetcher", () => {
  it("fetches with session credentials and returns the bytes", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const payload = new Uint8Array([1, 2, 3]);
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(payload.slice());
    }) as typeof fetch;

    const bytes = await sessionAssetFetcher(fetchFn).fetch({
      url: "https://x.atlassian.net/wiki/download/attachments/1/a.png",
      filename: "a.png",
    });

    expect(bytes).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("throws with status + filename on a non-OK response", async () => {
    const fetchFn = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect(
      sessionAssetFetcher(fetchFn).fetch({ url: "https://x/att", filename: "a.png" })
    ).rejects.toThrow("Asset fetch failed (403) for a.png");
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

/**
 * `PdfBytesHandle` (spec 010, T5.6; wave-1 review C2/C3).
 *
 * No production caller uses `objectUrl()` yet — T5.3's viewer is the first, and
 * it is the caller most likely to race itself (a re-render while the previous
 * mint is still awaiting `asBlob()`). These pin the ownership rules before that
 * lands rather than after.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  isPdfBytesHandle,
  pdfBytesFromBlob,
  pdfBytesFromUint8Array,
  type PdfBytesHandle,
} from "./bytes-handle.js";

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

/** Count every mint and revoke so a LEAK is observable, not just a wrong value. */
function trackObjectUrls(): { minted: string[]; revoked: string[]; live: () => string[] } {
  const minted: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  URL.createObjectURL = ((_blob: Blob) => {
    const url = `blob:test/${n++}`;
    minted.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  return { minted, revoked, live: () => minted.filter((url) => !revoked.includes(url)) };
}

describe("PdfBytesHandle", () => {
  it("reports size and mime type without materializing anything", () => {
    const handle = pdfBytesFromUint8Array(new Uint8Array(2048));
    expect(handle.size).toBe(2048);
    expect(handle.mimeType).toBe("application/pdf");
    expect(isPdfBytesHandle(handle)).toBe(true);
    expect(isPdfBytesHandle({})).toBe(false);
  });

  it("memoizes conversions so the same bytes are never shaped twice at once", async () => {
    const handle = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
    expect(await handle.asBlob()).toBe(await handle.asBlob());
    expect(await handle.asUint8Array()).toBe(await handle.asUint8Array());
  });

  describe("objectUrl() ownership (review C2)", () => {
    it("mints exactly one URL for CONCURRENT callers", async () => {
      // The regression: `if (url === undefined) url = createObjectUrl(await …)`
      // tested `url` BEFORE an await, so both callers found it unset, both
      // minted, the second assignment clobbered the first, and `release()` could
      // only revoke what it could still see. The first URL — with the whole
      // document pinned behind it — leaked for the life of the page.
      const urls = trackObjectUrls();
      const handle = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));

      const [a, b, c] = await Promise.all([
        handle.objectUrl(),
        handle.objectUrl(),
        handle.objectUrl(),
      ]);
      expect(urls.minted).toHaveLength(1);
      expect(a).toBe(b);
      expect(b).toBe(c);

      handle.release();
      expect(urls.live()).toEqual([]);
    });

    it("mints exactly one URL for sequential callers", async () => {
      const urls = trackObjectUrls();
      const handle = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
      expect(await handle.objectUrl()).toBe(await handle.objectUrl());
      expect(urls.minted).toHaveLength(1);
      handle.release();
      expect(urls.live()).toEqual([]);
    });

    it("leaves nothing live after release, however many callers raced", async () => {
      const urls = trackObjectUrls();
      const handle = pdfBytesFromUint8Array(new Uint8Array([9]));
      await Promise.all(Array.from({ length: 8 }, () => handle.objectUrl()));
      handle.release();
      expect(urls.minted.length).toBeGreaterThan(0);
      expect(urls.live()).toEqual([]);
    });

    it("mints a fresh URL after release, and does not revoke the old one twice", async () => {
      const urls = trackObjectUrls();
      const handle = pdfBytesFromUint8Array(new Uint8Array([1]));
      const first = await handle.objectUrl();
      handle.release();
      const second = await handle.objectUrl();
      expect(second).not.toBe(first);
      expect(urls.minted).toHaveLength(2);
      expect(urls.revoked).toEqual([first]);
      handle.release();
      expect(urls.revoked).toEqual([first, second]);
      expect(urls.live()).toEqual([]);
    });

    it("revokes rather than hands out a URL minted across a release", async () => {
      const urls = trackObjectUrls();
      // A blob that resolves on a later turn, so `release()` can land inside the
      // mint — the window a same-turn implementation cannot even express.
      const slow: PdfBytesHandle = pdfBytesFromBlob(
        new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" })
      );
      const pending = slow.objectUrl();
      slow.release();
      await expect(pending).rejects.toThrow(/released while objectUrl\(\) was still resolving/);
      // The URL WAS minted (the mint had already started) and then revoked —
      // asserting only `live() === []` would also pass if nothing were minted.
      expect(urls.minted).toHaveLength(1);
      expect(urls.revoked).toEqual(urls.minted);
    });

    it("explains itself when the runtime has no createObjectURL", async () => {
      URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
      const handle = pdfBytesFromUint8Array(new Uint8Array([1]));
      await expect(handle.objectUrl()).rejects.toThrow(/requires URL.createObjectURL/);
    });
  });

  /**
   * The borrow contract, pinned (review C3).
   *
   * `asUint8Array()` returning the backing array rather than a copy is a
   * DECISION — the handle exists to stop a second 64 MiB materialization, and
   * copying here would put it straight back. These tests exist so that decision
   * is visible and cannot be reversed (in either direction) by accident.
   */
  describe("asUint8Array() borrow contract (review C3)", () => {
    it("hands back the backing array itself, not a defensive copy", async () => {
      const source = new Uint8Array([1, 2, 3]);
      const handle = pdfBytesFromUint8Array(source);
      expect(await handle.asUint8Array()).toBe(source);
    });

    it("is a shared borrow: a mutation by one consumer is visible to the other", async () => {
      // Documenting the hazard, not endorsing it. A consumer that needs to
      // mutate must copy first — see the module comment.
      const handle = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
      const first = await handle.asUint8Array();
      const second = await handle.asUint8Array();
      first[0] = 99;
      expect(second[0]).toBe(99);

      // ...and the documented escape hatch actually insulates a caller.
      const copy = new Uint8Array(await handle.asUint8Array());
      copy[1] = 42;
      expect((await handle.asUint8Array())[1]).toBe(2);
    });

    it("gives a Blob-backed handle its own array, since it has no array to borrow", async () => {
      const handle = pdfBytesFromBlob(new Blob([new Uint8Array([1, 2, 3])]));
      const first = await handle.asUint8Array();
      first[0] = 99;
      // Memoized, so the SAME borrowed array comes back — the contract is the
      // same regardless of backing store.
      expect((await handle.asUint8Array())[0]).toBe(99);
    });

    it("does not snapshot: a caller that mutates the source mutates the handle", async () => {
      const source = new Uint8Array([1, 2, 3]);
      const handle = pdfBytesFromUint8Array(source);
      source[0] = 7;
      expect((await handle.asUint8Array())[0]).toBe(7);
      expect(new Uint8Array(await (await handle.asBlob()).arrayBuffer())[0]).toBe(7);
    });
  });
});

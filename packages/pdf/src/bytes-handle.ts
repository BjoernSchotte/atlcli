/**
 * `PdfBytesHandle` — the cross-layer contract for compiled PDF bytes
 * (spec 010, T5.6; Architecture point 9).
 *
 * ## Why a handle and not a `Uint8Array`
 *
 * Every layer that touches a finished PDF used to take the byte array itself,
 * so every layer that wanted a different *shape* of those bytes made its own
 * copy. Measured (`packages/pdf/scripts/bytes-memory.bench.ts`, Bun 1.3.8 /
 * JSC, arm64):
 *
 *   - `apps/extension/utils/download.ts` built `new Blob([bytes])` while the
 *     caller's `Uint8Array` was still reachable: **+32.0 MiB for a 32 MiB PDF,
 *     +64.0 MiB for a 64 MiB one** — a full second copy of the whole document,
 *     live at the same time as the first.
 *
 * A handle owns one representation and converts on demand, memoizing the
 * result, so the same bytes are never materialized twice in two shapes at once.
 * It also gives the preview cache (T5.3) and retained background jobs (T5.6) a
 * type they can both hold without either of them deciding how bytes are stored.
 *
 * ## Storage format: `Uint8Array`, and why
 *
 * Architecture point 9 proposed backing the handle with a `Blob` kept in
 * IndexedDB, on two assumptions:
 *
 *   (i)  a Chrome IndexedDB `Blob` stays out-of-heap on `get()`; and
 *   (ii) PDF.js range-/chunk-loads from a `blob:` URL rather than buffering it.
 *
 * **Both are UNVERIFIED.** They cannot be answered from a Bun/`fake-indexeddb`
 * harness — the polyfill has no out-of-line blob store, and PDF.js is not
 * loaded there (see the measurement task's report). The PLAN is explicit about
 * what happens in that case: the seam still stands, but the storage decision
 * *reverts to `Uint8Array` and is recorded as such*. That is what
 * {@link pdfBytesFromUint8Array} is.
 *
 * The seam is what makes that reversible. {@link pdfBytesFromBlob} already
 * exists, so if someone later attaches DevTools and confirms (i) and (ii), the
 * change is a different factory at the storage boundary — no consumer moves.
 *
 * ## Why every accessor is async
 *
 * A `Uint8Array`-backed handle could answer all of these synchronously. They
 * return promises anyway, because a `Blob`-backed one cannot (`asUint8Array()`
 * is `await blob.arrayBuffer()`), and a seam whose signature has to change the
 * day the backing store changes is not a seam.
 */

/**
 * A reference to one compiled PDF document's bytes, independent of how they are
 * stored.
 *
 * Handles are cheap to pass and hold. Conversions are memoized, so calling
 * `asBlob()` twice yields the same `Blob` rather than a second copy.
 */
export interface PdfBytesHandle {
  /**
   * Byte length of the document.
   *
   * Deliberately synchronous and always known without materializing anything:
   * quota accounting (`PDF_STORE_MAX_BYTES`) reads this, and a quota check that
   * had to load payloads to add numbers is exactly the defect T5.6 removes.
   */
  readonly size: number;
  /** MIME type handed to `Blob`/`objectUrl` consumers. */
  readonly mimeType: string;
  /** The bytes as a `Blob`. O(1) once materialized; memoized. */
  asBlob(): Promise<Blob>;
  /**
   * The bytes as a `Uint8Array`. Prefer {@link asBlob} where the consumer only
   * needs to hand the bytes to a browser API — this may materialize a heap copy
   * when the handle is not array-backed.
   */
  asUint8Array(): Promise<Uint8Array>;
  /**
   * A `blob:` URL for the bytes, memoized so repeated calls do not leak a URL
   * per call. The handle owns revocation: call {@link release} when done.
   */
  objectUrl(): Promise<string>;
  /**
   * Revoke any object URL this handle handed out and drop memoized
   * conversions. The handle stays usable — a later `objectUrl()` mints a new
   * one — so this is a "done with it for now", not a close.
   */
  release(): void;
}

const PDF_MIME = "application/pdf";

function createObjectUrl(blob: Blob): string {
  const url = globalThis.URL;
  if (typeof url?.createObjectURL !== "function") {
    throw new Error(
      "PdfBytesHandle.objectUrl() requires URL.createObjectURL, which this runtime does not provide. " +
        "Use asUint8Array() or asBlob() outside a browser."
    );
  }
  return url.createObjectURL(blob);
}

function revokeObjectUrl(value: string): void {
  globalThis.URL?.revokeObjectURL?.(value);
}

/** Shared memoization + URL ownership for both factories below. */
function handle(
  size: number,
  mimeType: string,
  load: { blob(): Promise<Blob>; bytes(): Promise<Uint8Array> }
): PdfBytesHandle {
  let blob: Promise<Blob> | undefined;
  let bytes: Promise<Uint8Array> | undefined;
  let url: string | undefined;

  return {
    size,
    mimeType,
    asBlob() {
      blob ??= load.blob();
      return blob;
    },
    asUint8Array() {
      bytes ??= load.bytes();
      return bytes;
    },
    async objectUrl() {
      if (url === undefined) url = createObjectUrl(await this.asBlob());
      return url;
    },
    release() {
      if (url !== undefined) {
        revokeObjectUrl(url);
        url = undefined;
      }
      blob = undefined;
      bytes = undefined;
    },
  };
}

/**
 * The default factory: a handle over bytes already in the JS heap.
 *
 * This is the storage format of record (see the module comment) until the two
 * assumptions behind a `Blob`-backed store are actually measured in Chrome.
 */
export function pdfBytesFromUint8Array(
  source: Uint8Array,
  options: { mimeType?: string } = {}
): PdfBytesHandle {
  const mimeType = options.mimeType ?? PDF_MIME;
  return handle(source.byteLength, mimeType, {
    blob: async () => new Blob([source as BlobPart], { type: mimeType }),
    // The array IS the backing store, so this hands back the same buffer rather
    // than copying — a consumer that mutates it mutates the handle's bytes.
    bytes: async () => source,
  });
}

/**
 * A handle over a `Blob` — for a host that already has one (a `fetch` response,
 * an IndexedDB `Blob` value) and should not pay to flatten it into the heap.
 *
 * Not used by the extension host today: the storage-format decision reverted to
 * `Uint8Array` because the out-of-heap assumption is unverified. It exists so
 * that decision is a one-line change if someone verifies it.
 */
export function pdfBytesFromBlob(source: Blob, options: { mimeType?: string } = {}): PdfBytesHandle {
  const mimeType = options.mimeType ?? source.type ?? PDF_MIME;
  return handle(source.size, mimeType, {
    blob: async () => source,
    bytes: async () => new Uint8Array(await source.arrayBuffer()),
  });
}

/** True for anything satisfying the {@link PdfBytesHandle} shape. */
export function isPdfBytesHandle(value: unknown): value is PdfBytesHandle {
  const candidate = value as Partial<PdfBytesHandle> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.size === "number" &&
    typeof candidate.asBlob === "function" &&
    typeof candidate.asUint8Array === "function" &&
    typeof candidate.objectUrl === "function"
  );
}

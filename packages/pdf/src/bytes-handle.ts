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
 * The real Chrome/V8 harness (`bun run bench:memory-chrome`) answered both on
 * Chrome 140. Reading a 16 MiB IndexedDB `Blob` added no V8 backing storage,
 * while the same `Uint8Array` added 16 MiB: (i) is confirmed. Chrome also
 * served a 64 KiB `Range` request against a `blob:` URL with `206`, but the
 * newly-created PDF.js worker retained 10.83 MiB of backing storage for an
 * 8.30 MiB PDF: (ii)'s chunk-only-retention premise is not confirmed.
 *
 * The PLAN requires both assumptions before changing the durable format. The
 * seam therefore stands, but storage remains `Uint8Array` and the Blob-store
 * migration is explicitly dropped. That is what
 * {@link pdfBytesFromUint8Array} represents.
 *
 * The seam is what makes that reversible. {@link pdfBytesFromBlob} already
 * exists, so a future PDF.js/runtime change can be remeasured and adopted by
 * changing the factory at the storage boundary — no consumer moves.
 *
 * ## Why every accessor is async
 *
 * A `Uint8Array`-backed handle could answer all of these synchronously. They
 * return promises anyway, because a `Blob`-backed one cannot (`asUint8Array()`
 * is `await blob.arrayBuffer()`), and a seam whose signature has to change the
 * day the backing store changes is not a seam.
 *
 * ## The `asUint8Array()` borrow contract
 *
 * `asUint8Array()` hands back a **borrowed reference to the handle's backing
 * bytes, not a copy.** Two consumers that both call it hold the same object;
 * mutating it, or detaching its `ArrayBuffer`, changes (or destroys) what every
 * other consumer — and the handle itself — will read. This is a deliberate
 * decision, not an oversight, and it is pinned by a test in
 * `bytes-handle.test.ts` so it cannot drift silently.
 *
 * Returning a copy was the alternative, and it was rejected: this handle exists
 * *because* `new Blob([bytes])` next to a live `Uint8Array` was measured at
 * +64.0 MiB for a 64 MiB document. Copying on every `asUint8Array()` — or even
 * memoizing one defensive copy — puts that exact allocation back, to defend
 * against a mutation that no consumer in the codebase performs. A handle whose
 * safety property is "it duplicates the thing it was built to stop
 * duplicating" is not worth having.
 *
 * So the obligation sits with the consumer, and it is short:
 *
 *   - **Read-only? Just use it.** The Node sink, the download path, size
 *     accounting and hashing all read and never write.
 *   - **Need to mutate?** `new Uint8Array(await h.asUint8Array())` first.
 *   - **Handing the bytes to something that may TRANSFER the buffer?** Copy
 *     first. `pdfjs.getDocument({ data })` is the live example: PDF.js may
 *     transfer `data`'s `ArrayBuffer` to its worker, which detaches it and
 *     leaves every other holder — including this handle — with a zero-length
 *     view. Prefer {@link PdfBytesHandle.objectUrl} or
 *     {@link PdfBytesHandle.asBlob} there; PDF.js accepts a URL and never
 *     detaches anything.
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
   * The bytes as a `Uint8Array`, **borrowed, not owned** — see
   * "The `asUint8Array()` borrow contract" in the module comment. Treat the
   * result as read-only and do not detach its buffer; `slice()` it if you need
   * either. Prefer {@link asBlob} where the consumer only needs to hand the
   * bytes to a browser API — this may materialize a heap copy when the handle
   * is not array-backed.
   */
  asUint8Array(): Promise<Uint8Array>;
  /**
   * A `blob:` URL for the bytes, memoized so repeated calls do not leak a URL
   * per call — including *concurrent* calls, which is the harder half. The
   * handle owns revocation: call {@link release} when done.
   *
   * Rejects if {@link release} lands while the URL is still being minted: the
   * URL is revoked rather than handed to a caller that would be holding a
   * reference the handle no longer owns.
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
  let pendingUrl: Promise<string> | undefined;
  /**
   * Bumped by every `release()`. A mint that started before a release finishes
   * into a handle that has already given its URL up, and must not install it.
   */
  let generation = 0;

  const self: PdfBytesHandle = {
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
    objectUrl() {
      // Memoize the PROMISE, not the settled URL. Testing `url === undefined`
      // *before* an `await` let two concurrent callers both find it unset and
      // both call `createObjectURL`; the second assignment then overwrote the
      // first, `release()` revoked only what it could still see, and the other
      // URL — with its whole document pinned behind it — leaked for the life of
      // the page. T5.3's viewer is the first caller that will race itself.
      pendingUrl ??= (async () => {
        const mintedAt = generation;
        const created = createObjectUrl(await self.asBlob());
        if (mintedAt !== generation) {
          revokeObjectUrl(created);
          throw new Error("PdfBytesHandle was released while objectUrl() was still resolving.");
        }
        url = created;
        return created;
      })();
      return pendingUrl;
    },
    release() {
      generation += 1;
      if (url !== undefined) {
        revokeObjectUrl(url);
        url = undefined;
      }
      pendingUrl = undefined;
      blob = undefined;
      bytes = undefined;
    },
  };
  return self;
}

/**
 * The default factory: a handle over bytes already in the JS heap.
 *
 * This is the measured storage format of record; see the module comment.
 */
export function pdfBytesFromUint8Array(
  source: Uint8Array,
  options: { mimeType?: string } = {}
): PdfBytesHandle {
  const mimeType = options.mimeType ?? PDF_MIME;
  return handle(source.byteLength, mimeType, {
    blob: async () => new Blob([source as BlobPart], { type: mimeType }),
    // The array IS the backing store, so this hands back the same object rather
    // than copying — a consumer that mutates or detaches it mutates or destroys
    // the handle's bytes. Deliberate; see "The `asUint8Array()` borrow
    // contract" in the module comment for why copying here is the worse trade.
    bytes: async () => source,
  });
}

/**
 * A handle over a `Blob` — for a host that already has one (a `fetch` response,
 * an IndexedDB `Blob` value) and should not pay to flatten it into the heap.
 *
 * Not used by the extension host today: Chrome keeps the Blob out of V8's
 * backing store, but the measured PDF.js worker did not demonstrate
 * chunk-only retention. It exists so a future remeasurement can change that
 * decision at one boundary.
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

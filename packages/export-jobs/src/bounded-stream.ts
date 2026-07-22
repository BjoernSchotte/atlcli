/** Limits shared by all reservations admitted through one semaphore. */
export interface ByteReservationLimitsV1 {
  /** Maximum bytes held by granted reservations at one time. */
  maxBytes: number;
  /** Maximum granted reservations at one time. */
  maxReservations: number;
}

/** Observable counters for diagnostics and deterministic tests. */
export interface ByteReservationSnapshotV1 {
  reservedBytes: number;
  activeReservations: number;
  queuedReservations: number;
}

/** One count slot and its exact byte charge. Release is idempotent. */
export interface ByteReservationV1 {
  readonly byteLength: number;
  readonly released: boolean;
  release(): void;
}

export type BoundedByteErrorCodeV1 =
  | "invalid-limit"
  | "invalid-byte-length"
  | "reservation-too-large"
  | "chunk-too-large"
  | "stream-too-large"
  | "invalid-chunk";

/** Stable, host-neutral failures for byte-budget enforcement. */
export class BoundedByteErrorV1 extends Error {
  readonly code: BoundedByteErrorCodeV1;

  constructor(code: BoundedByteErrorCodeV1, message: string) {
    super(message);
    this.name = "BoundedByteErrorV1";
    this.code = code;
  }
}

interface PendingReservation {
  byteLength: number;
  signal?: AbortSignal;
  abort?: () => void;
  resolve: (reservation: ByteReservationV1) => void;
  reject: (reason: unknown) => void;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BoundedByteErrorV1(
      "invalid-limit",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function reservationByteLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BoundedByteErrorV1(
      "invalid-byte-length",
      "Reservation byte length must be a non-negative safe integer.",
    );
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Byte reservation aborted.", "AbortError");
}

/**
 * FIFO byte-and-count semaphore used to bound concurrent fetch and buffer work.
 *
 * Cancellation removes a waiter before it owns capacity. Once granted, the
 * caller owns the reservation and must release it in a `finally` block. An
 * already granted reservation is deliberately not auto-released on abort:
 * releasing while its operation still touches the bytes would over-admit work.
 */
export class ByteReservationSemaphoreV1 {
  readonly limits: Readonly<ByteReservationLimitsV1>;

  #reservedBytes = 0;
  #activeReservations = 0;
  #queue: PendingReservation[] = [];

  constructor(limits: ByteReservationLimitsV1) {
    this.limits = Object.freeze({
      maxBytes: positiveSafeInteger(limits.maxBytes, "maxBytes"),
      maxReservations: positiveSafeInteger(limits.maxReservations, "maxReservations"),
    });
  }

  get snapshot(): ByteReservationSnapshotV1 {
    return {
      reservedBytes: this.#reservedBytes,
      activeReservations: this.#activeReservations,
      queuedReservations: this.#queue.length,
    };
  }

  reserve(byteLength: number, options: { signal?: AbortSignal } = {}): Promise<ByteReservationV1> {
    const checkedLength = reservationByteLength(byteLength);
    if (checkedLength > this.limits.maxBytes) {
      return Promise.reject(
        new BoundedByteErrorV1(
          "reservation-too-large",
          `Reservation requires ${checkedLength} bytes; limit is ${this.limits.maxBytes}.`,
        ),
      );
    }
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));

    return new Promise<ByteReservationV1>((resolve, reject) => {
      const pending: PendingReservation = {
        byteLength: checkedLength,
        signal: options.signal,
        resolve,
        reject,
      };

      if (options.signal) {
        pending.abort = () => {
          const index = this.#queue.indexOf(pending);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          reject(abortReason(options.signal!));
          this.#drain();
        };
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }

      this.#queue.push(pending);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const pending = this.#queue[0]!;
      if (
        this.#activeReservations >= this.limits.maxReservations ||
        this.#reservedBytes + pending.byteLength > this.limits.maxBytes
      ) {
        return;
      }

      this.#queue.shift();
      if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
      this.#reservedBytes += pending.byteLength;
      this.#activeReservations += 1;

      let released = false;
      const reservation: ByteReservationV1 = {
        byteLength: pending.byteLength,
        get released(): boolean {
          return released;
        },
        release: () => {
          if (released) return;
          released = true;
          this.#reservedBytes -= pending.byteLength;
          this.#activeReservations -= 1;
          this.#drain();
        },
      };
      pending.resolve(reservation);
    }
  }
}

/** Limits checked incrementally when a source has no trusted total length. */
export interface BoundedByteStreamLimitsV1 {
  maxChunkBytes: number;
  maxTotalBytes: number;
}

export interface BoundedByteChunkContextV1 {
  /** Zero-based non-empty chunk index. */
  index: number;
  /** Total source bytes observed through this chunk. */
  observedBytes: number;
}

/**
 * Copy a view into a minimally sized, exclusively owned ArrayBuffer.
 * This prevents retaining or persisting an oversized source backing buffer.
 */
export function copyExactOwnedBytesV1(chunk: Uint8Array): Uint8Array {
  if (!(chunk instanceof Uint8Array)) {
    throw new BoundedByteErrorV1("invalid-chunk", "Byte sources must yield Uint8Array chunks.");
  }
  const owned = new Uint8Array(chunk.byteLength);
  owned.set(chunk);
  return owned;
}

function assertStreamLimits(limits: BoundedByteStreamLimitsV1): void {
  positiveSafeInteger(limits.maxChunkBytes, "maxChunkBytes");
  positiveSafeInteger(limits.maxTotalBytes, "maxTotalBytes");
}

/**
 * Consume unknown-length bytes with shared count/byte backpressure.
 *
 * Each callback receives an exact-owned chunk. Its reservation is held until
 * the callback settles and is then released deterministically, including on
 * copy, callback, limit, and cancellation failures. The callback must not keep
 * the chunk after it settles; durable consumers should copy it into their
 * backend before returning.
 */
export async function consumeBoundedByteStreamV1(
  source: AsyncIterable<Uint8Array>,
  semaphore: ByteReservationSemaphoreV1,
  limits: BoundedByteStreamLimitsV1,
  consume: (chunk: Uint8Array, context: BoundedByteChunkContextV1) => void | Promise<void>,
  options: { signal?: AbortSignal } = {},
): Promise<{ byteLength: number; chunkCount: number }> {
  assertStreamLimits(limits);
  let observedBytes = 0;
  let chunkCount = 0;

  for await (const chunk of source) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (!(chunk instanceof Uint8Array)) {
      throw new BoundedByteErrorV1("invalid-chunk", "Byte sources must yield Uint8Array chunks.");
    }
    if (chunk.byteLength === 0) continue;
    if (chunk.byteLength > limits.maxChunkBytes) {
      throw new BoundedByteErrorV1(
        "chunk-too-large",
        `Chunk requires ${chunk.byteLength} bytes; limit is ${limits.maxChunkBytes}.`,
      );
    }
    if (
      !Number.isSafeInteger(observedBytes + chunk.byteLength) ||
      observedBytes + chunk.byteLength > limits.maxTotalBytes
    ) {
      throw new BoundedByteErrorV1(
        "stream-too-large",
        `Stream exceeds its ${limits.maxTotalBytes}-byte limit.`,
      );
    }

    const reservation = await semaphore.reserve(chunk.byteLength, { signal: options.signal });
    try {
      const owned = copyExactOwnedBytesV1(chunk);
      observedBytes += owned.byteLength;
      await consume(owned, { index: chunkCount, observedBytes });
      chunkCount += 1;
    } finally {
      reservation.release();
    }
  }

  if (options.signal?.aborted) throw abortReason(options.signal);
  return { byteLength: observedBytes, chunkCount };
}

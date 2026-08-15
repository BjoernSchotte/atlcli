import { describe, expect, it } from "bun:test";
import {
  ByteReservationSemaphoreV1,
  consumeBoundedByteStreamV1,
  copyExactOwnedBytesV1,
} from "./bounded-stream.js";

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached within the microtask budget.");
}

describe("ByteReservationSemaphoreV1", () => {
  it("enforces byte and count limits with FIFO concurrent reservations", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 6, maxReservations: 2 });
    const first = await semaphore.reserve(4);
    let secondGranted = false;
    let thirdGranted = false;
    const secondPromise = semaphore.reserve(4).then((reservation) => {
      secondGranted = true;
      return reservation;
    });
    const thirdPromise = semaphore.reserve(1).then((reservation) => {
      thirdGranted = true;
      return reservation;
    });

    await tick();
    expect({ secondGranted, thirdGranted }).toEqual({ secondGranted: false, thirdGranted: false });
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 4,
      activeReservations: 1,
      queuedReservations: 2,
    });

    first.release();
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 5,
      activeReservations: 2,
      queuedReservations: 0,
    });
    second.release();
    third.release();
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 0,
      activeReservations: 0,
      queuedReservations: 0,
    });
  });

  it("cancels queued reservations without leaking capacity", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    const active = await semaphore.reserve(4);
    const controller = new AbortController();
    const waiting = semaphore.reserve(1, { signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 4,
      activeReservations: 1,
      queuedReservations: 0,
    });

    active.release();
    active.release();
    const recovered = await semaphore.reserve(4);
    expect(recovered.released).toBe(false);
    recovered.release();
    expect(recovered.released).toBe(true);
    expect(semaphore.snapshot.reservedBytes).toBe(0);
  });

  it("rejects impossible reservations without blocking the queue", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    await expect(semaphore.reserve(5)).rejects.toEqual(
      expect.objectContaining({ code: "reservation-too-large" }),
    );
    const reservation = await semaphore.reserve(0);
    expect(semaphore.snapshot).toMatchObject({ reservedBytes: 0, activeReservations: 1 });
    reservation.release();
  });
});

describe("bounded byte stream", () => {
  it("copies small views into exact-owned backing buffers", async () => {
    const backing = new Uint8Array(1024);
    backing.set([7, 8, 9], 511);
    const view = backing.subarray(511, 514);
    const copied = copyExactOwnedBytesV1(view);

    backing[511] = 99;
    expect([...copied]).toEqual([7, 8, 9]);
    expect(copied.byteOffset).toBe(0);
    expect(copied.buffer.byteLength).toBe(copied.byteLength);
    expect(copied.buffer).not.toBe(backing.buffer);
  });

  it("enforces unknown total length after every chunk and releases capacity", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 2 });
    const consumed: number[][] = [];

    await expect(
      consumeBoundedByteStreamV1(
        chunks(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
        semaphore,
        { maxChunkBytes: 4, maxTotalBytes: 5 },
        (chunk) => {
          consumed.push([...chunk]);
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "stream-too-large" }));
    expect(consumed).toEqual([[1, 2, 3]]);
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 0,
      activeReservations: 0,
      queuedReservations: 0,
    });
  });

  it("rejects oversized chunks before reserving bytes", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 8, maxReservations: 2 });
    await expect(
      consumeBoundedByteStreamV1(
        chunks(new Uint8Array(5)),
        semaphore,
        { maxChunkBytes: 4, maxTotalBytes: 8 },
        () => undefined,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "chunk-too-large" }));
    expect(semaphore.snapshot.reservedBytes).toBe(0);
  });

  it("releases a chunk reservation when the consumer throws", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 3, maxReservations: 1 });
    const failure = new Error("backend failed");
    await expect(
      consumeBoundedByteStreamV1(
        chunks(new Uint8Array([1, 2, 3])),
        semaphore,
        { maxChunkBytes: 3, maxTotalBytes: 3 },
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 0,
      activeReservations: 0,
      queuedReservations: 0,
    });
  });

  it("propagates AbortSignal while waiting and leaves no reserved bytes", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 3, maxReservations: 1 });
    const occupied = await semaphore.reserve(3);
    const controller = new AbortController();
    let consumed = false;
    const stream = consumeBoundedByteStreamV1(
      chunks(new Uint8Array([1])),
      semaphore,
      { maxChunkBytes: 3, maxTotalBytes: 3 },
      () => {
        consumed = true;
      },
      { signal: controller.signal },
    );

    await waitUntil(() => semaphore.snapshot.queuedReservations === 1);
    expect(semaphore.snapshot.queuedReservations).toBe(1);
    controller.abort();
    await expect(stream).rejects.toMatchObject({ name: "AbortError" });
    expect(consumed).toBe(false);
    expect(semaphore.snapshot).toEqual({
      reservedBytes: 3,
      activeReservations: 1,
      queuedReservations: 0,
    });

    occupied.release();
    expect(semaphore.snapshot.reservedBytes).toBe(0);
  });

  it("returns deterministic counters and ignores empty source chunks", async () => {
    const semaphore = new ByteReservationSemaphoreV1({ maxBytes: 2, maxReservations: 1 });
    const contexts: Array<{ index: number; observedBytes: number }> = [];
    const result = await consumeBoundedByteStreamV1(
      chunks(new Uint8Array(), new Uint8Array([1]), new Uint8Array([2, 3])),
      semaphore,
      { maxChunkBytes: 2, maxTotalBytes: 3 },
      (_chunk, context) => {
        contexts.push(context);
      },
    );

    expect(result).toEqual({ byteLength: 3, chunkCount: 2 });
    expect(contexts).toEqual([
      { index: 0, observedBytes: 1 },
      { index: 1, observedBytes: 3 },
    ]);
    expect(semaphore.snapshot.reservedBytes).toBe(0);
  });
});

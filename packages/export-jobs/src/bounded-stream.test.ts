import { describe, expect, it } from "bun:test";
import {
  ByteReservationSemaphoreV1,
  copyExactOwnedBytesV1,
} from "./bounded-stream.js";

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
});

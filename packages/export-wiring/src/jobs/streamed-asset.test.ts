import { describe, expect, it } from "bun:test";
import { ByteReservationSemaphoreV1 } from "@atlcli/export-jobs";
import { streamBoundedExportAssetV1 } from "./streamed-asset.js";

async function collect(body: AsyncIterable<Uint8Array>): Promise<number[]> {
  const values: number[] = [];
  for await (const chunk of body) values.push(...chunk);
  return values;
}

describe("streamBoundedExportAssetV1", () => {
  it("reserves a known body before its first producer pull and releases afterward", async () => {
    const reservations = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    let pulled = false;
    const result = await streamBoundedExportAssetV1({
      reference: "asset",
      reservations,
      limits: { maxAssetBytes: 4, maxChunkBytes: 2 },
      source: {
        async fetch() {
          return {
            contentLength: 3,
            body: (async function* () {
              pulled = true;
              expect(reservations.snapshot.reservedBytes).toBe(3);
              yield new Uint8Array([1, 2]);
              yield new Uint8Array([3]);
            })(),
          };
        },
      },
      async persist(body) {
        expect(pulled).toBe(false);
        return collect(body);
      },
    });

    expect(result).toEqual({ result: [1, 2, 3], byteLength: 3, chunkCount: 2 });
    expect(reservations.snapshot.reservedBytes).toBe(0);
  });

  it("reserves the full cap for unknown lengths and rejects an oversized final chunk", async () => {
    const reservations = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    const run = streamBoundedExportAssetV1({
      reference: "asset",
      reservations,
      limits: { maxAssetBytes: 4, maxChunkBytes: 3 },
      source: {
        async fetch() {
          return {
            body: (async function* () {
              expect(reservations.snapshot.reservedBytes).toBe(4);
              yield new Uint8Array([1, 2, 3]);
              yield new Uint8Array([4, 5]);
            })(),
          };
        },
      },
      persist: collect,
    });

    await expect(run).rejects.toMatchObject({ code: "stream-too-large" });
    expect(reservations.snapshot.reservedBytes).toBe(0);
  });

  it("fails closed for lying Content-Length values", async () => {
    const reservations = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    for (const body of [new Uint8Array([1]), new Uint8Array([1, 2, 3])]) {
      await expect(streamBoundedExportAssetV1({
        reference: "asset",
        reservations,
        limits: { maxAssetBytes: 4, maxChunkBytes: 4 },
        source: {
          async fetch() {
            return { contentLength: 2, body: (async function* () { yield body; })() };
          },
        },
        persist: collect,
      })).rejects.toMatchObject({ code: "stream-too-large" });
    }
    expect(reservations.snapshot.reservedBytes).toBe(0);
  });

  it("cancels a queued asset without pulling its body", async () => {
    const reservations = new ByteReservationSemaphoreV1({ maxBytes: 4, maxReservations: 1 });
    const occupied = await reservations.reserve(4);
    const controller = new AbortController();
    let pulled = false;
    const run = streamBoundedExportAssetV1({
      reference: "asset",
      reservations,
      signal: controller.signal,
      limits: { maxAssetBytes: 4, maxChunkBytes: 4 },
      source: {
        async fetch() {
          return { body: (async function* () { pulled = true; yield Uint8Array.of(1); })() };
        },
      },
      persist: collect,
    });

    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(pulled).toBe(false);
    occupied.release();
  });
});

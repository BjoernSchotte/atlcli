import { describe, expect, it } from "bun:test";
import { encodeNfsFrame, NFS_MAX_FRAME_BYTES, readNfsFrames } from "./nfs-framing.js";

async function* chunks(...values: Uint8Array[]) { yield* values; }
async function decode(...values: Uint8Array[]): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const frame of readNfsFrames(chunks(...values))) result.push(frame);
  return result;
}

describe("NFS private pipe framing", () => {
  it("handles every split across headers and multibyte payloads", async () => {
    const value = { id: 7, data: "Grüße 🐴", bytes: "AAH/" };
    const frame = encodeNfsFrame(value);
    for (let split = 0; split <= frame.length; split++) {
      expect(await decode(frame.subarray(0, split), frame.subarray(split))).toEqual([value]);
    }
    expect(await decode(...Array.from(frame, (byte) => Uint8Array.of(byte)))).toEqual([value]);
  });

  it("accepts coalesced messages, JSON primitives and empty streams", async () => {
    expect(await decode(Buffer.concat([encodeNfsFrame(null), encodeNfsFrame({ id: 1 })])))
      .toEqual([null, { id: 1 }]);
    expect(await decode()).toEqual([]);
  });

  it("rejects oversized lengths before reading/allocating the advertised body", async () => {
    for (const size of [0, NFS_MAX_FRAME_BYTES + 1, 0xffffffff]) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(size);
      await expect(decode(header)).rejects.toThrow("frame size");
    }
    expect(() => encodeNfsFrame(undefined)).toThrow("frame size");
    expect(() => encodeNfsFrame("ü".repeat(NFS_MAX_FRAME_BYTES / 2))).toThrow("frame size");
  });

  it("detects EOF during every header/body prefix", async () => {
    const frame = encodeNfsFrame({ id: 1 });
    for (let length = 1; length < frame.length; length++) {
      await expect(decode(frame.subarray(0, length))).rejects.toThrow("Truncated");
    }
  });

  it("rejects invalid UTF-8 and JSON without leaking payload contents", async () => {
    for (const body of [Buffer.from([0x22, 0xff, 0x22]), Buffer.from("secret-tenant-data")]) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      await expect(decode(header, body)).rejects.toThrow("Invalid NFS bridge JSON or UTF-8");
    }
  });

  it("propagates pipe errors and does not pull ahead of the consumer", async () => {
    let pulls = 0;
    async function* pipe() {
      pulls++;
      yield encodeNfsFrame({ id: 1 });
      pulls++;
      throw new Error("pipe closed");
    }
    const frames = readNfsFrames(pipe());
    expect((await frames.next()).value).toEqual({ id: 1 });
    expect(pulls).toBe(1);
    await expect(frames.next()).rejects.toThrow("pipe closed");
  });
});

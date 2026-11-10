import { describe, expect, it } from "bun:test";
import {
  canonicalJson,
  compareCanonicalKeys,
  serialProgressChannel,
  sha256Hex,
  topReportCodes,
} from "./job-internals.js";

describe("job internals", () => {
  it("orders canonical keys by pinned English collation, not the host locale", () => {
    // lt sorts y before k, cs sorts ch after h; an English host always produced this order.
    expect(canonicalJson({ k: 1, y: 2, i: 3, h: 4, ch: 5, d: 6, B: 7, a: 8, c: 9, _x: 10 }))
      .toBe('{"_x":10,"a":8,"B":7,"c":9,"ch":5,"d":6,"h":4,"i":3,"k":1,"y":2}');
    expect(compareCanonicalKeys("k.png", "y.png")).toBeLessThan(0);
    expect(topReportCodes(new Map([["y-code", 1], ["k-code", 1], ["ch-code", 1], ["h-code", 2]])))
      .toEqual([
        { code: "h-code", count: 2 },
        { code: "ch-code", count: 1 },
        { code: "k-code", count: 1 },
        { code: "y-code", count: 1 },
      ]);
  });

  it("rejects non-plain, cyclic and non-finite data only in strict mode", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic, "Payload")).toThrow("Payload contains a cycle.");
    expect(() => canonicalJson({ at: new Date(0) }, "Payload")).toThrow("plain data objects");
    expect(() => canonicalJson({ n: Number.NaN }, "Payload")).toThrow("non-finite");
    expect(canonicalJson({ b: undefined, a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}]}');
  });

  it("hashes exactly the bytes of a typed-array view", async () => {
    const backing = new TextEncoder().encode("xxabcxx");
    expect(await sha256Hex(backing.subarray(2, 5)))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("never leaves a failed progress write as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const failure = new Error("progress store offline");
      const published: number[] = [];
      const channel = serialProgressChannel<number>(async (event) => {
        published.push(event);
        if (event === 2) throw failure;
      });
      channel.callback(1);
      channel.callback(2);
      channel.callback(3);
      // The engine keeps running for many ticks before anyone awaits settled().
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(published).toEqual([1, 2]);
      await expect(channel.settled()).rejects.toBe(failure);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

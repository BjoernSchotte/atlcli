import { describe, expect, it } from "bun:test";
import { canonical, sha256Hex } from "./internal.js";

describe("export-jobs internals", () => {
  it("orders canonical keys by pinned English collation, not the host locale", () => {
    // lt sorts y before k, cs sorts ch after h; an English host always produced this order.
    expect(canonical({ k: 1, y: 2, i: 3, h: 4, ch: 5, d: 6, B: 7, a: 8, c: 9, _x: 10, skip: undefined }))
      .toBe('{"_x":10,"a":8,"B":7,"c":9,"ch":5,"d":6,"h":4,"i":3,"k":1,"y":2}');
  });

  it("hashes exactly the bytes of a typed-array view", async () => {
    const backing = new TextEncoder().encode("xxabcxx");
    expect(await sha256Hex(backing.subarray(2, 5)))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

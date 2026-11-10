import { expect, test } from "bun:test";
import { fnv1a32Utf16Hex, fnv1a32Utf8Hex, sha256Hex } from "./hash.js";

// These digests are persisted in fingerprints and evidence IDs: the vectors
// pin the exact algorithms so a refactor cannot silently change stored data.
test("FNV-1a matches the published 32-bit vectors", () => {
  expect(fnv1a32Utf8Hex("")).toBe("811c9dc5");
  expect(fnv1a32Utf8Hex("a")).toBe("e40c292c");
  expect(fnv1a32Utf8Hex("foobar")).toBe("bf9cf968");
  expect(fnv1a32Utf16Hex("foobar")).toBe("bf9cf968");
});

test("the UTF-8 and UTF-16 variants stay distinct for non-ASCII input", () => {
  // UTF-16 hashes the single unit 0xE4; UTF-8 hashes the bytes 0xC3 0xA4.
  expect(fnv1a32Utf16Hex("ä")).toBe(((Math.imul(0x811c9dc5 ^ 0xe4, 0x01000193)) >>> 0).toString(16).padStart(8, "0"));
  expect(fnv1a32Utf8Hex("ä")).not.toBe(fnv1a32Utf16Hex("ä"));
});

test("SHA-256 matches the FIPS 180 vector", async () => {
  expect(await sha256Hex("abc"))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

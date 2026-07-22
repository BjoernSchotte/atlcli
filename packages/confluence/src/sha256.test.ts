import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { sha256HexSync, sha256HexOfUtf8 } from "./sha256.js";
import { hashContent } from "./markdown.js";

/**
 * Regression proof for the browser-gate fix.
 *
 * `hashContent` used to be `createHash("sha256")` from a bare `crypto` import.
 * Stored hashes in `.atlcli` sync state were produced by that implementation, so
 * the replacement has to be byte-identical — not merely "a SHA-256". Every case
 * here is checked against `node:crypto` itself (legitimate: test files are not
 * part of any browser entrypoint's graph).
 */
describe("sha256 (isomorphic replacement for node:crypto)", () => {
  const nodeHex = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

  test("matches the FIPS 180-4 published vectors", () => {
    expect(sha256HexOfUtf8("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256HexOfUtf8("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(sha256HexOfUtf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
  });

  const CASES: Record<string, string> = {
    empty: "",
    ascii: "Hello, world!",
    // Multi-byte UTF-8 must be encoded the same way `.update(text, "utf8")` did.
    unicode: "Hello \u{1F600} World — äöü 中文",
    newlines: "line1\nline2\r\nline3\n",
    // Block-boundary lengths: 55/56/57 and 63/64/65 bytes exercise the padding
    // branch where the 64-bit length no longer fits in the final block.
    len55: "a".repeat(55),
    len56: "a".repeat(56),
    len57: "a".repeat(57),
    len63: "a".repeat(63),
    len64: "a".repeat(64),
    len65: "a".repeat(65),
    len119: "a".repeat(119),
    len120: "a".repeat(120),
    large: "x".repeat(100_000),
  };

  for (const [name, input] of Object.entries(CASES)) {
    test(`digest matches node:crypto for ${name}`, () => {
      expect(sha256HexOfUtf8(input)).toBe(nodeHex(input));
    });
  }

  test("hashContent is wired to the isomorphic implementation", () => {
    for (const input of Object.values(CASES)) {
      expect(hashContent(input)).toBe(nodeHex(input));
    }
  });

  test("hashes raw bytes, not just strings", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);
    expect(sha256HexSync(bytes)).toBe(
      createHash("sha256").update(Buffer.from(bytes)).digest("hex")
    );
  });

  test("a byte offset view is hashed by its own contents", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    expect(sha256HexSync(view)).toBe(
      createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex")
    );
  });
});

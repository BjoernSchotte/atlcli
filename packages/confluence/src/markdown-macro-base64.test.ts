import { describe, test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeBase64, decodeBase64 } from "@atlcli/core";
import { storageToMarkdown } from "./markdown.js";

/**
 * Regression for finding #6: unknown-macro preservation used the node-only
 * `Buffer` global. In the Chrome panel bundle `Buffer` is `undefined`, so
 * converting ANY page containing an unknown macro threw. The fix routes the
 * base64 encode/decode through the isomorphic `@atlcli/core` helpers.
 */

// An unknown (non-whitelisted) structured macro with a non-ASCII body — the
// case that exercises the UTF-8 base64 round-trip.
const UNKNOWN_MACRO_STORAGE =
  '<p>before</p><ac:structured-macro ac:name="acme-customwidget">' +
  "<ac:parameter ac:name=\"title\">Grüße 你好 — €</ac:parameter>" +
  "<ac:rich-text-body><p>widget body</p></ac:rich-text-body>" +
  "</ac:structured-macro><p>after</p>";

describe("unknown-macro base64 (finding #6)", () => {
  test("encodeBase64/decodeBase64 are byte-identical to the former Buffer path", () => {
    const payload =
      '<ac:structured-macro ac:name="acme-customwidget">Grüße 你好 — €</ac:structured-macro>';
    const viaBuffer = Buffer.from(payload, "utf-8").toString("base64");
    expect(encodeBase64(payload)).toBe(viaBuffer);
    // And the decode is the exact inverse of the former Buffer decode.
    expect(decodeBase64(viaBuffer)).toBe(payload);
    expect(decodeBase64(encodeBase64(payload))).toBe(payload);
  });

  test("markdown.ts source contains no `Buffer` member-access (node global)", () => {
    // Import-specifier scans miss this: `Buffer` is a global, not an import.
    // Match member access (`Buffer.from` etc.) so the doc comment's plain word
    // "Buffer" does not false-positive — usage is what breaks the browser.
    const src = readFileSync(join(import.meta.dir, "markdown.ts"), "utf-8");
    expect(src).not.toMatch(/\bBuffer\s*\./);
  });

  test("storageToMarkdown converts an unknown macro with globalThis.Buffer deleted", () => {
    // Simulate the browser runtime (no Buffer global) in an isolated scope. On
    // the OLD code this threw a ReferenceError; the new code must succeed and
    // produce identical output to the Buffer-present run.
    const withBuffer = storageToMarkdown(UNKNOWN_MACRO_STORAGE);

    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).Buffer;
      const withoutBuffer = storageToMarkdown(UNKNOWN_MACRO_STORAGE);
      expect(withoutBuffer).toBe(withBuffer);
      // The unknown macro is preserved (round-trippable raw payload embedded).
      expect(withoutBuffer).toContain("acme-customwidget");
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });
});

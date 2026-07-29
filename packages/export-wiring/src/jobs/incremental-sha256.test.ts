import { describe, expect, it } from "bun:test";
import { sha256Utf8, utf8Chunks } from "./incremental-sha256.js";

async function webCryptoSha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("incremental UTF-8 SHA-256", () => {
  it("matches WebCrypto without encoding one complete large string", async () => {
    const value = `chapter 😀 ${"äöü<&>".repeat(100_000)}`;
    const chunks = [...utf8Chunks(value)];
    const binding = sha256Utf8(value);

    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThan(200 * 1024);
    expect(binding.byteLength).toBe(new TextEncoder().encode(value).byteLength);
    expect(binding.sha256).toBe(await webCryptoSha256(value));
  });

  it("honours cancellation between UTF-8 chunks", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    expect(() => sha256Utf8("content", controller.signal))
      .toThrow("stop");
  });
});

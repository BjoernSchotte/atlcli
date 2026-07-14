import { describe, expect, it } from "bun:test";
import { isExtRequest, isOffscreenRequest } from "../utils/messages.js";

describe("message guards", () => {
  it("isExtRequest accepts panel requests only", () => {
    expect(isExtRequest({ kind: "ping" })).toBe(true);
    expect(isExtRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(true);
    expect(isExtRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(false);
    expect(isExtRequest({ kind: "pong" })).toBe(false);
    expect(isExtRequest(null)).toBe(false);
    expect(isExtRequest("ping")).toBe(false);
  });

  it("isOffscreenRequest accepts offscreen-bound requests only", () => {
    expect(isOffscreenRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(true);
    expect(isOffscreenRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(false);
    expect(isOffscreenRequest(undefined)).toBe(false);
  });
});

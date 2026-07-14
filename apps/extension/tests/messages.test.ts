import { describe, expect, it } from "bun:test";
import { isEntityChanged, isExtRequest, isOffscreenRequest } from "../utils/messages.js";

describe("message guards", () => {
  it("isExtRequest accepts panel requests only", () => {
    expect(isExtRequest({ kind: "ping" })).toBe(true);
    expect(isExtRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(true);
    expect(isExtRequest({ kind: "get-current-entity" })).toBe(true);
    expect(isExtRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(false);
    expect(isExtRequest({ kind: "pong" })).toBe(false);
    expect(isExtRequest({ kind: "entity-changed", detection: { url: null, entity: null } })).toBe(
      false
    );
    expect(isExtRequest(null)).toBe(false);
    expect(isExtRequest("ping")).toBe(false);
  });

  it("isEntityChanged accepts only the entity-changed push", () => {
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { url: null, entity: null } })
    ).toBe(true);
    expect(isEntityChanged({ kind: "ping" })).toBe(false);
    expect(isEntityChanged({ kind: "current-entity", detection: { url: null, entity: null } })).toBe(
      false
    );
    expect(isEntityChanged(null)).toBe(false);
  });

  it("isOffscreenRequest accepts offscreen-bound requests only", () => {
    expect(isOffscreenRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(true);
    expect(isOffscreenRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(false);
    expect(isOffscreenRequest(undefined)).toBe(false);
  });
});

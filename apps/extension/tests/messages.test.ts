import { describe, expect, it } from "bun:test";
import {
  isEntityChanged,
  isEntityChangedForWindow,
  isExtRequest,
  isOffscreenRequest,
} from "../utils/messages.js";

describe("message guards", () => {
  it("isExtRequest accepts panel requests only", () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const opaqueJobId = "job-1";
    expect(isExtRequest({ kind: "ping" })).toBe(true);
    expect(isExtRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(true);
    expect(isExtRequest({ kind: "get-current-entity", windowId: 7 })).toBe(true);
    expect(isExtRequest({ kind: "get-current-entity" })).toBe(false);
    expect(isExtRequest({ kind: "get-current-entity", windowId: -1 })).toBe(false);
    expect(isExtRequest({ kind: "get-current-entity", windowId: 1.5 })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId })).toBe(true);
    expect(isExtRequest({ kind: "pdf:cancel", jobId })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId] })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], resumeWaiting: true })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", resumeWaiting: true })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], resumeWaiting: "yes" })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [opaqueJobId] })).toBe(true);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: ["   "] })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: ["x".repeat(4_097)] })).toBe(false);
    expect(isExtRequest({ kind: "jobs:wake", jobIds: [jobId], bytes: new Uint8Array([1]) })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId: "bad" })).toBe(false);
    expect(isExtRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(false);
    expect(isExtRequest({ kind: "pong" })).toBe(false);
    expect(isExtRequest({ kind: "entity-changed", detection: { windowId: 7, url: null, entity: null } })).toBe(
      false
    );
    expect(isExtRequest(null)).toBe(false);
    expect(isExtRequest("ping")).toBe(false);
  });

  it("isEntityChanged accepts only the entity-changed push", () => {
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { windowId: 7, url: null, entity: null } })
    ).toBe(true);
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { url: null, entity: null } })
    ).toBe(false);
    expect(
      isEntityChanged({ kind: "entity-changed", detection: { windowId: -1, url: null, entity: null } })
    ).toBe(false);
    expect(isEntityChanged({ kind: "ping" })).toBe(false);
    expect(isEntityChanged({ kind: "current-entity", detection: { windowId: 7, url: null, entity: null } })).toBe(
      false
    );
    expect(isEntityChanged(null)).toBe(false);
  });

  it("matches entity-changed broadcasts only to their owning window", () => {
    const message = {
      kind: "entity-changed",
      detection: { windowId: 7, url: null, entity: null },
    };
    expect(isEntityChangedForWindow(message, 7)).toBe(true);
    expect(isEntityChangedForWindow(message, 8)).toBe(false);
    expect(isEntityChangedForWindow({ kind: "ping" }, 7)).toBe(false);
  });

  it("isOffscreenRequest accepts offscreen-bound requests only", () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    expect(isOffscreenRequest({ kind: "offscreen:wasm-add", a: 1, b: 2 })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-cancel", jobId })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", jobIds: [jobId] })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:jobs-wake",
      jobIds: [jobId],
      resumeWaiting: true,
    })).toBe(true);
    expect(isOffscreenRequest({
      kind: "offscreen:jobs-wake",
      resumeWaiting: true,
    })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", jobIds: ["job-1"] })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:jobs-wake", bytes: new Uint8Array([1]) })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId: "bad" })).toBe(false);
    expect(isOffscreenRequest({ kind: "wasm-smoke", a: 1, b: 2 })).toBe(false);
    expect(isOffscreenRequest(undefined)).toBe(false);
  });
});

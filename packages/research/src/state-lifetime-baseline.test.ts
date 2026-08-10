import { describe, expect, test } from "bun:test";
import {
  RESEARCH_NON_SESSION_STATE_LIFETIMES_T0,
  RESEARCH_SESSION_FIELD_LIFETIMES_T0,
  RESEARCH_SESSION_TURN_FIELD_LIFETIMES_T0,
} from "./state-lifetime-baseline.js";

const forbiddenDurableNames = [
  "credential",
  "apiKey",
  "sourceBody",
  "providerCursor",
  "rawTrajectory",
  "quickJsGlobal",
  "tokenChunk",
] as const;

describe("T0 persisted-state lifetime baseline", () => {
  test("assigns exactly one explicit lifetime and resume owner to every inventoried field", () => {
    const entries = [
      ...Object.entries(RESEARCH_SESSION_FIELD_LIFETIMES_T0),
      ...Object.entries(RESEARCH_SESSION_TURN_FIELD_LIFETIMES_T0),
      ...Object.entries(RESEARCH_NON_SESSION_STATE_LIFETIMES_T0),
    ];
    expect(entries.length).toBeGreaterThan(40);
    for (const [field, entry] of entries) {
      expect(field.length).toBeGreaterThan(0);
      expect(entry.lifetime.length).toBeGreaterThan(0);
      expect(entry.resumeOwner.length).toBeGreaterThan(0);
      expect(typeof entry.modelVisible).toBe("boolean");
    }
  });

  test("does not promote secrets, raw bodies, cursors, trajectories, or guest state", () => {
    const persistedFieldNames = [
      ...Object.keys(RESEARCH_SESSION_FIELD_LIFETIMES_T0),
      ...Object.keys(RESEARCH_SESSION_TURN_FIELD_LIFETIMES_T0),
    ];
    for (const forbidden of forbiddenDurableNames) {
      expect(persistedFieldNames).not.toContain(forbidden);
    }
  });

  test("keeps fresh page context client-owned and transient UI state non-authoritative", () => {
    expect(RESEARCH_NON_SESSION_STATE_LIFETIMES_T0.currentPageContext)
      .toMatchObject({
        lifetime: "client-per-turn",
        resumeOwner: "authenticated-client",
      });
    expect(RESEARCH_NON_SESSION_STATE_LIFETIMES_T0.activityAnimation)
      .toMatchObject({
        lifetime: "transient-progress",
        resumeOwner: "active-run",
        modelVisible: false,
      });
  });
});

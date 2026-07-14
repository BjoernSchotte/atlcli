import { describe, expect, it } from "bun:test";
import {
  detectEntity,
  initialObserverState,
  observeTab,
  type ObserverState,
} from "../utils/tab-observer.js";

const PAGE_URL =
  "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/12345/Getting+Started";
const OTHER_PAGE_URL =
  "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/67890/Another";
const JIRA_URL = "https://myco.atlassian.net/browse/ATLCLI-42";
const NON_ATLASSIAN = "https://example.com/some/page";

describe("detectEntity", () => {
  it("resolves a Confluence page URL to a page entity", () => {
    expect(detectEntity(PAGE_URL)).toEqual({
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
    });
  });

  it("resolves a Jira issue URL to a Jira entity (detected, not exportable)", () => {
    expect(detectEntity(JIRA_URL)).toEqual({
      url: JIRA_URL,
      entity: { product: "jira", type: "issue", issueKey: "ATLCLI-42", projectKey: "ATLCLI" },
    });
  });

  it("resolves a non-Atlassian URL to a null entity", () => {
    expect(detectEntity(NON_ATLASSIAN)).toEqual({ url: NON_ATLASSIAN, entity: null });
  });
});

describe("observeTab (pure tab-observation core)", () => {
  it("emits entity-changed for a fresh URL and records it", () => {
    const { state, message } = observeTab(initialObserverState(), PAGE_URL);
    expect(message).toEqual({
      kind: "entity-changed",
      detection: {
        url: PAGE_URL,
        entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
      },
    });
    expect(state.lastEmittedUrl).toBe(PAGE_URL);
  });

  it("de-duplicates repeated identical URLs (no message storm on SPA nav)", () => {
    const first = observeTab(initialObserverState(), PAGE_URL);
    expect(first.message).not.toBeNull();

    // Confluence SPA fires onUpdated repeatedly with the same URL.
    const second = observeTab(first.state, PAGE_URL);
    expect(second.message).toBeNull();
    expect(second.state).toBe(first.state); // unchanged reference

    const third = observeTab(second.state, PAGE_URL);
    expect(third.message).toBeNull();
  });

  it("emits again when the URL changes (tab switch / real SPA navigation)", () => {
    const first = observeTab(initialObserverState(), PAGE_URL);
    const second = observeTab(first.state, OTHER_PAGE_URL);
    expect(second.message?.detection.url).toBe(OTHER_PAGE_URL);
    expect(second.state.lastEmittedUrl).toBe(OTHER_PAGE_URL);
  });

  it("carries a null entity for non-Atlassian tabs but still emits (idle state)", () => {
    const { message } = observeTab(initialObserverState(), NON_ATLASSIAN);
    expect(message).toEqual({
      kind: "entity-changed",
      detection: { url: NON_ATLASSIAN, entity: null },
    });
  });

  it("carries a Jira entity so the panel can show the not-exportable state", () => {
    const { message } = observeTab(initialObserverState(), JIRA_URL);
    expect(message?.detection.entity).toEqual({
      product: "jira",
      type: "issue",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
    });
  });

  it("is a no-op for an undefined/empty URL and never resets dedup memory", () => {
    const seeded: ObserverState = { lastEmittedUrl: PAGE_URL };
    expect(observeTab(seeded, undefined).message).toBeNull();
    expect(observeTab(seeded, undefined).state).toBe(seeded);
    expect(observeTab(seeded, "").message).toBeNull();
    expect(observeTab(seeded, null).message).toBeNull();
    // The next real duplicate of PAGE_URL is still deduped (memory intact).
    expect(observeTab(seeded, PAGE_URL).message).toBeNull();
  });
});

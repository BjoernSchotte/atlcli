import { describe, expect, it } from "bun:test";
import {
  classifyUrl,
  currentDetection,
  detectEntity,
  initialObserverState,
  observeTab,
  selectActiveTabUrl,
  type ObserverState,
} from "../utils/tab-observer.js";

const PAGE_URL =
  "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/12345/Getting+Started";
const OTHER_PAGE_URL =
  "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/67890/Another";
const JIRA_URL = "https://myco.atlassian.net/browse/ATLCLI-42";
const NON_ATLASSIAN = "https://example.com/some/page";
// A Confluence-SHAPED path served from a look-alike foreign origin. The URL
// registry recognizes the shape; the origin gate must reject it (finding #3).
const FOREIGN_CONFLUENCE_SHAPE =
  "https://evil-atlassian.net/wiki/spaces/D/pages/123/A";

describe("classifyUrl (URL → entity, origin-gated)", () => {
  it("resolves a Confluence page URL to a page entity", () => {
    expect(classifyUrl(PAGE_URL)).toEqual({
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
    });
  });

  it("resolves a Jira issue URL to a Jira entity (detected, not exportable)", () => {
    expect(classifyUrl(JIRA_URL)).toEqual({
      url: JIRA_URL,
      entity: { product: "jira", type: "issue", issueKey: "ATLCLI-42", projectKey: "ATLCLI" },
    });
  });

  it("resolves a non-Atlassian URL to a null entity", () => {
    expect(classifyUrl(NON_ATLASSIAN)).toEqual({ url: NON_ATLASSIAN, entity: null });
  });

  it("regression (finding #3): a Confluence-shaped path on a FOREIGN origin is a non-entity", () => {
    // Without the origin gate the extractor would return a page entity here, the
    // panel would try to load it, `profileFromTabUrl` would (correctly) return
    // null, and the user would see a spurious 'unknown error' instead of idle.
    expect(classifyUrl(FOREIGN_CONFLUENCE_SHAPE)).toEqual({
      url: FOREIGN_CONFLUENCE_SHAPE,
      entity: null,
    });
  });
});

describe("detectEntity (classification + ordering seq)", () => {
  it("stamps the supplied seq onto the detection", () => {
    expect(detectEntity(PAGE_URL, 7)).toEqual({
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
      seq: 7,
    });
  });
});

describe("observeTab (pure tab-observation core)", () => {
  it("emits entity-changed for a fresh URL, records it, and stamps seq 1", () => {
    const { state, message } = observeTab(initialObserverState(), PAGE_URL);
    expect(message).toEqual({
      kind: "entity-changed",
      detection: {
        url: PAGE_URL,
        entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
        seq: 1,
      },
    });
    expect(state.lastEmittedUrl).toBe(PAGE_URL);
    expect(state.seq).toBe(1);
  });

  it("bumps seq monotonically across distinct URLs", () => {
    const first = observeTab(initialObserverState(), PAGE_URL);
    expect(first.message?.detection.seq).toBe(1);
    const second = observeTab(first.state, OTHER_PAGE_URL);
    expect(second.message?.detection.seq).toBe(2);
    expect(second.state.seq).toBe(2);
  });

  it("de-duplicates repeated identical URLs (no message storm on SPA nav)", () => {
    const first = observeTab(initialObserverState(), PAGE_URL);
    expect(first.message).not.toBeNull();

    // Confluence SPA fires onUpdated repeatedly with the same URL.
    const second = observeTab(first.state, PAGE_URL);
    expect(second.message).toBeNull();
    expect(second.state).toBe(first.state); // unchanged reference, seq not bumped

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
      detection: { url: NON_ATLASSIAN, entity: null, seq: 1 },
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
    const seeded: ObserverState = { lastEmittedUrl: PAGE_URL, seq: 3 };
    expect(observeTab(seeded, undefined).message).toBeNull();
    expect(observeTab(seeded, undefined).state).toBe(seeded);
    expect(observeTab(seeded, "").message).toBeNull();
    expect(observeTab(seeded, null).message).toBeNull();
    // The next real duplicate of PAGE_URL is still deduped (memory intact).
    expect(observeTab(seeded, PAGE_URL).message).toBeNull();
  });
});

describe("currentDetection (pull path, shared seq counter)", () => {
  it("always returns a detection and shares the counter with observeTab", () => {
    // A push observed tab A (seq 1). The pull for a DIFFERENT active tab B must
    // draw the next seq (2) from the same counter, not restart it.
    const afterPush = observeTab(initialObserverState(), PAGE_URL);
    const pull = currentDetection(afterPush.state, OTHER_PAGE_URL);
    expect(pull.detection.seq).toBe(2);
    expect(pull.state.lastEmittedUrl).toBe(OTHER_PAGE_URL);
  });

  it("returns the SAME seq (no bump, no re-push) when the URL is unchanged", () => {
    const afterPush = observeTab(initialObserverState(), PAGE_URL); // seq 1
    const pull = currentDetection(afterPush.state, PAGE_URL);
    expect(pull.detection).toEqual({
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
      seq: 1,
    });
    expect(pull.state).toBe(afterPush.state);
  });

  it("returns a null detection stamped with the current seq for no active tab", () => {
    const afterPush = observeTab(initialObserverState(), PAGE_URL); // seq 1
    const pull = currentDetection(afterPush.state, undefined);
    expect(pull.detection).toEqual({ url: null, entity: null, seq: 1 });
  });
});

describe("selectActiveTabUrl (get-current-entity tab resolution, finding: detection after reload)", () => {
  it("prefers the last-focused active tab when it is an Atlassian URL", () => {
    expect(
      selectActiveTabUrl({ focused: PAGE_URL, active: [PAGE_URL, NON_ATLASSIAN] })
    ).toBe(PAGE_URL);
  });

  it("recovers the docked Atlassian tab when the last-focused tab is NOT Atlassian", () => {
    // Regression: after an extension reload the panel takes focus, so the
    // last-focused window's active tab resolves to a non-Confluence tab. Widening
    // to all active tabs and preferring an Atlassian one fixes the empty panel.
    expect(
      selectActiveTabUrl({ focused: NON_ATLASSIAN, active: [NON_ATLASSIAN, PAGE_URL] })
    ).toBe(PAGE_URL);
  });

  it("does not misread a foreign Confluence-shaped origin as the target tab", () => {
    // The origin gate lives in isAtlassianCloudUrl; a look-alike origin is not a
    // preferred candidate, so we fall back to the last-focused tab.
    expect(
      selectActiveTabUrl({ focused: NON_ATLASSIAN, active: [NON_ATLASSIAN, FOREIGN_CONFLUENCE_SHAPE] })
    ).toBe(NON_ATLASSIAN);
  });

  it("falls back to the last-focused tab when no active tab is Atlassian", () => {
    expect(
      selectActiveTabUrl({ focused: NON_ATLASSIAN, active: [NON_ATLASSIAN] })
    ).toBe(NON_ATLASSIAN);
  });

  it("falls back to the first active tab with a URL when there is no focused tab", () => {
    expect(
      selectActiveTabUrl({ focused: undefined, active: [undefined, NON_ATLASSIAN] })
    ).toBe(NON_ATLASSIAN);
  });

  it("returns undefined when there is no candidate URL at all", () => {
    expect(selectActiveTabUrl({ focused: undefined, active: [undefined, null] })).toBeUndefined();
  });
});

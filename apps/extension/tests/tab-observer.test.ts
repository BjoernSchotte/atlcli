import { describe, expect, it } from "bun:test";
import {
  classifyUrl,
  currentDetection,
  detectEntity,
  initialObserverState,
  isObserverState,
  observeTab,
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
const WINDOW_A = 7;
const WINDOW_B = 8;

/** This extension's own origin, as `chrome.runtime.getURL("/")` returns it. */
const OWN_ORIGIN = "chrome-extension://ifgomchmeaolmleampgdonakpbghinhn/";
const OWN_PREVIEW_PAGE = `${OWN_ORIGIN}preview.html`;

/**
 * Opening our own large-preview tab must not look like leaving the page.
 *
 * `window.open("preview.html")` puts a new tab in the SAME Chrome window and
 * activates it, so `chrome.tabs.onActivated` fires with a `chrome-extension:`
 * URL. Before this rule, that was folded in as an ordinary tab switch: a
 * null-entity detection with a HIGHER seq, pushed to every listener in the
 * window. Two things broke at once — the preview tab pulled that null detection
 * and so never had a page to preview (it rendered its "open a Confluence page"
 * state, which reads as a blank tab), and the side panel behind it lost its page
 * too.
 *
 * A FOREIGN page — including another extension's — still clears the context.
 * The panel going idle when you genuinely navigate away is correct behaviour,
 * and is pinned by the neighbouring tests; the exemption is only for surfaces
 * this extension itself owns.
 */
describe("our own extension pages are not a page change", () => {
  const withPage = observeTab(initialObserverState(), WINDOW_A, PAGE_URL).state;

  it("does not emit — or forget the page — when our preview tab is activated", () => {
    const result = observeTab(withPage, WINDOW_A, OWN_PREVIEW_PAGE, OWN_ORIGIN);
    expect(result.message).toBeNull();
    expect(result.state).toEqual(withPage);
  });

  it("answers a pull FROM that tab with the page the window is still showing", () => {
    const { detection } = currentDetection(withPage, WINDOW_A, OWN_PREVIEW_PAGE, OWN_ORIGIN);
    expect(detection.url).toBe(PAGE_URL);
    expect(detection.entity).toEqual({
      product: "confluence",
      type: "page",
      pageId: "12345",
      spaceKey: "DOCSY",
    });
  });

  it("still reports no page when the window never had one", () => {
    const { detection } = currentDetection(
      initialObserverState(),
      WINDOW_A,
      OWN_PREVIEW_PAGE,
      OWN_ORIGIN
    );
    expect(detection.url).toBeNull();
    expect(detection.entity).toBeNull();
  });

  it("does NOT exempt another extension's page", () => {
    const foreign = "chrome-extension://someotherextensionidhereokay/index.html";
    const result = observeTab(withPage, WINDOW_A, foreign, OWN_ORIGIN);
    expect(result.message).not.toBeNull();
    expect(result.message?.detection.entity).toBeNull();
  });

  it("does not exempt anything when no own origin is supplied", () => {
    // The pure core must not guess at its own identity — a host that forgets to
    // pass the origin gets exactly the old behaviour, visibly.
    const result = observeTab(withPage, WINDOW_A, OWN_PREVIEW_PAGE);
    expect(result.message).not.toBeNull();
  });

  /**
   * The consumption-site check, and the reason this block exists at all.
   *
   * `ownOrigin` is optional, so the entire fix above is inert unless the service
   * worker actually passes it — and "an option nothing reads" is precisely the
   * defect that produced this bug in the first place (`containerWidth` on
   * `renderPage` had a call site count of zero for the same reason). The pure
   * tests cannot see that; they hand in the argument themselves.
   *
   * `feed` and `getCurrentEntity` are closures inside `defineBackground`, so
   * there is nothing to import and drive. Reading the source is the honest
   * option — a weaker check than a behavioural one, but a real one, and far
   * better than trusting that the wiring stayed.
   */
  it("is actually wired: the service worker passes its own origin to both call sites", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../entrypoints/background.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain('chrome.runtime.getURL("/")');
    const calls = [...source.matchAll(/\b(observeTab|currentDetection)\s*\(([^)]*)\)/g)];
    expect(calls.length, "no observeTab/currentDetection call found in background.ts").toBe(2);
    for (const [, name, args] of calls) {
      expect(args, `${name}(...) in background.ts must pass ownOrigin`).toContain("ownOrigin");
    }
  });
});

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
    expect(detectEntity(PAGE_URL, 7, WINDOW_A)).toEqual({
      windowId: WINDOW_A,
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
      seq: 7,
    });
  });
});

describe("observeTab (pure tab-observation core)", () => {
  it("emits entity-changed for a fresh URL, records it, and stamps seq 1", () => {
    const { state, message } = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    expect(message).toEqual({
      kind: "entity-changed",
      detection: {
        windowId: WINDOW_A,
        url: PAGE_URL,
        entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
        seq: 1,
      },
    });
    expect(state.lastEmittedUrlByWindow[String(WINDOW_A)]).toBe(PAGE_URL);
    expect(state.seq).toBe(1);
  });

  it("bumps seq monotonically across distinct URLs", () => {
    const first = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    expect(first.message?.detection.seq).toBe(1);
    const second = observeTab(first.state, WINDOW_A, OTHER_PAGE_URL);
    expect(second.message?.detection.seq).toBe(2);
    expect(second.state.seq).toBe(2);
  });

  it("de-duplicates repeated identical URLs (no message storm on SPA nav)", () => {
    const first = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    expect(first.message).not.toBeNull();

    // Confluence SPA fires onUpdated repeatedly with the same URL.
    const second = observeTab(first.state, WINDOW_A, PAGE_URL);
    expect(second.message).toBeNull();
    expect(second.state).toBe(first.state); // unchanged reference, seq not bumped

    const third = observeTab(second.state, WINDOW_A, PAGE_URL);
    expect(third.message).toBeNull();
  });

  it("emits again when the URL changes (tab switch / real SPA navigation)", () => {
    const first = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    const second = observeTab(first.state, WINDOW_A, OTHER_PAGE_URL);
    expect(second.message?.detection.url).toBe(OTHER_PAGE_URL);
    expect(second.state.lastEmittedUrlByWindow[String(WINDOW_A)]).toBe(OTHER_PAGE_URL);
  });

  it("carries a null entity for non-Atlassian tabs but still emits (idle state)", () => {
    const { message } = observeTab(initialObserverState(), WINDOW_A, NON_ATLASSIAN);
    expect(message).toEqual({
      kind: "entity-changed",
      detection: { windowId: WINDOW_A, url: NON_ATLASSIAN, entity: null, seq: 1 },
    });
  });

  it("carries a Jira entity so the panel can show the not-exportable state", () => {
    const { message } = observeTab(initialObserverState(), WINDOW_A, JIRA_URL);
    expect(message?.detection.entity).toEqual({
      product: "jira",
      type: "issue",
      issueKey: "ATLCLI-42",
      projectKey: "ATLCLI",
    });
  });

  it("is a no-op for an undefined/empty URL and never resets dedup memory", () => {
    const seeded: ObserverState = {
      lastEmittedUrlByWindow: { [String(WINDOW_A)]: PAGE_URL },
      seq: 3,
    };
    expect(observeTab(seeded, WINDOW_A, undefined).message).toBeNull();
    expect(observeTab(seeded, WINDOW_A, undefined).state).toBe(seeded);
    expect(observeTab(seeded, WINDOW_A, "").message).toBeNull();
    expect(observeTab(seeded, WINDOW_A, null).message).toBeNull();
    // The next real duplicate of PAGE_URL is still deduped (memory intact).
    expect(observeTab(seeded, WINDOW_A, PAGE_URL).message).toBeNull();
  });
});

describe("currentDetection (pull path, shared seq counter)", () => {
  it("always returns a detection and shares the counter with observeTab", () => {
    // A push observed tab A (seq 1). The pull for a DIFFERENT active tab B must
    // draw the next seq (2) from the same counter, not restart it.
    const afterPush = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    const pull = currentDetection(afterPush.state, WINDOW_A, OTHER_PAGE_URL);
    expect(pull.detection.seq).toBe(2);
    expect(pull.state.lastEmittedUrlByWindow[String(WINDOW_A)]).toBe(OTHER_PAGE_URL);
  });

  it("returns the SAME seq (no bump, no re-push) when the URL is unchanged", () => {
    const afterPush = observeTab(initialObserverState(), WINDOW_A, PAGE_URL); // seq 1
    const pull = currentDetection(afterPush.state, WINDOW_A, PAGE_URL);
    expect(pull.detection).toEqual({
      windowId: WINDOW_A,
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "12345", spaceKey: "DOCSY" },
      seq: 1,
    });
    expect(pull.state).toBe(afterPush.state);
  });

  it("returns a null detection stamped with the current seq for no active tab", () => {
    const afterPush = observeTab(initialObserverState(), WINDOW_A, PAGE_URL); // seq 1
    const pull = currentDetection(afterPush.state, WINDOW_A, undefined);
    expect(pull.detection).toEqual({ windowId: WINDOW_A, url: null, entity: null, seq: 1 });
  });
});

describe("window-scoped observer state", () => {
  it("emits the same URL independently for two Chrome windows", () => {
    const first = observeTab(initialObserverState(), WINDOW_A, PAGE_URL);
    const second = observeTab(first.state, WINDOW_B, PAGE_URL);

    expect(first.message?.detection.windowId).toBe(WINDOW_A);
    expect(second.message?.detection.windowId).toBe(WINDOW_B);
    expect(second.message?.detection.seq).toBe(2);
  });

  it("continues from a persisted pre-restart sequence", () => {
    const persisted: ObserverState = {
      lastEmittedUrlByWindow: { [String(WINDOW_A)]: PAGE_URL },
      seq: 4,
    };
    const afterRestart = observeTab(persisted, WINDOW_A, OTHER_PAGE_URL);

    expect(afterRestart.message?.detection.seq).toBe(5);
    expect(afterRestart.message?.detection.url).toBe(OTHER_PAGE_URL);
  });

  it("validates only non-negative sequences and concrete window URL maps", () => {
    expect(isObserverState(initialObserverState())).toBe(true);
    expect(isObserverState({ seq: 4, lastEmittedUrlByWindow: { "7": PAGE_URL } })).toBe(true);
    expect(isObserverState({ seq: -1, lastEmittedUrlByWindow: {} })).toBe(false);
    expect(isObserverState({ seq: 4, lastEmittedUrlByWindow: { "-1": PAGE_URL } })).toBe(false);
    expect(isObserverState({ seq: 4, lastEmittedUrlByWindow: [] })).toBe(false);
  });
});

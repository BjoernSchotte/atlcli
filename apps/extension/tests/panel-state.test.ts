import { describe, expect, it } from "bun:test";
import type { AtlassianEntity } from "@atlcli/core";
import { initialPanelState, loadableContentId, reduce, type PanelState } from "../utils/panel-state.js";
import type { LoadedPage } from "../utils/read-path.js";

const pageEntity: AtlassianEntity = {
  product: "confluence",
  type: "page",
  pageId: "123",
  spaceKey: "DOCSY",
};
const blogEntity: AtlassianEntity = {
  product: "confluence",
  type: "blogpost",
  contentId: "999",
  spaceKey: "DOCSY",
};
const spaceEntity: AtlassianEntity = {
  product: "confluence",
  type: "space",
  spaceKey: "DOCSY",
};
const jiraEntity: AtlassianEntity = {
  product: "jira",
  type: "issue",
  issueKey: "ATLCLI-1",
  projectKey: "ATLCLI",
};

const URL_A = "https://x.atlassian.net/wiki/spaces/DOCSY/pages/123/A";
const URL_B = "https://x.atlassian.net/wiki/spaces/DOCSY/pages/456/B";

const fakePage: LoadedPage = {
  details: { id: "123", title: "A", storage: "" },
  markdown: "# A",
  wordCount: 1,
  attachments: [],
};

/** Convenience: drive detection then return the state. */
function detect(state: PanelState, url: string | null, entity: AtlassianEntity | null): PanelState {
  return reduce(state, { type: "detected", url, entity });
}

describe("loadableContentId", () => {
  it("returns the id for pages and blogposts, null otherwise", () => {
    expect(loadableContentId(pageEntity)).toBe("123");
    expect(loadableContentId(blogEntity)).toBe("999");
    expect(loadableContentId(spaceEntity)).toBeNull();
    expect(loadableContentId(jiraEntity)).toBeNull();
  });
});

describe("reduce — detection transitions", () => {
  it("null entity → idle", () => {
    const s = detect(initialPanelState, "https://example.com/", null);
    expect(s.status).toBe("idle");
  });

  it("null url → idle", () => {
    const s = detect(initialPanelState, null, null);
    expect(s.status).toBe("idle");
  });

  it("confluence page → loading with a bumped token", () => {
    const s = detect(initialPanelState, URL_A, pageEntity);
    expect(s).toMatchObject({ status: "loading", token: 1, contentId: "123" });
  });

  it("confluence blogpost → loading (also actionable)", () => {
    const s = detect(initialPanelState, URL_A, blogEntity);
    expect(s).toMatchObject({ status: "loading", contentId: "999" });
  });

  it("confluence space → unsupported (informational)", () => {
    const s = detect(initialPanelState, URL_A, spaceEntity);
    expect(s).toMatchObject({ status: "unsupported", entity: spaceEntity });
  });

  it("jira issue → unsupported (detected, not exportable)", () => {
    const s = detect(initialPanelState, "https://x.atlassian.net/browse/ATLCLI-1", jiraEntity);
    expect(s).toMatchObject({ status: "unsupported", entity: jiraEntity });
  });

  it("de-dups a repeated detection of the same URL (no reload/flicker)", () => {
    const loading = detect(initialPanelState, URL_A, pageEntity);
    const again = detect(loading, URL_A, pageEntity);
    // Same view + token (no reload), but `lastSeq` advances so a later
    // out-of-order detection for a different URL can't clobber it.
    expect(again.status).toBe("loading");
    expect(again.token).toBe(loading.token);
    expect((again as { ref: { url: string } }).ref.url).toBe(URL_A);
  });

  it("a different URL restarts loading with a fresh token", () => {
    const first = detect(initialPanelState, URL_A, pageEntity);
    const second = detect(first, URL_B, pageEntity);
    expect(second).toMatchObject({ status: "loading", token: 2 });
    expect((second as { ref: { url: string } }).ref.url).toBe(URL_B);
  });

  it("navigating away to a non-Atlassian tab returns to idle", () => {
    const loaded = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-succeeded",
      token: 1,
      page: fakePage,
    });
    expect(loaded.status).toBe("loaded");
    const idle = detect(loaded, "https://example.com/", null);
    expect(idle.status).toBe("idle");
  });
});

describe("reduce — load results + correlation token", () => {
  it("load-succeeded on the active token → loaded", () => {
    const loading = detect(initialPanelState, URL_A, pageEntity);
    const loaded = reduce(loading, { type: "load-succeeded", token: 1, page: fakePage });
    expect(loaded).toMatchObject({ status: "loaded", page: fakePage });
  });

  it("load-failed on the active token → error(kind)", () => {
    const loading = detect(initialPanelState, URL_A, pageEntity);
    const err = reduce(loading, { type: "load-failed", token: 1, kind: "not-logged-in" });
    expect(err).toMatchObject({ status: "error", kind: "not-logged-in" });
  });

  it("discards a stale load-succeeded from a superseded load (tab switch mid-load)", () => {
    const loadA = detect(initialPanelState, URL_A, pageEntity); // token 1
    const loadB = detect(loadA, URL_B, pageEntity); // token 2 (switched tabs)
    // The token-1 load resolves LATE — must be discarded.
    const after = reduce(loadB, { type: "load-succeeded", token: 1, page: fakePage });
    expect(after).toBe(loadB);
    expect(after.status).toBe("loading");
    expect(after.token).toBe(2);
  });

  it("discards a stale load-failed from a superseded load", () => {
    const loadA = detect(initialPanelState, URL_A, pageEntity);
    const loadB = detect(loadA, URL_B, pageEntity);
    const after = reduce(loadB, { type: "load-failed", token: 1, kind: "network" });
    expect(after).toBe(loadB);
    expect(after.status).toBe("loading");
  });

  it("ignores load results that arrive when not loading", () => {
    const loaded = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-succeeded",
      token: 1,
      page: fakePage,
    });
    const stray = reduce(loaded, { type: "load-succeeded", token: 1, page: fakePage });
    expect(stray).toBe(loaded);
  });
});

describe("reduce — retry", () => {
  it("retry from error re-enters loading with a bumped token", () => {
    const err = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-failed",
      token: 1,
      kind: "network",
    });
    const retry = reduce(err, { type: "retry" });
    expect(retry).toMatchObject({ status: "loading", token: 2, contentId: "123" });
    expect((retry as { ref: { url: string } }).ref.url).toBe(URL_A);
  });

  it("regression (finding #2): Reload from loaded re-enters loading with a fresh token", () => {
    // The loaded view's Reload button dispatches `retry`; before the fix the
    // reducer only accepted `retry` from `error`, so Reload was a silent no-op.
    const loaded = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-succeeded",
      token: 1,
      page: fakePage,
    });
    expect(loaded.status).toBe("loaded");
    const reloaded = reduce(loaded, { type: "retry" });
    expect(reloaded).toMatchObject({ status: "loading", token: 2, contentId: "123" });
    expect((reloaded as { ref: { url: string } }).ref.url).toBe(URL_A);
  });

  it("a stale result from the pre-reload load does not clobber the reloaded load", () => {
    const loaded = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-succeeded",
      token: 1,
      page: fakePage,
    });
    const reloaded = reduce(loaded, { type: "retry" }); // token 2
    // A late failure from the original load (token 1) must be discarded.
    const after = reduce(reloaded, { type: "load-failed", token: 1, kind: "network" });
    expect(after).toBe(reloaded);
    expect(after.status).toBe("loading");
  });

  it("retry is a no-op outside the error/loaded states", () => {
    expect(reduce(initialPanelState, { type: "retry" })).toBe(initialPanelState);
    const loading = detect(initialPanelState, URL_A, pageEntity);
    expect(reduce(loading, { type: "retry" })).toBe(loading);
  });

  it("the result of a pre-retry load does not clobber the retried load", () => {
    const err = reduce(detect(initialPanelState, URL_A, pageEntity), {
      type: "load-failed",
      token: 1,
      kind: "network",
    });
    const retry = reduce(err, { type: "retry" }); // token 2
    // A late success from the original attempt (token 1) is discarded.
    const after = reduce(retry, { type: "load-succeeded", token: 1, page: fakePage });
    expect(after).toBe(retry);
  });
});

describe("reduce — detection ordering guard (finding #1)", () => {
  /** Detection with an explicit ordering seq (as the SW stamps in production). */
  function detectSeq(
    state: PanelState,
    url: string | null,
    entity: AtlassianEntity | null,
    seq: number
  ): PanelState {
    return reduce(state, { type: "detected", url, entity, seq });
  }

  it("drops a delayed pull for tab A that arrives after a newer push for tab B", () => {
    // Panel mounts and pulls the current entity for tab A (seq 1) — but the
    // response is slow in transit. Meanwhile the user switches to tab B and the
    // SW pushes B (seq 2), which the panel applies first. THEN the stale A pull
    // finally arrives. It must be ignored (older seq) — otherwise the panel
    // loads A while the browser shows B.
    const start = initialPanelState;

    // B push (seq 2) applied first.
    const showingB = detectSeq(start, URL_B, pageEntity, 2);
    expect(showingB.status).toBe("loading");
    expect((showingB as { ref: { url: string } }).ref.url).toBe(URL_B);

    // A pull (seq 1) arrives late → must NOT clobber B.
    const afterStaleA = detectSeq(showingB, URL_A, pageEntity, 1);
    expect(afterStaleA).toBe(showingB);
    expect((afterStaleA as { ref: { url: string } }).ref.url).toBe(URL_B);
  });

  it("applies detections in seq order regardless of arrival order", () => {
    // A (seq 1) arrives, then a genuinely newer B (seq 2) supersedes it.
    const a = detectSeq(initialPanelState, URL_A, pageEntity, 1);
    expect((a as { ref: { url: string } }).ref.url).toBe(URL_A);
    const b = detectSeq(a, URL_B, pageEntity, 2);
    expect((b as { ref: { url: string } }).ref.url).toBe(URL_B);
    // A re-delivery of A at the OLD seq is dropped.
    const staleA = detectSeq(b, URL_A, pageEntity, 1);
    expect(staleA).toBe(b);
  });

  it("an equal seq (e.g. a null re-pull) does not supersede an applied detection", () => {
    const b = detectSeq(initialPanelState, URL_B, pageEntity, 2);
    const nullPullSameSeq = detectSeq(b, null, null, 2);
    expect(nullPullSameSeq).toBe(b); // seq 2 is not > lastSeq 2 → ignored
  });
});

describe("reduce — foreign-origin consistency (finding #3)", () => {
  it("a foreign-origin tab (null entity) lands on idle, not an error", () => {
    // tab-observer classifies a Confluence-shaped foreign-origin URL as a null
    // entity; the reducer must treat that as idle (nothing to export), matching
    // profileFromTabUrl returning null — no spurious error state.
    const s = reduce(initialPanelState, {
      type: "detected",
      url: "https://evil-atlassian.net/wiki/spaces/D/pages/123/A",
      entity: null,
      seq: 1,
    });
    expect(s.status).toBe("idle");
  });
});

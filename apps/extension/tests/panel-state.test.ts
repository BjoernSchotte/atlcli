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
    expect(again).toBe(loading); // identical reference, token unchanged
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

  it("retry is a no-op outside the error state", () => {
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

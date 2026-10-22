import { describe, expect, test } from "bun:test";
import type { ConfluenceSearchResult } from "@atlcli/confluence";
import type { JiraChangelogEntry, JiraIssue } from "@atlcli/jira";
import {
  type DigestRawInput,
  type DigestSince,
  anySectionSucceeded,
  buildCommentsCql,
  buildDigest,
  buildDigestQueries,
  nextDigestState,
  parseDigestState,
  renderDigestMarkdown,
  renderDigestText,
  resolveDigestSince,
  sinceMinutes,
  succeededProducts,
} from "./digest-core.js";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const ME_J = "jira-me";
const ME_C = "conf-me";

describe("resolveDigestSince", () => {
  test("relative forms, m means minutes", () => {
    expect(resolveDigestSince("90m", NOW, undefined).at.toISOString()).toBe(ago(90));
    expect(resolveDigestSince("24h", NOW, undefined).at.toISOString()).toBe(ago(24 * 60));
    expect(resolveDigestSince("2w", NOW, undefined).at.toISOString()).toBe(ago(14 * 24 * 60));
  });

  test("today / yesterday are local midnights; ISO date is local midnight; ISO datetime exact", () => {
    const local = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
    expect(resolveDigestSince("today", NOW, undefined).at).toEqual(local);
    expect(resolveDigestSince("yesterday", NOW, undefined).at).toEqual(
      new Date(local.getFullYear(), local.getMonth(), local.getDate() - 1)
    );
    expect(resolveDigestSince("2026-10-20", NOW, undefined).at).toEqual(new Date(2026, 9, 20));
    expect(resolveDigestSince("2026-10-21T08:00:00Z", NOW, undefined).at.toISOString()).toBe("2026-10-21T08:00:00.000Z");
  });

  test("lastrun uses the marker minus the overlap; without a marker 24h", () => {
    const withMarker = resolveDigestSince(undefined, NOW, new Date(ago(60)));
    expect(withMarker).toMatchObject({ source: "lastrun" });
    expect(withMarker.at.toISOString()).toBe(ago(65));
    const without = resolveDigestSince("lastrun", NOW, undefined);
    expect(without).toMatchObject({ source: "default", label: "the last 24h (no previous run)" });
    expect(without.at.toISOString()).toBe(ago(24 * 60));
  });

  test("clamps to 30 days with a warning; rejects the future and garbage", () => {
    const clamped = resolveDigestSince("90d", NOW, undefined);
    expect(clamped.at.toISOString()).toBe(ago(30 * 24 * 60));
    expect(clamped.warning).toContain("30 days");
    expect(() => resolveDigestSince("2027-01-01", NOW, undefined)).toThrow(/future/);
    expect(() => resolveDigestSince("3 months", NOW, undefined)).toThrow(/Invalid --since/);
    expect(sinceMinutes(resolveDigestSince("90m", NOW, undefined), NOW)).toBe(90);
  });
});

describe("queries", () => {
  test("every query string", () => {
    expect(buildDigestQueries({ minutes: 90, space: "DOCSY" })).toEqual({
      waiting: "assignee = currentUser() AND resolution IS EMPTY ORDER BY priority DESC, updated DESC",
      changed: "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -90m ORDER BY updated DESC",
      mentions: 'mention = currentUser() AND lastmodified >= now("-90m") ORDER BY lastmodified DESC',
      myPagesEdited: 'type = page AND creator = currentUser() AND lastmodified >= now("-90m") ORDER BY lastmodified DESC',
      myPageIds: "type = page AND creator = currentUser() ORDER BY lastmodified DESC",
      watched: 'watcher = currentUser() AND type in (page, blogpost) AND lastmodified >= now("-90m") ORDER BY lastmodified DESC',
      recent: 'type = page AND space = "DOCSY" AND lastModified >= now("-90m") ORDER BY lastModified DESC',
    });
    expect(buildDigestQueries({ minutes: 5 }).recent).toBeUndefined();
    expect(buildCommentsCql(["1", "2"], 30)).toBe('type = comment AND container IN (1, 2) AND created >= now("-30m") ORDER BY created DESC');
    expect(buildCommentsCql([], 30)).toBeUndefined();
  });
});

function jiraIssue(key: string, fields: Record<string, unknown> = {}): JiraIssue {
  return {
    id: key,
    key,
    self: "",
    fields: { summary: `Summary ${key}`, status: { id: "1", name: "In Progress", statusCategory: { key: "indeterminate" } }, ...fields },
  } as unknown as JiraIssue;
}
function history(at: string, author: string, field: string, from: string | null, to: string): JiraChangelogEntry {
  return {
    id: `${at}-${field}`,
    author: { accountId: author, displayName: author === ME_J ? "Me" : "Ann" } as JiraChangelogEntry["author"],
    created: at,
    items: [{ field, fieldtype: "jira", from: null, fromString: from, to: null, toString: to }],
  };
}
function page(id: string, minutesAgo: number, by = "other", fields: Partial<ConfluenceSearchResult> = {}): ConfluenceSearchResult {
  return { id, title: `Page ${id}`, spaceKey: "DOCSY", url: `https://x/wiki/${id}`, lastModified: ago(minutesAgo), lastModifiedBy: by === ME_C ? "Me" : "Bob", lastModifiedById: by, ...fields };
}
function comment(id: string, minutesAgo: number, by = "other", fields: Partial<ConfluenceSearchResult> = {}): ConfluenceSearchResult {
  return { id, title: "Re: Page 1", created: ago(minutesAgo), creator: by === ME_C ? "Me" : "Eve", creatorId: by, container: { id: "1", title: "Page 1" }, ...fields };
}

const SINCE: DigestSince = { at: new Date(ago(120)), source: "explicit", label: "2h" };

function raw(over: Partial<DigestRawInput> = {}): DigestRawInput {
  return {
    profile: "p",
    since: SINCE,
    products: ["jira", "confluence"],
    me: { jiraAccountId: ME_J, confluenceAccountId: ME_C, displayName: "Me" },
    jiraBaseUrl: "https://x",
    jira: {
      waiting: [jiraIssue("A-1", { priority: { name: "High" } })],
      changed: [
        jiraIssue("A-1", { assignee: { accountId: ME_J } }),
        jiraIssue("A-2", { reporter: { accountId: ME_J } }),
        jiraIssue("A-3"),
      ],
      changelogs: new Map([
        ["A-1", [history(ago(500), "ann", "status", "To Do", "Done"), history(ago(30), "ann", "status", "To Do", "In Progress")]],
        ["A-2", [history(ago(20), ME_J, "summary", "Old", "New")]],
        ["A-3", [history(ago(10), "ann", "description", null, "x".repeat(100))]],
      ]),
      sprints: [
        {
          id: 7,
          name: "S7",
          endDate: new Date(NOW.getTime() + 3.5 * 86_400_000).toISOString(),
          issues: [
            jiraIssue("A-1", { assignee: { accountId: ME_J } }),
            jiraIssue("A-9", { status: { name: "Done", statusCategory: { key: "done" } } }),
          ],
        },
      ],
    },
    confluence: {
      mentions: [page("1", 50), page("2", 40, ME_C)],
      myPagesEdited: [page("1", 50), page("3", 30)],
      comments: [comment("c1", 20), comment("c2", 10, ME_C)],
      openInline: [
        comment("i2", 2000, "other", { resolutionStatus: "open", location: "inline" }),
        comment("i1", 5000, "other", { resolutionStatus: "open", location: "inline" }),
        comment("i3", 100, "other", { resolutionStatus: "resolved" }),
      ],
      watched: [page("3", 30), page("4", 10)],
      recent: [page("5", 5)],
    },
    errors: [],
    ...over,
  };
}

describe("buildDigest", () => {
  test("own activity is filtered unless includeOwn; changes inside the window only", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 });
    expect(d.jira!.changed.map((c) => c.key)).toEqual(["A-1", "A-3"]);
    expect(d.jira!.changed[0]).toMatchObject({ roles: ["assignee"], changes: [{ field: "status", from: "To Do", to: "In Progress", you: false }] });
    expect(d.jira!.changed[1]).toMatchObject({ roles: ["watching"] });
    expect(d.jira!.changed[1].changes[0].to).toHaveLength(60);
    expect(d.confluence!.mentions.map((p) => p.id)).toEqual(["1"]);
    expect(d.confluence!.comments.map((c) => c.id)).toEqual(["c1"]);

    const own = buildDigest(raw(), { now: NOW, includeOwn: true, limit: 10 });
    expect(own.jira!.changed.map((c) => c.key)).toEqual(["A-1", "A-2", "A-3"]);
    expect(own.jira!.changed[1]).toMatchObject({ roles: ["reporter"], changes: [{ you: true }] });
    expect(own.confluence!.mentions.map((p) => p.id)).toEqual(["2", "1"]);
    expect(renderDigestText(own, NOW)).toContain("summary: Old → New by Me (you) · 20m ago");
  });

  test("a page appears in the first matching section only, with alsoIn", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 });
    expect(d.confluence!.mentions[0]).toMatchObject({ id: "1", alsoIn: ["myPagesEdited"] });
    expect(d.confluence!.myPagesEdited.map((p) => p.id)).toEqual(["3"]);
    expect(d.confluence!.myPagesEdited[0].alsoIn).toEqual(["watched"]);
    expect(d.confluence!.watched.map((p) => p.id)).toEqual(["4"]);
    expect(d.confluence!.recent.map((p) => p.id)).toEqual(["5"]);
  });

  test("open inline comments: open only, oldest first", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 });
    expect(d.confluence!.openInline.map((c) => c.id)).toEqual(["i1", "i2"]);
  });

  test("per-section limit marks truncation", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: true, limit: 1 });
    expect(d.jira!.changed).toHaveLength(1);
    expect(d.truncated).toEqual(["jira.changed", "confluence.mentions", "confluence.comments", "confluence.openInline"]);
  });

  test("sprint progress", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 });
    expect(d.jira!.sprints).toEqual([
      { id: 7, name: "S7", daysLeft: 4, counts: { todo: 0, wip: 1, done: 1 }, yoursOpen: 1, progress: "[██████████──────────] 50%" },
    ]);
  });

  test("Data Center: changed issues without change details are still listed", () => {
    const d = buildDigest(raw({ jira: { changed: [jiraIssue("A-5")], changelogs: undefined } }), { now: NOW, includeOwn: false, limit: 10 });
    expect(d.jira!.changed).toMatchObject([{ key: "A-5", changes: [] }]);
  });

  test("empty digest; --only keeps the other product out; every section key in JSON", () => {
    const empty = buildDigest(
      raw({ products: ["jira"], jira: {}, confluence: {} }),
      { now: NOW, includeOwn: false, limit: 10 }
    );
    expect(Object.keys(empty)).toEqual(["schemaVersion", "generatedAt", "since", "profile", "me", "warnings", "truncated", "jira"]);
    expect(empty.jira).toEqual({ waiting: [], changed: [], sprints: [] });
    expect(empty.confluence).toBeUndefined();
    expect(renderDigestText(empty, NOW)).toContain("Nothing new since 2h.");
  });

  test("partial failure: warnings, succeeded products, exit decision", () => {
    const errors = [{ section: "confluence.mentions", message: "500" }];
    const d = buildDigest(raw({ errors }), { now: NOW, includeOwn: false, limit: 10 });
    expect(succeededProducts(d, ["jira", "confluence"])).toEqual(["jira"]);
    expect(renderDigestText(d, NOW)).toContain("Warnings:\n  - confluence.mentions: 500");
    expect(anySectionSucceeded(raw())).toBe(true);
    // A skipped section (no board, no space) does not count as a success.
    expect(anySectionSucceeded({ jira: { waiting: undefined, sprints: undefined }, confluence: { recent: undefined } })).toBe(false);
    expect(anySectionSucceeded({ jira: {}, confluence: { comments: [] } })).toBe(true);
  });

  test("text and Markdown snapshots are deterministic", () => {
    const d = buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 });
    expect(renderDigestText(d, NOW)).toMatchSnapshot();
    expect(renderDigestMarkdown(d, NOW)).toMatchSnapshot();
    expect(JSON.stringify(d)).toBe(JSON.stringify(buildDigest(raw(), { now: NOW, includeOwn: false, limit: 10 })));
  });
});

describe("marker state", () => {
  const start = new Date(NOW);
  test("only products that succeeded with a lastrun/default since move", () => {
    const prev = { schemaVersion: 2 as const, jira: { lastRunAt: ago(60) }, confluence: { lastRunAt: ago(60) } };
    expect(
      nextDigestState(prev, { runStartedAt: start, succeeded: ["jira"], sinceSources: { jira: "lastrun", confluence: "lastrun" }, noMark: false })
    ).toEqual({ schemaVersion: 2, jira: { lastRunAt: start.toISOString() }, confluence: { lastRunAt: ago(60) } });
    expect(
      nextDigestState({ schemaVersion: 2 }, { runStartedAt: start, succeeded: ["jira", "confluence"], sinceSources: { jira: "default" }, noMark: false })
    ).toEqual({ schemaVersion: 2, jira: { lastRunAt: start.toISOString() } });
    expect(
      nextDigestState(prev, { runStartedAt: start, succeeded: ["jira"], sinceSources: { jira: "explicit" }, noMark: false })
    ).toEqual(prev);
    expect(
      nextDigestState(prev, { runStartedAt: start, succeeded: ["jira"], sinceSources: { jira: "lastrun" }, noMark: true })
    ).toEqual(prev);
  });

  test("schemaVersion 1 counts for both products; garbage throws", () => {
    expect(parseDigestState({ schemaVersion: 1, lastRunAt: ago(5) })).toEqual({
      schemaVersion: 2,
      jira: { lastRunAt: ago(5) },
      confluence: { lastRunAt: ago(5) },
    });
    expect(parseDigestState({ schemaVersion: 2, jira: { lastRunAt: "nope" } })).toEqual({ schemaVersion: 2 });
    expect(() => parseDigestState({ hello: 1 })).toThrow();
  });
});

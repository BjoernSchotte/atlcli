import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { epicSearchJql } from "./jira-actions.js";
import { filterJql, jira, loadIssues, openClause, splitWords, withOrder } from "./jira.js";
import { commands, issue, setup } from "./testing.js";

describe("query helpers", () => {
  test("splitWords keeps quoted words together", () => {
    expect(splitWords(`--status "In Arbeit" --assignee 'Ann Lee' x`)).toEqual(["--status", "In Arbeit", "--assignee", "Ann Lee", "x"]);
  });

  test("withOrder replaces or adds ORDER BY", () => {
    expect(withOrder("project = A ORDER BY created DESC", "updated ASC")).toBe("project = A ORDER BY updated ASC");
    expect(withOrder("project = A", "rank ASC")).toBe("project = A ORDER BY rank ASC");
    expect(withOrder("", "key ASC")).toBe("ORDER BY key ASC");
  });

  test("openClause adds the statuses the status map counts as done", () => {
    expect(openClause()).toBe("statusCategory != Done");
    expect(openClause(["Done", "Won't do"])).toBe(`statusCategory != Done AND status NOT IN ("Done", "Won't do")`);
  });

  test("epic search: summary prefix, a key also by key, quotes stripped", () => {
    expect(epicSearchJql("AB", "")).toBe(`project = "AB" AND issuetype = Epic ORDER BY updated DESC`);
    expect(epicSearchJql("AB", "ab-12")).toContain(`key = "AB-12"`);
    expect(epicSearchJql("AB", `pay"ment`)).toContain(`summary ~ "payment*"`);
  });
});

describe("filter bar", () => {
  test("raw JQL passes through", async () => {
    const { ctx } = setup();
    expect(await filterJql(ctx, "  project = X  ")).toBe("project = X");
  });

  test("submitting the filter shows the result: the list gets the focus", async () => {
    const { ctx, settle } = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k) });
    ctx.store.set((s) => ({ ...s, focus: "nav" }));
    handleKey({ ctx, commands: commands(), keymap: {} }, { name: "/", sequence: "/" });
    ctx.store.set((s) => ({ ...s, overlays: s.overlays.map((o) => (o.kind === "prompt" ? { ...o, value: "project = AB" } : o)) }));
    handleKey({ ctx, commands: commands(), keymap: {} }, { name: "return" });
    await settle();
    // Regression: in a narrow terminal the focused navigator covered the result.
    expect(ctx.store.get().focus).toBe("list");
    expect(ctx.store.get().jira.list.query).toBe("project = AB");
  });

  test("search flags become JQL, with users and localized statuses resolved", async () => {
    const { ctx } = setup(
      {
        getStatuses: () => [{ id: "3", name: "Fertig", untranslatedName: "Done" }],
        searchUsers: () => [{ accountId: "acc-ann", displayName: "Ann Lee", active: true }],
      },
      { project: "DEF" }
    );
    expect(await filterJql(ctx, `--assignee "Ann Lee" --status ~Fertig`)).toBe(`project = DEF AND assignee = "acc-ann" AND status != "Done"`);
  });
});

describe("loading", () => {
  test("an older list answer never overwrites a newer one", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { ctx, settle } = setup({
      search: async (jql: string) => {
        if (jql === "slow") await slow;
        return { issues: [issue(jql === "slow" ? "OLD-1" : "NEW-1")] };
      },
      getIssue: (key: string) => issue(key),
    });
    const first = loadIssues(ctx, "slow", "slow");
    await loadIssues(ctx, "fast", "fast");
    release();
    await first;
    await settle();
    expect(ctx.store.get().jira.list.items.map((i) => i.key)).toEqual(["NEW-1"]);
    expect(ctx.store.get().jira.list.title).toBe("fast");
  });

  test("a newer list load cancels the request of the older one", async () => {
    const signals: Record<string, AbortSignal> = {};
    const { ctx } = setup({
      search: (jql: string, o: { signal: AbortSignal }) => {
        signals[jql] = o.signal;
        return { issues: [] };
      },
      getIssue: (key: string) => issue(key),
    });
    await loadIssues(ctx, "a", "a");
    await loadIssues(ctx, "b", "b");
    expect([signals.a!.aborted, signals.b!.aborted]).toEqual([true, false]);
  });

  test("init lists my open issues and loads the selected one's detail", async () => {
    const { ctx, calls, settle } = setup({
      search: () => ({ issues: [issue("AB-1"), issue("AB-2")] }),
      getIssue: (key: string) => issue(key, { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] } as never }),
    });
    await jira.init(ctx);
    await settle();
    const s = ctx.store.get();
    expect(s.jira.list.query).toContain("assignee = currentUser()");
    expect(s.jira.list.items.map((i) => i.key)).toEqual(["AB-1", "AB-2"]);
    const detail = s.jira.details["AB-1"];
    expect(detail?.status === "ok" && detail.value.description).toBe("hello");
    expect(calls.filter((c) => c.method === "getIssue")).toHaveLength(1);
  });

  test("moving down loads the next issue's detail", async () => {
    const { ctx, calls, settle } = setup({ search: () => ({ issues: [issue("AB-1"), issue("AB-2")] }), getIssue: (key: string) => issue(key) });
    await jira.init(ctx);
    handleKey({ ctx, commands: commands(), keymap: {} }, { name: "j", sequence: "j" });
    await settle();
    expect(ctx.store.get().jira.list.selected).toBe(1);
    expect(calls.filter((c) => c.method === "getIssue").map((c) => c.args[0])).toEqual(["AB-1", "AB-2"]);
  });

  test("another list starts at the top even when it holds the selected issue; a reload keeps it", async () => {
    const lists: Record<string, string[]> = { A: ["AB-1", "AB-2"], B: ["AB-9", "AB-1"] };
    const { ctx, settle } = setup({ search: (jql: string) => ({ issues: lists[jql]!.map((k) => issue(k)) }), getIssue: (k: string) => issue(k) });
    await loadIssues(ctx, "A", "A");
    ctx.store.set((s) => ({ ...s, jira: { ...s.jira, list: { ...s.jira.list, selected: 1 } } }));
    await loadIssues(ctx, "A", "A");
    expect(ctx.store.get().jira.list.selected).toBe(1);
    ctx.store.set((s) => ({ ...s, jira: { ...s.jira, list: { ...s.jira.list, selected: 0 } } }));
    // Regression: switching lists kept the old items, so AB-1 (also in B) stayed selected.
    await loadIssues(ctx, "B", "B");
    await settle();
    expect(ctx.store.get().jira.list.selected).toBe(0);
  });

  test("a failed search shows its error in the list", async () => {
    const { ctx } = setup({ search: () => Promise.reject(new Error("JQL error: bad field")) });
    await loadIssues(ctx, "Search", "bad");
    expect(ctx.store.get().jira.list.error).toBe("JQL error: bad field");
    expect(ctx.store.get().jira.list.loading).toBe(false);
  });
});

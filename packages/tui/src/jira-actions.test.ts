import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { loadIssues } from "./jira.js";
import { topOverlay } from "./state.js";
import { commands, issue, setup, type TestSetup } from "./testing.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down"].includes(key);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name: key } : key.startsWith("ctrl+") ? { name: key.slice(5), ctrl: true } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

async function listed(t: TestSetup, keys: string[]) {
  await loadIssues(t.ctx, "Test", "x");
  await t.settle();
  void keys;
}

const transitions = [
  { id: "11", name: "Start", to: { name: "In Progress" } },
  { id: "31", name: "Done", to: { name: "Done" } },
];

describe("transition", () => {
  test("pick, confirm, then the transition runs and the issue reloads", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), getTransitions: () => transitions, transitionIssue: () => undefined });
    await listed(t, []);
    press(t, "t");
    await t.settle();
    expect(topOverlay(t.ctx.store.get())?.kind).toBe("picker");
    press(t, "down", "return");
    const confirm = topOverlay(t.ctx.store.get());
    expect(confirm?.kind === "confirm" && confirm.lines).toEqual(["AB-1  To Do → Done"]);
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "transitionIssue")?.args).toEqual(["AB-1", { transition: { id: "31" } }]);
    expect(t.calls.filter((c) => c.method === "getIssue").length).toBeGreaterThanOrEqual(2);
    expect(t.toasts().at(-1)).toMatchObject({ kind: "success", text: "AB-1 updated" });
  });

  test("n cancels without writing", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), getTransitions: () => transitions });
    await listed(t, []);
    press(t, "t");
    await t.settle();
    press(t, "return", "n");
    await t.settle();
    expect(t.calls.some((c) => c.method === "transitionIssue")).toBe(false);
    expect(t.ctx.store.get().overlays).toEqual([]);
  });

  test("a bulk change over five issues needs a second y; other workflows match by name", async () => {
    const keys = ["AB-1", "AB-2", "AB-3", "AB-4", "AB-5", "AB-6"];
    const t = setup({
      search: () => ({ issues: keys.map((k) => issue(k)) }),
      getIssue: (k: string) => issue(k),
      getTransitions: (k: string) => (k === "AB-1" ? transitions : [{ id: "99", name: "done", to: { name: "Done" } }]),
      transitionIssue: () => undefined,
    });
    await listed(t, []);
    press(t, ...keys.map(() => "space"));
    expect(t.ctx.store.get().jira.list.marked).toEqual(keys);
    press(t, "t");
    await t.settle();
    press(t, "down", "return", "y");
    expect(topOverlay(t.ctx.store.get())).toMatchObject({ kind: "confirm", step: 1 });
    expect(t.calls.some((c) => c.method === "transitionIssue")).toBe(false);
    press(t, "y");
    await t.settle();
    const done = t.calls.filter((c) => c.method === "transitionIssue").map((c) => [c.args[0], (c.args[1] as { transition: { id: string } }).transition.id]);
    expect(done).toEqual([["AB-1", "31"], ...keys.slice(1).map((k) => [k, "99"])]);
  });

  test("a failure on one issue names it and the others still run", async () => {
    const t = setup({
      search: () => ({ issues: [issue("AB-1"), issue("AB-2")] }),
      getIssue: (k: string) => issue(k),
      getTransitions: () => transitions,
      transitionIssue: (k: string) => (k === "AB-1" ? Promise.reject(new Error("Field required")) : undefined),
    });
    await listed(t, []);
    press(t, "space", "space", "t");
    await t.settle();
    press(t, "down", "return", "y");
    await t.settle();
    expect(t.calls.filter((c) => c.method === "transitionIssue")).toHaveLength(2);
    expect(t.toasts().at(-1)?.text).toContain("1 of 2 done. AB-1: Field required");
  });
});

describe("assign", () => {
  test("unassigned sends null", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), assignIssue: () => undefined });
    await listed(t, []);
    press(t, "a", "down", "return", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "assignIssue")?.args).toEqual(["AB-1", null]);
  });

  test("me resolves the current user", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), getCurrentUser: () => ({ accountId: "acc-me", displayName: "Me" }), assignIssue: () => undefined });
    await listed(t, []);
    press(t, "a", "return");
    await t.settle();
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "assignIssue")?.args).toEqual(["AB-1", { accountId: "acc-me" }]);
  });
});

describe("comment", () => {
  test("ctrl+s asks, then posts the markdown as ADF", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), addComment: () => ({ id: "1" }) });
    await listed(t, []);
    press(t, "c");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "compose" }>), value: "**hi**" }] }));
    press(t, "ctrl+s", "y");
    await t.settle();
    const body = t.calls.find((c) => c.method === "addComment")?.args[1] as { type: string; content: Array<{ content: Array<{ marks?: unknown[] }> }> };
    expect(body.type).toBe("doc");
    expect(body.content[0]!.content[0]!.marks).toEqual([{ type: "strong" }]);
  });

  test("a long comment on one issue needs one y (the second y is for many issues, not many lines)", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), addComment: () => ({ id: "1" }) });
    await listed(t, []);
    press(t, "c");
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "compose" }>), value: long }] }));
    press(t, "ctrl+s", "y");
    await t.settle();
    expect(t.calls.some((c) => c.method === "addComment")).toBe(true);
  });

  test("esc with text asks before throwing it away", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k) });
    await listed(t, []);
    press(t, "c");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "compose" }>), value: "draft" }] }));
    press(t, "escape");
    expect(topOverlay(t.ctx.store.get())?.kind).toBe("confirm");
    press(t, "n");
    expect(topOverlay(t.ctx.store.get())).toMatchObject({ kind: "compose", value: "draft" });
  });
});

describe("sprint", () => {
  const sprintStub = (moves: string[]) => ({
    search: () => ({ issues: [issue("AB-1"), issue("AB-2")] }),
    getIssue: (k: string) => issue(k),
    listBoards: () => ({ values: [{ id: 7, name: "AB board", type: "scrum" }] }),
    listSprints: (_board: number, o: { state: string }) => ({ values: o.state === "active" ? [{ id: 70, name: "Sprint 7", state: "active" }] : [{ id: 71, name: "Sprint 8", state: "future" }] }),
    moveIssuesToSprint: (id: number, keys: string[]) => void moves.push(`${id}:${keys.join(",")}`),
    moveIssuesToBacklog: (keys: string[]) => void moves.push(`backlog:${keys.join(",")}`),
  });

  test("the marked issues go to the picked sprint of the project's scrum board", async () => {
    const moves: string[] = [];
    const t = setup(sprintStub(moves));
    await listed(t, []);
    press(t, "space", "space", "s");
    await t.settle();
    const picker = topOverlay(t.ctx.store.get());
    expect(picker?.kind === "picker" && picker.items.map((i) => i.label)).toEqual(["Sprint 7", "Sprint 8", "Backlog"]);
    press(t, "down", "return", "y");
    await t.settle();
    expect(moves).toEqual(["71:AB-1,AB-2"]);
  });

  test("Backlog moves them out of any sprint", async () => {
    const moves: string[] = [];
    const t = setup(sprintStub(moves));
    await listed(t, []);
    press(t, "s");
    await t.settle();
    press(t, "down", "down", "return", "y");
    await t.settle();
    expect(moves).toEqual(["backlog:AB-1"]);
  });

  test("without a scrum board it says so", async () => {
    const t = setup({ ...sprintStub([]), listBoards: () => ({ values: [] }) });
    await listed(t, []);
    press(t, "s");
    await t.settle();
    expect(t.toasts().at(-1)?.text).toBe("No scrum board found for AB.");
  });
});

describe("parent", () => {
  test("(no parent) sends parent: null (live: an update with set none was silently ignored)", async () => {
    const t = setup({
      search: (jql: string) => ({ issues: jql.includes("issuetype = Epic") ? [] : [issue("AB-1", { parent: { key: "AB-9" } as never })] }),
      getIssue: (k: string) => issue(k),
      updateIssue: () => undefined,
    });
    await listed(t, []);
    press(t, "p");
    await t.settle();
    press(t, "return", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "updateIssue")?.args).toEqual(["AB-1", { fields: { parent: null } }]);
  });
});

describe("labels", () => {
  test("toggling sends only the difference", async () => {
    const t = setup({
      search: () => ({ issues: [issue("AB-1", { labels: ["a", "b"] })] }),
      getIssue: (k: string) => issue(k, { labels: ["a", "b"] }),
      addLabels: () => undefined,
      removeLabels: () => undefined,
    });
    await listed(t, []);
    press(t, "L");
    // b is marked; tab on it unmarks it. Then type a new one.
    press(t, "down", "tab");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "picker" }>), query: "new" }] }));
    press(t, "return");
    const confirm = topOverlay(t.ctx.store.get());
    expect(confirm?.kind === "confirm" && confirm.lines).toEqual(["+ new", "- b"]);
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "addLabels")?.args).toEqual(["AB-1", ["new"]]);
    expect(t.calls.find((c) => c.method === "removeLabels")?.args).toEqual(["AB-1", ["b"]]);
  });
});

describe("edit", () => {
  test("no change, no write", async () => {
    const t = setup({ search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k) });
    await listed(t, []);
    press(t, "e");
    await t.settle();
    press(t, "return");
    await t.settle();
    expect(t.toasts().at(-1)?.text).toBe("No changes.");
    expect(t.calls.some((c) => c.method === "updateIssue")).toBe(false);
  });

  test("an edited description shows a diff, then saves both fields", async () => {
    const t = setup(
      { search: () => ({ issues: [issue("AB-1")] }), getIssue: (k: string) => issue(k), updateIssue: () => undefined },
      { editText: async () => "new text" }
    );
    await listed(t, []);
    press(t, "e");
    await t.settle();
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "prompt" }>), value: "New summary" }] }));
    press(t, "return");
    await t.settle();
    const diff = topOverlay(t.ctx.store.get());
    expect(diff?.kind === "diff" && diff.after).toBe("# New summary\n\nnew text");
    press(t, "y");
    await t.settle();
    const fields = (t.calls.find((c) => c.method === "updateIssue")?.args[1] as { fields: Record<string, unknown> }).fields;
    expect(fields.summary).toBe("New summary");
    expect((fields.description as { type: string }).type).toBe("doc");
  });
});

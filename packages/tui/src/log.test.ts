import { describe, expect, test } from "bun:test";
import { AREAS, handleKey, refreshDue, startAutoRefresh } from "./app.js";
import { loadIssues } from "./jira.js";
import { formatCommand, shellQuote } from "./log.js";
import { initialState, topOverlay } from "./state.js";
import { commands, issue, setup, type TestSetup } from "./testing.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down"].includes(key);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name: key } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

const transitions = () => [{ id: "21", name: "Start", to: { id: "3", name: "In Progress" } }];

describe("shell quoting", () => {
  test("plain words stay, the rest is single-quoted so the line pastes into sh", () => {
    expect(shellQuote("ATLCLI-12")).toBe("ATLCLI-12");
    expect(shellQuote("In Arbeit")).toBe("'In Arbeit'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    // zsh expands a leading = to a command path.
    expect(shellQuote("=ls")).toBe("'=ls'");
    expect(formatCommand(["jira", "issue", "transition", "--key", "A-1", "--to", "In Arbeit"], "work")).toBe(
      "atlcli jira issue transition --key=A-1 '--to=In Arbeit' --profile=work"
    );
  });

  // Regression: Jira data starting with "-" became flags of the pasted line (a summary "--profile=prod" switched the profile).
  test("values from Jira cannot become flags of the pasted line", () => {
    expect(formatCommand(["jira", "issue", "clone", "K-1", "--summary", "--profile=prod"], "work")).toBe(
      "atlcli jira issue clone K-1 --summary=--profile=prod --profile=work"
    );
    expect(formatCommand(["jira", "board", "delete", "--id", "7", "--confirm", "--delete-filter"], "work")).toBe(
      "atlcli jira board delete --id=7 --confirm --delete-filter --profile=work"
    );
    // A positional value (label, comment) starting with "-" has no safe form: no line.
    expect(formatCommand(["jira", "bulk", "label", "add", "--jql=project=ACME", "--jql", "key in (A-1)"], "work")).toBeUndefined();
    expect(formatCommand(["jira", "issue", "comment", "--key", "A-1", "- a list item"], "work")).toBeUndefined();
  });
});

describe("command log", () => {
  test("a write logs what changed and the CLI command; a bulk write the bulk command", async () => {
    const t = setup({ search: () => ({ issues: [issue("A-1"), issue("A-2")] }), getIssue: (k: string) => issue(k), getTransitions: transitions, transitionIssue: () => undefined });
    await loadIssues(t.ctx, "Mine", "assignee = currentUser()");
    await t.settle();
    press(t, "t");
    await t.settle();
    press(t, "return", "y");
    await t.settle();
    press(t, "V", "t");
    await t.settle();
    press(t, "return", "y");
    await t.settle();
    const log = t.ctx.store.get().log;
    expect(log.map((e) => [e.ok, e.text, e.commands])).toEqual([
      [true, "A-1 updated", ["atlcli jira issue transition --key=A-1 --to=Start --profile=test"]],
      [true, "2 issues updated", ["atlcli jira bulk transition '--jql=key in (A-1, A-2)' --to=Start --profile=test"]],
    ]);
  });

  test("a failed write is logged with Jira's error", async () => {
    const t = setup({
      search: () => ({ issues: [issue("A-1")] }),
      getIssue: (k: string) => issue(k),
      getTransitions: transitions,
      transitionIssue: () => {
        throw new Error("Field 'resolution' is required");
      },
    });
    await loadIssues(t.ctx, "Mine", "x");
    await t.settle();
    press(t, "t");
    await t.settle();
    press(t, "return", "y");
    await t.settle();
    const [entry] = t.ctx.store.get().log;
    expect(entry).toMatchObject({ ok: false, text: "0 of 1 done. A-1: Field 'resolution' is required" });
  });

  test("! opens the log, y copies the selected entry's command", async () => {
    const t = setup({ search: () => ({ issues: [issue("A-1")] }), getIssue: (k: string) => issue(k), getTransitions: transitions, transitionIssue: () => undefined });
    const copied: string[] = [];
    t.ctx.copy = (text) => (copied.push(text), true);
    await loadIssues(t.ctx, "Mine", "x");
    await t.settle();
    press(t, "t");
    await t.settle();
    press(t, "return", "y");
    await t.settle();
    press(t, "!");
    expect(topOverlay(t.ctx.store.get())).toEqual({ kind: "log", selected: 0 });
    press(t, "y");
    expect(copied).toEqual(["atlcli jira issue transition --key=A-1 --to=Start --profile=test"]);
    press(t, "escape");
    expect(topOverlay(t.ctx.store.get())).toBeUndefined();
  });
});

describe("auto-refresh", () => {
  test("only when idle long enough, with nothing open, loading or saving", () => {
    const s = initialState("jira");
    expect(refreshDue(s, 60_000, 60_000)).toBe(true);
    expect(refreshDue(s, 59_000, 60_000)).toBe(false);
    expect(refreshDue(s, 60_000, 0)).toBe(false);
    expect(refreshDue({ ...s, busy: "Saving…" }, 60_000, 60_000)).toBe(false);
    expect(refreshDue({ ...s, overlays: [{ kind: "help" }] }, 60_000, 60_000)).toBe(false);
    expect(refreshDue({ ...s, jira: { ...s.jira, list: { ...s.jira.list, loading: true } } }, 60_000, 60_000)).toBe(false);
  });

  test("reloads the list quietly after the wait; a key press restarts it", async () => {
    let searches = 0;
    const t = setup({ search: () => (searches++, { issues: [issue("A-1")] }), getIssue: (k: string) => issue(k) });
    await loadIssues(t.ctx, "Mine", "x");
    await t.settle();
    let clock = 0;
    const timer = startAutoRefresh(t.ctx, AREAS, 60, () => clock, 5);
    try {
      clock = 59_000;
      await new Promise((r) => setTimeout(r, 20));
      expect(searches).toBe(1);
      timer.activity();
      clock = 118_000;
      await new Promise((r) => setTimeout(r, 20));
      expect(searches).toBe(1);
      clock = 119_000;
      await new Promise((r) => setTimeout(r, 20));
      expect(searches).toBe(2);
      // Quiet: the detail was not dropped while it reloaded.
      expect(t.ctx.store.get().jira.details["A-1"]?.status).toBe("ok");
    } finally {
      timer.stop();
    }
  });
});

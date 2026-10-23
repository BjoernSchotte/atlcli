/**
 * The shell rendered by OpenTUI's test renderer: what is on screen, and what
 * keys and mouse clicks do to it. No terminal, no network (stub clients).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { allCommands, AREAS, Shell } from "./app.js";
import { jira } from "./jira.js";
import { issue, setup, type TestSetup } from "./testing.js";
import { syntaxStyleFor, THEMES } from "./theme.js";
import { EnvProvider, type Env } from "./views.js";

// Renders happen outside act(); React's act warnings would only be noise here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

let screen: TestRendererSetup | undefined;
afterEach(async () => {
  await screen?.dispose();
  screen = undefined;
});

const issues = [
  issue("AB-1", { summary: "Fix the login", status: { id: "1", name: "To Do" } as never }),
  issue("AB-2", { summary: "Write the docs", status: { id: "3", name: "In Progress" } as never, assignee: { displayName: "Ann Lee" } as never }),
];

async function show(t: TestSetup, width = 140, height = 30) {
  const env = (renderer: TestRendererSetup["renderer"]): Env => ({
    ctx: t.ctx,
    theme: THEMES.dark,
    syntax: syntaxStyleFor(THEMES.dark, renderer.nativeScene),
    commands: allCommands(),
    areas: AREAS,
    keymap: {},
  });
  // testRender creates the renderer, which the syntax style needs; the shell renders into it next.
  screen = await testRender(<></>, { width, height });
  const { createRoot } = await import("@opentui/react");
  createRoot(screen.renderer).render(
    <EnvProvider value={env(screen.renderer)}>
      <Shell />
    </EnvProvider>
  );
  await jira.init(t.ctx);
  await t.settle();
  await screen.renderOnce();
  return screen;
}

const jiraStub = () =>
  setup({
    search: () => ({ issues }),
    getIssue: (k: string) => issues.find((i) => i.key === k) ?? issue(k),
  });

describe("shell", () => {
  test("header, navigator, list, detail and status bar", async () => {
    const s = await show(jiraStub());
    const frame = s.captureCharFrame();
    expect(frame).toContain("1 Jira");
    expect(frame).toContain("My open issues");
    expect(frame).toContain("AB-1");
    expect(frame).toContain("Write the docs");
    expect(frame).toContain("Fix the login");
    expect(frame).toMatch(/details\s+comments/);
    expect(frame).toContain("q quit");
  });

  test("j moves to the next issue and the detail follows", async () => {
    const t = jiraStub();
    const s = await show(t);
    s.mockInput.pressKey("j");
    await t.settle();
    await s.renderOnce();
    expect(t.ctx.store.get().jira.list.selected).toBe(1);
    expect(s.captureCharFrame()).toMatch(/─ AB-2 ─/);
  });

  test("? opens the help, esc closes it", async () => {
    const t = jiraStub();
    const s = await show(t);
    s.mockInput.pressKey("?");
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Keys · esc closes");
    s.mockInput.pressEscape();
    // A lone ESC byte only counts as Escape after the parser's wait for a longer sequence.
    await new Promise((r) => setTimeout(r, 150));
    await t.settle();
    await s.renderOnce();
    expect(s.captureCharFrame()).not.toContain("Keys · esc closes");
  });

  test("a click on a row selects it", async () => {
    const t = jiraStub();
    const s = await show(t);
    const lines = s.captureCharFrame().split("\n");
    const y = lines.findIndex((l) => l.includes("AB-2"));
    const x = lines[y]!.indexOf("AB-2");
    await s.mockMouse.click(x, y);
    await t.settle();
    await s.renderOnce();
    expect(t.ctx.store.get().jira.list.selected).toBe(1);
  });

  test("narrow terminals stack list and detail and hide the navigator", async () => {
    const s = await show(jiraStub(), 80, 30);
    const frame = s.captureCharFrame();
    expect(frame).not.toContain("Navigator");
    const listRow = frame.split("\n").findIndex((l) => l.includes("My open issues ("));
    const detailRow = frame.split("\n").findIndex((l) => /─ AB-1 ─/.test(l));
    expect(detailRow).toBeGreaterThan(listRow);
  });
});

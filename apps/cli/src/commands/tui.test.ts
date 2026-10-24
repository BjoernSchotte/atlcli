import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tuiConfig, tuiViews, withProfileViews } from "./tui.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("tuiConfig", () => {
  test("takes valid settings", () => {
    expect(tuiConfig({ area: "wiki", theme: "light", keymap: { "jira.transition": ["T"] }, columns: ["key", "type"] })).toEqual({
      area: "wiki",
      theme: "light",
      keymap: { "jira.transition": ["T"] },
      columns: ["key", "type"],
    });
    expect(tuiConfig(undefined)).toEqual({});
  });

  test("a typo says so instead of falling back silently", () => {
    expect(() => tuiConfig({ theme: "dakr" })).toThrow('tui.theme must be "dark" or "light", not "dakr".');
    expect(() => tuiConfig({ area: "confluence" })).toThrow("tui.area");
    expect(() => tuiConfig({ keymap: { x: "t" as never } })).toThrow("tui.keymap");
    expect(() => tuiConfig({ columns: ["key", "sumary"] })).toThrow("not sumary");
  });
});

describe("tui.refresh", () => {
  test("whole seconds; 0 turns it off, small values become 10", () => {
    expect(tuiConfig({ refresh: 30 })).toEqual({ refresh: 30 });
    expect(tuiConfig({ refresh: 0 })).toEqual({ refresh: 0 });
    expect(tuiConfig({ refresh: 2 })).toEqual({ refresh: 10 });
    expect(() => tuiConfig({ refresh: -1 })).toThrow("tui.refresh");
    expect(() => tuiConfig({ refresh: "60" as never })).toThrow("tui.refresh");
  });
});

describe("tui.views", () => {
  const all = [
    { profile: "work", area: "jira", name: "Bugs", query: "type = Bug" },
    { profile: "home", area: "wiki", name: "Howtos", query: 'label = "howto"' },
  ];

  test("the profile's views only", () => {
    expect(tuiViews({ views: all }, "work")).toEqual([{ area: "jira", name: "Bugs", query: "type = Bug" }]);
    expect(tuiViews(undefined, "work")).toEqual([]);
  });

  test("a broken entry says so", () => {
    expect(() => tuiViews({ views: [{ profile: "work", area: "confluence", name: "x", query: "y" }] }, "work")).toThrow("tui.views");
    expect(() => tuiViews({ views: [{ area: "jira", name: "x", query: "y" } as never] }, "work")).toThrow("tui.views");
  });

  test("saving replaces the profile's views and keeps the others'", () => {
    expect(withProfileViews(all, "work", [{ area: "jira", name: "Mine", query: "assignee = currentUser()" }])).toEqual([
      { profile: "home", area: "wiki", name: "Howtos", query: 'label = "howto"' },
      { profile: "work", area: "jira", name: "Mine", query: "assignee = currentUser()" },
    ]);
    expect(withProfileViews(undefined, "work", [])).toEqual([]);
  });
});

describe("atlcli tui", () => {
  test("without a terminal it fails instead of waiting for input", async () => {
    const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "tui", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error).toMatchObject({ code: "ATLCLI_ERR_USAGE", message: "atlcli tui needs an interactive terminal." });
  });

  test("--help works anywhere and names the keys", async () => {
    const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "tui", "--help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" } });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("atlcli tui [--area jira|wiki]");
    expect(stdout).toContain("ctrl+k");
  });
});

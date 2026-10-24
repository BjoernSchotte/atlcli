import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { tuiConfig } from "./tui.js";

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

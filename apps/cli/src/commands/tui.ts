import { ERROR_CODES, fail, getActiveProfile, getFlag, hasFlag, loadConfig, output, resolveDefaults, type OutputOptions, type TuiSettings } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { JiraClient, resolveStatusMap } from "@atlcli/jira";
import type { TuiColumn, TuiConfig } from "@atlcli/tui";

const COLUMNS: TuiColumn[] = ["key", "type", "status", "priority", "assignee", "updated"];
import { openUrl } from "./jira.js";
import { editInEditor } from "./jira-input.js";
import { assertCliAuthSupported } from "./session-guard.js";

export function tuiHelp(): string {
  return `atlcli tui [--area jira|wiki] [--jql <query>] [--project <key>] [--board <id>] [--space <key>] [--profile <name>]

A fullscreen terminal UI for working in Jira and Confluence: browse, read,
triage and edit issues and pages, with keyboard and mouse.

Options:
  --area <jira|wiki>  Start area (default: jira, or tui.area in the config)
  --jql <query>       Initial Jira list (default: your open issues)
  --project <key>     Project for the navigator's boards and epics (default: config)
  --board <id>        Board to preselect (default: config)
  --space <key>       Confluence space to open (default: config)
  --profile <name>    Auth profile

Keys: ? shows the keys of the focused pane, : (or ctrl+k) finds every command
by name, 1/2 switch between Jira and Wiki, q quits.

Config (~/.atlcli/config.json, optional):
  "tui": { "area": "wiki", "theme": "light", "columns": ["key", "type", "status", "assignee"],
           "keymap": { "jira.transition": ["t", "T"] } }

Needs an interactive terminal; in CI or a pipe it fails instead of waiting for input.`;
}

/** `tui` from the config, checked: a typo should say so, not silently fall back. */
export function tuiConfig(settings: TuiSettings | undefined): TuiConfig {
  const config: TuiConfig = {};
  if (!settings) return config;
  if (settings.area !== undefined) {
    if (settings.area !== "jira" && settings.area !== "wiki") throw new Error(`tui.area must be "jira" or "wiki", not "${settings.area}".`);
    config.area = settings.area;
  }
  if (settings.theme !== undefined) {
    if (settings.theme !== "dark" && settings.theme !== "light") throw new Error(`tui.theme must be "dark" or "light", not "${settings.theme}".`);
    config.theme = settings.theme;
  }
  if (settings.keymap !== undefined) {
    const ok = typeof settings.keymap === "object" && Object.values(settings.keymap).every((keys) => Array.isArray(keys) && keys.every((k) => typeof k === "string"));
    if (!ok) throw new Error('tui.keymap maps command ids to key lists: { "jira.transition": ["t"] }.');
    config.keymap = settings.keymap;
  }
  if (settings.columns !== undefined) {
    const bad = Array.isArray(settings.columns) ? settings.columns.filter((c) => !COLUMNS.includes(c as TuiColumn)) : ["(not a list)"];
    if (bad.length) throw new Error(`tui.columns takes ${COLUMNS.join(", ")}; not ${bad.join(", ")}.`);
    config.columns = settings.columns as TuiColumn[];
  }
  return config;
}

export async function handleTui(
  _args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  if (hasFlag(flags, "help")) {
    output(tuiHelp(), opts);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(opts, 1, ERROR_CODES.USAGE, "atlcli tui needs an interactive terminal.");
  }
  const area = getFlag(flags, "area");
  if (area !== undefined && area !== "jira" && area !== "wiki") fail(opts, 1, ERROR_CODES.USAGE, "--area must be jira or wiki.");
  const boardFlag = getFlag(flags, "board");
  if (boardFlag !== undefined && !/^\d+$/.test(boardFlag)) fail(opts, 1, ERROR_CODES.USAGE, "--board must be a board id.");

  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  assertCliAuthSupported(profile, opts);
  let tui: TuiConfig;
  try {
    tui = tuiConfig(config.tui);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.CONFIG, err instanceof Error ? err.message : String(err));
  }
  const defaults = resolveDefaults(config, profile);
  const statusMap = resolveStatusMap(config.flow?.statusMap, profile.flow?.statusMap);
  const jira = new JiraClient(profile);

  // Loaded only here: the rest of the CLI never pays for OpenTUI's native library.
  const { runTui } = await import("@atlcli/tui");
  await runTui({
    profile: profile.name,
    siteUrl: jira.siteUrl,
    jira,
    confluence: new ConfluenceClient(profile),
    area: area as "jira" | "wiki" | undefined,
    jql: getFlag(flags, "jql"),
    project: getFlag(flags, "project") ?? defaults.project,
    board: boardFlag !== undefined ? Number(boardFlag) : defaults.board,
    space: getFlag(flags, "space") ?? defaults.space,
    doneStatuses: Object.keys(statusMap).filter((status) => statusMap[status] === "done"),
    config: tui,
    openUrl,
    editText: editInEditor,
  });
}

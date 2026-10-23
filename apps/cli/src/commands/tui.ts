import { ERROR_CODES, fail, getFlag, hasFlag, output, type OutputOptions } from "@atlcli/core";
import { getClient, openUrl } from "./jira.js";
import { buildSearchJql } from "./jira-input.js";

const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

export function tuiHelp(): string {
  return `atlcli tui [--project <key>] [--jql <query>] [--profile <name>]

Fullscreen Jira browser (spike). Without --project or --jql it lists your open issues.

Keys: j/k move, g/G top/bottom, tab/enter/esc switch pane, space page,
o open in browser, r reload, q quit. Mouse: click to select, wheel to scroll.

Needs an interactive terminal; in CI or a pipe it fails instead of waiting for input.`;
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
  const project = getFlag(flags, "project");
  const jql = getFlag(flags, "jql");
  const query = project || jql ? buildSearchJql({ project, jql }) : DEFAULT_JQL;
  const client = await getClient(flags, opts);
  // Loaded only here: the rest of the CLI never pays for OpenTUI's native library.
  const { runTui } = await import("../tui/app.js");
  await runTui({ client, jql: query, openUrl });
}

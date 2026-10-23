/**
 * Shell completion logic for atlcli.
 *
 * This module provides dynamic completions by analyzing the command context
 * and returning matching commands, subcommands, and flags.
 */

import { ROOT_COMMANDS } from "./root-commands.js";

/**
 * Plugin command info for dynamic completion.
 */
export interface PluginCommandInfo {
  name: string;
  subcommands?: string[];
}

// Root commands (built-in)
const BUILTIN_ROOT_COMMANDS = ROOT_COMMANDS.map(([name]) => name).sort();

// Subcommands for each root command
const SUBCOMMANDS: Record<string, string[]> = {
  audit: ["jira", "wiki"],
  auth: ["delete", "init", "list", "login", "logout", "rename", "status", "switch"],
  completion: ["bash", "zsh"],
  config: ["get", "list", "set", "unset"],
  jira: [
    "analyze",
    "board",
    "bulk",
    "component",
    "epic",
    "export",
    "field",
    "filter",
    "import",
    "issue",
    "me",
    "my",
    "open",
    "project",
    "search",
    "sprint",
    "subtask",
    "template",
    "unwatch",
    "version",
    "watch",
    "watchers",
    "webhook",
    "worklog",
  ],
  log: ["clear", "list", "show", "tail"],
  plugin: ["disable", "enable", "install", "list", "remove"],
  "pdf-template": [
    "analyze",
    "build",
    "clear-optional",
    "clear-override",
    "decide",
    "diff",
    "import",
    "pack",
    "preview",
    "reanalyze",
    "review",
    "set",
    "status",
    "undo",
    "validate",
  ],
  wiki: [
    "docs",
    "mount",
    "my",
    "page",
    "publish",
    "recent",
    "search",
    "sh",
    "space",
    "template",
    "unmount",
    "vfs",
  ],
};

// Nested subcommands (command -> subcommand -> sub-subcommands)
const NESTED_SUBCOMMANDS: Record<string, Record<string, string[]>> = {
  wiki: {
    docs: ["add", "check", "diff", "init", "pull", "push", "resolve", "status", "sync", "watch"],
    publish: ["plan", "refresh", "build", "verify", "run", "status", "prune"],
    mount: ["list", "status", "unmount"],
    vfs: ["cache", "conflicts"],
    page: [
      "archive",
      "children",
      "comments",
      "copy",
      "create",
      "delete",
      "diff",
      "get",
      "history",
      "label",
      "list",
      "move",
      "open",
      "restore",
      "sort",
      "update",
    ],
    space: ["create", "get", "list"],
    template: [
      "copy",
      "create",
      "delete",
      "edit",
      "export",
      "import",
      "init",
      "list",
      "rename",
      "render",
      "show",
      "update",
      "validate",
    ],
  },
  jira: {
    analyze: ["aging", "burndown", "cfd", "flow", "predictability", "scope-change", "velocity"],
    board: ["backlog", "get", "issues", "list"],
    bulk: ["delete", "edit", "label", "link-page", "move", "transition"],
    component: ["create", "delete", "get", "list", "update"],
    epic: ["add", "create", "get", "issues", "list", "progress", "remove"],
    field: ["get", "list", "options", "search"],
    filter: ["create", "delete", "get", "list", "run", "share", "update"],
    issue: [
      "assign",
      "attach",
      "attachment",
      "attachments",
      "clone",
      "comment",
      "comments",
      "create",
      "delete",
      "get",
      "history",
      "link",
      "link-page",
      "open",
      "pages",
      "transition",
      "transitions",
      "unlink",
      "unlink-page",
      "update",
    ],
    project: ["create", "get", "list", "types"],
    sprint: [
      "add",
      "close",
      "create",
      "delete",
      "get",
      "issues",
      "list",
      "remove",
      "report",
      "review",
      "start",
    ],
    subtask: ["create", "list"],
    template: ["apply", "delete", "export", "get", "import", "list", "save"],
    version: ["create", "delete", "get", "list", "notes", "release", "update"],
    webhook: ["delete", "list", "refresh", "register", "serve"],
    worklog: ["add", "delete", "list", "report", "timer", "update"],
  },
};

// Third-level subcommands
const THIRD_LEVEL_SUBCOMMANDS: Record<string, Record<string, Record<string, string[]>>> = {
  jira: {
    bulk: {
      label: ["add", "remove"],
    },
    issue: {
      attachment: ["delete", "download"],
      comments: ["add", "delete", "edit", "list"],
    },
    worklog: {
      timer: ["cancel", "start", "status", "stop"],
    },
  },
};

// Global flags available on all commands
const GLOBAL_FLAGS = ["--help", "--json", "--no-log", "--profile"];

// Command-specific flags
const COMMAND_FLAGS: Record<string, string[]> = {
  "pdf-template import": ["--baseline", "--dir", "--metadata-only", "--policy"],
  "pdf-template analyze": ["--baseline", "--dir", "--metadata-only", "--policy"],
  "pdf-template status": ["--details", "--dir"],
  "pdf-template review": [
    "--acknowledge-unsupported",
    "--apply-ready",
    "--dir",
    "--keep-current-for-remaining",
    "--non-interactive",
  ],
  "pdf-template preview": ["--dir", "--output-dir"],
  "pdf-template build": ["--dir", "--output"],
  "pdf-template undo": ["--dir"],
  "pdf-template reanalyze": ["--dir", "--metadata-only"],
  "pdf-template diff": ["--details", "--dir"],
  "pdf-template decide": [
    "--accept",
    "--accept-asset",
    "--accept-recommended",
    "--accept-safe",
    "--acknowledge-unsupported",
    "--alt",
    "--candidate",
    "--custom-placement",
    "--decorative",
    "--dir",
    "--group",
    "--keep-baseline-for-remaining",
    "--meaningful",
    "--reject",
    "--reset-group",
    "--rights-confirmed",
    "--role",
    "--slot-default",
    "--use-baseline",
    "--use-candidate-placement",
  ],
  "pdf-template set": ["--dir", "--target", "--value"],
  "pdf-template clear-override": ["--dir", "--target"],
  "pdf-template clear-optional": ["--dir", "--target"],
  "pdf-template validate": ["--dir"],
  "pdf-template pack": ["--dir", "--output"],

  // auth flags
  "auth init": ["--email", "--profile", "--site", "--token"],
  "auth login": ["--email", "--profile", "--site", "--token"],

  // doctor flags
  doctor: ["--fix"],

  // wiki docs flags
  "wiki docs init": ["--ancestor", "--page-id", "--space"],
  "wiki docs pull": ["--auto-create", "--dry-run", "--label"],
  "wiki docs push": ["--dry-run", "--force", "--validate"],
  "wiki docs sync": ["--dry-run", "--label"],
  "wiki docs watch": ["--interval"],
  "wiki docs check": ["--fix"],

  // wiki publish lifecycle
  "wiki publish plan": ["--allow-partial", "--confirm-public", "--json", "--profile", "--project", "--workspace"],
  "wiki publish refresh": ["--allow-partial", "--confirm-public", "--dry-run", "--json", "--profile", "--project", "--workspace"],
  "wiki publish build": ["--json", "--project", "--workspace"],
  "wiki publish verify": ["--build", "--json", "--project", "--workspace"],
  "wiki publish run": ["--allow-partial", "--confirm-public", "--dry-run", "--json", "--profile", "--project", "--workspace"],
  "wiki publish status": ["--json", "--project", "--workspace"],
  "wiki publish prune": ["--confirm", "--json", "--project", "--workspace"],

  // wiki sh / wiki vfs
  "wiki sh": [
    "--allow-delete",
    "--cache-dir",
    "--cache-max-mb",
    "--cwd",
    "--json",
    "--mode",
    "--no-cql",
    "--offline",
    "--prefetch-max",
    "--profile",
    "--space",
    "--timeout",
  ],
  "wiki mount": [
    "--allow-delete",
    "--cache-dir",
    "--json",
    "--mode",
    "--port",
    "--profile",
    "--space",
  ],
  "wiki unmount": ["--cache-dir", "--json", "--profile"],
  "wiki vfs cache": ["--cache-dir", "--json", "--profile"],
  "wiki vfs conflicts": ["--cache-dir", "--json", "--profile"],

  // wiki page flags
  "wiki page list": ["--ancestor", "--limit", "--space"],
  "wiki page get": ["--format", "--id", "--markdown"],
  "wiki page create": ["--body", "--file", "--parent", "--space", "--template", "--title"],
  "wiki page update": ["--body", "--file", "--id", "--title"],
  "wiki page delete": ["--cql", "--dry-run", "--id"],
  "wiki page archive": ["--cql", "--dry-run", "--id"],
  "wiki page move": ["--after", "--before", "--first", "--id", "--last", "--parent", "--position"],
  "wiki page copy": ["--id", "--parent", "--space", "--title"],
  "wiki page sort": ["--id", "--recursive", "--reverse", "--strategy"],
  "wiki page children": ["--depth", "--id", "--limit"],
  "wiki page label": ["--cql", "--id"],
  "wiki page history": ["--id", "--limit"],
  "wiki page diff": [
    "--context",
    "--format",
    "--from",
    "--id",
    "--no-color",
    "--to",
    "--version",
    "--word-diff",
  ],
  "wiki page restore": ["--id", "--version"],
  "wiki page comments": ["--id"],
  "wiki page open": ["--id"],

  // wiki space flags
  "wiki space list": ["--limit"],
  "wiki space get": ["--key"],
  "wiki space create": ["--description", "--key", "--name"],

  // wiki template flags
  "wiki template list": ["--global", "--local", "--space"],
  "wiki template show": ["--global", "--local", "--space"],
  "wiki template create": ["--body", "--category", "--description", "--file", "--global", "--local", "--space"],
  "wiki template delete": ["--global", "--local", "--space"],
  "wiki template render": ["--global", "--local", "--output", "--space", "--var"],
  "wiki template validate": ["--global", "--local", "--space"],
  "wiki template export": ["--global", "--local", "--output", "--space"],
  "wiki template import": ["--global", "--local", "--space"],

  // config flags (key completions)
  "config get": ["global.board", "global.project", "global.space", "logging.global", "logging.level", "logging.project"],
  "config set": ["global.board", "global.project", "global.space", "logging.global", "logging.level", "logging.project"],
  "config unset": ["global.board", "global.project", "global.space", "logging.global", "logging.level", "logging.project"],

  // wiki search flags
  "wiki search": ["--cql", "--label", "--limit", "--space", "--type"],
  "wiki recent": ["--days", "--label", "--limit", "--space"],
  "wiki my": ["--contributed", "--label", "--limit", "--space"],

  // jira search flags
  "jira search": [
    "--all-results",
    "--assignee",
    "--columns",
    "--created",
    "--created-before",
    "--csv",
    "--delimiter",
    "--history",
    "--jql",
    "--label",
    "--limit",
    "--no-headers",
    "--plain",
    "--project",
    "--sprint",
    "--status",
    "--type",
    "--updated",
    "--updated-before",
    "--watching",
  ],

  // jira my flags
  "jira my": ["--all", "--all-results", "--columns", "--csv", "--delimiter", "--limit", "--no-headers", "--plain", "--project", "--status", "--type"],

  // jira project flags
  "jira project list": ["--limit", "--query"],
  "jira project get": ["--key"],
  "jira project create": ["--description", "--key", "--lead", "--name", "--template", "--type"],
  "jira project types": ["--key"],

  // jira issue flags
  "jira issue get": ["--expand", "--format", "--id", "--key"],
  "jira issue create": [
    "--assignee",
    "--description",
    "--description-file",
    "--edit",
    "--field",
    "--labels",
    "--parent",
    "--priority",
    "--project",
    "--summary",
    "--type",
  ],
  "jira issue update": [
    "--add-labels",
    "--assignee",
    "--description",
    "--description-file",
    "--edit",
    "--field",
    "--key",
    "--priority",
    "--remove-labels",
    "--summary",
  ],
  "jira issue clone": ["--assignee", "--key", "--labels", "--parent", "--priority", "--project", "--replace", "--summary", "--type"],
  "jira issue delete": ["--confirm", "--delete-subtasks", "--key"],
  "jira issue transition": ["--key", "--to"],
  "jira issue transitions": ["--key"],
  "jira issue assign": ["--assignee", "--key"],
  "jira issue comment": ["--body", "--body-file", "--edit", "--internal", "--key"],
  "jira issue comments add": ["--body", "--body-file", "--edit", "--internal", "--key"],
  "jira issue comments list": ["--format", "--key", "--limit"],
  "jira issue comments edit": ["--body", "--body-file", "--id", "--key"],
  "jira issue comments delete": ["--confirm", "--id", "--key"],
  "jira issue history": ["--field", "--key", "--limit"],
  "jira issue link": ["--from", "--key", "--title", "--to", "--type", "--url"],
  "jira issue unlink": ["--confirm", "--from", "--key", "--link", "--remote", "--to", "--type"],
  "jira issue link-page": ["--comment", "--key", "--page"],
  "jira issue pages": ["--key"],
  "jira issue unlink-page": ["--key", "--link", "--page"],
  "jira issue attach": ["--comment", "--key"],
  "jira issue attachments": ["--key"],
  "jira issue attachment download": ["--output", "--overwrite"],
  "jira issue attachment delete": ["--confirm"],
  "jira issue open": ["--key"],

  // jira board flags
  "jira board list": ["--all-projects", "--limit", "--name", "--project", "--type"],
  "jira board get": ["--id"],
  "jira board backlog": ["--columns", "--csv", "--delimiter", "--id", "--jql", "--limit", "--no-headers", "--plain"],
  "jira board issues": ["--columns", "--csv", "--delimiter", "--id", "--jql", "--limit", "--no-headers", "--plain"],

  // jira sprint flags
  "jira sprint list": ["--board", "--limit", "--state"],
  "jira sprint get": ["--id"],
  "jira sprint create": ["--board", "--end", "--goal", "--name", "--start"],
  "jira sprint start": ["--end", "--goal", "--id", "--start"],
  "jira sprint close": ["--id"],
  "jira sprint delete": ["--confirm", "--id"],
  "jira sprint issues": ["--columns", "--csv", "--delimiter", "--id", "--jql", "--limit", "--no-headers", "--plain"],
  "jira sprint add": ["--issues", "--sprint"],
  "jira sprint remove": ["--issues"],
  "jira sprint report": ["--id", "--points-field", "--status-map"],
  "jira sprint review": [
    "--dry-run",
    "--export",
    "--export-template",
    "--force",
    "--id",
    "--list-templates",
    "--parent",
    "--points-field",
    "--print-template",
    "--space",
    "--status-map",
    "--template",
    "--title",
    "--var",
  ],

  // jira worklog flags
  "jira worklog add": ["--comment", "--issue", "--round", "--started", "--time"],
  "jira worklog list": ["--issue", "--limit"],
  "jira worklog update": ["--comment", "--id", "--issue", "--started", "--time"],
  "jira worklog delete": ["--confirm", "--id", "--issue"],
  "jira worklog timer start": ["--comment", "--issue"],
  "jira worklog timer stop": ["--comment", "--round"],
  "jira worklog report": ["--group-by", "--since", "--until", "--user"],

  // jira epic flags
  "jira epic list": ["--board", "--done", "--limit", "--project"],
  "jira epic create": ["--description", "--description-file", "--project", "--summary"],
  "jira epic issues": ["--columns", "--csv", "--delimiter", "--limit", "--no-headers", "--plain", "--status"],
  "jira epic add": ["--epic"],

  // jira analyze flags
  "jira analyze velocity": ["--board", "--points-field", "--sprints", "--status-map"],
  "jira analyze burndown": ["--points-field", "--sprint", "--status-map"],
  "jira analyze predictability": ["--board", "--points-field", "--sprints", "--status-map"],
  "jira analyze scope-change": ["--points-field", "--sprint", "--status-map"],
  "jira analyze flow": ["--board", "--csv", "--jql", "--limit", "--project", "--since", "--status-map"],
  "jira analyze aging": ["--board", "--csv", "--jql", "--limit", "--project", "--since", "--status-map"],
  "jira analyze cfd": ["--board", "--csv", "--group-by", "--jql", "--limit", "--project", "--since", "--status-map"],
  "audit jira": [
    "--all",
    "--board",
    "--checks",
    "--fail-on",
    "--flagged-field",
    "--jql",
    "--limit",
    "--markdown",
    "--min-level",
    "--no-baseline",
    "--points-field",
    "--project",
    "--prune-baseline",
    "--rules",
    "--stale",
    "--status-map",
    "--update-baseline",
  ],
  digest: [
    "--board",
    "--include-own",
    "--limit",
    "--markdown",
    "--max-pages",
    "--no-mark",
    "--only",
    "--project",
    "--since",
    "--space",
    "--status-map",
    "--summarize",
    "--verbose",
  ],

  // jira bulk flags (all take --jql or --issues)
  "jira bulk edit": ["--dry-run", "--issues", "--jql", "--limit", "--set"],
  "jira bulk transition": ["--dry-run", "--issues", "--jql", "--limit", "--to"],
  "jira bulk label": ["--dry-run", "--issues", "--jql", "--label", "--limit"],
  "jira bulk delete": ["--confirm", "--dry-run", "--issues", "--jql", "--limit"],
  "jira bulk move": ["--backlog", "--dry-run", "--issues", "--jql", "--limit", "--sprint"],
  "jira bulk link-page": ["--comment", "--dry-run", "--issues", "--jql", "--limit", "--page"],

  // jira filter flags
  "jira filter list": ["--favorite", "--limit", "--query"],
  "jira filter get": ["--id"],
  "jira filter create": ["--description", "--favorite", "--jql", "--name"],
  "jira filter update": ["--description", "--id", "--jql", "--name"],
  "jira filter delete": ["--confirm", "--id"],
  "jira filter share": ["--group", "--id", "--project", "--type", "--user"],
  "jira filter run": ["--all-results", "--columns", "--csv", "--delimiter", "--id", "--limit", "--no-headers", "--plain"],

  // jira export/import flags
  "jira export": ["--format", "--jql", "--no-attachments", "--no-comments", "--output"],
  "jira import": ["--dry-run", "--file", "--map-field", "--project", "--skip-attachments"],

  // jira webhook flags
  "jira webhook serve": ["--events", "--path", "--port", "--projects", "--secret"],
  "jira webhook register": ["--events", "--jql", "--url"],
  "jira webhook delete": ["--id"],
  "jira webhook refresh": ["--id"],

  // jira subtask flags
  "jira subtask create": ["--assignee", "--description", "--description-file", "--parent", "--priority", "--summary"],
  "jira subtask list": ["--parent"],

  // jira component flags
  "jira component list": ["--project"],
  "jira component get": ["--id"],
  "jira component create": ["--description", "--lead", "--name", "--project"],
  "jira component update": ["--description", "--id", "--lead", "--name"],
  "jira component delete": ["--confirm", "--id"],

  // jira version flags
  "jira version list": ["--project"],
  "jira version get": ["--id"],
  "jira version create": ["--description", "--name", "--project", "--release-date", "--start-date"],
  "jira version update": ["--description", "--id", "--name", "--release-date", "--start-date"],
  "jira version release": ["--id"],
  "jira version delete": ["--confirm", "--id"],
  "jira version notes": [
    "--dry-run",
    "--export",
    "--export-template",
    "--force",
    "--group-by",
    "--id",
    "--list-templates",
    "--parent",
    "--points-field",
    "--print-template",
    "--project",
    "--space",
    "--status-map",
    "--template",
    "--title",
    "--var",
  ],

  // jira field flags
  "jira field list": ["--custom", "--system", "--type"],
  "jira field get": ["--id"],
  "jira field options": ["--id"],
  "jira field search": ["--query"],

  // jira template flags
  "jira template list": ["--all", "--expand", "--level", "--project", "--search", "--tag", "--type"],
  "jira template save": ["--description", "--force", "--issue", "--level", "--name", "--project", "--tags"],
  "jira template get": ["--name", "--project"],
  "jira template apply": ["--assignee", "--description", "--name", "--project", "--summary"],
  "jira template delete": ["--confirm", "--level", "--name", "--project"],
  "jira template export": ["--name", "--output", "--project"],
  "jira template import": ["--file", "--force", "--level", "--project"],

  // log flags
  "log list": ["--global", "--level", "--limit", "--project", "--since", "--type", "--until"],
  "log tail": ["--follow", "--global", "--level", "--lines", "--project", "--type"],
  "log show": ["--global", "--id", "--project"],
  "log clear": ["--all", "--before", "--global", "--project"],

  // plugin flags
  "plugin install": ["--global", "--local"],
  "plugin remove": [],
  "plugin enable": [],
  "plugin disable": [],

  // update flags
  update: ["--check"],
};

/**
 * Filter items that start with the given prefix.
 */
function filterPrefix(items: string[], prefix: string): string[] {
  if (!prefix) return items;
  const lower = prefix.toLowerCase();
  return items.filter((item) => item.toLowerCase().startsWith(lower));
}

/**
 * Get completions for the given command context.
 *
 * @param args - The words typed so far (excluding 'atlcli')
 * @param pluginCommands - Optional plugin commands to include
 * @returns Array of completion strings
 */
export function getCompletions(
  args: string[],
  pluginCommands: PluginCommandInfo[] = []
): string[] {
  // Build root commands list including plugins
  const rootCommands = [
    ...BUILTIN_ROOT_COMMANDS,
    ...pluginCommands.map((p) => p.name),
  ].sort();

  // Build subcommands map including plugins
  const subcommands: Record<string, string[]> = { ...SUBCOMMANDS };
  for (const plugin of pluginCommands) {
    if (plugin.subcommands && plugin.subcommands.length > 0) {
      subcommands[plugin.name] = plugin.subcommands.sort();
    }
  }

  // Check if there's a trailing empty string (user typed a space after the last word)
  const hasTrailingSpace = args.length > 0 && args[args.length - 1] === "";

  // Filter out empty strings for non-trailing positions
  const words = args.filter((w) => w !== "");

  // No words yet - complete root commands
  if (words.length === 0) {
    return rootCommands;
  }

  // Determine current word and completed words
  // If there's a trailing space, all words are complete and we're starting a new one
  const current = hasTrailingSpace ? "" : words[words.length - 1];
  const completed = hasTrailingSpace ? words : words.slice(0, -1);

  // If current word starts with -, complete flags
  if (current.startsWith("-")) {
    return getFlags(completed, current);
  }

  // Check if previous word is a flag that expects a value
  if (completed.length > 0) {
    const prev = completed[completed.length - 1];
    if (prev.startsWith("-") && !prev.startsWith("--no-")) {
      // Flag value completion (could be enhanced with dynamic values)
      return [];
    }
  }

  // Level 0: Complete root command
  if (completed.length === 0) {
    return filterPrefix(rootCommands, current);
  }

  const rootCmd = completed[0];

  // Level 1: Complete first-level subcommand
  if (completed.length === 1) {
    const subs = subcommands[rootCmd];
    if (subs) {
      return filterPrefix(subs, current);
    }
    // Plugin without subcommands - return flags
    if (pluginCommands.some((p) => p.name === rootCmd)) {
      return getFlags(completed, current);
    }
    return [];
  }

  const subCmd = completed[1];

  // Level 2: Complete second-level subcommand
  if (completed.length === 2) {
    const nested = NESTED_SUBCOMMANDS[rootCmd]?.[subCmd];
    if (nested) {
      return filterPrefix(nested, current);
    }
    // No more subcommands, suggest flags
    return getFlags(completed, current);
  }

  const subSubCmd = completed[2];

  // Level 3: Complete third-level subcommand
  if (completed.length === 3) {
    const third = THIRD_LEVEL_SUBCOMMANDS[rootCmd]?.[subCmd]?.[subSubCmd];
    if (third) {
      return filterPrefix(third, current);
    }
    // No more subcommands, suggest flags
    return getFlags(completed, current);
  }

  // Beyond level 3, only suggest flags
  return getFlags(completed, current);
}

/**
 * Get flag completions for the given command path.
 */
function getFlags(commandPath: string[], prefix: string): string[] {
  // Build command key for lookup
  const keys = [
    commandPath.join(" "),
    commandPath.slice(0, 3).join(" "),
    commandPath.slice(0, 2).join(" "),
    commandPath.slice(0, 1).join(" "),
  ];

  // Collect flags from most specific to least specific
  const flags = new Set<string>(GLOBAL_FLAGS);
  for (const key of keys) {
    const cmdFlags = COMMAND_FLAGS[key];
    if (cmdFlags) {
      cmdFlags.forEach((f) => flags.add(f));
    }
  }

  return filterPrefix([...flags].sort(), prefix);
}

// Zsh completion script
export const ZSH_COMPLETION_SCRIPT = `#compdef atlcli

# atlcli zsh completion
# Install: atlcli completion zsh >> ~/.zshrc && source ~/.zshrc

_atlcli() {
  local -a completions
  local IFS=$'\\n'

  # Get completions from atlcli
  completions=(\${(f)"$(atlcli completion __complete "\${words[@]:1}" 2>/dev/null)"})

  if [[ \${#completions[@]} -gt 0 ]]; then
    _describe 'atlcli' completions
  fi
}

compdef _atlcli atlcli
`;

// Bash completion script
export const BASH_COMPLETION_SCRIPT = `# atlcli bash completion
# Install: atlcli completion bash >> ~/.bashrc && source ~/.bashrc

_atlcli() {
  local cur prev words cword
  _init_completion -n = || return

  # Get completions from atlcli
  local completions
  completions=$(atlcli completion __complete "\${words[@]:1}" 2>/dev/null)

  COMPREPLY=($(compgen -W "$completions" -- "$cur"))
}

complete -F _atlcli atlcli
`;

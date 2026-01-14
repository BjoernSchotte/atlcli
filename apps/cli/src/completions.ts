/**
 * Shell completion logic for atlcli.
 *
 * This module provides dynamic completions by analyzing the command context
 * and returning matching commands, subcommands, and flags.
 */

/**
 * Plugin command info for dynamic completion.
 */
export interface PluginCommandInfo {
  name: string;
  subcommands?: string[];
}

// Root commands (built-in)
const BUILTIN_ROOT_COMMANDS = [
  "auth",
  "completion",
  "doctor",
  "jira",
  "log",
  "plugin",
  "update",
  "version",
  "wiki",
];

// Subcommands for each root command
const SUBCOMMANDS: Record<string, string[]> = {
  auth: ["delete", "init", "list", "login", "logout", "rename", "status", "switch"],
  completion: ["bash", "zsh"],
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
  wiki: ["docs", "page", "search", "space", "template"],
};

// Nested subcommands (command -> subcommand -> sub-subcommands)
const NESTED_SUBCOMMANDS: Record<string, Record<string, string[]>> = {
  wiki: {
    docs: ["add", "check", "diff", "init", "pull", "push", "resolve", "status", "sync", "watch"],
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
    analyze: ["burndown", "predictability", "velocity"],
    board: ["backlog", "get", "issues", "list"],
    bulk: ["delete", "edit", "label", "transition"],
    component: ["create", "delete", "get", "list", "update"],
    epic: ["add", "create", "get", "issues", "list", "progress", "remove"],
    field: ["get", "list", "options", "search"],
    filter: ["create", "delete", "get", "list", "share", "update"],
    issue: [
      "assign",
      "attach",
      "comment",
      "create",
      "delete",
      "get",
      "link",
      "transition",
      "transitions",
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
      "start",
    ],
    subtask: ["create", "list"],
    template: ["apply", "delete", "export", "get", "import", "list", "save"],
    version: ["create", "delete", "get", "list", "release", "update"],
    webhook: ["delete", "list", "refresh", "register", "serve"],
    worklog: ["add", "delete", "list", "report", "timer", "update"],
  },
};

// Third-level subcommands
const THIRD_LEVEL_SUBCOMMANDS: Record<string, Record<string, Record<string, string[]>>> = {
  jira: {
    worklog: {
      timer: ["cancel", "start", "status", "stop"],
    },
  },
};

// Global flags available on all commands
const GLOBAL_FLAGS = ["--help", "--json", "--no-log", "--profile"];

// Command-specific flags
const COMMAND_FLAGS: Record<string, string[]> = {
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
  "wiki page diff": ["--id", "--version1", "--version2"],
  "wiki page restore": ["--id", "--version"],
  "wiki page comments": ["--id"],

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

  // wiki search flags
  "wiki search": ["--cql", "--label", "--limit", "--space", "--type"],

  // jira search flags
  "jira search": [
    "--assignee",
    "--component",
    "--created",
    "--epic",
    "--fields",
    "--jql",
    "--label",
    "--limit",
    "--order",
    "--priority",
    "--project",
    "--reporter",
    "--sprint",
    "--status",
    "--text",
    "--type",
    "--updated",
  ],

  // jira project flags
  "jira project list": ["--limit"],
  "jira project get": ["--key"],
  "jira project create": ["--description", "--key", "--lead", "--name", "--type"],

  // jira issue flags
  "jira issue get": ["--fields", "--key"],
  "jira issue create": [
    "--assignee",
    "--body",
    "--component",
    "--description",
    "--epic",
    "--label",
    "--parent",
    "--priority",
    "--project",
    "--summary",
    "--template",
    "--type",
  ],
  "jira issue update": [
    "--assignee",
    "--component",
    "--description",
    "--key",
    "--label",
    "--priority",
    "--summary",
  ],
  "jira issue delete": ["--key"],
  "jira issue transition": ["--comment", "--key", "--to"],
  "jira issue transitions": ["--key"],
  "jira issue assign": ["--key", "--to"],
  "jira issue comment": ["--body", "--key"],
  "jira issue link": ["--from", "--to", "--type"],
  "jira issue attach": ["--file", "--key"],

  // jira board flags
  "jira board list": ["--limit", "--project", "--type"],
  "jira board get": ["--id"],
  "jira board backlog": ["--id", "--limit"],
  "jira board issues": ["--id", "--jql", "--limit"],

  // jira sprint flags
  "jira sprint list": ["--board", "--limit", "--state"],
  "jira sprint get": ["--id"],
  "jira sprint create": ["--board", "--end", "--goal", "--name", "--start"],
  "jira sprint start": ["--id"],
  "jira sprint close": ["--id", "--move-to"],
  "jira sprint delete": ["--id"],
  "jira sprint issues": ["--id", "--jql", "--limit"],
  "jira sprint add": ["--id", "--issues"],
  "jira sprint remove": ["--id", "--issues"],
  "jira sprint report": ["--id"],

  // jira worklog flags
  "jira worklog add": ["--comment", "--round", "--started", "--time"],
  "jira worklog list": ["--key", "--limit"],
  "jira worklog update": ["--comment", "--id", "--key", "--time"],
  "jira worklog delete": ["--id", "--key"],
  "jira worklog timer start": ["--round"],
  "jira worklog timer stop": ["--comment", "--round"],
  "jira worklog report": ["--from", "--group-by", "--project", "--to", "--user"],

  // jira epic flags
  "jira epic list": ["--limit", "--project"],
  "jira epic get": ["--key"],
  "jira epic create": ["--description", "--project", "--summary"],
  "jira epic issues": ["--key", "--limit"],
  "jira epic add": ["--issues", "--key"],
  "jira epic remove": ["--issues", "--key"],
  "jira epic progress": ["--key"],

  // jira analyze flags
  "jira analyze velocity": ["--board", "--sprints"],
  "jira analyze burndown": ["--sprint"],
  "jira analyze predictability": ["--board", "--sprints"],

  // jira bulk flags
  "jira bulk edit": ["--assignee", "--dry-run", "--jql", "--label", "--priority"],
  "jira bulk transition": ["--dry-run", "--jql", "--to"],
  "jira bulk label": ["--add", "--dry-run", "--jql", "--remove"],
  "jira bulk delete": ["--dry-run", "--jql"],

  // jira filter flags
  "jira filter list": ["--favorite", "--limit"],
  "jira filter get": ["--id"],
  "jira filter create": ["--description", "--favorite", "--jql", "--name"],
  "jira filter update": ["--description", "--id", "--jql", "--name"],
  "jira filter delete": ["--id"],
  "jira filter share": ["--group", "--id", "--project", "--role"],

  // jira export/import flags
  "jira export": ["--attachments", "--comments", "--format", "--jql", "--output"],
  "jira import": ["--dry-run", "--file", "--project"],

  // jira webhook flags
  "jira webhook serve": ["--filter", "--port"],
  "jira webhook list": ["--limit"],
  "jira webhook register": ["--events", "--filter", "--name", "--url"],
  "jira webhook delete": ["--id"],
  "jira webhook refresh": ["--id"],

  // jira subtask flags
  "jira subtask create": ["--assignee", "--parent", "--summary"],
  "jira subtask list": ["--parent"],

  // jira component flags
  "jira component list": ["--project"],
  "jira component get": ["--id"],
  "jira component create": ["--description", "--lead", "--name", "--project"],
  "jira component update": ["--description", "--id", "--lead", "--name"],
  "jira component delete": ["--id", "--move-to"],

  // jira version flags
  "jira version list": ["--project"],
  "jira version get": ["--id"],
  "jira version create": ["--description", "--name", "--project", "--release-date", "--start-date"],
  "jira version update": ["--description", "--id", "--name", "--release-date", "--released"],
  "jira version release": ["--id", "--move-to"],
  "jira version delete": ["--id", "--move-to"],

  // jira field flags
  "jira field list": ["--custom", "--limit", "--search"],
  "jira field get": ["--id"],
  "jira field options": ["--id", "--limit"],
  "jira field search": ["--query"],

  // jira template flags
  "jira template list": [],
  "jira template save": ["--fields", "--from"],
  "jira template get": [],
  "jira template apply": ["--template"],
  "jira template delete": [],
  "jira template export": ["--output"],
  "jira template import": ["--file"],

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

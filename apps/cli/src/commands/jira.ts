import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
} from "@atlcli/core";
import {
  JiraClient,
  JiraIssue,
  JiraTransition,
  JiraSprint,
  JiraWorklog,
  JiraEpic,
  JiraFilter,
  TimerState,
  SprintMetrics,
  BulkOperationSummary,
  ExportData,
  ImportResult,
  JiraWebhookServer,
  JiraWebhookPayload,
  formatWebhookEvent,
  parseTimeToSeconds,
  secondsToJiraFormat,
  secondsToHuman,
  roundTime,
  parseRoundingInterval,
  parseStartedDate,
  formatWorklogDate,
  formatElapsed,
  startTimer,
  stopTimer,
  cancelTimer,
  loadTimer,
  getElapsedSeconds,
  parseDateInput,
  aggregateWorklogs,
  toWorklogWithIssue,
  WorklogWithIssue,
  calculateSprintMetrics,
  calculateVelocityTrend,
  calculateBurndown,
  getStoryPoints,
  generateProgressBar as generateAnalyticsProgressBar,
  collectExportData,
  writeExportFile,
  parseImportFile,
  importIssues,
  listTemplates,
  loadTemplate,
  saveTemplate,
  deleteTemplate,
  templateExists,
  issueToTemplate,
  templateToCreateInput,
  getTemplateFieldNames,
  JiraTemplate,
} from "@atlcli/jira";

export async function handleJira(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "project":
      await handleProject(rest, flags, opts);
      return;
    case "issue":
      await handleIssue(rest, flags, opts);
      return;
    case "board":
      await handleBoard(rest, flags, opts);
      return;
    case "sprint":
      await handleSprint(rest, flags, opts);
      return;
    case "worklog":
      await handleWorklog(rest, flags, opts);
      return;
    case "epic":
      await handleEpic(rest, flags, opts);
      return;
    case "analyze":
      await handleAnalyze(rest, flags, opts);
      return;
    case "bulk":
      await handleBulk(rest, flags, opts);
      return;
    case "filter":
      await handleFilter(rest, flags, opts);
      return;
    case "export":
      await handleExport(flags, opts);
      return;
    case "import":
      await handleImport(flags, opts);
      return;
    case "search":
      await handleSearch(rest, flags, opts);
      return;
    case "me":
      await handleMe(flags, opts);
      return;
    case "my":
      await handleMy(rest, flags, opts);
      return;
    case "watch":
      await handleWatch(rest, flags, opts);
      return;
    case "unwatch":
      await handleUnwatch(rest, flags, opts);
      return;
    case "watchers":
      await handleWatchers(rest, flags, opts);
      return;
    case "webhook":
      await handleWebhook(rest, flags, opts);
      return;
    case "subtask":
      await handleSubtask(rest, flags, opts);
      return;
    case "component":
      await handleComponent(rest, flags, opts);
      return;
    case "version":
      await handleVersion(rest, flags, opts);
      return;
    case "field":
      await handleField(rest, flags, opts);
      return;
    case "template":
      await handleTemplate(rest, flags, opts);
      return;
    default:
      output(jiraHelp(), opts);
      return;
  }
}

type ClientWithDefaults = {
  client: JiraClient;
  defaults: { project?: string; space?: string; board?: number };
};

async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<JiraClient>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults: true
): Promise<ClientWithDefaults>;
async function getClient(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  withDefaults?: boolean
): Promise<JiraClient | ClientWithDefaults> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      "No active profile found. Run `atlcli auth login`.",
      { profile: profileName }
    );
  }
  const client = new JiraClient(profile);
  if (withDefaults) {
    return { client, defaults: config.defaults ?? {} };
  }
  return client;
}

// ============ Me ============

async function handleMe(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const user = await client.getCurrentUser();
  output({ schemaVersion: "1", user }, opts);
}

// ============ Project Operations ============

async function handleProject(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "list":
      await handleProjectList(flags, opts);
      return;
    case "get":
      await handleProjectGet(flags, opts);
      return;
    case "create":
      await handleProjectCreate(flags, opts);
      return;
    case "types":
      await handleProjectTypes(flags, opts);
      return;
    default:
      output(projectHelp(), opts);
      return;
  }
}

async function handleProjectList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const query = getFlag(flags, "query");

  const result = await client.listProjects({
    maxResults: Number.isNaN(limit) ? 50 : limit,
    query,
  });

  output({ schemaVersion: "1", projects: result.values, total: result.total }, opts);
}

async function handleProjectGet(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const client = await getClient(flags, opts);
  const project = await client.getProject(key);
  output({ schemaVersion: "1", project }, opts);
}

async function handleProjectCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const name = getFlag(flags, "name");
  const type = getFlag(flags, "type") as "software" | "service_desk" | "business" | undefined;
  const template = getFlag(flags, "template");
  const description = getFlag(flags, "description");
  const lead = getFlag(flags, "lead");

  if (!key || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key and --name are required.");
  }

  const client = await getClient(flags, opts);
  const project = await client.createProject({
    key,
    name,
    projectTypeKey: type ?? "software",
    projectTemplateKey: template,
    description,
    leadAccountId: lead,
  });

  output({ schemaVersion: "1", project }, opts);
}

async function handleProjectTypes(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const client = await getClient(flags, opts);
  const types = await client.getProjectIssueTypes(key);
  output({ schemaVersion: "1", issueTypes: types }, opts);
}

function projectHelp(): string {
  return `atlcli jira project <command>

Commands:
  list [--limit <n>] [--query <text>]
  get --key <key>
  create --key <KEY> --name <name> [--type software|service_desk|business] [--template <key>] [--description <text>] [--lead <accountId>]
  types --key <key>                   List issue types for a project

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

// ============ Issue Operations ============

async function handleIssue(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "get":
      await handleIssueGet(flags, opts);
      return;
    case "create":
      await handleIssueCreate(flags, opts);
      return;
    case "update":
      await handleIssueUpdate(flags, opts);
      return;
    case "delete":
      await handleIssueDelete(flags, opts);
      return;
    case "transition":
      await handleIssueTransition(flags, opts);
      return;
    case "transitions":
      await handleIssueTransitions(flags, opts);
      return;
    case "assign":
      await handleIssueAssign(flags, opts);
      return;
    case "comment":
      await handleIssueComment(args.slice(1), flags, opts);
      return;
    case "link":
      await handleIssueLink(flags, opts);
      return;
    case "attach":
      await handleIssueAttach(args.slice(1), flags, opts);
      return;
    case "open":
      await handleIssueOpen(args.slice(1), flags, opts);
      return;
    default:
      output(issueHelp(), opts);
      return;
  }
}

async function handleIssueGet(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key") ?? getFlag(flags, "id");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const expand = getFlag(flags, "expand");
  const client = await getClient(flags, opts);
  const issue = await client.getIssue(key, { expand });

  output({ schemaVersion: "1", issue: formatIssue(issue) }, opts);
}

async function handleIssueCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  const type = getFlag(flags, "type");
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");
  const priority = getFlag(flags, "priority");
  const assignee = getFlag(flags, "assignee");
  const labels = getFlag(flags, "labels");
  const parent = getFlag(flags, "parent"); // For subtasks or epic children

  if (!project || !type || !summary) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project, --type, and --summary are required (or set defaults.project in config).");
  }
  const issue = await client.createIssue({
    fields: {
      project: { key: project },
      issuetype: { name: type },
      summary,
      description: description ? client.textToAdf(description) : undefined,
      priority: priority ? { name: priority } : undefined,
      assignee: assignee ? { accountId: assignee } : undefined,
      labels: labels ? labels.split(",").map((l) => l.trim()) : undefined,
      parent: parent ? { key: parent } : undefined,
    },
  });

  output({ schemaVersion: "1", issue: formatIssue(issue) }, opts);
}

async function handleIssueUpdate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");
  const priority = getFlag(flags, "priority");
  const assignee = getFlag(flags, "assignee");
  const addLabels = getFlag(flags, "add-labels");
  const removeLabels = getFlag(flags, "remove-labels");

  const client = await getClient(flags, opts);

  const fields: Record<string, unknown> = {};
  if (summary) fields.summary = summary;
  if (description) fields.description = client.textToAdf(description);
  if (priority) fields.priority = { name: priority };
  if (assignee) fields.assignee = assignee === "none" ? null : { accountId: assignee };

  const update: Record<string, Array<{ add?: string; remove?: string }>> = {};
  if (addLabels) {
    update.labels = addLabels.split(",").map((l) => ({ add: l.trim() }));
  }
  if (removeLabels) {
    update.labels = [
      ...(update.labels ?? []),
      ...removeLabels.split(",").map((l) => ({ remove: l.trim() })),
    ];
  }

  await client.updateIssue(key, {
    fields: Object.keys(fields).length > 0 ? fields : undefined,
    update: Object.keys(update).length > 0 ? update : undefined,
  });

  // Fetch updated issue
  const issue = await client.getIssue(key);
  output({ schemaVersion: "1", issue: formatIssue(issue) }, opts);
}

async function handleIssueDelete(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const confirm = hasFlag(flags, "confirm");

  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete an issue.");
  }

  const deleteSubtasks = hasFlag(flags, "delete-subtasks");
  const client = await getClient(flags, opts);
  await client.deleteIssue(key, { deleteSubtasks });

  output({ schemaVersion: "1", deleted: key }, opts);
}

async function handleIssueTransitions(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const client = await getClient(flags, opts);
  const transitions = await client.getTransitions(key);
  output({ schemaVersion: "1", transitions }, opts);
}

async function handleIssueTransition(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const to = getFlag(flags, "to");

  if (!key || !to) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key and --to are required.");
  }

  const client = await getClient(flags, opts);

  // Find transition by name
  const transitions = await client.getTransitions(key);
  const transition = transitions.find(
    (t: JiraTransition) => t.name.toLowerCase() === to.toLowerCase() || t.id === to
  );

  if (!transition) {
    const available = transitions.map((t: JiraTransition) => t.name).join(", ");
    fail(opts, 1, ERROR_CODES.USAGE, `Transition "${to}" not found. Available: ${available}`);
  }

  await client.transitionIssue(key, { transition: { id: transition.id } });

  // Fetch updated issue
  const issue = await client.getIssue(key);
  output({ schemaVersion: "1", issue: formatIssue(issue) }, opts);
}

async function handleIssueAssign(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const assignee = getFlag(flags, "assignee");

  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }

  const client = await getClient(flags, opts);

  if (!assignee || assignee === "none") {
    await client.assignIssue(key, null);
  } else {
    await client.assignIssue(key, { accountId: assignee });
  }

  const issue = await client.getIssue(key);
  output({ schemaVersion: "1", issue: formatIssue(issue) }, opts);
}

async function handleIssueComment(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const body = args.join(" ") || getFlag(flags, "body");

  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }
  if (!body) {
    fail(opts, 1, ERROR_CODES.USAGE, "Comment body is required.");
  }

  const client = await getClient(flags, opts);
  const comment = await client.addComment(key, body);
  output({ schemaVersion: "1", comment }, opts);
}

async function handleIssueLink(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const from = getFlag(flags, "from");
  const to = getFlag(flags, "to");
  const type = getFlag(flags, "type");

  if (!from || !to || !type) {
    fail(opts, 1, ERROR_CODES.USAGE, "--from, --to, and --type are required.");
  }

  const client = await getClient(flags, opts);
  await client.createIssueLink({
    type: { name: type },
    inwardIssue: { key: from },
    outwardIssue: { key: to },
  });

  output({ schemaVersion: "1", linked: { from, to, type } }, opts);
}

async function handleIssueAttach(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = getFlag(flags, "key");
  const [filePath] = args;

  if (!key || !filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key <issue> and <file> are required.");
    return;
  }

  // Check if file exists
  try {
    await stat(filePath);
  } catch {
    fail(opts, 1, ERROR_CODES.USAGE, `File not found: ${filePath}`);
    return;
  }

  const client = await getClient(flags, opts);
  const data = await readFile(filePath);
  const filename = basename(filePath);

  const attachments = await client.uploadAttachment(key, filename, data);

  if (opts.json) {
    output({
      schemaVersion: "1",
      attached: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mimeType: a.mimeType,
      })),
    }, opts);
  } else {
    output(`Attached ${filename} (${data.length} bytes) to ${key}`, opts);
  }
}

async function handleIssueOpen(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const key = args[0] ?? getFlag(flags, "key");

  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "Issue key is required: jira issue open <key>");
    return;
  }

  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));

  if (!profile) {
    fail(opts, 1, ERROR_CODES.CONFIG, "No active profile. Run: atlcli auth login");
    return;
  }

  // Construct URL - Jira Cloud browse URL
  const url = `${profile.baseUrl}/browse/${key}`;

  // Always display the URL first (for headless environments)
  output(url, opts);

  // Attempt to open in browser
  try {
    await openUrl(url);
  } catch {
    // Silently fail - URL was already printed
  }
}

async function openUrl(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux and others
    command = "xdg-open";
    args = [url];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });

    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function issueHelp(): string {
  return `atlcli jira issue <command>

Commands:
  get --key <key> [--expand <fields>]
  create --project <key> --type <name> --summary <text> [--description <text>] [--priority <name>] [--assignee <accountId>] [--labels <a,b,c>] [--parent <key>]
  update --key <key> [--summary <text>] [--description <text>] [--priority <name>] [--assignee <accountId>|none] [--add-labels <a,b>] [--remove-labels <c,d>]
  delete --key <key> --confirm [--delete-subtasks]
  transition --key <key> --to <status>
  transitions --key <key>              List available transitions
  assign --key <key> --assignee <accountId>|none
  comment --key <key> <text>
  link --from <key> --to <key> --type <name>
  attach --key <key> <file>            Attach a file to an issue
  open <key>                           Open issue in browser

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

// ============ Board Operations ============

async function handleBoard(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "list":
      await handleBoardList(flags, opts);
      return;
    case "get":
      await handleBoardGet(flags, opts);
      return;
    case "backlog":
      await handleBoardBacklog(flags, opts);
      return;
    case "issues":
      await handleBoardIssues(flags, opts);
      return;
    default:
      output(boardHelp(), opts);
      return;
  }
}

async function handleBoardList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const type = getFlag(flags, "type") as "scrum" | "kanban" | "simple" | undefined;
  const name = getFlag(flags, "name");
  const project = getFlag(flags, "project") ?? defaults.project;

  const result = await client.listBoards({
    maxResults: Number.isNaN(limit) ? 50 : limit,
    type,
    name,
    projectKeyOrId: project,
  });

  output({ schemaVersion: "1", boards: result.values, total: result.total }, opts);
}

async function handleBoardGet(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const board = await client.getBoard(Number(id));
  output({ schemaVersion: "1", board }, opts);
}

async function handleBoardBacklog(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const jql = getFlag(flags, "jql");

  const result = await client.getBoardBacklog(Number(id), {
    maxResults: Number.isNaN(limit) ? 50 : limit,
    jql,
  });

  output(
    {
      schemaVersion: "1",
      issues: result.issues.map(formatIssue),
      total: result.total,
    },
    opts
  );
}

async function handleBoardIssues(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const jql = getFlag(flags, "jql");

  const result = await client.getBoardIssues(Number(id), {
    maxResults: Number.isNaN(limit) ? 50 : limit,
    jql,
  });

  output(
    {
      schemaVersion: "1",
      issues: result.issues.map(formatIssue),
      total: result.total,
    },
    opts
  );
}

function boardHelp(): string {
  return `atlcli jira board <command>

Commands:
  list [--limit <n>] [--type scrum|kanban|simple] [--name <text>] [--project <key>]
  get --id <boardId>
  backlog --id <boardId> [--limit <n>] [--jql <query>]
  issues --id <boardId> [--limit <n>] [--jql <query>]

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

// ============ Sprint Operations ============

async function handleSprint(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "list":
      await handleSprintList(flags, opts);
      return;
    case "get":
      await handleSprintGet(flags, opts);
      return;
    case "create":
      await handleSprintCreate(flags, opts);
      return;
    case "start":
      await handleSprintStart(flags, opts);
      return;
    case "close":
      await handleSprintClose(flags, opts);
      return;
    case "delete":
      await handleSprintDelete(flags, opts);
      return;
    case "issues":
      await handleSprintIssues(flags, opts);
      return;
    case "add":
      await handleSprintAdd(args.slice(1), flags, opts);
      return;
    case "remove":
      await handleSprintRemove(args.slice(1), flags, opts);
      return;
    case "report":
      await handleSprintReport(args.slice(1), flags, opts);
      return;
    default:
      output(sprintHelp(), opts);
      return;
  }
}

async function handleSprintList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const boardId = getFlag(flags, "board") ?? (defaults.board ? String(defaults.board) : undefined);
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required (or set defaults.board in config).");
  }
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const state = getFlag(flags, "state") as "future" | "active" | "closed" | undefined;

  const result = await client.listSprints(Number(boardId), {
    maxResults: Number.isNaN(limit) ? 50 : limit,
    state,
  });

  output({ schemaVersion: "1", sprints: result.values, total: result.total }, opts);
}

async function handleSprintGet(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const sprint = await client.getSprint(Number(id));
  output({ schemaVersion: "1", sprint }, opts);
}

async function handleSprintCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const boardId = getFlag(flags, "board") ?? (defaults.board ? String(defaults.board) : undefined);
  const name = getFlag(flags, "name");

  if (!boardId || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board and --name are required (or set defaults.board in config).");
  }
  const startDate = getFlag(flags, "start");
  const endDate = getFlag(flags, "end");
  const goal = getFlag(flags, "goal");

  const sprint = await client.createSprint({
    name,
    originBoardId: Number(boardId),
    startDate,
    endDate,
    goal,
  });

  output({ schemaVersion: "1", sprint }, opts);
}

async function handleSprintStart(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const startDate = getFlag(flags, "start");
  const endDate = getFlag(flags, "end");
  const goal = getFlag(flags, "goal");

  const sprint = await client.startSprint(Number(id), {
    startDate,
    endDate,
    goal,
  });

  output({ schemaVersion: "1", sprint }, opts);
}

async function handleSprintClose(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const sprint = await client.closeSprint(Number(id));
  output({ schemaVersion: "1", sprint }, opts);
}

async function handleSprintDelete(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  const confirm = hasFlag(flags, "confirm");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a sprint.");
  }

  const client = await getClient(flags, opts);
  await client.deleteSprint(Number(id));
  output({ schemaVersion: "1", deleted: Number(id) }, opts);
}

async function handleSprintIssues(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const jql = getFlag(flags, "jql");

  const result = await client.getSprintIssues(Number(id), {
    maxResults: Number.isNaN(limit) ? 50 : limit,
    jql,
  });

  output(
    {
      schemaVersion: "1",
      issues: result.issues.map(formatIssue),
      total: result.total,
    },
    opts
  );
}

async function handleSprintAdd(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sprintId = getFlag(flags, "sprint");
  const issues = args.length > 0 ? args : getFlag(flags, "issues")?.split(",");

  if (!sprintId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--sprint is required.");
  }
  if (!issues || issues.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "Issue keys are required (as args or --issues).");
  }

  const client = await getClient(flags, opts);
  await client.moveIssuesToSprint(Number(sprintId), issues);
  output({ schemaVersion: "1", added: { sprint: Number(sprintId), issues } }, opts);
}

async function handleSprintRemove(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const issues = args.length > 0 ? args : getFlag(flags, "issues")?.split(",");

  if (!issues || issues.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "Issue keys are required (as args or --issues).");
  }

  const client = await getClient(flags, opts);
  await client.moveIssuesToBacklog(issues);
  output({ schemaVersion: "1", removed: { issues } }, opts);
}

async function handleSprintReport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sprintId = args[0] || getFlag(flags, "id");
  if (!sprintId) {
    fail(opts, 1, ERROR_CODES.USAGE, "Sprint ID is required.");
  }

  const pointsFieldOverride = getFlag(flags, "points-field");
  const client = await getClient(flags, opts);

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = (await client.detectStoryPointsField()) ?? undefined;
    if (!pointsField) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        "Could not detect story points field. Use --points-field <field_id> to specify it."
      );
    }
  }

  // Get sprint info
  const sprint = await client.getSprint(Number(sprintId));

  // Get sprint issues
  const issuesResult = await client.getSprintIssues(Number(sprintId), {
    maxResults: 200,
    fields: ["status", "summary", pointsField],
  });

  // Fetch changelog for scope change analysis
  const issuesWithChangelog = await Promise.all(
    issuesResult.issues.map((issue) =>
      client.getIssue(issue.key, { expand: "changelog" })
    )
  );

  // Calculate full metrics
  const metrics = calculateSprintMetrics(
    sprint,
    issuesResult.issues,
    pointsField,
    issuesWithChangelog
  );

  // Format dates
  const dateRange =
    metrics.startDate && metrics.endDate
      ? `${new Date(metrics.startDate).toLocaleDateString()} - ${new Date(metrics.endDate).toLocaleDateString()}`
      : "N/A";

  output(
    {
      schemaVersion: "1",
      sprint: {
        id: metrics.sprintId,
        name: metrics.sprintName,
        state: metrics.state,
        dates: dateRange,
      },
      pointsField,
      velocity: metrics.completedPoints,
      sayDoRatio: metrics.sayDoRatio,
      scopeChange: metrics.scopeChangePercent,
      issues: {
        total: metrics.totalIssues,
        completed: metrics.completedIssues,
        incomplete: metrics.incompleteIssues,
        added: metrics.addedDuringSprint,
        removed: metrics.removedDuringSprint,
      },
      progress: {
        committed: metrics.committedPoints,
        completed: metrics.completedPoints,
        percent: metrics.committedPoints > 0
          ? Math.round((metrics.completedPoints / metrics.committedPoints) * 100)
          : 0,
        bar: generateAnalyticsProgressBar(metrics.completedPoints, metrics.committedPoints),
      },
    },
    opts
  );
}

function sprintHelp(): string {
  return `atlcli jira sprint <command>

Commands:
  list --board <id> [--limit <n>] [--state future|active|closed]
  get --id <sprintId>
  create --board <id> --name <name> [--start <date>] [--end <date>] [--goal <text>]
  start --id <sprintId> [--start <date>] [--end <date>] [--goal <text>]
  close --id <sprintId>
  delete --id <sprintId> --confirm
  issues --id <sprintId> [--limit <n>] [--jql <query>]
  add <issue>... --sprint <id>           Add issues to sprint
  remove <issue>...                      Move issues to backlog
  report <sprintId> [--points-field <id>]   Sprint metrics report

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira sprint list --board 123
  jira sprint report 456 --json
`;
}

// ============ Worklog Operations ============

async function handleWorklog(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      await handleWorklogAdd(rest, flags, opts);
      return;
    case "list":
      await handleWorklogList(flags, opts);
      return;
    case "update":
      await handleWorklogUpdate(flags, opts);
      return;
    case "delete":
      await handleWorklogDelete(flags, opts);
      return;
    case "timer":
      await handleWorklogTimer(rest, flags, opts);
      return;
    case "report":
      await handleWorklogReport(flags, opts);
      return;
    default:
      output(worklogHelp(), opts);
      return;
  }
}

async function handleWorklogAdd(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // Parse: jira worklog add PROJ-123 1h30m [--comment "..."] [--started "..."]
  const issueKey = getFlag(flags, "issue") ?? args[0];
  const timeArg = args.length > 1 ? args.slice(1).join(" ") : getFlag(flags, "time");

  if (!issueKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Issue key is required.");
  }
  if (!timeArg) {
    fail(opts, 1, ERROR_CODES.USAGE, "Time is required (e.g., 1h30m, 1.5h, 90m).");
  }

  // Parse time
  let timeSeconds: number;
  try {
    timeSeconds = parseTimeToSeconds(timeArg);
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }

  // Apply rounding if specified
  const roundFlag = getFlag(flags, "round");
  if (roundFlag) {
    try {
      const interval = parseRoundingInterval(roundFlag);
      timeSeconds = roundTime(timeSeconds, interval);
    } catch (e) {
      fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
    }
  }

  // Parse started date if provided
  let started: string | undefined;
  const startedFlag = getFlag(flags, "started");
  if (startedFlag) {
    try {
      const date = parseStartedDate(startedFlag);
      started = formatWorklogDate(date);
    } catch (e) {
      fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
    }
  }

  const comment = getFlag(flags, "comment");
  const client = await getClient(flags, opts);

  const worklog = await client.addWorklog(issueKey, timeSeconds, {
    started,
    comment,
  });

  output(
    {
      schemaVersion: "1",
      worklog: formatWorklog(worklog),
      logged: secondsToHuman(timeSeconds),
    },
    opts
  );
}

async function handleWorklogList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const issueKey = getFlag(flags, "issue");
  if (!issueKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "--issue is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);

  const result = await client.getWorklogs(issueKey, {
    maxResults: Number.isNaN(limit) ? 50 : limit,
  });

  output(
    {
      schemaVersion: "1",
      worklogs: result.worklogs.map(formatWorklog),
      total: result.total,
    },
    opts
  );
}

async function handleWorklogUpdate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const issueKey = getFlag(flags, "issue");
  const worklogId = getFlag(flags, "id");

  if (!issueKey || !worklogId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--issue and --id are required.");
  }

  const timeArg = getFlag(flags, "time");
  const comment = getFlag(flags, "comment");
  const startedFlag = getFlag(flags, "started");

  if (!timeArg && !comment && !startedFlag) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one of --time, --comment, or --started is required.");
  }

  const updates: {
    timeSpentSeconds?: number;
    started?: string;
    comment?: string;
  } = {};

  if (timeArg) {
    try {
      updates.timeSpentSeconds = parseTimeToSeconds(timeArg);
    } catch (e) {
      fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
    }
  }

  if (startedFlag) {
    try {
      updates.started = formatWorklogDate(parseStartedDate(startedFlag));
    } catch (e) {
      fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
    }
  }

  if (comment) {
    updates.comment = comment;
  }

  const client = await getClient(flags, opts);
  const worklog = await client.updateWorklog(issueKey, worklogId, updates);

  output({ schemaVersion: "1", worklog: formatWorklog(worklog) }, opts);
}

async function handleWorklogDelete(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const issueKey = getFlag(flags, "issue");
  const worklogId = getFlag(flags, "id");
  const confirm = hasFlag(flags, "confirm");

  if (!issueKey || !worklogId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--issue and --id are required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a worklog.");
  }

  const client = await getClient(flags, opts);
  await client.deleteWorklog(issueKey, worklogId);

  output({ schemaVersion: "1", deleted: { issue: issueKey, worklogId } }, opts);
}

function formatWorklog(worklog: JiraWorklog): Record<string, unknown> {
  return {
    id: worklog.id,
    issueId: worklog.issueId,
    author: worklog.author?.displayName,
    authorId: worklog.author?.accountId,
    timeSpent: worklog.timeSpent,
    timeSpentSeconds: worklog.timeSpentSeconds,
    timeSpentHuman: secondsToHuman(worklog.timeSpentSeconds),
    started: worklog.started,
    created: worklog.created,
    updated: worklog.updated,
    comment: worklog.comment,
  };
}

// ============ Worklog Report ============

async function handleWorklogReport(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);

  // Parse date range
  const sinceStr = getFlag(flags, "since") ?? "30d";
  const untilStr = getFlag(flags, "until") ?? "today";
  const groupBy = getFlag(flags, "group-by") as "issue" | "date" | undefined;

  let sinceDate: Date;
  let untilDate: Date;
  try {
    sinceDate = parseDateInput(sinceStr);
    untilDate = parseDateInput(untilStr);
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }

  // Set to start/end of day for proper date range
  sinceDate.setHours(0, 0, 0, 0);
  untilDate.setHours(23, 59, 59, 999);

  const sinceDateStr = sinceDate.toISOString().split("T")[0];
  const untilDateStr = untilDate.toISOString().split("T")[0];

  // Determine user - default to "me" (currentUser())
  const userInput = getFlag(flags, "user") ?? "me";
  const userJql = userInput === "me" ? "currentUser()" : `"${userInput}"`;

  // Build JQL to find issues with worklogs by this user in date range
  const jql = `worklogAuthor = ${userJql} AND worklogDate >= "${sinceDateStr}" AND worklogDate <= "${untilDateStr}"`;

  // Search for matching issues
  const searchResult = await client.search(jql, {
    maxResults: 1000,
    fields: ["key", "summary"],
  });

  if (searchResult.issues.length === 0) {
    output(
      {
        schemaVersion: "1",
        message: "No worklogs found for the specified criteria.",
        query: { user: userInput, since: sinceDateStr, until: untilDateStr },
        summary: {
          totalTimeSeconds: 0,
          totalTimeHuman: "0 minutes",
          worklogCount: 0,
          issueCount: 0,
          averagePerDay: "0 minutes",
        },
        worklogs: [],
      },
      opts
    );
    return;
  }

  // Fetch worklogs for each issue and filter
  const allWorklogs: WorklogWithIssue[] = [];

  // Get current user's accountId for filtering (if using "me")
  let targetAccountId: string | undefined;
  if (userInput === "me") {
    const currentUser = await client.getCurrentUser();
    targetAccountId = currentUser.accountId;
  }

  for (const issue of searchResult.issues) {
    const worklogsResult = await client.getWorklogs(issue.key, { maxResults: 1000 });

    for (const worklog of worklogsResult.worklogs) {
      const worklogDate = new Date(worklog.started);

      // Filter by date range
      if (worklogDate < sinceDate || worklogDate > untilDate) {
        continue;
      }

      // Filter by user
      if (userInput === "me") {
        if (worklog.author?.accountId !== targetAccountId) {
          continue;
        }
      } else {
        // Match by display name or email
        const authorName = worklog.author?.displayName?.toLowerCase() ?? "";
        const authorEmail = worklog.author?.emailAddress?.toLowerCase() ?? "";
        const searchLower = userInput.toLowerCase();
        if (!authorName.includes(searchLower) && !authorEmail.includes(searchLower)) {
          continue;
        }
      }

      allWorklogs.push(toWorklogWithIssue(worklog, issue.key, issue.fields.summary));
    }
  }

  // Determine user display name for report
  let userName = userInput;
  let userId: string | undefined;
  if (userInput === "me") {
    const currentUser = await client.getCurrentUser();
    userName = currentUser.displayName;
    userId = currentUser.accountId;
  } else if (allWorklogs.length > 0) {
    userName = allWorklogs[0].author;
    userId = allWorklogs[0].authorId;
  }

  // Aggregate and output
  const report = aggregateWorklogs(
    allWorklogs,
    userName,
    userId,
    { from: sinceDateStr, to: untilDateStr },
    groupBy
  );

  output({ schemaVersion: "1", ...report }, opts);
}

// ============ Timer Operations ============

async function handleWorklogTimer(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      await handleTimerStart(rest, flags, opts);
      return;
    case "stop":
      await handleTimerStop(flags, opts);
      return;
    case "status":
      handleTimerStatus(opts);
      return;
    case "cancel":
      handleTimerCancel(opts);
      return;
    default:
      output(timerHelp(), opts);
      return;
  }
}

async function handleTimerStart(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const issueKey = args[0] || getFlag(flags, "issue");
  if (!issueKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Issue key is required. Usage: jira worklog timer start <issue>");
  }

  const profileName = getFlag(flags, "profile") || "default";
  const comment = getFlag(flags, "comment");

  try {
    const timer = startTimer(issueKey, profileName, comment);
    output(
      {
        schemaVersion: "1",
        timer: {
          issueKey: timer.issueKey,
          startedAt: timer.startedAt,
          profile: timer.profile,
          comment: timer.comment,
        },
        message: `Timer started for ${issueKey}`,
      },
      opts
    );
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }
}

async function handleTimerStop(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const roundFlag = getFlag(flags, "round");
  const commentOverride = getFlag(flags, "comment");

  let result: { timer: TimerState; elapsedSeconds: number };
  try {
    result = stopTimer();
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }

  let { timer, elapsedSeconds } = result;

  // Apply rounding if specified
  if (roundFlag) {
    try {
      const interval = parseRoundingInterval(roundFlag);
      elapsedSeconds = roundTime(elapsedSeconds, interval);
    } catch (e) {
      fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
    }
  }

  // Minimum 1 minute
  if (elapsedSeconds < 60) {
    elapsedSeconds = 60;
  }

  // Use comment from stop command or from timer start
  const comment = commentOverride || timer.comment;

  // Get client using the profile from when timer was started
  const config = await loadConfig();
  const profile = getActiveProfile(config, timer.profile);
  if (!profile) {
    fail(
      opts,
      1,
      ERROR_CODES.AUTH,
      `Profile "${timer.profile}" not found. The timer was started with this profile.`
    );
  }
  const client = new JiraClient(profile);

  // Log the worklog
  const worklog = await client.addWorklog(timer.issueKey, elapsedSeconds, {
    started: timer.startedAt.replace("Z", "+0000"),
    comment,
  });

  output(
    {
      schemaVersion: "1",
      worklog: formatWorklog(worklog),
      logged: secondsToHuman(elapsedSeconds),
      elapsed: formatElapsed(elapsedSeconds),
    },
    opts
  );
}

function handleTimerStatus(opts: OutputOptions): void {
  const timer = loadTimer();
  if (!timer) {
    output({ schemaVersion: "1", running: false, message: "No timer is running" }, opts);
    return;
  }

  const elapsed = getElapsedSeconds(timer);
  output(
    {
      schemaVersion: "1",
      running: true,
      timer: {
        issueKey: timer.issueKey,
        startedAt: timer.startedAt,
        profile: timer.profile,
        comment: timer.comment,
        elapsed: formatElapsed(elapsed),
        elapsedSeconds: elapsed,
      },
    },
    opts
  );
}

function handleTimerCancel(opts: OutputOptions): void {
  try {
    const timer = cancelTimer();
    const elapsed = getElapsedSeconds({ ...timer, startedAt: timer.startedAt });
    output(
      {
        schemaVersion: "1",
        cancelled: {
          issueKey: timer.issueKey,
          elapsed: formatElapsed(elapsed),
        },
        message: `Timer cancelled for ${timer.issueKey}`,
      },
      opts
    );
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }
}

function timerHelp(): string {
  return `atlcli jira worklog timer <command>

Commands:
  start <issue> [--comment <text>]   Start tracking time on an issue
  stop [--round <interval>] [--comment <text>]   Stop timer and log worklog
  status                             Show current timer status
  cancel                             Cancel timer without logging

Options:
  --profile <name>   Use a specific auth profile
  --round <interval> Round time when stopping (15m, 30m, 1h)
  --comment <text>   Comment for the worklog

Examples:
  jira worklog timer start PROJ-123 --comment "Working on feature"
  jira worklog timer status
  jira worklog timer stop --round 15m
  jira worklog timer cancel
`;
}

function worklogHelp(): string {
  return `atlcli jira worklog <command>

Commands:
  add <issue> <time> [--comment <text>] [--started <date>] [--round <interval>]
  list --issue <key> [--limit <n>]
  update --issue <key> --id <worklogId> [--time <time>] [--comment <text>] [--started <date>]
  delete --issue <key> --id <worklogId> --confirm
  report [--user <user>] [--since <date>] [--until <date>] [--group-by <issue|date>]

Timer mode (start/stop tracking):
  timer start <issue> [--comment <text>]   Start tracking time
  timer stop [--round <interval>]          Stop and log worklog
  timer status                             Show running timer
  timer cancel                             Cancel without logging

Report options:
  --user <user>           User to report on (default: me)
  --since <date>          Start date (default: 30d)
  --until <date>          End date (default: today)
  --group-by <issue|date> Group worklogs by issue or date

Time formats:
  1h30m, 1h 30m      Hours and minutes
  1.5h, 2.25h        Decimal hours
  90m, 45m           Minutes only
  1:30, 2:45         HH:MM format
  1d, 2d             Days (8h each)
  1w                 Weeks (5d each)

Started date formats:
  today, yesterday   Relative dates
  14:30              Time today
  2026-01-12         Date (current time)
  ISO 8601           Full datetime

Rounding:
  --round 15m        Round to nearest 15 minutes
  --round 30m        Round to nearest 30 minutes
  --round 1h         Round to nearest hour

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira worklog add PROJ-123 1h30m --comment "Feature work"
  jira worklog add PROJ-123 1.5h --started 09:00
  jira worklog add PROJ-123 2h --round 15m
  jira worklog list --issue PROJ-123

  # Timer mode
  jira worklog timer start PROJ-123 --comment "Working on feature"
  jira worklog timer status
  jira worklog timer stop --round 15m
`;
}

// ============ Epic Operations ============

async function handleEpic(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleEpicList(flags, opts);
      return;
    case "get":
      await handleEpicGet(rest, flags, opts);
      return;
    case "create":
      await handleEpicCreate(flags, opts);
      return;
    case "issues":
      await handleEpicIssues(rest, flags, opts);
      return;
    case "add":
      await handleEpicAdd(rest, flags, opts);
      return;
    case "remove":
      await handleEpicRemove(rest, flags, opts);
      return;
    case "progress":
      await handleEpicProgress(rest, flags, opts);
      return;
    default:
      output(epicHelp(), opts);
      return;
  }
}

async function handleEpicList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  const boardId = getFlag(flags, "board") ?? (defaults.board ? String(defaults.board) : undefined);
  const includeDone = hasFlag(flags, "done");
  const limit = Number(getFlag(flags, "limit") ?? 50);

  if (boardId) {
    // Use Agile API for board-based listing
    const result = await client.listBoardEpics(Number(boardId), {
      maxResults: limit,
      done: includeDone ? undefined : false,
    });
    output(
      {
        schemaVersion: "1",
        epics: result.values.map(formatEpic),
        total: result.total,
      },
      opts
    );
  } else {
    // Use JQL search
    let jql = "issuetype = Epic";
    if (project) {
      jql += ` AND project = ${project}`;
    }
    if (!includeDone) {
      jql += " AND resolution IS EMPTY";
    }
    jql += " ORDER BY created DESC";

    const result = await client.search(jql, {
      maxResults: limit,
      fields: ["*navigable"],
    });
    output(
      {
        schemaVersion: "1",
        jql,
        epics: result.issues.map(formatIssueAsEpic),
        total: result.total,
      },
      opts
    );
  }
}

async function handleEpicGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const epicKey = args[0];
  if (!epicKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Epic key is required.");
  }

  const client = await getClient(flags, opts);
  const issue = await client.getIssue(epicKey);

  // Get child issues for progress
  const childResult = await client.getEpicIssues(epicKey, { maxResults: 1000 });
  const children = childResult.issues || [];
  const done = children.filter(
    (i) => i.fields.status?.statusCategory?.key === "done"
  ).length;

  output(
    {
      schemaVersion: "1",
      epic: {
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name,
        statusCategory: issue.fields.status?.statusCategory?.key,
        description: issue.fields.description,
        assignee: issue.fields.assignee?.displayName,
        reporter: issue.fields.reporter?.displayName,
        created: issue.fields.created,
        updated: issue.fields.updated,
        childCount: children.length,
        progress: {
          done,
          total: children.length,
          percent: children.length > 0 ? Math.round((done / children.length) * 100) : 0,
        },
      },
    },
    opts
  );
}

async function handleEpicCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");

  if (!project) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project is required (or set defaults.project in config).");
  }
  if (!summary) {
    fail(opts, 1, ERROR_CODES.USAGE, "--summary is required.");
  }

  const issue = await client.createIssue({
    fields: {
      project: { key: project },
      issuetype: { name: "Epic" },
      summary,
      description: description ? client.textToAdf(description) : undefined,
    },
  });

  output(
    {
      schemaVersion: "1",
      created: {
        id: issue.id,
        key: issue.key,
        summary,
      },
    },
    opts
  );
}

async function handleEpicIssues(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const epicKey = args[0];
  if (!epicKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Epic key is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const status = getFlag(flags, "status");

  const result = await client.getEpicIssues(epicKey, { maxResults: limit });
  let issues = result.issues || [];

  // Filter by status if specified
  if (status) {
    issues = issues.filter(
      (i) => i.fields.status?.name?.toLowerCase() === status.toLowerCase()
    );
  }

  output(
    {
      schemaVersion: "1",
      epic: epicKey,
      issues: issues.map((i) => ({
        key: i.key,
        summary: i.fields.summary,
        status: i.fields.status?.name,
        statusCategory: i.fields.status?.statusCategory?.key,
        type: i.fields.issuetype?.name,
        assignee: i.fields.assignee?.displayName,
      })),
      total: issues.length,
    },
    opts
  );
}

async function handleEpicAdd(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const epicKey = getFlag(flags, "epic");
  if (!epicKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "--epic is required.");
  }
  if (args.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one issue key is required.");
  }

  const client = await getClient(flags, opts);
  await client.moveIssuesToEpic(epicKey, args);

  output(
    {
      schemaVersion: "1",
      added: {
        epic: epicKey,
        issues: args,
      },
    },
    opts
  );
}

async function handleEpicRemove(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  if (args.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one issue key is required.");
  }

  const client = await getClient(flags, opts);
  await client.removeIssuesFromEpic(args);

  output(
    {
      schemaVersion: "1",
      removed: {
        issues: args,
      },
    },
    opts
  );
}

async function handleEpicProgress(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const epicKey = args[0];
  if (!epicKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Epic key is required.");
  }

  const client = await getClient(flags, opts);

  // Get epic details
  const epic = await client.getIssue(epicKey);

  // Get all child issues
  const result = await client.getEpicIssues(epicKey, { maxResults: 1000 });
  const issues = result.issues || [];

  // Calculate progress by status category
  const byCategory: Record<string, number> = {};
  for (const issue of issues) {
    const cat = issue.fields.status?.statusCategory?.key || "unknown";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  const done = byCategory["done"] || 0;
  const inProgress = byCategory["indeterminate"] || 0;
  const todo = byCategory["new"] || 0;
  const total = issues.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  output(
    {
      schemaVersion: "1",
      epic: {
        key: epic.key,
        summary: epic.fields.summary,
        status: epic.fields.status?.name,
      },
      progress: {
        done,
        inProgress,
        todo,
        total,
        percent,
        bar: generateProgressBar(percent),
      },
    },
    opts
  );
}

function formatEpic(epic: JiraEpic): Record<string, unknown> {
  return {
    id: epic.id,
    key: epic.key,
    name: epic.name,
    summary: epic.summary,
    done: epic.done,
    color: epic.color?.key,
  };
}

function formatIssueAsEpic(issue: JiraIssue): Record<string, unknown> {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status?.name,
    statusCategory: issue.fields.status?.statusCategory?.key,
    assignee: issue.fields.assignee?.displayName,
    created: issue.fields.created,
  };
}

function generateProgressBar(percent: number): string {
  const width = 20;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${"-".repeat(empty)}] ${percent}%`;
}

function epicHelp(): string {
  return `atlcli jira epic <command>

Commands:
  list [--project <key>] [--board <id>] [--done]   List epics
  get <key>                                         Get epic details
  create --project <key> --summary <text> [--description <text>]
  issues <key> [--status <status>] [--limit <n>]   List child issues
  add <issues...> --epic <key>                     Add issues to epic
  remove <issues...>                               Remove issues from epic
  progress <key>                                   Show completion progress

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
  --done             Include completed epics in list

Examples:
  jira epic list --project PROJ
  jira epic list --board 123 --done
  jira epic get PROJ-1
  jira epic create --project PROJ --summary "New Feature"
  jira epic issues PROJ-1
  jira epic add PROJ-10 PROJ-11 --epic PROJ-1
  jira epic remove PROJ-10
  jira epic progress PROJ-1
`;
}

// ============ Analyze (Sprint Analytics) ============

async function handleAnalyze(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub] = args;
  switch (sub) {
    case "velocity":
      await handleAnalyzeVelocity(flags, opts);
      return;
    case "burndown":
      await handleAnalyzeBurndown(flags, opts);
      return;
    case "scope-change":
      await handleAnalyzeScopeChange(flags, opts);
      return;
    case "predictability":
      await handleAnalyzePredictability(flags, opts);
      return;
    default:
      output(analyzeHelp(), opts);
      return;
  }
}

async function handleAnalyzeVelocity(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const boardId = getFlag(flags, "board") ?? (defaults.board ? String(defaults.board) : undefined);
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required (or set defaults.board in config).");
  }

  const sprintCount = Number(getFlag(flags, "sprints") ?? 5);
  const pointsFieldOverride = getFlag(flags, "points-field");

  // Get board info
  const board = await client.getBoard(Number(boardId));

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = (await client.detectStoryPointsField()) ?? undefined;
    if (!pointsField) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        "Could not detect story points field. Use --points-field <field_id> to specify it."
      );
    }
  }

  // Get closed sprints
  const sprintsResult = await client.listSprints(Number(boardId), {
    state: "closed",
    maxResults: sprintCount,
  });

  if (sprintsResult.values.length === 0) {
    output(
      {
        schemaVersion: "1",
        board: { id: board.id, name: board.name },
        message: "No closed sprints found for this board.",
        sprints: [],
        averageVelocity: 0,
        trend: 0,
      },
      opts
    );
    return;
  }

  // Calculate metrics for each sprint
  const sprintMetrics: SprintMetrics[] = [];

  for (const sprint of sprintsResult.values) {
    const issuesResult = await client.getSprintIssues(sprint.id, {
      maxResults: 200,
      fields: ["status", "summary", pointsField],
    });

    const metrics = calculateSprintMetrics(
      sprint as JiraSprint,
      issuesResult.issues,
      pointsField
    );
    sprintMetrics.push(metrics);
  }

  // Calculate velocity trend
  const trend = calculateVelocityTrend(
    Number(boardId),
    board.name,
    sprintMetrics.reverse() // Chronological order (oldest first)
  );

  output(
    {
      schemaVersion: "1",
      board: { id: board.id, name: board.name },
      pointsField,
      sprints: trend.sprints.map((s) => ({
        id: s.id,
        name: s.name,
        velocity: s.velocity,
        completedIssues: s.completedIssues,
      })),
      averageVelocity: trend.averageVelocity,
      trend: trend.trend,
      trendDescription:
        trend.trend > 0
          ? `+${trend.trend}% (improving)`
          : trend.trend < 0
            ? `${trend.trend}% (declining)`
            : "stable",
    },
    opts
  );
}

async function handleAnalyzeBurndown(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sprintId = getFlag(flags, "sprint");
  if (!sprintId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--sprint is required.");
  }

  const pointsFieldOverride = getFlag(flags, "points-field");
  const client = await getClient(flags, opts);

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = (await client.detectStoryPointsField()) ?? undefined;
    if (!pointsField) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        "Could not detect story points field. Use --points-field <field_id> to specify it."
      );
    }
  }

  // Get sprint info
  const sprint = await client.getSprint(Number(sprintId));

  if (!sprint.startDate || !sprint.endDate) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      "Sprint must have start and end dates for burndown calculation."
    );
  }

  // Get sprint issues with changelog for accurate burndown
  const issuesResult = await client.getSprintIssues(Number(sprintId), {
    maxResults: 200,
    fields: ["status", "summary", "resolutiondate", pointsField],
  });

  // Fetch changelog for each issue (needed for accurate burndown)
  const issuesWithChangelog = await Promise.all(
    issuesResult.issues.map((issue) =>
      client.getIssue(issue.key, { expand: "changelog" })
    )
  );

  // Calculate burndown
  const burndown = calculateBurndown(sprint, issuesWithChangelog, pointsField);

  // Calculate totals
  const totalPoints = issuesWithChangelog.reduce(
    (sum, issue) => sum + getStoryPoints(issue, pointsField),
    0
  );

  output(
    {
      schemaVersion: "1",
      sprint: {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
      },
      pointsField,
      totalPoints,
      burndown,
    },
    opts
  );
}

async function handleAnalyzeScopeChange(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sprintId = getFlag(flags, "sprint");
  if (!sprintId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--sprint is required.");
  }

  const pointsFieldOverride = getFlag(flags, "points-field");
  const client = await getClient(flags, opts);

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = (await client.detectStoryPointsField()) ?? undefined;
    if (!pointsField) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        "Could not detect story points field. Use --points-field <field_id> to specify it."
      );
    }
  }

  // Get sprint info
  const sprint = await client.getSprint(Number(sprintId));

  // Get sprint issues
  const issuesResult = await client.getSprintIssues(Number(sprintId), {
    maxResults: 200,
    fields: ["status", "summary", pointsField],
  });

  // Fetch changelog for scope change analysis
  const issuesWithChangelog = await Promise.all(
    issuesResult.issues.map((issue) =>
      client.getIssue(issue.key, { expand: "changelog" })
    )
  );

  // Calculate metrics including scope change
  const metrics = calculateSprintMetrics(
    sprint,
    issuesResult.issues,
    pointsField,
    issuesWithChangelog
  );

  output(
    {
      schemaVersion: "1",
      sprint: {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
      },
      pointsField,
      scopeChange: {
        committedPoints: metrics.committedPoints,
        addedPoints: metrics.addedDuringSprint,
        removedPoints: metrics.removedDuringSprint,
        scopeChangePercent: metrics.scopeChangePercent,
        stability: metrics.scopeChangePercent <= 10 ? "stable" : metrics.scopeChangePercent <= 25 ? "moderate" : "unstable",
      },
      issues: {
        total: metrics.totalIssues,
        completed: metrics.completedIssues,
        incomplete: metrics.incompleteIssues,
      },
    },
    opts
  );
}

async function handleAnalyzePredictability(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const boardId = getFlag(flags, "board") ?? (defaults.board ? String(defaults.board) : undefined);
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required (or set defaults.board in config).");
  }

  const sprintCount = Number(getFlag(flags, "sprints") ?? 5);
  const pointsFieldOverride = getFlag(flags, "points-field");

  // Get board info
  const board = await client.getBoard(Number(boardId));

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = (await client.detectStoryPointsField()) ?? undefined;
    if (!pointsField) {
      fail(
        opts,
        1,
        ERROR_CODES.USAGE,
        "Could not detect story points field. Use --points-field <field_id> to specify it."
      );
    }
  }

  // Get closed sprints
  const sprintsResult = await client.listSprints(Number(boardId), {
    state: "closed",
    maxResults: sprintCount,
  });

  if (sprintsResult.values.length === 0) {
    output(
      {
        schemaVersion: "1",
        board: { id: board.id, name: board.name },
        message: "No closed sprints found for this board.",
        sprints: [],
        averageSayDoRatio: 0,
      },
      opts
    );
    return;
  }

  // Calculate metrics for each sprint
  const sprintMetrics: SprintMetrics[] = [];

  for (const sprint of sprintsResult.values) {
    const issuesResult = await client.getSprintIssues(sprint.id, {
      maxResults: 200,
      fields: ["status", "summary", pointsField],
    });

    const metrics = calculateSprintMetrics(
      sprint as JiraSprint,
      issuesResult.issues,
      pointsField
    );
    sprintMetrics.push(metrics);
  }

  // Calculate average say-do ratio
  const totalSayDo = sprintMetrics.reduce((sum, m) => sum + m.sayDoRatio, 0);
  const averageSayDo = Math.round(totalSayDo / sprintMetrics.length);

  output(
    {
      schemaVersion: "1",
      board: { id: board.id, name: board.name },
      pointsField,
      sprints: sprintMetrics.reverse().map((m) => ({
        id: m.sprintId,
        name: m.sprintName,
        committed: m.committedPoints,
        completed: m.completedPoints,
        sayDoRatio: m.sayDoRatio,
        bar: generateAnalyticsProgressBar(m.completedPoints, m.committedPoints),
      })),
      averageSayDoRatio: averageSayDo,
      predictability:
        averageSayDo >= 80
          ? "high"
          : averageSayDo >= 60
            ? "moderate"
            : "low",
    },
    opts
  );
}

function analyzeHelp(): string {
  return `atlcli jira analyze <command>

Commands:
  velocity --board <id> [--sprints <n>] [--points-field <field>]
      Calculate velocity trend across recent sprints

  burndown --sprint <id> [--points-field <field>]
      Generate burndown data for a sprint

  scope-change --sprint <id> [--points-field <field>]
      Analyze scope stability during a sprint

  predictability --board <id> [--sprints <n>] [--points-field <field>]
      Calculate say-do ratio (predictability) across sprints

Options:
  --profile <name>     Use a specific auth profile
  --json               JSON output
  --board <id>         Board ID for velocity/predictability
  --sprint <id>        Sprint ID for burndown/scope-change
  --sprints <n>        Number of sprints to analyze (default: 5)
  --points-field <id>  Story points field ID (auto-detected if not specified)

Metrics:
  Velocity       Sum of completed story points per sprint
  Say-Do Ratio   Completed / Committed × 100 (predictability)
  Scope Change   (Added + Removed) / Committed × 100 (stability)
  Burndown       Daily remaining vs ideal work curve

Examples:
  jira analyze velocity --board 123 --sprints 5
  jira analyze burndown --sprint 456
  jira analyze scope-change --sprint 456
  jira analyze predictability --board 123
`;
}

// ============ Bulk Operations ============

async function handleBulk(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "edit":
      await handleBulkEdit(flags, opts);
      return;
    case "transition":
      await handleBulkTransition(flags, opts);
      return;
    case "label":
      await handleBulkLabel(rest, flags, opts);
      return;
    case "delete":
      await handleBulkDelete(flags, opts);
      return;
    default:
      output(bulkHelp(), opts);
      return;
  }
}

/**
 * Fetch all issues matching JQL (with pagination).
 */
async function fetchAllIssues(
  client: JiraClient,
  jql: string,
  maxResults: number = 1000
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const result = await client.search(jql, {
      maxResults: Math.min(100, maxResults - issues.length),
      nextPageToken,
      fields: ["summary", "status", "labels", "priority", "assignee"],
    });
    issues.push(...result.issues);
    nextPageToken = result.nextPageToken;
  } while (nextPageToken && issues.length < maxResults);

  return issues;
}

/**
 * Execute an operation on issues in parallel batches.
 */
async function executeInBatches(
  issues: JiraIssue[],
  operation: (issue: JiraIssue) => Promise<void>,
  batchSize: number = 10
): Promise<BulkOperationSummary> {
  const summary: BulkOperationSummary = {
    total: issues.length,
    successful: 0,
    failed: 0,
    errors: [],
  };

  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(operation));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        summary.successful++;
      } else {
        summary.failed++;
        summary.errors.push({
          key: batch[j].key,
          error: result.reason?.message || String(result.reason),
        });
      }
    }
  }

  return summary;
}

/**
 * Parse --set field=value assignments.
 */
function parseFieldAssignments(
  setFlags: string[]
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  for (const assignment of setFlags) {
    const eqIndex = assignment.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`Invalid --set format: "${assignment}". Use field=value.`);
    }

    const field = assignment.slice(0, eqIndex).trim();
    const value = assignment.slice(eqIndex + 1).trim();

    // Handle special field mappings
    switch (field.toLowerCase()) {
      case "priority":
        fields.priority = { name: value };
        break;
      case "assignee":
        fields.assignee = value === "none" ? null : { accountId: value };
        break;
      case "labels":
        fields.labels = value.split(",").map((l) => l.trim());
        break;
      default:
        fields[field] = value;
    }
  }

  return fields;
}

async function handleBulkEdit(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const jql = getFlag(flags, "jql");
  const setFlag = getFlag(flags, "set");
  const dryRun = hasFlag(flags, "dry-run");
  const limit = Number(getFlag(flags, "limit") ?? 1000);

  if (!jql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--jql is required.");
  }
  if (!setFlag) {
    fail(opts, 1, ERROR_CODES.USAGE, "--set is required. Use --set field=value.");
  }

  // Parse field assignments (support multiple --set flags via comma)
  let fieldUpdates: Record<string, unknown>;
  try {
    fieldUpdates = parseFieldAssignments(setFlag.split(",").map((s) => s.trim()));
  } catch (e) {
    fail(opts, 1, ERROR_CODES.USAGE, e instanceof Error ? e.message : String(e));
  }

  const client = await getClient(flags, opts);
  const issues = await fetchAllIssues(client, jql, limit);

  if (issues.length === 0) {
    output(
      { schemaVersion: "1", operation: "edit", jql, count: 0, message: "No issues found." },
      opts
    );
    return;
  }

  // Dry run - show preview
  if (dryRun) {
    output(
      {
        schemaVersion: "1",
        dryRun: true,
        operation: "edit",
        jql,
        fields: fieldUpdates,
        affectedIssues: issues.map((i) => ({ key: i.key, summary: i.fields.summary })),
        count: issues.length,
      },
      opts
    );
    return;
  }

  // Execute bulk edit
  const summary = await executeInBatches(issues, async (issue) => {
    await client.updateIssue(issue.key, { fields: fieldUpdates });
  });

  output(
    {
      schemaVersion: "1",
      operation: "edit",
      jql,
      fields: fieldUpdates,
      result: summary,
    },
    opts
  );
}

async function handleBulkTransition(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const jql = getFlag(flags, "jql");
  const toStatus = getFlag(flags, "to");
  const dryRun = hasFlag(flags, "dry-run");
  const limit = Number(getFlag(flags, "limit") ?? 1000);

  if (!jql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--jql is required.");
  }
  if (!toStatus) {
    fail(opts, 1, ERROR_CODES.USAGE, "--to is required. Specify target status.");
  }

  const client = await getClient(flags, opts);
  const issues = await fetchAllIssues(client, jql, limit);

  if (issues.length === 0) {
    output(
      { schemaVersion: "1", operation: "transition", jql, to: toStatus, count: 0, message: "No issues found." },
      opts
    );
    return;
  }

  // Dry run - show preview
  if (dryRun) {
    output(
      {
        schemaVersion: "1",
        dryRun: true,
        operation: "transition",
        jql,
        to: toStatus,
        affectedIssues: issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          currentStatus: i.fields.status?.name,
        })),
        count: issues.length,
      },
      opts
    );
    return;
  }

  // Execute bulk transition
  const summary = await executeInBatches(issues, async (issue) => {
    // Find the transition for this issue
    const transitions = await client.getTransitions(issue.key);
    const transition = transitions.find(
      (t: JiraTransition) =>
        t.name.toLowerCase() === toStatus.toLowerCase() ||
        t.to.name.toLowerCase() === toStatus.toLowerCase() ||
        t.id === toStatus
    );

    if (!transition) {
      const available = transitions.map((t: JiraTransition) => t.name).join(", ");
      throw new Error(`Transition "${toStatus}" not available. Available: ${available}`);
    }

    await client.transitionIssue(issue.key, { transition: { id: transition.id } });
  });

  output(
    {
      schemaVersion: "1",
      operation: "transition",
      jql,
      to: toStatus,
      result: summary,
    },
    opts
  );
}

async function handleBulkLabel(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [action, ...labelArgs] = args;

  if (action !== "add" && action !== "remove") {
    output(bulkLabelHelp(), opts);
    return;
  }

  const label = labelArgs[0] || getFlag(flags, "label");
  const jql = getFlag(flags, "jql");
  const dryRun = hasFlag(flags, "dry-run");
  const limit = Number(getFlag(flags, "limit") ?? 1000);

  if (!label) {
    fail(opts, 1, ERROR_CODES.USAGE, "Label is required.");
  }
  if (!jql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--jql is required.");
  }

  const client = await getClient(flags, opts);
  const issues = await fetchAllIssues(client, jql, limit);

  if (issues.length === 0) {
    output(
      { schemaVersion: "1", operation: `label-${action}`, jql, label, count: 0, message: "No issues found." },
      opts
    );
    return;
  }

  // Dry run - show preview
  if (dryRun) {
    output(
      {
        schemaVersion: "1",
        dryRun: true,
        operation: `label-${action}`,
        jql,
        label,
        affectedIssues: issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          currentLabels: i.fields.labels,
        })),
        count: issues.length,
      },
      opts
    );
    return;
  }

  // Execute bulk label operation
  const summary = await executeInBatches(issues, async (issue) => {
    if (action === "add") {
      await client.addLabels(issue.key, [label]);
    } else {
      await client.removeLabels(issue.key, [label]);
    }
  });

  output(
    {
      schemaVersion: "1",
      operation: `label-${action}`,
      jql,
      label,
      result: summary,
    },
    opts
  );
}

async function handleBulkDelete(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const jql = getFlag(flags, "jql");
  const confirm = hasFlag(flags, "confirm");
  const dryRun = hasFlag(flags, "dry-run");
  const limit = Number(getFlag(flags, "limit") ?? 1000);

  if (!jql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--jql is required.");
  }

  const client = await getClient(flags, opts);
  const issues = await fetchAllIssues(client, jql, limit);

  if (issues.length === 0) {
    output(
      { schemaVersion: "1", operation: "delete", jql, count: 0, message: "No issues found." },
      opts
    );
    return;
  }

  // Dry run - show preview
  if (dryRun) {
    output(
      {
        schemaVersion: "1",
        dryRun: true,
        operation: "delete",
        jql,
        affectedIssues: issues.map((i) => ({ key: i.key, summary: i.fields.summary })),
        count: issues.length,
        warning: "Use --confirm to execute this destructive operation.",
      },
      opts
    );
    return;
  }

  // Require confirmation for actual delete
  if (!confirm) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      `--confirm is required to delete ${issues.length} issues. Use --dry-run to preview.`
    );
  }

  // Execute bulk delete
  const summary = await executeInBatches(issues, async (issue) => {
    await client.deleteIssue(issue.key);
  });

  output(
    {
      schemaVersion: "1",
      operation: "delete",
      jql,
      result: summary,
    },
    opts
  );
}

function bulkHelp(): string {
  return `atlcli jira bulk <command>

Commands:
  edit --jql <query> --set <field>=<value> [--dry-run] [--limit <n>]
      Bulk edit issues matching JQL query

  transition --jql <query> --to <status> [--dry-run] [--limit <n>]
      Bulk transition issues to a new status

  label add <label> --jql <query> [--dry-run] [--limit <n>]
      Add a label to all matching issues

  label remove <label> --jql <query> [--dry-run] [--limit <n>]
      Remove a label from all matching issues

  delete --jql <query> --confirm [--dry-run] [--limit <n>]
      Delete all matching issues (destructive!)

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
  --jql <query>      JQL query to select issues
  --dry-run          Preview changes without applying
  --limit <n>        Max issues to process (default: 1000)
  --confirm          Required for delete operations

Supported --set fields:
  priority=High      Set priority by name
  assignee=<id>      Set assignee by account ID (or "none")
  labels=a,b,c       Replace all labels

Examples:
  # Preview bulk transition
  jira bulk transition --jql "project = PROJ AND status = Open" --to "In Progress" --dry-run

  # Add label to sprint issues
  jira bulk label add sprint-47 --jql "sprint in openSprints()"

  # Set priority on all bugs
  jira bulk edit --jql "project = PROJ AND type = Bug" --set priority=High

  # Delete test issues (careful!)
  jira bulk delete --jql "project = TEST AND summary ~ 'test'" --confirm
`;
}

function bulkLabelHelp(): string {
  return `atlcli jira bulk label <add|remove> <label> --jql <query>

Usage:
  jira bulk label add <label> --jql <query> [--dry-run]
  jira bulk label remove <label> --jql <query> [--dry-run]

Examples:
  jira bulk label add urgent --jql "project = PROJ AND priority = High"
  jira bulk label remove obsolete --jql "project = PROJ AND resolution IS NOT EMPTY"
`;
}

// ============ Filter Operations ============

async function handleFilter(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleFilterList(flags, opts);
      return;
    case "get":
      await handleFilterGet(rest, flags, opts);
      return;
    case "create":
      await handleFilterCreate(flags, opts);
      return;
    case "update":
      await handleFilterUpdate(rest, flags, opts);
      return;
    case "delete":
      await handleFilterDelete(rest, flags, opts);
      return;
    case "share":
      await handleFilterShare(rest, flags, opts);
      return;
    default:
      output(filterHelp(), opts);
      return;
  }
}

async function handleFilterList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const query = getFlag(flags, "query");
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const favourite = hasFlag(flags, "favorite") || hasFlag(flags, "favourite");

  const client = await getClient(flags, opts);

  if (favourite) {
    const filters = await client.getFavouriteFilters();
    output(
      {
        schemaVersion: "1",
        filters: filters.map(formatFilter),
        total: filters.length,
      },
      opts
    );
    return;
  }

  const result = await client.listFilters({
    filterName: query,
    maxResults: limit,
    expand: "sharePermissions",
  });

  output(
    {
      schemaVersion: "1",
      filters: result.values.map(formatFilter),
      total: result.total,
    },
    opts
  );
}

async function handleFilterGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Filter ID is required.");
  }

  const client = await getClient(flags, opts);
  const filter = await client.getFilter(id, { expand: "sharePermissions" });

  output(
    {
      schemaVersion: "1",
      filter: formatFilter(filter),
    },
    opts
  );
}

async function handleFilterCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = getFlag(flags, "name");
  const jql = getFlag(flags, "jql");
  const description = getFlag(flags, "description");
  const favourite = hasFlag(flags, "favorite") || hasFlag(flags, "favourite");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--name is required.");
  }
  if (!jql) {
    fail(opts, 1, ERROR_CODES.USAGE, "--jql is required.");
  }

  const client = await getClient(flags, opts);
  const filter = await client.createFilter({
    name,
    jql,
    description,
    favourite,
  });

  output(
    {
      schemaVersion: "1",
      created: formatFilter(filter),
    },
    opts
  );
}

async function handleFilterUpdate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Filter ID is required.");
  }

  const name = getFlag(flags, "name");
  const jql = getFlag(flags, "jql");
  const description = getFlag(flags, "description");

  if (!name && !jql && !description) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one of --name, --jql, or --description is required.");
  }

  const client = await getClient(flags, opts);
  const input: { name?: string; jql?: string; description?: string } = {};
  if (name) input.name = name;
  if (jql) input.jql = jql;
  if (description) input.description = description;

  const filter = await client.updateFilter(id, input);

  output(
    {
      schemaVersion: "1",
      updated: formatFilter(filter),
    },
    opts
  );
}

async function handleFilterDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  const confirm = hasFlag(flags, "confirm");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Filter ID is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a filter.");
  }

  const client = await getClient(flags, opts);
  await client.deleteFilter(id);

  output(
    {
      schemaVersion: "1",
      deleted: id,
    },
    opts
  );
}

async function handleFilterShare(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const id = args[0] || getFlag(flags, "id");
  const shareType = getFlag(flags, "type") as "global" | "project" | "group" | undefined;
  const project = getFlag(flags, "project") ?? defaults.project;
  const group = getFlag(flags, "group");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Filter ID is required.");
  }
  if (!shareType) {
    fail(opts, 1, ERROR_CODES.USAGE, "--type is required (global, project, or group).");
  }

  if (shareType === "project" && !project) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project is required when type is 'project' (or set defaults.project in config).");
  }
  if (shareType === "group" && !group) {
    fail(opts, 1, ERROR_CODES.USAGE, "--group is required when type is 'group'.");
  }

  // If project key is provided, we need to look up the project ID
  let projectId: string | undefined;
  if (shareType === "project" && project) {
    const projectData = await client.getProject(project);
    projectId = projectData.id;
  }

  const permission = await client.addFilterPermission(id, {
    type: shareType,
    projectId,
    groupname: group,
  });

  output(
    {
      schemaVersion: "1",
      shared: {
        filterId: id,
        permission: {
          id: permission.id,
          type: permission.type,
          project: permission.project,
          group: permission.group,
        },
      },
    },
    opts
  );
}

function formatFilter(filter: JiraFilter): {
  id: string;
  name: string;
  jql: string;
  description?: string;
  favourite: boolean;
  owner?: string;
  sharePermissions?: Array<{ type: string; project?: string; group?: string }>;
} {
  return {
    id: filter.id,
    name: filter.name,
    jql: filter.jql,
    description: filter.description,
    favourite: filter.favourite,
    owner: filter.owner?.displayName,
    sharePermissions: filter.sharePermissions?.map((p) => ({
      type: p.type,
      project: p.project?.key || p.project?.name,
      group: p.group?.name,
    })),
  };
}

function filterHelp(): string {
  return `atlcli jira filter <command>

Commands:
  list [--query <text>] [--limit <n>] [--favorite]
      List saved filters (optionally search by name)

  get <id>
      Get filter details and JQL

  create --name <name> --jql <query> [--description <text>] [--favorite]
      Create a new saved filter

  update <id> [--name <name>] [--jql <query>] [--description <text>]
      Update a filter

  delete <id> --confirm
      Delete a filter

  share <id> --type <global|project|group> [--project <key>] [--group <name>]
      Share a filter with others

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira filter list
  jira filter list --favorite
  jira filter get 10000
  jira filter create --name "My Open Issues" --jql "assignee = currentUser() AND resolution IS EMPTY"
  jira filter update 10000 --jql "assignee = currentUser() AND status != Done"
  jira filter share 10000 --type project --project PERSONAL
  jira filter delete 10000 --confirm
`;
}

// ============ Search (JQL) ============

async function handleSearch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);

  // JQL can be passed as args or --jql flag
  let jql = args.join(" ") || getFlag(flags, "jql");

  // Build JQL from convenience flags if no raw JQL
  if (!jql) {
    const parts: string[] = [];
    const project = getFlag(flags, "project") ?? defaults.project;
    const assignee = getFlag(flags, "assignee");
    const status = getFlag(flags, "status");
    const type = getFlag(flags, "type");
    const label = getFlag(flags, "label");
    const sprint = getFlag(flags, "sprint");

    if (project) parts.push(`project = ${project}`);
    if (assignee) {
      parts.push(assignee === "me" ? "assignee = currentUser()" : `assignee = "${assignee}"`);
    }
    if (status) parts.push(`status = "${status}"`);
    if (type) parts.push(`issuetype = "${type}"`);
    if (label) parts.push(`labels = "${label}"`);
    if (sprint) {
      if (sprint === "current" || sprint === "active") {
        parts.push("sprint IN openSprints()");
      } else {
        parts.push(`sprint = "${sprint}"`);
      }
    }

    jql = parts.length > 0 ? parts.join(" AND ") : "ORDER BY created DESC";
  }

  const limit = Number(getFlag(flags, "limit") ?? 25);

  const result = await client.search(jql, {
    maxResults: Number.isNaN(limit) ? 25 : limit,
  });

  output(
    {
      schemaVersion: "1",
      jql,
      issues: result.issues.map(formatIssue),
      total: result.total,
    },
    opts
  );
}

async function handleMy(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const parts: string[] = ["assignee = currentUser()"];

  // Optional filters (use defaults if available)
  const project = getFlag(flags, "project") ?? defaults.project;
  const status = getFlag(flags, "status");
  const type = getFlag(flags, "type");
  const all = hasFlag(flags, "all");

  if (project) parts.push(`project = ${project}`);
  if (status) parts.push(`status = "${status}"`);
  if (type) parts.push(`issuetype = "${type}"`);

  // Default: exclude resolved unless --all
  if (!all && !status) {
    parts.push("resolution IS EMPTY");
  }

  // Order by updated
  const jql = parts.join(" AND ") + " ORDER BY updated DESC";
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const result = await client.search(jql, {
    maxResults: Number.isNaN(limit) ? 25 : limit,
  });

  output(
    {
      schemaVersion: "1",
      jql,
      issues: result.issues.map(formatIssue),
      total: result.total,
    },
    opts
  );
}

// ============ Helpers ============

function formatIssue(issue: JiraIssue): Record<string, unknown> {
  const f = issue.fields;
  return {
    id: issue.id,
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    statusCategory: f.status?.statusCategory?.key,
    type: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    assigneeId: f.assignee?.accountId,
    reporter: f.reporter?.displayName,
    created: f.created,
    updated: f.updated,
    labels: f.labels,
    parent: f.parent?.key,
    description: issue.fields.description,
  };
}

// ============ Export/Import Commands ============

async function handleExport(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const jql = getFlag(flags, "jql");
  const outputPath = getFlag(flags, "o") || getFlag(flags, "output");
  const format = (getFlag(flags, "format") || "json") as "csv" | "json";
  const includeComments = !hasFlag(flags, "no-comments");
  const includeAttachments = !hasFlag(flags, "no-attachments");

  if (!jql) {
    output(exportHelp(), opts);
    return;
  }

  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--output (-o) is required for export.");
    return;
  }

  const client = await getClient(flags, opts);

  // Fetch all matching issues
  const allIssues: JiraIssue[] = [];
  const maxResults = 100;
  let nextPageToken: string | undefined;

  if (!opts.json) {
    process.stderr.write("Searching issues...\n");
  }

  while (true) {
    const result = await client.search(jql, {
      nextPageToken,
      maxResults,
      fields: ["*all"],
    });
    allIssues.push(...result.issues);
    if (!result.nextPageToken || result.issues.length === 0) break;
    nextPageToken = result.nextPageToken;
  }

  if (allIssues.length === 0) {
    if (opts.json) {
      output({ schemaVersion: "1", exported: 0, message: "No issues found" }, opts);
    } else {
      output("No issues found matching the query.", opts);
    }
    return;
  }

  if (!opts.json) {
    process.stderr.write(`Found ${allIssues.length} issues. Collecting data...\n`);
  }

  // Collect export data
  const exportedIssues = await collectExportData(
    client,
    allIssues,
    {
      format,
      includeComments,
      includeAttachments,
      outputPath,
    },
    (current, total, key) => {
      if (!opts.json) {
        process.stderr.write(`\rProcessing ${current}/${total}: ${key}...`);
      }
    }
  );

  if (!opts.json) {
    process.stderr.write("\n");
  }

  // Build export data structure
  const exportData: ExportData = {
    exportedAt: new Date().toISOString(),
    query: jql,
    issues: exportedIssues,
  };

  // Write to file
  await writeExportFile(exportData, {
    format,
    includeComments,
    includeAttachments,
    outputPath,
  });

  if (opts.json) {
    output({
      schemaVersion: "1",
      exported: exportedIssues.length,
      format,
      outputPath,
      includeComments,
      includeAttachments,
    }, opts);
  } else {
    output(`Exported ${exportedIssues.length} issues to ${outputPath}`, opts);
    if (format === "csv" && includeAttachments) {
      output(`Attachments saved to: ${outputPath}_attachments/`, opts);
    }
  }
}

async function handleImport(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const filePath = getFlag(flags, "file");
  const project = getFlag(flags, "project") ?? defaults.project;
  const dryRun = hasFlag(flags, "dry-run");
  const skipAttachments = hasFlag(flags, "skip-attachments");

  if (!filePath || !project) {
    output(importHelp(), opts);
    return;
  }

  // Parse the import file
  let issues;
  try {
    issues = await parseImportFile(filePath);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.USAGE, `Failed to parse import file: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (issues.length === 0) {
    if (opts.json) {
      output({ schemaVersion: "1", imported: 0, message: "No issues found in file" }, opts);
    } else {
      output("No issues found in the import file.", opts);
    }
    return;
  }

  if (!opts.json) {
    if (dryRun) {
      process.stderr.write(`[DRY RUN] Would import ${issues.length} issues into project ${project}\n`);
    } else {
      process.stderr.write(`Importing ${issues.length} issues into project ${project}...\n`);
    }
  }

  const result = await importIssues(
    client,
    issues,
    { project, dryRun, skipAttachments },
    (current, total, summary, status) => {
      if (!opts.json) {
        process.stderr.write(`\r${dryRun ? "[DRY RUN] " : ""}${current}/${total}: ${summary.substring(0, 40)}...`);
      }
    }
  );

  if (!opts.json) {
    process.stderr.write("\n");
  }

  if (opts.json) {
    output({
      schemaVersion: "1",
      dryRun,
      total: result.total,
      created: result.created,
      skipped: result.skipped,
      failed: result.failed,
      issues: result.issues,
    }, opts);
  } else {
    output(`${dryRun ? "[DRY RUN] " : ""}Import complete:`, opts);
    output(`  Total: ${result.total}`, opts);
    output(`  Created: ${result.created}`, opts);
    if (result.skipped > 0) output(`  Skipped: ${result.skipped}`, opts);
    if (result.failed > 0) {
      output(`  Failed: ${result.failed}`, opts);
      for (const issue of result.issues.filter((i) => i.status === "failed")) {
        output(`    - ${issue.summary}: ${issue.error}`, opts);
      }
    }
  }
}

function exportHelp(): string {
  return `atlcli jira export --jql <query> -o <file> [options]

Export issues to CSV or JSON with comments and attachments.

Options:
  --jql <query>        JQL query to select issues (required)
  -o, --output <file>  Output file path (required)
  --format <format>    Output format: json (default) or csv
  --no-comments        Exclude comments from export
  --no-attachments     Exclude attachments from export
  --profile <name>     Use a specific auth profile
  --json               JSON output for status

Examples:
  jira export --jql "project = PROJ" -o issues.json
  jira export --jql "assignee = currentUser()" -o my-issues.csv --format csv
  jira export --jql "sprint in openSprints()" -o sprint.json --no-attachments
`;
}

function importHelp(): string {
  return `atlcli jira import --file <path> --project <key> [options]

Import issues from CSV or JSON file (create-only mode).

Options:
  --file <path>        Import file path (required)
  --project <key>      Target project key (required)
  --dry-run            Preview import without creating issues
  --skip-attachments   Skip attachment uploads
  --profile <name>     Use a specific auth profile
  --json               JSON output

Notes:
  - Import creates new issues only (does not update existing)
  - Issues with existing keys are skipped
  - Required fields: summary, issuetype
  - Comments and attachments are included if present in file

Examples:
  jira import --file issues.json --project PROJ --dry-run
  jira import --file backup.csv --project PERSONAL
  jira import --file export.json --project PROJ --skip-attachments
`;
}

// ============ Watch Commands ============

async function handleWatch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [key] = args;
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: jira watch <issue-key>");
    return;
  }

  const client = await getClient(flags, opts);
  const me = await client.getCurrentUser();

  if (!me.accountId) {
    fail(opts, 1, ERROR_CODES.AUTH, "Could not determine current user accountId.");
    return;
  }

  await client.addWatcher(key, me.accountId);

  if (opts.json) {
    output({ schemaVersion: "1", watching: key, user: me.displayName }, opts);
  } else {
    output(`Now watching ${key}`, opts);
  }
}

async function handleUnwatch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [key] = args;
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: jira unwatch <issue-key>");
    return;
  }

  const client = await getClient(flags, opts);
  const me = await client.getCurrentUser();

  if (!me.accountId) {
    fail(opts, 1, ERROR_CODES.AUTH, "Could not determine current user accountId.");
    return;
  }

  await client.removeWatcher(key, me.accountId);

  if (opts.json) {
    output({ schemaVersion: "1", unwatched: key, user: me.displayName }, opts);
  } else {
    output(`Stopped watching ${key}`, opts);
  }
}

async function handleWatchers(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [key] = args;
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: jira watchers <issue-key>");
    return;
  }

  const client = await getClient(flags, opts);
  const result = await client.getWatchers(key);

  if (opts.json) {
    output({
      schemaVersion: "1",
      issue: key,
      watchCount: result.watchCount,
      isWatching: result.isWatching,
      watchers: result.watchers.map((w) => ({
        accountId: w.accountId,
        displayName: w.displayName,
        email: w.emailAddress,
      })),
    }, opts);
  } else {
    output(`Watchers for ${key} (${result.watchCount}):`, opts);
    if (result.isWatching) {
      output(`  (You are watching this issue)`, opts);
    }
    for (const w of result.watchers) {
      output(`  - ${w.displayName}${w.emailAddress ? ` <${w.emailAddress}>` : ""}`, opts);
    }
  }
}

// ============ Webhook Commands ============

async function handleWebhook(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "serve":
      await handleWebhookServe(flags, opts);
      return;
    case "list":
      await handleWebhookList(flags, opts);
      return;
    case "register":
      await handleWebhookRegister(flags, opts);
      return;
    case "delete":
      await handleWebhookDelete(rest, flags, opts);
      return;
    case "refresh":
      await handleWebhookRefresh(rest, flags, opts);
      return;
    default:
      output(webhookHelp(), opts);
      return;
  }
}

async function handleWebhookServe(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const port = Number(getFlag(flags, "port") ?? 8080);
  const path = getFlag(flags, "path") ?? "/webhook";
  const secret = getFlag(flags, "secret");
  const projectsStr = getFlag(flags, "projects");
  const eventsStr = getFlag(flags, "events");

  const filterProjects = projectsStr ? new Set(projectsStr.split(",")) : undefined;
  const filterEvents = eventsStr ? new Set(eventsStr.split(",")) : undefined;

  const server = new JiraWebhookServer({
    port,
    path,
    secret,
    filterProjects,
    filterEvents,
  });

  // Register handler to output events
  server.on((payload: JiraWebhookPayload) => {
    if (opts.json) {
      output({
        schemaVersion: "1",
        type: "event",
        payload,
      }, opts);
    } else {
      output(formatWebhookEvent(payload), opts);
    }
  });

  // Start server
  server.start();

  const url = server.getUrl();
  if (opts.json) {
    output({
      schemaVersion: "1",
      type: "started",
      url,
      port,
      path,
      filters: {
        projects: projectsStr ? projectsStr.split(",") : null,
        events: eventsStr ? eventsStr.split(",") : null,
      },
    }, opts);
  } else {
    output(`Webhook server started at ${url}`, opts);
    output(`Health check: http://localhost:${port}/health`, opts);
    if (filterProjects) {
      output(`Filtering projects: ${projectsStr}`, opts);
    }
    if (filterEvents) {
      output(`Filtering events: ${eventsStr}`, opts);
    }
    output("Press Ctrl+C to stop...", opts);
  }

  // Keep running until interrupted
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop();
      if (!opts.json) {
        output("\nWebhook server stopped.", opts);
      }
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });
}

async function handleWebhookList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const result = await client.getWebhooks();

  output({
    schemaVersion: "1",
    webhooks: result.values.map((w) => ({
      id: w.id,
      jqlFilter: w.jqlFilter,
      events: w.events,
      expirationDate: w.expirationDate,
    })),
    total: result.total,
  }, opts);
}

async function handleWebhookRegister(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const url = getFlag(flags, "url");
  const jql = getFlag(flags, "jql") ?? "";
  const eventsStr = getFlag(flags, "events");

  if (!url) {
    fail(opts, 1, ERROR_CODES.USAGE, "--url is required (your webhook endpoint URL).");
  }
  if (!eventsStr) {
    fail(opts, 1, ERROR_CODES.USAGE, "--events is required (comma-separated event types).");
  }

  const events = eventsStr.split(",");

  const client = await getClient(flags, opts);
  const result = await client.registerWebhooks([{ jqlFilter: jql, events }], url);

  const registration = result.webhookRegistrationResult[0];
  if (registration.errors && registration.errors.length > 0) {
    fail(opts, 1, ERROR_CODES.API, `Webhook registration failed: ${registration.errors.join(", ")}`);
  }

  output({
    schemaVersion: "1",
    registered: true,
    webhookId: registration.createdWebhookId,
    url,
    jqlFilter: jql || "(all issues)",
    events,
  }, opts);
}

async function handleWebhookDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const idStr = args[0] || getFlag(flags, "id");
  if (!idStr) {
    fail(opts, 1, ERROR_CODES.USAGE, "Webhook ID is required.");
  }

  const ids = idStr.split(",").map(Number);

  const client = await getClient(flags, opts);
  await client.deleteWebhooks(ids);

  output({
    schemaVersion: "1",
    deleted: ids,
  }, opts);
}

async function handleWebhookRefresh(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const idStr = args[0] || getFlag(flags, "id");
  if (!idStr) {
    fail(opts, 1, ERROR_CODES.USAGE, "Webhook ID(s) required.");
  }

  const ids = idStr.split(",").map(Number);

  const client = await getClient(flags, opts);
  const result = await client.refreshWebhooks(ids);

  output({
    schemaVersion: "1",
    refreshed: ids,
    expirationDate: result.expirationDate,
  }, opts);
}

function webhookHelp(): string {
  return `atlcli jira webhook <command>

Commands:
  serve [--port <n>] [--path <path>] [--secret <s>] [--projects <p1,p2>] [--events <e1,e2>]
      Start local webhook server to receive Jira events

  list
      List registered webhooks

  register --url <url> --events <events> [--jql <filter>]
      Register a webhook with Jira Cloud

  delete <id>
      Delete a registered webhook

  refresh <id>
      Refresh webhook expiration (webhooks expire after 30 days)

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
  --port <n>         Server port (default: 8080)
  --path <path>      Webhook endpoint path (default: /webhook)
  --secret <s>       Shared secret for HMAC validation
  --projects <list>  Filter by project keys (comma-separated)
  --events <list>    Filter/register event types (comma-separated)
  --url <url>        Your webhook endpoint URL (for registration)
  --jql <filter>     JQL filter for registered webhook

Event Types:
  jira:issue_created, jira:issue_updated, jira:issue_deleted
  comment_created, comment_updated, comment_deleted
  sprint_created, sprint_started, sprint_closed
  worklog_created, worklog_updated, worklog_deleted

Examples:
  # Start local server (use with ngrok/cloudflare tunnel)
  jira webhook serve --port 3000 --projects PROJ,TEAM

  # List registered webhooks
  jira webhook list

  # Register webhook (after starting local server + tunnel)
  jira webhook register --url https://abc.ngrok.io/webhook --events jira:issue_updated,comment_created

  # Refresh before expiration
  jira webhook refresh 12345
`;
}

// ============ Subtask Commands ============

async function handleSubtask(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create":
      await handleSubtaskCreate(rest, flags, opts);
      return;
    case "list":
      await handleSubtaskList(rest, flags, opts);
      return;
    default:
      output(subtaskHelp(), opts);
      return;
  }
}

async function handleSubtaskCreate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const parentKey = args[0] || getFlag(flags, "parent");
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");
  const assignee = getFlag(flags, "assignee");
  const priority = getFlag(flags, "priority");

  if (!parentKey || !summary) {
    fail(opts, 1, ERROR_CODES.USAGE, "Parent issue key and --summary are required.");
  }

  const client = await getClient(flags, opts);

  // Get parent issue to extract project key
  const parent = await client.getIssue(parentKey, { fields: ["project"] });
  const projectKey = parent.fields.project.key;

  // Find subtask issue type for this project
  const issueTypes = await client.getProjectIssueTypes(projectKey);
  const subtaskType = issueTypes.find((t) => t.subtask);
  if (!subtaskType) {
    fail(opts, 1, ERROR_CODES.API, `No subtask issue type found for project ${projectKey}.`);
  }

  const issue = await client.createIssue({
    fields: {
      project: { key: projectKey },
      issuetype: { id: subtaskType.id },
      summary,
      description: description ? client.textToAdf(description) : undefined,
      assignee: assignee ? { accountId: assignee } : undefined,
      priority: priority ? { name: priority } : undefined,
      parent: { key: parentKey },
    },
  });

  output({
    schemaVersion: "1",
    created: {
      id: issue.id,
      key: issue.key,
      parent: parentKey,
      summary,
    },
  }, opts);
}

async function handleSubtaskList(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const parentKey = args[0] || getFlag(flags, "parent");
  if (!parentKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "Parent issue key is required.");
  }

  const client = await getClient(flags, opts);
  const issue = await client.getIssue(parentKey, { fields: ["subtasks", "summary"] });

  const subtasks = issue.fields.subtasks ?? [];

  output({
    schemaVersion: "1",
    parent: {
      key: parentKey,
      summary: issue.fields.summary,
    },
    subtasks: subtasks.map((s) => ({
      key: s.key,
      summary: s.fields?.summary,
      status: s.fields?.status?.name,
      type: s.fields?.issuetype?.name,
    })),
    total: subtasks.length,
  }, opts);
}

function subtaskHelp(): string {
  return `atlcli jira subtask <command>

Commands:
  create <parent> --summary <text> [--description <text>] [--assignee <id>] [--priority <name>]
      Create a subtask under the specified parent issue

  list <parent>
      List all subtasks for an issue

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira subtask create PROJ-123 --summary "Implement feature"
  jira subtask create PROJ-123 --summary "Fix bug" --priority High
  jira subtask list PROJ-123
`;
}

// ============ Component Commands ============

async function handleComponent(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleComponentList(flags, opts);
      return;
    case "get":
      await handleComponentGet(rest, flags, opts);
      return;
    case "create":
      await handleComponentCreate(flags, opts);
      return;
    case "update":
      await handleComponentUpdate(rest, flags, opts);
      return;
    case "delete":
      await handleComponentDelete(rest, flags, opts);
      return;
    default:
      output(componentHelp(), opts);
      return;
  }
}

async function handleComponentList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  if (!project) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project is required (or set defaults.project in config).");
  }
  const components = await client.getProjectComponents(project);

  output({
    schemaVersion: "1",
    project,
    components: components.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      lead: c.lead?.displayName,
    })),
    total: components.length,
  }, opts);
}

async function handleComponentGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Component ID is required.");
  }

  const client = await getClient(flags, opts);
  const component = await client.getComponent(id);

  output({
    schemaVersion: "1",
    component: {
      id: component.id,
      name: component.name,
      description: component.description,
      lead: component.lead?.displayName,
      leadAccountId: component.lead?.accountId,
      assigneeType: component.assigneeType,
    },
  }, opts);
}

async function handleComponentCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description");
  const lead = getFlag(flags, "lead");

  if (!project || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project and --name are required (or set defaults.project in config).");
  }
  const component = await client.createComponent({
    project,
    name,
    description,
    leadAccountId: lead,
  });

  output({
    schemaVersion: "1",
    created: {
      id: component.id,
      name: component.name,
    },
  }, opts);
}

async function handleComponentUpdate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Component ID is required.");
  }

  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description");
  const lead = getFlag(flags, "lead");

  if (!name && !description && !lead) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one of --name, --description, or --lead is required.");
  }

  const client = await getClient(flags, opts);
  const component = await client.updateComponent(id, {
    name,
    description,
    leadAccountId: lead,
  });

  output({
    schemaVersion: "1",
    updated: {
      id: component.id,
      name: component.name,
    },
  }, opts);
}

async function handleComponentDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  const confirm = hasFlag(flags, "confirm");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Component ID is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a component.");
  }

  const client = await getClient(flags, opts);
  await client.deleteComponent(id);

  output({ schemaVersion: "1", deleted: id }, opts);
}

function componentHelp(): string {
  return `atlcli jira component <command>

Commands:
  list --project <key>
      List all components for a project

  get <id>
      Get component details

  create --project <key> --name <name> [--description <text>] [--lead <accountId>]
      Create a new component

  update <id> [--name <name>] [--description <text>] [--lead <accountId>]
      Update a component

  delete <id> --confirm
      Delete a component

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira component list --project PROJ
  jira component create --project PROJ --name "Backend"
  jira component update 10001 --description "Backend services"
  jira component delete 10001 --confirm
`;
}

// ============ Version Commands ============

async function handleVersion(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleVersionList(flags, opts);
      return;
    case "get":
      await handleVersionGet(rest, flags, opts);
      return;
    case "create":
      await handleVersionCreate(flags, opts);
      return;
    case "update":
      await handleVersionUpdate(rest, flags, opts);
      return;
    case "release":
      await handleVersionRelease(rest, flags, opts);
      return;
    case "delete":
      await handleVersionDelete(rest, flags, opts);
      return;
    default:
      output(versionHelp(), opts);
      return;
  }
}

async function handleVersionList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  if (!project) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project is required (or set defaults.project in config).");
  }
  const versions = await client.getProjectVersions(project);

  output({
    schemaVersion: "1",
    project,
    versions: versions.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      released: v.released,
      releaseDate: v.releaseDate,
      startDate: v.startDate,
      archived: v.archived,
    })),
    total: versions.length,
  }, opts);
}

async function handleVersionGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Version ID is required.");
  }

  const client = await getClient(flags, opts);
  const version = await client.getVersion(id);

  output({
    schemaVersion: "1",
    version: {
      id: version.id,
      name: version.name,
      description: version.description,
      released: version.released,
      releaseDate: version.releaseDate,
      startDate: version.startDate,
      archived: version.archived,
    },
  }, opts);
}

async function handleVersionCreate(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const project = getFlag(flags, "project") ?? defaults.project;
  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description");
  const startDate = getFlag(flags, "start-date");
  const releaseDate = getFlag(flags, "release-date");

  if (!project || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project and --name are required (or set defaults.project in config).");
  }

  // Need project ID for version creation
  const projectData = await client.getProject(project);

  const version = await client.createVersion({
    projectId: projectData.id,
    name,
    description,
    startDate,
    releaseDate,
  });

  output({
    schemaVersion: "1",
    created: {
      id: version.id,
      name: version.name,
    },
  }, opts);
}

async function handleVersionUpdate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Version ID is required.");
  }

  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description");
  const startDate = getFlag(flags, "start-date");
  const releaseDate = getFlag(flags, "release-date");

  if (!name && !description && !startDate && !releaseDate) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one of --name, --description, --start-date, or --release-date is required.");
  }

  const client = await getClient(flags, opts);
  const version = await client.updateVersion(id, {
    name,
    description,
    startDate,
    releaseDate,
  });

  output({
    schemaVersion: "1",
    updated: {
      id: version.id,
      name: version.name,
    },
  }, opts);
}

async function handleVersionRelease(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Version ID is required.");
  }

  const client = await getClient(flags, opts);
  const version = await client.updateVersion(id, {
    released: true,
    releaseDate: new Date().toISOString().split("T")[0],
  });

  output({
    schemaVersion: "1",
    released: {
      id: version.id,
      name: version.name,
      releaseDate: version.releaseDate,
    },
  }, opts);
}

async function handleVersionDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0] || getFlag(flags, "id");
  const confirm = hasFlag(flags, "confirm");

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Version ID is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a version.");
  }

  const client = await getClient(flags, opts);
  await client.deleteVersion(id);

  output({ schemaVersion: "1", deleted: id }, opts);
}

function versionHelp(): string {
  return `atlcli jira version <command>

Commands:
  list --project <key>
      List all versions for a project

  get <id>
      Get version details

  create --project <key> --name <name> [--description <text>] [--start-date <YYYY-MM-DD>] [--release-date <YYYY-MM-DD>]
      Create a new version

  update <id> [--name <name>] [--description <text>] [--start-date <YYYY-MM-DD>] [--release-date <YYYY-MM-DD>]
      Update a version

  release <id>
      Mark version as released (sets release date to today)

  delete <id> --confirm
      Delete a version

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira version list --project PROJ
  jira version create --project PROJ --name "1.0.0" --release-date 2026-02-01
  jira version release 10001
  jira version delete 10001 --confirm
`;
}

// ============ Field ============

async function handleField(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleFieldList(flags, opts);
      return;
    case "get":
      await handleFieldGet(rest, flags, opts);
      return;
    case "options":
      await handleFieldOptions(rest, flags, opts);
      return;
    case "search":
      await handleFieldSearch(rest, flags, opts);
      return;
    default:
      output(fieldHelp(), opts);
      return;
  }
}

async function handleFieldList(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const customOnly = hasFlag(flags, "custom");
  const typeFilter = getFlag(flags, "type");

  const client = await getClient(flags, opts);
  const fields = await client.getFields();

  let filtered = fields;

  if (customOnly) {
    filtered = filtered.filter((f) => f.custom);
  }

  if (typeFilter) {
    filtered = filtered.filter((f) => f.schema?.type === typeFilter);
  }

  output(
    {
      schemaVersion: "1",
      fields: filtered.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.schema?.type ?? "unknown",
        custom: f.custom,
        searchable: f.searchable,
        clauseNames: f.clauseNames,
      })),
      total: filtered.length,
    },
    opts
  );
}

async function handleFieldGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const fieldId = args[0] || getFlag(flags, "id");

  if (!fieldId) {
    fail(opts, 1, ERROR_CODES.USAGE, "Field ID is required.");
  }

  const client = await getClient(flags, opts);
  const fields = await client.getFields();
  const field = fields.find((f) => f.id === fieldId || f.key === fieldId);

  if (!field) {
    fail(opts, 1, ERROR_CODES.API, `Field not found: ${fieldId}`);
  }

  output(
    {
      schemaVersion: "1",
      field: {
        id: field.id,
        key: field.key,
        name: field.name,
        custom: field.custom,
        type: field.schema?.type ?? "unknown",
        customType: field.schema?.custom,
        searchable: field.searchable,
        orderable: field.orderable,
        navigable: field.navigable,
        clauseNames: field.clauseNames,
      },
    },
    opts
  );
}

async function handleFieldOptions(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const fieldId = args[0] || getFlag(flags, "id");

  if (!fieldId) {
    fail(opts, 1, ERROR_CODES.USAGE, "Field ID is required.");
  }

  const client = await getClient(flags, opts);

  // Verify field exists and is a custom field
  const fields = await client.getFields();
  const field = fields.find((f) => f.id === fieldId || f.key === fieldId);

  if (!field) {
    fail(opts, 1, ERROR_CODES.API, `Field not found: ${fieldId}`);
  }

  if (!field.custom) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      `Field "${field.name}" is a system field. Only custom fields have configurable options.`
    );
  }

  try {
    const options = await client.getFieldOptions(field.id);

    output(
      {
        schemaVersion: "1",
        field: { id: field.id, name: field.name },
        options,
        total: options.length,
      },
      opts
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("404") || msg.includes("not found")) {
      output(
        {
          schemaVersion: "1",
          field: { id: field.id, name: field.name },
          options: [],
          total: 0,
          message: "Field has no configurable options or does not support options.",
        },
        opts
      );
    } else if (msg.includes("403") || msg.includes("administrators")) {
      output(
        {
          schemaVersion: "1",
          field: { id: field.id, name: field.name },
          options: [],
          total: 0,
          message: "Jira admin permission required to access field options.",
        },
        opts
      );
    } else {
      throw error;
    }
  }
}

async function handleFieldSearch(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const query = args.join(" ") || getFlag(flags, "query");

  if (!query) {
    fail(opts, 1, ERROR_CODES.USAGE, "Search query is required.");
  }

  const client = await getClient(flags, opts);
  const fields = await client.getFields();

  const lowerQuery = query.toLowerCase();
  const matches = fields.filter(
    (f) =>
      f.name.toLowerCase().includes(lowerQuery) ||
      f.id.toLowerCase().includes(lowerQuery) ||
      f.clauseNames?.some((c) => c.toLowerCase().includes(lowerQuery))
  );

  output(
    {
      schemaVersion: "1",
      query,
      fields: matches.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.schema?.type ?? "unknown",
        custom: f.custom,
        clauseNames: f.clauseNames,
      })),
      total: matches.length,
    },
    opts
  );
}

function fieldHelp(): string {
  return `atlcli jira field <command>

Commands:
  list [--custom] [--type <type>]
      List all fields (optionally filter by custom or type)

  get <id>
      Get field details

  options <id>
      List options for select/multiselect custom fields

  search <query>
      Search fields by name, ID, or clause name

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira field list
  jira field list --custom
  jira field list --type string
  jira field get customfield_10016
  jira field options customfield_10001
  jira field search "story point"
`;
}

// ============ Template ============

async function handleTemplate(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await handleTemplateList(opts);
      return;
    case "save":
      await handleTemplateSave(rest, flags, opts);
      return;
    case "get":
      await handleTemplateGet(rest, flags, opts);
      return;
    case "apply":
      await handleTemplateApply(rest, flags, opts);
      return;
    case "delete":
      await handleTemplateDelete(rest, flags, opts);
      return;
    case "export":
      await handleTemplateExport(rest, flags, opts);
      return;
    case "import":
      await handleTemplateImport(flags, opts);
      return;
    default:
      output(templateHelp(), opts);
      return;
  }
}

async function handleTemplateList(opts: OutputOptions): Promise<void> {
  const templates = await listTemplates();

  output(
    {
      schemaVersion: "1",
      templates: templates.map((t) => ({
        name: t.name,
        description: t.description,
        createdAt: t.createdAt,
        sourceIssue: t.sourceIssue,
      })),
      total: templates.length,
    },
    opts
  );
}

async function handleTemplateSave(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0] || getFlag(flags, "name");
  const issueKey = getFlag(flags, "issue");
  const description = getFlag(flags, "description");
  const force = hasFlag(flags, "force");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }
  if (!issueKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "--issue <key> is required.");
  }

  const client = await getClient(flags, opts);
  const issue = await client.getIssue(issueKey, { fields: ["*all"] });

  const template = issueToTemplate(issue, name, description);
  await saveTemplate(template, { force });

  output(
    {
      schemaVersion: "1",
      saved: name,
      sourceIssue: issue.key,
      fields: getTemplateFieldNames(template),
    },
    opts
  );
}

async function handleTemplateGet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0] || getFlag(flags, "name");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }

  const template = await loadTemplate(name);

  output(
    {
      schemaVersion: "1",
      template: {
        name: template.name,
        description: template.description,
        createdAt: template.createdAt,
        sourceIssue: template.sourceIssue,
        fields: template.fields,
      },
    },
    opts
  );
}

async function handleTemplateApply(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const { client, defaults } = await getClient(flags, opts, true);
  const name = args[0] || getFlag(flags, "name");
  const projectKey = getFlag(flags, "project") ?? defaults.project;
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");
  const assignee = getFlag(flags, "assignee");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }
  if (!projectKey) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project <key> is required (or set defaults.project in config).");
  }

  const template = await loadTemplate(name);

  // Summary is required - use template's or override
  const finalSummary = summary || template.fields.summary;
  if (!finalSummary) {
    fail(opts, 1, ERROR_CODES.USAGE, "--summary is required (template has no default summary).");
  }

  const createInput = templateToCreateInput(template, projectKey, {
    summary: finalSummary,
    description,
    assignee,
  });

  const created = await client.createIssue(createInput as { fields: { project: { key: string }; issuetype: { name: string }; summary: string } });

  output(
    {
      schemaVersion: "1",
      created: {
        id: created.id,
        key: created.key,
        self: created.self,
      },
      template: name,
    },
    opts
  );
}

async function handleTemplateDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0] || getFlag(flags, "name");
  const confirm = hasFlag(flags, "confirm");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }
  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "--confirm is required to delete a template.");
  }

  await deleteTemplate(name);

  output({ schemaVersion: "1", deleted: name }, opts);
}

async function handleTemplateExport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0] || getFlag(flags, "name");
  const outputPath = getFlag(flags, "o") || getFlag(flags, "output");

  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Template name is required.");
  }
  if (!outputPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "-o <file> or --output <file> is required.");
  }

  const template = await loadTemplate(name);
  const { writeFile } = await import("fs/promises");
  await writeFile(outputPath, JSON.stringify(template, null, 2), "utf-8");

  output(
    {
      schemaVersion: "1",
      exported: name,
      path: outputPath,
    },
    opts
  );
}

async function handleTemplateImport(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const filePath = getFlag(flags, "file");
  const force = hasFlag(flags, "force");

  if (!filePath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--file <path> is required.");
  }

  const { readFile } = await import("fs/promises");
  const content = await readFile(filePath, "utf-8");

  let template: JiraTemplate;
  try {
    template = JSON.parse(content) as JiraTemplate;
  } catch {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Invalid JSON in template file.");
  }

  // Validate required fields
  if (!template.name || typeof template.name !== "string") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Template must have a 'name' field.");
  }
  if (!template.fields || typeof template.fields !== "object") {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Template must have a 'fields' object.");
  }
  if (!template.fields.issuetype) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Template fields must include 'issuetype'.");
  }
  if (!template.fields.summary) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Template fields must include 'summary'.");
  }

  // Ensure createdAt is set
  if (!template.createdAt) {
    template.createdAt = new Date().toISOString();
  }

  await saveTemplate(template, { force });

  output(
    {
      schemaVersion: "1",
      imported: template.name,
      fields: getTemplateFieldNames(template),
    },
    opts
  );
}

function templateHelp(): string {
  return `atlcli jira template <command>

Commands:
  list
      List all saved templates

  save <name> --issue <key> [--description <text>] [--force]
      Save an issue as a template

  get <name>
      Show template contents

  apply <name> --project <key> [--summary <text>] [--description <text>] [--assignee <id>]
      Create a new issue from template

  delete <name> --confirm
      Delete a template

  export <name> -o <file>
      Export template to a JSON file

  import --file <path> [--force]
      Import template from a JSON file

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  jira template list
  jira template save bug-report --issue PROJ-123 --description "Standard bug template"
  jira template get bug-report
  jira template apply bug-report --project PROJ --summary "Login button broken"
  jira template export bug-report -o /tmp/bug-template.json
  jira template import --file /tmp/bug-template.json
  jira template delete old-template --confirm
`;
}

function jiraHelp(): string {
  return `atlcli jira <command>

Commands:
  project     Project operations (list, get, create, types)
  issue       Issue operations (get, create, update, delete, transition, comment, link, attach)
  board       Board operations (list, get, backlog, issues)
  sprint      Sprint operations (list, get, create, start, close, add, remove, report)
  worklog     Time tracking (add, list, update, delete, timer)
  epic        Epic operations (list, get, create, issues, add, remove, progress)
  analyze     Sprint analytics (velocity, burndown, scope-change, predictability)
  bulk        Bulk operations (edit, transition, label, delete)
  filter      Saved JQL filters (list, get, create, update, delete, share)
  export      Export issues to CSV/JSON with comments and attachments
  import      Import issues from CSV/JSON file
  search      Search with JQL
  me          Get current user info
  my          My open issues (shortcut for search --assignee me)
  watch       Start watching an issue (receive notifications)
  unwatch     Stop watching an issue
  watchers    List watchers for an issue
  webhook     Webhook server (serve, list, register, delete, refresh)
  subtask     Subtask operations (create, list)
  component   Component operations (list, get, create, update, delete)
  version     Version operations (list, get, create, update, release, delete)
  field       Field operations (list, get, options, search)
  template    Issue templates (list, save, get, apply, delete, export, import)

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  atlcli jira project list
  atlcli jira issue create --project PROJ --type Task --summary "My task"
  atlcli jira filter create --name "My Issues" --jql "assignee = currentUser()"
  atlcli jira bulk label add sprint-47 --jql "sprint in openSprints()"
  atlcli jira analyze velocity --board 123 --sprints 5
  atlcli jira export --jql "project = PROJ" -o issues.json
  atlcli jira import --file issues.json --project PROJ --dry-run
  atlcli jira watch PROJ-123
  atlcli jira search --project PROJ --assignee me
  atlcli jira webhook serve --port 3000 --projects PROJ
  atlcli jira subtask create PROJ-123 --summary "My subtask"
  atlcli jira field search "story point"
  atlcli jira template save bug --issue PROJ-1
`;
}

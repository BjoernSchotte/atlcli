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
  TimerState,
  SprintMetrics,
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
  calculateSprintMetrics,
  calculateVelocityTrend,
  calculateBurndown,
  getStoryPoints,
  generateProgressBar as generateAnalyticsProgressBar,
} from "@atlcli/jira";

export async function handleJira(
  args: string[],
  flags: Record<string, string | boolean>,
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
    case "search":
      await handleSearch(rest, flags, opts);
      return;
    case "me":
      await handleMe(flags, opts);
      return;
    default:
      output(jiraHelp(), opts);
      return;
  }
}

async function getClient(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<JiraClient> {
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
  return new JiraClient(profile);
}

// ============ Me ============

async function handleMe(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const user = await client.getCurrentUser();
  output({ schemaVersion: "1", user }, opts);
}

// ============ Project Operations ============

async function handleProject(
  args: string[],
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
    default:
      output(issueHelp(), opts);
      return;
  }
}

async function handleIssueGet(
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const project = getFlag(flags, "project");
  const type = getFlag(flags, "type");
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");
  const priority = getFlag(flags, "priority");
  const assignee = getFlag(flags, "assignee");
  const labels = getFlag(flags, "labels");
  const parent = getFlag(flags, "parent"); // For subtasks or epic children

  if (!project || !type || !summary) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project, --type, and --summary are required.");
  }

  const client = await getClient(flags, opts);
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

// ============ Board Operations ============

async function handleBoard(
  args: string[],
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const type = getFlag(flags, "type") as "scrum" | "kanban" | "simple" | undefined;
  const name = getFlag(flags, "name");
  const project = getFlag(flags, "project");

  const result = await client.listBoards({
    maxResults: Number.isNaN(limit) ? 50 : limit,
    type,
    name,
    projectKeyOrId: project,
  });

  output({ schemaVersion: "1", boards: result.values, total: result.total }, opts);
}

async function handleBoardGet(
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const boardId = getFlag(flags, "board");
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required.");
  }

  const client = await getClient(flags, opts);
  const limit = Number(getFlag(flags, "limit") ?? 50);
  const state = getFlag(flags, "state") as "future" | "active" | "closed" | undefined;

  const result = await client.listSprints(Number(boardId), {
    maxResults: Number.isNaN(limit) ? 50 : limit,
    state,
  });

  output({ schemaVersion: "1", sprints: result.values, total: result.total }, opts);
}

async function handleSprintGet(
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const boardId = getFlag(flags, "board");
  const name = getFlag(flags, "name");

  if (!boardId || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board and --name are required.");
  }

  const client = await getClient(flags, opts);
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
    pointsField = await client.detectStoryPointsField();
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
  flags: Record<string, string | boolean>,
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
    default:
      output(worklogHelp(), opts);
      return;
  }
}

async function handleWorklogAdd(
  args: string[],
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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

// ============ Timer Operations ============

async function handleWorklogTimer(
  args: string[],
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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

Timer mode (start/stop tracking):
  timer start <issue> [--comment <text>]   Start tracking time
  timer stop [--round <interval>]          Stop and log worklog
  timer status                             Show running timer
  timer cancel                             Cancel without logging

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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const client = await getClient(flags, opts);
  const project = getFlag(flags, "project");
  const boardId = getFlag(flags, "board");
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const project = getFlag(flags, "project");
  const summary = getFlag(flags, "summary");
  const description = getFlag(flags, "description");

  if (!project) {
    fail(opts, 1, ERROR_CODES.USAGE, "--project is required.");
  }
  if (!summary) {
    fail(opts, 1, ERROR_CODES.USAGE, "--summary is required.");
  }

  const client = await getClient(flags, opts);

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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const boardId = getFlag(flags, "board");
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required.");
  }

  const sprintCount = Number(getFlag(flags, "sprints") ?? 5);
  const pointsFieldOverride = getFlag(flags, "points-field");

  const client = await getClient(flags, opts);

  // Get board info
  const board = await client.getBoard(Number(boardId));

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = await client.detectStoryPointsField();
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
  flags: Record<string, string | boolean>,
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
    pointsField = await client.detectStoryPointsField();
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
  flags: Record<string, string | boolean>,
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
    pointsField = await client.detectStoryPointsField();
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
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const boardId = getFlag(flags, "board");
  if (!boardId) {
    fail(opts, 1, ERROR_CODES.USAGE, "--board is required.");
  }

  const sprintCount = Number(getFlag(flags, "sprints") ?? 5);
  const pointsFieldOverride = getFlag(flags, "points-field");

  const client = await getClient(flags, opts);

  // Get board info
  const board = await client.getBoard(Number(boardId));

  // Detect or use specified story points field
  let pointsField = pointsFieldOverride;
  if (!pointsField) {
    pointsField = await client.detectStoryPointsField();
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

// ============ Search (JQL) ============

async function handleSearch(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  // JQL can be passed as args or --jql flag
  let jql = args.join(" ") || getFlag(flags, "jql");

  // Build JQL from convenience flags if no raw JQL
  if (!jql) {
    const parts: string[] = [];
    const project = getFlag(flags, "project");
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
  const client = await getClient(flags, opts);

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

function jiraHelp(): string {
  return `atlcli jira <command>

Commands:
  project     Project operations (list, get, create, types)
  issue       Issue operations (get, create, update, delete, transition, comment, link)
  board       Board operations (list, get, backlog, issues)
  sprint      Sprint operations (list, get, create, start, close, add, remove)
  worklog     Time tracking (add, list, update, delete, timer)
  epic        Epic operations (list, get, create, issues, add, remove, progress)
  analyze     Sprint analytics (velocity, burndown, scope-change, predictability)
  search      Search with JQL
  me          Get current user info

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  atlcli jira project list
  atlcli jira issue create --project PROJ --type Task --summary "My task"
  atlcli jira worklog add PROJ-123 1h30m --comment "Feature work"
  atlcli jira worklog timer start PROJ-123
  atlcli jira epic list --project PROJ
  atlcli jira analyze velocity --board 123 --sprints 5
  atlcli jira board list --project PROJ
  atlcli jira sprint list --board 123
  atlcli jira search --project PROJ --assignee me
`;
}

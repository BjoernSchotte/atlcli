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
import { JiraClient, JiraIssue, JiraTransition } from "@atlcli/jira";

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
  search      Search with JQL
  me          Get current user info

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  atlcli jira project list
  atlcli jira project create --key ATLCLI --name "atlcli" --type software
  atlcli jira issue create --project ATLCLI --type Task --summary "My first issue"
  atlcli jira search --project ATLCLI --assignee me
  atlcli jira search "project = ATLCLI AND status = 'To Do'"
`;
}

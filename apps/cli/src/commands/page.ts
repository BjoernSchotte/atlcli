import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  loadConfig,
  output,
  readTextFile,
} from "@atlcli/core";
import {
  ConfluenceClient,
  markdownToStorage,
} from "@atlcli/confluence";

export async function handlePage(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "get":
      await handleGet(flags, opts);
      return;
    case "list":
      await handleList(flags, opts);
      return;
    case "create":
      await handleCreate(flags, opts);
      return;
    case "update":
      await handleUpdate(flags, opts);
      return;
    case "label":
      await handleLabel(args.slice(1), flags, opts);
      return;
    default:
      output(pageHelp(), opts);
      return;
  }
}

async function getClient(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`." , { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

async function handleGet(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  const client = await getClient(flags, opts);
  const page = await client.getPage(id);
  output({ schemaVersion: "1", page }, opts);
}

async function handleList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const label = getFlag(flags, "label");
  const space = getFlag(flags, "space");
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const client = await getClient(flags, opts);

  // If --label is provided, use getPagesByLabel
  if (label) {
    const pages = await client.getPagesByLabel(label, {
      spaceKey: space,
      limit: Number.isNaN(limit) ? 25 : limit,
    });
    output({
      schemaVersion: "1",
      label,
      space: space ?? null,
      pages: pages.map((p) => ({
        id: p.id,
        title: p.title,
        spaceKey: p.spaceKey,
      })),
    }, opts);
    return;
  }

  // Otherwise use CQL search
  const cql = getFlag(flags, "cql") ?? "type=page";
  const pages = await client.searchPages(cql, Number.isNaN(limit) ? 25 : limit);
  output({ schemaVersion: "1", pages }, opts);
}

async function handleCreate(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const space = getFlag(flags, "space");
  const title = getFlag(flags, "title");
  const bodyPath = getFlag(flags, "body");
  if (!space || !title || !bodyPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--space, --title, and --body are required.");
  }
  const client = await getClient(flags, opts);
  const markdown = await readTextFile(bodyPath);
  const storage = markdownToStorage(markdown);
  const page = await client.createPage({ spaceKey: space, title, storage });
  output({ schemaVersion: "1", page }, opts);
}

async function handleUpdate(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const bodyPath = getFlag(flags, "body");
  if (!id || !bodyPath) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id and --body are required.");
  }
  const client = await getClient(flags, opts);
  const current = await client.getPage(id);
  const title = getFlag(flags, "title") ?? current.title;
  const markdown = await readTextFile(bodyPath);
  const storage = markdownToStorage(markdown);
  const version = (current.version ?? 1) + 1;
  const page = await client.updatePage({ id, title, storage, version });
  output({ schemaVersion: "1", page }, opts);
}

// ============ Label Operations ============

async function handleLabel(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const action = args[0];
  switch (action) {
    case "add":
      await handleLabelAdd(args.slice(1), flags, opts);
      return;
    case "remove":
      await handleLabelRemove(args.slice(1), flags, opts);
      return;
    case "list":
      await handleLabelList(flags, opts);
      return;
    default:
      output(labelHelp(), opts);
      return;
  }
}

async function handleLabelAdd(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  // Labels can be passed as positional args or comma-separated
  const labels = args.length > 0
    ? args.flatMap((arg) => arg.split(",").map((l) => l.trim()).filter(Boolean))
    : [];

  if (labels.length === 0) {
    fail(opts, 1, ERROR_CODES.USAGE, "At least one label is required. Usage: atlcli page label add <label> [<label>...] --id <id>");
  }

  const client = await getClient(flags, opts);
  const result = await client.addLabels(id, labels);
  output({
    schemaVersion: "1",
    pageId: id,
    added: labels,
    labels: result.map((l) => l.name),
  }, opts);
}

async function handleLabelRemove(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  const label = args[0];

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }
  if (!label) {
    fail(opts, 1, ERROR_CODES.USAGE, "Label name is required. Usage: atlcli page label remove <label> --id <id>");
  }

  const client = await getClient(flags, opts);
  await client.removeLabel(id, label);

  // Fetch remaining labels
  const remaining = await client.getLabels(id);
  output({
    schemaVersion: "1",
    pageId: id,
    removed: label,
    labels: remaining.map((l) => l.name),
  }, opts);
}

async function handleLabelList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const id = getFlag(flags, "id");
  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "--id is required.");
  }

  const client = await getClient(flags, opts);
  const labels = await client.getLabels(id);
  output({
    schemaVersion: "1",
    pageId: id,
    labels: labels.map((l) => l.name),
  }, opts);
}

function labelHelp(): string {
  return `atlcli page label <command>

Commands:
  add <label> [<label>...] --id <id>   Add labels to a page
  remove <label> --id <id>             Remove a label from a page
  list --id <id>                       List labels on a page

Examples:
  atlcli page label add architecture api-docs --id 12345
  atlcli page label remove draft --id 12345
  atlcli page label list --id 12345
`;
}

function pageHelp(): string {
  return `atlcli page <command>

Commands:
  get --id <id>
  list [--cql <query>] [--limit <n>] [--label <label>] [--space <key>]
  create --space <key> --title <title> --body <file>
  update --id <id> --body <file> [--title <title>]
  label <add|remove|list> ...          Manage page labels

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output

Examples:
  atlcli page list --label architecture
  atlcli page list --label api-docs --space MYSPACE
  atlcli page label add important --id 12345

Run 'atlcli page label' for label subcommand help.
`;
}

import {
  ConfluenceClient,
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  loadConfig,
  markdownToStorage,
  output,
  readTextFile,
} from "@atlcli/core";

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
  const cql = getFlag(flags, "cql") ?? "type=page";
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const client = await getClient(flags, opts);
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

function pageHelp(): string {
  return `atlcli page <command>

Commands:
  get --id <id>
  list [--cql <query>] [--limit <n>]
  create --space <key> --title <title> --body <file>
  update --id <id> --body <file> [--title <title>]

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

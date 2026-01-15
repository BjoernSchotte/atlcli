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
import { ConfluenceClient } from "@atlcli/confluence";

export async function handleSpace(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  // Show help if --help or -h flag is set
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(spaceHelp(), opts);
    return;
  }

  const sub = args[0];
  switch (sub) {
    case "list":
      await handleList(flags, opts);
      return;
    case "get":
      await handleGet(flags, opts);
      return;
    case "create":
      await handleCreate(flags, opts);
      return;
    default:
      output(spaceHelp(), opts);
      return;
  }
}

async function getClient(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

async function handleList(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const client = await getClient(flags, opts);
  const spaces = await client.listSpaces(Number.isNaN(limit) ? 25 : limit);
  output({ schemaVersion: "1", spaces }, opts);
}

async function handleGet(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }
  const client = await getClient(flags, opts);
  const space = await client.getSpace(key);
  output({ schemaVersion: "1", space }, opts);
}

async function handleCreate(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const key = getFlag(flags, "key");
  const name = getFlag(flags, "name");
  const description = getFlag(flags, "description");
  if (!key || !name) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key and --name are required.");
  }
  const client = await getClient(flags, opts);
  const space = await client.createSpace({ key, name, description });
  output({ schemaVersion: "1", space }, opts);
}

function spaceHelp(): string {
  return `atlcli wiki space <command>

Confluence space operations.

Commands:
  list    List spaces
  get     Get space details
  create  Create a new space

Options:
  --key <key>         Space key (required for get/create)
  --name <name>       Space name (required for create)
  --description <txt> Space description (optional)
  --limit <n>         Max results for list (default: 25)
  --profile <name>    Use a specific auth profile
  --json              JSON output

Examples:
  atlcli wiki space list
  atlcli wiki space get --key TEAM
  atlcli wiki space create --key DOCS --name "Documentation"
`;
}

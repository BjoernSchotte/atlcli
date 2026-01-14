import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  loadConfig,
  output,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";

export async function handleSpace(args: string[], flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
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

async function getClient(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<ConfluenceClient> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", { profile: profileName });
  }
  return new ConfluenceClient(profile);
}

async function handleList(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const limit = Number(getFlag(flags, "limit") ?? 25);
  const client = await getClient(flags, opts);
  const spaces = await client.listSpaces(Number.isNaN(limit) ? 25 : limit);
  output({ schemaVersion: "1", spaces }, opts);
}

async function handleGet(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
  const key = getFlag(flags, "key");
  if (!key) {
    fail(opts, 1, ERROR_CODES.USAGE, "--key is required.");
  }
  const client = await getClient(flags, opts);
  const space = await client.getSpace(key);
  output({ schemaVersion: "1", space }, opts);
}

async function handleCreate(flags: Record<string, string | boolean>, opts: OutputOptions): Promise<void> {
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

Commands:
  list [--limit <n>]
  get --key <key>
  create --key <KEY> --name <name> [--description <text>]

Options:
  --profile <name>   Use a specific auth profile
  --json             JSON output
`;
}

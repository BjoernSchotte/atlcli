import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getFlagValue,
  hasFlag,
  listFlags,
  output,
  setGlobalFlag,
  setProjectFlag,
  unsetFlag,
  FlagValue,
} from "@atlcli/core";

export async function handleFlag(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const sub = args[0];

  if (!sub) {
    output(flagHelp(), opts);
    return;
  }

  switch (sub) {
    case "list":
    case "ls":
      await handleList(opts);
      return;
    case "get":
      await handleGet(args.slice(1), opts);
      return;
    case "set":
      await handleSet(args.slice(1), flags, opts);
      return;
    case "unset":
    case "rm":
      await handleUnset(args.slice(1), flags, opts);
      return;
    default:
      output(flagHelp(), opts);
      return;
  }
}

async function handleList(opts: OutputOptions): Promise<void> {
  const entries = await listFlags();

  if (entries.length === 0) {
    output("No flags set", opts);
    return;
  }

  if (opts.json) {
    output(entries, opts);
    return;
  }

  const lines = entries.map((e) => {
    const value =
      typeof e.value === "string" ? `"${e.value}"` : String(e.value);
    return `${e.name} = ${value} (${e.source})`;
  });
  output(lines.join("\n"), opts);
}

async function handleGet(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Flag name required");
  }

  const value = await getFlagValue(name);

  if (value === undefined) {
    if (opts.json) {
      output({ name, value: null, set: false }, opts);
    } else {
      output(`Flag '${name}' is not set`, opts);
    }
    return;
  }

  if (opts.json) {
    output({ name, value, set: true }, opts);
  } else {
    const displayValue =
      typeof value === "string" ? `"${value}"` : String(value);
    output(`${name} = ${displayValue}`, opts);
  }
}

function parseValue(valueStr: string): FlagValue {
  if (valueStr === "true") return true;
  if (valueStr === "false") return false;
  const num = Number(valueStr);
  if (!isNaN(num) && valueStr.trim() !== "") return num;
  return valueStr;
}

async function handleSet(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  const valueStr = args[1];

  if (!name || valueStr === undefined) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Usage: atlcli flag set <name> <value> [--global]");
  }

  const value = parseValue(valueStr);
  const isGlobal = hasFlag(flags, "global");

  if (isGlobal) {
    await setGlobalFlag(name, value);
    output(`Set global flag: ${name} = ${JSON.stringify(value)}`, opts);
  } else {
    await setProjectFlag(name, value);
    output(`Set project flag: ${name} = ${JSON.stringify(value)}`, opts);
  }
}

async function handleUnset(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];

  if (!name) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Flag name required");
  }

  const scope = hasFlag(flags, "global") ? "global" : "project";
  const removed = await unsetFlag(name, scope);

  if (removed) {
    output(`Removed ${scope} flag: ${name}`, opts);
  } else {
    output(`Flag '${name}' was not set in ${scope} config`, opts);
  }
}

function flagHelp(): string {
  return `Usage: atlcli flag <command> [options]

Commands:
  list, ls              List all flags with their sources
  get <name>            Get a flag value
  set <name> <value>    Set a flag (project-level by default)
  unset, rm <name>      Remove a flag

Options:
  --global              Apply to global config instead of project

Precedence (highest to lowest):
  1. Environment variables (FLAG_*)
  2. Project config (.atlcli/config.json)
  3. Global config (~/.atlcli/config.json)

Examples:
  atlcli flag set uno.service true
  atlcli flag set export.backend libreoffice --global
  atlcli flag get uno.service
  atlcli flag list
  atlcli flag unset uno.service`;
}

/**
 * Config command for atlcli.
 *
 * atlcli config list                    - Show all config
 * atlcli config get <key>               - Get a value
 * atlcli config set <key> <value>       - Set a value
 * atlcli config unset <key>             - Remove a value
 */

import { OutputOptions, output, loadConfig, saveConfig, hasFlag } from "@atlcli/core";

export async function handleConfig(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const [sub, ...rest] = args;

  // Show help if no subcommand
  if (!sub) {
    output(configHelp(), opts);
    return;
  }

  switch (sub) {
    case "list":
      await configList(opts);
      return;
    case "get":
      await configGet(rest[0], opts);
      return;
    case "set":
      await configSet(rest[0], rest.slice(1).join(" "), opts);
      return;
    case "unset":
      await configUnset(rest[0], opts);
      return;
    default:
      output(configHelp(), opts);
      return;
  }
}

async function configList(opts: OutputOptions): Promise<void> {
  const config = await loadConfig();

  // Redact sensitive auth data, include profile-specific defaults
  const safe = {
    currentProfile: config.currentProfile,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, p]) => [
        name,
        {
          name: p.name,
          baseUrl: p.baseUrl,
          auth: { type: p.auth.type },
          project: p.project,
          space: p.space,
          board: p.board,
        },
      ])
    ),
    global: config.global,
    logging: config.logging,
  };

  if (opts.json) {
    output({ schemaVersion: "1", config: safe }, opts);
  } else {
    output(formatConfig(safe), opts);
  }
}

async function configGet(key: string, opts: OutputOptions): Promise<void> {
  if (!key) {
    output("Usage: atlcli config get <key>", opts);
    return;
  }

  const config = await loadConfig();

  // Special handling for profile keys
  const profileMatch = key.match(/^profiles\.([^.]+)\.(.+)$/);
  let value: any;
  if (profileMatch) {
    const [, profileName, field] = profileMatch;
    value = (config.profiles[profileName] as any)?.[field];
  } else {
    value = getNestedValue(config, key);
  }

  if (value === undefined) {
    output(`Key "${key}" not set`, opts);
    return;
  }

  if (opts.json) {
    output({ schemaVersion: "1", key, value }, opts);
  } else {
    if (typeof value === "object") {
      output(JSON.stringify(value, null, 2), opts);
    } else {
      output(String(value), opts);
    }
  }
}

async function configSet(key: string, value: string, opts: OutputOptions): Promise<void> {
  if (!key || value === undefined || value === "") {
    output("Usage: atlcli config set <key> <value>", opts);
    return;
  }

  // Validate key path
  if (!isValidKey(key)) {
    output(`Invalid key: ${key}`, opts);
    output("Valid keys: global.(project|space|board), profiles.<name>.(project|space|board), logging.(level|global|project)", opts);
    return;
  }

  const config = await loadConfig();

  // Special handling for profile keys
  const profileMatch = key.match(/^profiles\.([^.]+)\.(.+)$/);
  if (profileMatch) {
    const [, profileName, field] = profileMatch;
    if (!config.profiles[profileName]) {
      output(`Profile "${profileName}" not found.`, opts);
      return;
    }
    (config.profiles[profileName] as any)[field] = parseValue(value);
    await saveConfig(config);
    output(`Set ${key} = ${value}`, opts);
    return;
  }

  setNestedValue(config, key, parseValue(value));
  await saveConfig(config);

  output(`Set ${key} = ${value}`, opts);
}

async function configUnset(key: string, opts: OutputOptions): Promise<void> {
  if (!key) {
    output("Usage: atlcli config unset <key>", opts);
    return;
  }

  const config = await loadConfig();

  // Special handling for profile keys
  const profileMatch = key.match(/^profiles\.([^.]+)\.(.+)$/);
  if (profileMatch) {
    const [, profileName, field] = profileMatch;
    if (config.profiles[profileName]) {
      delete (config.profiles[profileName] as any)[field];
      await saveConfig(config);
    }
    output(`Unset ${key}`, opts);
    return;
  }

  deleteNestedValue(config, key);
  await saveConfig(config);

  output(`Unset ${key}`, opts);
}

// Helper: get nested value by dot notation
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

// Helper: set nested value by dot notation
function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => (o[k] = o[k] ?? {}), obj);
  target[last] = value;
}

// Helper: delete nested value
function deleteNestedValue(obj: any, path: string): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => o?.[k], obj);
  if (target) delete target[last];
}

// Helper: parse value (bool, number, string)
function parseValue(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;
  return value;
}

// Helper: validate key
function isValidKey(key: string): boolean {
  // Global: global.project, global.space, global.board
  if (/^global\.(project|space|board)$/.test(key)) return true;

  // Logging: logging.level, logging.global, logging.project
  if (/^logging\.(level|global|project)$/.test(key)) return true;

  // Profile: profiles.<name>.(project|space|board)
  if (/^profiles\.[a-zA-Z0-9_-]+\.(project|space|board)$/.test(key)) return true;

  return false;
}

// Helper: format config for display
function formatConfig(config: any): string {
  const lines: string[] = [];

  if (config.currentProfile) {
    lines.push(`Current Profile: ${config.currentProfile}`);
  }

  if (config.global && Object.keys(config.global).length > 0) {
    lines.push("");
    lines.push("Global:");
    for (const [key, value] of Object.entries(config.global)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (config.logging && Object.keys(config.logging).length > 0) {
    lines.push("");
    lines.push("Logging:");
    for (const [key, value] of Object.entries(config.logging)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (Object.keys(config.profiles).length > 0) {
    lines.push("");
    lines.push("Profiles:");
    for (const [name, profile] of Object.entries(config.profiles) as [string, any][]) {
      const current = name === config.currentProfile ? " (active)" : "";
      lines.push(`  ${name}${current}: ${profile.baseUrl}`);

      // Show profile-specific defaults if set
      const profileDefaults: string[] = [];
      if (profile.project) profileDefaults.push(`project: ${profile.project}`);
      if (profile.space) profileDefaults.push(`space: ${profile.space}`);
      if (profile.board) profileDefaults.push(`board: ${profile.board}`);
      if (profileDefaults.length > 0) {
        lines.push(`    ${profileDefaults.join(", ")}`);
      }
    }
  }

  if (lines.length === 0) {
    return "No configuration set. Run: atlcli auth login";
  }

  return lines.join("\n");
}

function configHelp(): string {
  return `atlcli config <command>

Manage CLI configuration settings.

Commands:
  list              Show all configuration
  get <key>         Get a configuration value
  set <key> <value> Set a configuration value
  unset <key>       Remove a configuration value

Keys:
  global.project          Default Jira project key
  global.space            Default Confluence space key
  global.board            Default Jira board ID
  profiles.<name>.project Profile-specific Jira project
  profiles.<name>.space   Profile-specific Confluence space
  profiles.<name>.board   Profile-specific Jira board
  logging.level           Log level: off, error, warn, info, debug
  logging.global          Enable global logs (true/false)
  logging.project         Enable project logs (true/false)

Resolution: CLI flag > profile config > global config

Examples:
  atlcli config list
  atlcli config set global.project PROJ
  atlcli config set profiles.work.project WORKPROJ
  atlcli config get logging.level
  atlcli config unset global.space
`;
}

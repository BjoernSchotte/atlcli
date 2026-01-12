/**
 * Log query and management commands.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import os from "node:os";
import { hasFlag, getFlag, output, fail, ERROR_CODES } from "@atlcli/core";
import type { OutputOptions } from "@atlcli/core";
import type { LogEntry, LogLevel, LogEntryType } from "@atlcli/core";

/** Get the global logs directory */
function getGlobalLogsDir(): string {
  return join(os.homedir(), ".atlcli", "logs");
}

/** Get the project logs directory */
function getProjectLogsDir(projectDir: string): string {
  return join(projectDir, ".atlcli", "logs");
}

/** Parse a relative time string like "1h", "7d", "30m" */
function parseRelativeTime(str: string): Date | null {
  const match = str.match(/^(\d+)([mhd])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case "m":
      return new Date(now.getTime() - value * 60 * 1000);
    case "h":
      return new Date(now.getTime() - value * 60 * 60 * 1000);
    case "d":
      return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

/** Parse a date string (ISO or relative) */
function parseDate(str: string): Date | null {
  // Try relative time first
  const relative = parseRelativeTime(str);
  if (relative) return relative;

  // Try ISO date
  const date = new Date(str);
  if (!isNaN(date.getTime())) return date;

  return null;
}

/** Get all log files from a directory, sorted by date (newest first) */
function getLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .map((f) => join(dir, f));
}

/** Stream log entries from files with filtering */
async function* streamLogs(
  files: string[],
  filters: {
    since?: Date;
    until?: Date;
    level?: LogLevel;
    type?: string;
    limit?: number;
  }
): AsyncGenerator<LogEntry> {
  let count = 0;
  const limit = filters.limit ?? Infinity;

  for (const file of files) {
    if (count >= limit) break;

    const rl = createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (count >= limit) break;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as LogEntry;

        // Apply filters
        if (filters.since) {
          const entryDate = new Date(entry.timestamp);
          if (entryDate < filters.since) continue;
        }

        if (filters.until) {
          const entryDate = new Date(entry.timestamp);
          if (entryDate > filters.until) continue;
        }

        if (filters.level && entry.level !== filters.level) continue;

        if (filters.type) {
          // Support partial type matching (e.g., "api" matches "api.request" and "api.response")
          if (!entry.type.startsWith(filters.type)) continue;
        }

        yield entry;
        count++;
      } catch {
        // Skip invalid JSON lines
      }
    }
  }
}

/** Format a log entry for display */
function formatEntry(entry: LogEntry, verbose = false): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const level = entry.level.toUpperCase().padEnd(5);
  const type = entry.type.padEnd(14);

  let summary = "";
  switch (entry.type) {
    case "cli.command":
      summary = entry.data.command.join(" ");
      break;
    case "cli.result":
      summary = `${entry.data.command.join(" ")} [${entry.data.exitCode === 0 ? "OK" : "FAIL"}] ${entry.data.durationMs}ms`;
      break;
    case "api.request":
      summary = `${entry.data.method} ${entry.data.path}`;
      break;
    case "api.response":
      summary = `${entry.data.status} ${entry.data.durationMs}ms`;
      break;
    case "sync.event":
      summary = `${entry.data.eventType} ${entry.data.file || entry.data.pageId || ""}`;
      break;
    case "auth.change":
      summary = `${entry.data.action} ${entry.data.profile || ""}`;
      break;
    case "error":
      summary = entry.data.message.slice(0, 60);
      break;
  }

  if (verbose) {
    return `${time} ${level} ${type} ${entry.id}\n  ${summary}\n  ${JSON.stringify(entry.data)}`;
  }

  return `${time} ${level} ${type} ${summary}`;
}

export async function handleLog(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      await handleList(flags, opts);
      break;
    case "tail":
      await handleTail(flags, opts);
      break;
    case "show":
      await handleShow(args.slice(1), flags, opts);
      break;
    case "clear":
      await handleClear(flags, opts);
      break;
    default:
      output(logHelp(), opts);
  }
}

async function handleList(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const sinceStr = getFlag(flags, "since");
  const untilStr = getFlag(flags, "until");
  const level = getFlag(flags, "level") as LogLevel | undefined;
  const type = getFlag(flags, "type");
  const limit = parseInt(getFlag(flags, "limit") || "100", 10);
  const globalOnly = hasFlag(flags, "global");
  const projectOnly = hasFlag(flags, "project");

  const since = sinceStr ? parseDate(sinceStr) : undefined;
  const until = untilStr ? parseDate(untilStr) : undefined;

  if (sinceStr && !since) {
    fail(opts, 1, ERROR_CODES.USAGE, `Invalid date format: ${sinceStr}`);
  }
  if (untilStr && !until) {
    fail(opts, 1, ERROR_CODES.USAGE, `Invalid date format: ${untilStr}`);
  }

  // Collect log files
  const files: string[] = [];

  if (!projectOnly) {
    files.push(...getLogFiles(getGlobalLogsDir()));
  }

  if (!globalOnly) {
    files.push(...getLogFiles(getProjectLogsDir(process.cwd())));
  }

  // Sort all files by name (date) descending
  files.sort().reverse();

  const entries: LogEntry[] = [];
  for await (const entry of streamLogs(files, { since, until, level, type, limit })) {
    entries.push(entry);
  }

  if (opts.json) {
    output({ schemaVersion: "1", entries }, opts);
  } else {
    if (entries.length === 0) {
      output("No log entries found.", opts);
    } else {
      for (const entry of entries) {
        output(formatEntry(entry), opts);
      }
    }
  }
}

async function handleTail(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const follow = hasFlag(flags, "follow") || hasFlag(flags, "f");
  const level = getFlag(flags, "level") as LogLevel | undefined;
  const projectOnly = hasFlag(flags, "project");
  const limit = parseInt(getFlag(flags, "limit") || "20", 10);

  const logsDir = projectOnly ? getProjectLogsDir(process.cwd()) : getGlobalLogsDir();
  const files = getLogFiles(logsDir);

  if (files.length === 0) {
    output("No log files found.", opts);
    return;
  }

  // Show last N entries
  const entries: LogEntry[] = [];
  for await (const entry of streamLogs(files, { level, limit })) {
    entries.push(entry);
  }

  for (const entry of entries.reverse()) {
    output(formatEntry(entry), opts);
  }

  if (follow) {
    output("\n--- Following new log entries (Ctrl+C to stop) ---\n", opts);

    // Watch for new entries
    const today = new Date().toISOString().split("T")[0];
    const currentFile = join(logsDir, `${today}.jsonl`);
    let lastSize = existsSync(currentFile) ? statSync(currentFile).size : 0;

    const pollInterval = setInterval(async () => {
      if (!existsSync(currentFile)) return;

      const currentSize = statSync(currentFile).size;
      if (currentSize > lastSize) {
        // Read new content
        const content = await readFile(currentFile, "utf-8");
        const lines = content.slice(lastSize).split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as LogEntry;
            if (level && entry.level !== level) continue;
            output(formatEntry(entry), opts);
          } catch {
            // Skip invalid lines
          }
        }

        lastSize = currentSize;
      }
    }, 1000);

    // Handle Ctrl+C
    process.on("SIGINT", () => {
      clearInterval(pollInterval);
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
  }
}

async function handleShow(
  args: string[],
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const id = args[0];

  if (!id) {
    fail(opts, 1, ERROR_CODES.USAGE, "Log entry ID is required.");
  }

  // Search all log files for the entry
  const files = [
    ...getLogFiles(getGlobalLogsDir()),
    ...getLogFiles(getProjectLogsDir(process.cwd())),
  ];

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        if (entry.id === id) {
          if (opts.json) {
            output({ schemaVersion: "1", entry }, opts);
          } else {
            output(`ID:        ${entry.id}`, opts);
            output(`Timestamp: ${entry.timestamp}`, opts);
            output(`Level:     ${entry.level}`, opts);
            output(`Type:      ${entry.type}`, opts);
            output(`Session:   ${entry.sessionId}`, opts);
            output(`PID:       ${entry.pid}`, opts);
            output("", opts);
            output("Data:", opts);
            output(JSON.stringify(entry.data, null, 2), opts);
          }
          return;
        }
      } catch {
        // Skip invalid lines
      }
    }
  }

  fail(opts, 1, ERROR_CODES.USAGE, `Log entry not found: ${id}`);
}

async function handleClear(
  flags: Record<string, string | boolean>,
  opts: OutputOptions
): Promise<void> {
  const beforeStr = getFlag(flags, "before");
  const confirm = hasFlag(flags, "confirm");
  const globalOnly = hasFlag(flags, "global");
  const projectOnly = hasFlag(flags, "project");

  if (!confirm) {
    fail(opts, 1, ERROR_CODES.USAGE, "Use --confirm to clear logs.");
  }

  let before: Date | undefined;
  if (beforeStr) {
    before = parseDate(beforeStr) ?? undefined;
    if (!before) {
      fail(opts, 1, ERROR_CODES.USAGE, `Invalid date format: ${beforeStr}`);
    }
  }

  let cleared = 0;

  const clearDir = async (dir: string) => {
    if (!existsSync(dir)) return;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(dir, file);

      if (before) {
        // Parse date from filename (YYYY-MM-DD.jsonl)
        const dateStr = file.replace(".jsonl", "");
        const fileDate = new Date(dateStr);
        if (fileDate >= before) continue;
      }

      await rm(filePath);
      cleared++;
    }
  };

  if (!projectOnly) {
    await clearDir(getGlobalLogsDir());
  }

  if (!globalOnly) {
    await clearDir(getProjectLogsDir(process.cwd()));
  }

  if (opts.json) {
    output({ schemaVersion: "1", cleared }, opts);
  } else {
    output(`Cleared ${cleared} log file(s).`, opts);
  }
}

function logHelp(): string {
  return `atlcli log <subcommand>

Subcommands:
  list      List/filter log entries
  tail      Stream recent logs
  show      Show full log entry details
  clear     Clear old log files

List options:
  --since <date>    Start date (ISO or relative: 1h, 7d, 30m)
  --until <date>    End date
  --level <level>   Filter by level: error|warn|info|debug
  --type <type>     Filter by type: api|cli|sync|auth|error
  --limit <n>       Max entries (default: 100)
  --global          Query global logs only
  --project         Query project logs only

Tail options:
  -f, --follow      Keep following (like tail -f)
  --level <level>   Filter by level
  --limit <n>       Initial entries to show (default: 20)
  --project         Tail project logs instead of global

Clear options:
  --before <date>   Clear logs older than date
  --global          Clear global logs only
  --project         Clear project logs only
  --confirm         Required to actually clear

Examples:
  atlcli log list --since "1h" --level error
  atlcli log list --type api --limit 50
  atlcli log tail -f
  atlcli log show abc123-uuid
  atlcli log clear --before "7d" --confirm
`;
}

/**
 * Node logger wiring for atlcli.
 *
 * Re-exports the browser-safe logger core and installs the JSONL file sink
 * (writing to `~/.atlcli/logs/` and project `.atlcli/logs/`) as the default,
 * so `getLogger()` in the CLI behaves exactly as before the logger split.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { Logger } from "./logger.js";
import type { LogEntry, LoggerOptions, LogSink } from "./logger.js";

// Re-export the full logger surface so Node consumers can import everything
// from a single module.
export * from "./logger.js";

/**
 * Get the global logs directory (~/.atlcli/logs/).
 */
function getGlobalLogsDir(): string {
  return join(os.homedir(), ".atlcli", "logs");
}

/**
 * Get the project logs directory (.atlcli/logs/).
 */
function getProjectLogsDir(projectDir: string): string {
  return join(projectDir, ".atlcli", "logs");
}

/**
 * Get today's log filename (YYYY-MM-DD.jsonl).
 */
function getLogFilename(): string {
  const date = new Date().toISOString().split("T")[0];
  return `${date}.jsonl`;
}

/**
 * JSONL file sink — reproduces the pre-split file-writing behavior.
 */
export class FileLogSink implements LogSink {
  private enableGlobal = true;
  private enableProject = true;
  private projectDir: string | null = null;

  configure(options: LoggerOptions): void {
    if (options.enableGlobal !== undefined) {
      this.enableGlobal = options.enableGlobal;
    }
    if (options.enableProject !== undefined) {
      this.enableProject = options.enableProject;
    }
    if (options.projectDir !== undefined) {
      this.projectDir = options.projectDir;
    }
  }

  reset(): void {
    this.enableGlobal = true;
    this.enableProject = true;
    this.projectDir = null;
  }

  async write(entry: LogEntry): Promise<void> {
    const line = JSON.stringify(entry) + "\n";
    const filename = getLogFilename();

    const writes: Promise<void>[] = [];

    // Write to global logs
    if (this.enableGlobal) {
      const globalDir = getGlobalLogsDir();
      writes.push(this.appendToLog(join(globalDir, filename), line));
    }

    // Write to project logs
    if (this.enableProject && this.projectDir) {
      const projectLogsDir = getProjectLogsDir(this.projectDir);
      // Only write if .atlcli directory exists in project
      if (existsSync(join(this.projectDir, ".atlcli"))) {
        writes.push(this.appendToLog(join(projectLogsDir, filename), line));
      }
    }

    await Promise.all(writes);
  }

  /**
   * Append a line to a log file, creating the directory if needed.
   */
  private async appendToLog(path: string, line: string): Promise<void> {
    try {
      const dir = join(path, "..");
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await appendFile(path, line);
    } catch {
      // Silently ignore write errors to avoid disrupting CLI operations
    }
  }
}

// Install the file sink as the default the moment this Node entry is loaded,
// so `getLogger()` / `configureLogging()` behave as they did pre-split.
Logger.setSink(new FileLogSink());

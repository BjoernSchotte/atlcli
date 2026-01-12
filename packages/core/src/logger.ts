/**
 * JSONL logging system for atlcli.
 *
 * Provides structured logging to both global (~/.atlcli/logs/) and
 * project-level (.atlcli/logs/) directories.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { redactSensitive } from "./redact.js";

// Re-export redact utilities
export { redactSensitive, isSensitiveKey } from "./redact.js";

/** Log levels in order of severity */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

/** Log entry types */
export type LogEntryType =
  | "api.request"
  | "api.response"
  | "cli.command"
  | "cli.result"
  | "sync.event"
  | "auth.change"
  | "error";

/** Base fields present in all log entries */
export interface BaseLogEntry {
  id: string;
  timestamp: string;
  level: Exclude<LogLevel, "off">;
  type: LogEntryType;
  pid: number;
  sessionId: string;
}

/** API request log data */
export interface ApiRequestData {
  requestId: string;
  method: string;
  url: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  headers: Record<string, string>;
  body?: unknown;
}

/** API response log data */
export interface ApiResponseData {
  requestId: string;
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: unknown;
  durationMs: number;
  retryCount?: number;
}

/** CLI command invocation data */
export interface CommandData {
  command: string[];
  args: string[];
  flags: Record<string, string | boolean | string[]>;
  cwd: string;
  profile?: string;
}

/** CLI command result data */
export interface ResultData {
  command: string[];
  exitCode: number;
  durationMs: number;
  result?: unknown;
}

/** Sync event data */
export interface SyncEventData {
  eventType: "pull" | "push" | "conflict" | "merge" | "move" | "create" | "delete" | "status" | "error";
  file?: string;
  pageId?: string;
  title?: string;
  message?: string;
  details?: unknown;
}

/** Auth change data */
export interface AuthChangeData {
  action: "login" | "logout" | "switch" | "init" | "delete" | "rename";
  profile?: string;
  email?: string;
  baseUrl?: string;
}

/** Error log data */
export interface ErrorData {
  code?: string;
  message: string;
  stack?: string;
  context?: {
    command?: string[];
    file?: string;
    pageId?: string;
    requestId?: string;
  };
}

/** Complete log entry types */
export type LogEntry =
  | (BaseLogEntry & { type: "api.request"; data: ApiRequestData })
  | (BaseLogEntry & { type: "api.response"; data: ApiResponseData })
  | (BaseLogEntry & { type: "cli.command"; data: CommandData })
  | (BaseLogEntry & { type: "cli.result"; data: ResultData })
  | (BaseLogEntry & { type: "sync.event"; data: SyncEventData })
  | (BaseLogEntry & { type: "auth.change"; data: AuthChangeData })
  | (BaseLogEntry & { type: "error"; data: ErrorData });

/** Logger configuration options */
export interface LoggerOptions {
  level?: LogLevel;
  enableGlobal?: boolean;
  enableProject?: boolean;
  projectDir?: string;
}

/** Numeric level values for comparison */
const LEVEL_VALUES: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

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
 * JSONL Logger singleton.
 */
export class Logger {
  private static instance: Logger | null = null;

  private level: LogLevel = "info";
  private enableGlobal = true;
  private enableProject = true;
  private projectDir: string | null = null;
  private sessionId: string;
  private disabled = false;

  private constructor() {
    this.sessionId = crypto.randomUUID();
  }

  /**
   * Get the singleton logger instance.
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Configure the logger.
   */
  static configure(options: LoggerOptions): void {
    const logger = Logger.getInstance();
    if (options.level !== undefined) {
      logger.level = options.level;
    }
    if (options.enableGlobal !== undefined) {
      logger.enableGlobal = options.enableGlobal;
    }
    if (options.enableProject !== undefined) {
      logger.enableProject = options.enableProject;
    }
    if (options.projectDir !== undefined) {
      logger.projectDir = options.projectDir;
    }
  }

  /**
   * Disable all logging (for --no-log flag).
   */
  static disable(): void {
    const logger = Logger.getInstance();
    logger.disabled = true;
  }

  /**
   * Re-enable logging.
   */
  static enable(): void {
    const logger = Logger.getInstance();
    logger.disabled = false;
  }

  /**
   * Reset the logger (for testing).
   */
  static reset(): void {
    const logger = Logger.getInstance();
    logger.level = "info";
    logger.enableGlobal = true;
    logger.enableProject = true;
    logger.projectDir = null;
    logger.disabled = false;
    logger.sessionId = crypto.randomUUID();
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Check if a log level should be written.
   */
  private shouldLog(level: Exclude<LogLevel, "off">): boolean {
    if (this.disabled || this.level === "off") {
      return false;
    }
    return LEVEL_VALUES[level] <= LEVEL_VALUES[this.level];
  }

  /**
   * Write a log entry to all configured destinations.
   */
  private async write(entry: LogEntry): Promise<void> {
    if (!this.shouldLog(entry.level)) {
      return;
    }

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

  /**
   * Create base log entry fields.
   */
  private createBase(level: Exclude<LogLevel, "off">, type: LogEntryType): BaseLogEntry {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      type,
      pid: process.pid,
      sessionId: this.sessionId,
    };
  }

  /**
   * Log an API request.
   */
  api(type: "request", data: ApiRequestData): void;
  api(type: "response", data: ApiResponseData): void;
  api(type: "request" | "response", data: ApiRequestData | ApiResponseData): void {
    if (type === "request") {
      const entry: LogEntry = {
        ...this.createBase("info", "api.request"),
        type: "api.request",
        data: redactSensitive(data as ApiRequestData),
      };
      this.write(entry);
    } else {
      const entry: LogEntry = {
        ...this.createBase("info", "api.response"),
        type: "api.response",
        data: data as ApiResponseData,
      };
      this.write(entry);
    }
  }

  /**
   * Log a CLI command invocation.
   */
  command(data: CommandData): void {
    const entry: LogEntry = {
      ...this.createBase("info", "cli.command"),
      type: "cli.command",
      data: redactSensitive(data),
    };
    this.write(entry);
  }

  /**
   * Log a CLI command result.
   */
  result(data: ResultData): void {
    const level = data.exitCode === 0 ? "info" : "error";
    const entry: LogEntry = {
      ...this.createBase(level, "cli.result"),
      type: "cli.result",
      data,
    };
    this.write(entry);
  }

  /**
   * Log a sync event.
   */
  sync(data: SyncEventData): void {
    const level = data.eventType === "error" ? "error" : "info";
    const entry: LogEntry = {
      ...this.createBase(level, "sync.event"),
      type: "sync.event",
      data,
    };
    this.write(entry);
  }

  /**
   * Log an auth change.
   */
  auth(data: AuthChangeData): void {
    const entry: LogEntry = {
      ...this.createBase("info", "auth.change"),
      type: "auth.change",
      data,
    };
    this.write(entry);
  }

  /**
   * Log an error.
   */
  error(error: Error, context?: ErrorData["context"]): void {
    const entry: LogEntry = {
      ...this.createBase("error", "error"),
      type: "error",
      data: {
        message: error.message,
        stack: error.stack,
        context,
      },
    };
    this.write(entry);
  }

  /**
   * Log an error with a code.
   */
  errorWithCode(code: string, message: string, context?: ErrorData["context"]): void {
    const entry: LogEntry = {
      ...this.createBase("error", "error"),
      type: "error",
      data: {
        code,
        message,
        context,
      },
    };
    this.write(entry);
  }
}

/**
 * Get the singleton logger instance.
 */
export function getLogger(): Logger {
  return Logger.getInstance();
}

/**
 * Configure the logger.
 */
export function configureLogging(options: LoggerOptions): void {
  Logger.configure(options);
}

/**
 * Generate a unique request ID for API call correlation.
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

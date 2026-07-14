/**
 * Structured logging core for atlcli (browser-safe).
 *
 * This module holds the isomorphic logger kernel: log levels, entry types,
 * `generateRequestId`, the `LogSink` interface, and a default console sink.
 * It has zero `node:`/`bun:` imports so it resolves for the browser target.
 *
 * The Node entry (`logger.node.ts`) installs a JSONL file sink to reproduce
 * today's CLI behavior; browsers keep the console sink.
 */

import { redactSensitive } from "./redact.js";

// Re-export redact utilities
export { redactSensitive, isSensitiveKey } from "./redact.js";

/** Log levels in order of severity */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

/** Log entry types */
export type LogEntryType =
  | "api.request"
  | "api.response"
  | "api.rate-limit"
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
  headers?: Record<string, string>;
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
  error?: string;
}

/** API rate limit log data */
export interface ApiRateLimitData {
  requestId: string;
  retryAfter: number;
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
  username?: string;
  baseUrl?: string;
  authType?: string;
  deploymentType?: "cloud" | "data-center";
  keychainUsed?: boolean;
  keychainDeleted?: boolean;
  details?: unknown;
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
  | (BaseLogEntry & { type: "api.rate-limit"; data: ApiRateLimitData })
  | (BaseLogEntry & { type: "cli.command"; data: CommandData })
  | (BaseLogEntry & { type: "cli.result"; data: ResultData })
  | (BaseLogEntry & { type: "sync.event"; data: SyncEventData })
  | (BaseLogEntry & { type: "auth.change"; data: AuthChangeData })
  | (BaseLogEntry & { type: "error"; data: ErrorData });

/**
 * A destination for log entries. The core `Logger` decides *whether* an entry
 * should be emitted (level/enabled gating); a sink decides *where* it goes.
 *
 * `configure`/`reset` are optional hooks so environment-specific sinks (e.g.
 * the Node JSONL file sink) can pick up `LoggerOptions` and reset their state.
 */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
  configure?(options: LoggerOptions): void;
  reset?(): void;
}

/** Logger configuration options */
export interface LoggerOptions {
  level?: LogLevel;
  enableGlobal?: boolean;
  enableProject?: boolean;
  projectDir?: string;
  /** Inject a custom log sink (browser: console; Node: JSONL file sink). */
  sink?: LogSink;
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
 * Default browser/isomorphic sink: writes entries at or above `minLevel`
 * (default `warn`) to the console, so extension problems surface in DevTools
 * without spamming info/debug chatter. Callers can inject a different sink.
 */
export class ConsoleLogSink implements LogSink {
  constructor(private minLevel: LogLevel = "warn") {}

  write(entry: LogEntry): void {
    if (LEVEL_VALUES[entry.level] > LEVEL_VALUES[this.minLevel]) {
      return;
    }
    const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
    // eslint-disable-next-line no-console
    console[method](`[atlcli] ${entry.type}`, entry);
  }
}

/** Process id if available (undefined in browsers). */
function currentPid(): number {
  return typeof process !== "undefined" && typeof process.pid === "number" ? process.pid : 0;
}

/**
 * JSONL Logger singleton.
 */
export class Logger {
  private static instance: Logger | null = null;

  private level: LogLevel = "info";
  private sessionId: string;
  private disabled = false;
  private sink: LogSink = new ConsoleLogSink();

  private constructor() {
    this.sessionId = generateRequestId();
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
    if (options.sink !== undefined) {
      logger.sink = options.sink;
    }
    // Forward environment-specific options (enableGlobal/enableProject/
    // projectDir) to the active sink if it understands them.
    logger.sink.configure?.(options);
  }

  /**
   * Replace the active log sink (injection point for Node/browser wiring).
   */
  static setSink(sink: LogSink): void {
    Logger.getInstance().sink = sink;
  }

  /**
   * Get the active log sink.
   */
  static getSink(): LogSink {
    return Logger.getInstance().sink;
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
   * Reset the logger (for testing). Keeps the active sink but resets its state.
   */
  static reset(): void {
    const logger = Logger.getInstance();
    logger.level = "info";
    logger.disabled = false;
    logger.sessionId = generateRequestId();
    logger.sink.reset?.();
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
   * Write a log entry to the active sink.
   */
  private write(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }
    void this.sink.write(entry);
  }

  /**
   * Create base log entry fields.
   */
  private createBase(level: Exclude<LogLevel, "off">, type: LogEntryType): BaseLogEntry {
    return {
      id: generateRequestId(),
      timestamp: new Date().toISOString(),
      level,
      type,
      pid: currentPid(),
      sessionId: this.sessionId,
    };
  }

  /**
   * Log an API request, response, or rate limit event.
   */
  api(type: "request", data: ApiRequestData): void;
  api(type: "response", data: ApiResponseData): void;
  api(type: "rate-limited", data: ApiRateLimitData): void;
  api(type: "request" | "response" | "rate-limited", data: ApiRequestData | ApiResponseData | ApiRateLimitData): void {
    if (type === "request") {
      const entry: LogEntry = {
        ...this.createBase("info", "api.request"),
        type: "api.request",
        data: redactSensitive(data as ApiRequestData),
      };
      this.write(entry);
    } else if (type === "response") {
      const entry: LogEntry = {
        ...this.createBase("info", "api.response"),
        type: "api.response",
        data: data as ApiResponseData,
      };
      this.write(entry);
    } else {
      const entry: LogEntry = {
        ...this.createBase("warn", "api.rate-limit"),
        type: "api.rate-limit",
        data: data as ApiRateLimitData,
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
 *
 * Uses `globalThis.crypto.randomUUID()` (Bun, Node >= 19, all browsers) so the
 * logger core carries no `node:crypto` dependency.
 */
export function generateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

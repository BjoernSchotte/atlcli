import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  Logger,
  getLogger,
  configureLogging,
  generateRequestId,
  ConsoleLogSink,
} from "./logger.js";
import type { LogEntry, LogSink } from "./logger.js";

/** In-memory sink that captures every entry it receives. */
class CaptureSink implements LogSink {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  reset(): void {
    this.entries = [];
  }
}

describe("logger core (browser-safe)", () => {
  let sink: CaptureSink;

  beforeEach(() => {
    Logger.reset();
    sink = new CaptureSink();
    configureLogging({ level: "debug", sink });
  });

  afterEach(() => {
    Logger.reset();
  });

  test("generateRequestId returns unique v4-shaped UUIDs", () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("injected sink captures emitted entries", () => {
    const logger = getLogger();
    logger.command({ command: ["page", "list"], args: [], flags: {}, cwd: "/tmp" });
    logger.error(new Error("boom"));

    expect(sink.entries.length).toBe(2);
    expect(sink.entries[0].type).toBe("cli.command");
    expect(sink.entries[1].type).toBe("error");
  });

  test("level gating suppresses entries below the configured level", () => {
    configureLogging({ level: "error", sink });
    const logger = getLogger();
    logger.command({ command: ["x"], args: [], flags: {}, cwd: "/tmp" }); // info
    logger.error(new Error("boom")); // error

    expect(sink.entries.map((e) => e.level)).toEqual(["error"]);
  });

  test("getSink returns the injected sink", () => {
    expect(Logger.getSink()).toBe(sink);
  });

  test("Logger.setSink swaps the active sink", () => {
    const other = new CaptureSink();
    Logger.setSink(other);
    getLogger().error(new Error("boom"));
    expect(other.entries.length).toBe(1);
    expect(sink.entries.length).toBe(0);
  });
});

describe("ConsoleLogSink", () => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  let calls: Array<{ method: string; entry: LogEntry }>;

  beforeEach(() => {
    calls = [];
    console.log = ((_msg: string, entry: LogEntry) => calls.push({ method: "log", entry })) as typeof console.log;
    console.warn = ((_msg: string, entry: LogEntry) => calls.push({ method: "warn", entry })) as typeof console.warn;
    console.error = ((_msg: string, entry: LogEntry) => calls.push({ method: "error", entry })) as typeof console.error;
  });

  afterEach(() => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });

  function entry(level: LogEntry["level"]): LogEntry {
    return {
      id: "id",
      timestamp: "t",
      level,
      type: "error",
      pid: 0,
      sessionId: "s",
      data: { message: "m" },
    } as LogEntry;
  }

  test("default minLevel is warn: info/debug are dropped", () => {
    const s = new ConsoleLogSink();
    s.write(entry("info"));
    s.write(entry("debug"));
    expect(calls.length).toBe(0);
  });

  test("warn and error pass at default level and pick the right console method", () => {
    const s = new ConsoleLogSink();
    s.write(entry("warn"));
    s.write(entry("error"));
    expect(calls.map((c) => c.method)).toEqual(["warn", "error"]);
  });

  test("custom minLevel widens what is emitted", () => {
    const s = new ConsoleLogSink("debug");
    s.write(entry("info"));
    expect(calls.map((c) => c.method)).toEqual(["log"]);
  });
});

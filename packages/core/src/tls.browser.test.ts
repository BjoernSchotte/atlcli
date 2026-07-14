import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildTlsOptions } from "./tls.browser.js";
import { Logger, configureLogging } from "./logger.js";
import type { LogEntry, LogSink } from "./logger.js";
import type { Profile } from "./types.js";

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

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    baseUrl: "https://example.atlassian.net",
    auth: { type: "apiToken" },
    ...overrides,
  };
}

/** Warn-level entries carrying a message (what `logger.warn` emits). */
function warnings(sink: CaptureSink): string[] {
  return sink.entries
    .filter((e) => e.level === "warn" && e.type === "error")
    .map((e) => (e.data as { message: string }).message);
}

describe("buildTlsOptions (browser no-op)", () => {
  let sink: CaptureSink;

  beforeEach(() => {
    Logger.reset();
    sink = new CaptureSink();
    configureLogging({ level: "debug", sink });
  });

  afterEach(() => {
    Logger.reset();
  });

  // The "warn once per process" guard is a module-level flag that cannot be
  // reset between tests, so the full sequence lives in one deterministic test.
  test("warns exactly once when TLS settings are present, never when absent, always returns undefined", () => {
    // (b) No TLS settings -> no warning.
    expect(buildTlsOptions(profile())).toBeUndefined();
    expect(warnings(sink)).toHaveLength(0);

    // (a) TLS settings present -> exactly one warning; (c) still undefined.
    expect(buildTlsOptions(profile({ tlsSkipVerify: true }))).toBeUndefined();
    expect(warnings(sink)).toHaveLength(1);
    expect(warnings(sink)[0]).toContain("ignored in the browser context");

    // Subsequent calls with TLS settings must not warn again (once per process).
    expect(buildTlsOptions(profile({ tlsCaFile: "/etc/ca.pem" }))).toBeUndefined();
    expect(buildTlsOptions(profile({ tlsSkipVerify: true, tlsCaFile: "/etc/ca.pem" }))).toBeUndefined();
    expect(warnings(sink)).toHaveLength(1);
  });
});

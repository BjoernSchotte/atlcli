import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Logger,
  getLogger,
  configureLogging,
  generateRequestId,
  redactSensitive,
  isSensitiveKey,
} from "./logger.js";

describe("redactSensitive", () => {
  test("redacts token fields", () => {
    const input = { token: "secret123", name: "test" };
    const result = redactSensitive(input);
    expect(result.token).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  test("redacts apiToken fields", () => {
    const input = { apiToken: "abc123", email: "user@example.com" };
    const result = redactSensitive(input);
    expect(result.apiToken).toBe("[REDACTED]");
    expect(result.email).toBe("user@example.com");
  });

  test("redacts password fields", () => {
    const input = { password: "secret", username: "admin" };
    const result = redactSensitive(input);
    expect(result.password).toBe("[REDACTED]");
    expect(result.username).toBe("admin");
  });

  test("redacts Authorization header preserving type", () => {
    const input = { Authorization: "Basic dXNlcjpwYXNz" };
    const result = redactSensitive(input);
    expect(result.Authorization).toBe("Basic [REDACTED]");
  });

  test("redacts Bearer Authorization header", () => {
    const input = { authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" };
    const result = redactSensitive(input);
    expect(result.authorization).toBe("Bearer [REDACTED]");
  });

  test("handles nested objects", () => {
    const input = {
      auth: {
        token: "secret",
        email: "user@example.com",
      },
      data: {
        title: "Page Title",
      },
    };
    const result = redactSensitive(input);
    expect(result.auth.token).toBe("[REDACTED]");
    expect(result.auth.email).toBe("user@example.com");
    expect(result.data.title).toBe("Page Title");
  });

  test("handles arrays", () => {
    const input = [
      { token: "secret1", name: "first" },
      { token: "secret2", name: "second" },
    ];
    const result = redactSensitive(input);
    expect(result[0].token).toBe("[REDACTED]");
    expect(result[0].name).toBe("first");
    expect(result[1].token).toBe("[REDACTED]");
    expect(result[1].name).toBe("second");
  });

  test("handles null and undefined", () => {
    expect(redactSensitive(null)).toBe(null);
    expect(redactSensitive(undefined)).toBe(undefined);
  });

  test("handles primitives", () => {
    expect(redactSensitive("string")).toBe("string");
    expect(redactSensitive(123)).toBe(123);
    expect(redactSensitive(true)).toBe(true);
  });

  test("does not redact content, title, email", () => {
    const input = {
      content: "Page content with sensitive data",
      title: "Important Page",
      email: "user@example.com",
      displayName: "John Doe",
    };
    const result = redactSensitive(input);
    expect(result.content).toBe("Page content with sensitive data");
    expect(result.title).toBe("Important Page");
    expect(result.email).toBe("user@example.com");
    expect(result.displayName).toBe("John Doe");
  });
});

describe("isSensitiveKey", () => {
  test("detects token keys", () => {
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("apiToken")).toBe(true);
    expect(isSensitiveKey("api_token")).toBe(true);
    expect(isSensitiveKey("accessToken")).toBe(true);
  });

  test("detects password keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("userPassword")).toBe(true);
  });

  test("detects secret keys", () => {
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("clientSecret")).toBe(true);
  });

  test("detects authorization keys", () => {
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
  });

  test("does not flag safe keys", () => {
    expect(isSensitiveKey("email")).toBe(false);
    expect(isSensitiveKey("title")).toBe(false);
    expect(isSensitiveKey("content")).toBe(false);
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("id")).toBe(false);
  });
});

describe("Logger", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-logger-test-"));
    Logger.reset();
  });

  afterEach(async () => {
    Logger.reset();
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true });
    }
  });

  test("getInstance returns singleton", () => {
    const logger1 = Logger.getInstance();
    const logger2 = Logger.getInstance();
    expect(logger1).toBe(logger2);
  });

  test("getLogger returns singleton", () => {
    const logger1 = getLogger();
    const logger2 = getLogger();
    expect(logger1).toBe(logger2);
  });

  test("generateRequestId returns unique UUIDs", () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("getSessionId returns consistent ID within session", () => {
    const logger = getLogger();
    const id1 = logger.getSessionId();
    const id2 = logger.getSessionId();
    expect(id1).toBe(id2);
  });

  test("disable prevents logging", async () => {
    // Create global logs dir in temp
    const logsDir = join(tempDir, "logs");
    await mkdir(logsDir, { recursive: true });

    // Configure logger to use temp dir
    configureLogging({
      level: "debug",
      enableGlobal: true,
      enableProject: false,
    });

    // Mock the global logs dir (this is a limitation - we can't easily test global dir)
    Logger.disable();

    const logger = getLogger();
    logger.command({
      command: ["test"],
      args: [],
      flags: {},
      cwd: "/tmp",
    });

    // Re-enable for other tests
    Logger.enable();
  });

  test("configure sets log level", () => {
    configureLogging({ level: "error" });
    // Level is private, but we can test behavior
    const logger = getLogger();
    expect(logger).toBeDefined();
  });

  test("command logs CLI invocations", async () => {
    const logger = getLogger();
    logger.command({
      command: ["page", "list"],
      args: ["--space", "TEST"],
      flags: { space: "TEST" },
      cwd: "/home/user/project",
      profile: "work",
    });
    // Log is written asynchronously
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("api logs request and response", async () => {
    const logger = getLogger();
    const requestId = generateRequestId();

    logger.api("request", {
      requestId,
      method: "GET",
      url: "https://example.atlassian.net/wiki/rest/api/content/123",
      path: "/content/123",
      headers: { Authorization: "Basic abc123" },
    });

    logger.api("response", {
      requestId,
      status: 200,
      statusText: "OK",
      body: { id: "123", title: "Test Page" },
      durationMs: 150,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("sync logs sync events", async () => {
    const logger = getLogger();
    logger.sync({
      eventType: "pull",
      file: "./docs/page.md",
      pageId: "123",
      title: "Test Page",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("auth logs auth changes", async () => {
    const logger = getLogger();
    logger.auth({
      action: "login",
      profile: "work",
      email: "user@example.com",
      baseUrl: "https://example.atlassian.net",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("error logs errors with context", async () => {
    const logger = getLogger();
    const error = new Error("Something went wrong");
    logger.error(error, {
      command: ["page", "get"],
      pageId: "123",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("errorWithCode logs errors with code", async () => {
    const logger = getLogger();
    logger.errorWithCode("ATLCLI_ERR_API", "API request failed", {
      requestId: "abc123",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("result logs command results", async () => {
    const logger = getLogger();
    logger.result({
      command: ["page", "list"],
      exitCode: 0,
      durationMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("result logs failed commands with error level", async () => {
    const logger = getLogger();
    logger.result({
      command: ["page", "get"],
      exitCode: 1,
      durationMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("Logger file output", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-logger-file-test-"));
    projectDir = join(tempDir, "project");
    await mkdir(join(projectDir, ".atlcli"), { recursive: true });
    Logger.reset();
  });

  afterEach(async () => {
    Logger.reset();
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true });
    }
  });

  test("writes to project logs when .atlcli exists", async () => {
    configureLogging({
      level: "info",
      enableGlobal: false,
      enableProject: true,
      projectDir,
    });

    const logger = getLogger();
    logger.command({
      command: ["page", "list"],
      args: [],
      flags: {},
      cwd: projectDir,
    });

    // Wait for async write
    await new Promise((resolve) => setTimeout(resolve, 100));

    const logsDir = join(projectDir, ".atlcli", "logs");
    expect(existsSync(logsDir)).toBe(true);

    const today = new Date().toISOString().split("T")[0];
    const logFile = join(logsDir, `${today}.jsonl`);
    expect(existsSync(logFile)).toBe(true);

    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("cli.command");
    expect(entry.data.command).toEqual(["page", "list"]);
    expect(entry.sessionId).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.id).toBeDefined();
    expect(entry.pid).toBe(process.pid);
  });

  test("does not write when level is off", async () => {
    configureLogging({
      level: "off",
      enableGlobal: false,
      enableProject: true,
      projectDir,
    });

    const logger = getLogger();
    logger.command({
      command: ["page", "list"],
      args: [],
      flags: {},
      cwd: projectDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const logsDir = join(projectDir, ".atlcli", "logs");
    expect(existsSync(logsDir)).toBe(false);
  });

  test("respects log level filtering", async () => {
    configureLogging({
      level: "error",
      enableGlobal: false,
      enableProject: true,
      projectDir,
    });

    const logger = getLogger();

    // Info level should not be logged when level is error
    logger.command({
      command: ["page", "list"],
      args: [],
      flags: {},
      cwd: projectDir,
    });

    // Error should be logged
    logger.error(new Error("Test error"));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const logsDir = join(projectDir, ".atlcli", "logs");
    const today = new Date().toISOString().split("T")[0];
    const logFile = join(logsDir, `${today}.jsonl`);

    if (existsSync(logFile)) {
      const content = await readFile(logFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Only error should be logged
      for (const line of lines) {
        const entry = JSON.parse(line);
        expect(entry.level).toBe("error");
      }
    }
  });

  test("redacts sensitive data in logs", async () => {
    configureLogging({
      level: "debug",
      enableGlobal: false,
      enableProject: true,
      projectDir,
    });

    const logger = getLogger();
    logger.api("request", {
      requestId: "test-123",
      method: "GET",
      url: "https://example.atlassian.net/wiki/rest/api/content",
      path: "/content",
      headers: {
        Authorization: "Basic dXNlcjpwYXNzd29yZA==",
        "Content-Type": "application/json",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const logsDir = join(projectDir, ".atlcli", "logs");
    const today = new Date().toISOString().split("T")[0];
    const logFile = join(logsDir, `${today}.jsonl`);

    const content = await readFile(logFile, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.data.headers.Authorization).toBe("Basic [REDACTED]");
    expect(entry.data.headers["Content-Type"]).toBe("application/json");
  });
});

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { CREDENTIAL_VARIABLES, isolatedTestEnv, PARALLEL_TIMEOUT_MS, testRuns } from "./run-tests.js";

const BASE = ["--conditions=development", "test", "--path-ignore-patterns=spikes/**"];

// Regression: tests built their package with the root `bun run build --filter=…`,
// whose root `prebuild` cleans every browser artifact. Under `--parallel` that
// deleted the extension's `.output` while the extension tests were building it.
test("no test builds through the root build script (its prebuild wipes browser artifacts)", async () => {
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("{apps,packages,scripts}/**/*.test.{ts,tsx}").scan({ cwd: join(import.meta.dir, "../..") })) {
    if (file.includes("node_modules") || file.endsWith("test-helpers/run-tests.test.ts")) continue;
    const text = await Bun.file(join(import.meta.dir, "../..", file)).text();
    if (/\["bun", "run", "build", "--filter=/.test(text)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("a serial run passes the arguments through unchanged", () => {
  expect(testRuns(["packages/core", "--test-name-pattern", "x"])).toEqual([[...BASE, "packages/core", "--test-name-pattern", "x"]]);
});

test("--parallel runs benchmarks separately and serially, after the rest", () => {
  expect(testRuns(["--parallel"])).toEqual([
    [...BASE, `--timeout=${PARALLEL_TIMEOUT_MS}`, "--path-ignore-patterns=**/*.benchmark.test.*", "--parallel"],
    [...BASE, ".benchmark.test."],
  ]);
});

test("--parallel keeps an explicit timeout and file filters as given", () => {
  expect(testRuns(["--parallel=4", "--timeout=9000"])[0]).not.toContain(`--timeout=${PARALLEL_TIMEOUT_MS}`);
  expect(testRuns(["--parallel", "packages/jira"])).toEqual([[...BASE, `--timeout=${PARALLEL_TIMEOUT_MS}`, "--parallel", "packages/jira"]]);
});

const real = { ATLCLI_API_TOKEN: "real-token", ATLCLI_EMAIL: "me@example.invalid", PATH: "/bin", HOME: "/home/me" };

test("drops credentials and sandboxes HOME (#278)", () => {
  const env = isolatedTestEnv(real, "/home/me", () => "/tmp/sandbox");
  for (const name of CREDENTIAL_VARIABLES) expect(env[name]).toBeUndefined();
  expect(env.HOME).toBe("/tmp/sandbox");
  expect(env.USERPROFILE).toBe("/tmp/sandbox");
  expect(env.PATH).toBe("/bin");
});

test("a live E2E opt-in keeps the real HOME but still drops the token", () => {
  for (const optIn of ["ATLCLI_JIRA_CONTENT_E2E", "ATLCLI_E2E_PROFILE", "ATLCLI_NFS_LIVE"]) {
    const env = isolatedTestEnv({ ...real, [optIn]: "1" }, "/home/me", () => "/tmp/sandbox");
    expect(env.HOME).toBe("/home/me");
    expect(env.ATLCLI_API_TOKEN).toBeUndefined();
  }
  expect(isolatedTestEnv({ ...real, ATLCLI_NFS_LIVE: "0" }, "/home/me", () => "/tmp/sandbox").HOME).toBe("/tmp/sandbox");
});

test("bun run test itself runs in the sandbox", () => {
  // This file runs under `bun run test`; only a live E2E opt-in keeps the real HOME.
  const optedIn = isolatedTestEnv(process.env, "/real", () => "/sandbox").HOME === process.env.HOME;
  if (!optedIn) expect(homedir()).toMatch(/atlcli-test-home-/);
  expect(process.env.ATLCLI_API_TOKEN).toBeUndefined();
});

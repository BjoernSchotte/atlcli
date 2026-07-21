/**
 * Regression: `jira worklog timer stop` used to destroy tracked time.
 *
 * `stopTimer()` deleted `~/.atlcli/timer.json` *before* the caller had done any
 * of the four things that can fail — parsing `--round`, looking the profile up,
 * the session-auth guard, and the `addWorklog` POST (which had no try/catch at
 * all). Any of them losing meant the elapsed time was gone with no worklog
 * created and no way to recover it.
 *
 * The timer is now only cleared once Jira has confirmed the worklog. These tests
 * force a failure *past* the point where the old code had already cleared the
 * state and assert the timer file is still there with its original `startedAt`.
 *
 * Everything runs through the real CLI in its own process (the handlers call
 * `process.exit`, and the timer path is derived from `homedir()` at call time),
 * against a real local Bun HTTP server — no fetch mocking, per repo rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const ISSUE = "ATLCLI-1";
const PROFILE = "mayflower";

/** 90 minutes of tracked work, fixed so assertions are deterministic. */
const STARTED_AT = new Date(Date.now() - 90 * 60 * 1000).toISOString();

/** Flipped per test to make the worklog POST succeed or fail. */
let worklogMode: "ok" | "server-error" = "ok";
/** Every worklog POST the CLI actually made. */
let worklogPosts: Array<{ path: string; body: unknown }> = [];

let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      // Non-cloud base URL ⇒ the client talks v2.
      if (req.method === "POST" && pathname === `/rest/api/2/issue/${ISSUE}/worklog`) {
        const body = await req.json();
        worklogPosts.push({ path: pathname, body });
        if (worklogMode === "server-error") {
          return new Response(JSON.stringify({ errorMessages: ["Internal server error"] }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return Response.json({
          id: "10001",
          issueId: "10000",
          author: { accountId: "acc-1", displayName: "Fixture Author" },
          timeSpent: "1h 30m",
          timeSpentSeconds: (body as { timeSpentSeconds: number }).timeSpentSeconds,
          started: (body as { started?: string }).started,
          created: "2026-07-21T00:00:00.000+0000",
          updated: "2026-07-21T00:00:00.000+0000",
        });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-timer-stop-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify(
      {
        currentProfile: PROFILE,
        profiles: {
          // Deliberately NOT named "default": the second half of the bug was
          // `timer start` recording the literal string "default", so on a
          // machine like this one every stop failed the profile lookup.
          [PROFILE]: {
            name: PROFILE,
            baseUrl: server.url.origin,
            deploymentType: "data-center",
            auth: { type: "bearer" },
          },
        },
      },
      null,
      2
    )
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  worklogMode = "ok";
  worklogPosts = [];
});

const timerPath = () => join(home, ".atlcli", "timer.json");

async function seedTimer(profile: string = PROFILE): Promise<void> {
  await writeFile(
    timerPath(),
    JSON.stringify({ issueKey: ISSUE, startedAt: STARTED_AT, profile }, null, 2)
  );
}

async function readTimer(): Promise<{ issueKey: string; startedAt: string; profile: string } | null> {
  if (!existsSync(timerPath())) return null;
  return JSON.parse(await readFile(timerPath(), "utf-8"));
}

async function runCli(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      // Workspace packages only resolve to src/ under this condition.
      "--conditions=development",
      "run",
      CLI,
      ...args,
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ATLCLI_API_TOKEN: "stub-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("jira worklog timer stop: tracked time survives every losing path", () => {
  it("keeps the timer when --round cannot be parsed", async () => {
    await seedTimer();

    const { stdout, exitCode } = await runCli([
      "jira",
      "worklog",
      "timer",
      "stop",
      "--round",
      "garbage",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    // The old code had already deleted the timer by the time --round was parsed.
    const timer = await readTimer();
    expect(timer).not.toBeNull();
    expect(timer!.startedAt).toBe(STARTED_AT);
    expect(timer!.issueKey).toBe(ISSUE);
    // Nothing was sent to Jira either.
    expect(worklogPosts).toEqual([]);

    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_USAGE");
    expect(parsed.error.details.timerPreserved).toBe(true);
    expect(parsed.error.message).toMatch(/still running/i);
  }, 30_000);

  it("keeps the timer when the recorded profile does not exist", async () => {
    // Exactly the state `timer start` used to write on a machine whose only
    // profile is `mayflower`: the literal string "default".
    await seedTimer("default");

    const { stdout, exitCode } = await runCli(["jira", "worklog", "timer", "stop", "--json"]);

    expect(exitCode).not.toBe(0);
    const timer = await readTimer();
    expect(timer).not.toBeNull();
    expect(timer!.startedAt).toBe(STARTED_AT);
    expect(worklogPosts).toEqual([]);

    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_AUTH");
    expect(parsed.error.details.timerPreserved).toBe(true);
  }, 30_000);

  it("keeps the timer when Jira rejects the worklog with a 500", async () => {
    await seedTimer();
    worklogMode = "server-error";

    const { stdout, exitCode } = await runCli(["jira", "worklog", "timer", "stop", "--json"]);

    expect(exitCode).not.toBe(0);
    // The important one: the POST was attempted and failed, and the elapsed
    // time is still recoverable.
    expect(worklogPosts.length).toBeGreaterThan(0);
    const timer = await readTimer();
    expect(timer).not.toBeNull();
    expect(timer!.startedAt).toBe(STARTED_AT);
    expect(timer!.issueKey).toBe(ISSUE);

    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_API");
    expect(parsed.error.details.timerPreserved).toBe(true);
    expect(parsed.error.details.startedAt).toBe(STARTED_AT);
  }, 60_000);

  it("retrying after the failure still logs the full original elapsed time", async () => {
    await seedTimer();
    worklogMode = "server-error";
    await runCli(["jira", "worklog", "timer", "stop", "--json"]);

    worklogMode = "ok";
    worklogPosts = [];
    const { stdout, exitCode } = await runCli(["jira", "worklog", "timer", "stop", "--json"]);

    expect(exitCode).toBe(0);
    expect(worklogPosts).toHaveLength(1);
    const body = worklogPosts[0]!.body as { timeSpentSeconds: number; started: string };
    // ~90 minutes, measured from the ORIGINAL start — not lost, not restarted.
    expect(body.timeSpentSeconds).toBeGreaterThanOrEqual(90 * 60);
    expect(body.timeSpentSeconds).toBeLessThan(95 * 60);
    expect(body.started).toBe(STARTED_AT.replace("Z", "+0000"));
    // Only now is the timer gone.
    expect(await readTimer()).toBeNull();
    expect(JSON.parse(stdout).worklog.id).toBe("10001");
  }, 60_000);

  it("clears the timer on a successful stop", async () => {
    await seedTimer();

    const { exitCode } = await runCli(["jira", "worklog", "timer", "stop", "--json"]);

    expect(exitCode).toBe(0);
    expect(worklogPosts).toHaveLength(1);
    expect(await readTimer()).toBeNull();
  }, 30_000);
});

describe("jira worklog timer profile handling", () => {
  it("records the resolved active profile at start, not the literal \"default\"", async () => {
    await rm(timerPath(), { force: true });

    const { stdout, exitCode } = await runCli([
      "jira",
      "worklog",
      "timer",
      "start",
      ISSUE,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).timer.profile).toBe(PROFILE);
    const timer = await readTimer();
    expect(timer!.profile).toBe(PROFILE);

    // …and the timer it wrote can actually be stopped.
    const stop = await runCli(["jira", "worklog", "timer", "stop", "--json"]);
    expect(stop.exitCode).toBe(0);
    expect(await readTimer()).toBeNull();
  }, 60_000);

  it("lets an explicit --profile at stop override a wrong recorded profile", async () => {
    // The documented escape hatch: timerHelp advertises --profile for the whole
    // timer group, but handleTimerStop never read it.
    await seedTimer("stale-profile-name");

    const { exitCode } = await runCli([
      "jira",
      "worklog",
      "timer",
      "stop",
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(worklogPosts).toHaveLength(1);
    expect(await readTimer()).toBeNull();
  }, 30_000);

  it("rejects an unknown --profile at start instead of recording it", async () => {
    await rm(timerPath(), { force: true });

    const { stdout, exitCode } = await runCli([
      "jira",
      "worklog",
      "timer",
      "start",
      ISSUE,
      "--profile",
      "does-not-exist",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_AUTH");
    expect(await readTimer()).toBeNull();
  }, 30_000);
});

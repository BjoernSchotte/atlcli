/**
 * Regression: `jira template` wrote to the wrong storage level and then could
 * not find the template again.
 *
 * `--profile` is the *global auth-profile* flag, and the storage-level selector
 * tested it before the `project` branch and before an explicit `--level`. So
 * `--level project --project ATLCLI --profile mayflower` stored under
 * `profiles/mayflower/`, reported `level: "profile:mayflower"`, and a
 * subsequent `delete --level project --project ATLCLI` reported
 * "not found at project:ATLCLI" — the template was stranded. Anyone using more
 * than one auth profile, i.e. the normal case, silently got the wrong storage.
 * `template list` had the same overload: the `--profile`/`--project` branches
 * overwrote the `filter.level` that `--level` had just set.
 *
 * The rule now, applied to save, import, delete and list alike: an explicit
 * `--level` always wins, then `--project`, then `--profile`, then global; an
 * unknown `--level` is rejected instead of silently falling through.
 *
 * Round trips run through the real CLI against a real local Bun HTTP server
 * (no fetch mocking) with a sandboxed HOME and ATLCLI_TEMPLATES_DIR.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const ISSUE = "ATLCLI-1";
const PROFILE = "mayflower";
const PROJECT = "ATLCLI";

const ISSUE_JSON = {
  id: "10000",
  key: ISSUE,
  self: "http://localhost/rest/api/2/issue/10000",
  fields: {
    summary: "Fixture issue for template storage",
    issuetype: { id: "10001", name: "Task" },
    project: { id: "10100", key: PROJECT, name: "atlcli" },
    labels: ["fixture"],
  },
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let templatesDir: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === `/rest/api/2/issue/${ISSUE}`) return Response.json(ISSUE_JSON);
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-template-level-"));
  templatesDir = join(home, "templates");
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify(
      {
        currentProfile: PROFILE,
        profiles: {
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

beforeEach(async () => {
  await rm(templatesDir, { recursive: true, force: true });
});

async function runCli(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number; json: unknown }> {
  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, ...args],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ATLCLI_TEMPLATES_DIR: templatesDir,
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
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { stdout, stderr, exitCode, json };
}

const projectFile = (name: string) =>
  join(templatesDir, "jira", "projects", PROJECT, `${name}.json`);
const profileFile = (name: string) =>
  join(templatesDir, "jira", "profiles", PROFILE, `${name}.json`);
const globalFile = (name: string) => join(templatesDir, "jira", "global", `${name}.json`);

describe("jira template: --level wins over the auth --profile flag", () => {
  it("saves at project level and finds it again with the SAME flags", async () => {
    const save = await runCli([
      "jira",
      "template",
      "save",
      "round-trip",
      "--issue",
      ISSUE,
      "--level",
      "project",
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(save.exitCode, save.stderr).toBe(0);
    // Used to report "profile:mayflower" and write into profiles/mayflower/.
    expect((save.json as { level: string }).level).toBe(`project:${PROJECT}`);
    expect(existsSync(projectFile("round-trip"))).toBe(true);
    expect(existsSync(profileFile("round-trip"))).toBe(false);

    // The round trip: same flag combination must find it.
    const del = await runCli([
      "jira",
      "template",
      "delete",
      "round-trip",
      "--level",
      "project",
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--confirm",
      "--json",
    ]);

    expect(del.exitCode, del.stdout + del.stderr).toBe(0);
    expect((del.json as { deleted: string; level: string })).toMatchObject({
      deleted: "round-trip",
      level: `project:${PROJECT}`,
    });
    expect(existsSync(projectFile("round-trip"))).toBe(false);
  }, 60_000);

  it("saves at global level even when an auth --profile is passed", async () => {
    const save = await runCli([
      "jira",
      "template",
      "save",
      "global-tpl",
      "--issue",
      ISSUE,
      "--level",
      "global",
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(save.exitCode, save.stderr).toBe(0);
    expect((save.json as { level: string }).level).toBe("global");
    expect(existsSync(globalFile("global-tpl"))).toBe(true);
    expect(existsSync(profileFile("global-tpl"))).toBe(false);
  }, 60_000);

  it("still honours --profile as a storage selector when no --level is given", async () => {
    const save = await runCli([
      "jira",
      "template",
      "save",
      "profile-tpl",
      "--issue",
      ISSUE,
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(save.exitCode, save.stderr).toBe(0);
    expect((save.json as { level: string }).level).toBe(`profile:${PROFILE}`);
    expect(existsSync(profileFile("profile-tpl"))).toBe(true);
  }, 60_000);

  it("prefers the explicit --project over the auth --profile when no --level is given", async () => {
    const save = await runCli([
      "jira",
      "template",
      "save",
      "implicit-project",
      "--issue",
      ISSUE,
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(save.exitCode, save.stderr).toBe(0);
    expect((save.json as { level: string }).level).toBe(`project:${PROJECT}`);
    expect(existsSync(projectFile("implicit-project"))).toBe(true);
    expect(existsSync(profileFile("implicit-project"))).toBe(false);
  }, 60_000);

  it("round-trips an import at project level with an auth --profile present", async () => {
    const file = join(home, "imported.json");
    await writeFile(
      file,
      JSON.stringify({
        name: "imported-tpl",
        createdAt: "2026-07-21T00:00:00.000Z",
        fields: { issuetype: { name: "Task" }, summary: "Imported" },
      })
    );

    const imported = await runCli([
      "jira",
      "template",
      "import",
      "--file",
      file,
      "--level",
      "project",
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--json",
    ]);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect((imported.json as { level: string }).level).toBe(`project:${PROJECT}`);
    expect(existsSync(projectFile("imported-tpl"))).toBe(true);

    const del = await runCli([
      "jira",
      "template",
      "delete",
      "imported-tpl",
      "--level",
      "project",
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--confirm",
      "--json",
    ]);
    expect(del.exitCode, del.stdout + del.stderr).toBe(0);
  }, 60_000);

  it("rejects an unknown --level instead of silently picking another one", async () => {
    const save = await runCli([
      "jira",
      "template",
      "save",
      "bogus-level",
      "--issue",
      ISSUE,
      "--level",
      "nonsense",
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(save.exitCode).not.toBe(0);
    expect((save.json as { error: { code: string; message: string } }).error.code).toBe(
      "ATLCLI_ERR_USAGE"
    );
    expect((save.json as { error: { message: string } }).error.message).toMatch(
      /Unknown --level "nonsense"/
    );
    expect(existsSync(profileFile("bogus-level"))).toBe(false);
    expect(existsSync(globalFile("bogus-level"))).toBe(false);
  }, 60_000);
});

describe("jira template list: --level is not overwritten by --profile/--project", () => {
  /** Save one template at each level so the filters have something to choose. */
  async function seedAllLevels(): Promise<void> {
    await runCli(["jira", "template", "save", "g-tpl", "--issue", ISSUE, "--level", "global", "--json"]);
    await runCli([
      "jira", "template", "save", "p-tpl", "--issue", ISSUE,
      "--level", "profile", "--profile", PROFILE, "--json",
    ]);
    await runCli([
      "jira", "template", "save", "j-tpl", "--issue", ISSUE,
      "--level", "project", "--project", PROJECT, "--json",
    ]);
  }

  const names = (json: unknown) =>
    (json as { templates: Array<{ name: string; level: string }> }).templates
      .map((t) => t.name)
      .sort();

  it("--level global --profile <name> lists global templates, not profile ones", async () => {
    await seedAllLevels();

    const list = await runCli([
      "jira",
      "template",
      "list",
      "--level",
      "global",
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(list.exitCode, list.stderr).toBe(0);
    // Used to return the profile template because --profile overwrote the level.
    expect(names(list.json)).toEqual(["g-tpl"]);
  }, 90_000);

  it("--level project --profile <name> lists project templates", async () => {
    await seedAllLevels();

    const list = await runCli([
      "jira",
      "template",
      "list",
      "--level",
      "project",
      "--project",
      PROJECT,
      "--profile",
      PROFILE,
      "--json",
    ]);

    expect(list.exitCode, list.stderr).toBe(0);
    expect(names(list.json)).toEqual(["j-tpl"]);
  }, 90_000);

  it("rejects an unknown --level when listing", async () => {
    const list = await runCli(["jira", "template", "list", "--level", "nonsense", "--json"]);

    expect(list.exitCode).not.toBe(0);
    expect((list.json as { error: { code: string } }).error.code).toBe("ATLCLI_ERR_USAGE");
  }, 30_000);
});

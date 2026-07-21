/**
 * Regression tests for `wiki template` level selection and `validate` exit codes.
 *
 * The defect these pin down: `--level` documented `global|profile|space` but
 * only `global` was handled, so `--level profile` fell through to precedence
 * resolution and operated on whatever level happened to win. Concretely,
 * `template delete dup --level profile --force` deleted the *space* copy and
 * left the profile copy in place, while reporting success.
 *
 * Every fixture therefore puts the SAME template name at two or three levels.
 * A single-level fixture passes against the buggy code and proves nothing:
 * with one copy, precedence resolution and level selection agree by accident.
 *
 * Everything runs against a sandboxed HOME and ATLCLI_TEMPLATES_DIR; no
 * network, no real ~/.atlcli.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "index.ts");

const PROFILE_NAME = "work";
const SPACE_KEY = "DOCSY";

let root: string;
let home: string;
let workDir: string;
let templatesDir: string;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(
    // `--conditions=development` keeps in-repo `@atlcli/*` resolution on live
    // src/ (spec 009); without it this would exercise stale dist/ output.
    [process.execPath, "--conditions=development", "run", CLI, ...args],
    {
      cwd: workDir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ATLCLI_TEMPLATES_DIR: templatesDir,
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function templatePath(level: "global" | "profile" | "space", name: string): string {
  if (level === "global") return join(templatesDir, "global", `${name}.md`);
  if (level === "profile") return join(templatesDir, "profiles", PROFILE_NAME, `${name}.md`);
  return join(templatesDir, "spaces", SPACE_KEY, `${name}.md`);
}

async function writeTemplate(
  level: "global" | "profile" | "space",
  name: string,
  body = `body at ${level}`,
): Promise<void> {
  const path = templatePath(level, name);
  await writeFile(path, `---\nname: ${name}\ndescription: ${level} copy\n---\n${body}\n`, "utf8");
}

/** The two-level fixture the wrong-target deletion needs: one name, three homes. */
async function writeAllLevels(name: string): Promise<void> {
  await writeTemplate("global", name);
  await writeTemplate("profile", name);
  await writeTemplate("space", name);
}

/** Config with an active profile and a default space, so every level has context. */
async function writeConfig(config: unknown): Promise<void> {
  await writeFile(join(home, ".atlcli", "config.json"), JSON.stringify(config, null, 2), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atlcli-template-level-"));
  home = join(root, "home");
  // The working directory sits outside HOME so no stray `.atlcli` above it can
  // turn into a docs-folder space storage.
  workDir = join(root, "work");
  templatesDir = join(root, "templates");

  await mkdir(join(home, ".atlcli"), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(join(templatesDir, "global"), { recursive: true });
  await mkdir(join(templatesDir, "profiles", PROFILE_NAME), { recursive: true });
  await mkdir(join(templatesDir, "spaces", SPACE_KEY), { recursive: true });

  await writeConfig({
    currentProfile: PROFILE_NAME,
    profiles: {
      [PROFILE_NAME]: {
        name: PROFILE_NAME,
        baseUrl: "https://example.atlassian.net",
        auth: { type: "token" },
      },
    },
    global: { space: SPACE_KEY },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("wiki template --level targets the level that was asked for", () => {
  test("delete --level profile removes the profile copy and leaves the others", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "delete", "dup", "--level", "profile", "--force");

    expect(res.exitCode).toBe(0);
    // The reported target is part of the fix: "Deleted template 'dup'." gave no
    // way to notice it had removed the wrong file.
    expect(res.stdout).toContain("profile:work");
    expect(existsSync(templatePath("profile", "dup"))).toBe(false);
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
    expect(existsSync(templatePath("global", "dup"))).toBe(true);
  }, 30_000);

  test("delete --level space removes the space copy and leaves the others", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "delete", "dup", "--level", "space", "--force");

    expect(res.exitCode).toBe(0);
    expect(existsSync(templatePath("space", "dup"))).toBe(false);
    expect(existsSync(templatePath("profile", "dup"))).toBe(true);
    expect(existsSync(templatePath("global", "dup"))).toBe(true);
  }, 30_000);

  test("delete --level global removes the global copy and leaves the others", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "delete", "dup", "--level", "global", "--force");

    expect(res.exitCode).toBe(0);
    expect(existsSync(templatePath("global", "dup"))).toBe(false);
    expect(existsSync(templatePath("profile", "dup"))).toBe(true);
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
  }, 30_000);

  test("show --level profile shows the profile copy even though space shadows it", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "show", "dup", "--level", "profile");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("body at profile");
    expect(res.stdout).not.toContain("body at space");
  }, 30_000);

  test("render --level global renders the global copy, not the shadowing space copy", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "render", "dup", "--level", "global");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("body at global");
    expect(res.stdout).not.toContain("body at space");
  }, 30_000);

  test("export --level profile exports the profile copy, not the shadowing space copy", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "export", "dup", "--level", "profile");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("body at profile");
    expect(res.stdout).not.toContain("body at space");
  }, 30_000);

  test("rename --level profile renames only the profile copy", async () => {
    await writeAllLevels("dup");

    const res = await runCli(
      "wiki",
      "template",
      "rename",
      "dup",
      "renamed",
      "--level",
      "profile",
    );

    expect(res.exitCode).toBe(0);
    expect(existsSync(templatePath("profile", "renamed"))).toBe(true);
    expect(existsSync(templatePath("profile", "dup"))).toBe(false);
    // The other levels keep their original name and content.
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
    expect(existsSync(templatePath("space", "renamed"))).toBe(false);
    expect(existsSync(templatePath("global", "dup"))).toBe(true);

    const renamed = await readFile(templatePath("profile", "renamed"), "utf8");
    expect(renamed).toContain("body at profile");
  }, 30_000);

  test("create --level profile writes to the profile level, not the default space", async () => {
    const source = join(workDir, "source.md");
    await writeFile(source, "---\nname: fresh\n---\nfresh body\n", "utf8");

    const res = await runCli(
      "wiki",
      "template",
      "create",
      "fresh",
      "--level",
      "profile",
      "--file",
      source,
    );

    expect(res.exitCode).toBe(0);
    expect(existsSync(templatePath("profile", "fresh"))).toBe(true);
    expect(existsSync(templatePath("space", "fresh"))).toBe(false);
    expect(existsSync(templatePath("global", "fresh"))).toBe(false);
  }, 30_000);

  test("list --level profile lists the profile copy, not the shadowing space copy", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "list", "--level", "profile");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("[profile:work]");
    expect(res.stdout).not.toContain("[space:DOCSY]");
  }, 30_000);

  test("a named level that is missing the template fails instead of falling back", async () => {
    // Only the space level has it; asking for the profile level must not
    // quietly hand back the space copy.
    await writeTemplate("space", "dup");

    const res = await runCli("wiki", "template", "show", "dup", "--level", "profile");

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not found at profile:work");
    expect(res.stdout).not.toContain("body at space");
  }, 30_000);
});

describe("wiki template level selection fails loudly instead of guessing", () => {
  test("--level profile without any profile context is a usage error", async () => {
    await writeConfig({ profiles: {} });
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "delete", "dup", "--level", "profile", "--force");

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("No profile context");
    // Nothing was deleted anywhere.
    expect(existsSync(templatePath("global", "dup"))).toBe(true);
    expect(existsSync(templatePath("profile", "dup"))).toBe(true);
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
  }, 30_000);

  test("--level space without any space context is a usage error", async () => {
    await writeConfig({ profiles: {} });
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "delete", "dup", "--level", "space", "--force");

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("No space context");
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
  }, 30_000);

  test("--level global with --profile is rejected as contradictory", async () => {
    await writeAllLevels("dup");

    const res = await runCli(
      "wiki",
      "template",
      "delete",
      "dup",
      "--level",
      "global",
      "--profile",
      PROFILE_NAME,
      "--force",
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("conflicts with --profile");
    expect(existsSync(templatePath("global", "dup"))).toBe(true);
  }, 30_000);

  test("--level space with --profile is rejected as contradictory", async () => {
    await writeAllLevels("dup");

    const res = await runCli(
      "wiki",
      "template",
      "show",
      "dup",
      "--level",
      "space",
      "--profile",
      PROFILE_NAME,
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("conflicts with --profile");
  }, 30_000);

  test("--profile together with --space is rejected as contradictory", async () => {
    await writeAllLevels("dup");

    const res = await runCli(
      "wiki",
      "template",
      "show",
      "dup",
      "--profile",
      PROFILE_NAME,
      "--space",
      SPACE_KEY,
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("name different levels");
  }, 30_000);

  test("an unknown --level value is rejected", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "show", "dup", "--level", "profiles");

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid --level 'profiles'");
  }, 30_000);

  test("a valueless --profile is rejected instead of silently meaning 'no level'", async () => {
    await writeAllLevels("dup");

    // `--profile` with nothing after it used to read back as undefined, i.e.
    // "resolve by precedence" — another way to delete the wrong file.
    const res = await runCli("wiki", "template", "delete", "dup", "--force", "--profile");

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--profile requires a value");
    expect(existsSync(templatePath("space", "dup"))).toBe(true);
    expect(existsSync(templatePath("profile", "dup"))).toBe(true);
  }, 30_000);

  test("no level flags still resolves by precedence (space wins)", async () => {
    await writeAllLevels("dup");

    const res = await runCli("wiki", "template", "show", "dup");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("body at space");
  }, 30_000);
});

describe("wiki template validate is usable as a CI gate", () => {
  const INVALID = "---\nname: broken\n---\n{{#if x}}\nunclosed block\n";
  const VALID = "---\nname: fine\n---\nnothing to see here\n";

  test("--file with an unclosed block exits 1", async () => {
    const file = join(workDir, "broken.md");
    await writeFile(file, INVALID, "utf8");

    const res = await runCli("wiki", "template", "validate", "--file", file);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Unclosed block helper");
  }, 30_000);

  test("--file on a valid template exits 0", async () => {
    const file = join(workDir, "fine.md");
    await writeFile(file, VALID, "utf8");

    const res = await runCli("wiki", "template", "validate", "--file", file);

    expect(res.exitCode).toBe(0);
  }, 30_000);

  test("validate <name> on an invalid template exits 1", async () => {
    await writeTemplate("global", "broken", "{{#if x}}\nunclosed block");

    const res = await runCli("wiki", "template", "validate", "broken", "--level", "global");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Unclosed block helper");
  }, 30_000);

  test("validate --all exits 1 when any template is invalid", async () => {
    await writeTemplate("global", "fine", "all good");
    await writeTemplate("global", "broken", "{{#if x}}\nunclosed block");

    const res = await runCli("wiki", "template", "validate", "--all");

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("broken");
  }, 30_000);

  test("validate --all exits 0 when everything is valid", async () => {
    await writeTemplate("global", "fine", "all good");

    const res = await runCli("wiki", "template", "validate", "--all");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("All templates valid.");
  }, 30_000);

  test("warnings alone do not fail the command", async () => {
    // An undeclared variable is a warning, not an error.
    await writeTemplate("global", "warned", "{{undeclared}}");

    const res = await runCli("wiki", "template", "validate", "warned", "--level", "global");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("WARN:");
  }, 30_000);

  test("--json emits exactly one JSON document and still exits 1", async () => {
    await writeTemplate("global", "broken", "{{#if x}}\nunclosed block");

    const res = await runCli(
      "wiki",
      "template",
      "validate",
      "broken",
      "--level",
      "global",
      "--json",
    );

    expect(res.exitCode).toBe(1);
    // A `fail()` here would print a second JSON object after the report and
    // break every `--json` consumer.
    const parsed = JSON.parse(res.stdout);
    expect(parsed.valid).toBe(false);
    expect(res.stderr).toBe("");
  }, 30_000);
});

describe("wiki template help", () => {
  test("documents the level rule and no longer advertises the inert update --force", async () => {
    const res = await runCli("wiki", "template", "--help");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--level <global|profile|space>");
    // `update --force` was read and never used; re-tracking is unconditional.
    expect(res.stdout).not.toContain("Re-track source for templates");
  }, 30_000);
});

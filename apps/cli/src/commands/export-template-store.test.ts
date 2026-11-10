/**
 * `wiki export template save|delete` only ever touch the template store.
 *
 * `template delete <name> --confirm` used to resolve the name the way
 * `--template` does for an export, whose first rule is "an existing path wins":
 * a file in the working directory named like the template was unlinked instead
 * of the stored template. And `template save --level foo` silently wrote to the
 * global store.
 *
 * Real CLI process, sandboxed HOME and working directory; neither command
 * talks to Confluence.
 */
import { afterEach, beforeEach, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

let home: string;
let cwd: string;
const store = () => join(home, ".atlcli", "templates", "confluence");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atlcli-template-home-"));
  cwd = await mkdtemp(join(tmpdir(), "atlcli-template-cwd-"));
  await mkdir(store(), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function template(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "wiki", "export", "template", ...args, "--json"], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

it("delete removes the stored template, not a working-directory file of the same name", async () => {
  await writeFile(join(store(), "corp.docx"), "stored");
  await writeFile(join(cwd, "corp.docx"), "my document");
  await writeFile(join(cwd, "corp"), "my notes");

  for (const name of ["corp.docx", "corp"]) {
    await writeFile(join(store(), "corp.docx"), "stored");
    const out = await template(["delete", name, "--confirm"]);
    expect(out.exitCode, out.stdout + out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).path).toContain(join(".atlcli", "templates", "confluence", "corp.docx"));
    expect(existsSync(join(store(), "corp.docx"))).toBe(false);
    expect(existsSync(join(cwd, "corp.docx"))).toBe(true);
    expect(existsSync(join(cwd, "corp"))).toBe(true);
  }
});

it("delete of a name that is not a stored template is not found, whatever exists on disk", async () => {
  await writeFile(join(cwd, "notes.docx"), "my document");
  await writeFile(join(home, "outside.docx"), "outside the store");
  await writeFile(join(store(), "corp.docx"), "stored");

  for (const name of ["notes.docx", join(cwd, "notes.docx"), "../../../outside.docx", "../confluence/corp.docx"]) {
    const out = await template(["delete", name, "--confirm"]);
    expect(out.exitCode, name).toBe(1);
    expect(JSON.parse(out.stdout).error.message, name).toContain("Template not found");
  }
  expect(existsSync(join(cwd, "notes.docx"))).toBe(true);
  expect(existsSync(join(home, "outside.docx"))).toBe(true);
  expect(existsSync(join(store(), "corp.docx"))).toBe(true);
});

it("save rejects an unknown --level instead of writing to the global store", async () => {
  await writeFile(join(cwd, "t.docx"), "template");
  const bad = await template(["save", "corp", "--file", "t.docx", "--level", "foo"]);
  expect(bad.exitCode).toBe(1);
  const error = JSON.parse(bad.stdout).error;
  expect(error.code).toBe("ATLCLI_ERR_USAGE");
  expect(error.message).toContain('Unknown --level "foo"');
  expect(existsSync(join(store(), "corp.docx"))).toBe(false);

  const ok = await template(["save", "corp", "--file", "t.docx", "--level", "project"]);
  expect(ok.exitCode, ok.stdout + ok.stderr).toBe(0);
  expect(existsSync(join(cwd, ".atlcli", "templates", "confluence", "corp.docx"))).toBe(true);
});

it("save rejects a template name that would leave the store", async () => {
  await writeFile(join(cwd, "t.docx"), "template");
  for (const name of ["../../../escaped", join(cwd, "absolute"), "sub/corp"]) {
    const out = await template(["save", name, "--file", "t.docx"]);
    expect(out.exitCode, name).toBe(1);
    expect(JSON.parse(out.stdout).error.message, name).toContain("Invalid template name");
  }
  expect(existsSync(join(home, "escaped.docx"))).toBe(false);
  expect(existsSync(join(cwd, "absolute.docx"))).toBe(false);
});

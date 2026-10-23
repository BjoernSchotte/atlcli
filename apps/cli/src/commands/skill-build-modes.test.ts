import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./skill-smoke-entry.ts", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../../../../skills/atlcli", import.meta.url));
let workDir: string;
let expected: string;

/** The digest the smoke entry must print, computed from the files on disk in manifest order. */
async function expectedLine(): Promise<string> {
  const references = (await readdir(join(SKILL_DIR, "references"))).sort().map((name) => `references/${name}`);
  const paths = ["SKILL.md", ...references];
  const digest = createHash("sha256");
  for (const path of paths) digest.update(`${path}\0${await readFile(join(SKILL_DIR, path), "utf8")}\0`);
  return `SKILL_OK ${paths.length} ${digest.digest("hex")}`;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atlcli-skill-build-modes-"));
  expected = await expectedLine();
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function run(cmd: string[], cwd?: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("the agent skill survives every CLI build mode", () => {
  it("embeds the skill in a source run", async () => {
    const result = await run(["bun", "--conditions=development", "run", ENTRY], tmpdir());
    expect(result.stdout.trim()).toBe(expected);
    expect(result.code).toBe(0);
  }, 30_000);

  it("embeds the skill in a dist bundle run from a foreign cwd", async () => {
    const distDir = join(workDir, "dist");
    const build = await run(["bun", "build", ENTRY, "--outdir", distDir, "--target", "bun"]);
    expect(build.code).toBe(0);
    const result = await run(["bun", join(distDir, "skill-smoke-entry.js")], tmpdir());
    expect(result.stdout.trim()).toBe(expected);
    expect(result.code).toBe(0);
  }, 60_000);

  it("embeds the skill in a compiled executable run from a foreign cwd", async () => {
    const binary = join(workDir, "atlcli-skill-smoke");
    const build = await run(["bun", "build", ENTRY, "--compile", "--outfile", binary]);
    expect(build.code).toBe(0);
    const result = await run([binary], tmpdir());
    expect(result.stdout.trim()).toBe(expected);
    expect(result.code).toBe(0);
  }, 120_000);
});

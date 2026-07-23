import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./export-code-font-smoke-entry.ts", import.meta.url));
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atlcli-code-font-build-modes-"));
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

function expectCodeFont(result: { code: number; stdout: string }): void {
  expect(result.stdout).toMatch(/^CODE_FONT_OK 273900\s*$/u);
  expect(result.code).toBe(0);
}

describe("DOCX code font survives every CLI build mode", () => {
  it("loads the committed sfnt from source", async () => {
    expectCodeFont(await run(["bun", "--conditions=development", "run", ENTRY]));
  }, 30_000);

  it("loads the committed sfnt from a dist bundle in a foreign cwd", async () => {
    const distDir = join(workDir, "dist");
    const build = await run(["bun", "build", ENTRY, "--outdir", distDir, "--target", "bun"]);
    expect(build.code).toBe(0);
    expectCodeFont(
      await run(["bun", join(distDir, "export-code-font-smoke-entry.js")], tmpdir()),
    );
  }, 60_000);

  it("loads the committed sfnt from a compiled executable in a foreign cwd", async () => {
    const binary = join(workDir, "atlcli-code-font-smoke");
    const build = await run(["bun", "build", ENTRY, "--compile", "--outfile", binary]);
    expect(build.code).toBe(0);
    expectCodeFont(await run([binary], tmpdir()));
  }, 120_000);
});

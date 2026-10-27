import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingNativeExternals } from "../../build-tui-natives.js";

// Regression: release binaries aborted every Jinja render (`wiki page create`)
// with ENOENT on `/$bunfs/root/emscripten-module.wasm`: `--compile` never
// embedded the WASM the QuickJS loader reads beside the bundle.
const ENTRY = fileURLToPath(new URL("./quickjs-smoke-entry.ts", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const EXPECTED = "QUICKJS_OK 1+2 42";
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atlcli-quickjs-build-modes-"));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function run(cmd: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function expectSmoke(cmd: string[]): Promise<void> {
  const result = await run(cmd, tmpdir());
  expect(result.stderr).not.toContain("emscripten-module");
  expect(result.stdout.trim()).toBe(EXPECTED);
  expect(result.code).toBe(0);
}

describe("QuickJS survives every CLI build mode", () => {
  it("runs in a source run", async () => {
    await expectSmoke(["bun", "--conditions=development", "run", ENTRY]);
  }, 30_000);

  it("runs in a dist bundle from a foreign cwd", async () => {
    const distDir = join(workDir, "dist");
    const build = await run(["bun", "build", ENTRY, "--outdir", distDir, "--target", "bun", "--conditions=development"]);
    expect(build.code).toBe(0);
    await expectSmoke(["bun", join(distDir, "quickjs-smoke-entry.js")]);
  }, 60_000);

  it("runs in a compiled executable from a foreign cwd", async () => {
    const binary = join(workDir, "atlcli-quickjs-smoke");
    const build = await run(["bun", "build", ENTRY, "--compile", "--conditions=development", "--outfile", binary]);
    expect(build.code).toBe(0);
    await expectSmoke([binary]);
  }, 120_000);

  it("renders a template in the compiled CLI itself", async () => {
    const binary = join(workDir, "atlcli");
    const build = await run([
      "bun", "build", CLI_ENTRY, "--compile", "--conditions=development",
      ...missingNativeExternals(), "--outfile", binary,
    ]);
    expect(build.code).toBe(0);
    const template = join(workDir, "page.md");
    await writeFile(template, "Hallo {{ name }}\n");
    const result = await run([binary, "template", "vars", "--file", template, "--json"], tmpdir());
    expect(result.stderr).not.toContain("emscripten-module");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"name"');
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";

/**
 * T3.1 regression guard (spec 008): the riskiest packaging assumption is that
 * the `with { type: "file" }` wasm/font imports survive EVERY build mode the
 * release ships. This automates the one-time spike check as a permanent gate:
 * the same minimal bundle must compile to `%PDF-` bytes in a source run, a
 * `bun build --target bun` dist bundle, and a `bun build --compile` binary.
 * Runs on Linux and macOS CI runners.
 */
const ENTRY = fileURLToPath(new URL("./export-pdf-smoke-entry.ts", import.meta.url));
let workDir: string;

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  workDir = await mkdtemp(join(tmpdir(), "atlcli-pdf-build-modes-"));
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

describe("PDF compile port survives every build mode (T3.1)", () => {
  it("source run compiles to %PDF- bytes", async () => {
    const { code, stdout } = await run(["bun", "run", ENTRY]);
    expect(stdout).toContain("PDF_OK");
    expect(code).toBe(0);
  }, 60_000);

  it("bun build --target bun dist bundle compiles to %PDF- bytes", async () => {
    const distDir = join(workDir, "dist");
    const build = await run(["bun", "build", ENTRY, "--outdir", distDir, "--target", "bun"]);
    expect(build.code).toBe(0);
    // Run from a foreign CWD to prove the asset path is anchored to the bundle,
    // not the process working directory.
    const { code, stdout } = await run(
      ["bun", join(distDir, "export-pdf-smoke-entry.js")],
      tmpdir()
    );
    expect(stdout).toContain("PDF_OK");
    expect(code).toBe(0);
  }, 60_000);

  it("bun build --compile binary compiles to %PDF- bytes", async () => {
    const binPath = join(workDir, "atlcli-pdf-smoke");
    const build = await run(["bun", "build", ENTRY, "--compile", "--outfile", binPath]);
    expect(build.code).toBe(0);
    const { code, stdout } = await run([binPath], tmpdir());
    expect(stdout).toContain("PDF_OK");
    expect(code).toBe(0);
  }, 120_000);
});

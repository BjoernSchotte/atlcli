import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard (spec 006 G4): the diagram/SVG-attachment rasterizer's
 * `with { type: "file" }` resvg-wasm + font imports must resolve in EVERY build
 * mode the release ships. Before the `assetFilePath` (`import.meta.dir`) fix,
 * SVG embedding worked from source but failed in the `bun build --target bun`
 * dist build because `readFile` resolved the bundle-relative asset paths against
 * the process CWD. This automates the check the same way spec 008 did for the
 * PDF/typst wasm (`export-pdf-build-modes.test.ts`): the same minimal entry must
 * rasterize a trivial SVG to a valid PNG in a source run, a dist bundle run from
 * a FOREIGN cwd, and a compiled binary.
 */
const ENTRY = fileURLToPath(new URL("./export-rasterizer-smoke-entry.ts", import.meta.url));
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atlcli-rasterizer-build-modes-"));
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

describe("diagram/SVG rasterizer survives every build mode (spec 006 G4)", () => {
  it("source run rasterizes an SVG to a PNG", async () => {
    // Run from live `src/`: the workspace packages this entry imports only
    // resolve to source under the `development` export condition (spec 009's
    // dist-exports model); without it they demand a built `dist/`.
    const { code, stdout } = await run(["bun", "--conditions=development", "run", ENTRY]);
    expect(stdout).toContain("RASTER_OK");
    expect(code).toBe(0);
  }, 60_000);

  it("bun build --target bun dist bundle rasterizes an SVG to a PNG", async () => {
    const distDir = join(workDir, "dist");
    const build = await run(["bun", "build", ENTRY, "--outdir", distDir, "--target", "bun"]);
    expect(build.code).toBe(0);
    // Run from a foreign CWD to prove the asset path is anchored to the bundle,
    // not the process working directory (the exact SVG-in-dist bug).
    const { code, stdout } = await run(
      ["bun", join(distDir, "export-rasterizer-smoke-entry.js")],
      tmpdir()
    );
    expect(stdout).toContain("RASTER_OK");
    expect(code).toBe(0);
  }, 60_000);

  it("bun build --compile binary rasterizes an SVG to a PNG", async () => {
    const binPath = join(workDir, "atlcli-rasterizer-smoke");
    const build = await run(["bun", "build", ENTRY, "--compile", "--outfile", binPath]);
    expect(build.code).toBe(0);
    const { code, stdout } = await run([binPath], tmpdir());
    expect(stdout).toContain("RASTER_OK");
    expect(code).toBe(0);
  }, 120_000);
});

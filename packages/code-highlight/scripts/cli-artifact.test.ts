import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(
  new URL("./cli-artifact-smoke-entry.ts", import.meta.url),
);
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atlcli-code-highlight-artifact-"));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

async function run(
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CLI highlighting artifact", () => {
  test(
    "keeps Oniguruma operational without retaining aggregate Shiki initializers",
    async () => {
      const bundle = join(workDir, "code-highlight-smoke.js");
      const bundled = await run([
        "bun",
        "build",
        ENTRY,
        "--target",
        "bun",
        "--minify",
        "--outfile",
        bundle,
      ]);
      expect(bundled.code, bundled.stderr).toBe(0);
      const source = await readFile(bundle, "utf8");
      for (const forbidden of [
        "bundle_full_exports",
        "langs-bundle-full",
        "bundledLanguages",
        "bundledThemes",
        'from"shiki"',
        '"shiki/langs"',
        '"shiki/themes"',
      ]) {
        expect(source).not.toContain(forbidden);
      }

      const binary = join(workDir, "code-highlight-smoke");
      const compiled = await run([
        "bun",
        "build",
        ENTRY,
        "--compile",
        "--minify",
        "--outfile",
        binary,
      ]);
      expect(compiled.code, compiled.stderr).toBe(0);
      const executed = await run([binary]);
      expect(executed.code, executed.stderr).toBe(0);
      expect(executed.stdout).toMatch(/^CODE_HIGHLIGHT_CLI_OK\s*$/);
    },
    120_000,
  );
});

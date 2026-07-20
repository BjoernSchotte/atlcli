import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePdfOutput } from "@atlcli/pdf";

/**
 * Live-Confluence E2E harness for `--format pdf` (spec 008 Tests + folder 002's
 * deferred PDF E2E variants). GATED behind `ATLCLI_E2E=1` so `bun test` stays
 * offline by default — the orchestrator runs these against profile `mayflower`
 * and cleans up any pages it creates.
 *
 * HARD REQUIREMENT: every live fixture referenced here lives EXCLUSIVELY in
 * space `DOCSY` — no other space may be used.
 *
 * Assumptions when enabled:
 *   - `ATLCLI_E2E_PAGE_ID`      — an existing DOCSY page with a heading + image.
 *   - `ATLCLI_E2E_TREE_ROOT_ID` — the root of folder 002's DOCSY fixture tree
 *     (do not build a second tree; 002's tasks own and clean the shared one).
 *   - profile `mayflower` is configured (or ephemeral ATLCLI_* env vars are set).
 */
const RUN = process.env.ATLCLI_E2E === "1";
const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROFILE = process.env.ATLCLI_E2E_PROFILE ?? "mayflower";
const PAGE_ID = process.env.ATLCLI_E2E_PAGE_ID ?? "";
const TREE_ROOT_ID = process.env.ATLCLI_E2E_TREE_ROOT_ID ?? "";

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // CLI resolves to source (`../index.ts`); the `development` export condition
  // makes its `@atlcli/*` imports resolve to `src/` instead of demanding `dist/`.
  const proc = Bun.spawn(["bun", "--conditions=development", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

describe.skipIf(!RUN)("wiki export --format pdf (live E2E)", () => {
  it("exports a single page to a tagged PDF with a schema-v1 report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-"));
    try {
      const out = join(dir, "e2e.pdf");
      const { code, stdout } = await runCli([
        "wiki", "export", PAGE_ID, "--format", "pdf", "--profile", PROFILE, "-o", out, "--report", "json",
      ]);
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.schema).toBe("atlcli.export-report/1");
      expect(report.outputs).toHaveLength(1);
      const inspection = validatePdfOutput(new Uint8Array(await readFile(out)));
      expect(inspection.pageCount).toBeGreaterThanOrEqual(1);
      expect(inspection.tagged).toBe(true);
      expect(inspection.hasOutline).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("exports the DOCSY fixture tree to ONE PDF with per-chapter outline entries (002 hand-off)", async () => {
    // 002's deferred "PDF E2E variants": tree scope + label exclude → exactly
    // one artifact, one sourcePages[] entry per exported page, outline present.
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-tree-"));
    try {
      const { code, stdout } = await runCli([
        "wiki", "export", TREE_ROOT_ID, "--format", "pdf", "--profile", PROFILE,
        "--scope", "tree", "--label-exclude", "internal",
        "--out-dir", dir, "--report", "json",
      ]);
      expect(code).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.schema).toBe("atlcli.export-report/1");
      // Artifact-cardinality contract: tree scope yields exactly ONE output.
      expect(report.outputs).toHaveLength(1);
      expect(report.sourcePages.length).toBeGreaterThanOrEqual(1);
      // No excluded page appears among the source pages.
      for (const page of report.sourcePages) {
        expect(page.notes.map((n: { code: string }) => n.code)).not.toContain("label-filtered");
      }
      const inspection = validatePdfOutput(new Uint8Array(await readFile(report.outputs[0])));
      expect(inspection.tagged).toBe(true);
      // Chapters produce outline entries.
      expect(inspection.hasOutline).toBe(true);
      expect(inspection.pageCount).toBeGreaterThanOrEqual(report.sourcePages.length >= 2 ? 2 : 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("returns exit 4 for a nonexistent page with errors populated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-"));
    try {
      const { code, stdout } = await runCli([
        "wiki", "export", "999999999999", "--format", "pdf", "--profile", PROFILE,
        "--out-dir", dir, "--report", "json",
      ]);
      expect(code).toBe(4);
      expect(JSON.parse(stdout).errors.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("returns exit 3 for a bad token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-"));
    try {
      const proc = Bun.spawn(
        ["bun", "--conditions=development", "run", CLI, "wiki", "export", PAGE_ID, "--format", "pdf", "--profile", PROFILE, "--out-dir", dir, "--report", "json"],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLCLI_API_TOKEN: "definitely-wrong" } }
      );
      const code = await proc.exited;
      expect(code).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

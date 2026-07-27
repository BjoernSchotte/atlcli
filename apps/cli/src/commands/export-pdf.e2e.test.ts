import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@atlcli/core";
import { analyzeDocxTemplateImport } from "@atlcli/docx-template-intake";
import {
  DOCX_TEMPLATE_INTAKE_FIXTURE_BYTES,
  DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE,
} from "@atlcli/export-fixtures";
import {
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V1,
  loadPdfTemplatePack,
  validatePdfOutput,
} from "@atlcli/pdf";
import { InMemoryTemplateAssetStore } from "@atlcli/pdf-template-authoring";

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

if (RUN && PAGE_ID.trim() === "") {
  throw new Error(
    "ATLCLI_E2E_PAGE_ID is required when ATLCLI_E2E=1; provide an existing retained page in DOCSY."
  );
}

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

interface PdfTemplateCommandResult {
  schema: "atlcli.pdf-template-result/1";
  view?: {
    stage: string;
    availableActions: readonly {
      kind: string;
      enabled: boolean;
    }[];
  };
  outputs?: Readonly<Record<string, string>>;
}

async function runCliJson<T>(args: string[]): Promise<T> {
  const result = await runCli([...args, "--json", "--no-log"]);
  if (result.code !== 0) {
    throw new Error(
      `CLI command failed (${result.code}): ${args.join(" ")}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return JSON.parse(result.stdout) as T;
}

async function buildGeneratedTemplatePack(
  dir: string
): Promise<string> {
  const source = join(dir, "synthetic-brand.docx");
  const project = join(dir, "synthetic-brand-pdf-template");
  const pack = join(dir, "synthetic-brand.wiki-pdf-template");
  const sourceBytes = new Uint8Array(DOCX_TEMPLATE_INTAKE_FIXTURE_BYTES);
  expect(await sha256Hex(sourceBytes)).toBe(
    DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.sourceDigest
  );
  await writeFile(source, sourceBytes);

  const assetStore = new InMemoryTemplateAssetStore();
  const analyzed = await analyzeDocxTemplateImport(
    sourceBytes,
    {
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(({ family }) => family),
      assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
      assetStore,
    }
  );
  expect(analyzed.analysis.sourceDigest).toBe(
    DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.sourceDigest
  );

  let result = await runCliJson<PdfTemplateCommandResult>([
    "pdf-template",
    "import",
    source,
    "--dir",
    project,
    "--non-interactive",
  ]);
  expect(result.schema).toBe("atlcli.pdf-template-result/1");

  const roleBySha = new Map<string, string>([
    [
      DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.background.assetSha256,
      "asset.pageBackground",
    ],
    [
      DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.header.assetSha256,
      "asset.headerDecoration",
    ],
  ]);
  for (const candidate of analyzed.privateAssetCandidates) {
    const role = roleBySha.get(candidate.asset.sha256);
    if (!role) continue;
    result = await runCliJson<PdfTemplateCommandResult>([
      "pdf-template",
      "decide",
      "--dir",
      project,
      "--candidate",
      candidate.candidateId,
      "--accept-asset",
      "--role",
      role,
      "--rights-confirmed",
      "--decorative",
      "--slot-default",
      "--non-interactive",
    ]);
  }

  for (const [kind, flag] of [
    ["apply-ready", "--apply-ready"],
    ["keep-current-for-remaining", "--keep-current-for-remaining"],
    ["acknowledge-inventory", "--acknowledge-unsupported"],
  ] as const) {
    const action = result.view?.availableActions.find(
      (entry) => entry.kind === kind
    );
    if (!action?.enabled) continue;
    result = await runCliJson<PdfTemplateCommandResult>([
      "pdf-template",
      "review",
      project,
      flag,
      "--non-interactive",
    ]);
  }
  expect(result.view?.stage).toBe("ready-to-preview");

  result = await runCliJson<PdfTemplateCommandResult>([
    "pdf-template",
    "preview",
    project,
    "--non-interactive",
  ]);
  expect(result.view?.stage).toBe("ready-to-build");

  const built = await runCliJson<PdfTemplateCommandResult>([
    "pdf-template",
    "build",
    project,
    "--output",
    pack,
    "--non-interactive",
  ]);
  expect(built.view?.stage).toBe("built");
  expect(built.outputs?.archive).toBe(pack);
  return pack;
}

describe("wiki export live E2E pack setup", () => {
  it("builds the reviewed canonical pack without Confluence access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-template-setup-"));
    try {
      const pack = await buildGeneratedTemplatePack(dir);
      const runtime = await loadPdfTemplatePack(
        new Uint8Array(await readFile(pack))
      );
      expect(runtime.manifest.engine.entry).toBe("atlcli.typ");
      expect(runtime.assets["asset.pageBackground"]).toBeDefined();
      expect(runtime.assets["asset.headerDecoration"]).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

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

  it("builds a reviewed DOCX-derived pack and applies it to a retained DOCSY page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-template-"));
    try {
      const pack = await buildGeneratedTemplatePack(dir);
      const baselineOut = join(dir, "baseline.pdf");
      const templateOut = join(dir, "generated-template.pdf");
      const exportedAt = "2026-07-27T00:00:00.000Z";
      const baseline = await runCli([
        "wiki",
        "export",
        PAGE_ID,
        "--format",
        "pdf",
        "--profile",
        PROFILE,
        "--output",
        baselineOut,
        "--exported-at",
        exportedAt,
        "--report",
        "json",
      ]);
      expect(baseline.code).toBe(0);
      const templated = await runCli([
        "wiki",
        "export",
        PAGE_ID,
        "--format",
        "pdf",
        "--profile",
        PROFILE,
        "--output",
        templateOut,
        "--template",
        pack,
        "--exported-at",
        exportedAt,
        "--report",
        "json",
      ]);
      expect(templated.code).toBe(0);

      const baselineReport = JSON.parse(baseline.stdout);
      const templateReport = JSON.parse(templated.stdout);
      expect(baselineReport.schema).toBe("atlcli.export-report/1");
      expect(templateReport.schema).toBe("atlcli.export-report/1");
      expect(baselineReport.outputs).toEqual([baselineOut]);
      expect(templateReport.outputs).toEqual([templateOut]);

      const baselineBytes = new Uint8Array(await readFile(baselineOut));
      const templateBytes = new Uint8Array(await readFile(templateOut));
      const baselineInspection = validatePdfOutput(baselineBytes);
      const templateInspection = validatePdfOutput(templateBytes);
      expect(templateInspection.pageCount).toBe(baselineInspection.pageCount);
      expect(templateInspection.tagged).toBe(true);
      expect(templateInspection.hasOutline).toBe(true);
      expect(templateBytes).not.toEqual(baselineBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it.skipIf(TREE_ROOT_ID.trim() === "")(
    "exports the DOCSY fixture tree to ONE PDF with per-chapter outline entries (002 hand-off)",
    async () => {
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
    },
    300_000
  );

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

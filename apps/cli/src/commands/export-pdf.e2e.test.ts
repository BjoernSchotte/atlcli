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
import { parsePdfTemplateRecipeYaml } from "./pdf-template-yaml.js";

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
 *   - `ATLCLI_E2E_WHITEBOARD_PAGE_ID` — optional DOCSY page whose ADF embeds an
 *     Atlassian Whiteboard. The Whiteboard-specific test skips when absent.
 *   - `ATLCLI_E2E_PDF_TEMPLATE_RECIPE` — optional private declarative YAML
 *     recipe. The harness builds it twice, exercises synthetic title tiers,
 *     then applies it to the retained DOCSY page.
 *   - `ATLCLI_E2E_PDF_TEMPLATE_PACK` — optional prebuilt revision-4 pack used
 *     instead of a recipe. Set at most one of the two template variables.
 *   - profile `mayflower` is configured (or ephemeral ATLCLI_* env vars are set).
 */
const RUN = process.env.ATLCLI_E2E === "1";
const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROFILE = process.env.ATLCLI_E2E_PROFILE ?? "mayflower";
const PAGE_ID = process.env.ATLCLI_E2E_PAGE_ID ?? "";
const TREE_ROOT_ID = process.env.ATLCLI_E2E_TREE_ROOT_ID ?? "";
const WHITEBOARD_PAGE_ID =
  process.env.ATLCLI_E2E_WHITEBOARD_PAGE_ID ?? "";
const PDF_TEMPLATE_RECIPE =
  process.env.ATLCLI_E2E_PDF_TEMPLATE_RECIPE?.trim() ?? "";
const PDF_TEMPLATE_PACK =
  process.env.ATLCLI_E2E_PDF_TEMPLATE_PACK?.trim() ?? "";

if (PDF_TEMPLATE_RECIPE !== "" && PDF_TEMPLATE_PACK !== "") {
  throw new Error(
    "Set only one of ATLCLI_E2E_PDF_TEMPLATE_RECIPE or ATLCLI_E2E_PDF_TEMPLATE_PACK."
  );
}

if (RUN && PAGE_ID.trim() === "") {
  throw new Error(
    "ATLCLI_E2E_PAGE_ID is required when ATLCLI_E2E=1; provide an existing retained page in DOCSY."
  );
}

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env
): Promise<{ code: number; stdout: string; stderr: string }> {
  // CLI resolves to source (`../index.ts`); the `development` export condition
  // makes its `@atlcli/*` imports resolve to `src/` instead of demanding `dist/`.
  const proc = Bun.spawn(["bun", "--conditions=development", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runPrivateTemplateBuild(
  recipe: string,
  output: string
): Promise<void> {
  const result = await runCli([
    "pdf-template",
    "build",
    recipe,
    "--output",
    output,
    "--json",
    "--no-log",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `Private PDF template recipe build failed with exit code ${result.code}`
    );
  }
}

async function preparePrivateTemplatePack(dir: string): Promise<{
  pack: string;
  runtime: Awaited<ReturnType<typeof loadPdfTemplatePack>>;
}> {
  if (PDF_TEMPLATE_RECIPE !== "") {
    const first = join(dir, "private-template-a.wiki-pdf-template");
    const second = join(dir, "private-template-b.wiki-pdf-template");
    await runPrivateTemplateBuild(PDF_TEMPLATE_RECIPE, first);
    await runPrivateTemplateBuild(PDF_TEMPLATE_RECIPE, second);
    const firstBytes = new Uint8Array(await readFile(first));
    const secondBytes = new Uint8Array(await readFile(second));
    expect(await sha256Hex(firstBytes)).toBe(await sha256Hex(secondBytes));

    const [runtime, secondRuntime] = await Promise.all([
      loadPdfTemplatePack(firstBytes),
      loadPdfTemplatePack(secondBytes),
    ]);
    expect(runtime.canonicalSource.revision).toBe("4");
    expect(runtime.manifest.capabilityCatalog?.version).toBe(2);
    expect(secondRuntime.runtimeSnapshot).toEqual(runtime.runtimeSnapshot);

    const authored = parsePdfTemplateRecipeYaml(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readFile(PDF_TEMPLATE_RECIPE)
      )
    );
    const authoredDesignDigest = await sha256Hex(
      new TextEncoder().encode(canonicalJson(authored.design))
    );
    const runtimeDesignDigest = await sha256Hex(
      new TextEncoder().encode(canonicalJson(runtime.manifest.design))
    );
    expect(runtimeDesignDigest).toBe(authoredDesignDigest);
    return { pack: first, runtime };
  }

  const bytes = new Uint8Array(await readFile(PDF_TEMPLATE_PACK));
  const runtime = await loadPdfTemplatePack(bytes);
  expect(runtime.canonicalSource.revision).toBe("4");
  expect(runtime.manifest.capabilityCatalog?.version).toBe(2);
  return { pack: PDF_TEMPLATE_PACK, runtime };
}

async function runPoppler(
  command: "pdftoppm" | "pdftotext",
  args: string[]
): Promise<{ stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command} failed with exit code ${code}`);
  }
  return { stdout, stderr };
}

async function assertPrivateTemplatePage(
  pdfPath: string,
  page: number,
  expectedText?: string
): Promise<string> {
  const text = new TextDecoder().decode(
    (
      await runPoppler("pdftotext", [
        "-f",
        String(page),
        "-l",
        String(page),
        "-layout",
        pdfPath,
        "-",
      ])
    ).stdout
  );
  if (expectedText !== undefined) {
    expect(countOccurrences(text.replace(/\s+/gu, " "), expectedText)).toBe(1);
  }
  const rasterPrefix = join(
    tmpdir(),
    `atlcli-e2e-raster-${crypto.randomUUID()}`
  );
  const rasterPath = `${rasterPrefix}.ppm`;
  try {
    await runPoppler("pdftoppm", [
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      "-r",
      "144",
      pdfPath,
      rasterPrefix,
    ]);
    const raster = new Uint8Array(await readFile(rasterPath));
    expect(raster.byteLength).toBeGreaterThan(1_000_000);
    expect(new TextDecoder().decode(raster.subarray(0, 2))).toBe("P6");
  } finally {
    await rm(rasterPath, { force: true });
  }
  return text.replace(/\s+/gu, " ").trim();
}

function assertDeclaredClosingText(
  text: string,
  runtime: Awaited<ReturnType<typeof loadPdfTemplatePack>>
): void {
  const design = runtime.manifest.design!;
  const closing = design.compositions!.closingPage;
  if (
    closing.website === "show" &&
    !text.includes(design.branding.websiteLabel!)
  ) {
    throw new Error("Closing page is missing its declared website label");
  }
  if (
    closing.legalNotice === "show" &&
    !text.includes(design.branding.legalNotice!)
  ) {
    throw new Error("Closing page is missing its declared legal notice");
  }
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
  it.skipIf(PDF_TEMPLATE_RECIPE === "" && PDF_TEMPLATE_PACK === "")(
    "builds a private revision-4 recipe and exports synthetic titles plus retained DOCSY content",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-private-pdf-template-"));
      let server: ReturnType<typeof Bun.serve> | undefined;
      try {
        const { pack, runtime } = await preparePrivateTemplatePack(dir);
        const titles = [
          "PLATFORM",
          "DIGITAL DELIVERY",
          "RELIABLE DIGITAL DELIVERY",
          "ARCHITECTURE FOR RELIABLE DIGITAL PRODUCTS AND SERVICES",
        ] as const;
        const titleById = new Map(
          titles.map((title, index) => [String(980_001 + index), title])
        );
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const { pathname } = new URL(request.url);
            const match = pathname.match(/^\/rest\/api\/content\/(\d+)$/u);
            const title = match ? titleById.get(match[1]!) : undefined;
            if (!title) {
              return Response.json({ message: "Fixture route not found" }, { status: 404 });
            }
            return Response.json({
              id: match![1],
              title,
              space: { key: "DOCSY" },
              version: { number: 1, when: "2026-08-07T00:00:00.000Z" },
              ancestors: [],
              history: {
                createdDate: "2026-08-07T00:00:00.000Z",
                createdBy: { accountId: "fixture", displayName: "Fixture" },
                lastUpdated: {
                  when: "2026-08-07T00:00:00.000Z",
                  by: { accountId: "fixture", displayName: "Fixture" },
                },
              },
              metadata: { labels: { results: [] }, properties: {} },
              body: {
                storage: {
                  value: "<h1>Pipeline proof</h1><p>Neutral synthetic content.</p>",
                  representation: "storage",
                },
              },
              _links: { base: server!.url.origin, webui: `/pages/${match![1]}` },
            });
          },
        });

        const design = runtime.manifest.design!;
        if (!("features" in design)) {
          throw new Error("Revision-3 fixture unexpectedly resolved a V3 design");
        }
        const expectedSyntheticPageCount =
          1 +
          Number(design.features.cover.enabled) +
          Number(design.features.outline.enabled) +
          Number(design.features.closingPage.enabled);

        for (const [pageId, title] of titleById) {
          const output = join(dir, `synthetic-${pageId}.pdf`);
          const exported = await runCli(
            [
              "wiki",
              "export",
              pageId,
              "--format",
              "pdf",
              "--base-url",
              server.url.origin,
              "--auth-type",
              "bearer",
              "--allow-http",
              "--template",
              pack,
              "--output",
              output,
              "--report",
              "json",
              "--no-log",
            ],
            { ...process.env, ATLCLI_API_TOKEN: "synthetic-token" }
          );
          expect(exported.code).toBe(0);
          const report = JSON.parse(exported.stdout);
          expect(report.schema).toBe("atlcli.export-report/1");
          const inspection = validatePdfOutput(
            new Uint8Array(await readFile(output))
          );
          expect(inspection.tagged).toBe(true);
          expect(inspection.hasOutline).toBe(true);
          expect(inspection.pageCount).toBe(expectedSyntheticPageCount);
          await assertPrivateTemplatePage(output, 1, title);
          const closingText = await assertPrivateTemplatePage(
            output,
            inspection.pageCount
          );
          assertDeclaredClosingText(closingText, runtime);
        }
        server.stop(true);
        server = undefined;

        const liveOutput = join(dir, "retained-docsy.pdf");
        const live = await runCli([
          "wiki",
          "export",
          PAGE_ID,
          "--format",
          "pdf",
          "--profile",
          PROFILE,
          "--template",
          pack,
          "--output",
          liveOutput,
          "--report",
          "json",
          "--no-log",
        ]);
        expect(live.code).toBe(0);
        const liveReport = JSON.parse(live.stdout);
        expect(liveReport.schema).toBe("atlcli.export-report/1");
        expect(liveReport.complete).toBe(true);
        expect(liveReport.errors).toHaveLength(0);
        const liveInspection = validatePdfOutput(
          new Uint8Array(await readFile(liveOutput))
        );
        expect(liveInspection.tagged).toBe(true);
        expect(liveInspection.hasOutline).toBe(true);
        expect(liveInspection.pageCount).toBeGreaterThanOrEqual(3);
        await assertPrivateTemplatePage(liveOutput, 1);
        const liveClosingText = await assertPrivateTemplatePage(
          liveOutput,
          liveInspection.pageCount
        );
        assertDeclaredClosingText(liveClosingText, runtime);

        const closing = runtime.manifest.design?.compositions?.closingPage;
        expect(closing?.kind).toBe("brand-lockup");
      } finally {
        server?.stop(true);
        await rm(dir, { recursive: true, force: true });
      }
    },
    600_000
  );

  it.skipIf(WHITEBOARD_PAGE_ID.trim() === "")(
    "exports an embedded Whiteboard as a linked card in live DOCX and PDF",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-whiteboard-"));
      try {
        for (const format of ["docx", "pdf"] as const) {
          const out = join(dir, `whiteboard.${format}`);
          const result = await runCli([
            "wiki",
            "export",
            WHITEBOARD_PAGE_ID,
            "--format",
            format,
            "--profile",
            PROFILE,
            "--output",
            out,
            "--report",
            "json",
          ]);
          expect(result.code).toBe(0);
          const report = JSON.parse(result.stdout);
          expect(report.schema).toBe("atlcli.export-report/1");
          expect(report.format).toBe(format);
          expect(report.complete).toBe(true);
          expect(report.warnings).toHaveLength(0);
          expect(report.errors).toHaveLength(0);
          expect(report.notesByCode?.["macro-rendered-via"]).toBe(1);
          expect(report.notesByCode?.["macro-degraded"]).toBeUndefined();
          expect(report.sourcePages).toHaveLength(1);
          expect(
            report.sourcePages[0].notes.map(
              (note: { code: string }) => note.code
            )
          ).toEqual(["macro-rendered-via"]);

          const bytes = new Uint8Array(await readFile(out));
          expect(bytes.byteLength).toBeGreaterThan(0);
          if (format === "pdf") {
            const inspection = validatePdfOutput(bytes);
            expect(inspection.pageCount).toBeGreaterThanOrEqual(1);
            expect(inspection.tagged).toBe(true);
            expect(inspection.hasOutline).toBe(true);
          }
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000
  );

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

  it("returns exit 4 for a nonexistent page in PDF and DOCX", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-"));
    try {
      for (const format of ["pdf", "docx"] as const) {
        const { code, stdout } = await runCli([
          "wiki", "export", "999999999999", "--format", format, "--profile", PROFILE,
          "--output", join(dir, `missing.${format}`), "--report", "json",
        ]);
        expect(code).toBe(4);
        expect(JSON.parse(stdout).errors.length).toBeGreaterThan(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("returns exit 3 for a bad token in PDF and DOCX", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlcli-e2e-pdf-"));
    try {
      for (const format of ["pdf", "docx"] as const) {
        const proc = Bun.spawn(
          ["bun", "--conditions=development", "run", CLI, "wiki", "export", PAGE_ID, "--format", format, "--profile", PROFILE, "--output", join(dir, `unauthorized.${format}`), "--report", "json"],
          { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLCLI_API_TOKEN: "definitely-wrong" } }
        );
        const code = await proc.exited;
        expect(code).toBe(3);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * `--strict` severity fidelity: an INFORMATIONAL note must not be reported as a
 * warning, and must not fail a CI build.
 *
 * The defect this pins: `noteToIssue` hard-coded `severity: "warning"` and threw
 * `note.level` away. `packages/docx/src/export.ts` appends a `perf-timing` note
 * (`level: "info"`) to EVERY ts DOCX export unconditionally, so a completely
 * clean DOCX ts export always produced one "warning" and exited `2` under
 * `--strict` — while the PDF path, which emits no such note, exited `0`. Two
 * engines, identical input, different exit codes, and `--strict` unusable in CI
 * on `--engine ts`.
 *
 * The fix is in the CLI's translation layer only (`noteToIssue`): note levels
 * map onto issue severities faithfully (`info` → `info`, `warning` → `warning`).
 * Neither engine's note emission changed, and `perf-timing` is NOT special-cased
 * — every `level: "info"` note in the codebase is affected the same way.
 *
 * NO MOCKS: a real Bun HTTP server stands in for the Confluence REST API, the
 * real ts DOCX engine writes a real .docx, and the real Typst pipeline compiles
 * a real PDF — driven through the real CLI in its own process, exactly like the
 * sibling `export-report-flag.test.ts` / `engine-parity.test.ts` suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

/** A page whose body is ordinary prose: nothing here is a defect on either engine. */
const CLEAN_PAGE_ID = "1126240001";
const CLEAN_STORAGE = `<h1>Clean</h1><p>Ordinary prose, nothing to report.</p>`;

/**
 * A page that really does contain a `warning`-level defect on BOTH engines: an
 * `<ac:image>` whose attachment the stub refuses to serve. The DOCX serializer
 * reports `image-embed-failed` and the PDF prepare stage `pdf-image-skipped`,
 * both `level: "warning"`. This is what keeps the fix honest — `--strict` must
 * still bite. The two engines' *codes* for this differ; unifying them is a
 * separate concern, so the cross-engine assertions below compare exit codes and
 * warning COUNTS rather than code spellings.
 */
const DIRTY_PAGE_ID = "1126240002";
const DIRTY_STORAGE =
  `<p>Before</p><ac:image><ri:attachment ri:filename="ghost.png" /></ac:image><p>After</p>`;

function page(id: string, title: string, storage: string) {
  return {
    id,
    title,
    space: { key: "DOCSY" },
    version: { number: 1, when: "2026-07-21T00:00:00.000Z" },
    ancestors: [],
    history: {
      createdDate: "2026-07-21T00:00:00.000Z",
      createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
      lastUpdated: { when: "2026-07-21T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
    },
    metadata: { labels: { results: [] }, properties: {} },
    body: { storage: { value: storage, representation: "storage" } },
    _links: { base: "https://example.invalid/wiki", webui: `/pages/${id}` },
  };
}

const PAGES: Record<string, ReturnType<typeof page>> = {
  [CLEAN_PAGE_ID]: page(CLEAN_PAGE_ID, "Clean Export", CLEAN_STORAGE),
  [DIRTY_PAGE_ID]: page(DIRTY_PAGE_ID, "Warning Export", DIRTY_STORAGE),
};

interface CliIssue {
  code: string;
  severity: "error" | "warning" | "info";
  phase: string;
  message?: string;
}
interface CliReport {
  schema: string;
  format: string;
  engine?: string;
  issues: CliIssue[];
  warnings: CliIssue[];
  errors: CliIssue[];
  notesByCode?: Record<string, number>;
  exitCode: number;
}

describe("--strict counts warnings, not informational notes (severity fidelity)", () => {
  const unmatched: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let templatePath: string;

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
        const found = match ? PAGES[match[1]!] : undefined;
        if (found) return Response.json(found);
        // The attachment lookup for the dirty fixture answers 404 on purpose:
        // that is what makes `image-unresolved` a REAL warning rather than a
        // hand-built one.
        unmatched.push(`${url.pathname}?${url.searchParams}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dir = await mkdtemp(join(tmpdir(), "atlcli-strict-severity-"));
    templatePath = join(dir, "strict.docx");
    await writeFile(templatePath, buildDocx({ body: para("$scroll.content"), date: new Date(0) }));
  });

  afterAll(async () => {
    server?.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function runCli(pageId: string, args: string[]): Promise<{ report: CliReport; exitCode: number; stderr: string }> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        "run",
        CLI,
        "wiki",
        "export",
        pageId,
        ...args,
        "--base-url",
        server.url.origin,
        "--auth-type",
        "bearer",
        "--allow-http",
        "--report",
        "json",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          ATLCLI_API_TOKEN: "stub-token",
          ATLCLI_DISABLE_UPDATE_CHECK: "1",
          ATLCLI_SUPPRESS_ENGINE_NOTICE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stdout, `no report document on stdout:\n${stderr}`).toContain("atlcli.export-report/1");
    return { report: JSON.parse(stdout) as CliReport, exitCode, stderr };
  }

  const docxArgs = (name: string, extra: string[] = []): string[] => [
    "--engine",
    "ts",
    "--template",
    templatePath,
    "-o",
    join(dir, name),
    ...extra,
  ];
  const pdfArgs = (name: string, extra: string[] = []): string[] => [
    "--format",
    "pdf",
    "-o",
    join(dir, name),
    ...extra,
  ];

  it("REGRESSION: a clean DOCX ts export exits 0 under --strict", async () => {
    const { report, exitCode, stderr } = await runCli(CLEAN_PAGE_ID, docxArgs("clean-strict.docx", ["--strict"]));
    expect(exitCode, `clean --engine ts --strict stderr:\n${stderr}`).toBe(0);
    expect(report.exitCode).toBe(0);

    // The note that used to fail the build is STILL THERE — it was mis-severitied,
    // not missing, and the fix must not make it vanish.
    expect(report.notesByCode?.["perf-timing"], "perf-timing must still be reported").toBe(1);
    const timing = report.issues.filter((i) => i.code === "perf-timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.severity).toBe("info");
    expect(timing[0]!.message).toMatch(/Timing: /);

    // …and it is not counted as a warning any more.
    expect(report.warnings.map((w) => w.code)).not.toContain("perf-timing");
    expect(report.warnings, `unexpected warnings: ${JSON.stringify(report.warnings)}`).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  }, 300_000);

  it("still exits 2 under --strict when a genuine warning-level note exists (DOCX ts)", async () => {
    const { report, exitCode } = await runCli(DIRTY_PAGE_ID, docxArgs("dirty-strict.docx", ["--strict"]));
    expect(exitCode).toBe(2);
    expect(report.exitCode).toBe(2);
    const codes = report.warnings.map((w) => w.code);
    expect(codes, `warnings: ${JSON.stringify(report.warnings)}`).toContain("image-embed-failed");
    expect(report.warnings.every((w) => w.severity === "warning")).toBe(true);
    // The informational note rides along in `issues` without inflating the count.
    expect(report.notesByCode?.["perf-timing"]).toBe(1);
    expect(codes).not.toContain("perf-timing");
  }, 300_000);

  it("both engines agree on the --strict exit code for identical input", async () => {
    const cleanDocx = await runCli(CLEAN_PAGE_ID, docxArgs("parity-clean.docx", ["--strict"]));
    const cleanPdf = await runCli(CLEAN_PAGE_ID, pdfArgs("parity-clean.pdf", ["--strict"]));
    expect(
      cleanDocx.exitCode,
      `docx=${cleanDocx.exitCode} pdf=${cleanPdf.exitCode}; docx stderr:\n${cleanDocx.stderr}`
    ).toBe(cleanPdf.exitCode);
    expect(cleanDocx.exitCode).toBe(0);

    const dirtyDocx = await runCli(DIRTY_PAGE_ID, docxArgs("parity-dirty.docx", ["--strict"]));
    const dirtyPdf = await runCli(DIRTY_PAGE_ID, pdfArgs("parity-dirty.pdf", ["--strict"]));
    expect(dirtyDocx.exitCode).toBe(dirtyPdf.exitCode);
    expect(dirtyDocx.exitCode).toBe(2);

    // Same claim one level down: a CI consumer reading `.warnings` gets the same
    // answer from both engines — empty for the clean page, non-empty for the
    // page with the unfetchable image.
    for (const [engine, report] of [["docx", cleanDocx.report], ["pdf", cleanPdf.report]] as const) {
      expect(report.warnings, `${engine} clean warnings: ${JSON.stringify(report.warnings)}`).toHaveLength(0);
      expect(report.errors).toHaveLength(0);
    }
    for (const [engine, report] of [["docx", dirtyDocx.report], ["pdf", dirtyPdf.report]] as const) {
      expect(report.warnings.length, `${engine} dirty warnings`).toBeGreaterThan(0);
      expect(report.warnings.every((w) => w.severity === "warning")).toBe(true);
    }
  }, 300_000);

  it("without --strict a warning-level note is still exit 0 (strict is the only gate)", async () => {
    const { report, exitCode } = await runCli(DIRTY_PAGE_ID, docxArgs("dirty-lenient.docx"));
    expect(exitCode).toBe(0);
    expect(report.warnings.map((w) => w.code)).toContain("image-embed-failed");
  }, 300_000);
});

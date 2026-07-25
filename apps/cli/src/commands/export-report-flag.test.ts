/**
 * FLAG parity: `--report json` must behave exactly like `--json` on every
 * format. (Field parity between the PDF and DOCX reports lives in the sibling
 * `export-report-parity.test.ts`; these two suites are deliberately separate.)
 *
 * `--report json` is documented as a synonym for `--json` for "PDF and ts-engine
 * exports" alike (see the JSON Output section of `exportHelp`). It used to be
 * normalized inside `handlePdfExport` only, so every DOCX path read the
 * un-normalized opts and `--engine ts --report json` printed the one-line human
 * summary while `--json` printed the `atlcli.export-report/1` document.
 *
 * The parity is asserted end-to-end through the real CLI: a real Bun HTTP server
 * stands in for the Confluence REST API (no fetch mocking — the CLI runs in its
 * own process), a real template built by the docx fixtures, and the real ts
 * export engine writing a real .docx to disk.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, para } from "@atlcli/docx/fixtures";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "646382103";

/** Requests the stub could not answer — surfaced in the failure message. */
const unmatched: string[] = [];

const PAGE = {
  id: PAGE_ID,
  title: "Report Parity Fixture",
  space: { key: "DOCSY" },
  version: { number: 3, when: "2026-07-19T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-18T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-19T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Parity body paragraph.</p>", representation: "storage" } },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${PAGE_ID}` },
};

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let templatePath: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      // Data-center shape (bearer auth ⇒ no /wiki prefix): /rest/api/content/<id>
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      unmatched.push(pathname);
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  dir = await mkdtemp(join(tmpdir(), "atlcli-report-parity-"));
  templatePath = join(dir, "parity.docx");
  // `date` is pinned so the template bytes (and therefore the export) are
  // reproducible across the two runs being compared.
  await writeFile(templatePath, buildDocx({ body: para("$scroll.content"), date: new Date(0) }));
});

afterAll(async () => {
  server?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Run the real CLI against the stub server and capture raw stdout bytes. */
async function runExportCli(reportFlags: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      // Required when running the CLI from source: the workspace packages only
      // resolve to src/ under this condition (spec 009 dist-exports model).
      "--conditions=development",
      "run",
      CLI,
      "wiki",
      "export",
      PAGE_ID,
      "--engine",
      "ts",
      "--template",
      templatePath,
      "-o",
      join(dir, "out.docx"),
      "--base-url",
      server.url.origin,
      "--auth-type",
      "bearer",
      "--allow-http",
      ...reportFlags,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        ATLCLI_API_TOKEN: "stub-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
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
  return { stdout, stderr, exitCode };
}

/**
 * Wall-clock durations are the ONLY thing allowed to differ between two runs of
 * the same export — `timings.totalMs` plus the per-phase figures the engine
 * writes into its human-readable timing note. Blank both so everything else in
 * the document is compared byte for byte.
 */
function normalizeTimings(stdout: string): string {
  return stdout.replace(/"totalMs":\s*\d+(\.\d+)?/g, '"totalMs":0').replace(/\d+(\.\d+)? ms/g, "N ms");
}

describe("DOCX ts export: --report json is a true synonym for --json", () => {
  it("emits the atlcli.export-report/1 document for both flag spellings, identical but for wall-clock timings", async () => {
    const viaJson = await runExportCli(["--json"]);
    const viaReport = await runExportCli(["--report", "json"]);

    expect(unmatched).toEqual([]);
    expect(viaJson.exitCode, `--json stderr:\n${viaJson.stderr}`).toBe(0);
    expect(viaReport.exitCode, `--report json stderr:\n${viaReport.stderr}`).toBe(0);

    // The regression itself: `--report json` used to print the human summary
    // ("Exported DOCX → …") on stdout instead of the report document.
    const parsed = JSON.parse(viaReport.stdout);
    expect(parsed.schema).toBe("atlcli.export-report/1");
    expect(parsed.format).toBe("docx");
    expect(parsed.engine).toBe("ts");
    expect(parsed.sourcePages).toHaveLength(1);
    expect(parsed.sourcePages[0].id).toBe(PAGE_ID);

    expect(normalizeTimings(viaReport.stdout)).toBe(normalizeTimings(viaJson.stdout));
  }, 60_000);

  it("rejects a non-json --report value on the DOCX path too", async () => {
    const { stdout, stderr, exitCode } = await runExportCli(["--report", "xml"]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/Unknown --report "xml"/);
  }, 30_000);
});

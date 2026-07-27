/**
 * `--keep-ignored` actually keeps the ignored body.
 *
 * The defect this pins: the flag was parsed, guarded (`--engine ts`, single
 * page), and threaded all the way into `runExport` as
 * `exportControls: "passthrough"` — and still dropped every `scroll-ignore`
 * body. The engine applies its own control policy only when it performs the
 * storage walk itself; spec 008's mention-resolution pre-walk in the CLI took
 * that walk over and passed no `exportControls`, so the walk that mattered
 * always ran under the default `"apply"` and the engine-level option addressed
 * a walk that no longer happened.
 *
 * The pre-existing engine test (`packages/docx/src/export.test.ts`, "spec 003
 * exporter-sensitive scroll macros") passes `details.storage` with NO `blocks`
 * — i.e. the one path the CLI never takes. It was green throughout and could
 * not have caught this. Hence a CLI-level test: it is the pre-walk, not the
 * engine, that has to carry the option.
 *
 * NO MOCKS: a real Bun HTTP server stands in for the Confluence REST API and
 * the real CLI runs in its own process against it, following
 * `export-field-refresh.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, headingStyle, para, readPart, stylesXml } from "@atlcli/docx/fixtures";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "1126250177";
const HOSTED_TEST_TIMEOUT_MS = 15_000;

/** Requests the stub could not answer — surfaced in the failure message. */
const unmatched: string[] = [];

/**
 * One body per export control, each with a distinct marker so a partial fix
 * (say, one that passes the option but loses the `exporter` alongside it)
 * cannot look like a pass.
 */
const STORAGE =
  "<h1>Doc</h1>" +
  "<p>ALWAYS_VISIBLE</p>" +
  '<ac:structured-macro ac:name="scroll-ignore"><ac:rich-text-body>' +
  "<p>IGNORED_BODY</p></ac:rich-text-body></ac:structured-macro>" +
  '<ac:structured-macro ac:name="scroll-only"><ac:parameter ac:name="exporter">word</ac:parameter>' +
  "<ac:rich-text-body><p>WORD_ONLY_BODY</p></ac:rich-text-body></ac:structured-macro>" +
  '<ac:structured-macro ac:name="scroll-only"><ac:parameter ac:name="exporter">pdf</ac:parameter>' +
  "<ac:rich-text-body><p>PDF_ONLY_BODY</p></ac:rich-text-body></ac:structured-macro>";

const PAGE = {
  id: PAGE_ID,
  title: "Keep Ignored Fixture",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-21T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-21T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: {
      when: "2026-07-21T00:00:00.000Z",
      by: { accountId: "acc-1", displayName: "Fixture Author" },
    },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: STORAGE, representation: "storage" } },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${PAGE_ID}` },
};

interface CliReport {
  issues: { code: string; severity: string; message?: string }[];
  exitCode: number;
}

let server: ReturnType<typeof Bun.serve>;
let dir: string;
let template: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      unmatched.push(pathname);
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  dir = await mkdtemp(join(tmpdir(), "atlcli-keep-ignored-"));
  template = join(dir, "plain.docx");
  await writeFile(
    template,
    buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
      date: new Date(0),
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function exportWith(name: string, extra: string[]): Promise<CliReport & { doc: string }> {
  const out = join(dir, name);
  const proc = Bun.spawn(
    [
      process.execPath,
      // Workspace packages only resolve to src/ under this condition.
      "--conditions=development",
      "run",
      CLI,
      "wiki",
      "export",
      PAGE_ID,
      "--base-url",
      server.url.origin,
      "--auth-type",
      "bearer",
      "--allow-http",
      "--engine",
      "ts",
      "--template",
      template,
      ...extra,
      "-o",
      out,
      "--json",
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
  expect(unmatched).toEqual([]);
  expect(exitCode, stderr).toBe(0);
  let report: CliReport;
  try {
    report = JSON.parse(stdout) as CliReport;
  } catch {
    throw new Error(`stdout was not an export report.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const doc = readPart(new Uint8Array(await readFile(out)), "word/document.xml");
  return { ...report, doc };
}

describe("--engine ts: --keep-ignored reaches the walk that actually runs", () => {
  it("applies every export control by default", async () => {
    const { doc, issues } = await exportWith("default.docx", []);
    // The page really did export — otherwise the absences below prove nothing.
    expect(doc).toContain("ALWAYS_VISIBLE");
    expect(doc).not.toContain("IGNORED_BODY");
    // Also pins the OTHER half of the pre-walk's options: `exporter: "word"`.
    // A fix that threaded `exportControls` through but dropped `exporter`
    // would keep both of these instead.
    expect(doc).toContain("WORD_ONLY_BODY");
    expect(doc).not.toContain("PDF_ONLY_BODY");
    expect(issues.map((i) => i.code)).toContain("scroll-ignore-applied");
  }, HOSTED_TEST_TIMEOUT_MS);

  it("keeps the ignored body with --keep-ignored, and says so in the report", async () => {
    const { doc, issues } = await exportWith("kept.docx", ["--keep-ignored"]);
    expect(doc).toContain("ALWAYS_VISIBLE");
    // The regression: this was absent even though the flag was accepted and
    // `exportControls: "passthrough"` reached `runExport`.
    expect(doc).toContain("IGNORED_BODY");
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("export-controls-passthrough");
    expect(codes).not.toContain("scroll-ignore-applied");
  }, HOSTED_TEST_TIMEOUT_MS);

  it("passthrough is total — it bypasses exporter routing too", async () => {
    // `passthrough` returns the body before `classifyExporterParam` runs
    // (export-blocks.ts:1823), so a `scroll-only[pdf]` body is kept as well.
    // That is the point of the flag — the export is a debugging view of the
    // source, not a representative run — and this pins it against a later
    // "fix" that narrows passthrough to scroll-ignore alone.
    const { doc } = await exportWith("kept-total.docx", ["--keep-ignored"]);
    expect(doc).toContain("WORD_ONLY_BODY");
    expect(doc).toContain("PDF_ONLY_BODY");
  }, HOSTED_TEST_TIMEOUT_MS);
});

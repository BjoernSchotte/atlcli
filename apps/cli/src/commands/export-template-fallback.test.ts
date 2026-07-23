/**
 * Template handling for the TypeScript DOCX engine
 * (spec 010 W3-D). Two gaps, one root cause: the ts engine used to accept any
 * `.docx` as a template and never say what it could not fill.
 *
 *  Gap 1 — a docxtpl/Jinja template exports with its `{{ … }}` placeholders as
 *          visible literal text. That must be a WARNING (so `--strict` bites in
 *          CI) naming actual examples, not a bare count, and not a refusal.
 *  Gap 2 — `--template` was mandatory, which is what pushed a first-time ts user
 *          toward grabbing whatever `.docx` was at hand (the mistake that
 *          produced Gap 1's finding). On `--engine ts` it is now optional and
 *          falls back to the bundled default, reported as an `info` note.
 *          the removed Python engine fails with a migration message.
 *
 * NO MOCKS: a real Bun HTTP server stands in for the Confluence REST API and the
 * real CLI runs in its own process against it, writing a real `.docx` to disk —
 * the established pattern from `export-report-flag.test.ts` /
 * `export-strict-severity.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, headingStyle, para, readPart, stylesXml } from "@atlcli/docx/fixtures";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "1126250001";

/** Requests the stub could not answer — surfaced in the failure message. */
const unmatched: string[] = [];

const PAGE = {
  id: PAGE_ID,
  title: "Template Fallback Fixture",
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
  body: {
    storage: { value: "<h1>Heading</h1><p>Ordinary prose body.</p>", representation: "storage" },
  },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${PAGE_ID}` },
};

interface CliIssue {
  code: string;
  severity: "error" | "warning" | "info";
  phase: string;
  message?: string;
}
interface CliReport {
  schema: string;
  issues: CliIssue[];
  outputs: string[];
  exitCode: number;
}

let server: ReturnType<typeof Bun.serve>;
let dir: string;
/** A docxtpl template: Jinja placeholders, not one `$scroll.*`. */
let jinjaTemplate: string;
/** A clean `$scroll.*` template — the control for every assertion below. */
let scrollTemplate: string;

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

  dir = await mkdtemp(join(tmpdir(), "atlcli-template-fallback-"));
  const styles = stylesXml(headingStyle("Heading1", "Heading 1"));

  jinjaTemplate = join(dir, "docxtpl.docx");
  await writeFile(
    jinjaTemplate,
    buildDocx({
      body:
        para("{{ title }}") +
        para("{{ author }}") +
        para("{{ spaceName }}") +
        para("{%p content %}"),
      styles,
      date: new Date(0),
    })
  );

  scrollTemplate = join(dir, "scroll.docx");
  await writeFile(
    scrollTemplate,
    buildDocx({ body: para("$scroll.title") + para("$scroll.content"), styles, date: new Date(0) })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
      ...args,
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
  return { stdout, stderr, exitCode };
}

function parseReport(stdout: string, stderr: string): CliReport {
  try {
    return JSON.parse(stdout) as CliReport;
  } catch {
    throw new Error(`stdout was not an export report.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

describe("Gap 2: --template is optional on --engine ts", () => {
  it("exports with the bundled default and says which template it used", async () => {
    const out = join(dir, "default.docx");
    const { stdout, stderr, exitCode } = await runCli(["--engine", "ts", "-o", out, "--json"]);
    expect(unmatched).toEqual([]);
    expect(exitCode, stderr).toBe(0);

    const report = parseReport(stdout, stderr);
    const note = report.issues.find((i) => i.code === "template-default-used");
    expect(note, `issues: ${JSON.stringify(report.issues.map((i) => i.code))}`).toBeDefined();
    // `info`, not `warning`: nothing is wrong with this export, so it must not
    // fail a `--strict` CI build (see the strict case below).
    expect(note!.severity).toBe("info");
    expect(note!.message).toMatch(/bundled default template/i);

    // The whole point of the fallback: a document with NOTHING left unfilled.
    const doc = readPart(new Uint8Array(await readFile(out)), "word/document.xml");
    expect(doc).not.toContain("$scroll.");
    expect(doc).not.toContain("{{");
    expect(doc).not.toContain("{%");
    expect(doc).toContain(PAGE.title); // $scroll.title really was substituted
    expect(doc).toContain("Ordinary prose body."); // $scroll.content really was
  }, 60_000);

  it("the bundled-default export is clean under --strict", async () => {
    const { exitCode, stderr } = await runCli([
      "--engine",
      "ts",
      "-o",
      join(dir, "default-strict.docx"),
      "--strict",
      "--json",
    ]);
    expect(exitCode, stderr).toBe(0);
  }, 60_000);

  it("mentions the fallback on stderr in text mode, where the report is not printed", async () => {
    const { exitCode, stderr } = await runCli([
      "--engine",
      "ts",
      "-o",
      join(dir, "default-text.docx"),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stderr).toMatch(/no --template given; using the bundled default template/);
  }, 60_000);

  it("rejects the removed Python engine with a migration message", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "--engine",
      "python",
      "-o",
      join(dir, "python.docx"),
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/Python DOCX exporter is no longer supported/);
    expect(`${stdout}${stderr}`).toMatch(/TypeScript DOCX engine is now the default/);
  }, 30_000);
});

describe("Gap 1: a docxtpl/Jinja template is reported, not silently rendered", () => {
  it("warns, names examples, and fails --strict", async () => {
    const out = join(dir, "jinja.docx");
    const { stdout, stderr, exitCode } = await runCli([
      "--engine",
      "ts",
      "--template",
      jinjaTemplate,
      "-o",
      out,
      "--strict",
      "--json",
    ]);
    // Exit 2 = "completed with warnings under --strict". This is the whole
    // point: `info` (the pre-fix `no-content-placeholder`) would exit 0.
    expect(exitCode, stderr).toBe(2);

    const report = parseReport(stdout, stderr);
    const note = report.issues.find((i) => i.code === "template-foreign-placeholders");
    expect(note, `issues: ${JSON.stringify(report.issues.map((i) => i.code))}`).toBeDefined();
    expect(note!.severity).toBe("warning");
    // Actionable: the reader must recognise their OWN template, so the note
    // names the offending placeholders rather than counting them.
    expect(note!.message).toContain("{{ title }}");
    expect(note!.message).toContain("{{ author }}");
    expect(note!.message).toContain("$scroll.");

    // And the document was still produced, with the placeholders left literal —
    // exactly what the note says happens.
    const doc = readPart(new Uint8Array(await readFile(out)), "word/document.xml");
    expect(doc).toContain("{{ title }}");
  }, 60_000);

  it("says nothing about foreign placeholders for a clean $scroll.* template", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "--engine",
      "ts",
      "--template",
      scrollTemplate,
      "-o",
      join(dir, "scroll-out.docx"),
      "--strict",
      "--json",
    ]);
    expect(exitCode, stderr).toBe(0);
    const report = parseReport(stdout, stderr);
    expect(report.issues.map((i) => i.code)).not.toContain("template-foreign-placeholders");
    // …nor the default-template note: this run named its own template.
    expect(report.issues.map((i) => i.code)).not.toContain("template-default-used");
  }, 60_000);
});

/**
 * `-t` is the documented short form of `--template` — in `--help`, in the option
 * table of `docs/confluence/export.md`, and in worked examples in both. It was
 * read nowhere, so `-t` fell through to the bundled default and reported
 * `template-default-used`: a documented option accepted and silently ignored,
 * the same class as Gap 1 above.
 *
 * Both halves are asserted deliberately. The absence of the note alone would
 * pass if the flag were read and the template still ignored, and the presence of
 * template content alone would pass if the default happened to contain it — so
 * the document must come FROM the named template, and the note must be gone.
 */
describe("short flag aliases the help advertises", () => {
  it("-t names the template, exactly like --template", async () => {
    const out = join(dir, "short-t.docx");
    const { stdout, stderr, exitCode } = await runCli([
      "--engine",
      "ts",
      "-t",
      jinjaTemplate,
      "-o",
      out,
      "--json",
    ]);
    expect(exitCode, stderr).toBe(0);
    const report = parseReport(stdout, stderr);

    // (a) the export used THIS template: the Jinja fixture's own placeholders
    //     survive as literal text (and the bundled default has none of them).
    const doc = readPart(new Uint8Array(await readFile(out)), "word/document.xml");
    expect(doc).toContain("{{ title }}");
    expect(report.issues.map((i) => i.code)).toContain("template-foreign-placeholders");
    // (b) …and the CLI did not fall back.
    expect(report.issues.map((i) => i.code)).not.toContain("template-default-used");
  }, 60_000);

  it("-t is rejected with --format pdf, like the long spelling", async () => {
    // The PDF guard checks PRESENCE. Rejecting only `--template` would let `-t`
    // through into an export that silently ignores it.
    const { stdout, stderr, exitCode } = await runCli([
      "--format",
      "pdf",
      "-t",
      scrollTemplate,
      "-o",
      join(dir, "short-t.pdf"),
      "--json",
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("--template is DOCX-only");
  }, 60_000);

  it("-o names the output file, exactly like --output", async () => {
    const out = join(dir, "short-o.docx");
    const { stderr, exitCode } = await runCli([
      "--engine",
      "ts",
      "--template",
      scrollTemplate,
      "-o",
      out,
      "--json",
    ]);
    expect(exitCode, stderr).toBe(0);
    const doc = readPart(new Uint8Array(await readFile(out)), "word/document.xml");
    expect(doc).toContain(PAGE.title);
  }, 60_000);
});

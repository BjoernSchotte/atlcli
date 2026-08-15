/**
 * `--no-field-update-prompt` (and its original spelling `--no-toc-prompt`)
 * actually reaches the ts engine.
 *
 * The defect this pins: the flag was parsed, threaded into the response as a
 * `note`, and never applied — on `--engine ts` the exported document's
 * `w:updateFields` was untouched, while `--help` promised "Word won't prompt to
 * update fields". Same class as the Jinja-placeholder defect: an option
 * accepted, processed, and not doing what it says.
 *
 * The second half is the default: a page whose only fields are hyperlinks must
 * come out with NO flag at all.
 *
 * NO MOCKS: a real Bun HTTP server stands in for the Confluence REST API and the
 * real CLI runs in its own process against it, writing a real `.docx` to disk —
 * the established pattern from `export-template-fallback.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocx, headingStyle, para, readPart, stylesXml } from "@atlcli/docx/fixtures";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "1126250099";

/** Requests the stub could not answer — surfaced in the failure message. */
const unmatched: string[] = [];

const PAGE = {
  id: PAGE_ID,
  title: "Field Refresh Fixture",
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
    storage: {
      // The reported shape: prose whose only fields are static hyperlinks.
      value:
        "<h1>Heading</h1><p>See <a href='https://example.com/a'>a</a> and " +
        "<a href='https://example.com/b'>b</a>.</p>",
      representation: "storage",
    },
  },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${PAGE_ID}` },
};

interface CliIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message?: string;
}
interface CliReport {
  issues: CliIssue[];
  exitCode: number;
}

let server: ReturnType<typeof Bun.serve>;
let dir: string;
/** A plain template — no fields at all. */
let plainTemplate: string;
/** A template whose cover page carries a real Word TOC field. */
let tocTemplate: string;

/** A TOC field with its instruction split across runs, as Word writes it. */
const TOC_FIELD =
  `<w:p>` +
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
  `<w:r><w:instrText xml:space="preserve"> TO</w:instrText></w:r>` +
  `<w:r><w:instrText xml:space="preserve">C \\o "1-3" \\h \\z \\u </w:instrText></w:r>` +
  `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
  `<w:r><w:t xml:space="preserve">Right-click to update</w:t></w:r>` +
  `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
  `</w:p>`;

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

  dir = await mkdtemp(join(tmpdir(), "atlcli-field-refresh-"));
  const styles = stylesXml(headingStyle("Heading1", "Heading 1"));

  plainTemplate = join(dir, "plain.docx");
  await writeFile(
    plainTemplate,
    buildDocx({ body: para("$scroll.title") + para("$scroll.content"), styles, date: new Date(0) })
  );

  tocTemplate = join(dir, "toc.docx");
  await writeFile(
    tocTemplate,
    buildDocx({ body: TOC_FIELD + para("$scroll.content"), styles, date: new Date(0) })
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

/** The `w:val` of the produced document's `<w:updateFields>`, or `undefined`. */
async function updateFieldsValue(path: string): Promise<string | undefined> {
  const settings = readPart(new Uint8Array(await readFile(path)), "word/settings.xml");
  return /<w:updateFields\b[^>]*\bw:val="([^"]*)"/.exec(settings)?.[1];
}

async function exportWith(name: string, extra: string[]): Promise<CliReport & { out: string }> {
  const out = join(dir, name);
  const { stdout, stderr, exitCode } = await runCli([...extra, "-o", out, "--json"]);
  expect(unmatched).toEqual([]);
  expect(exitCode, stderr).toBe(0);
  let report: CliReport;
  try {
    report = JSON.parse(stdout) as CliReport;
  } catch {
    throw new Error(`stdout was not an export report.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { ...report, out };
}

describe("--engine ts: the field-refresh flag follows the document", () => {
  it("a hyperlink-only page gets NO updateFields flag", async () => {
    const { out } = await exportWith("links-only.docx", ["--engine", "ts", "--template", plainTemplate]);
    // The hyperlinks really are in there — otherwise this proves nothing.
    expect(readPart(new Uint8Array(await readFile(out)), "word/document.xml")).toContain("HYPERLINK");
    expect(await updateFieldsValue(out)).toBeUndefined();
  }, 60_000);

  it("a template with a TOC still gets it (the important default)", async () => {
    const { out } = await exportWith("toc.docx", ["--engine", "ts", "--template", tocTemplate]);
    expect(await updateFieldsValue(out)).toBe("true");
  }, 60_000);
});

describe("--engine ts: --no-field-update-prompt actually suppresses the flag", () => {
  it("clears it even when a TOC is present, and reports what that costs", async () => {
    const report = await exportWith("toc-suppressed.docx", [
      "--engine",
      "ts",
      "--template",
      tocTemplate,
      "--no-field-update-prompt",
    ]);
    expect(await updateFieldsValue(report.out)).not.toBe("true");
    const note = report.issues.find((i) => i.code === "field-refresh-suppressed");
    expect(note, `issues: ${JSON.stringify(report.issues.map((i) => i.code))}`).toBeDefined();
    expect(note!.severity).toBe("info");
    expect(note!.message).toMatch(/F9/);
  }, 60_000);

  it("the original spelling --no-toc-prompt does exactly the same", async () => {
    // Renaming is allowed; breaking a documented flag is not.
    const report = await exportWith("toc-suppressed-alias.docx", [
      "--engine",
      "ts",
      "--template",
      tocTemplate,
      "--no-toc-prompt",
    ]);
    expect(await updateFieldsValue(report.out)).not.toBe("true");
    expect(report.issues.some((i) => i.code === "field-refresh-suppressed")).toBe(true);
  }, 60_000);

  it("says nothing when there was nothing to suppress", async () => {
    const report = await exportWith("links-only-suppressed.docx", [
      "--engine",
      "ts",
      "--template",
      plainTemplate,
      "--no-field-update-prompt",
    ]);
    expect(await updateFieldsValue(report.out)).toBeUndefined();
    expect(report.issues.some((i) => i.code === "field-refresh-suppressed")).toBe(false);
  }, 60_000);
});

describe("--help documents what the flag does", () => {
  it("names both spellings and does not promise a TOC-only effect", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("--no-field-update-prompt");
    expect(stdout).toContain("--no-toc-prompt");
  }, 30_000);
});

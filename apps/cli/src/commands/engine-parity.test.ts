import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { storageToBlocks, type ExportBlock } from "@atlcli/confluence";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { ensurePdfFonts } from "../../../../packages/pdf/scripts/ensure-fonts.js";

/**
 * python→ts engine parity checklist (spec 008 T3.5). Scope is measurement + the
 * migration path — the default-engine flip is its own later PR. Two layers:
 *
 * 1. OFFLINE (always runs): both engines consume the SAME `ExportBlock[]`
 *    contract from `storageToBlocks`; the tests below pin the
 *    observable-feature matrix that contract must carry, so a regression in the
 *    shared source model (which would silently diverge both engines) is caught
 *    without Python, a template, or the network.
 * 2. LIVE dual-engine render diff (gated `ATLCLI_PARITY=1`, second describe
 *    below): exports the SAME page through `--engine python` and `--engine ts`
 *    and diffs observable DOCX features (tables, heading texts) from the two
 *    produced documents. Needs Python + a template + a live DOCSY page — the
 *    orchestrator runs it.
 *
 * Intentional, documented differences (NOT parity gaps):
 *   - Templates: ts uses Scroll placeholders ($scroll.title); python uses Jinja2.
 *   - SVG images: python may embed; ts embeds PNG/JPEG/GIF (SVG pending) — image
 *     counts are therefore NOT diffed below.
 *   - `--include-children` merge: python legacy behavior; ts uses `--scope tree`.
 *   - List numbering: native numbering parity depends on T1.13 (tracked) —
 *     numbering XML is not diffed below.
 */

const FIXTURE_STORAGE = `
<h1>Title</h1>
<p>Intro with a <a href="https://example.com">link</a> and <strong>bold</strong>.</p>
<h2>Section</h2>
<ul><li>first</li><li>second</li></ul>
<ol><li>one</li><li>two</li></ol>
<table><tbody>
  <tr><th>Col A</th><th>Col B</th></tr>
  <tr><td>1</td><td>2</td></tr>
</tbody></table>
<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>
`;

function collectTypes(blocks: ExportBlock[]): Set<string> {
  const types = new Set<string>();
  const walk = (list: ExportBlock[]): void => {
    for (const block of list) {
      types.add(block.type);
      switch (block.type) {
        case "callout":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return types;
}

describe("engine parity checklist — shared block model (spec 008 T3.5)", () => {
  it("carries every observable feature both engines must render", () => {
    const { blocks } = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" });
    const types = collectTypes(blocks);
    for (const feature of ["heading", "paragraph", "list", "table", "image", "codeBlock"]) {
      expect(types.has(feature)).toBe(true);
    }
    // Ordered + unordered lists both present.
    const lists = blocks.filter((b): b is Extract<ExportBlock, { type: "list" }> => b.type === "list");
    expect(lists.some((l) => l.ordered)).toBe(true);
    expect(lists.some((l) => !l.ordered)).toBe(true);
    // Heading levels preserved (h1 → level 1, h2 → level 2).
    const headings = blocks.filter((b): b is Extract<ExportBlock, { type: "heading" }> => b.type === "heading");
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
  });

  it("is deterministic — the same storage yields identical blocks across runs", () => {
    const a = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" }).blocks;
    const b = storageToBlocks(FIXTURE_STORAGE, { exporter: "word" }).blocks;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/**
 * MACRO-REPORT parity (spec 010). Layer 1.5: both engines, driven through the
 * REAL CLI against a real Bun HTTP server standing in for the Confluence REST
 * API (no fetch mocking — the CLI runs in its own process), must describe the
 * same macros the same way, in the aggregate AND per source page.
 *
 * The defect this pins: the CLI walks the storage itself (to pre-resolve
 * @mentions) and hands the engine the blocks plus the walker notes. The DOCX
 * engine dropped those notes on the floor before macro resolution, so the
 * provisional `unknown-macro` survived NEXT TO the terminal `macro-rendered-via`
 * that was supposed to replace it — the aggregate reported one live-rendered
 * macro twice, once as rendered and once as not rendered. On the PDF side the
 * aggregate was already reconciled, but `sourcePages[].notes` was projected from
 * the PRE-resolution walk and kept telling the same lie one level down.
 *
 * The fixture carries TWO macros with a non-macro note between them, and only
 * the SECOND resolves live (the stub serves an `export_view` fragment for its
 * macro id only). Pairing is positional, so an off-by-one would attach
 * "rendered" to the macro that did not render — visible as a swapped order in
 * the per-page projection asserted below.
 */
const MACRO_PAGE_ID = "1126236245";
const LIVE_MACRO_ID = "live-macro";
const DEAD_MACRO_ID = "dead-macro";
const MACRO_STORAGE =
  `<p>Before</p>` +
  `<ac:structured-macro ac:name="acme-quiet" ac:macro-id="${DEAD_MACRO_ID}"/>` +
  `<ac:image/>` +
  `<ac:structured-macro ac:name="acme-widget" ac:macro-id="${LIVE_MACRO_ID}"/>` +
  `<p>After</p>`;

/** The one note ordering both engines must agree on, per source page. */
const EXPECTED_SOURCE_PAGE_CODES = ["macro-degraded", "image-unresolved", "macro-rendered-via"];
const MACRO_CODES = new Set([
  "unknown-macro",
  "macro-not-rendered",
  "macro-rendered-via",
  "macro-degraded",
  "macro-skipped-by-config",
]);

const MACRO_PAGE = {
  id: MACRO_PAGE_ID,
  title: "Macro Report Parity",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-20T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: MACRO_STORAGE, representation: "storage" } },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${MACRO_PAGE_ID}` },
};

/** Only the LIVE macro id has a server-rendered fragment — the other must degrade. */
const EXPORT_VIEW_HTML = `<div data-macro-id="${LIVE_MACRO_ID}"><p>LIVE RENDERED TABLE</p></div>`;

interface CliReport {
  notesByCode?: Record<string, number>;
  sourcePages: { id: string; notes: { code: string }[] }[];
  issues: { code: string }[];
}

describe("macro-report parity across engines (spec 010)", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
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
        if (url.pathname === `/rest/api/content/${MACRO_PAGE_ID}`) {
          // One route, two shapes: the batched export_view fetch (spec 004
          // T1.10) asks for `body.export_view`; everything else is page details.
          if ((url.searchParams.get("expand") ?? "").includes("body.export_view")) {
            return Response.json({ body: { export_view: { value: EXPORT_VIEW_HTML } }, version: { number: 1 } });
          }
          return Response.json(MACRO_PAGE);
        }
        unmatched.push(`${url.pathname}?${url.searchParams}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dir = await mkdtemp(join(tmpdir(), "atlcli-macro-parity-"));
    templatePath = join(dir, "parity.docx");
    await writeFile(templatePath, buildDocx({ body: para("$scroll.content"), date: new Date(0) }));
  });

  afterAll(async () => {
    server?.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<CliReport> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        "run",
        CLI,
        "wiki",
        "export",
        MACRO_PAGE_ID,
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
    expect(exitCode, `CLI failed (${args.join(" ")}):\n${stderr}`).toBe(0);
    return JSON.parse(stdout) as CliReport;
  }

  const macroCounts = (codes: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const code of codes) if (MACRO_CODES.has(code)) out[code] = (out[code] ?? 0) + 1;
    return out;
  };

  it("reports a live-rendered macro exactly once, in the aggregate and per page, on both engines", async () => {
    const docx = await runCli(["--engine", "ts", "--template", templatePath, "-o", join(dir, "out.docx")]);
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "out.pdf")]);
    expect(unmatched).toEqual([]);

    // 1. Aggregate: the terminal outcome REPLACED the provisional note; the
    //    live-rendered macro is reported once, the unrenderable one once.
    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      const counts = macroCounts(report.issues.map((i) => i.code));
      expect(counts, `${engine} aggregate macro notes`).toEqual({
        "macro-rendered-via": 1,
        "macro-degraded": 1,
      });
      expect(report.notesByCode?.["macro-not-rendered"], `${engine} notesByCode`).toBeUndefined();
      expect(report.notesByCode?.["unknown-macro"], `${engine} notesByCode`).toBeUndefined();
    }

    // 2. Per source page: same story one level down — no surviving "this macro
    //    did not render" next to the macro that did, non-macro notes untouched,
    //    and the two terminal notes in the order their macros appear (an
    //    off-by-one pairing swaps them).
    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      expect(report.sourcePages, `${engine} sourcePages`).toHaveLength(1);
      expect(report.sourcePages[0]!.id).toBe(MACRO_PAGE_ID);
      expect(report.sourcePages[0]!.notes.map((n) => n.code), `${engine} sourcePages[0].notes`).toEqual(
        EXPECTED_SOURCE_PAGE_CODES
      );
    }

    // 3. The cross-engine claim itself: identical input ⇒ identical macro note
    //    codes, aggregate and per page.
    expect(macroCounts(pdf.issues.map((i) => i.code))).toEqual(macroCounts(docx.issues.map((i) => i.code)));
    expect(pdf.sourcePages[0]!.notes.map((n) => n.code)).toEqual(docx.sourcePages[0]!.notes.map((n) => n.code));
  }, 300_000);
});

/**
 * LIVE dual-engine render diff (layer 2). GATED: needs Python (`packages/
 * export` venv or system install), a Scroll-style template, a configured
 * profile, and a live page — which per the project's hard E2E rule MUST live in
 * space DOCSY. Env: ATLCLI_PARITY=1, ATLCLI_PARITY_PAGE_ID (DOCSY page id),
 * ATLCLI_PARITY_TEMPLATE (template path usable by BOTH engines),
 * ATLCLI_PARITY_PROFILE (default "mayflower").
 */
const PARITY = process.env.ATLCLI_PARITY === "1";

describe.skipIf(!PARITY)("dual-engine render diff (live, DOCSY)", () => {
  it("python and ts render the same tables and heading texts from one page", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { unzipDocx } = await import("@atlcli/docx/scan");

    const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
    const pageId = process.env.ATLCLI_PARITY_PAGE_ID!;
    const template = process.env.ATLCLI_PARITY_TEMPLATE!;
    const profile = process.env.ATLCLI_PARITY_PROFILE ?? "mayflower";
    expect(pageId).toBeTruthy();
    expect(template).toBeTruthy();

    const dir = await mkdtemp(join(tmpdir(), "atlcli-parity-"));
    try {
      const outputs: Record<string, string> = {
        python: join(dir, "python.docx"),
        ts: join(dir, "ts.docx"),
      };
      for (const [engine, out] of Object.entries(outputs)) {
        const proc = Bun.spawn(
          ["bun", "--conditions=development", "run", cli, "wiki", "export", pageId, "--profile", profile, "--engine", engine, "--template", template, "-o", out, "--json"],
          { stdout: "pipe", stderr: "pipe", env: { ...process.env, ATLCLI_SUPPRESS_ENGINE_NOTICE: "1" } }
        );
        expect(await proc.exited).toBe(0);
      }

      const documentXml = async (path: string): Promise<string> => {
        const zip = unzipDocx(new Uint8Array(await readFile(path)));
        return zip.file("word/document.xml")?.asText() ?? "";
      };
      const [pythonXml, tsXml] = await Promise.all([
        documentXml(outputs.python),
        documentXml(outputs.ts),
      ]);

      // Observable-feature diff. Image counts and numbering XML deliberately
      // excluded (documented intentional differences above).
      const tableCount = (xml: string): number => (xml.match(/<w:tbl[ >]/g) ?? []).length;
      expect(tableCount(tsXml)).toBe(tableCount(pythonXml));

      const headingTexts = (xml: string): string[] =>
        [...xml.matchAll(/<w:p\b[^>]*>(?:(?!<\/w:p>).)*?w:val="Heading[1-6]"(?:(?!<\/w:p>).)*?<\/w:p>/gs)]
          .map((match) => [...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("").trim())
          .filter(Boolean);
      expect(new Set(headingTexts(tsXml))).toEqual(new Set(headingTexts(pythonXml)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

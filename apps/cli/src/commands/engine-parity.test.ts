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
  issues: { code: string; message?: string }[];
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
 * MENTION-NOTE parity (spec 010). Same shape as the macro-report suite above —
 * the REAL CLI, a real Bun HTTP server standing in for the Confluence REST API,
 * no fetch mocking — pinning a different cross-engine divergence.
 *
 * The defect this pins: BOTH export paths push a `mention-unresolved` note into
 * the source notes they hand the engine, and both engines return it on
 * `report.notes`, which `pdfReportContributions`/its DOCX counterpart map onto
 * report issues. The PDF host then appended a SECOND, hand-built
 * `mention-unresolved` issue from `scope.mentionUnresolved`, so one unresolvable
 * account id was counted twice: `notesByCode["mention-unresolved"]` read 2 on
 * `--format pdf` and 1 on `--engine ts`. Under `--strict` the duplicate also
 * inflated the warning count for a single fact.
 *
 * The engine-borne note is the one that survives: it carries the message with
 * the unresolved COUNT, and it rides the same channel as every other note. The
 * message assertions below are therefore load-bearing — dropping the note
 * instead of the hand-built issue would leave a bare, message-less code and fail
 * here.
 */
const MENTION_PAGE_ID = "1126236301";
/** Deliberately unknown to the stubbed user lookup — that is the whole fixture. */
const GHOST_ACCOUNT_ID = "ghost-account-id";
const MENTION_STORAGE =
  `<p>Reviewed by <ac:link><ri:user ri:account-id="${GHOST_ACCOUNT_ID}"/></ac:link>.</p>`;

const MENTION_PAGE = {
  id: MENTION_PAGE_ID,
  title: "Mention Report Parity",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-20T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: MENTION_STORAGE, representation: "storage" } },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${MENTION_PAGE_ID}` },
};

interface MentionCliReport extends CliReport {
  warnings: { code: string; message?: string }[];
}

describe("mention-note parity across engines (spec 010)", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
  const unmatched: string[] = [];
  /** Account ids the CLI actually asked about — proof the fixture is live. */
  const userLookups: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let templatePath: string;

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === `/rest/api/content/${MENTION_PAGE_ID}`) {
          return Response.json(MENTION_PAGE);
        }
        // The user lookup answers 404 for every account id: the mention can
        // never resolve to a display name, so exactly one `mention-unresolved`
        // fact exists for both engines to report.
        if (url.pathname === "/rest/api/user") {
          userLookups.push(url.searchParams.get("accountId") ?? "");
          return new Response(JSON.stringify({ message: "stub: no such user" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        unmatched.push(`${url.pathname}?${url.searchParams}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dir = await mkdtemp(join(tmpdir(), "atlcli-mention-parity-"));
    templatePath = join(dir, "parity.docx");
    await writeFile(templatePath, buildDocx({ body: para("$scroll.content"), date: new Date(0) }));
  });

  afterAll(async () => {
    server?.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[], expectedExit: number): Promise<MentionCliReport> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        "run",
        CLI,
        "wiki",
        "export",
        MENTION_PAGE_ID,
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
    expect(exitCode, `CLI exit (${args.join(" ")}):\n${stderr}`).toBe(expectedExit);
    return JSON.parse(stdout) as MentionCliReport;
  }

  const docxArgs = (name: string): string[] => [
    "--engine",
    "ts",
    "--template",
    templatePath,
    "-o",
    join(dir, name),
  ];

  it("counts one unresolvable mention exactly once on both engines", async () => {
    // The fixture must really drive a user lookup on BOTH runs — otherwise the
    // assertions below would be vacuously satisfied by zero notes.
    const beforeDocx = userLookups.length;
    const docx = await runCli(docxArgs("out.docx"), 0);
    expect(userLookups.length - beforeDocx, "docx user lookups").toBe(1);
    const beforePdf = userLookups.length;
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "out.pdf")], 0);
    expect(userLookups.length - beforePdf, "pdf user lookups").toBe(1);
    expect(new Set(userLookups)).toEqual(new Set([GHOST_ACCOUNT_ID]));
    expect(unmatched).toEqual([]);

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      expect(report.notesByCode?.["mention-unresolved"], `${engine} notesByCode`).toBe(1);
      const mentionIssues = report.issues.filter((i) => i.code === "mention-unresolved");
      expect(mentionIssues, `${engine} issues`).toHaveLength(1);
      // The surviving issue is the engine-borne note, message and all — a bare
      // hand-built code would lose the unresolved count.
      expect(mentionIssues[0]!.message, `${engine} issue message`).toBe(
        "1 mention(s) could not be resolved to a display name."
      );
    }

    // The cross-engine claim itself.
    expect(pdf.notesByCode?.["mention-unresolved"]).toBe(docx.notesByCode?.["mention-unresolved"]);
  }, 300_000);

  it("still trips --strict on both engines, counting the one warning once", async () => {
    const docx = await runCli([...docxArgs("strict.docx"), "--strict"], 2);
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "strict.pdf"), "--strict"], 2);
    expect(unmatched).toEqual([]);

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      expect(
        report.warnings.filter((w) => w.code === "mention-unresolved"),
        `${engine} strict warnings`
      ).toHaveLength(1);
    }
  }, 300_000);
});

/**
 * IMAGE-NOTE VOCABULARY parity (spec 010). Same shape again — the REAL CLI, a
 * real Bun HTTP server standing in for the Confluence REST API, no fetch
 * mocking — pinning the last cross-engine divergence in the note vocabulary.
 *
 * The defect this pins: both engines detected the same two conditions on the
 * same image and reported them under DIFFERENT codes. The PDF engine emitted
 * `pdf-image-missing-alt` / `pdf-image-skipped` where the DOCX engine emitted
 * `image-missing-alt` / `image-embed-failed`. A pipeline that greps
 * `notesByCode` for missing alt text therefore worked on one format and matched
 * nothing on the other, silently — the worst way for an accessibility gate to
 * fail.
 *
 * Note what the second pair is NOT. `pdf-image-skipped` was unified with
 * `image-embed-failed`, not with the similarly-named `image-skipped`. Reading
 * both emitters (rather than both names) shows `image-skipped` is DOCX's `info`
 * note for "this export has no image pipeline at all" — a whole-export
 * configuration fact the PDF engine cannot even represent, since
 * `preparePdfDocument` takes a REQUIRED resolver. Its assertion below is
 * therefore that `image-skipped` appears on NEITHER engine here: this fixture
 * has a working image pipeline, it just has a broken image.
 *
 * The fixture is one `<ac:image>` with no `ac:alt` whose attachment the stub
 * refuses to serve — one image carrying both conditions at once, so a fix that
 * unified one code and not the other cannot pass.
 */
const IMAGE_PAGE_ID = "1126236411";
/** No `ac:alt` (the audit condition); `ghost.png` is served by nobody (the embed condition). */
const IMAGE_STORAGE =
  `<p>Before</p><ac:image><ri:attachment ri:filename="ghost.png" /></ac:image><p>After</p>`;

const IMAGE_PAGE = {
  id: IMAGE_PAGE_ID,
  title: "Image Note Parity",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-21T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-21T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-21T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: IMAGE_STORAGE, representation: "storage" } },
  _links: { base: "https://example.invalid/wiki", webui: `/pages/${IMAGE_PAGE_ID}` },
};

describe("image-note vocabulary parity across engines (spec 010)", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
  const unmatched: string[] = [];
  /** Attachment listings the CLI actually asked for — proof the image path ran. */
  let attachmentListings = 0;
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let templatePath: string;

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        // The listing is empty, so BOTH engines' shared `tokenAssetFetcher`
        // raises `attachment "ghost.png" not found` — one per-image failure,
        // identical on both paths, without needing to serve corrupt bytes.
        if (url.pathname === `/rest/api/content/${IMAGE_PAGE_ID}/child/attachment`) {
          attachmentListings += 1;
          return Response.json({ results: [], size: 0, start: 0, limit: 50 });
        }
        if (url.pathname === `/rest/api/content/${IMAGE_PAGE_ID}`) {
          return Response.json(IMAGE_PAGE);
        }
        unmatched.push(`${url.pathname}?${url.searchParams}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dir = await mkdtemp(join(tmpdir(), "atlcli-image-parity-"));
    templatePath = join(dir, "parity.docx");
    await writeFile(templatePath, buildDocx({ body: para("$scroll.content"), date: new Date(0) }));
  });

  afterAll(async () => {
    server?.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function runCli(args: string[], expectedExit = 0): Promise<CliReport> {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        "run",
        CLI,
        "wiki",
        "export",
        IMAGE_PAGE_ID,
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
    expect(exitCode, `CLI exit (${args.join(" ")}):\n${stderr}`).toBe(expectedExit);
    return JSON.parse(stdout) as CliReport;
  }

  it("reports the same alt-text and embed-failure codes on both engines", async () => {
    const beforeDocx = attachmentListings;
    const docx = await runCli(["--engine", "ts", "--template", templatePath, "-o", join(dir, "out.docx")]);
    expect(attachmentListings - beforeDocx, "docx attachment listings").toBeGreaterThan(0);
    const beforePdf = attachmentListings;
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "out.pdf")]);
    expect(attachmentListings - beforePdf, "pdf attachment listings").toBeGreaterThan(0);
    expect(unmatched).toEqual([]);

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      // The source-page accessibility defect, under ONE code regardless of
      // output format. Audited from the source block, so a broken image is
      // audited too — which is why one fixture image carries both facts.
      expect(report.notesByCode?.["image-missing-alt"], `${engine} image-missing-alt`).toBe(1);
      // The per-image embed failure, under ONE code regardless of output format.
      expect(report.notesByCode?.["image-embed-failed"], `${engine} image-embed-failed`).toBe(1);
      // No engine-prefixed spelling of either fact survives anywhere.
      const prefixed = Object.keys(report.notesByCode ?? {}).filter((code) => code.startsWith("pdf-image"));
      expect(prefixed, `${engine} engine-prefixed image codes`).toEqual([]);
      // `image-skipped` is a DIFFERENT fact ("no image pipeline configured") and
      // must not be conflated with the failure above: this export has a pipeline.
      expect(report.notesByCode?.["image-skipped"], `${engine} image-skipped`).toBeUndefined();
    }

    // The cross-engine claim itself: identical input ⇒ identical image-note tallies.
    const imageCounts = (report: CliReport): Record<string, number> =>
      Object.fromEntries(
        Object.entries(report.notesByCode ?? {}).filter(([code]) => code.includes("image"))
      );
    expect(imageCounts(pdf)).toEqual(imageCounts(docx));
  }, 300_000);

  it("gates --strict on the same codes from both engines", async () => {
    // Both facts are `warning`-level on both engines, so a pipeline that gates
    // on them must reach the same verdict whichever format it exports — and it
    // must be able to name WHY with one set of codes.
    const docx = await runCli(
      ["--engine", "ts", "--template", templatePath, "-o", join(dir, "strict.docx"), "--strict"],
      2
    );
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "strict.pdf"), "--strict"], 2);
    expect(unmatched).toEqual([]);

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      const codes = report.issues.map((i) => i.code);
      expect(codes, `${engine} strict issues`).toContain("image-embed-failed");
      expect(codes, `${engine} strict issues`).toContain("image-missing-alt");
    }
  }, 300_000);
});

/**
 * CONFLUENCE-LIST DATASOURCE parity (spec SUPPORT-DATASOURCE-CONFLUENCE).
 *
 * Same shape as the two suites above — the REAL CLI, a real `Bun.serve` origin
 * standing in for the Confluence REST API, no fetch mocking — pinning the claim
 * that a Confluence list renders the SAME table and reports the SAME note codes
 * from the PDF and the DOCX engine.
 *
 * The page storage is the VERBATIM artifact of DOCSY page 1126236229, with only
 * the site origin rewritten to the stub's (the renderer's cross-site guard
 * compares the datasource `href` origin against the export's own site, so a
 * literal `mayflowergmbh.atlassian.net` here would correctly degrade and the
 * suite would be testing nothing).
 */
const LIST_PAGE_ID = "1126236229";
const LIST_COLUMN_KEYS = [
  "type",
  "title",
  "space",
  "description",
  "ownedBy",
  "updatedAt",
  "labels",
  "status",
];

function listStorage(origin: string): string {
  const href = `${origin}/wiki/search?text=&contributors=70121%3A666cbd78-32fa-4764-90a1-d3368305f07b`;
  const datasource = JSON.stringify({
    id: "768fc736-3af4-4a8f-b27e-203602bff8ca",
    parameters: {
      cloudId: "ca7c5cc9-632e-4985-b88e-fb2a96c0b9ca",
      contributorAccountIds: ["70121:666cbd78-32fa-4764-90a1-d3368305f07b"],
      searchString: "",
    },
    views: [{ type: "table", properties: { columns: LIST_COLUMN_KEYS.map((key) => ({ key })) } }],
  })
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  return (
    `<h2>Abschnitt 7.6</h2><p>Fachtext im Abschnitt 7.6.</p>` +
    `<a href="${href.replaceAll("&", "&amp;")}" data-card-appearance="block" ` +
    `data-datasource="${datasource}">${href.replaceAll("&", "&amp;")}</a>`
  );
}

describe("Confluence-list datasource parity across engines (spec SUPPORT-DATASOURCE-CONFLUENCE)", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
  const unmatched: string[] = [];
  /** Every CQL the CLI actually issued — proof the fixture is live. */
  const searches: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;
  let templatePath: string;

  /**
   * 150 hits against the 100-row cap: for THIS provider truncation is the
   * normal case (the live artifact matches 2 817 rows), so the parity claim has
   * to cover the truncated shape, not the comfortable one.
   */
  const SEARCH_HITS = Array.from({ length: 150 }, (_v, i) => ({
    content: {
      id: `${2000 + i}`,
      type: "page",
      status: "current",
      title: `Ergebnis ${i}`,
      space: { key: "DOCSY", name: "Docs and Systems" },
      history: {
        lastUpdated: { when: "2026-05-26T06:25:48.628Z" },
        ownedBy: { displayName: "Robert Lippert" },
      },
      metadata: { labels: { results: [{ name: "jourfixe" }] } },
      _links: { webui: `/spaces/DOCSY/pages/${2000 + i}` },
    },
    title: `Ergebnis ${i}`,
    excerpt: `Auszug ${i}`,
    url: `/spaces/DOCSY/pages/${2000 + i}`,
  }));

  const LIST_PAGE = (origin: string) => ({
    id: LIST_PAGE_ID,
    title: "M1 Abnahme Abschnitt 7.6",
    space: { key: "DOCSY" },
    version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
    ancestors: [],
    history: {
      createdDate: "2026-07-20T00:00:00.000Z",
      createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
      lastUpdated: {
        when: "2026-07-20T00:00:00.000Z",
        by: { accountId: "acc-1", displayName: "Fixture Author" },
      },
    },
    metadata: { labels: { results: [] }, properties: {} },
    body: { storage: { value: listStorage(origin), representation: "storage" } },
    _links: { base: `${origin}/wiki`, webui: `/pages/${LIST_PAGE_ID}` },
  });

  beforeAll(async () => {
    await ensurePdfFonts({ logger: () => {} });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const origin = server.url.origin;
        if (url.pathname === `/rest/api/content/${LIST_PAGE_ID}`) {
          if ((url.searchParams.get("expand") ?? "").includes("body.export_view")) {
            return Response.json({ body: { export_view: { value: "" } }, version: { number: 1 } });
          }
          return Response.json(LIST_PAGE(origin));
        }
        if (url.pathname === "/rest/api/search") {
          searches.push(url.searchParams.get("cql") ?? "");
          const limit = Number(url.searchParams.get("limit") ?? "25");
          return Response.json({
            results: SEARCH_HITS.slice(0, limit),
            start: 0,
            limit,
            size: Math.min(limit, SEARCH_HITS.length),
            totalSize: 2817,
            _links: { base: `${origin}/wiki` },
          });
        }
        unmatched.push(`${url.pathname}?${url.searchParams}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dir = await mkdtemp(join(tmpdir(), "atlcli-list-parity-"));
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
        LIST_PAGE_ID,
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

  /** Macro-note codes only, counted — same projection the suites above use. */
  const listMacroCounts = (codes: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const code of codes) if (MACRO_CODES.has(code)) out[code] = (out[code] ?? 0) + 1;
    return out;
  };

  it("renders the list live on BOTH engines, with the same note codes", async () => {
    searches.length = 0;
    const docx = await runCli(["--engine", "ts", "--template", templatePath, "-o", join(dir, "list.docx")]);
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "list.pdf")]);
    expect(unmatched).toEqual([]);

    // The CQL is composed from the FILTERS, not from the empty `searchString`.
    expect(searches).toHaveLength(2);
    for (const cql of searches) {
      expect(cql).toBe('contributor in ("70121:666cbd78-32fa-4764-90a1-d3368305f07b")');
    }

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      const counts = listMacroCounts(report.issues.map((i) => i.code));
      // The provisional walker note was REPLACED by the terminal one — the same
      // reconciliation the two suites above pin, now over a datasource macro.
      expect(counts, `${engine} macro notes`).toEqual({
        "macro-rendered-via": 1,
        "macro-degraded": 1,
      });
      expect(report.notesByCode?.["datasource-provider-unsupported"], engine).toBeUndefined();
      expect(report.notesByCode?.["macro-not-rendered"], engine).toBeUndefined();
      expect(report.notesByCode?.["unknown-macro"], engine).toBeUndefined();
    }

    // Cross-engine claim: identical input ⇒ identical codes, aggregate and per page.
    expect(listMacroCounts(pdf.issues.map((i) => i.code))).toEqual(
      listMacroCounts(docx.issues.map((i) => i.code))
    );
    expect(pdf.sourcePages[0]!.notes.map((n) => n.code)).toEqual(
      docx.sourcePages[0]!.notes.map((n) => n.code)
    );
  }, 300_000);

  it("truncates to the cap and names BOTH counts, identically on both engines", async () => {
    const docx = await runCli(["--engine", "ts", "--template", templatePath, "-o", join(dir, "t.docx")]);
    const pdf = await runCli(["--format", "pdf", "-o", join(dir, "t.pdf")]);

    for (const [engine, report] of [["docx", docx], ["pdf", pdf]] as const) {
      const note = report.issues.find((i) => i.code === "macro-degraded");
      expect(note, `${engine} truncation note`).toBeDefined();
      // Both counts: "100 of 100+" would hide that the reader sees 3.5 %.
      expect(note!.message, engine).toContain("100 of 2817");
      expect(note!.message, engine).toContain("sample");
    }
    expect(pdf.issues.find((i) => i.code === "macro-degraded")!.message).toBe(
      docx.issues.find((i) => i.code === "macro-degraded")!.message
    );
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

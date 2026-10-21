import { describe, expect, test } from "bun:test";
import { TemplateEngine, parseTemplate } from "@atlcli/core";
import { extractPageTasks, markdownToStorage } from "@atlcli/confluence";
import { buildReportData, type JiraIssue } from "@atlcli/jira";
import { BUNDLED_REPORT_TEMPLATES } from "./jira-report-templates.js";
import { REPORT_TOC_MIN_HEADINGS, decideReportTarget, reportExportFlags, reportNeedsToc } from "./jira-report.js";

const BASE = "https://x.atlassian.net";
const issue = (key: string, type: string, category: string, summary = `Summary ${key}`, description?: unknown): JiraIssue =>
  ({
    id: key,
    key,
    fields: {
      summary,
      description,
      issuetype: { id: type, name: type, subtask: false },
      status: { id: "1", name: category === "done" ? "Done" : "Open", statusCategory: { key: category } },
      assignee: { displayName: "Ann" },
    },
  }) as unknown as JiraIssue;

function render(name: string, kind: "release" | "sprint") {
  const data = buildReportData({
    kind,
    source: { id: "1", name: "1.0", releaseDate: "2026-12-01", released: true, goal: "Ship *it*", state: "closed", startDate: "2026-10-01", endDate: "2026-10-14" },
    issues: [
      issue("AB-1", "Story", "done", "Fix *all* the [things]", { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Users can *now* log in." }] }] }),
      issue("AB-2", "Bug", "new"),
    ],
    baseUrl: BASE,
    now: new Date(),
  });
  const template = { ...parseTemplate(BUNDLED_REPORT_TEMPLATES[name]!), source: { level: "global" as const, path: `bundled:${name}` } };
  return new TemplateEngine().render(template, { variables: { ...data }, builtins: {} }).content;
}

describe("bundled report templates", () => {
  test("release-notes renders groups, escaped summaries and the date lozenge", () => {
    const md = render("release-notes", "release");
    expect(md).toContain("{status:green}Released{status} · {date:2026-12-01}");
    expect(md).toContain("## Story (1)");
    expect(md).toContain(`- [AB-1](${BASE}/browse/AB-1) **Fix \\*all\\* the \\[things\\]**\\\n  Users can \\*now\\* log in.\n`);
    expect(md).toContain(`- [AB-2](${BASE}/browse/AB-2) **Summary AB-2** · *Open*\n`);
    expect(md).toContain("## Bug (1)");
    expect(md).toContain("## Contributors");
  });

  test("sprint-review renders goal panel and done / not done", () => {
    const md = render("sprint-review", "sprint");
    expect(md).toContain(":::info\n**Sprint goal:** Ship \\*it\\*\n:::");
    expect(md).toContain("## Done (1)");
    expect(md).toContain("## Not done (1)");
  });

  test("every bundled template converts to storage", () => {
    for (const name of Object.keys(BUNDLED_REPORT_TEMPLATES)) {
      const storage = markdownToStorage(render(name, name === "sprint-review" ? "sprint" : "release"), { baseUrl: BASE });
      expect(storage).toContain("AB-1");
      expect(storage).not.toContain("{{");
      expect(extractPageTasks(storage)).toEqual([]);
      // The excerpt sits on its own line inside the same list item.
      expect(storage).toMatch(/<li>(?:(?!<\/li>).)*<br\s*\/?>\s*Users can \*now\* log in\.(?:(?!<li>).)*<\/li>/s);
    }
  });
});

describe("reportNeedsToc", () => {
  test("only reports with many sections get a contents page", () => {
    const sections = (n: number) => Array.from({ length: n }, (_, i) => `## Section ${i}\n\n- item`).join("\n\n");
    expect(reportNeedsToc(sections(REPORT_TOC_MIN_HEADINGS - 1))).toBe(false);
    expect(reportNeedsToc(sections(REPORT_TOC_MIN_HEADINGS))).toBe(true);
    expect(reportNeedsToc("#### deep\n".repeat(20))).toBe(false);
  });
});

describe("decideReportTarget", () => {
  const wanted = { v: 1 as const, kind: "release" as const, jiraSite: BASE, sourceId: "10" };

  test("creates when no page has the title", () => {
    expect(decideReportTarget([], wanted, false)).toEqual({ action: "create" });
  });

  test("updates the page that carries this report's identity", () => {
    const identity = { ...wanted, contentHash: "h" };
    expect(decideReportTarget([{ id: "1" }, { id: "2", identity }], wanted, false)).toEqual({ action: "update", pageId: "2", identity });
  });

  test("refuses a same-title page atlcli did not create, unless --force", () => {
    expect(decideReportTarget([{ id: "1" }], wanted, false)).toEqual({ action: "conflict", pageId: "1" });
    expect(decideReportTarget([{ id: "1" }], wanted, true)).toEqual({ action: "update", pageId: "1" });
  });

  test("a page for another version is not ours", () => {
    const other = { ...wanted, sourceId: "11" };
    expect(decideReportTarget([{ id: "1", identity: other }], wanted, false).action).toBe("conflict");
  });
});

describe("reportExportFlags", () => {
  const long = Array.from({ length: REPORT_TOC_MIN_HEADINGS }, (_, i) => `## S${i}`).join("\n");

  test("PDF: overwrite, no cover, contents only for long reports", () => {
    expect(reportExportFlags("notes.PDF", "## One")).toEqual({ output: "notes.PDF", format: "pdf", force: true, "no-cover": true, "no-toc": true });
    expect(reportExportFlags("notes.pdf", long)).toEqual({ output: "notes.pdf", format: "pdf", force: true, "no-cover": true });
  });

  test("DOCX: overwrite only", () => {
    expect(reportExportFlags("notes.docx", "## One")).toEqual({ output: "notes.docx", format: "docx", force: true });
  });
});

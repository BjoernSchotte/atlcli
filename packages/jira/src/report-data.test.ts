import { describe, expect, test } from "bun:test";
import { buildReportData, descriptionExcerpt, escapeMarkdown } from "./report-data.js";
import type { JiraIssue } from "./types.js";

const BASE = "https://x.atlassian.net";

function issue(key: string, type: string, category: "new" | "indeterminate" | "done", extra: Record<string, unknown> = {}): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary: `Summary ${key}`,
      issuetype: { id: type, name: type, subtask: false },
      status: { id: "1", name: category, statusCategory: { key: category } },
      ...extra,
    },
  } as unknown as JiraIssue;
}

const epic = (key: string, summary: string) => ({
  parent: { id: key, key, fields: { summary, issuetype: { id: "e", name: "Epic", subtask: false, hierarchyLevel: 1 } } },
});

function build(issues: JiraIssue[], pointsField?: string) {
  return buildReportData({
    kind: "release",
    source: { id: "10", name: "1.0", releaseDate: "2026-12-01", released: true },
    issues,
    baseUrl: BASE,
    pointsField,
    now: new Date("2026-10-21T00:00:00Z"),
  });
}

describe("buildReportData", () => {
  test("groups by type in a stable order and by epic with 'No epic' last", () => {
    const data = build([
      issue("AB-10", "Bug", "done", epic("AB-1", "Login")),
      issue("AB-2", "Improvement", "new"),
      issue("AB-3", "Story", "indeterminate", epic("AB-1", "Login")),
      issue("AB-4", "Story", "done", epic("AB-5", "Export")),
    ]);
    expect(data.issues.map((i) => i.key)).toEqual(["AB-2", "AB-3", "AB-4", "AB-10"]);
    expect(data.byType.map((g) => [g.name, g.count])).toEqual([["Story", 2], ["Bug", 1], ["Improvement", 1]]);
    expect(data.byEpic.map((g) => [g.name, g.key, g.count])).toEqual([
      ["Export", "AB-5", 1],
      ["Login", "AB-1", 2],
      ["No epic", undefined, 1],
    ]);
  });

  test("metrics, links and date lozenge", () => {
    const data = build([issue("AB-1", "Task", "done"), issue("AB-2", "Task", "indeterminate"), issue("AB-3", "Task", "new")]);
    expect(data.metrics).toMatchObject({ total: 3, done: 1, inProgress: 1, todo: 1, donePercent: 33 });
    expect(data.issues[0]!.link).toBe(`[AB-1](${BASE}/browse/AB-1)`);
    expect(data.source.releaseDateMd).toBe("{date:2026-12-01}");
    expect(data.doneIssues.map((i) => i.key)).toEqual(["AB-1"]);
  });

  test("points and contributors", () => {
    const data = build(
      [
        issue("AB-1", "Task", "done", { customfield_1: 3, assignee: { displayName: "Ann" } }),
        issue("AB-2", "Task", "new", { customfield_1: 5, assignee: { displayName: "Ann" } }),
        issue("AB-3", "Task", "done", { customfield_1: 2, assignee: { displayName: "Bo" } }),
      ],
      "customfield_1"
    );
    expect(data.metrics.points).toEqual({ committed: 10, completed: 5 });
    expect(data.contributors.map((c) => [c.name, c.count])).toEqual([["Ann", 2], ["Bo", 1]]);
  });

  test("empty version", () => {
    const data = build([]);
    expect(data.metrics).toMatchObject({ total: 0, donePercent: 0 });
    expect(data.byType).toEqual([]);
  });

  test("adds an escaped description excerpt per issue", () => {
    const description = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why" }] },
        { type: "paragraph", content: [{ type: "text", text: "Users need *markdown*." }] },
      ],
    };
    const [withText, without] = build([issue("AB-1", "Task", "done", { description }), issue("AB-2", "Task", "done")]).issues;
    expect(withText).toMatchObject({ excerpt: "Why Users need *markdown*.", excerptMd: "Why Users need \\*markdown\\*." });
    expect(without!.excerpt).toBeUndefined();
  });
});

describe("descriptionExcerpt", () => {
  const p = (...content: unknown[]) => ({ type: "paragraph", content });
  const t = (text: string) => ({ type: "text", text });

  test("skips code and tables, keeps paragraphs apart, renders inline nodes", () => {
    const doc = {
      type: "doc",
      content: [
        p(t("First"), { type: "hardBreak" }, t("line, ping "), { type: "mention", attrs: { text: "@Ann" } }),
        { type: "codeBlock", content: [t("const x = 1;")] },
        { type: "table", content: [] },
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("item"))] }] },
        p({ type: "date", attrs: { timestamp: "1798761600000" } }, { type: "status", attrs: { text: "DONE" } }),
      ],
    };
    expect(descriptionExcerpt(doc)).toBe("First line, ping @Ann item 2027-01-01DONE");
  });

  test("cuts long text at a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const excerpt = descriptionExcerpt(long, 50)!;
    expect(excerpt.length).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(long.startsWith(excerpt.slice(0, -1))).toBe(true);
    expect(excerpt.slice(0, -1).endsWith(" ")).toBe(false);
  });

  test("empty, missing and whitespace-only descriptions have no excerpt", () => {
    expect(descriptionExcerpt(undefined)).toBeUndefined();
    expect(descriptionExcerpt("  \n ")).toBeUndefined();
    expect(descriptionExcerpt({ type: "doc", content: [{ type: "codeBlock", content: [t("x")] }] })).toBeUndefined();
  });
});

describe("escapeMarkdown", () => {
  test("neutralises markdown and dialect syntax", () => {
    expect(escapeMarkdown("Fix *all* [things] {status:red}x{status} :smile:")).toBe(
      "Fix \\*all\\* \\[things\\] \\{status:red\\}x\\{status\\} \\:smile:"
    );
    expect(escapeMarkdown("1. not a list")).toBe("1\\. not a list");
  });
});

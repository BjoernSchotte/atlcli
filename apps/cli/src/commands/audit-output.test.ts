import { beforeAll, expect, it } from "bun:test";
import {
  type AuditFinding,
  type AuditReportV3,
  DEFAULT_MARKDOWN_TEMPLATE,
  markdownModel,
  writeReportCsv,
  writeReportJson,
  writeReportJsonl,
} from "@atlcli/audit";
import { initJinja, renderJinja, streamJinja } from "@atlcli/jinja";
import { auditFormatOf } from "./audit-scripts.js";

beforeAll(() => initJinja());

function finding(i: number): AuditFinding {
  return {
    rule: i % 2 ? "hygiene/stale" : "flow/stuck",
    category: "hygiene",
    severity: i % 3 ? "warning" : "error",
    target: { kind: "issue", key: `P-${i}`, ...(i % 4 ? { url: `https://x.atlassian.net/browse/P-${i}` } : {}) },
    key: `P-${i}`,
    summary: `Fix "it", | now\nreally ${i}`,
    status: "In Progress",
    ...(i % 5 ? { assignee: "Ann" } : {}),
    detail: `Not updated for ${i} days.`,
    ageDays: i,
    subject: `P-${i}`,
  };
}

function report(findings: AuditFinding[]): AuditReportV3 {
  return {
    schemaVersion: "3",
    product: "jira",
    generatedAt: "2026-10-26T09:00:00.000Z",
    query: 'project = "P"',
    rules: { source: "built-in", extends: "default", minLevel: "warning" },
    summary: { total: findings.length, bySeverity: { error: 1, warning: 2, info: 0 }, byRule: { "hygiene/stale": 2 }, suppressed: { quiet: 0, baseline: 0, legacy: 0 } },
    findings,
    quiet: {},
    legacy: { "hygiene/stale": 3 },
    legacyDays: null,
    staleBaselineEntries: 0,
    partial: [],
    diagnostics: ["one", "two"],
    titles: { "hygiene/stale": "Stale", "flow/stuck": "Stuck" },
  };
}

const collect = (fn: (write: (c: string) => void) => void) => {
  const chunks: string[] = [];
  fn((c) => chunks.push(c));
  return { text: chunks.join(""), chunks: chunks.length };
};

it("writeReportJson writes exactly what JSON.stringify(report, null, 2) does, a finding at a time", () => {
  for (const findings of [[], [finding(1)], Array.from({ length: 50 }, (_, i) => finding(i))]) {
    const r = report(findings);
    const { text, chunks } = collect((w) => writeReportJson(r, w));
    expect(text).toBe(`${JSON.stringify(r, null, 2)}\n`);
    if (findings.length > 1) expect(chunks).toBeGreaterThan(findings.length);
  }
  const withUndefined = { ...report([]), partial: undefined } as unknown as AuditReportV3;
  expect(collect((w) => writeReportJson(withUndefined, w)).text).toBe(`${JSON.stringify(withUndefined, null, 2)}\n`);
});

it("writeReportJsonl and writeReportCsv write a finding per line", () => {
  const r = report([finding(1), finding(4)]);
  expect(collect((w) => writeReportJsonl(r, w)).text.trimEnd().split("\n").map((l) => JSON.parse(l))).toEqual(r.findings);
  expect(collect((w) => writeReportCsv(r, w)).text).toBe(
    [
      "severity,rule,key,summary,status,assignee,detail,ageDays,url",
      'warning,hygiene/stale,P-1,"Fix ""it"", | now\nreally 1",In Progress,Ann,Not updated for 1 days.,1,https://x.atlassian.net/browse/P-1',
      'warning,flow/stuck,P-4,"Fix ""it"", | now\nreally 4",In Progress,Ann,Not updated for 4 days.,4,',
      "",
    ].join("\r\n"),
  );
});

it("the default Markdown template streams exactly what it renders, also for a large report", () => {
  for (const n of [0, 3, 2000]) {
    const model = markdownModel(report(Array.from({ length: n }, (_, i) => finding(i))));
    const expected = renderJinja(DEFAULT_MARKDOWN_TEMPLATE, model, { lines: true }).text;
    const { text, chunks } = collect((w) => streamJinja(DEFAULT_MARKDOWN_TEMPLATE, model, w, { lines: true }));
    expect(text).toBe(expected);
    if (n === 2000) expect(chunks).toBeGreaterThan(10);
  }
}, 60_000);

it("auditFormatOf picks the format from the file extension", () => {
  expect(["a.json", "a.JSONL", "a.ndjson", "a.csv", "a.md", "report"].map(auditFormatOf)).toEqual(["json", "jsonl", "jsonl", "csv", "md", "md"]);
});

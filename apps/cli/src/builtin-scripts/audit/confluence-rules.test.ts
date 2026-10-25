/**
 * The built-in wiki (Confluence) audit rules through the audit engine, on
 * hand-built page snapshots: what each rule finds, profiles, the rules
 * file's confluence: section, and the fixes --fix plans.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type AuditPage,
  type AuditRegistry,
  type AuditRules,
  type AuditRuleScript,
  auditConfluence,
  createAuditBaseline,
  defaultAuditRules,
  parseAuditRules,
  parseConfluenceAuditRules,
} from "@atlcli/audit";
import type { ScriptPort } from "@atlcli/script-runtime";
import { loadBuiltinAuditRules, planAuditFixes, registryOf } from "../../commands/audit-scripts.js";

let scripts: AuditRuleScript[];
let registry: AuditRegistry;
beforeAll(async () => {
  scripts = await loadBuiltinAuditRules("confluence");
  registry = registryOf(scripts);
});

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const user = (id: string, active: boolean | null = true) => ({ id, displayName: id.toUpperCase(), active });

function page(id: string, p: Partial<AuditPage> = {}): AuditPage {
  return {
    id,
    title: `Page ${id}`,
    spaceKey: "DOCSY",
    path: `${id}.md`,
    url: `https://example.atlassian.net/wiki/pages/viewpage.action?pageId=${id}`,
    synced: true,
    parentId: "root",
    ancestors: ["root"],
    contentType: "page",
    status: "current",
    version: 3,
    versionCount: 3,
    wordCount: 100,
    createdAt: ago(900),
    createdBy: user("ann"),
    lastModified: ago(5),
    lastModifiedBy: user("ann"),
    labels: [],
    restricted: false,
    orphan: false,
    brokenLinks: [],
    externalLinks: [],
    contributors: [user("ann"), user("bob")],
    ...p,
  };
}

const PAGES: AuditPage[] = [
  page("1", { lastModified: ago(400), orphan: true, parentId: null, ancestors: [], contributors: [user("ann")], brokenLinks: [{ target: "./gone.md", text: "gone", line: 4 }] }),
  page("2", { status: "draft", restricted: true, versionCount: 60, contributors: [user("cy", false), user("di", false)] }),
  page("3", { lastModified: ago(800), labels: ["needs-review"], externalLinks: [{ url: "https://x.test/a", domain: "x.test", text: null, line: 1, httpStatus: 404, broken: true }] }),
  page("4", { status: "archived", lastModified: ago(200) }),
  page("9", { synced: false, path: null, lastModified: ago(30), contributors: [] }),
];

/** Rules only read the snapshots they are given; nothing reaches a port. */
const port = {} as ScriptPort;

async function run(rules: AuditRules, pages = PAGES, folderIssues: Array<{ file: string; code: string; message: string }> = []) {
  return auditConfluence({ rules, registry, scripts, pages, folderIssues, now: NOW, useBaseline: true, query: "space DOCSY" }, { port, now: NOW });
}
const ids = (findings: Array<{ rule: string; key: string; severity: string }>) => findings.map((f) => `${f.rule}:${f.key}:${f.severity}`);

describe("built-in wiki rules", () => {
  test("default profile: stale by age, orphans, broken links, contributors, folders; inventories off", async () => {
    const { report, candidates } = await run(defaultAuditRules(registry), PAGES, [{ file: "empty", code: "FOLDER_EMPTY", message: "Folder has no pages." }]);
    expect(report.product).toBe("confluence");
    expect(report.legacyDays).toBe(180);
    expect(ids(report.findings)).toEqual([
      "content/stale:3:error",
      "content/stale:1:error",
      "content/stale:4:warning",
      "links/orphan:1:warning",
      "links/broken:1:warning",
      "people/inactive-contributors:2:warning",
      "structure/folders:empty:warning",
    ]);
    expect(report.quiet).toEqual({ "people/single-contributor": 1, "content/restricted": 1, "content/draft": 1, "content/archived": 1 });
    const stale = report.findings.find((f) => f.key === "1")!;
    expect(stale).toEqual(
      expect.objectContaining({
        detail: `Not edited for 13 months (last ${ago(400).slice(0, 10)}).`,
        target: { kind: "page", key: "1", url: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=1" },
        summary: "Page 1",
        assignee: "ANN",
        fixable: true,
      }),
    );
    expect(report.findings.find((f) => f.rule === "links/broken")).toEqual(expect.objectContaining({ detail: "Broken link to ./gone.md (line 4).", subject: "1:./gone.md" }));
    expect(report.findings.find((f) => f.rule === "structure/folders")).toEqual(expect.objectContaining({ target: { kind: "other", key: "empty" }, subject: "folder:empty", status: "FOLDER_EMPTY" }));
    expect(candidates.some((f) => f.rule === "links/external-broken")).toBe(false);
  });

  test("off rules come on with settings: missing label, high churn, external links, unsynced", async () => {
    const rules = parseConfluenceAuditRules(
      {
        confluence: {
          extends: "minimal",
          minLevel: "info",
          rules: {
            "content/stale": "off",
            "content/missing-label": { severity: "warning", label: ["owner"] },
            "content/high-churn": { warning: 50 },
            "links/external-broken": "error",
            "content/unsynced": "info",
          },
        },
      },
      "rules.yaml",
      registry,
    );
    const { report } = await run(rules);
    expect(ids(report.findings)).toEqual([
      "links/broken:1:warning",
      "links/external-broken:3:error",
      "content/missing-label:1:warning",
      "content/missing-label:2:warning",
      "content/missing-label:3:warning",
      "content/missing-label:4:warning",
      "content/high-churn:2:warning",
      "content/unsynced:9:info",
    ]);
    expect(report.findings.find((f) => f.rule === "links/external-broken")!.detail).toBe("https://x.test/a is broken (HTTP 404).");
    expect(report.findings.find((f) => f.key === "3" && f.rule === "content/missing-label")!.detail).toBe("Missing label owner (has needs-review).");
  });

  test("the confluence: section is checked, and the Jira part of the file ignores it", () => {
    expect(() => parseConfluenceAuditRules({ confluence: { custom: [] } }, "r.yaml", registry)).toThrow('confluence: unknown key "custom"');
    expect(() => parseConfluenceAuditRules({ confluence: { rules: { "content/stale": { warning: "soon" } } } }, "r.yaml", registry)).toThrow(
      "confluence.rules.content/stale.warning: expected days",
    );
    expect(() => parseConfluenceAuditRules({ confluence: { rules: { "content/missing-label": { label: [] } } } }, "r.yaml", registry)).toThrow("expected text or a list of texts");
    // A Jira registry: the confluence: key is allowed at the top level.
    expect(parseAuditRules({ minLevel: "info", confluence: { minLevel: "error" } }, "r.yaml", registry).minLevel).toBe("info");
    expect(parseConfluenceAuditRules({ minLevel: "info", confluence: { minLevel: "error" } }, "r.yaml", registry).minLevel).toBe("error");
  });

  test("a baseline hides accepted findings", async () => {
    const first = await run(defaultAuditRules(registry));
    const baseline = createAuditBaseline(first.candidates.filter((f) => f.rule === "content/stale"), NOW);
    const next = await auditConfluence(
      { rules: defaultAuditRules(registry), registry, scripts, pages: PAGES, folderIssues: [], now: NOW, baseline, useBaseline: true, query: "space DOCSY" },
      { port, now: NOW },
    );
    expect(next.report.findings.some((f) => f.rule === "content/stale")).toBe(false);
    expect(next.report.summary.suppressed.baseline).toBe(3);
  });
});

describe("wiki fixes", () => {
  test("--fix plans labels for error-level stale pages, archives two-year-old pages, trashes old orphans", async () => {
    const rules = parseConfluenceAuditRules({ confluence: { rules: { "content/stale": { label: ["review-me"] } } } }, "r.yaml", registry);
    const { report } = await run(rules);
    const byId = new Map(PAGES.map((p) => [p.id, p]));
    const live = (id: string) => ({ id, title: `Page ${id}`, spaceKey: "DOCSY", version: 3, markdown: "" });
    const plan = await planAuditFixes(
      report.findings.filter((f) => f.fixable),
      scripts,
      (f) => byId.get(f.key),
      { confluenceGetPage: async (id: string) => live(id) } as unknown as ScriptPort,
      undefined,
      (f) => rules.rules[f.rule],
    );
    expect(plan.operations.map((o) => `${o.verb} ${JSON.stringify(o.args)}`)).toEqual([
      `confluence.archivePage {"id":"3","title":"Page 3"}`,
      `confluence.addLabels {"pageId":"1","labels":["review-me"]}`,
      `confluence.deletePage {"id":"1","title":"Page 1"}`,
    ]);
  });
});

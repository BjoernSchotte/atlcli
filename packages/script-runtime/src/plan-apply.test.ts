import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import { createScriptPlan, parseScriptPlan, ScriptPlanError, serializeScriptPlan, type ScriptPlanV1 } from "./plan.js";
import type { ConfluencePageView, JiraIssueView, ScriptPort } from "./port.js";
import { planScript } from "./verbs.js";

const BASE_URL = "https://example.atlassian.net";

/** A small stateful Atlassian: reads see earlier writes, writes are logged. */
class StatefulPort implements ScriptPort {
  writes: string[] = [];
  issues = new Map<string, JiraIssueView & { status: string; comments: string[] }>();
  pages = new Map<string, ConfluencePageView & { labels: string[] }>();
  failOn?: string;
  private clock = 0;
  private nextIssue = 10;
  private nextPage = 500;

  constructor() {
    this.issues.set("ATLCLI-1", { id: "1", key: "ATLCLI-1", fields: { summary: "Old", updated: this.tick() }, status: "To Do", comments: [] });
    this.pages.set("100", { id: "100", title: "Release Notes", spaceKey: "DOCSY", version: 7, markdown: "# Old", labels: [] });
  }

  tick(): string {
    return `2026-10-24T00:00:${String(this.clock++).padStart(2, "0")}Z`;
  }
  private guard(name: string): void {
    this.writes.push(name);
    if (this.failOn === name) throw new Error(`${name} rejected by server`);
  }

  async jiraSearch() {
    return { issues: [...this.issues.values()] };
  }
  async jiraGetIssue(key: string) {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`Issue does not exist: ${key}`);
    return { id: issue.id, key, fields: { ...issue.fields } };
  }
  async jiraGetTransitions() {
    return ["Done", "Won't Do"];
  }
  async jiraCreateIssue(input: { project: string; summary: string }) {
    this.guard("jiraCreateIssue");
    const key = `${input.project}-${this.nextIssue++}`;
    this.issues.set(key, { id: key, key, fields: { summary: input.summary, updated: this.tick() }, status: "To Do", comments: [] });
    return { id: key, key };
  }
  async jiraUpdateIssue(key: string, input: { summary?: string }) {
    this.guard("jiraUpdateIssue");
    const issue = this.issues.get(key)!;
    if (input.summary) issue.fields.summary = input.summary;
    issue.fields.updated = this.tick();
  }
  async jiraTransitionIssue(key: string, transition: string) {
    this.guard("jiraTransitionIssue");
    const issue = this.issues.get(key)!;
    issue.status = transition;
    issue.fields.updated = this.tick();
  }
  async jiraAddComment(key: string, markdown: string) {
    this.guard("jiraAddComment");
    const issue = this.issues.get(key)!;
    issue.comments.push(markdown);
    return { id: `c${issue.comments.length}` };
  }
  async confluenceSearch() {
    return { results: [] };
  }
  async confluenceGetPage(id: string) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`Page not found: ${id}`);
    const { labels: _, ...view } = page;
    return view;
  }
  async confluenceFindPage(spaceKey: string, title: string) {
    const page = [...this.pages.values()].find((p) => p.spaceKey === spaceKey && p.title === title);
    return page ? { id: page.id, version: page.version } : null;
  }
  async confluenceCreatePage(input: { spaceKey: string; title: string; markdown: string; parentId?: string }) {
    this.guard("confluenceCreatePage");
    const id = String(this.nextPage++);
    this.pages.set(id, { id, title: input.title, spaceKey: input.spaceKey, version: 1, markdown: input.markdown, labels: [], ...(input.parentId ? { parentId: input.parentId } : {}) });
    return { id, version: 1 };
  }
  async confluenceUpdatePage(input: { id: string; title: string; markdown: string; version: number }) {
    this.guard("confluenceUpdatePage");
    const page = this.pages.get(input.id)!;
    if (page.version !== input.version) throw new Error(`Version conflict on ${input.id}`);
    Object.assign(page, { title: input.title, markdown: input.markdown, version: page.version + 1 });
    return { id: page.id, version: page.version };
  }
  async confluenceAddLabels(pageId: string, labels: string[]) {
    this.guard("confluenceAddLabels");
    this.pages.get(pageId)!.labels.push(...labels);
  }
}

const SCRIPT = `
export const meta = {
  name: "release-housekeeping",
  permissions: ["jira:read", "jira:write:ATLCLI", "confluence:read", "confluence:write:DOCSY"],
  params: { version: { type: "string" } },
};
export default async ({ version }) => {
  const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Release " + version });
  await atlcli.jira.comment(issue.key, "Tracking release " + version);
  await atlcli.jira.transition(issue.key, "Done");
  await atlcli.jira.update("ATLCLI-1", { summary: "Shipped in " + version });
  await atlcli.jira.transition("ATLCLI-1", "Done");
  const parent = await atlcli.confluence.createPage({ space: "DOCSY", title: "Release " + version, markdown: "# " + version });
  const child = await atlcli.confluence.createPage({ space: "DOCSY", title: "Changes " + version, markdown: "- x", parentId: parent.id });
  await atlcli.confluence.addLabels(child.id, ["release"]);
  await atlcli.confluence.updatePage("100", { markdown: "# " + version });
  await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Release Notes", markdown: "# " + version + " final" });
  return { issue: issue.key, parent: parent.id };
};
`;

async function makePlan(port: ScriptPort, source = SCRIPT): Promise<ScriptPlanV1> {
  const run = await planScript(source, { port, params: { version: "2026.10.8" }, variant: DEBUG_VARIANT });
  return createScriptPlan(run, {
    source,
    path: "scripts/release.ts",
    baseUrl: `${BASE_URL}/`,
    profile: "mayflower",
    now: new Date("2026-10-24T12:00:00Z"),
  });
}

describe("script plan file", () => {
  it("round-trips through canonical JSON and verifies its digest", async () => {
    const plan = await makePlan(new StatefulPort());
    const text = serializeScriptPlan(plan);
    expect(text).toBe(serializeScriptPlan(await parseScriptPlan(text)));
    expect(await parseScriptPlan(text)).toEqual(plan);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.script.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.target).toEqual({ baseUrl: BASE_URL, profile: "mayflower" });
    expect(plan.operations).toHaveLength(10);
    expect(plan.value).toEqual({ issue: "plan:1", parent: "plan:6" });
  });

  it("carries no credentials, only the target identity", async () => {
    const text = serializeScriptPlan(await makePlan(new StatefulPort()));
    expect(text).not.toMatch(/token|password|secret|authorization/i);
  });

  it("rejects a plan modified after creation", async () => {
    const plan = await makePlan(new StatefulPort());
    const tampered = JSON.parse(serializeScriptPlan(plan));
    tampered.operations[0].args.summary = "Something else";
    await expect(parseScriptPlan(JSON.stringify(tampered))).rejects.toThrow("digest mismatch");
    const retargeted = { ...JSON.parse(serializeScriptPlan(plan)), target: { baseUrl: "https://evil.example" } };
    await expect(parseScriptPlan(retargeted)).rejects.toThrow("digest mismatch");
  });

  it.each([
    ["not json", "{", "not valid JSON"],
    ["wrong schema", JSON.stringify({ schema: "atlcli.script-plan/2" }), "Invalid plan at plan.schema"],
  ])("rejects %s", async (_name, input, message) => {
    await expect(parseScriptPlan(input)).rejects.toThrow(message);
  });

  it("rejects inconsistent operation order before checking the digest", async () => {
    const plan = JSON.parse(serializeScriptPlan(await makePlan(new StatefulPort())));
    plan.operations[1].dependsOn = [5];
    await expect(parseScriptPlan(plan)).rejects.toThrow("depends on later operation 5");
  });
});

describe("applyScriptPlan", () => {
  it("applies every operation, resolving placeholders and chaining versions", async () => {
    const port = new StatefulPort();
    const plan = await parseScriptPlan(serializeScriptPlan(await makePlan(port)));
    expect(port.writes).toEqual([]); // planning wrote nothing

    const progress: number[] = [];
    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL, onOperation: (r) => progress.push(r.seq) });

    expect(report.status).toBe("applied");
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const created = port.issues.get("ATLCLI-10")!;
    expect([created.fields.summary, created.status, created.comments]).toEqual(["Release 2026.10.8", "Done", ["Tracking release 2026.10.8"]]);
    const existing = port.issues.get("ATLCLI-1")!;
    expect([existing.fields.summary, existing.status]).toEqual(["Shipped in 2026.10.8", "Done"]);
    const child = [...port.pages.values()].find((p) => p.title === "Changes 2026.10.8")!;
    expect(child.parentId).toBe("500");
    expect(child.labels).toEqual(["release"]);
    // two updates of page 100 in one plan: 7 → 8 → 9, no self-inflicted conflict
    expect(port.pages.get("100")).toMatchObject({ version: 9, markdown: "# 2026.10.8 final" });
    expect(report.operations[0]).toEqual({ seq: 1, verb: "jira.create", status: "applied", result: { id: "ATLCLI-10", key: "ATLCLI-10" } });
  });

  it("resolves references embedded in text, leaves unrelated plan:<n> text alone", async () => {
    const port = new StatefulPort();
    const source = `
const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Ship it" });
await atlcli.confluence.createPage({ space: "DOCSY", title: "Notes", markdown: "Tracked in " + issue.key + "; see plan:99 and plan:2" });`;
    const run = await planScript(source, { port, variant: DEBUG_VARIANT });
    expect(run.operations[1]!.dependsOn).toEqual([1]);
    const plan = await createScriptPlan(run, { source, baseUrl: BASE_URL });
    expect((await applyScriptPlan(plan, { port, baseUrl: BASE_URL })).status).toBe("applied");
    const page = [...port.pages.values()].find((p) => p.title === "Notes")!;
    expect(page.markdown).toBe("Tracked in ATLCLI-10; see plan:99 and plan:2");
  });

  it("aborts with nothing written when the target drifted", async () => {
    const port = new StatefulPort();
    const plan = await makePlan(port);
    port.issues.get("ATLCLI-1")!.fields.updated = port.tick(); // someone edited the issue
    port.pages.get("100")!.version = 8; // and the page
    await port.confluenceCreatePage({ spaceKey: "DOCSY", title: "Changes 2026.10.8", markdown: "dup" });
    port.writes = [];

    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });

    expect(report.status).toBe("drift");
    expect(report.drift.map((d) => [d.seq, d.precondition.kind, d.actual])).toEqual([
      [4, "jira-issue-unchanged", "updated 2026-10-24T00:00:01Z"],
      [7, "confluence-title-absent", "page 500 exists"],
      [9, "confluence-page-unchanged", "version 8"],
    ]);
    expect(port.writes).toEqual([]);
    expect(report.operations.every((o) => o.status === "skipped")).toBe(true);
  });

  it("reports unreadable preconditions as drift", async () => {
    const port = new StatefulPort();
    const plan = await makePlan(port);
    port.issues.delete("ATLCLI-1");
    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });
    expect(report.status).toBe("drift");
    expect(report.drift[0]!.actual).toBe("unreadable: Issue does not exist: ATLCLI-1");
  });

  it("refuses to apply against a different site", async () => {
    const port = new StatefulPort();
    const plan = await makePlan(port);
    await expect(applyScriptPlan(plan, { port, baseUrl: "https://other.atlassian.net" })).rejects.toThrow(ScriptPlanError);
    expect(port.writes).toEqual([]);
  });

  it("stops at the first failed write and skips the rest", async () => {
    const port = new StatefulPort();
    const plan = await makePlan(port);
    port.failOn = "jiraTransitionIssue";
    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });
    expect(report.status).toBe("failed");
    expect(report.operations.map((o) => o.status)).toEqual([
      "applied", "applied", "failed", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped",
    ]);
    expect(report.operations[2]!.error).toBe("jiraTransitionIssue rejected by server");
    expect(port.writes).toEqual(["jiraCreateIssue", "jiraAddComment", "jiraTransitionIssue"]);
  });
});

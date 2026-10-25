import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import { createScriptPlan, parseScriptPlan, ScriptPlanError, serializeScriptPlan, type ScriptPlanV1 } from "./plan.js";
import type { ConfluencePageView, JiraIssueView, JiraSprintView, ScriptPort } from "./port.js";
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
  async jiraAddComment(key: string, body: string | { raw: unknown }) {
    this.guard("jiraAddComment");
    const issue = this.issues.get(key)!;
    issue.comments.push(typeof body === "string" ? body : JSON.stringify(body.raw));
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
  confluenceNormalizeMarkdown(markdown: string) {
    return markdown;
  }
  async confluenceAddLabels(pageId: string, labels: string[]) {
    this.guard("confluenceAddLabels");
    this.pages.get(pageId)!.labels.push(...labels);
  }

  links: string[] = [];
  assignees = new Map<string, unknown>();
  labels = new Map<string, string[]>();
  attachments: string[] = [];
  sprints = new Map<number, JiraSprintView & { issues: string[] }>();
  comments: string[] = [];
  exports: string[] = [];
  async jiraLinkTypes() {
    return [{ name: "Blocks", outward: "blocks", inward: "is blocked by" }];
  }
  async jiraLinkIssues(input: { type: string; from: string; to: string }) {
    this.guard("jiraLinkIssues");
    this.links.push(`${input.from} ${input.type} ${input.to}`);
  }
  async jiraFindUser(query: string) {
    return { accountId: `acc-${query}` };
  }
  async jiraAssignIssue(key: string, user: unknown) {
    this.guard("jiraAssignIssue");
    this.assignees.set(key, user);
  }
  async jiraEditLabels(key: string, change: { add?: string[]; remove?: string[] }) {
    this.guard("jiraEditLabels");
    const current = (this.labels.get(key) ?? []).filter((l) => !change.remove?.includes(l));
    this.labels.set(key, [...current, ...(change.add ?? [])]);
  }
  sourceAttachments = new Map([["900", { id: "900", filename: "evidence.xlsx", size: 12_000_000, mimeType: "application/vnd.ms-excel" }]]);
  async jiraAttachmentInfo(id: string) {
    const found = this.sourceAttachments.get(id);
    if (!found) throw new Error(`Attachment does not exist: ${id}`);
    return found;
  }
  async jiraSetStatus(key: string, status: string) {
    this.guard("jiraSetStatus");
    if (status === "Nowhere") return { moved: false };
    this.issues.get(key)!.status = status;
    return { moved: true, transition: status };
  }
  async jiraCopyAttachment(id: string, toKey: string) {
    this.guard("jiraCopyAttachment");
    this.attachments.push(`${toKey}/${this.sourceAttachments.get(id)!.filename}:copy`);
    return { id: `a${this.attachments.length}` };
  }
  async jiraAttach(key: string, file: { name: string; content: string; encoding: string }) {
    this.guard("jiraAttach");
    this.attachments.push(`${key}/${file.name}:${file.encoding}:${file.content}`);
    return { id: `a${this.attachments.length}` };
  }
  async jiraBoards() {
    return { boards: [{ id: 7, name: "ATLCLI board", type: "scrum", projectKey: "ATLCLI" }] };
  }
  async jiraGetBoard(id: number) {
    return { id, name: "ATLCLI board", type: "scrum", projectKey: "ATLCLI" };
  }
  async jiraSprints() {
    return { sprints: [...this.sprints.values()] };
  }
  async jiraGetSprint(id: number) {
    const sprint = this.sprints.get(id);
    if (!sprint) throw new Error(`Sprint does not exist: ${id}`);
    return sprint;
  }
  async jiraCreateSprint(input: { boardId: number; name: string }) {
    this.guard("jiraCreateSprint");
    const id = 40 + this.sprints.size;
    this.sprints.set(id, { id, name: input.name, state: "future", boardId: input.boardId, issues: [] });
    return { id };
  }
  async jiraUpdateSprint(id: number, input: { state?: "active" | "closed" }) {
    this.guard("jiraUpdateSprint");
    if (input.state) this.sprints.get(id)!.state = input.state;
  }
  async jiraMoveToSprint(sprintId: number, keys: string[]) {
    this.guard("jiraMoveToSprint");
    this.sprints.get(sprintId)!.issues.push(...keys);
  }
  async confluenceRemoveLabels(pageId: string, labels: string[]) {
    this.guard("confluenceRemoveLabels");
    const page = this.pages.get(pageId)!;
    page.labels = page.labels.filter((l) => !labels.includes(l));
  }
  async confluenceComments() {
    return [];
  }
  async confluenceAddComment(pageId: string, markdown: string) {
    this.guard("confluenceAddComment");
    this.comments.push(`${pageId}:${markdown}`);
    return { id: `pc${this.comments.length}` };
  }
  async confluenceMovePage(id: string, parentId: string) {
    this.guard("confluenceMovePage");
    const page = this.pages.get(id)!;
    Object.assign(page, { parentId, version: page.version + 1 });
    return { id, version: page.version };
  }
  async confluenceDeletePage(id: string) {
    this.guard("confluenceDeletePage");
    this.pages.delete(id);
  }
  async confluenceAttachments() {
    return [];
  }
  async confluenceAttach(pageId: string, file: { name: string; content: string; encoding: string }) {
    this.guard("confluenceAttach");
    this.attachments.push(`${pageId}/${file.name}:${file.encoding}:${file.content}`);
    return { id: `att${this.attachments.length}` };
  }
  async confluenceExport(input: { pageId: string; format: string; path: string }) {
    this.guard("confluenceExport");
    this.exports.push(`${input.pageId}:${input.format}:${input.path}`);
    return { path: input.path, bytes: 42 };
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
  it("copies attachments onto a created issue, and reports drift when the source changed", async () => {
    const source = `export const meta = { name: "copy", permissions: ["jira:read", "jira:write:ATLCLI"] };
const { key } = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Copy" });
await atlcli.jira.copyAttachment("900", key);
`;
    const port = new StatefulPort();
    const plan = await makePlan(port, source);
    const parsed = await parseScriptPlan(serializeScriptPlan(plan));
    const report = await applyScriptPlan(parsed, { port, baseUrl: BASE_URL });
    expect(report.status).toBe("applied");
    expect(port.attachments).toEqual(["ATLCLI-10/evidence.xlsx:copy"]);

    const fresh = new StatefulPort();
    const again = await makePlan(fresh, source);
    fresh.sourceAttachments.get("900")!.size = 5;
    const drifted = await applyScriptPlan(again, { port: fresh, baseUrl: BASE_URL });
    expect(drifted.status).toBe("drift");
    expect(drifted.drift[0].actual).toBe("size 5");
    expect(fresh.attachments).toEqual([]);
  });

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

  it("applies links, assignments, labels, attachments, sprints, moves, deletes and exports", async () => {
    const port = new StatefulPort();
    port.issues.set("ATLCLI-2", { id: "2", key: "ATLCLI-2", fields: { summary: "Other", updated: port.tick() }, status: "To Do", comments: [] });
    port.pages.set("200", { id: "200", title: "Archive", spaceKey: "DOCSY", version: 1, markdown: "", labels: [] });
    port.pages.set("300", { id: "300", title: "Obsolete", spaceKey: "DOCSY", version: 4, markdown: "", labels: [] });
    const source = `
const sprint = await atlcli.jira.createSprint({ board: 7, name: "Sprint 1", startDate: "2026-11-02T09:00:00Z", endDate: "2026-11-16T17:00:00Z" });
await atlcli.jira.moveToSprint(sprint.id, ["ATLCLI-1", "ATLCLI-2"]);
await atlcli.jira.updateSprint(sprint.id, { state: "active" });
await atlcli.jira.link("ATLCLI-1", "is blocked by", "ATLCLI-2");
await atlcli.jira.assign("ATLCLI-1", "ada@example.com");
await atlcli.jira.addLabels("ATLCLI-1", ["triaged"]);
await atlcli.jira.attach("ATLCLI-1", { name: "report.csv", content: "a,b" });
await atlcli.confluence.addLabels("100", ["generated"]);
await atlcli.confluence.updatePage("100", { markdown: "# New" });
await atlcli.confluence.movePage("100", { parentId: "200" });
await atlcli.confluence.comment("100", "Moved to the archive");
await atlcli.confluence.attach("100", { name: "logo.png", content: "aGk=", encoding: "base64" });
await atlcli.confluence.export("100", { format: "pdf", path: "out/notes.pdf" });
await atlcli.confluence.deletePage("300");`;
    const run = await planScript(source, { port, variant: DEBUG_VARIANT });
    // Labels do not occupy the page: the later update keeps its version precondition.
    expect(run.operations.find((o) => o.verb === "confluence.updatePage")!.precondition).toEqual({
      kind: "confluence-page-unchanged",
      id: "100",
      version: 7,
    });
    const plan = await parseScriptPlan(serializeScriptPlan(await createScriptPlan(run, { source, baseUrl: BASE_URL })));
    expect(port.writes).toEqual([]);

    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });

    expect(report.status).toBe("applied");
    expect(port.sprints.get(40)).toMatchObject({ name: "Sprint 1", state: "active", issues: ["ATLCLI-1", "ATLCLI-2"] });
    expect(port.links).toEqual(["ATLCLI-2 Blocks ATLCLI-1"]);
    expect(port.assignees.get("ATLCLI-1")).toEqual({ accountId: "acc-ada@example.com" });
    expect(port.labels.get("ATLCLI-1")).toEqual(["triaged"]);
    expect(port.attachments).toEqual(["ATLCLI-1/report.csv:utf8:a,b", "100/logo.png:base64:aGk="]);
    // update 7 → 8, move 8 → 9
    expect(port.pages.get("100")).toMatchObject({ version: 9, parentId: "200", markdown: "# New", labels: ["generated"] });
    expect(port.comments).toEqual(["100:Moved to the archive"]);
    expect(port.exports).toEqual(["100:pdf:out/notes.pdf"]);
    expect(port.pages.has("300")).toBe(false);
  });

  it("checks sprint state as a precondition", async () => {
    const port = new StatefulPort();
    port.sprints.set(41, { id: 41, name: "Running", state: "active", boardId: 7, issues: [] });
    const source = `await atlcli.jira.updateSprint(41, { state: "closed" });`;
    const plan = await createScriptPlan(await planScript(source, { port, variant: DEBUG_VARIANT }), { source, baseUrl: BASE_URL });
    port.sprints.get(41)!.state = "closed";
    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });
    expect(report.drift.map((d) => d.actual)).toEqual(["state closed"]);
    expect(port.writes).toEqual([]);
  });

  it("re-checks export paths when applying, since a plan file is editable", async () => {
    const port = new StatefulPort();
    const source = `await atlcli.confluence.export("100", { format: "docx" });`;
    const plan = await createScriptPlan(await planScript(source, { port, variant: DEBUG_VARIANT }), { source, baseUrl: BASE_URL });
    expect(plan.operations[0]!.args.path).toBe("100.docx");
    plan.operations[0]!.args.path = "../../.ssh/authorized_keys.docx";
    const report = await applyScriptPlan(plan, { port, baseUrl: BASE_URL });
    expect(report.status).toBe("failed");
    expect(report.operations[0]!.error).toContain("must be relative and stay inside the output directory");
    expect(port.exports).toEqual([]);
  });
});

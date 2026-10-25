import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import type { ConfluencePageView, JiraIssueView, ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { inspectScript, planScript, SCRIPT_VERBS, type PlanScriptOptions } from "./verbs.js";

/** In-memory Atlassian; records every port call, writes must never happen. */
class FakePort implements ScriptPort {
  calls: string[] = [];
  issues = new Map<string, JiraIssueView>();
  pages = new Map<string, ConfluencePageView>();
  transitions: Record<string, string[]> = {};

  constructor() {
    for (let n = 1; n <= 250; n++) {
      const key = `ATLCLI-${n}`;
      this.issues.set(key, { id: String(n), key, fields: { summary: `Issue ${n}`, updated: `2026-10-0${(n % 9) + 1}T00:00:00Z` } });
    }
    this.pages.set("100", { id: "100", title: "Release Notes", spaceKey: "DOCSY", version: 7, markdown: "# Old" });
    this.pages.set("101", { id: "101", title: "Child", spaceKey: "DOCSY", version: 2, parentId: "100", markdown: "" });
    this.pages.set("200", { id: "200", title: "Elsewhere", spaceKey: "OTHER", version: 1, markdown: "" });
    Object.assign(this.issues.get("ATLCLI-2")!.fields, { assignee: { accountId: "acc-ada" }, labels: ["triaged"] });
    this.transitions["ATLCLI-1"] = ["Done", "Won't Do"];
  }

  async jiraSearch(jql: string, o: { pageToken?: string; maxResults: number }) {
    this.calls.push(`jiraSearch:${jql}:${o.pageToken ?? ""}`);
    const all = [...this.issues.values()];
    const start = Number(o.pageToken ?? 0);
    const end = start + o.maxResults;
    return { issues: all.slice(start, end), ...(end < all.length ? { nextPageToken: String(end) } : {}) };
  }
  async jiraGetIssue(key: string) {
    this.calls.push(`jiraGetIssue:${key}`);
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`Issue does not exist: ${key}`);
    return issue;
  }
  async jiraGetTransitions(key: string) {
    this.calls.push(`jiraGetTransitions:${key}`);
    return this.transitions[key] ?? [];
  }
  async confluenceSearch(cql: string, o: { cursor?: string }) {
    this.calls.push(`confluenceSearch:${cql}`);
    const results = [...this.pages.values()].map(({ id, title, spaceKey }) => ({ id, title, spaceKey }));
    return o.cursor ? { results: [] } : { results, nextCursor: "next" };
  }
  async confluenceGetPage(id: string) {
    this.calls.push(`confluenceGetPage:${id}`);
    const page = this.pages.get(id);
    if (!page) throw new Error(`Page not found: ${id}`);
    return page;
  }
  async confluenceFindPage(spaceKey: string, title: string) {
    this.calls.push(`confluenceFindPage:${spaceKey}:${title}`);
    const page = [...this.pages.values()].find((p) => p.spaceKey === spaceKey && p.title === title);
    return page ? { id: page.id, version: page.version } : null;
  }
  /** The fake stores Markdown as given, so normalizing trims only trailing blank lines. */
  confluenceNormalizeMarkdown(markdown: string) {
    return markdown.replace(/\s+$/, "");
  }
  async jiraLinkTypes() {
    this.calls.push("jiraLinkTypes");
    return [
      { name: "Blocks", outward: "blocks", inward: "is blocked by" },
      { name: "Relates", outward: "relates to", inward: "relates to" },
    ];
  }
  async jiraFindUser(query: string) {
    this.calls.push(`jiraFindUser:${query}`);
    if (query === "nobody") throw new Error(`No user matches "${query}".`);
    return { accountId: query === "me" ? "acc-me" : `acc-${query}` };
  }
  boards = [
    { id: 1, name: "Scrum", type: "scrum", projectKey: "ATLCLI" },
    { id: 2, name: "Kanban", type: "kanban", projectKey: "ATLCLI" },
    { id: 3, name: "Loose", type: "scrum" },
  ];
  sprints = [
    { id: 10, name: "Old", state: "closed" as const, boardId: 1 },
    { id: 11, name: "Now", state: "active" as const, boardId: 1 },
    { id: 12, name: "Next", state: "future" as const, boardId: 1 },
    { id: 13, name: "Loose", state: "future" as const, boardId: 3 },
  ];
  async jiraBoards(o: { startAt: number; maxResults: number }) {
    this.calls.push(`jiraBoards:${o.startAt}`);
    // two per page, to exercise paging
    const page = this.boards.slice(o.startAt, o.startAt + 2);
    return { boards: page, ...(o.startAt + 2 < this.boards.length ? { next: o.startAt + 2 } : {}) };
  }
  async jiraGetBoard(id: number) {
    const board = this.boards.find((b) => b.id === id);
    if (!board) throw new Error(`Board does not exist: ${id}`);
    return board;
  }
  async jiraSprints(boardId: number, o: { state?: string }) {
    return { sprints: this.sprints.filter((s) => s.boardId === boardId && (!o.state || s.state === o.state)) };
  }
  async jiraGetSprint(id: number) {
    const sprint = this.sprints.find((s) => s.id === id);
    if (!sprint) throw new Error(`Sprint does not exist: ${id}`);
    return sprint;
  }
  async confluenceComments(pageId: string) {
    return [{ id: "c1", status: "open", markdown: `on ${pageId}`, replies: [] }];
  }
  async confluenceAttachments() {
    return [{ id: "att1", name: "a.txt", mediaType: "text/plain", size: 3, version: 1 }];
  }
  jiraAttachmentList = [{ id: "900", filename: "evidence.xlsx", size: 12_000_000, mimeType: "application/vnd.ms-excel" }];
  async jiraAttachmentInfo(id: string) {
    this.calls.push(`jiraAttachmentInfo:${id}`);
    const found = this.jiraAttachmentList.find((a) => a.id === id);
    if (!found) throw new Error(`Attachment does not exist: ${id}`);
    return found;
  }
  jiraCreateIssue = this.write;
  jiraUpdateIssue = this.write;
  jiraTransitionIssue = this.write;
  jiraAddComment = this.write;
  jiraLinkIssues = this.write;
  jiraAssignIssue = this.write;
  jiraEditLabels = this.write;
  jiraAttach = this.write;
  jiraCopyAttachment = this.write;
  jiraCreateSprint = this.write;
  jiraUpdateSprint = this.write;
  jiraMoveToSprint = this.write;
  confluenceCreatePage = this.write;
  confluenceUpdatePage = this.write;
  confluenceAddLabels = this.write;
  confluenceRemoveLabels = this.write;
  confluenceAddComment = this.write;
  confluenceMovePage = this.write;
  confluenceDeletePage = this.write;
  confluenceAttach = this.write;
  confluenceExport = this.write;
  private async write(): Promise<never> {
    throw new Error("planScript must never write");
  }
}

const meta = (permissions: string[], extra = "") =>
  `export const meta = { name: "test", permissions: ${JSON.stringify(permissions)}${extra} };\n`;
const ALL = ["jira:read", "jira:write:ATLCLI", "confluence:read", "confluence:write:DOCSY"];

function plan(js: string, options: Partial<PlanScriptOptions> = {}) {
  return planScript(js, { port: new FakePort(), variant: DEBUG_VARIANT, ...options });
}

async function scriptError(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptError);
    return error as ScriptError;
  }
  throw new Error("expected the script to fail");
}

describe("copying issues losslessly", () => {
  it("plans copyAttachment by reference, with no bytes in the plan", async () => {
    const result = await plan(meta(ALL) + `export default await atlcli.jira.copyAttachment("900", "ATLCLI-2")`);
    expect(result.operations).toEqual([
      {
        seq: 1,
        verb: "jira.copyAttachment",
        args: { id: "900", to: "ATLCLI-2", filename: "evidence.xlsx", size: 12_000_000 },
        precondition: { kind: "jira-attachment-unchanged", id: "900", size: 12_000_000 },
        dependsOn: [],
      },
    ]);
    expect(result.value).toEqual({ id: "plan:1" });
  });

  it("copies onto an issue created by the same plan", async () => {
    const result = await plan(
      meta(ALL) +
        `const { key } = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "Copy" });
await atlcli.jira.copyAttachment("900", key);`,
    );
    expect(result.operations[1]).toMatchObject({ verb: "jira.copyAttachment", args: { to: "plan:1" }, dependsOn: [1] });
  });

  it("skips a copy the target already has (same name and size)", async () => {
    const port = new FakePort();
    port.issues.get("ATLCLI-2")!.fields.attachment = [{ id: "77", filename: "evidence.xlsx", size: 12_000_000 }] as never;
    const result = await plan(meta(ALL) + `export default await atlcli.jira.copyAttachment("900", "ATLCLI-2")`, { port });
    expect(result.operations).toEqual([]);
    expect(result.skipped).toEqual([{ verb: "jira.copyAttachment", target: "ATLCLI-2", title: "evidence.xlsx", reason: "unchanged" }]);
    expect(result.value).toEqual({ id: "77" });
  });

  it("fails at plan time for a missing attachment", async () => {
    const error = await scriptError(plan(meta(ALL) + `await atlcli.jira.copyAttachment("404", "ATLCLI-2")`));
    expect(error.message).toContain("Attachment does not exist: 404");
  });

  it("needs write permission on the target project", async () => {
    const error = await scriptError(plan(meta(["jira:read"]) + `await atlcli.jira.copyAttachment("900", "ATLCLI-2")`));
    expect(error.kind).toBe("permission-denied");
  });

  it("rejects description together with fields.description", async () => {
    const error = await scriptError(
      plan(meta(ALL) + `await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "x", description: "md", fields: { description: { type: "doc" } } })`),
    );
    expect(error.message).toContain("not both");
  });

  it("passes a raw description, issue properties and a raw comment through unchanged", async () => {
    const adf = { type: "doc", version: 1, content: [{ type: "table", content: [] }] };
    const result = await plan(
      meta(ALL) +
        `const { key } = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "x", fields: { description: ${JSON.stringify(adf)} }, properties: { "atlcli.copiedFrom": { key: "OLD-1" } } });
await atlcli.jira.comment(key, { raw: ${JSON.stringify(adf)} });`,
    );
    expect(result.operations[0].args).toMatchObject({ fields: { description: adf }, properties: { "atlcli.copiedFrom": { key: "OLD-1" } } });
    expect(result.operations[1].args).toEqual({ key: "plan:1", raw: adf });
  });
});

describe("planScript", () => {
  it("validates meta and resolves params before running", async () => {
    const result = await plan(
      meta(["jira:read"], `, params: { days: { type: "number", default: 180 } }`) + `export default (p) => p.days * 2`,
      { params: { days: "7" } },
    );
    expect(result.value).toBe(14);
    expect(result.params).toEqual({ days: 7 });
    expect(result.meta.name).toBe("test");
    expect(result.operations).toEqual([]);
  });

  it("fails as invalid-script on bad meta or params, before any code runs", async () => {
    const port = new FakePort();
    const bad = await scriptError(plan(meta(["jira:admin"]) + `await atlcli.jira.get("ATLCLI-1");`, { port }));
    expect(bad.kind).toBe("invalid-script");
    expect(port.calls).toEqual([]);
    const unknown = await scriptError(
      plan(meta(["jira:read"], `, params: { days: { type: "number" } }`) + `export default () => 1`, { params: { x: "1" } }),
    );
    expect(unknown.message).toBe("Unknown parameter: x");
  });

  it("runs a plain top-level script without meta, imports or exports", async () => {
    const result = await plan(
      `for await (const issue of atlcli.jira.search("project = ATLCLI", { limit: 2 })) {
  await atlcli.jira.comment(issue.key, "Closing as stale");
}`,
      { params: { reason: "stale" } },
    );
    expect(result.meta).toEqual({});
    expect(result.params).toEqual({ reason: "stale" });
    expect(result.operations.map((o) => [o.verb, o.args.key])).toEqual([
      ["jira.comment", "ATLCLI-1"],
      ["jira.comment", "ATLCLI-2"],
    ]);
  });

  it("iterates jira.search across pages with a limit", async () => {
    const port = new FakePort();
    const result = await plan(
      meta(["jira:read"]) +
        `export default async () => { const keys = []; for await (const i of atlcli.jira.search("project = ATLCLI", { limit: 230 })) keys.push(i.key); return [keys.length, keys.at(-1)]; }`,
      { port },
    );
    expect(result.value).toEqual([230, "ATLCLI-230"]);
    expect(port.calls).toEqual(["jiraSearch:project = ATLCLI:", "jiraSearch:project = ATLCLI:100", "jiraSearch:project = ATLCLI:200"]);
  });

  it("iterates confluence.search until the cursor ends", async () => {
    const result = await plan(
      meta(["confluence:read"]) +
        `export default async () => { const t = []; for await (const p of atlcli.confluence.search("space = DOCSY")) t.push(p.title); return t; }`,
    );
    expect(result.value).toEqual(["Release Notes", "Child", "Elsewhere"]);
  });

  it("denies verbs not granted by meta.permissions, even when caught", async () => {
    const error = await scriptError(
      plan(meta(["jira:read"]) + `export default async () => { try { await atlcli.jira.update("ATLCLI-1", { summary: "x" }); } catch {} }`),
    );
    expect(error.kind).toBe("permission-denied");
    expect(error.message).toContain('"jira:write:ATLCLI"');
    const otherProject = await scriptError(
      plan(meta(ALL) + `export default () => atlcli.jira.comment("OTHER-1", "hi")`),
    );
    expect(otherProject.message).toContain('"jira:write:OTHER"');
    const read = await scriptError(plan(meta(["jira:read"]) + `export default () => atlcli.confluence.getPage("100")`));
    expect(read.message).toContain('"confluence:read"');
  });

  it("records writes with preconditions instead of executing them", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => {
          await atlcli.jira.update("ATLCLI-1", { summary: "Renamed" });
          await atlcli.jira.transition("ATLCLI-1", "Won't Do");
          const c = await atlcli.jira.comment("ATLCLI-1", "Closed as stale");
          await atlcli.confluence.updatePage("100", { markdown: "# New" });
          await atlcli.confluence.addLabels("100", ["release"]);
          return c;
        }`,
    );
    expect(result.value).toEqual({ id: "plan:3" });
    expect(result.operations).toEqual([
      {
        seq: 1,
        verb: "jira.update",
        args: { key: "ATLCLI-1", summary: "Renamed" },
        precondition: { kind: "jira-issue-unchanged", key: "ATLCLI-1", updated: "2026-10-02T00:00:00Z" },
        dependsOn: [],
      },
      // second write to the same issue chains on the first instead of re-checking `updated`
      { seq: 2, verb: "jira.transition", args: { key: "ATLCLI-1", transition: "Won't Do" }, dependsOn: [1] },
      { seq: 3, verb: "jira.comment", args: { key: "ATLCLI-1", markdown: "Closed as stale" }, dependsOn: [] },
      {
        seq: 4,
        verb: "confluence.updatePage",
        args: { id: "100", title: "Release Notes", markdown: "# New" },
        precondition: { kind: "confluence-page-unchanged", id: "100", version: 7 },
        dependsOn: [],
      },
      // labels do not change the page version, so they do not chain on the update
      { seq: 5, verb: "confluence.addLabels", args: { pageId: "100", labels: ["release"] }, dependsOn: [] },
    ]);
  });

  it("chains placeholders from created objects", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => {
          const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "New" });
          await atlcli.jira.transition(issue.key, "Done");
          const parent = await atlcli.confluence.createPage({ space: "DOCSY", title: "Parent", markdown: "p" });
          const child = await atlcli.confluence.createPage({ space: "DOCSY", title: "Child", markdown: "c", parentId: parent.id });
          await atlcli.confluence.addLabels(child.id, ["generated"]);
          return [issue, parent, child];
        }`,
    );
    expect(result.value).toEqual([{ id: "plan:1", key: "plan:1" }, { id: "plan:3" }, { id: "plan:4" }]);
    expect(result.operations.map((o) => [o.seq, o.verb, o.dependsOn, o.precondition?.kind])).toEqual([
      [1, "jira.create", [], undefined],
      [2, "jira.transition", [1], undefined],
      [3, "confluence.createPage", [], "confluence-title-absent"],
      [4, "confluence.createPage", [3], "confluence-title-absent"],
      [5, "confluence.addLabels", [4], undefined],
    ]);
  });

  it("refuses to read objects that exist only in the plan", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => {
          const issue = await atlcli.jira.create({ project: "ATLCLI", type: "Task", summary: "New" });
          try { await atlcli.jira.get(issue.key); } catch (e) { return e.message; }
        }`,
    );
    expect(result.value).toBe("plan:1 is created by this plan and can only be read after it is applied");
  });

  it("upserts: updates existing pages, creates missing ones, reuses plan-created ones", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => [
          await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Release Notes", markdown: "v2" }),
          await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Fresh", markdown: "a" }),
          await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Fresh", markdown: "b" }),
        ]`,
    );
    expect(result.value).toEqual([
      { id: "100", created: false },
      { id: "plan:2", created: true },
      { id: "plan:2", created: true },
    ]);
    expect(result.operations.map((o) => [o.verb, o.args.markdown, o.dependsOn, o.precondition?.kind])).toEqual([
      ["confluence.updatePage", "v2", [], "confluence-page-unchanged"],
      ["confluence.createPage", "a", [], "confluence-title-absent"],
      ["confluence.updatePage", "b", [2], undefined],
    ]);
  });

  it("skips page updates that would not change the page", async () => {
    const result = await plan(
      meta(ALL) +
        `export default [
          await atlcli.confluence.updatePage("100", { markdown: "# Old\\n" }),
          await atlcli.confluence.upsertPage({ space: "DOCSY", title: "Release Notes", markdown: "# Old" }),
        ]`,
    );
    expect(result.value).toEqual([{ id: "100" }, { id: "100", created: false }]);
    expect(result.operations).toEqual([]);
    expect(result.skipped).toEqual([
      { verb: "confluence.updatePage", target: "100", title: "Release Notes", reason: "unchanged" },
      { verb: "confluence.updatePage", target: "100", title: "Release Notes", reason: "unchanged" },
    ]);
  });

  it("keeps updates that only look unchanged against the pre-plan state", async () => {
    const result = await plan(
      meta(ALL) +
        `await atlcli.confluence.updatePage("100", { markdown: "# New" });
         await atlcli.confluence.updatePage("100", { markdown: "# Old" });
         await atlcli.confluence.updatePage("100", { title: "Renamed", markdown: "# Old" });`,
    );
    // A → B → A must restore A; a title change is a change even with the same body.
    expect(result.operations.map((o) => [o.args.title, o.args.markdown])).toEqual([
      ["Release Notes", "# New"],
      ["Release Notes", "# Old"],
      ["Renamed", "# Old"],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("lets the caller override meta.limits.maxWrites", async () => {
    const script = meta(ALL, `, limits: { maxWrites: 5 }`) + `for (let i = 0; i < 3; i++) await atlcli.jira.comment("ATLCLI-1", "n" + i);`;
    expect((await plan(script)).operations).toHaveLength(3);
    const error = await scriptError(plan(script, { maxWrites: 2 }));
    expect(error.kind).toBe("write-limit");
    expect(error.message).toContain("--max-writes");
  });

  it("rejects creating the same page twice in one plan", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => {
          await atlcli.confluence.createPage({ space: "DOCSY", title: "Twice", markdown: "1" });
          try { await atlcli.confluence.createPage({ space: "DOCSY", title: "Twice", markdown: "2" }); } catch (e) { return e.message; }
        }`,
    );
    expect(result.value).toContain("already created by this plan");
  });

  it("checks transitions at plan time", async () => {
    const result = await plan(
      meta(ALL) + `export default async () => { try { await atlcli.jira.transition("ATLCLI-1", "Reopen"); } catch (e) { return e.message; } }`,
    );
    expect(result.value).toBe('Transition "Reopen" is not available for ATLCLI-1 (available: Done, Won\'t Do)');
  });

  it("enforces meta.limits.maxWrites as fatal", async () => {
    const error = await scriptError(
      plan(
        meta(ALL, `, limits: { maxWrites: 2 }`) +
          `export default async () => { for (let i = 0; i < 3; i++) { try { await atlcli.jira.comment("ATLCLI-1", "n" + i); } catch {} } }`,
      ),
    );
    expect(error.kind).toBe("write-limit");
  });

  it("validates verb arguments as untrusted input", async () => {
    const result = await plan(
      meta(ALL) +
        `export default async () => {
          const out = [];
          for (const f of [
            () => atlcli.jira.get(42),
            () => atlcli.jira.create({ project: "ATLCLI", type: "Task" }),
            () => atlcli.jira.update("ATLCLI-1", {}),
            () => atlcli.jira.update("ATLCLI-1", { summary: "x", sneaky: true }),
            () => atlcli.confluence.addLabels("100", []),
            () => atlcli.jira.comment("not a key", "x"),
          ]) { try { await f(); out.push("ok"); } catch (e) { out.push(e.message.split(":")[0]); } }
          return out;
        }`,
    );
    expect(result.value).toEqual([
      "Invalid arguments for atlcli.jira.get",
      "Invalid arguments for atlcli.jira.create",
      "Invalid arguments for atlcli.jira.update",
      "Invalid arguments for atlcli.jira.update",
      "Invalid arguments for atlcli.confluence.addLabels",
      "Invalid issue key",
    ]);
  });

  it("passes live reads through", async () => {
    const result = await plan(
      meta(["jira:read", "confluence:read"]) +
        `export default async () => [(await atlcli.jira.get("ATLCLI-2")).fields.summary, (await atlcli.confluence.getPage("100")).markdown]`,
    );
    expect(result.value).toEqual(["Issue 2", "# Old"]);
  });
});

/** Runs `body` and returns the message of what it throws, or "ok". */
const attempt = (body: string) => `try { ${body}; return "ok"; } catch (e) { return e.message; }`;

describe("jira verbs beyond issues", () => {
  it("records links in the outward direction and checks the type at plan time", async () => {
    const result = await plan(
      `await atlcli.jira.link("ATLCLI-1", "blocks", "ATLCLI-2");
       await atlcli.jira.link("ATLCLI-1", "is blocked by", "ATLCLI-3");
       await atlcli.jira.link("ATLCLI-1", "Relates", "ATLCLI-4");
       export default await (async () => { ${attempt(`await atlcli.jira.link("ATLCLI-1", "duplicates", "ATLCLI-2")`)} })();`,
    );
    expect(result.operations.map((o) => o.args)).toEqual([
      { from: "ATLCLI-1", type: "Blocks", to: "ATLCLI-2" },
      { from: "ATLCLI-3", type: "Blocks", to: "ATLCLI-1" },
      { from: "ATLCLI-1", type: "Relates", to: "ATLCLI-4" },
    ]);
    expect(result.value).toBe('Unknown link type "duplicates" (available: blocks / is blocked by, relates to / relates to)');
  });

  it("needs write grants on both linked projects", async () => {
    const error = await scriptError(plan(meta(ALL) + `await atlcli.jira.link("ATLCLI-1", "blocks", "OTHER-1");`));
    expect(error.message).toContain('"jira:write:OTHER"');
  });

  it("resolves assignees at plan time, unassigns with null and skips no-ops", async () => {
    const port = new FakePort();
    const result = await plan(
      `await atlcli.jira.assign("ATLCLI-1", "me");
       await atlcli.jira.assign("ATLCLI-2", "ada");
       await atlcli.jira.assign("ATLCLI-3", null);
       await atlcli.jira.assign("ATLCLI-2", null);
       export default await (async () => { ${attempt(`await atlcli.jira.assign("ATLCLI-4", "nobody")`)} })();`,
      { port },
    );
    expect(result.operations.map((o) => [o.args, o.precondition?.kind])).toEqual([
      [{ key: "ATLCLI-1", assignee: { accountId: "acc-me" }, user: "me" }, "jira-issue-unchanged"],
      [{ key: "ATLCLI-2", assignee: null }, "jira-issue-unchanged"],
    ]);
    // ATLCLI-2 already has ada, ATLCLI-3 has nobody
    expect(result.skipped.map((s) => s.target)).toEqual(["ATLCLI-2", "ATLCLI-3"]);
    expect(result.value).toBe('No user matches "nobody".');
  });

  it("skips label changes that change nothing", async () => {
    const result = await plan(
      `await atlcli.jira.addLabels("ATLCLI-2", ["triaged"]);
       await atlcli.jira.removeLabels("ATLCLI-2", ["missing"]);
       await atlcli.jira.addLabels("ATLCLI-2", ["triaged", "new"]);
       await atlcli.jira.removeLabels("ATLCLI-2", ["triaged"]);`,
    );
    expect(result.operations.map((o) => [o.verb, o.args.labels, o.dependsOn])).toEqual([
      ["jira.addLabels", ["triaged", "new"], []],
      // after a planned write the pre-plan labels no longer tell, so it is kept
      ["jira.removeLabels", ["triaged"], [1]],
    ]);
    expect(result.skipped.map((s) => s.verb)).toEqual(["jira.addLabels", "jira.removeLabels"]);
  });

  it("validates attachments made by the script", async () => {
    const result = await plan(
      `const out = [];
       for (const file of [
         { name: "report.csv", content: "a,b\\n1,2" },
         { name: "logo.png", content: "aGk=", encoding: "base64" },
         { name: "bad.png", content: "not base64!", encoding: "base64" },
         { name: "../x.txt", content: "x" },
       ]) { try { await atlcli.jira.attach("ATLCLI-1", file); out.push("ok"); } catch (e) { out.push(e.message.slice(0, 50)); } }
       export default out;`,
    );
    expect(result.value).toEqual([
      "ok",
      "ok",
      "Attachment bad.png: content is not valid base64",
      "Invalid arguments for atlcli.jira.attach: 1.name: ",
    ]);
    expect(result.operations.map((o) => o.args.encoding)).toEqual(["utf8", "base64"]);
  });

  it("limits attachment size", async () => {
    // Release build: the debug build of quickjs-ng 0.32 asserts on a leak after
    // JSON.stringify of strings from about 4 MB, which the release build tolerates.
    const result = await planScript(
      `export default await atlcli.jira.attach("ATLCLI-1", { name: "big.txt", content: "x".repeat(10 * 1024 * 1024 + 1) }).catch((e) => e.message);`,
      { port: new FakePort(), limits: { memoryBytes: 128 * 1024 * 1024 } },
    );
    expect(result.value).toBe("Attachment big.txt is 10485761 bytes; the limit is 10485760 bytes");
  });

  it("iterates boards and sprints", async () => {
    const port = new FakePort();
    const result = await plan(
      `const boards = []; for await (const b of atlcli.jira.boards()) boards.push(b.id);
       const sprints = []; for await (const s of atlcli.jira.sprints(1, { state: "future" })) sprints.push(s.name);
       export default [boards, sprints];`,
      { port },
    );
    expect(result.value).toEqual([[1, 2, 3], ["Next"]]);
    expect(port.calls.filter((c) => c.startsWith("jiraBoards"))).toEqual(["jiraBoards:0", "jiraBoards:2"]);
  });

  it("plans sprints: create on scrum boards, start and close in order, move issues", async () => {
    const result = await plan(
      meta(ALL) +
        `const s = await atlcli.jira.createSprint({ board: 1, name: "Sprint 9", startDate: "2026-11-02T09:00:00.000Z", endDate: "2026-11-16T17:00:00.000Z" });
         await atlcli.jira.moveToSprint(s.id, ["ATLCLI-1", "ATLCLI-1", "ATLCLI-2"]);
         await atlcli.jira.updateSprint(s.id, { state: "active" });
         await atlcli.jira.updateSprint("11", { state: "closed" });
         const out = [];
         for (const f of [
           () => atlcli.jira.createSprint({ board: 2, name: "x" }),
           () => atlcli.jira.updateSprint(12, { state: "closed" }),
           () => atlcli.jira.updateSprint(11, { goal: "late" }),
           () => atlcli.jira.moveToSprint(10, ["ATLCLI-3"]),
           () => atlcli.jira.updateSprint(s.id, { state: "active" }),
           () => atlcli.jira.createSprint({ board: 1, name: "x", startDate: "next monday" }),
           // regression (live): Jira answers 400 when a sprint is started without dates
           () => atlcli.jira.updateSprint(12, { state: "active" }),
           () => atlcli.jira.updateSprint(12, { state: "active", startDate: "2026-11-02T09:00:00.000Z" }),
         ]) { try { await f(); out.push("ok"); } catch (e) { out.push(e.message); } }
         export default out;`,
    );
    expect(result.operations.map((o) => [o.verb, o.args, o.dependsOn, o.precondition])).toEqual([
      [
        "jira.createSprint",
        { boardId: 1, name: "Sprint 9", startDate: "2026-11-02T09:00:00.000Z", endDate: "2026-11-16T17:00:00.000Z" },
        [],
        undefined,
      ],
      ["jira.moveToSprint", { sprintId: "plan:1", keys: ["ATLCLI-1", "ATLCLI-2"] }, [1], undefined],
      ["jira.updateSprint", { id: "plan:1", state: "active" }, [1], undefined],
      ["jira.updateSprint", { id: 11, state: "closed" }, [], { kind: "jira-sprint-unchanged", id: 11, state: "active" }],
    ]);
    expect(result.value).toEqual([
      "Board 2 is a kanban board; sprints need a scrum board",
      "Sprint 12 is future; only a active sprint can become closed",
      "Sprint 11 is closed and cannot be changed",
      "Sprint 10 is closed; issues cannot be moved into it",
      "Sprint plan:1 is active; only a future sprint can become active",
      expect.stringContaining("Invalid arguments for atlcli.jira.createSprint: 0.startDate"),
      "Starting sprint 12 needs a startDate and an endDate",
      "Starting sprint 12 needs a startDate and an endDate",
    ]);
  });

  it("denies sprint writes on boards outside any project once permissions are declared", async () => {
    const error = await scriptError(plan(meta(ALL) + `await atlcli.jira.updateSprint(13, { name: "x" });`));
    expect(error.kind).toBe("permission-denied");
    expect(error.message).toBe("Sprint 13 belongs to no project, so meta.permissions cannot grant writes to it");
    const ok = await plan(`await atlcli.jira.updateSprint(13, { name: "x" });`);
    expect(ok.operations).toHaveLength(1);
  });
});

describe("confluence verbs beyond pages", () => {
  it("reads comments and attachments", async () => {
    const result = await plan(
      meta(["confluence:read"]) + `export default [await atlcli.confluence.comments("100"), await atlcli.confluence.attachments("100")]`,
    );
    expect(result.value).toEqual([
      [{ id: "c1", status: "open", markdown: "on 100", replies: [] }],
      [{ id: "att1", name: "a.txt", mediaType: "text/plain", size: 3, version: 1 }],
    ]);
  });

  it("plans comments, label removal and attachments without taking the page's precondition", async () => {
    const result = await plan(
      meta(ALL) +
        `await atlcli.confluence.comment("100", "Reviewed");
         await atlcli.confluence.removeLabels("100", ["draft"]);
         await atlcli.confluence.attach("100", { name: "data.json", content: "{}" });
         await atlcli.confluence.updatePage("100", { markdown: "# New" });`,
    );
    expect(result.operations.map((o) => [o.verb, o.precondition?.kind])).toEqual([
      ["confluence.comment", undefined],
      ["confluence.removeLabels", undefined],
      ["confluence.attach", undefined],
      ["confluence.updatePage", "confluence-page-unchanged"],
    ]);
  });

  it("moves pages within their space and skips moves to the current parent", async () => {
    const result = await plan(
      `await atlcli.confluence.movePage("101", { parentId: "100" });
       const p = await atlcli.confluence.createPage({ space: "DOCSY", title: "New parent", markdown: "" });
       await atlcli.confluence.movePage("101", { parentId: p.id });
       export default await (async () => { ${attempt(`await atlcli.confluence.movePage("100", { parentId: "200" })`)} })();`,
    );
    expect(result.skipped).toEqual([{ verb: "confluence.movePage", target: "101", title: "Child", reason: "unchanged" }]);
    expect(result.operations.map((o) => [o.verb, o.args, o.dependsOn, o.precondition?.kind])).toEqual([
      ["confluence.createPage", { spaceKey: "DOCSY", title: "New parent", markdown: "" }, [], "confluence-title-absent"],
      ["confluence.movePage", { id: "101", parentId: "plan:1" }, [1], "confluence-page-unchanged"],
    ]);
    expect(result.value).toBe("Page 100 is in DOCSY and cannot move under 200 in OTHER");
  });

  it("deletes pages and rejects later writes to them", async () => {
    const result = await plan(
      `await atlcli.confluence.deletePage("101");
       const out = [];
       for (const f of [
         () => atlcli.confluence.updatePage("101", { markdown: "x" }),
         () => atlcli.confluence.comment("101", "x"),
         () => atlcli.confluence.createPage({ space: "DOCSY", title: "Orphan", markdown: "", parentId: "101" }),
         async () => atlcli.confluence.deletePage((await atlcli.confluence.createPage({ space: "DOCSY", title: "T", markdown: "" })).id),
       ]) { try { await f(); out.push("ok"); } catch (e) { out.push(e.message); } }
       export default out;`,
    );
    expect(result.operations[0]).toEqual({
      seq: 1,
      verb: "confluence.deletePage",
      args: { id: "101", title: "Child" },
      precondition: { kind: "confluence-page-unchanged", id: "101", version: 2 },
      dependsOn: [],
    });
    expect(result.value).toEqual([
      "Page 101 is deleted by this plan",
      "Page 101 is deleted by this plan",
      "Page 101 is deleted by this plan",
      "plan:2 is created by this plan; leave out the createPage instead",
    ]);
  });

  it("plans exports with safe relative paths", async () => {
    const result = await plan(
      meta(["confluence:read"]) +
        `const out = [await atlcli.confluence.export("100", { format: "pdf" }), await atlcli.confluence.export("100", { format: "docx", path: "./out/notes.docx" })];
         for (const path of ["/etc/x.pdf", "../x.pdf", "a//b.pdf", "C:/x.pdf", "~/x.pdf", "notes.docx", "out/notes.docx"]) {
           try { await atlcli.confluence.export("100", { format: path.endsWith("docx") ? "docx" : "pdf", path }); out.push("ok"); } catch (e) { out.push(e.message.split(":")[0]); }
         }
         export default out;`,
    );
    expect(result.value).toEqual([
      { path: "100.pdf" },
      { path: "out/notes.docx" },
      "Export path must be relative and stay inside the output directory",
      "Export path must be relative and stay inside the output directory",
      "Export path must be relative and stay inside the output directory",
      "Export path must be relative and stay inside the output directory",
      "Export path must be relative and stay inside the output directory",
      "ok",
      "out/notes.docx is already exported by this plan",
    ]);
    expect(result.operations.map((o) => o.args)).toEqual([
      { pageId: "100", format: "pdf", path: "100.pdf" },
      { pageId: "100", format: "docx", path: "out/notes.docx" },
      { pageId: "100", format: "docx", path: "notes.docx" },
    ]);
  });

  it("rejects an export path with the wrong extension", async () => {
    const result = await plan(`export default await (async () => { ${attempt(`await atlcli.confluence.export("100", { format: "pdf", path: "a.docx" })`)} })();`);
    expect(result.value).toBe('Export path "a.docx" must end in .pdf');
  });
});

describe("inspectScript", () => {
  it("returns meta without running the default export", async () => {
    const got = await inspectScript(meta(["jira:read"]) + `export default () => { throw new Error("default ran"); }`, {
      variant: DEBUG_VARIANT,
    });
    expect(got).toEqual({ name: "test", permissions: ["jira:read"] });
  });

  it("reports invalid meta", async () => {
    const error = await scriptError(
      inspectScript(`export const meta = { permissions: ["jira:admin"] }; export default () => 1`, { variant: DEBUG_VARIANT }),
    );
    expect(error.message).toContain("Invalid meta.permissions");
  });
});

it("exposes the verb set", () => {
  expect([...SCRIPT_VERBS].sort()).toEqual([
    "confluence.addLabels",
    "confluence.attach",
    "confluence.attachments",
    "confluence.comment",
    "confluence.comments",
    "confluence.createPage",
    "confluence.deletePage",
    "confluence.export",
    "confluence.getPage",
    "confluence.movePage",
    "confluence.removeLabels",
    "confluence.search",
    "confluence.updatePage",
    "confluence.upsertPage",
    "jira.addLabels",
    "jira.assign",
    "jira.attach",
    "jira.boards",
    "jira.comment",
    "jira.copyAttachment",
    "jira.create",
    "jira.createSprint",
    "jira.get",
    "jira.link",
    "jira.moveToSprint",
    "jira.removeLabels",
    "jira.search",
    "jira.sprints",
    "jira.transition",
    "jira.update",
    "jira.updateSprint",
  ]);
});

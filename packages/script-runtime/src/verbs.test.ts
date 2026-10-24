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
  jiraCreateIssue = this.write;
  jiraUpdateIssue = this.write;
  jiraTransitionIssue = this.write;
  jiraAddComment = this.write;
  confluenceCreatePage = this.write;
  confluenceUpdatePage = this.write;
  confluenceAddLabels = this.write;
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
    expect(result.value).toEqual(["Release Notes"]);
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
      { seq: 5, verb: "confluence.addLabels", args: { pageId: "100", labels: ["release"] }, dependsOn: [4] },
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

it("exposes the MVP verb set", () => {
  expect([...SCRIPT_VERBS].sort()).toEqual([
    "confluence.addLabels",
    "confluence.createPage",
    "confluence.getPage",
    "confluence.search",
    "confluence.updatePage",
    "confluence.upsertPage",
    "jira.comment",
    "jira.create",
    "jira.get",
    "jira.search",
    "jira.transition",
    "jira.update",
  ]);
});

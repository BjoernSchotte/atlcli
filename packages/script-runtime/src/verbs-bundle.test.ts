import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import type { ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { parseDuration, planScript, type PlanScriptOptions } from "./verbs.js";

const BASE = "https://example.atlassian.net";
const plan = (js: string, port: ScriptPort, extra: Partial<PlanScriptOptions> = {}) => planScript(js, { port, variant: DEBUG_VARIANT, ...extra });
const apply = (operations: Awaited<ReturnType<typeof plan>>["operations"], port: ScriptPort) =>
  applyScriptPlan({ target: { baseUrl: BASE }, operations }, { port, baseUrl: BASE });

async function scriptError(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

/** A small Jira/Confluence with the bundle's read and write ports; writes are logged. */
function site() {
  const calls: unknown[][] = [];
  const log = (...args: unknown[]) => calls.push(args);
  const versions = [{ id: "100", name: "1.0", project: "ATL", released: false, archived: false }];
  const properties: Record<string, unknown> = { existing: { a: 1 } };
  let updated = "2026-10-26T10:00:00.000+0000";
  const port = {
    jiraGetIssue: async (key: string) => ({ id: "1", key, fields: { updated } }),
    jiraFindUser: async (q: string) => ({ accountId: `id-${q}` }),
    confluenceGetPage: async (id: string) => ({ id, title: "Page", spaceKey: "DOCSY", version: 3, markdown: "" }),
    confluenceSearch: async (cql: string, o: { cursor?: string }) => {
      log("search", cql, o.cursor ?? null);
      return o.cursor ? { results: [{ id: "3", title: "C", spaceKey: "DOCSY" }] } : { results: [{ id: "2", title: "B", spaceKey: "DOCSY" }], nextCursor: "100" };
    },
    jiraRequest: async (method: string, path: string, o: unknown) => (log("jiraRequest", method, path, o), { id: "10500", key: "ATL-77" }),
    confluenceRequest: async (method: string, path: string) => (log("confluenceRequest", method, path), {}),
    jiraComments: async () => [{ id: "5", markdown: "hi" }],
    jiraUpdateComment: async (...a: unknown[]) => void log("jiraUpdateComment", ...a),
    jiraDeleteComment: async (...a: unknown[]) => void log("jiraDeleteComment", ...a),
    jiraWorklogs: async () => [],
    jiraAddWorklog: async (key: string, input: unknown) => (log("jiraAddWorklog", key, input), { id: "w1" }),
    jiraVersions: async () => versions,
    jiraGetVersion: async (id: string) => versions.find((v) => v.id === id)!,
    jiraCreateVersion: async (input: unknown) => (log("jiraCreateVersion", input), { id: "200" }),
    jiraUpdateVersion: async (...a: unknown[]) => void log("jiraUpdateVersion", ...a),
    jiraComponents: async () => [{ id: "7", name: "Core", project: "ATL" }],
    jiraGetComponent: async (id: string) => ({ id, name: "Core", project: "ATL" }),
    jiraCreateComponent: async (input: unknown) => (log("jiraCreateComponent", input), { id: "8" }),
    jiraUpdateComponent: async (...a: unknown[]) => void log("jiraUpdateComponent", ...a),
    jiraRank: async (...a: unknown[]) => void log("jiraRank", ...a),
    jiraDeleteIssue: async (...a: unknown[]) => void log("jiraDeleteIssue", ...a),
    jiraCloneIssue: async (key: string, input: unknown) => (log("jiraCloneIssue", key, input), { id: "9", key: "ATL-9" }),
    jiraAddComment: async (key: string, body: unknown) => (log("jiraAddComment", key, body), { id: "c1" }),
    jiraLinks: async () => [{ id: "L1", type: "Blocks", direction: "outward", phrase: "blocks", issue: { key: "ATL-2" } }],
    jiraDeleteLink: async (id: string) => void log("jiraDeleteLink", id),
    jiraFields: async () => (log("jiraFields"), [
      { id: "summary", name: "Summary", custom: false },
      { id: "customfield_1", name: "Story Points", custom: true },
      { id: "customfield_2", name: "Team", custom: true },
      { id: "customfield_3", name: "Team", custom: true },
    ]),
    confluenceProperties: async () => properties,
    confluenceSetProperty: async (...a: unknown[]) => void log("confluenceSetProperty", ...a),
    confluenceDeleteProperty: async (...a: unknown[]) => void log("confluenceDeleteProperty", ...a),
    confluenceRestrictions: async () => ({ read: { accountIds: ["a", "b"], groupIds: [] }, update: { accountIds: [], groupIds: ["g"] } }),
    confluenceSetRestrictions: async (...a: unknown[]) => void log("confluenceSetRestrictions", ...a),
    confluenceSpaces: async (o: { cursor?: string; type?: string }) => (log("spaces", o.cursor ?? null, o.type ?? null), o.cursor ? { results: [{ key: "B", name: "B", type: "global" }] } : { results: [{ key: "A", name: "A", type: "global" }], nextCursor: "1" }),
    confluenceCreateBlogPost: async (input: unknown) => (log("confluenceCreateBlogPost", input), { id: "55", version: 1 }),
  } as unknown as ScriptPort;
  return { port, calls, writes: () => calls.filter((c) => !["search", "spaces", "jiraFields"].includes(c[0] as string)), touch: () => (updated = "2026-10-26T11:00:00.000+0000") };
}

describe("jira.request and confluence.request", () => {
  it("plan the write, derive the grant from the path and resolve later references to the response's key", async () => {
    const { port, writes } = site();
    const run = await plan(
      `const v = await atlcli.jira.request("post", "/rest/api/3/issue/ATL-1/comment", { body: { body: "x" } });
       await atlcli.jira.comment("ATL-1", "see " + v.key);`,
      port,
    );
    expect(run.operations.map((o) => [o.verb, o.args])).toEqual([
      ["jira.request", { method: "POST", path: "/rest/api/3/issue/ATL-1/comment", body: { body: "x" } }],
      ["jira.comment", { key: "ATL-1", markdown: "see plan:1" }],
    ]);
    expect(writes()).toEqual([]);
    const report = await apply(run.operations, port);
    expect(report.status).toBe("applied");
    expect(writes()).toEqual([
      ["jiraRequest", "POST", "/rest/api/3/issue/ATL-1/comment", { body: { body: "x" }, query: undefined }],
      ["jiraAddComment", "ATL-1", "see ATL-77"],
    ]);
  });

  it("need jira:write:<P> for a project path and jira:write:* for anything else", async () => {
    const { port } = site();
    const meta = `export const meta = { permissions: ["jira:write:ATL"] };`;
    await plan(`${meta} await atlcli.jira.request("PUT", "/rest/api/3/project/ATL/role/1", { body: {} });`, port);
    const denied = await scriptError(plan(`${meta} await atlcli.jira.request("POST", "/rest/api/3/version", { body: {} });`, port));
    expect(denied.message).toContain('"jira:write:*"');
    await plan(`export const meta = { permissions: ["jira:write:*"] }; await atlcli.jira.request("POST", "/rest/api/3/version");`, port);
    const confluence = await scriptError(plan(`export const meta = { permissions: ["confluence:write:DOCSY"] }; await atlcli.confluence.request("POST", "/rest/api/content");`, port));
    expect(confluence.message).toContain('"confluence:write:*"');
  });

  it("refuse GET and paths of the other product", async () => {
    const { port } = site();
    await expect(plan(`await atlcli.jira.request("GET", "/rest/api/3/field")`, port)).rejects.toThrow(/GET is jira.rest/);
    await expect(plan(`await atlcli.jira.request("POST", "/wiki/rest/api/content")`, port)).rejects.toThrow(/start with \/rest\//);
    await expect(plan(`await atlcli.confluence.request("POST", "/rest/agile/1.0/board")`, port)).rejects.toThrow(/\/rest\/api\/ or \/api\/v2\//);
  });
});

describe("Jira verbs", () => {
  it("comments: read, edit and delete as planned operations", async () => {
    const { port, writes } = site();
    const run = await plan(
      `const [c] = await atlcli.jira.comments("ATL-1");
       await atlcli.jira.updateComment("ATL-1", c.id, "**new**");
       await atlcli.jira.deleteComment("ATL-1", "6");`,
      port,
    );
    await apply(run.operations, port);
    expect(writes()).toEqual([
      ["jiraUpdateComment", "ATL-1", "5", "**new**"],
      ["jiraDeleteComment", "ATL-1", "6"],
    ]);
  });

  it("addWorklog takes Jira durations", async () => {
    expect([parseDuration("1h 30m"), parseDuration("2d"), parseDuration("1w"), parseDuration(90)]).toEqual([5400, 57600, 144000, 90]);
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
    const { port, writes } = site();
    const run = await plan(`await atlcli.jira.addWorklog("ATL-1", { timeSpent: "45m", comment: "review" })`, port);
    await apply(run.operations, port);
    expect(writes()).toEqual([["jiraAddWorklog", "ATL-1", { timeSpentSeconds: 2700, comment: "review" }]]);
  });

  it("versions: an existing name is reused, a new one created and released through its placeholder", async () => {
    const { port, writes } = site();
    const run = await plan(
      `const old = await atlcli.jira.createVersion("ATL", { name: "1.0" });
       const next = await atlcli.jira.createVersion("ATL", { name: "2.0", releaseDate: "2026-11-01" });
       await atlcli.jira.updateVersion(next.id, { released: true });
       await atlcli.jira.updateVersion(old.id, { released: false });
       export default old.id;`,
      port,
    );
    expect(run.value).toBe("100");
    expect(run.skipped.map((s) => s.verb)).toEqual(["jira.createVersion", "jira.updateVersion"]);
    await apply(run.operations, port);
    expect(writes()).toEqual([
      ["jiraCreateVersion", { project: "ATL", name: "2.0", releaseDate: "2026-11-01" }],
      ["jiraUpdateVersion", "200", { released: true }],
    ]);
  });

  it("components: lead resolved like assign; unchanged updates are skipped", async () => {
    const { port, writes } = site();
    const run = await plan(
      `await atlcli.jira.createComponent("ATL", { name: "Core" });
       await atlcli.jira.createComponent("ATL", { name: "UI", lead: "me" });
       await atlcli.jira.updateComponent("7", { name: "Core" });
       await atlcli.jira.updateComponent("7", { description: "Engine" });`,
      port,
    );
    expect(run.skipped.map((s) => s.verb)).toEqual(["jira.createComponent", "jira.updateComponent"]);
    await apply(run.operations, port);
    expect(writes()).toEqual([
      ["jiraCreateComponent", { project: "ATL", name: "UI", lead: { accountId: "id-me" } }],
      ["jiraUpdateComponent", "7", { description: "Engine" }],
    ]);
  });

  it("rank, clone and unlink; a clone's key stands in for later writes", async () => {
    const { port, writes } = site();
    const run = await plan(
      `await atlcli.jira.rank(["ATL-3", "ATL-4"], { before: "ATL-1" });
       const copy = await atlcli.jira.clone("ATL-1", { summary: "Copy" });
       await atlcli.jira.comment(copy.key, "cloned");
       await atlcli.jira.unlink("ATL-1", "L1");
       await atlcli.jira.unlink("ATL-1", "L9");`,
      port,
    );
    expect(run.skipped).toEqual([{ verb: "jira.unlink", target: "ATL-1", title: "L9", reason: "unchanged" }]);
    await apply(run.operations, port);
    expect(writes()).toEqual([
      ["jiraRank", ["ATL-3", "ATL-4"], { before: "ATL-1" }],
      ["jiraCloneIssue", "ATL-1", { summary: "Copy" }],
      ["jiraAddComment", "ATL-9", "cloned"],
      ["jiraDeleteLink", "L1"],
    ]);
    await expect(plan(`await atlcli.jira.rank(["ATL-1"], { after: "ATL-1" })`, port)).rejects.toThrow(/relative to itself/);
  });

  it("deleteIssue carries a precondition, so a changed issue is drift", async () => {
    const { port, writes, touch } = site();
    const run = await plan(`await atlcli.jira.deleteIssue("ATL-1", { subtasks: true })`, port);
    expect(run.operations[0]!.precondition).toEqual({ kind: "jira-issue-unchanged", key: "ATL-1", updated: "2026-10-26T10:00:00.000+0000" });
    touch();
    expect((await apply(run.operations, port)).status).toBe("drift");
    expect(writes()).toEqual([]);
  });

  it("fieldId resolves ids and names once per run and refuses ambiguous names", async () => {
    const { port, calls } = site();
    const run = await plan(`export default [await atlcli.jira.fieldId("story points"), await atlcli.jira.fieldId("summary")];`, port);
    expect(run.value).toEqual(["customfield_1", "summary"]);
    expect(calls.filter((c) => c[0] === "jiraFields")).toHaveLength(1);
    await expect(plan(`await atlcli.jira.fieldId("Team")`, port)).rejects.toThrow(/customfield_2, customfield_3/);
    await expect(plan(`await atlcli.jira.fieldId("Nope")`, port)).rejects.toThrow(/No field is named/);
  });
});

describe("Confluence verbs", () => {
  it("properties: same value and absent key are skipped", async () => {
    const { port, writes } = site();
    const run = await plan(
      `await atlcli.confluence.setProperty("42", "existing", { a: 1 });
       await atlcli.confluence.setProperty("42", "fresh", [1, 2]);
       await atlcli.confluence.deleteProperty("42", "missing");
       await atlcli.confluence.deleteProperty("42", "existing");`,
      port,
    );
    expect(run.skipped.map((s) => `${s.verb} ${s.title}`)).toEqual(["confluence.setProperty existing", "confluence.deleteProperty missing"]);
    await apply(run.operations, port);
    expect(writes()).toEqual([
      ["confluenceSetProperty", "42", "fresh", [1, 2]],
      ["confluenceDeleteProperty", "42", "existing"],
    ]);
  });

  it("setRestrictions compares as sets and is skipped when nothing changes", async () => {
    const { port, writes } = site();
    const same = await plan(`await atlcli.confluence.setRestrictions("42", { read: { accountIds: ["b", "a", "a"] } })`, port);
    expect(same.operations).toEqual([]);
    const run = await plan(`await atlcli.confluence.setRestrictions("42", { update: { groupIds: [] } })`, port);
    await apply(run.operations, port);
    expect(writes()).toEqual([["confluenceSetRestrictions", "42", { update: { accountIds: [], groupIds: [] } }]]);
  });

  it("descendants and spaces page as iterators", async () => {
    const { port, calls } = site();
    const run = await plan(
      `const d = []; for await (const p of atlcli.confluence.descendants("42")) d.push(p.id);
       const s = []; for await (const sp of atlcli.confluence.spaces({ type: "global" })) s.push(sp.key);
       export default { d, s };`,
      port,
    );
    expect(run.value).toEqual({ d: ["2", "3"], s: ["A", "B"] });
    expect(calls.filter((c) => c[0] === "search")).toEqual([
      ["search", "ancestor = 42 AND type = page", null],
      ["search", "ancestor = 42 AND type = page", "100"],
    ]);
    expect(calls.filter((c) => c[0] === "spaces")).toEqual([
      ["spaces", null, "global"],
      ["spaces", "1", "global"],
    ]);
    await expect(plan(`for await (const p of atlcli.confluence.descendants("42 OR 1=1")) {}`, port)).rejects.toThrow(/a page id/);
  });

  it("createBlogPost needs a write grant on the space", async () => {
    const { port, writes } = site();
    const denied = await scriptError(plan(`export const meta = { permissions: ["confluence:read"] }; await atlcli.confluence.createBlogPost({ space: "DOCSY", title: "T", markdown: "x" })`, port));
    expect(denied.kind).toBe("permission-denied");
    const run = await plan(`export default await atlcli.confluence.createBlogPost({ space: "DOCSY", title: "T", markdown: "x" })`, port);
    expect(run.value).toEqual({ id: "plan:1" });
    await apply(run.operations, port);
    expect(writes()).toEqual([["confluenceCreateBlogPost", { spaceKey: "DOCSY", title: "T", markdown: "x" }]]);
  });
});

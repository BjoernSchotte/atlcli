import { expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import { createScriptPlan } from "./plan.js";
import type { JiraUserRef, ScriptPort, TransitionOptions } from "./port.js";
import { planScript } from "./verbs.js";

const BASE = "https://example.atlassian.net";

/** Records writes; ATLCLI-1 is watched by ada and open. */
function port(writes: unknown[] = []): ScriptPort {
  return {
    async jiraGetIssue(key: string) {
      return { id: "1", key, fields: { updated: "2026-10-25T00:00:00Z", status: { name: "Open" } } };
    },
    async jiraGetTransitions() {
      return ["Fertig", "In Arbeit"];
    },
    async jiraFindUser(query: string) {
      return { accountId: `acc-${query}` };
    },
    async jiraTransitions() {
      return [{ name: "Fertig", to: { name: "Fertig", category: "done" } }];
    },
    async jiraHistory(_key: string, o: { fields?: string[] }) {
      return [{ at: "2026-10-01T00:00:00Z", field: "status", from: "Open", to: "In Arbeit" }].filter((c) => !o.fields || o.fields.includes(c.field));
    },
    async jiraWatchers() {
      return [{ accountId: "acc-ada", displayName: "Ada" }];
    },
    async jiraTransitionIssue(key: string, transition: string, options?: TransitionOptions) {
      writes.push(["transition", key, transition, options ?? null]);
    },
    async jiraSetStatus(key: string, status: string, options?: TransitionOptions) {
      writes.push(["setStatus", key, status, options ?? null]);
      return { moved: true, transition: status };
    },
    async jiraAddWatcher(key: string, user: JiraUserRef) {
      writes.push(["watch+", key, user]);
    },
    async jiraRemoveWatcher(key: string, user: JiraUserRef) {
      writes.push(["watch-", key, user]);
    },
    async jiraNotify(key: string, input: unknown) {
      writes.push(["notify", key, input]);
    },
  } as unknown as ScriptPort;
}

async function planAndApply(js: string) {
  const writes: unknown[] = [];
  const p = port(writes);
  const run = await planScript(js, { port: p, variant: DEBUG_VARIANT });
  const plan = await createScriptPlan(run, { source: js, baseUrl: BASE });
  const report = await applyScriptPlan(plan, { port: p, baseUrl: BASE });
  return { run, report, writes };
}

it("transition and setStatus carry screen fields and a comment through plan and apply", async () => {
  const { run, report, writes } = await planAndApply(`
    await atlcli.jira.transition("ATLCLI-1", "fertig", { fields: { resolution: { name: "Done" } }, comment: "Closed by **script**" });
    await atlcli.jira.setStatus("ATLCLI-2", "Fertig", { comment: "bye" });
    await atlcli.jira.transition("ATLCLI-3", "In Arbeit");`);
  expect(run.operations.map((o) => o.args)).toEqual([
    { key: "ATLCLI-1", transition: "fertig", fields: { resolution: { name: "Done" } }, comment: "Closed by **script**" },
    { key: "ATLCLI-2", status: "Fertig", comment: "bye" },
    { key: "ATLCLI-3", transition: "In Arbeit" },
  ]);
  expect(report.status).toBe("applied");
  expect(writes).toEqual([
    ["transition", "ATLCLI-1", "fertig", { fields: { resolution: { name: "Done" } }, comment: "Closed by **script**" }],
    ["setStatus", "ATLCLI-2", "Fertig", { comment: "bye" }],
    ["transition", "ATLCLI-3", "In Arbeit", null],
  ]);
});

it("reads transitions, history and watchers without planning anything", async () => {
  const { run } = await planAndApply(`export default {
    t: await atlcli.jira.transitions("ATLCLI-1"),
    h: await atlcli.jira.history("ATLCLI-1", { fields: ["status"] }),
    none: await atlcli.jira.history("ATLCLI-1", { fields: ["labels"] }),
    w: await atlcli.jira.watchers("ATLCLI-1"),
  }`);
  expect(run.operations).toEqual([]);
  expect(run.value).toEqual({
    t: [{ name: "Fertig", to: { name: "Fertig", category: "done" } }],
    h: [{ at: "2026-10-01T00:00:00Z", field: "status", from: "Open", to: "In Arbeit" }],
    none: [],
    w: [{ accountId: "acc-ada", displayName: "Ada" }],
  });
});

it("adds and removes watchers, skipping what would change nothing", async () => {
  const { run, writes } = await planAndApply(`
    await atlcli.jira.addWatcher("ATLCLI-1", "ada");      // already watching
    await atlcli.jira.addWatcher("ATLCLI-1", "bob");
    await atlcli.jira.removeWatcher("ATLCLI-1", "ada");
    await atlcli.jira.removeWatcher("ATLCLI-1", "carl");  // not watching`);
  expect(run.skipped).toEqual([
    { verb: "jira.addWatcher", target: "ATLCLI-1", title: "ada", reason: "unchanged" },
    { verb: "jira.removeWatcher", target: "ATLCLI-1", title: "carl", reason: "unchanged" },
  ]);
  expect(writes).toEqual([
    ["watch+", "ATLCLI-1", { accountId: "acc-bob" }],
    ["watch-", "ATLCLI-1", { accountId: "acc-ada" }],
  ]);
});

it("notify resolves users when planning and needs a recipient", async () => {
  const { writes } = await planAndApply(`
    await atlcli.jira.notify("ATLCLI-1", { subject: "Heads up", markdown: "Please *review*", to: { users: ["ada"], groups: ["devs"], assignee: true } });`);
  expect(writes).toEqual([
    ["notify", "ATLCLI-1", { subject: "Heads up", markdown: "Please *review*", to: { users: [{ accountId: "acc-ada" }], groups: ["devs"], assignee: true } }],
  ]);
  await expect(planAndApply(`await atlcli.jira.notify("ATLCLI-1", { subject: "x", markdown: "y", to: {} })`)).rejects.toThrow(/at least one recipient/);
});

it("needs write permission on the project for watcher and notify writes", async () => {
  const js = `export const meta = { permissions: ["jira:read"] }; await atlcli.jira.addWatcher("ATLCLI-1", "bob");`;
  await expect(planScript(js, { port: port(), variant: DEBUG_VARIANT })).rejects.toThrow(/jira:write:ATLCLI/);
});

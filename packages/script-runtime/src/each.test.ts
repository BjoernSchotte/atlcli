import { expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { parseScriptMeta } from "./meta.js";
import type { JiraIssueView, ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { planScript } from "./verbs.js";

const issue = (key: string, status = "Open"): JiraIssueView => ({ id: key, key, fields: { updated: "2026-10-25T00:00:00Z", status: { name: status } } });

function port(calls: string[] = []): ScriptPort {
  return {
    async jiraGetIssue(key: string) {
      calls.push(`get:${key}`);
      return issue(key);
    },
    async jiraFindUser(query: string) {
      calls.push(`user:${query}`);
      return { accountId: `acc-${query}` };
    },
    async jiraLinkTypes() {
      calls.push("linkTypes");
      return [{ name: "Blocks", outward: "blocks", inward: "is blocked by" }];
    },
  } as unknown as ScriptPort;
}

it("calls the default export with the issue and params", async () => {
  const run = await planScript(
    `export default async (issue, params) => {
       if (issue.fields.status.name !== "Done") await atlcli.jira.comment(issue.key, params.text);
       return issue.key;
     }`,
    { port: port(), item: issue("A-1"), params: { text: "Still needed?" }, variant: DEBUG_VARIANT },
  );
  expect(run.value).toBe("A-1");
  expect(run.operations).toEqual([{ seq: 1, verb: "jira.comment", args: { key: "A-1", markdown: "Still needed?" }, dependsOn: [] }]);
});

it("requires a default-export function in per-issue mode", async () => {
  const error = await planScript(`await atlcli.jira.comment("A-1", "x")`, { port: port(), item: issue("A-1"), variant: DEBUG_VARIANT }).catch((e) => e);
  expect(error).toBeInstanceOf(ScriptError);
  expect((error as ScriptError).kind).toBe("invalid-script");
  expect((error as ScriptError).message).toContain("export default async (issue)");
});

it("shares issue-independent lookups across runs through memo", async () => {
  const calls: string[] = [];
  const memo = new Map<string, Promise<unknown>>();
  const js = `export default async (issue) => {
    await atlcli.jira.assign(issue.key, "ada");
    await atlcli.jira.link(issue.key, "blocks", "A-9");
  }`;
  for (const key of ["A-1", "A-2", "A-3"]) {
    const run = await planScript(js, { port: port(calls), item: issue(key), memo, variant: DEBUG_VARIANT });
    expect(run.operations.map((o) => o.verb)).toEqual(["jira.assign", "jira.link"]);
  }
  expect(calls.filter((c) => c === "user:ada" || c === "linkTypes")).toEqual(["user:ada", "linkTypes"]);
});

it("meta.each declares the selection", () => {
  expect(parseScriptMeta({ each: { jql: "project = A", fields: ["summary"] } }).each).toEqual({ jql: "project = A", fields: ["summary"] });
  expect(() => parseScriptMeta({ each: { jql: "" } })).toThrow(/meta.each.jql/);
  expect(() => parseScriptMeta({ each: { query: "x" } })).toThrow(/meta.each/);
});

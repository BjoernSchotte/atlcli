/**
 * Every example `atlcli script init --example` writes type-checks against the
 * shipped atlcli.d.ts and plans in the real sandbox, so none of them rots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATLCLI_SCRIPT_TYPES, planScript, type JiraIssueView, type ScriptPort } from "@atlcli/script-runtime";
import { AUDIT_RULE_SKELETONS } from "../commands/audit-scripts.js";
import { eachSkeleton } from "../commands/script.js";
import { SCRIPT_EXAMPLES } from "./examples.js";

setDefaultTimeout(60_000);

const issue = (n: number, fields: Record<string, unknown> = {}): JiraIssueView => ({
  id: String(n),
  key: `ATLCLI-${n}`,
  fields: {
    updated: "2026-10-25T00:00:00Z",
    summary: `Issue ${n}`,
    labels: ["Front_End", "ui"],
    status: { name: "Open", statusCategory: { key: "new" } },
    customfield_1: "x",
    project: { key: "ATLCLI" },
    parent: { key: "ATLCLI-1" },
    fixVersions: [],
    subtasks: [{ key: "ATLCLI-8", fields: { summary: "Done one", status: { statusCategory: { key: "done" } } } }],
    issuelinks: [{ type: { inward: "is blocked by" }, inwardIssue: { key: "ATLCLI-9", fields: { status: { statusCategory: { key: "done" } } } } }],
    ...fields,
  },
});

/** Reads only; every write verb is planned, never called. */
const port = {
  async jiraSearch(jql: string) {
    if (jql.includes("issuetype = Epic")) return { issues: [issue(1, { summary: "Epic" })] };
    if (jql.includes("childrenOf")) return { issues: [issue(2, { status: { statusCategory: { key: "done" } } }), issue(3)] };
    return { issues: [issue(7)] };
  },
  async jiraGetIssue(key: string) {
    return key === "ATLCLI-1" ? issue(1, { fixVersions: [{ name: "2026.11" }] }) : { ...issue(7), key };
  },
  async jiraGetTransitions() {
    return ["Done"];
  },
  async jiraRest() {
    return [{ id: "customfield_1", name: "Team", custom: true }, { id: "summary", name: "Summary", custom: false }];
  },
  async confluenceFindPage() {
    return null;
  },
  async jiraVersions() {
    return [{ id: "100", name: "2026.11", project: "ATLCLI", released: false, archived: false }];
  },
  async jiraGetVersion() {
    return { id: "100", name: "2026.11", project: "ATLCLI", released: false, archived: false };
  },
  async jiraWorklogs() {
    return [{ id: "1", author: { displayName: "Ada, L." }, started: new Date().toISOString(), timeSpentSeconds: 5400 }];
  },
  secret: () => "T000/B000/XXXX",
  confluenceNormalizeMarkdown: (m: string) => m,
  outputOpen: async (path: string) => (outputs.set(path, ""), path),
  outputWrite: async (path: string, chunk: string) => void outputs.set(path, outputs.get(path)! + chunk),
  outputClose: async (path: string) => ({ path, bytes: outputs.get(path)!.length, sha256: "x" }),
} as unknown as ScriptPort;
const outputs = new Map<string, string>();

const transpile = (source: string) => new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);

describe("script examples", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlcli-examples-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("type-check against atlcli.d.ts, like `atlcli script check`", async () => {
    await writeFile(join(dir, "atlcli.d.ts"), ATLCLI_SCRIPT_TYPES);
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022"], types: [], strict: true, noEmit: true, moduleDetection: "force", erasableSyntaxOnly: true, skipLibCheck: true },
        include: ["*.ts"],
      }),
    );
    for (const example of SCRIPT_EXAMPLES) await writeFile(join(dir, `${example.name}.ts`), example.source);
    await writeFile(join(dir, "each.ts"), eachSkeleton("project = ATLCLI"));
    for (const [product, source] of Object.entries(AUDIT_RULE_SKELETONS)) await writeFile(join(dir, `audit-${product}.ts`), source);
    const tsc = Bun.which("tsc", { cwd: process.cwd(), PATH: `${join(process.cwd(), "node_modules", ".bin")}:${process.env.PATH}` });
    expect(tsc).toBeTruthy();
    const proc = Bun.spawn([tsc!, "--noEmit", "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  for (const example of SCRIPT_EXAMPLES) {
    it(`${example.name} plans (${example.mode})`, async () => {
      const params: Record<string, string> =
        {
          "copy-field": { from: "customfield_1", to: "customfield_2" },
          "unblock-when-blocker-done": { blocked: "Open" },
          "subtasks-from-checklist": { parent: "ATLCLI-7", items: "Laptop; done one" },
          "release-version": { project: "ATLCLI", version: "2026.11" },
          "worklog-report": { project: "ATLCLI" },
        }[example.name] ?? {};
      const run = await planScript(transpile(example.source), {
        port,
        params,
        ...(example.mode === "each" ? { item: issue(7) } : {}),
      });
      expect(Boolean(run.meta.each)).toBe(example.mode === "each");
      if (example.name === "field-usage") expect(run.value).toEqual({ Team: 1 });
      else if (example.name === "worklog-report") {
        expect(run.operations).toEqual([]);
        expect(outputs.get("worklogs-ATLCLI.csv")).toBe('issue,summary,person,hours\r\nATLCLI-7,Issue 7,"Ada, L.",1.50\r\n');
      }
      else expect(run.operations.length + run.skipped.length).toBeGreaterThan(0);
    });
  }
});

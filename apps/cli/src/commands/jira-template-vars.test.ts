import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initJinja } from "@atlcli/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemplateScope, RenderBudget } from "@atlcli/core";
import { inferTemplateVariables, renderTemplateFields } from "./jira.js";

beforeAll(() => initJinja());

const fields = {
  issuetype: { name: "Task" },
  summary: "Release {{version}}",
  description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Owner {{owner}} on {{ today }}" }] }] },
  labels: ["rel-{{version}}"],
  duedate: "{{ today | dateAdd(14, 'd') }}",
  components: [{ name: "Comp {{version}}" }],
};

describe("jira template variables", () => {
  test("infers used variables as required strings", () => {
    expect(inferTemplateVariables(fields as never)).toEqual([
      { name: "owner", type: "string", required: true },
      { name: "version", type: "string", required: true },
    ]);
  });
  test("renders every templated field", () => {
    const scope = createTemplateScope({ vars: { version: "4.2", owner: "Ann" }, now: new Date("2026-10-25T08:00:00Z") });
    const out = renderTemplateFields(fields as never, scope, new RenderBudget());
    expect(out.fields.summary).toBe("Release 4.2");
    expect(out.fields.labels).toEqual(["rel-4.2"]);
    expect(out.fields.duedate).toBe("2026-11-08");
    expect(out.fields.components).toEqual([{ name: "Comp 4.2" }]);
    expect(JSON.stringify(out.fields.description)).toContain("Owner Ann on 2026-10-25");
    expect(out.warnings).toEqual([]);
  });
  test("templates without placeholders render unchanged", () => {
    const plain = { issuetype: { name: "Bug" }, summary: "Plain", priority: { id: "3" } };
    const out = renderTemplateFields(plain as never, createTemplateScope({}), new RenderBudget());
    expect(out.fields).toEqual(plain);
    expect(out.warnings).toEqual([]);
  });
});

describe("jira template apply without a terminal", () => {
  const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "atlcli-template-vars-"));
    await mkdir(join(home, ".atlcli"), { recursive: true });
    await writeFile(
      join(home, ".atlcli", "config.json"),
      JSON.stringify({
        currentProfile: "p",
        profiles: { p: { name: "p", baseUrl: "http://127.0.0.1:9", deploymentType: "data-center", auth: { type: "bearer" } } },
      }),
    );
    const dir = join(home, "templates", "jira", "global");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rel.json"),
      JSON.stringify({
        name: "rel",
        createdAt: "2026-10-25T00:00:00.000Z",
        fields: { issuetype: { name: "Task" }, summary: "Release {{version}}" },
        variables: [{ name: "version", type: "string", required: true }],
      }),
    );
  });
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("fails listing the missing variables before any request", async () => {
    const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", "template", "apply", "rel", "--project", "X", "--json"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_TEMPLATES_DIR: join(home, "templates"), ATLCLI_API_TOKEN: "t", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("Missing required template variables: version");
  }, 30_000);
});

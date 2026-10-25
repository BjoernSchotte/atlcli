/**
 * The built-in copy-issues script, planned in the real sandbox against a small
 * in-memory Jira. Only planning is exercised here; apply is the generic
 * plan/apply engine with its own tests.
 */
import { describe, expect, it } from "bun:test";
import { replaceInBody } from "@atlcli/jira";
import { planScript, type JiraIssueView, type PlannedOperation, type ScriptPort } from "@atlcli/script-runtime";
import source from "./copy-issues.script" with { type: "text" };
import { createTemplateRenderer } from "../commands/template-flags.js";

const script = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string) => ({ type: "text", text: t });

function issue(key: string, fields: Record<string, unknown>, properties?: Record<string, unknown>): JiraIssueView {
  return { id: key.replace(/\D/g, ""), key, fields: { updated: "2026-10-01T00:00:00Z", summary: key, issuetype: { name: "Task" }, ...fields }, ...(properties ? { properties } : {}) };
}

class FakeJira {
  calls: string[] = [];
  linkTypes = [
    { name: "Blocks", outward: "blocks", inward: "is blocked by" },
    { name: "Relates", outward: "relates to", inward: "relates to" },
    { name: "Cloners", outward: "clones", inward: "is cloned by" },
  ];
  source = [
    issue("SUP-1", {
      summary: "Release {{version}} checks",
      description: doc(para(text("Ship {{version}} after "), { type: "mention", attrs: { id: "acc-2", text: "@Bob" } })),
      labels: ["dev"],
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      assignee: { accountId: "acc-1" },
      attachment: [{ id: "900", filename: "evidence.xlsx", size: 12_000_000 }],
      issuelinks: [
        { type: { name: "Blocks" }, outwardIssue: { key: "SUP-2" } },
        { type: { name: "Relates" }, outwardIssue: { key: "EXT-9" } },
      ],
      comment: {
        total: 1,
        comments: [{ author: { displayName: "Ann" }, created: "2026-01-02T10:00:00.000+0000", body: doc(para(text("cc "), { type: "mention", attrs: { id: "acc-2", text: "@Bob" } })) }],
      },
    }),
    issue("SUP-2", { status: { name: "To Do", statusCategory: { key: "new" } }, issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "SUP-1" } }, { type: { name: "Relates" }, inwardIssue: { key: "EXT-8" } }] }),
  ];
  children = [issue("SUP-3", { parent: { key: "SUP-1" }, issuetype: { name: "Sub-task" } })];
  copies: JiraIssueView[] = [];
  attachments = new Map([["900", { id: "900", filename: "evidence.xlsx", size: 12_000_000, mimeType: "application/vnd.ms-excel" }]]);

  port(): ScriptPort {
    const write = async (): Promise<never> => {
      throw new Error("planning must never write");
    };
    return {
      jiraSearch: async (jql: string) => {
        this.calls.push(jql);
        if (jql.startsWith('project = "DEV"')) return { issues: this.copies };
        if (jql.startsWith("parent in (")) {
          const keys = jql.slice(11, jql.indexOf(")")).split(", ");
          return { issues: this.children.filter((c) => keys.includes((c.fields.parent as { key: string }).key)) };
        }
        return { issues: this.source };
      },
      jiraGetIssue: async (key: string) => {
        const found = [...this.copies, ...this.source].find((i) => i.key === key);
        if (!found) throw new Error(`Issue does not exist: ${key}`);
        return found;
      },
      jiraLinkTypes: async () => this.linkTypes,
      jiraAttachmentInfo: async (id: string) => {
        const found = this.attachments.get(id);
        if (!found) throw new Error(`Attachment does not exist: ${id}`);
        return found;
      },
      jiraGetTransitions: async () => [],
      jiraFindUser: async (q: string) => ({ accountId: q }),
      confluenceNormalizeMarkdown: (m: string) => m,
      render: createTemplateRenderer(),
      jiraCreateIssue: write, jiraUpdateIssue: write, jiraTransitionIssue: write, jiraSetStatus: write, jiraAddComment: write,
      jiraLinkIssues: write, jiraAssignIssue: write, jiraEditLabels: write, jiraAttach: write, jiraCopyAttachment: write,
      jiraCreateSprint: write, jiraUpdateSprint: write, jiraMoveToSprint: write,
    } as unknown as ScriptPort;
  }
}

const DEFAULTS = {
  from: "SUP", jql: "", to: "DEV", attachments: true, links: true, subtasks: true, fields: "", replace: "[]",
  linkSource: false, comments: false, keepMentions: false, keepAssignee: false, keepStatus: false, statusMap: "{}",
};

const NOW = "2026-10-25T08:30:00.000Z";
type Templating = { vars: Record<string, unknown>; now: string; strict: boolean };

async function plan(params: Partial<typeof DEFAULTS> = {}, jira = new FakeJira(), templating?: Templating) {
  const run = await planScript(script, { port: jira.port(), params: { ...DEFAULTS, ...params }, maxWrites: 1000, ...(templating ? { templating } : {}) });
  const ops = run.operations;
  const value = run.value as { warnings: string[] } & Record<string, unknown>;
  return { ops, value, run, jira, created: (summary: string) => ops.find((o) => o.verb === "jira.create" && o.args.summary === summary)! };
}

const ref = (op: PlannedOperation) => `plan:${op.seq}`;

describe("copy-issues", () => {
  it("copies the selection and its subtasks, parents first", async () => {
    const { ops, value, created } = await plan();
    const creates = ops.filter((o) => o.verb === "jira.create").map((o) => o.args.summary);
    expect(creates).toEqual(["Release {{version}} checks", "SUP-2", "SUP-3"]);
    expect(created("SUP-3").args.fields).toEqual({ parent: { key: ref(created("Release {{version}} checks")) } });
    expect(created("SUP-2").args.properties).toEqual({ "atlcli.copiedFrom": { key: "SUP-2", id: "2" } });
    expect(value).toMatchObject({ issues: 3, subtasksPulledIn: 1, resumed: 0 });
  });

  it("never copies status, assignee or comments by default", async () => {
    const { ops, created } = await plan();
    expect(created("Release {{version}} checks").args.fields).toEqual({
      description: doc(para(text("Ship {{version}} after "), { type: "mention", attrs: { id: "acc-2", text: "@Bob" } })),
      labels: ["dev"],
    });
    expect(ops.some((o) => o.verb === "jira.comment" || o.verb === "jira.setStatus")).toBe(false);
  });

  it("leaves subtasks out with subtasks=false", async () => {
    const { ops, value } = await plan({ subtasks: false });
    expect(ops.filter((o) => o.verb === "jira.create")).toHaveLength(2);
    expect(value.subtasksPulledIn).toBe(0);
  });

  it("copies attachments by reference", async () => {
    const { ops, value, created } = await plan();
    const copy = ops.find((o) => o.verb === "jira.copyAttachment")!;
    expect(copy.args).toEqual({ id: "900", to: ref(created("Release {{version}} checks")), filename: "evidence.xlsx", size: 12_000_000 });
    expect(value).toMatchObject({ attachments: 1, attachmentBytes: 12_000_000 });
    expect((await plan({ attachments: false })).ops.some((o) => o.verb === "jira.copyAttachment")).toBe(false);
  });

  it("rewires links inside the set once and keeps links to issues outside it", async () => {
    const { ops, created } = await plan();
    const links = ops.filter((o) => o.verb === "jira.link").map((o) => [o.args.from, o.args.type, o.args.to]);
    const one = ref(created("Release {{version}} checks"));
    const two = ref(created("SUP-2"));
    expect(links).toEqual([
      [one, "Blocks", two],
      [one, "Relates", "EXT-9"],
      ["EXT-8", "Relates", two],
    ]);
    expect((await plan({ links: false })).ops.some((o) => o.verb === "jira.link")).toBe(false);
  });

  it("applies replacements to summary and ADF text like replaceInBody", async () => {
    const pairs: Array<[string, string]> = [["{{version}}", "2026.11"]];
    const jira = new FakeJira();
    const { created, value, run } = await plan({ replace: JSON.stringify(pairs) }, jira);
    const copy = created("Release 2026.11 checks");
    expect(copy.args.fields).toMatchObject({ description: replaceInBody(jira.source[0]!.fields.description, pairs) });
    expect(value.warnings).toEqual([]);
    expect(run.renderWarnings).toEqual([]);
  });

  describe("templates", () => {
    const templating = (vars: Record<string, unknown>, strict = false): Templating => ({ vars, now: NOW, strict });

    it("renders summary, description, labels and comments from --var", async () => {
      const jira = new FakeJira();
      jira.source[0]!.fields.labels = ["rel-{{version}}"];
      const { created } = await plan({ comments: true }, jira, templating({ version: "4.2" }));
      const copy = created("Release 4.2 checks");
      expect(JSON.stringify(copy.args.fields)).toContain("Ship 4.2 after ");
      expect((copy.args.fields as { labels: string[] }).labels).toEqual(["rel-4.2"]);
    });

    it("leaves unknown placeholders literal and reports them as render warnings", async () => {
      const { created, run, value } = await plan();
      expect(created("Release {{version}} checks")).toBeDefined();
      expect(run.renderWarnings.some((w) => w.unit === "SUP-1 summary" && w.code === "unresolved")).toBe(true);
      expect(value.warnings.some((w) => w.includes("placeholder"))).toBe(false);
    });

    it("applies --replace before rendering", async () => {
      const { created } = await plan({ replace: JSON.stringify([["{{version}}", "{{v}}"]]) }, new FakeJira(), templating({ v: "9" }));
      expect(created("Release 9 checks")).toBeDefined();
    });

    it("offers the source issue as {{source.*}}", async () => {
      const jira = new FakeJira();
      jira.source[1]!.fields.summary = "Copy of {{source.key}}";
      const { created } = await plan({}, jira, templating({}));
      expect(created("Copy of SUP-2")).toBeDefined();
    });

    it("a label that renders with whitespace fails the plan, not the apply", async () => {
      const jira = new FakeJira();
      jira.source[0]!.fields.labels = ["{{team}}"];
      const error = await plan({}, jira, templating({ team: "ops team", version: "1" })).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "ScriptError", kind: "template" });
      expect(String((error as Error).message)).toContain("whitespace");
    });

    it("strict fails the plan on a leftover placeholder", async () => {
      const error = await plan({}, new FakeJira(), templating({}, true)).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "ScriptError", kind: "template" });
    });

    it("same --now gives the same plan", async () => {
      const jira = new FakeJira();
      jira.source[1]!.fields.summary = "Run {{@uuid}} on {{@today}}";
      const a = await plan({}, jira, templating({ version: "1" }));
      const b = await plan({}, new FakeJira(), templating({ version: "1" }));
      jira.source[1]!.fields.summary = "Run {{@uuid}} on {{@today}}";
      const c = await plan({}, jira, templating({ version: "1" }));
      expect(c.ops).toEqual(a.ops);
      expect(b.ops).not.toEqual(a.ops);
    });
  });

  it("adds the project-split opt-ins", async () => {
    const { ops, created } = await plan({ linkSource: true, comments: true, keepAssignee: true, keepStatus: true, statusMap: JSON.stringify({ "In Progress": "Doing" }) });
    const one = created("Release {{version}} checks");
    expect(one.args.fields).toMatchObject({ assignee: { accountId: "acc-1" } });
    // Only SUP-1 is past "To Do"; SUP-2 starts in the right status already, SUP-3 has none.
    expect(ops.filter((o) => o.verb === "jira.setStatus").map((o) => o.args)).toEqual([{ key: ref(one), status: "Doing" }]);
    expect(ops.filter((o) => o.verb === "jira.link" && o.args.type === "Cloners").map((o) => o.args.to)).toEqual(["SUP-1", "SUP-2", "SUP-3"]);
    const comment = ops.find((o) => o.verb === "jira.comment")!.args.raw as ReturnType<typeof doc>;
    expect(comment.content).toEqual([
      para({ type: "text", text: "Originally by Ann on 2026-01-02", marks: [{ type: "em" }] }),
      para(text("cc "), text("@Bob")),
    ]);
    const kept = (await plan({ comments: true, keepMentions: true })).ops.find((o) => o.verb === "jira.comment")!.args.raw as ReturnType<typeof doc>;
    expect(JSON.stringify(kept)).toContain('"type":"mention"');
  });

  it("warns once and links nothing back when the site has no Cloners link type", async () => {
    const jira = new FakeJira();
    jira.linkTypes = jira.linkTypes.filter((t) => t.name !== "Cloners");
    const { ops, value } = await plan({ linkSource: true }, jira);
    expect(ops.some((o) => o.verb === "jira.link" && o.args.type === "Cloners")).toBe(false);
    expect(value.warnings.filter((w) => w.includes("Cloners"))).toHaveLength(1);
  });

  it("resumes after a partial apply: existing copies are reused, done work is skipped", async () => {
    const jira = new FakeJira();
    jira.copies = [
      issue(
        "DEV-5",
        {
          attachment: [{ id: "1200", filename: "evidence.xlsx", size: 12_000_000 }],
          issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "EXT-9" } }],
        },
        { "atlcli.copiedFrom": { key: "SUP-1", id: "1" } },
      ),
    ];
    const { ops, run, value, created } = await plan({}, jira);
    expect(ops.filter((o) => o.verb === "jira.create").map((o) => o.args.summary)).toEqual(["SUP-2", "SUP-3"]);
    expect(created("SUP-3").args.fields).toEqual({ parent: { key: "DEV-5" } });
    expect(ops.some((o) => o.verb === "jira.copyAttachment")).toBe(false);
    expect(run.skipped).toEqual([{ verb: "jira.copyAttachment", target: "DEV-5", title: "evidence.xlsx", reason: "unchanged" }]);
    expect(ops.filter((o) => o.verb === "jira.link").map((o) => [o.args.from, o.args.type, o.args.to])).toEqual([
      ["DEV-5", "Blocks", ref(created("SUP-2"))],
      ["EXT-8", "Relates", ref(created("SUP-2"))],
    ]);
    expect(value).toMatchObject({ issues: 2, resumed: 1 });
  });

  it("selects by JQL alone and never copies the target project", async () => {
    const { jira } = await plan({ from: "", jql: "project = SUP AND labels = dev" });
    expect(jira.calls[0]).toBe('(project = SUP AND labels = dev) AND project != "DEV" ORDER BY key');
    expect(jira.calls.find((c) => c.startsWith("parent in"))).toContain('project != "DEV"');
  });
});

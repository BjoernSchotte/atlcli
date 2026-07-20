import { describe, expect, test } from "bun:test";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { jiraMacroRenderer, jiraStatusColor, issueTable } from "./jira.js";
import { portError } from "./types.js";
import type { JiraIssuePort, JiraIssueRef, MacroExportContext } from "./types.js";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function ctx(jira?: JiraIssuePort): MacroExportContext {
  return { page: { id: "1" }, depth: 0, visited: new Set(), ...(jira ? { jira } : {}) };
}

const fixtureIssues: JiraIssueRef[] = [
  { key: "ATL-1", summary: "First", status: "Done", statusColor: "green", url: "/browse/ATL-1" },
  { key: "ATL-2", summary: "Second", status: "To Do", statusColor: "blue", url: "/browse/ATL-2" },
];

function port(overrides: Partial<JiraIssuePort> = {}): JiraIssuePort {
  return {
    async getIssue(key) {
      return fixtureIssues.find((i) => i.key === key) ?? fixtureIssues[0];
    },
    async searchJql(_jql, opts) {
      return fixtureIssues.slice(0, opts.maximumIssues);
    },
    ...overrides,
  };
}

describe("jiraStatusColor mapping", () => {
  test("maps category colors to Confluence status colors", () => {
    expect(jiraStatusColor("green")).toBe("green");
    expect(jiraStatusColor("yellow")).toBe("yellow");
    expect(jiraStatusColor("blue-gray")).toBe("blue");
    expect(jiraStatusColor("unknown")).toBe("grey");
  });
});

describe("issueTable shape", () => {
  test("has a header row plus one row per issue", () => {
    const table = issueTable(["key", "summary", "status"], fixtureIssues) as Extract<ExportBlock, { type: "table" }>;
    expect(table.rows.length).toBe(3);
    expect(table.rows[0].cells.every((c) => c.header)).toBe(true);
  });
});

describe("jiraMacroRenderer", () => {
  test("single issue → paragraph with bold link + status", async () => {
    const res = await jiraMacroRenderer().render({ name: "jira", params: [param("key", "ATL-1")] }, ctx(port()));
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      const para = res.blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
      expect(para.content[0]).toMatchObject({ type: "link" });
      expect(para.content.some((n) => n.type === "status")).toBe(true);
    }
  });

  test("JQL → table with maximumIssues cap", async () => {
    const res = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL"), param("maximumIssues", "1")] },
      ctx(port())
    );
    if (res.kind === "blocks") {
      const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
      expect(table.rows.length).toBe(2); // header + 1 issue
    } else {
      throw new Error("expected blocks");
    }
  });

  test("column selection is respected", async () => {
    const res = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL"), param("columns", "key,summary")] },
      ctx(port())
    );
    if (res.kind === "blocks") {
      const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
      expect(table.rows[0].cells.length).toBe(2);
    }
  });

  test("no jira port → skip", async () => {
    const res = await jiraMacroRenderer().render({ name: "jira", params: [param("key", "ATL-1")] }, ctx());
    expect(res.kind).toBe("skip");
  });

  test("403 permission → skip + degraded note", async () => {
    const failing = port({
      async getIssue() {
        throw portError("permission", "forbidden", { service: "jira" });
      },
    });
    const res = await jiraMacroRenderer().render({ name: "jira", params: [param("key", "ATL-1")] }, ctx(failing));
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") {
      expect(res.notes?.[0].code).toBe("macro-degraded");
      expect(res.notes?.[0].message).toMatch(/permission/);
    }
  });
});

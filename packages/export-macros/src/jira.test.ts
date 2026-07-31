import { describe, expect, test } from "bun:test";
import type { ExportBlock, MacroParameter } from "@atlcli/confluence";
import { datasourceSiteVerdict, jiraMacroRenderer, jiraStatusColor, issueTable } from "./jira.js";
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

// ---------------------------------------------------------------------------
// Datasource smart links (SUPPORT-DATASOURCE-JIRA)
// ---------------------------------------------------------------------------

const SITE = "https://example.atlassian.net";
const DATASOURCE_HREF = `${SITE}/issues/?jql=project%20in%20(DEMO)`;
const JIRA_DATASOURCE_ID = "d8b75300-dfda-4519-b6cd-e49abbd50401";

function siteCtx(jira: JiraIssuePort | undefined, siteId: string | undefined): MacroExportContext {
  return {
    page: { id: "1" },
    depth: 0,
    visited: new Set(),
    ...(jira ? { jira } : {}),
    ...(siteId !== undefined ? { siteId } : {}),
  };
}

/** The instance the storage walk produces for the real DOCSY 7.7 artifact. */
function datasourceInstance(overrides: Partial<{ href: string }> = {}) {
  return {
    name: "jira",
    params: [
      param("jqlquery", "project in (DEMO) and status in (Review) ORDER BY created DESC"),
      param("columns", "issuetype,key,summary,assignee,priority,status,updated"),
      param("maximumissues", "100"),
      param("datasourceid", JIRA_DATASOURCE_ID),
      param("datasourcecloudid", "11111111-2222-4333-8444-555555555555"),
      param("datasourceurl", overrides.href ?? DATASOURCE_HREF),
    ],
    body: [
      {
        type: "paragraph" as const,
        content: [
          {
            type: "link" as const,
            target: { kind: "external" as const, href: overrides.href ?? DATASOURCE_HREF },
            content: [{ type: "text" as const, text: "the original link" }],
          },
        ],
      },
    ],
  };
}

describe("datasourceSiteVerdict", () => {
  test("same origin proves the table targets our site", () => {
    expect(
      datasourceSiteVerdict({ datasourceUrl: DATASOURCE_HREF, siteBaseUrl: SITE })
    ).toBe("same-site");
    // Trailing slash / case differences are not a different site.
    expect(
      datasourceSiteVerdict({ datasourceUrl: DATASOURCE_HREF, siteBaseUrl: `${SITE}/wiki` })
    ).toBe("same-site");
  });

  test("a different site is cross-site", () => {
    expect(
      datasourceSiteVerdict({
        datasourceUrl: "https://other.atlassian.net/issues/?jql=x",
        siteBaseUrl: SITE,
      })
    ).toBe("cross-site");
  });

  test("anything we cannot compare is unprovable, never a guess", () => {
    expect(datasourceSiteVerdict({ siteBaseUrl: SITE })).toBe("unprovable");
    expect(datasourceSiteVerdict({ datasourceUrl: DATASOURCE_HREF })).toBe("unprovable");
    expect(datasourceSiteVerdict({ datasourceUrl: "not a url", siteBaseUrl: SITE })).toBe(
      "unprovable"
    );
  });
});

describe("jiraMacroRenderer — datasource-sourced instances", () => {
  test("renders through the SAME path as a legacy macro and honours column order", async () => {
    const res = await jiraMacroRenderer().render(datasourceInstance(), siteCtx(port(), SITE));
    expect(res.kind).toBe("blocks");
    if (res.kind !== "blocks") return;
    const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.type).toBe("table");
    expect(table.rows.length).toBe(3); // header + 2 fixture issues
    expect(
      table.rows[0].cells.map((c) => {
        const p = c.content[0] as Extract<ExportBlock, { type: "paragraph" }>;
        const first = p.content[0];
        return first.type === "text" ? first.text : "";
      })
    ).toEqual(["Type", "Key", "Summary", "Assignee", "Priority", "Status", "Updated"]);
    expect(res.notes?.[0].code).toBe("macro-rendered-via");
  });

  test("a legacy instance and a datasource instance with the same JQL produce the same table", async () => {
    const legacy = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL"), param("columns", "key,summary")] },
      siteCtx(port(), SITE)
    );
    const modern = await jiraMacroRenderer().render(
      {
        name: "jira",
        params: [
          param("jqlquery", "project = ATL"),
          param("columns", "key,summary"),
          param("datasourceid", JIRA_DATASOURCE_ID),
          param("datasourceurl", DATASOURCE_HREF),
        ],
      },
      siteCtx(port(), SITE)
    );
    if (legacy.kind !== "blocks" || modern.kind !== "blocks") throw new Error("expected blocks");
    expect(modern.blocks).toEqual(legacy.blocks);
  });

  test("a cross-site datasource degrades to its link rather than rows from the wrong site", async () => {
    let searched = false;
    const spy = port({
      async searchJql() {
        searched = true;
        return fixtureIssues;
      },
    });
    const res = await jiraMacroRenderer().render(
      datasourceInstance({ href: "https://someoneelse.atlassian.net/issues/?jql=x" }),
      siteCtx(spy, SITE)
    );
    // The whole point: we never query our own site with a foreign JQL.
    expect(searched).toBe(false);
    expect(res.kind).toBe("blocks");
    if (res.kind !== "blocks") return;
    expect(res.blocks[0].type).toBe("paragraph");
    expect(res.notes?.[0].code).toBe("datasource-cross-site");
    expect(res.notes?.[0].level).toBe("warning");
    expect(res.notes?.[0].message).toContain("someoneelse.atlassian.net");
  });

  test("an unprovable site degrades too (never a guess)", async () => {
    const res = await jiraMacroRenderer().render(
      datasourceInstance(),
      siteCtx(port(), undefined)
    );
    expect(res.kind).toBe("blocks");
    if (res.kind !== "blocks") return;
    expect(res.notes?.[0].code).toBe("datasource-cross-site");
    expect(res.blocks[0].type).toBe("paragraph");
  });

  test("the legacy macro path is NOT subjected to the cross-site guard", async () => {
    // A legacy `jira` macro carries no datasource id; it must still render even
    // when the context has no siteId at all (Data Center customers).
    const res = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL")] },
      siteCtx(port(), undefined)
    );
    expect(res.kind).toBe("blocks");
    if (res.kind !== "blocks") return;
    expect(res.blocks[0].type).toBe("table");
  });
});

describe("jiraMacroRenderer — truncation", () => {
  /** A port with `total` issues, honouring the requested cap like the real ones. */
  function bigPort(total: number): JiraIssuePort {
    const all: JiraIssueRef[] = Array.from({ length: total }, (_, i) => ({
      key: `ATL-${i + 1}`,
      summary: `Issue ${i + 1}`,
      status: "To Do",
      statusColor: "blue",
      url: `/browse/ATL-${i + 1}`,
    }));
    return port({
      async searchJql(_jql, opts) {
        return all.slice(0, opts.maximumIssues);
      },
    });
  }

  test("a table cut at the cap says so", async () => {
    const res = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL"), param("maximumIssues", "5")] },
      siteCtx(bigPort(50), SITE)
    );
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.rows.length).toBe(6); // header + exactly the cap
    const note = res.notes?.find((n) => n.message.includes("truncated"));
    expect(note).toBeDefined();
    expect(note!.level).toBe("warning");
    expect(note!.message).toContain("5 of 5+");
  });

  test("a table that fits carries NO truncation note", async () => {
    const res = await jiraMacroRenderer().render(
      { name: "jira", params: [param("jqlQuery", "project = ATL"), param("maximumIssues", "5")] },
      siteCtx(bigPort(3), SITE)
    );
    if (res.kind !== "blocks") throw new Error("expected blocks");
    expect((res.blocks[0] as Extract<ExportBlock, { type: "table" }>).rows.length).toBe(4);
    expect(res.notes?.some((n) => n.message.includes("truncated"))).toBe(false);
  });

  test("a datasource table is capped at 100 and reports the cut", async () => {
    const res = await jiraMacroRenderer().render(datasourceInstance(), siteCtx(bigPort(500), SITE));
    if (res.kind !== "blocks") throw new Error("expected blocks");
    const table = res.blocks[0] as Extract<ExportBlock, { type: "table" }>;
    expect(table.rows.length).toBe(101); // header + 100
    expect(res.notes?.some((n) => n.message.includes("100 of 100+"))).toBe(true);
  });
});

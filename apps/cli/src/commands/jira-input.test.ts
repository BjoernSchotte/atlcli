import { describe, expect, test } from "bun:test";
import type { JiraIssue, JiraUser } from "@atlcli/jira";
import {
  buildSearchJql,
  cellValue,
  issueCell,
  jqlBefore,
  jqlIn,
  jqlSince,
  jqlStatusNames,
  needsFieldList,
  parseReplacements,
  pickUser,
  renderTable,
  replaceInBody,
  resolveColumns,
} from "./jira-input.js";

describe("pickUser", () => {
  const ann = { accountId: "a1", displayName: "Ann Lee", emailAddress: "ann@example.com", active: true };
  const anna = { accountId: "a2", displayName: "Anna Lee", emailAddress: "anna@example.com", active: true };
  const gone = { accountId: "a3", displayName: "Ann Old", active: false };

  test("an exact email or name wins over other hits", () => {
    expect(pickUser([ann, anna], "ANN@example.com").accountId).toBe("a1");
    expect(pickUser([ann, anna], "anna lee").accountId).toBe("a2");
  });
  test("a single active hit is taken; inactive users never are", () => {
    expect(pickUser([anna, gone], "ann").accountId).toBe("a2");
  });
  test("ambiguous and unknown users throw with the candidates", () => {
    expect(() => pickUser([ann, anna], "lee")).toThrow(/several users: Ann Lee <ann@example.com>, Anna Lee/);
    expect(() => pickUser([gone] as JiraUser[], "ann")).toThrow('No user matches "ann".');
  });
});

describe("JQL", () => {
  test("jqlIn: one value or an in-list (regression: --type Bug,Task was one literal type)", () => {
    expect(jqlIn("issuetype", "Bug")).toBe('issuetype = "Bug"');
    expect(jqlIn("issuetype", "Bug, Task")).toBe('issuetype in ("Bug", "Task")');
    expect(jqlIn("status", 'Say "hi"')).toBe('status = "Say \\"hi\\""');
  });

  test("negation with ~: != / not in; labels and assignee keep empty issues", () => {
    expect(jqlIn("status", "~Done")).toBe('status != "Done"');
    expect(jqlIn("status", "~Done, Closed")).toBe('status not in ("Done", "Closed")');
    // JQL drops issues without labels from `labels != x`; the negation must keep them.
    expect(jqlIn("labels", "~ui", true)).toBe('(labels IS EMPTY OR labels != "ui")');
    expect(buildSearchJql({ assignee: "currentUser()", notAssignee: true })).toBe("(assignee IS EMPTY OR assignee != currentUser())");
    expect(buildSearchJql({ assignee: "EMPTY", notAssignee: true })).toBe("assignee IS NOT EMPTY");
  });

  test("jqlStatusNames: localized names become the names JQL matches (live: Fertig matched 0 issues)", () => {
    const statuses = [
      { name: "Fertig", untranslatedName: "Done" },
      { name: "Fertig", untranslatedName: "Done" },
      { name: "In Arbeit", untranslatedName: "In Progress" },
      { name: "Backlog" },
    ];
    expect(jqlStatusNames("Fertig", statuses)).toBe("Done");
    expect(jqlStatusNames("~fertig, in arbeit", statuses)).toBe("~Done,In Progress");
    expect(jqlStatusNames("Done,Backlog,Unknown", statuses)).toBe("Done,Backlog,Unknown");
  });

  test("jqlBefore", () => {
    expect(jqlBefore("created", "2026-01-01")).toBe('created < "2026-01-01"');
    expect(jqlBefore("updated", "-30d")).toBe("updated < -30d");
    expect(jqlBefore("updated", "month")).toBe("updated < startOfMonth()");
    expect(jqlBefore("updated", "soon")).toBeUndefined();
  });

  test("jqlSince", () => {
    expect(jqlSince("created", "-7d")).toBe("created >= -7d");
    expect(jqlSince("updated", "week")).toBe("updated >= startOfWeek()");
    expect(jqlSince("created", "2026-10-01")).toBe('created >= "2026-10-01"');
    expect(jqlSince("created", "yesterday")).toBeUndefined();
  });

  test("buildSearchJql: flags only, nothing, history", () => {
    expect(buildSearchJql({ project: "AB", status: "To Do,Doing", watching: true })).toBe(
      'project = AB AND status in ("To Do", "Doing") AND watcher = currentUser()'
    );
    expect(buildSearchJql({})).toBe("ORDER BY created DESC");
    expect(buildSearchJql({ history: true })).toBe("issuekey IN issueHistory() ORDER BY lastViewed DESC");
    expect(buildSearchJql({ assignee: "EMPTY" })).toBe("assignee IS EMPTY");
  });

  test("buildSearchJql: raw JQL keeps its ORDER BY and gets the flags ANDed", () => {
    expect(buildSearchJql({ jql: "project = AB ORDER BY rank", dates: ["created >= -7d"] })).toBe(
      "(project = AB) AND created >= -7d ORDER BY rank"
    );
    expect(buildSearchJql({ jql: "project = AB" })).toBe("project = AB");
  });
});

describe("clone replacements", () => {
  test("split at the first colon; reject a missing find", () => {
    expect(parseReplacements(["a:b:c"])).toEqual([["a", "b:c"]]);
    expect(() => parseReplacements([":x"])).toThrow("find:replace");
  });
  test("replace in ADF text nodes, not in attributes", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v1 and v1" }], attrs: { text: "v1" } }] };
    const out = replaceInBody(doc, [["v1", "v2"]]);
    expect(out.content[0]!.content[0]!.text).toBe("v2 and v2");
    expect(doc.content[0]!.content[0]!.text).toBe("v1 and v1");
  });
});

describe("issue table", () => {
  const issue = {
    id: "1",
    key: "AB-1",
    fields: {
      summary: "Fix, it",
      status: { name: "To Do" },
      issuetype: { name: "Bug" },
      labels: ["a", "b"],
      customfield_10016: 5,
      customfield_10020: [{ name: "Sprint 1" }],
      assignee: null,
    },
  } as unknown as JiraIssue;

  test("columns: known names need no field list; names resolve via fields", () => {
    expect(needsFieldList(["key", "Type", "customfield_1"])).toBe(false);
    expect(needsFieldList(["Story Points"])).toBe(true);
    const fields = [{ id: "customfield_10016", name: "Story Points" }] as never;
    expect(resolveColumns(["key", "type", "Story Points"], fields)).toEqual(["key", "issuetype", "customfield_10016"]);
    expect(() => resolveColumns(["nope"], fields)).toThrow('Unknown column "nope"');
  });

  test("cells: names, joined arrays, numbers, empty", () => {
    expect(issueCell(issue, "issuetype")).toBe("Bug");
    expect(issueCell(issue, "labels")).toBe("a,b");
    expect(issueCell(issue, "customfield_10016")).toBe("5");
    expect(issueCell(issue, "customfield_10020")).toBe("Sprint 1");
    expect(issueCell(issue, "assignee")).toBe("");
    expect(cellValue({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] })).toBe("hi");
  });

  test("table, plain and CSV", () => {
    const rows = [["AB-1", "Fix, it"], ["AB-10", "x\ty"]];
    expect(renderTable(["key", "summary"], rows, { kind: "table" })).toBe("key    summary\nAB-1   Fix, it\nAB-10  x\ty");
    expect(renderTable(["key", "summary"], rows, { kind: "plain", delimiter: "\t" }, false)).toBe("AB-1\tFix, it\nAB-10\tx y");
    expect(renderTable(["key", "summary"], rows, { kind: "csv" })).toBe('key,summary\nAB-1,"Fix, it"\nAB-10,x\ty');
  });
});

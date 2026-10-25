import { describe, expect, test } from "bun:test";
import { expandJqlFunctions, findJqlFunctions, hasJqlFunctions, JqlFunctionError, type JqlSearchPage } from "./jql-functions.js";

type Issue = { key: string; fields: Record<string, any> };

/** Fake search: inner query → issues, paged by 100; records the calls. */
function fakeSearch(results: Record<string, Issue[]>): JqlSearchPage & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (jql, { nextPageToken }) => {
    calls.push(jql);
    const all = results[jql];
    if (!all) throw new Error(`unexpected query: ${jql}`);
    const start = Number(nextPageToken ?? 0);
    const next = start + 100;
    return { issues: all.slice(start, next), ...(next < all.length ? { nextPageToken: String(next) } : {}) };
  }) as JqlSearchPage & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("findJqlFunctions", () => {
  test("finds clauses with in / not in, any case, outside strings", () => {
    const jql = `project = X AND issue in linkedIssuesOf("project = A", "blocks") AND key NOT IN SUBTASKSOF('status = "In Arbeit"')`;
    const calls = findJqlFunctions(jql);
    expect(calls.map((c) => [c.name, c.negated, c.args])).toEqual([
      ["linkedIssuesOf", false, ["project = A", "blocks"]],
      ["subtasksOf", true, ['status = "In Arbeit"']],
    ]);
    expect(jql.slice(calls[0]!.start, calls[0]!.end)).toBe(`issue in linkedIssuesOf("project = A", "blocks")`);
  });

  test("ignores function names inside string literals and unknown functions", () => {
    expect(findJqlFunctions(`summary ~ "issue in hasLinks(\\"x\\")" AND issue in linkedIssues("A-1")`)).toEqual([]);
    expect(hasJqlFunctions(`summary ~ "hasLinks"`)).toBe(false);
  });

  test("unescapes arguments", () => {
    expect(findJqlFunctions(`issue in hasLinks("summary ~ \\"a b\\"")`)[0]!.args).toEqual([`summary ~ "a b"`]);
  });

  test("rejects unquoted arguments", () => {
    expect(() => findJqlFunctions(`issue in hasLinks(project = A)`)).toThrow(JqlFunctionError);
  });
});

describe("expandJqlFunctions", () => {
  test("query without functions is returned unchanged and searches nothing", async () => {
    const search = fakeSearch({});
    expect(await expandJqlFunctions("project = A ORDER BY key", search)).toBe("project = A ORDER BY key");
    expect(search.calls).toEqual([]);
  });

  test("subtasksOf becomes a native parent clause; not in keeps issues without parent", async () => {
    const search = fakeSearch({ "project = A": [{ key: "A-2", fields: {} }, { key: "A-1", fields: {} }] });
    expect(await expandJqlFunctions(`issue in subtasksOf("project = A") AND status = Open`, search)).toBe(
      "parent IN (A-1, A-2) AND status = Open",
    );
    expect(await expandJqlFunctions(`issue not in childrenOf("project = A")`, search)).toBe("(parent NOT IN (A-1, A-2) OR parent IS EMPTY)");
  });

  test("linkedIssuesOf follows both directions, or only the named one", async () => {
    const links = [
      { type: { name: "Blocks", outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "B-1" } },
      { type: { name: "Blocks", outward: "blocks", inward: "is blocked by" }, inwardIssue: { key: "B-2" } },
      { type: { name: "Relates", outward: "relates to", inward: "relates to" }, outwardIssue: { key: "B-3" } },
    ];
    const search = fakeSearch({ "key = A-1": [{ key: "A-1", fields: { issuelinks: links } }] });
    expect(await expandJqlFunctions(`issue in linkedIssuesOf("key = A-1")`, search)).toBe("key IN (B-1, B-2, B-3)");
    expect(await expandJqlFunctions(`issue in linkedIssuesOf("key = A-1", "blocks")`, search)).toBe("key IN (B-1)");
    expect(await expandJqlFunctions(`issue in linkedIssuesOf("key = A-1", "is blocked by")`, search)).toBe("key IN (B-2)");
    expect(await expandJqlFunctions(`issue in linkedIssuesOf("key = A-1", "Relates")`, search)).toBe("key IN (B-3)");
  });

  test("has* filters the inner query by field", async () => {
    const search = fakeSearch({
      "project = A": [
        { key: "A-1", fields: { attachment: [{}], comment: { total: 0 }, subtasks: [], worklog: { total: 2 } } },
        { key: "A-2", fields: { attachment: [], comment: { total: 3 }, subtasks: [{}], worklog: { total: 0 } } },
      ],
    });
    expect(await expandJqlFunctions(`issue in hasAttachments("project = A")`, search)).toBe("key IN (A-1)");
    expect(await expandJqlFunctions(`issue in hasComments("project = A")`, search)).toBe("key IN (A-2)");
    expect(await expandJqlFunctions(`issue in hasSubtasks("project = A")`, search)).toBe("key IN (A-2)");
    expect(await expandJqlFunctions(`issue not in hasWorklogs("project = A")`, search)).toBe("key NOT IN (A-1)");
  });

  test("parentsOf and epicsOf (one hop through a story)", async () => {
    const epic = { hierarchyLevel: 1, name: "Epic" };
    const story = { hierarchyLevel: 0, name: "Story" };
    const search = fakeSearch({
      "project = A": [
        { key: "A-5", fields: { parent: { key: "A-2", fields: { issuetype: story } } } },
        { key: "A-6", fields: { parent: { key: "A-1", fields: { issuetype: epic } } } },
        { key: "A-7", fields: {} },
      ],
      "key IN (A-2)": [{ key: "A-2", fields: { parent: { key: "A-9", fields: { issuetype: epic } } } }],
    });
    expect(await expandJqlFunctions(`issue in parentsOf("project = A")`, search)).toBe("key IN (A-1, A-2)");
    expect(await expandJqlFunctions(`issue in epicsOf("project = A")`, search)).toBe("key IN (A-1, A-9)");
  });

  test("empty results match nothing, or everything when negated", async () => {
    const search = fakeSearch({ "project = A": [] });
    expect(await expandJqlFunctions(`project = B AND issue in hasLinks("project = A")`, search)).toBe("project = B AND (created IS EMPTY)");
    expect(await expandJqlFunctions(`issue not in subtasksOf("project = A")`, search)).toBe("(created IS NOT EMPTY)");
  });

  test("pages through the inner query and fails loudly over the limits", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ key: `A-${i + 1}`, fields: { attachment: [{}] } }));
    const search = fakeSearch({ "project = A": many });
    expect(await expandJqlFunctions(`issue in hasAttachments("project = A")`, search, { maxKeys: 300, maxScan: 300 })).toMatch(/^key IN \(/);
    expect(search.calls.length).toBe(3);
    await expect(expandJqlFunctions(`issue in hasAttachments("project = A")`, search, { maxKeys: 100, maxScan: 300 })).rejects.toThrow(
      /matched 250 issues, more than the limit of 100/,
    );
    await expect(expandJqlFunctions(`issue in hasAttachments("project = A")`, search, { maxKeys: 300, maxScan: 200 })).rejects.toThrow(
      /more than 200 issues/,
    );
  });

  test("nesting and wrong arity are errors", async () => {
    const search = fakeSearch({});
    await expect(expandJqlFunctions(`issue in hasLinks("issue in subtasksOf('project = A')")`, search)).rejects.toThrow(/cannot be nested/);
    await expect(expandJqlFunctions(`issue in hasLinks("a = 1", "b")`, search)).rejects.toThrow(/takes one query/);
    await expect(expandJqlFunctions(`issue in linkedIssuesOf()`, search)).rejects.toThrow(/link type/);
  });
});

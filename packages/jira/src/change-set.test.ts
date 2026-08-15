import { describe, expect, it } from "bun:test";
import { parseChangeSetV1, type ChangeSetV1 } from "@atlcli/change-set";
import {
  planJiraFieldChangesV1,
  planJiraTransitionV1,
} from "./change-set.js";
import type { AdfDocument, JiraIssue, JiraTransition, UpdateIssueInput } from "./types.js";

function adf(text: string): AdfDocument {
  return {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function issue(overrides: Record<string, unknown> = {}): JiraIssue {
  return {
    id: "10001",
    key: "SAFE-7",
    self: "https://jira.invalid/rest/api/3/issue/10001",
    fields: {
      summary: "SafeOps proof",
      description: adf("Before"),
      issuetype: { id: "10000", name: "Task", subtask: false },
      project: { id: "10100", key: "SAFE", name: "Safe Operations" },
      status: { id: "1", name: "To Do" },
      priority: { id: "2", name: "Medium" },
      assignee: { accountId: "account-1", displayName: "Ada" },
      labels: ["alpha", "stable"],
      components: [{ id: "10", name: "API" }],
      fixVersions: [{ id: "20", name: "1.0" }],
      ...overrides,
    },
  };
}

function expectValid(changeSet: ChangeSetV1): void {
  expect(parseChangeSetV1(changeSet)).toBe(changeSet);
  expect(changeSet.schema).toBe("atlcli.change-set/1");
  expect(changeSet.subject).toEqual({
    provider: "jira",
    kind: "issue",
    id: "10001",
    label: "SAFE-7",
  });
  expect(changeSet.baseline.representation).toBe("jira-fields");
  expect(changeSet.target.representation).toBe("jira-fields");
}

describe("Jira ChangeSet adapter", () => {
  it("models scalar and stable-id entity replacements deterministically", async () => {
    const input: UpdateIssueInput = {
      fields: {
        summary: "Reviewed SafeOps proof",
        priority: { id: "3" },
      },
    };
    const first = await planJiraFieldChangesV1(issue(), input);
    const second = await planJiraFieldChangesV1(issue(), input);

    expectValid(first);
    expect(second).toEqual(first);
    expect(first.completeness.status).toBe("complete");
    expect(first.operations).toHaveLength(2);
    expect(first.operations.find((operation) => operation.path[1] === "summary")).toMatchObject({
      kind: "modify",
      path: ["fields", "summary"],
      before: "SafeOps proof",
      after: "Reviewed SafeOps proof",
    });
    expect(first.operations.find((operation) => operation.path[1] === "priority")).toMatchObject({
      kind: "modify",
      path: ["fields", "priority"],
      matchBasis: "stable-id",
      before: { id: "2", label: "Medium" },
      after: { id: "3" },
      riskTags: ["identity-change"],
    });
  });

  it("keeps fields replacement distinct from update.set intent", async () => {
    const changeSet = await planJiraFieldChangesV1(issue(), {
      fields: { labels: ["alpha", "replacement"] },
      update: { priority: [{ set: { id: "4" } }] },
    });

    expectValid(changeSet);
    expect(changeSet.operations.map((operation) => operation.path)).toEqual([
      ["fields", "labels"],
      ["update", "priority", 0, "set"],
    ]);
    expect(changeSet.operations[0]).toMatchObject({
      kind: "modify",
      riskTags: ["collection-change"],
    });
    expect(changeSet.operations[1]).toMatchObject({
      kind: "modify",
      riskTags: ["identity-change"],
    });
  });

  it("models set-like label, component, and version add/remove operations by item identity", async () => {
    const changeSet = await planJiraFieldChangesV1(issue(), {
      update: {
        labels: [{ add: "beta" }, { remove: "absent" }],
        components: [{ remove: { id: "10" } }, { add: { id: "11", name: "UI" } }],
        fixVersions: [{ add: { id: "20" } }],
      },
    });

    expectValid(changeSet);
    expect(changeSet.operations).toHaveLength(3);
    expect(changeSet.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "collection-add",
        path: ["update", "labels", 0, "add"],
        item: "beta",
      }),
      expect.objectContaining({
        kind: "collection-remove",
        path: ["update", "components", 0, "remove"],
        item: { id: "10" },
        matchBasis: "stable-id",
      }),
      expect.objectContaining({
        kind: "collection-add",
        path: ["update", "components", 1, "add"],
        item: { id: "11", label: "UI" },
        matchBasis: "stable-id",
      }),
    ]));
    expect(changeSet.summary).toMatchObject({ inserts: 2, deletes: 1, noOp: false });
  });

  it("emits a complete no-op for redundant set-like operations", async () => {
    const changeSet = await planJiraFieldChangesV1(issue(), {
      fields: {
        priority: { id: "2" },
        components: [{ id: "10" }],
      },
      update: {
        labels: [{ add: "alpha" }, { remove: "absent" }],
        components: [{ add: { id: "10" } }],
      },
    });

    expectValid(changeSet);
    expect(changeSet.operations).toEqual([]);
    expect(changeSet.summary.noOp).toBe(true);
    expect(changeSet.completeness).toEqual({ status: "complete", diagnostics: [] });
  });

  it("uses the shared ADF canonicalizer and matcher for description changes", async () => {
    const changeSet = await planJiraFieldChangesV1(issue(), {
      update: { description: [{ set: adf("After") }] },
    });

    expectValid(changeSet);
    expect(changeSet.completeness.status).toBe("complete");
    expect(changeSet.operations.length).toBeGreaterThan(0);
    expect(changeSet.operations.every((operation) =>
      operation.path.slice(0, 4).join("/") === "update/description/0/set")).toBe(true);
    expect(changeSet.operations.some((operation) =>
      operation.kind === "modify" &&
      JSON.stringify(operation.before).includes("Before") &&
      JSON.stringify(operation.after).includes("After"))).toBe(true);
    expect(changeSet.operations.some((operation) => operation.kind === "opaque-change")).toBe(false);
  });

  it("models a resolved transition as a separate higher-risk operation", async () => {
    const transition: JiraTransition = {
      id: "31",
      name: "Start progress",
      to: { id: "3", name: "In Progress" },
    };
    const changeSet = await planJiraTransitionV1(issue(), transition);

    expectValid(changeSet);
    expect(changeSet.operations).toHaveLength(1);
    expect(changeSet.operations[0]).toMatchObject({
      kind: "transition",
      path: ["transition"],
      matchBasis: "stable-id",
      confidence: "anchored",
      riskTags: ["workflow-transition"],
      before: { id: "1", label: "To Do" },
      after: { id: "3", label: "In Progress" },
    });
  });

  it("reports an unavailable transition without an executable-looking operation", async () => {
    const changeSet = await planJiraTransitionV1(issue(), {
      transition: { id: "missing" },
      availableTransitions: [{
        id: "31",
        name: "Start progress",
        to: { id: "3", name: "In Progress" },
      }],
    });

    expectValid(changeSet);
    expect(changeSet.operations).toEqual([]);
    expect(changeSet.summary.noOp).toBe(true);
    expect(changeSet.completeness.status).toBe("degraded");
    expect(changeSet.completeness.diagnostics).toContainEqual(expect.objectContaining({
      code: "unavailable-transition",
      severity: "error",
      path: ["transition"],
    }));
  });

  it("reports missing observed field data without fabricating a before value", async () => {
    const changeSet = await planJiraFieldChangesV1(issue(), {
      fields: { customfield_12345: "planned" },
    });

    expectValid(changeSet);
    expect(changeSet.operations).toEqual([]);
    expect(changeSet.completeness.status).toBe("degraded");
    expect(changeSet.completeness.diagnostics).toContainEqual(expect.objectContaining({
      code: "missing-observed-value",
      severity: "error",
      path: ["fields", "customfield_12345"],
    }));
  });

  it("keeps an observed unknown custom field bounded, opaque, and degraded", async () => {
    const changeSet = await planJiraFieldChangesV1(
      issue({ customfield_12345: { score: 1, source: "manual" } }),
      { fields: { customfield_12345: { score: 2, source: "manual" } } },
    );

    expectValid(changeSet);
    expect(changeSet.completeness.status).toBe("degraded");
    expect(changeSet.operations).toHaveLength(1);
    expect(changeSet.operations[0]).toMatchObject({
      kind: "opaque-change",
      path: ["fields", "customfield_12345"],
      matchBasis: "opaque",
      riskTags: ["opaque"],
      before: { score: 1, source: "manual" },
      after: { score: 2, source: "manual" },
    });
    expect(changeSet.completeness.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "opaque-source-change",
      "source-incomplete",
    ]);
  });

  it("performs no HTTP request while planning fields or transitions", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("Jira ChangeSet planning must not call fetch");
    }) as unknown as typeof fetch;
    try {
      await planJiraFieldChangesV1(issue(), { fields: { summary: "Planned" } });
      await planJiraTransitionV1(issue(), {
        id: "31",
        name: "Start progress",
        to: { id: "3", name: "In Progress" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toBe(0);
  });
});

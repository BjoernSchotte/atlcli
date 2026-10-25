/** Rule configuration over the built-in Jira rule scripts (ported from packages/jira/src/audit-rules.test.ts). */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type AuditRegistry,
  AuditRulesError,
  applyRulePatch as patchRule,
  defaultAuditRules as defaults,
  digestAuditRules as digest,
  effectiveRule as effective,
  isRuleOff as off,
  maxRuleSeverity as maxSeverity,
  parseAuditRules,
  resolveAuditChecks as checks,
  severityForValue,
} from "@atlcli/audit";
import type { JiraField } from "@atlcli/jira";
import { findFlaggedField } from "../../commands/audit-jira.js";
import { loadBuiltinAuditRules, registryOf } from "../../commands/audit-scripts.js";

let registry: AuditRegistry;
beforeAll(async () => {
  registry = registryOf(await loadBuiltinAuditRules("jira"));
});
const JIRA_AUDIT_RULES = { get defs() { return registry.defs; } };
const defaultAuditRules = (p?: "minimal" | "default" | "strict") => defaults(registry, p);
const applyRulePatch = (c: Parameters<typeof patchRule>[0], p: unknown, id: string, path: string) => patchRule(c, p, id, path, registry);
const isRuleOff = (c: Parameters<typeof off>[0], id: string) => off(c, id, registry);
const effectiveRule = (r: Parameters<typeof effective>[0], id: string, issue: Parameters<typeof effective>[2]) => effective(r, id, issue, registry);
const maxRuleSeverity = (r: Parameters<typeof maxSeverity>[0], id: string) => maxSeverity(r, id, registry);
const digestAuditRules = (r: Parameters<typeof digest>[0]) => digest(r, registry);
const resolveAuditChecks = (v: string, custom?: string[]) => checks(v, registry, custom);
const parse = (raw: unknown) => parseAuditRules(raw, "rules.yaml", registry);
const fails = (raw: unknown) => {
  try {
    parse(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(AuditRulesError);
    return (err as Error).message;
  }
  throw new Error("expected an AuditRulesError");
};

describe("profiles", () => {
  test("default is used without a file; minimal and strict differ as documented", () => {
    const d = parse(undefined);
    expect(d).toMatchObject({ extends: "default", minLevel: "warning", legacyDays: 180, source: "rules.yaml" });
    expect(isRuleOff(d.rules["flow/status-aging"], "flow/status-aging")).toBe(true);
    expect(d.rules["hygiene/stale"].thresholds).toEqual({ info: { days: 30 }, warning: { days: 60 }, error: { days: 90 } });
    const minimal = defaultAuditRules("minimal");
    expect(isRuleOff(minimal.rules["hygiene/no-parent"], "hygiene/no-parent")).toBe(true);
    const strict = defaultAuditRules("strict");
    expect(strict).toMatchObject({ minLevel: "info", legacyDays: null });
    expect(strict.rules["hygiene/stale"]!.options?.include).toEqual(["todo", "wip"]);
    // Every profile mentions only known rules, and every rule has a profile setting.
    for (const def of JIRA_AUDIT_RULES.defs) expect(strict.rules[def.id]).toBeDefined();
  });
});

describe("parseAuditRules", () => {
  test("a full file", () => {
    const rules = parse({
      version: 1,
      extends: "minimal",
      minLevel: "info",
      rules: { "hygiene/stale": { warning: "2w", error: 45 }, "hygiene/no-parent": "warning", "flow/stuck-wip": { warning: "p80" } },
      custom: [{ id: "team/bug-without-component", jql: "issuetype = Bug", message: "Bug without a component." }],
      overrides: [{ match: { project: ["GROW", "VDS"], jql: "priority = Highest" }, rules: { "team/bug-without-component": "error" } }],
      baseline: { olderThan: "off" },
      flagged: { field: "customfield_123" },
    });
    expect(rules.extends).toBe("minimal");
    // minimal's stale is { error: 90d }; the file merges warning and replaces error.
    expect(rules.rules["hygiene/stale"].thresholds).toEqual({ warning: { days: 14 }, error: { days: 45 } });
    expect(rules.rules["flow/stuck-wip"].thresholds).toEqual({ warning: { percentile: 80 } });
    expect(rules.rules["team/bug-without-component"]).toEqual({ level: "warning" });
    expect(rules.overrides[0].match).toEqual({ project: ["GROW", "VDS"], jql: "priority = Highest" });
    expect(rules.legacyDays).toBeNull();
    expect(rules.flaggedField).toBe("customfield_123");
  });

  test("errors name the path", () => {
    expect(fails({ extends: "loud" })).toContain("extends must be one of minimal, default, strict");
    expect(fails({ rulez: {} })).toContain('unknown key "rulez"');
    expect(fails({ rules: { "hygiene/nope": "off" } })).toContain('rules: unknown rule "hygiene/nope"');
    expect(fails({ rules: { "hygiene/stale": { warning: "soon" } } })).toContain("rules.hygiene/stale.warning: expected days");
    expect(fails({ rules: { "hygiene/stale": { warning: "p85" } } })).toContain("percentiles are only allowed for flow/stuck-wip, flow/status-aging");
    expect(fails({ rules: { "flow/unassigned-wip": { warning: "3d" } } })).toContain("has no thresholds; use a level");
    expect(fails({ rules: { "hygiene/stale": { colour: "red" } } })).toContain('rules.hygiene/stale.colour: unknown option "colour"');
    expect(fails({ custom: [{ id: "Bad Id", jql: "x" }] })).toContain("custom[0].id");
    expect(fails({ custom: [{ id: "hygiene/stale", jql: "x" }] })).toContain("is already a rule");
    expect(fails({ custom: [{ id: "team/x", jql: "a = 1 ORDER BY key" }] })).toContain("leave out ORDER BY");
    expect(fails({ overrides: [{ match: {}, rules: {} }] })).toContain("overrides[0].match: give at least one of");
    expect(fails({ overrides: [{ match: { sprint: "1" }, rules: {} }] })).toContain('unknown key "sprint"');
    expect(fails({ overrides: [{ match: { project: "X" }, rules: { "hygiene/stale": "loud" } }] })).toContain("overrides[0].rules.hygiene/stale: expected off, info, warning or error");
    expect(fails({ version: 2 })).toContain("version must be 1");
  });
});

describe("patches and overrides", () => {
  test("a level on a threshold rule keeps the mildest threshold with that severity; off removes one threshold", () => {
    const stale = defaultAuditRules().rules["hygiene/stale"];
    expect(applyRulePatch(stale, "error", "hygiene/stale", "x").thresholds).toEqual({ error: { days: 30 } });
    expect(applyRulePatch(stale, { info: "off" }, "hygiene/stale", "x").thresholds).toEqual({ warning: { days: 60 }, error: { days: 90 } });
    expect(isRuleOff(applyRulePatch(stale, "off", "hygiene/stale", "x"), "hygiene/stale")).toBe(true);
    // Thresholds turn an off rule back on.
    expect(isRuleOff(applyRulePatch({ level: "off" }, { warning: "1d" }, "hygiene/stale", "x"), "hygiene/stale")).toBe(false);
  });

  test("effectiveRule matches project (also from the key), type and status by name or id, case-insensitively", () => {
    const rules = parse({
      overrides: [
        { match: { project: "grow" }, rules: { "flow/unassigned-wip": "error" } },
        { match: { status: "10001" }, rules: { "flow/unassigned-wip": "off" } },
      ],
    });
    expect(effectiveRule(rules, "flow/unassigned-wip", { key: "GROW-1" }).level).toBe("error");
    expect(effectiveRule(rules, "flow/unassigned-wip", { key: "GROW-1", status: { id: "10001", name: "Fertig" } }).level).toBe("off");
    expect(effectiveRule(rules, "flow/unassigned-wip", { key: "ATL-1" }).level).toBe("warning");
    expect(maxRuleSeverity(rules, "flow/unassigned-wip")).toBe("error");
    expect(maxRuleSeverity(rules, "flow/status-aging")).toBeUndefined();
  });

  test("severityForValue: days inclusive, percentiles strict, until counts down", () => {
    const age = { thresholds: { warning: { days: 30 }, error: { percentile: 95 } } };
    expect(severityForValue(age, "age", 30, () => 40)?.severity).toBe("warning");
    expect(severityForValue(age, "age", 40, () => 40)?.severity).toBe("warning");
    expect(severityForValue(age, "age", 40.1, () => 40)?.severity).toBe("error");
    expect(severityForValue(age, "age", 50, () => undefined)?.severity).toBe("warning");
    expect(severityForValue(age, "age", 29, () => 40)).toBeUndefined();
    const until = { thresholds: { info: { days: 3 }, warning: { days: 1 } } };
    expect(severityForValue(until, "until", 0.5, () => undefined)?.severity).toBe("warning");
    expect(severityForValue(until, "until", 3, () => undefined)?.severity).toBe("info");
    expect(severityForValue(until, "until", 3.5, () => undefined)).toBeUndefined();
  });
});

describe("digestAuditRules", () => {
  test("keeps rules that can reach error, drops expensive ones unless digest: true, lists errors only", () => {
    const rules = digestAuditRules(defaultAuditRules());
    const on = Object.keys(rules.rules).filter((id) => !isRuleOff(rules.rules[id], id));
    expect(on).toEqual(["hygiene/overdue", "hygiene/flagged", "hygiene/stale"]);
    expect(rules.minLevel).toBe("error");
    const opted = digestAuditRules(parse({ rules: { "flow/stuck-wip": { digest: true }, "flow/unassigned-wip": "warning" }, overrides: [{ match: { project: "GROW" }, rules: { "flow/unassigned-wip": "error" } }] }));
    expect(isRuleOff(opted.rules["flow/stuck-wip"], "flow/stuck-wip")).toBe(false);
    // Reaches error only through an override: kept, and the override still applies per issue.
    expect(opted.rules["flow/unassigned-wip"].level).toBe("warning");
  });
});

describe("resolveAuditChecks", () => {
  test("rule ids, categories, older names and custom ids", () => {
    expect([...(resolveAuditChecks("stuck-wip, stale") as Set<string>)]).toEqual(["flow/stuck-wip", "hygiene/stale"]);
    expect([...(resolveAuditChecks("workflow") as Set<string>)]).toEqual(["workflow/resolved-not-done"]);
    expect((resolveAuditChecks("flow") as Set<string>).size).toBe(3);
    expect([...(resolveAuditChecks("custom", ["team/a"]) as Set<string>)]).toEqual(["team/a"]);
    expect(resolveAuditChecks("nope")).toContain('Unknown check "nope"');
    expect(resolveAuditChecks(",")).toBe("--checks is empty.");
  });
});

describe("findFlaggedField", () => {
  test("by the JQL clause name, preferring the checkbox field", () => {
    const fields = [
      { id: "customfield_1", name: "Flagged (old)", custom: true, clauseNames: ["cf[1]"] },
      { id: "customfield_2", name: "Markiert", custom: true, clauseNames: ["Flagged"], schema: { type: "string", custom: "x:textfield" } },
      { id: "customfield_10021", name: "Markiert", custom: true, clauseNames: ["Flagged", "Flagged[Checkboxes]", "cf[10021]"], schema: { type: "array", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes" } },
    ] as JiraField[];
    expect(findFlaggedField(fields)).toBe("customfield_10021");
    expect(findFlaggedField(fields.slice(0, 2))).toBe("customfield_2");
    expect(findFlaggedField([])).toBeUndefined();
  });
});

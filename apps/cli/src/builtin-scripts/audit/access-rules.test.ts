/**
 * The built-in access rules through the audit engine, on a model read from a
 * fake source: what the model holds (coverage included), what each rule
 * finds, profiles, the rules file's access: section and the fixes --fix plans.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type AuditRegistry, type AuditRules, type AuditRuleScript, auditAccess, defaultAuditRules, parseSectionAuditRules } from "@atlcli/audit";
import type { ScriptPort } from "@atlcli/script-runtime";
import { type AccessSource, type AccessUserDetails, collectAccessModel } from "../../commands/audit-access.js";
import { loadBuiltinAuditRules, planAuditFixes, registryOf } from "../../commands/audit-scripts.js";

let scripts: AuditRuleScript[];
let registry: AuditRegistry;
beforeAll(async () => {
  scripts = await loadBuiltinAuditRules("access");
  registry = registryOf(scripts);
});

const NOW = new Date("2026-10-27T12:00:00.000Z");
const user = (accountId: string, p: Partial<AccessUserDetails> = {}): AccessUserDetails => ({
  accountId,
  displayName: accountId.toUpperCase(),
  active: true,
  status: "active",
  accountType: "atlassian",
  external: false,
  guest: false,
  ...p,
});
const USERS = [user("ann"), user("bob"), user("gone", { active: false, status: "inactive" }), user("ext", { external: true }), user("bot", { accountType: "app" })];
const perm = (id: string, type: string, pid: string, operation: string, targetType = "space") => ({ id, principal: { type, id: pid }, operation, targetType });
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });

function fakeSource(): AccessSource {
  const members: Record<string, string[]> = { devs: ["ann", "bob"], ghosts: ["gone"] };
  const details = (ids: string[]) => USERS.filter((u) => ids.includes(u.accountId));
  return {
    confluence: {
      spaces: async () => [
        { id: "1", key: "OPEN", name: "Open space" },
        { id: "2", key: "SOLO", name: "Solo space" },
        { id: "3", key: "HIDDEN", name: "Hidden" },
      ],
      roleMode: async () => "ROLES_TRANSITION",
      roles: async () => [{ id: "r-admin", name: "Admin", permissions: ["administer/space"] }],
      permissions: async (spaceId) => {
        if (spaceId === "3") throw forbidden();
        if (spaceId === "1")
          return [
            perm("1", "access-class", "ANONYMOUS", "read"),
            perm("2", "access-class", "ALL_LICENSED_USERS", "administer"),
            perm("3", "user", "gone", "read"),
            perm("4", "group", "ghosts", "read"),
            perm("5", "user", "ext", "administer"),
            perm("6", "access-class", "ALL_PRODUCT_ADMINS", "administer"),
          ];
        return [perm("7", "user", "ann", "administer")];
      },
      roleAssignments: async (spaceId) => (spaceId === "2" ? [{ roleId: "r-admin", principal: { type: "USER", id: "ann" } }] : []),
      groups: async () => [],
      groupMembers: async (id) => details(members[id] ?? []),
      users: async (ids) => details(ids),
      pages: async (spaceId, max) => {
        const pages = spaceId === "1" ? [{ id: "101", title: "Locked", parentId: null }, { id: "102", title: "Child", parentId: "101" }] : [];
        return { pages: pages.slice(0, max), truncated: pages.length > max };
      },
      restrictions: async (pageId) =>
        pageId === "101"
          ? { read: { accountIds: ["ann", "gone"], groupIds: [] }, update: { accountIds: ["gone"], groupIds: ["ghosts"] } }
          : { read: { accountIds: [], groupIds: [] }, update: { accountIds: [], groupIds: [] } },
      url: { space: (k) => `https://x.atlassian.net/wiki/spaces/${k}`, page: (id) => `https://x.atlassian.net/wiki/pages/viewpage.action?pageId=${id}` },
    },
    jira: {
      projects: async () => [
        { id: "10", key: "PUB", name: "Public", style: "classic" },
        { id: "11", key: "LOCK", name: "Locked roles", style: "team" },
      ],
      projectScheme: async (key) => (key === "PUB" ? { id: 100, name: "Open scheme" } : { id: 101, name: "Team scheme" }),
      schemes: async () => [
        {
          id: 100,
          name: "Open scheme",
          grants: [
            { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
            { id: 2, permission: "ADMINISTER_PROJECTS", holder: { type: "projectRole", value: "50" } },
            { id: 3, permission: "BROWSE_PROJECTS", holder: { type: "projectRole", value: "50" } },
            { id: 4, permission: "BROWSE_PROJECTS", holder: { type: "user", value: "gone" } },
            { id: 5, permission: "BROWSE_PROJECTS", holder: { type: "group", value: "devs", parameter: "devs" } },
          ],
        },
        { id: 101, name: "Team scheme", grants: [{ id: 9, permission: "ADMINISTER_PROJECTS", holder: { type: "projectRole", value: "60" } }] },
      ],
      projectRoles: async (key) => {
        if (key === "LOCK") throw forbidden();
        return [{ id: 50, name: "Administrators", actors: [{ type: "user", id: "gone", name: "GONE" }] }];
      },
      groups: async () => [
        { id: "devs", name: "developers" },
        { id: "ghosts", name: "ghost-team" },
      ],
      groupMembers: async (id) => details(members[id] ?? []),
      users: async (ids) => details(ids),
      url: { project: (k) => `https://x.atlassian.net/browse/${k}` },
    },
  };
}

const port = {} as ScriptPort;
const strict = () => defaultAuditRules(registry, "strict");
async function run(rules: AuditRules, pages = true) {
  const { model, partial } = await collectAccessModel(fakeSource(), { spaces: "*", projects: "*", personal: false, pages, maxPages: 100 });
  return auditAccess({ rules, registry, scripts, model, now: NOW, useBaseline: false, partial, query: "all", pagesRead: pages }, { port, now: NOW });
}

describe("access model", () => {
  test("grants, resolved principals and coverage", async () => {
    const { model } = await collectAccessModel(fakeSource(), { spaces: "*", projects: "*", personal: false, pages: true, maxPages: 100 });
    expect(model.resources.map((r) => [r.kind, r.key, r.complete])).toEqual([
      ["project", "LOCK", false],
      ["project", "PUB", true],
      ["space", "HIDDEN", false],
      ["space", "OPEN", true],
      ["space", "SOLO", true],
    ]);
    expect(model.coverage.incomplete.map((i) => `${i.kind} ${i.key}: ${i.note}`)).toEqual([
      "space HIDDEN: permissions not readable (not permitted)",
      "project LOCK: role members not readable (not permitted; needs Administer Projects)",
    ]);
    const open = model.resources.find((r) => r.key === "OPEN")!;
    expect(open.grants.find((g) => g.principal.type === "group")!.principal).toEqual({ type: "group", id: "ghosts", name: "ghost-team", activeMembers: 0 });
    expect(open.grants.find((g) => g.principal.id === "gone")!.principal).toMatchObject({ name: "GONE", active: false });
    expect(model.resources.find((r) => r.key === "SOLO")!.grants[0]!.role).toEqual({ id: "r-admin", name: "Admin" });
    const child = model.pages.find((p) => p.id === "102")!;
    expect(child.inheritedRead.map((i) => [i.pageId, i.principals.map((p) => p.id)])).toEqual([["101", ["ann", "gone"]]]);
  });

  test("--max-pages stops reading pages and marks the run partial", async () => {
    const { model, partial } = await collectAccessModel(fakeSource(), { spaces: "*", personal: false, pages: true, maxPages: 1 });
    expect(model.pages.length).toBe(1);
    expect(partial[0]).toContain("--max-pages 1");
  });
});

describe("access rules", () => {
  test("each built-in rule finds its case (strict profile)", async () => {
    const { report } = await run(strict());
    const got = report.findings.map((f) => `${f.rule} ${f.target.kind}:${f.key}${f.principal ? ` ${f.principal.type}:${f.principal.id}` : ""} [${f.severity}]`);
    expect(got).toEqual([
      "exposure/anonymous-space space:OPEN anonymous:ANONYMOUS [error]",
      "exposure/anonymous-project project:PUB anonymous:anyone [error]",
      "exposure/all-users space:OPEN all-users:ALL_LICENSED_USERS [warning]",
      "stale/inactive-user-grant space:OPEN user:gone [warning]",
      "stale/inactive-user-grant project:PUB user:gone [warning]",
      "stale/empty-group-grant space:OPEN group:ghosts [info]",
      "stale/inactive-in-restriction page:101 user:gone [info]",
      "stale/inactive-in-restriction page:101 user:gone [info]",
      "admin/no-active-admin project:PUB [error]",
      "admin/single-admin space:SOLO user:ann [info]",
      "admin/external-admin space:OPEN user:ext [warning]",
      "hygiene/unmigrated-access space:OPEN [info]",
      "pages/locked-out page:101 [warning]",
    ]);
    const anon = report.findings[0]!;
    expect(anon).toMatchObject({ summary: "Open space", status: "ROLES_TRANSITION", assignee: "Anyone (anonymous)", subject: "space:OPEN|anonymous:ANONYMOUS", fixable: true });
    expect(anon.target.url).toBe("https://x.atlassian.net/wiki/spaces/OPEN");
  });

  test("the default profile lists errors and warnings; page rules wait for --pages", async () => {
    const { report } = await run(defaultAuditRules(registry, "default"), false);
    expect(new Set(report.findings.map((f) => f.rule))).toEqual(
      new Set(["exposure/anonymous-space", "exposure/anonymous-project", "exposure/all-users", "stale/inactive-user-grant", "admin/no-active-admin", "admin/external-admin"]),
    );
    expect(report.product).toBe("access");
    expect(report.legacyDays).toBeNull();
  });

  test("minimal: exposure and missing admins only", async () => {
    const { report } = await run(defaultAuditRules(registry, "minimal"));
    expect(new Set(report.findings.map((f) => f.rule))).toEqual(new Set(["exposure/anonymous-space", "exposure/anonymous-project", "admin/no-active-admin"]));
  });

  test("options and the rules file's access: section", async () => {
    const rules = parseSectionAuditRules(
      { access: { extends: "strict", rules: { "hygiene/direct-user-grants": { max: ["0"] }, "reach/broad-admin": { max: ["0"] } } } },
      "access",
      "rules.yaml",
      registry,
    );
    const { report } = await run(rules);
    expect(report.findings.filter((f) => f.rule === "hygiene/direct-user-grants").map((f) => f.key)).toEqual(["OPEN", "PUB", "SOLO"]);
    expect(report.findings.filter((f) => f.rule === "reach/broad-admin").map((f) => f.key)).toEqual(["ann", "ext"]);
    expect(() => parseSectionAuditRules({ access: { custom: [] } }, "access", "r.yaml", registry)).toThrow('access: unknown key "custom"');
  });
});

describe("access fixes", () => {
  test("--fix plans the removal of anonymous and inactive access and cleans restrictions", async () => {
    const rules = defaultAuditRules(registry, "strict");
    const { report, items } = await run(rules);
    const live = {
      confluenceSpaceRoles: async () => ({ mode: "ROLES_TRANSITION", roles: [] }),
      confluenceRoleAssignments: async () => [],
      confluenceSpacePermissions: async (key: string) =>
        key === "OPEN"
          ? [
              { id: "1", principal: { type: "access-class", id: "ANONYMOUS" }, operation: "read", targetType: "space" },
              { id: "3", principal: { type: "user", id: "gone" }, operation: "read", targetType: "space" },
            ]
          : [],
      jiraProjectRoles: async () => [{ id: 50, name: "Administrators", admin: true, actors: [{ type: "user", id: "gone", name: "GONE" }] }],
      jiraPermissionSchemes: async () => [
        {
          id: 100,
          name: "Open scheme",
          grants: [
            { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
            { id: 4, permission: "BROWSE_PROJECTS", holder: { type: "user", value: "gone" } },
          ],
        },
      ],
      confluenceGetPage: async (id: string) => ({ id, title: "Locked", spaceKey: "OPEN", version: 1, markdown: "" }),
      confluenceRestrictions: async () => ({ read: { accountIds: ["ann", "gone"], groupIds: [] }, update: { accountIds: ["gone"], groupIds: ["ghosts"] } }),
    } as unknown as ScriptPort;
    const plan = await planAuditFixes(
      report.findings.filter((f) => f.fixable),
      scripts,
      (f) => items.get(`${f.target.kind}:${f.target.key}`),
      live,
      undefined,
      (f) => rules.rules[f.rule],
    );
    expect(plan.operations.map((o) => `${o.verb} ${JSON.stringify(o.args)}`)).toEqual([
      `confluence.removeSpaceAccess {"spaceKey":"OPEN","principal":{"type":"access-class","id":"ANONYMOUS"},"permissionIds":["1"]}`,
      expect.stringMatching(/^jira\.deletePermissionGrant \{"schemeId":100,"grantId":1,/),
      `confluence.removeSpaceAccess {"spaceKey":"OPEN","principal":{"type":"user","id":"gone"},"permissionIds":["3"]}`,
      expect.stringMatching(/^jira\.removeRoleActor \{"projectKey":"PUB","roleId":50,/),
      expect.stringMatching(/^jira\.deletePermissionGrant \{"schemeId":100,"grantId":4,/),
      `confluence.setRestrictions {"pageId":"101","read":{"accountIds":["ann"],"groupIds":[]}}`,
      `confluence.setRestrictions {"pageId":"101","update":{"accountIds":[],"groupIds":["ghosts"]}}`,
    ]);
  });
});

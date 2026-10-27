import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import type { ConfluenceSpaceRolesView, ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { planScript } from "./verbs.js";

const BASE = "https://example.atlassian.net";
const plan = (js: string, port: ScriptPort) => planScript(js, { port, variant: DEBUG_VARIANT });
const apply = (operations: Awaited<ReturnType<typeof plan>>["operations"], port: ScriptPort) =>
  applyScriptPlan({ target: { baseUrl: BASE }, operations }, { port, baseUrl: BASE });

async function scriptError(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

/** A site with access data; writes are logged. */
function site(mode: ConfluenceSpaceRolesView["mode"] = "ROLES_TRANSITION") {
  const calls: unknown[][] = [];
  const log = (...args: unknown[]) => calls.push(args);
  const user = { accountId: "u1", displayName: "Ann", active: true, status: "active", accountType: "atlassian", external: false, guest: false };
  const port = {
    confluenceSpaceId: async () => "7",
    confluenceSpaceRoles: async () => ({ mode, roles: [{ id: "r1", name: "Viewer", type: "SYSTEM", permissions: ["read/space"] }] }),
    confluenceRoleAssignments: async () => [
      { roleId: "r1", principal: { type: "user", id: "u1" } },
      { roleId: "r1", principal: { type: "access-class", id: "all-licensed-users" } },
    ],
    confluenceSpacePermissions: async () => [
      { id: "11", principal: { type: "user", id: "u1" }, operation: "read", targetType: "space" },
      { id: "12", principal: { type: "group", id: "g1" }, operation: "read", targetType: "space" },
      { id: "13", principal: { type: "group", id: "g1" }, operation: "create", targetType: "page" },
    ],
    confluenceGroupMembers: async (g: string) => (log("groupMembers", g), [user]),
    confluenceUsers: async (ids: string[]) => (log("users", ids), [user]),
    confluenceRemoveRoleAssignment: async (...a: unknown[]) => void log("removeRoleAssignment", ...a),
    confluenceRemoveSpacePermission: async (...a: unknown[]) => void log("removeSpacePermission", ...a),
    jiraPermissionSchemes: async () => [{ id: 10000, name: "Default", grants: [{ id: 3, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } }] }],
    jiraProjectPermissionScheme: async () => ({ id: 10000, name: "Default" }),
    jiraProjectRoles: async () => [{ id: 10002, name: "Administrators", admin: true, actors: [{ type: "user", id: "a1", name: "Ann" }] }],
    jiraGroupMembers: async () => [{ accountId: "a1", displayName: "Ann", active: false, accountType: "atlassian" }],
    jiraRemoveRoleActor: async (...a: unknown[]) => void log("removeRoleActor", ...a),
    jiraDeletePermissionGrant: async (...a: unknown[]) => void log("deletePermissionGrant", ...a),
  } as unknown as ScriptPort;
  return { port, calls, writes: () => calls.filter((c) => String(c[0]).startsWith("remove") || c[0] === "deletePermissionGrant") };
}

describe("access reads", () => {
  it("return the port's views and need the product's read grant", async () => {
    const { port, calls } = site();
    const run = await plan(
      `export const meta = { permissions: ["confluence:read", "jira:read"] };
       export default {
         perms: (await atlcli.confluence.spacePermissions("DOCSY")).length,
         roles: await atlcli.confluence.spaceRoles(),
         assigned: (await atlcli.confluence.roleAssignments("DOCSY")).map((a) => a.principal.type),
         members: (await atlcli.confluence.groupMembers("g1")).map((u) => u.accountId),
         users: (await atlcli.confluence.users(["u1", "u1", "u2"])).map((u) => u.status),
         none: await atlcli.confluence.users([]),
         schemes: (await atlcli.jira.permissionSchemes())[0].grants[0].holder.type,
         scheme: await atlcli.jira.projectPermissionScheme("ATL"),
         roles2: (await atlcli.jira.projectRoles("ATL"))[0].actors,
         jmembers: (await atlcli.jira.groupMembers("g1"))[0].active,
       };`,
      port,
    );
    expect(run.value).toEqual({
      perms: 3,
      roles: { mode: "ROLES_TRANSITION", roles: [{ id: "r1", name: "Viewer", type: "SYSTEM", permissions: ["read/space"] }] },
      assigned: ["user", "access-class"],
      members: ["u1"],
      users: ["active"],
      none: [],
      schemes: "anyone",
      scheme: { id: 10000, name: "Default" },
      roles2: [{ type: "user", id: "a1", name: "Ann" }],
      jmembers: false,
    });
    expect(calls).toContainEqual(["users", ["u1", "u2"]]);
    const denied = await scriptError(plan(`export const meta = { permissions: ["jira:read"] }; await atlcli.confluence.spacePermissions("DOCSY");`, port));
    expect(denied.message).toContain('"confluence:read"');
    const jira = await scriptError(plan(`export const meta = { permissions: ["confluence:read"] }; await atlcli.jira.projectRoles("ATL");`, port));
    expect(jira.message).toContain('"jira:read"');
  });

  it("confluence.users takes at most 500 ids", async () => {
    const { port } = site();
    await expect(plan(`await atlcli.confluence.users(Array.from({ length: 501 }, (_, i) => "u" + i))`, port)).rejects.toThrow(/at most 500/);
  });
});

describe("confluence.removeSpaceAccess", () => {
  it("removes the role assignment and, during the transition, the principal's permission records", async () => {
    const { port, writes } = site();
    const run = await plan(
      `await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "user", id: "u1" });
       await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "user", id: "u1" });
       await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "access-class", id: "ALL_LICENSED_USERS" });
       await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "group", id: "g1" });
       await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "group", id: "nobody" });`,
      port,
    );
    expect(run.operations.map((o) => o.args)).toEqual([
      { spaceKey: "DOCSY", spaceId: "7", roleId: "r1", principal: { type: "user", id: "u1" }, permissionIds: ["11"] },
      { spaceKey: "DOCSY", spaceId: "7", roleId: "r1", principal: { type: "access-class", id: "all-licensed-users" } },
      { spaceKey: "DOCSY", principal: { type: "group", id: "g1" }, permissionIds: ["12", "13"] },
    ]);
    expect(run.skipped.map((s) => s.title)).toEqual(["user:u1", "group:nobody"]);
    expect(writes()).toEqual([]);
    expect((await apply(run.operations, port)).status).toBe("applied");
    expect(writes()).toEqual([
      ["removeRoleAssignment", "7", { type: "user", id: "u1" }],
      ["removeSpacePermission", "DOCSY", "11"],
      ["removeRoleAssignment", "7", { type: "access-class", id: "all-licensed-users" }],
      ["removeSpacePermission", "DOCSY", "12"],
      ["removeSpacePermission", "DOCSY", "13"],
    ]);
  });

  it("leaves permission records alone in the role model and skips role reads before it", async () => {
    const roles = await plan(`await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "user", id: "u1" });`, site("ROLES").port);
    expect(roles.operations[0]!.args).toEqual({ spaceKey: "DOCSY", spaceId: "7", roleId: "r1", principal: { type: "user", id: "u1" } });
    const { port, calls } = site("PRE_ROLES");
    (port as { confluenceRoleAssignments: unknown }).confluenceRoleAssignments = async () => (calls.push(["assignments"]), []);
    // A principal read elsewhere may carry its name; the plan leaves it out.
    const pre = await plan(`await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "user", id: "u1", name: "U One" });`, port);
    expect(pre.operations[0]!.args).toEqual({ spaceKey: "DOCSY", principal: { type: "user", id: "u1" }, permissionIds: ["11"] });
    expect(calls).not.toContainEqual(["assignments"]);
  });

  it("needs confluence:write:<space>", async () => {
    const { port } = site();
    const error = await scriptError(
      plan(`export const meta = { permissions: ["confluence:write:OTHER"] }; await atlcli.confluence.removeSpaceAccess("DOCSY", { type: "user", id: "u1" });`, port),
    );
    expect(error.message).toContain('"confluence:write:DOCSY"');
  });
});

describe("jira access writes", () => {
  it("removeRoleActor finds the role by id or name and skips an absent actor", async () => {
    const { port, writes } = site();
    const run = await plan(
      `await atlcli.jira.removeRoleActor("ATL", "administrators", { type: "user", id: "a1", name: "Ann" });
       await atlcli.jira.removeRoleActor("ATL", 10002, { type: "user", id: "a1" });
       await atlcli.jira.removeRoleActor("ATL", 10002, { type: "group", id: "g1" });`,
      port,
    );
    expect(run.operations.map((o) => o.args)).toEqual([{ projectKey: "ATL", roleId: 10002, role: "Administrators", principal: { type: "user", id: "a1" } }]);
    expect(run.skipped.map((s) => s.title)).toEqual(["Administrators user:a1", "Administrators group:g1"]);
    await apply(run.operations, port);
    expect(writes()).toEqual([["removeRoleActor", "ATL", 10002, { type: "user", id: "a1" }]]);
    await expect(plan(`await atlcli.jira.removeRoleActor("ATL", "Nope", { type: "user", id: "a1" })`, port)).rejects.toThrow(/has no role "Nope"/);
    const denied = await scriptError(
      plan(`export const meta = { permissions: ["jira:write:OTHER"] }; await atlcli.jira.removeRoleActor("ATL", 10002, { type: "user", id: "a1" });`, port),
    );
    expect(denied.message).toContain('"jira:write:ATL"');
  });

  it("deletePermissionGrant needs jira:write:* and skips a missing grant", async () => {
    const { port, writes } = site();
    const denied = await scriptError(plan(`export const meta = { permissions: ["jira:write:ATL"] }; await atlcli.jira.deletePermissionGrant(10000, 3);`, port));
    expect(denied.message).toContain('"jira:write:*"');
    const run = await plan(
      `export const meta = { permissions: ["jira:write:*"] };
       await atlcli.jira.deletePermissionGrant(10000, 3);
       await atlcli.jira.deletePermissionGrant(10000, 4);
       await atlcli.jira.deletePermissionGrant(1, 3);`,
      port,
    );
    expect(run.operations.map((o) => o.args)).toEqual([
      { schemeId: 10000, grantId: 3, scheme: "Default", permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
    ]);
    expect(run.skipped).toHaveLength(2);
    await apply(run.operations, port);
    expect(writes()).toEqual([["deletePermissionGrant", 10000, 3]]);
  });
});

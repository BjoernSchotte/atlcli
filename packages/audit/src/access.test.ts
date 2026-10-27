import { expect, test } from "bun:test";
import {
  type AccessPrincipal,
  type AccessPrincipalType,
  accessUserItems,
  confluenceOperationLevel,
  confluencePrincipalType,
  confluenceRoleLevel,
  confluenceSpaceGrants,
  inheritedReadRestrictions,
  jiraPermissionLevel,
  jiraProjectGrants,
} from "./access.js";

const principal = (type: AccessPrincipalType, id: string, name?: string): AccessPrincipal => ({ type, id, name: name ?? id });

test("Confluence principals: users, groups and access classes in both spellings", () => {
  expect(confluencePrincipalType("user", "a1")).toBe("user");
  expect(confluencePrincipalType("GROUP", "g1")).toBe("group");
  expect(confluencePrincipalType("access-class", "ALL_LICENSED_USERS")).toBe("all-users");
  expect(confluencePrincipalType("ACCESS_CLASS", "all-licensed-users")).toBe("all-users");
  expect(confluencePrincipalType("access-class", "ALL_PRODUCT_ADMINS")).toBe("product-admins");
  expect(confluencePrincipalType("role", "ANONYMOUS")).toBe("anonymous");
  expect(confluencePrincipalType("ACCESS_CLASS", "anonymous")).toBe("anonymous");
});

test("Confluence levels from permission records and role permissions", () => {
  expect(confluenceOperationLevel("read", "space")).toBe("read");
  expect(confluenceOperationLevel("create", "comment")).toBe("read");
  expect(confluenceOperationLevel("create", "page")).toBe("write");
  expect(confluenceOperationLevel("administer", "space")).toBe("admin");
  expect(confluenceRoleLevel(["read/space", "read/comment", "delete/own-content"])).toBe("read");
  expect(confluenceRoleLevel(["read/space", "write/space", "edit/blogpost"])).toBe("write");
  expect(confluenceRoleLevel(["read/space", "administer/space"])).toBe("admin");
});

test("space grants: one per principal, with its role; a role holder without records gets the role's level", () => {
  const perm = (id: string, type: string, pid: string, operation: string, targetType: string) => ({ id, principal: { type, id: pid }, operation, targetType });
  const grants = confluenceSpaceGrants(
    [
      perm("1", "user", "ann", "read", "space"),
      perm("2", "user", "ann", "administer", "space"),
      perm("3", "access-class", "ALL_LICENSED_USERS", "read", "space"),
      perm("4", "access-class", "ALL_LICENSED_USERS", "create", "page"),
      perm("5", "group", "g1", "read", "space"),
    ],
    [
      { roleId: "admin", principal: { type: "USER", id: "ann" } },
      { roleId: "viewer", principal: { type: "USER", id: "bob" } },
      { roleId: "collab", principal: { type: "ACCESS_CLASS", id: "all-licensed-users" } },
    ],
    [
      { id: "admin", name: "Admin", permissions: ["administer/space"] },
      { id: "viewer", name: "Viewer", permissions: ["read/space"] },
      { id: "collab", name: "Collaborator", permissions: ["read/space", "write/space"] },
    ],
    principal,
  );
  expect(grants.map((g) => [g.principal.type, g.principal.id, g.level, g.role?.name ?? null, g.permissionIds])).toEqual([
    ["user", "ann", "admin", "Admin", ["1", "2"]],
    ["all-users", "ALL_LICENSED_USERS", "write", "Collaborator", ["3", "4"]],
    ["group", "g1", "read", null, ["5"]],
    ["user", "bob", "read", "Viewer", []],
  ]);
  expect(grants[1]!.operations).toEqual(["create:page", "read:space"]);
});

test("Jira levels: Administer, write permissions, Browse only, nothing without Browse", () => {
  expect(jiraPermissionLevel(["ADMINISTER_PROJECTS"])).toBe("admin");
  expect(jiraPermissionLevel(["BROWSE_PROJECTS", "EDIT_ISSUES"])).toBe("write");
  expect(jiraPermissionLevel(["BROWSE_PROJECTS", "ADD_COMMENTS"])).toBe("read");
  expect(jiraPermissionLevel(["ASSIGNABLE_USER"])).toBeUndefined();
});

test("project grants: role grants per role actor, the rest per holder with the scheme grant ids", () => {
  const g = (id: number, permission: string, holder: { type: string; value?: string; parameter?: string; name?: string }) => ({ id, permission, holder });
  const scheme = [
    g(1, "BROWSE_PROJECTS", { type: "projectRole", value: "10" }),
    g(2, "ADMINISTER_PROJECTS", { type: "projectRole", value: "10" }),
    g(3, "BROWSE_PROJECTS", { type: "anyone" }),
    g(4, "BROWSE_PROJECTS", { type: "group", value: "gid", parameter: "devs" }),
    g(5, "EDIT_ISSUES", { type: "group", value: "gid", parameter: "devs" }),
    g(6, "BROWSE_PROJECTS", { type: "applicationRole", value: "" }),
    g(7, "BROWSE_PROJECTS", { type: "reporter" }),
    g(8, "ASSIGNABLE_USER", { type: "user", value: "zed" }),
  ];
  const roles = [{ id: 10, name: "Administrators", actors: [{ type: "user" as const, id: "ann", name: "Ann" }, { type: "group" as const, id: "ops", name: "ops" }] }];
  const grants = jiraProjectGrants(scheme, roles, principal);
  expect(grants.map((x) => [x.principal.type, x.principal.id, x.level, x.role?.name ?? null, x.grantIds ?? null])).toEqual([
    ["user", "ann", "admin", "Administrators", null],
    ["group", "ops", "admin", "Administrators", null],
    ["anonymous", "anyone", "read", null, [3]],
    ["group", "gid", "write", null, [4, 5]],
    ["all-users", "any", "read", null, [6]],
    ["dynamic", "reporter", "read", null, [7]],
  ]);
  // Without readable roles, role grants name nobody.
  expect(jiraProjectGrants(scheme, undefined, principal).some((x) => x.role)).toBe(false);
});

test("inherited read restrictions: ancestors' restrictions, nearest first, stopping at cycles", () => {
  const p = (id: string, parentId: string | null, read: string[] = []) => ({ id, title: id, parentId, read: read.map((r) => principal("user", r)) });
  const inherited = inheritedReadRestrictions([p("root", null, ["boss"]), p("mid", "root"), p("leaf", "mid", ["ann"]), p("child", "leaf"), p("x", "y"), p("y", "x", ["z"])]);
  expect(inherited.get("child")!.map((i) => [i.pageId, i.principals.map((x) => x.id)])).toEqual([
    ["leaf", ["ann"]],
    ["root", ["boss"]],
  ]);
  expect(inherited.get("root")).toEqual([]);
  expect(inherited.get("x")!.map((i) => i.pageId)).toEqual(["y"]);
});

test("user items collect direct access and access through groups", () => {
  const ann = { accountId: "ann", displayName: "Ann", active: true, status: "active", accountType: "atlassian", external: false, guest: false };
  const items = accessUserItems({
    users: [ann],
    groups: [{ id: "g", name: "devs", activeMembers: 1, members: ["ann"] }],
    resources: [
      { kind: "space", product: "confluence", key: "S", id: "1", name: "Space", mode: "ROLES", complete: true, grants: [{ principal: principal("user", "ann"), level: "admin", operations: [], role: { id: "r", name: "Admin" } }] },
      { kind: "project", product: "jira", key: "P", id: "2", name: "Proj", mode: "classic", complete: true, grants: [{ principal: principal("group", "g", "devs"), level: "write", operations: [] }] },
    ],
  });
  expect(items[0]!.access).toEqual([
    { kind: "space", key: "S", name: "Space", level: "admin", via: "role Admin" },
    { kind: "project", key: "P", name: "Proj", level: "write", via: "group devs" },
  ]);
});

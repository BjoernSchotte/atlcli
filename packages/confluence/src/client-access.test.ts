import { afterEach, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cloud: Profile = {
  name: "synthetic-cloud",
  baseUrl: "https://example.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "fixture@example.invalid", token: "fixture-token" },
};

type Call = { method: string; path: string; params: URLSearchParams; body?: unknown };
function stub(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname, params: url.searchParams, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return calls;
}

/** Two v2 pages: the first links to the second by cursor. */
const twoPages = (path: string, first: unknown, second: unknown) => (c: Call) =>
  c.params.get("cursor") === "next"
    ? Response.json({ results: [second], _links: {} })
    : Response.json({ results: [first], _links: { next: `/wiki/api/v2${path}?cursor=next&limit=250` } });

test("getSpacePermissionsV2 drains every cursor page", async () => {
  const calls = stub(
    twoPages(
      "/spaces/7/permissions",
      { id: "1", principal: { type: "user", id: "u1" }, operation: { key: "read", targetType: "space" } },
      { id: "2", principal: { type: "access-class", id: "ALL_LICENSED_USERS" }, operation: { key: "administer", targetType: "space" } },
    ),
  );
  expect(await new ConfluenceClient(cloud).getSpacePermissionsV2("7")).toEqual([
    { id: "1", principal: { type: "user", id: "u1" }, operation: { key: "read", targetType: "space" } },
    { id: "2", principal: { type: "access-class", id: "ALL_LICENSED_USERS" }, operation: { key: "administer", targetType: "space" } },
  ]);
  expect(calls.map((c) => c.path)).toEqual(["/wiki/api/v2/spaces/7/permissions", "/wiki/api/v2/spaces/7/permissions"]);
  expect(calls[0]!.params.get("limit")).toBe("250");
});

test("listSpaceRoles and getSpaceRoleAssignments page to the end", async () => {
  stub(twoPages("/space-roles", { id: "r1", type: "SYSTEM", name: "Viewer", spacePermissions: ["read/space"] }, { id: "r2", type: "CUSTOM", name: "X", description: "d" }));
  expect(await new ConfluenceClient(cloud).listSpaceRoles()).toEqual([
    { id: "r1", type: "SYSTEM", name: "Viewer", spacePermissions: ["read/space"] },
    { id: "r2", type: "CUSTOM", name: "X", description: "d", spacePermissions: [] },
  ]);
  stub(
    twoPages(
      "/spaces/7/role-assignments",
      { roleId: "r1", principal: { principalType: "USER", principalId: "u1" } },
      { roleId: "r2", principal: { principalType: "ACCESS_CLASS", principalId: "all-licensed-users" } },
    ),
  );
  expect((await new ConfluenceClient(cloud).getSpaceRoleAssignments("7")).map((a) => a.roleId)).toEqual(["r1", "r2"]);
});

test("getSpaceRoleMode reads the mode and treats a missing endpoint as PRE_ROLES", async () => {
  stub(() => Response.json({ mode: "ROLES" }));
  expect(await new ConfluenceClient(cloud).getSpaceRoleMode()).toBe("ROLES");
  stub(() => new Response("not found", { status: 404 }));
  expect(await new ConfluenceClient(cloud).getSpaceRoleMode()).toBe("PRE_ROLES");
  stub(() => new Response("no", { status: 403 }));
  await expect(new ConfluenceClient(cloud).getSpaceRoleMode()).rejects.toThrow(/403/);
});

test("setSpaceRoleAssignments posts an array; an entry without roleId removes the assignment", async () => {
  const calls = stub(() => Response.json({}));
  await new ConfluenceClient(cloud).setSpaceRoleAssignments("7", [{ principal: { principalType: "USER", principalId: "u1" } }]);
  expect(calls[0]).toMatchObject({ method: "POST", path: "/wiki/api/v2/spaces/7/role-assignments", body: [{ principal: { principalType: "USER", principalId: "u1" } }] });
});

test("removeSpacePermission deletes by v1 id and counts an absent record as removed", async () => {
  let gone = false;
  const calls = stub(() => (gone ? new Response("missing", { status: 404 }) : new Response(null, { status: 204 })));
  const client = new ConfluenceClient(cloud);
  await client.removeSpacePermission("DOCSY", "163869");
  gone = true;
  await client.removeSpacePermission("DOCSY", "163869");
  expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /wiki/rest/api/space/DOCSY/permission/163869", "DELETE /wiki/rest/api/space/DOCSY/permission/163869"]);
});

test("getGroupMembersById pages by offset until a short page", async () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ accountId: `u${i}`, displayName: `U${i}`, accountStatus: "active", accountType: "atlassian" }));
  const calls = stub((c) =>
    c.params.get("start") === "0"
      ? Response.json({ results: full, size: 200, _links: { next: "/rest/api/group/g/membersByGroupId?start=200" } })
      : Response.json({ results: [{ accountId: "x", displayName: "X", accountStatus: "inactive", isExternalCollaborator: true }], size: 1, _links: {} }),
  );
  const members = await new ConfluenceClient(cloud).getGroupMembersById("g");
  expect(members).toHaveLength(201);
  expect(members[200]).toEqual({ accountId: "x", displayName: "X", status: "inactive", accountType: "unknown", external: true, guest: false });
  expect(calls.map((c) => `${c.path}?${c.params}`)).toEqual([
    "/wiki/rest/api/group/g/membersByGroupId?start=0&limit=200&expand=isExternalCollaborator",
    "/wiki/rest/api/group/g/membersByGroupId?start=200&limit=200&expand=isExternalCollaborator",
  ]);
});

test("getUsersDetails dedupes and asks /user/bulk 100 ids at a time", async () => {
  const calls = stub((c) =>
    Response.json({
      results: c.params.get("accountId")!.split(",").map((id) => ({ accountId: id, displayName: id, accountStatus: "closed", accountType: "app", isGuest: true })),
    }),
  );
  const ids = Array.from({ length: 150 }, (_, i) => `a${i}`);
  const users = await new ConfluenceClient(cloud).getUsersDetails([...ids, "a0"]);
  expect(users).toHaveLength(150);
  expect(users[0]).toEqual({ accountId: "a0", displayName: "a0", status: "closed", accountType: "app", external: false, guest: true });
  expect(calls.map((c) => c.params.get("accountId")!.split(",").length)).toEqual([100, 50]);
  expect(calls[0]!.params.get("expand")).toBe("isExternalCollaborator");
});

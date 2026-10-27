import { afterEach, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";

const profile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Call = { method: string; path: string; params: URLSearchParams };
function stub(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? "GET", path: url.pathname, params: url.searchParams };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return calls;
}

test("listPermissionSchemes expands holders and names them", async () => {
  const calls = stub(() =>
    Response.json({
      permissionSchemes: [
        {
          id: 10000,
          name: "Default",
          permissions: [
            { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "projectRole", parameter: "10002", value: "10002", projectRole: { id: 10002, name: "Admins" } } },
            { id: 2, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
            { id: 3, permission: "ADMINISTER_PROJECTS", holder: { type: "group", parameter: "jira-admins", value: "g-1", group: { name: "jira-admins", groupId: "g-1" } } },
          ],
        },
      ],
    }),
  );
  expect(await new JiraClient(profile).listPermissionSchemes()).toEqual([
    {
      id: 10000,
      name: "Default",
      grants: [
        { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "projectRole", value: "10002", parameter: "10002", name: "Admins" } },
        { id: 2, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } },
        { id: 3, permission: "ADMINISTER_PROJECTS", holder: { type: "group", value: "g-1", parameter: "jira-admins", name: "jira-admins" } },
      ],
    },
  ]);
  expect(calls[0]!.params.get("expand")).toBe("permissions,group,projectRole,user");
});

test("getProjectRoles reads roledetails, then each role's actors; a refusal keeps its status", async () => {
  let forbidden = false;
  const calls = stub((c) => {
    if (c.path.endsWith("/roledetails")) return Response.json([{ id: 10002, name: "Administrators", admin: true }, { id: 10003, name: "Users" }]);
    if (forbidden) return new Response(JSON.stringify({ errorMessages: ["no"] }), { status: 403 });
    return Response.json(
      c.path.endsWith("/10002")
        ? { actors: [{ type: "atlassian-user-role-actor", displayName: "Ann", actorUser: { accountId: "a1" } }] }
        : { actors: [{ type: "atlassian-group-role-actor", displayName: "devs", actorGroup: { groupId: "g1", name: "devs", displayName: "Devs" } }] },
    );
  });
  expect(await new JiraClient(profile).getProjectRoles("ATL")).toEqual([
    { id: 10002, name: "Administrators", admin: true, actors: [{ type: "user", id: "a1", name: "Ann" }] },
    { id: 10003, name: "Users", admin: false, actors: [{ type: "group", id: "g1", name: "Devs" }] },
  ]);
  expect(calls.map((c) => c.path)).toEqual(["/rest/api/3/project/ATL/roledetails", "/rest/api/3/project/ATL/role/10002", "/rest/api/3/project/ATL/role/10003"]);
  forbidden = true;
  const error = await new JiraClient(profile).getProjectRoles("ATL").catch((e) => e);
  expect((error as { status?: number }).status).toBe(403);
});

test("getGroupMembers pages until isLast and includes inactive users", async () => {
  const calls = stub((c) =>
    c.params.get("startAt") === "0"
      ? Response.json({ values: [{ accountId: "a", displayName: "A", active: true, accountType: "atlassian" }], isLast: false })
      : Response.json({ values: [{ accountId: "b", displayName: "B", active: false, accountType: "app" }], isLast: true }),
  );
  expect(await new JiraClient(profile).getGroupMembers("g1")).toEqual([
    { accountId: "a", displayName: "A", active: true, accountType: "atlassian" },
    { accountId: "b", displayName: "B", active: false, accountType: "app" },
  ]);
  expect(calls.map((c) => c.params.toString())).toEqual([
    "groupId=g1&includeInactiveUsers=true&startAt=0&maxResults=50",
    "groupId=g1&includeInactiveUsers=true&startAt=1&maxResults=50",
  ]);
});

test("getUsersDetails repeats accountId, 100 per request, deduped", async () => {
  const calls = stub((c) => Response.json({ values: c.params.getAll("accountId").map((id) => ({ accountId: id, displayName: id, active: true, accountType: "atlassian" })), isLast: true }));
  const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
  expect(await new JiraClient(profile).getUsersDetails([...ids, "a1"])).toHaveLength(120);
  expect(calls.map((c) => c.params.getAll("accountId").length)).toEqual([100, 20]);
});

test("getProjectPermissionScheme returns the scheme's id and name", async () => {
  const calls = stub(() => Response.json({ id: 10000, name: "Default", self: "x" }));
  expect(await new JiraClient(profile).getProjectPermissionScheme("ATL")).toEqual({ id: 10000, name: "Default" });
  expect(calls[0]!.path).toBe("/rest/api/3/project/ATL/permissionscheme");
});

test("myPermissions maps havePermission per key", async () => {
  const calls = stub(() => Response.json({ permissions: { BROWSE_PROJECTS: { havePermission: true }, ADMINISTER_PROJECTS: { havePermission: false } } }));
  expect(await new JiraClient(profile).myPermissions("ATL", ["BROWSE_PROJECTS", "ADMINISTER_PROJECTS", "MISSING"])).toEqual({
    BROWSE_PROJECTS: true,
    ADMINISTER_PROJECTS: false,
    MISSING: false,
  });
  expect(calls[0]!.params.toString()).toBe("projectKey=ATL&permissions=BROWSE_PROJECTS%2CADMINISTER_PROJECTS%2CMISSING");
});

test("removeProjectRoleActor and deletePermissionGrant send the DELETEs", async () => {
  const calls = stub(() => new Response(null, { status: 204 }));
  const client = new JiraClient(profile);
  await client.removeProjectRoleActor("ATL", 10002, { type: "user", id: "a1" });
  await client.removeProjectRoleActor("ATL", 10002, { type: "group", id: "g1" });
  await client.deletePermissionGrant(10000, 3);
  expect(calls.map((c) => `${c.method} ${c.path}?${c.params}`)).toEqual([
    "DELETE /rest/api/3/project/ATL/role/10002?user=a1",
    "DELETE /rest/api/3/project/ATL/role/10002?groupId=g1",
    "DELETE /rest/api/3/permissionscheme/10000/permission/3?",
  ]);
});

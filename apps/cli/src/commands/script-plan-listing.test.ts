import { expect, test } from "bun:test";
import type { PlannedOperation } from "@atlcli/script-runtime";
import { describeOperation, renderPlan } from "./script.js";

const op = (verb: PlannedOperation["verb"], args: Record<string, unknown>): PlannedOperation => ({ seq: 1, verb, args, dependsOn: [] });

test("access writes read clearly in the plan listing", () => {
  expect(describeOperation(op("confluence.removeSpaceAccess", { spaceKey: "DOCSY", spaceId: "7", roleId: "r1", principal: { type: "user", id: "u1" }, permissionIds: ["11"] }))).toBe(
    "space access     DOCSY - user:u1 (role r1, 1 permission(s))",
  );
  expect(describeOperation(op("jira.removeRoleActor", { projectKey: "ATL", roleId: 10002, role: "Administrators", principal: { type: "group", id: "g1" } }))).toBe(
    'jira role        ATL "Administrators" - group:g1',
  );
  expect(
    describeOperation(op("jira.deletePermissionGrant", { schemeId: 10000, grantId: 3, scheme: "Default", permission: "BROWSE_PROJECTS", holder: { type: "anyone" } })),
  ).toBe('jira grant       DELETE 3 of scheme 10000 "Default": BROWSE_PROJECTS → anyone');
});

test("a skipped space access names the space, not a page", () => {
  const listing = renderPlan(
    {
      script: { name: "x" },
      target: { baseUrl: "https://example.atlassian.net" },
      operations: [],
      skipped: [{ verb: "confluence.removeSpaceAccess", target: "DOCSY", title: "group:g1", reason: "unchanged" }],
    } as never,
    undefined,
    false,
  );
  expect(listing).toContain('space DOCSY "group:g1" (no access)');
});

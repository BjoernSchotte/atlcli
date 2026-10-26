import { afterEach, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";
import { cloneIssue } from "./issue-clone.js";

const profile: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function site(failLink = false) {
  const writes: Array<{ method: string; path: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.endsWith("/SRC-2")) return Response.json({ id: "2", key: "SRC-2", fields: {} });
    if (method === "GET") {
      return Response.json({
        id: "1",
        key: "SRC-1",
        fields: {
          project: { key: "SRC" },
          summary: "Original",
          description: { type: "doc", version: 1, content: [] },
          issuetype: { name: "Task" },
          labels: ["a"],
          components: [{ id: "7", name: "Core" }],
          parent: { key: "SRC-0" },
          attachment: [],
        },
      });
    }
    writes.push({ method, path: url.pathname, body: JSON.parse(String(init?.body)) });
    if (url.pathname.endsWith("/issueLink") && failLink) return Response.json({ errorMessages: ["No link type Cloners"] }, { status: 404 });
    return url.pathname.endsWith("/issue") ? Response.json({ id: "2", key: "SRC-2" }, { status: 201 }) : new Response(null, { status: 201 });
  }) as typeof fetch;
  return writes;
}

test("clones within the project with components and parent, then links the clone", async () => {
  const writes = site();
  const result = await cloneIssue(new JiraClient(profile), "SRC-1", { summary: "Copy" });
  expect(result).toEqual({ id: "2", key: "SRC-2", attachments: [], warnings: [] });
  expect(writes[0]!.body.fields).toMatchObject({ project: { key: "SRC" }, summary: "Copy", labels: ["a"], components: [{ id: "7" }], parent: { key: "SRC-0" } });
  expect(writes[1]).toMatchObject({ path: "/rest/api/3/issueLink", body: { type: { name: "Cloners" }, inwardIssue: { key: "SRC-2" }, outwardIssue: { key: "SRC-1" } } });
});

test("into another project it drops components and parent; a failed link is a warning", async () => {
  const writes = site(true);
  const result = await cloneIssue(new JiraClient(profile), "SRC-1", { project: "DST" });
  expect(writes[0]!.body.fields.components).toBeUndefined();
  expect(writes[0]!.body.fields.parent).toBeUndefined();
  expect(writes[0]!.body.fields.project).toEqual({ key: "DST" });
  expect(result.warnings[0]).toMatch(/not linked to SRC-1/);
});

test("link: false creates no link", async () => {
  const writes = site();
  await cloneIssue(new JiraClient(profile), "SRC-1", { link: false });
  expect(writes.map((w) => w.path)).toEqual(["/rest/api/3/issue"]);
});

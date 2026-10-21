/**
 * JiraClient content APIs added for spec jira-content-workflows A1b: comment
 * edit/delete, the paginated changelog, and rich-text bodies per deployment.
 * Only `globalThis.fetch` is swapped, as in `client.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";

const cloud: Profile = {
  name: "test",
  baseUrl: "https://test.atlassian.net",
  auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
};
const dataCenter: Profile = { ...cloud, baseUrl: "https://jira.example.com", deploymentType: "data-center" };

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body: unknown }>;
let respond: (url: string) => unknown;

beforeEach(() => {
  calls = [];
  respond = () => ({});
  globalThis.fetch = mock((url: string, options: RequestInit) => {
    calls.push({
      url,
      method: options.method ?? "GET",
      body: options.body ? JSON.parse(String(options.body)) : undefined,
    });
    const payload = respond(url);
    return Promise.resolve(
      payload === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(payload), { status: 200 })
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("comments", () => {
  test("updateComment PUTs the body to the comment URL", async () => {
    const adf = { type: "doc" as const, version: 1 as const, content: [] };
    await new JiraClient(cloud).updateComment("AB-1", "77", adf);
    expect(calls[0]).toMatchObject({ method: "PUT", body: { body: adf } });
    expect(calls[0]!.url).toContain("/rest/api/3/issue/AB-1/comment/77");
  });

  test("deleteComment sends DELETE", async () => {
    respond = () => undefined;
    await new JiraClient(cloud).deleteComment("AB-1", "77");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]!.url).toContain("/issue/AB-1/comment/77");
  });

  test("string comments are ADF on Cloud and plain strings on Data Center (regression)", async () => {
    respond = () => ({ id: "1" });
    await new JiraClient(cloud).addComment("AB-1", "hello");
    expect((calls[0]!.body as { body: { type: string } }).body.type).toBe("doc");

    await new JiraClient(dataCenter).addComment("AB-1", "hello");
    expect(calls[1]!.url).toContain("/rest/api/2/issue/AB-1/comment");
    expect((calls[1]!.body as { body: unknown }).body).toBe("hello");
  });

  test("worklog comments follow the same rule", async () => {
    respond = () => ({ id: "1" });
    await new JiraClient(dataCenter).addWorklog("AB-1", 60, { comment: "fixed it" });
    expect((calls[0]!.body as { comment: unknown }).comment).toBe("fixed it");
  });
});

describe("getChangelog", () => {
  test("reports isLast from the Cloud page", async () => {
    respond = () => ({ values: [{ id: "1", created: "x", author: { displayName: "A" }, items: [] }], startAt: 0, total: 2, isLast: false });
    const page = await new JiraClient(cloud).getChangelog("AB-1");
    expect(page).toMatchObject({ startAt: 0, total: 2, isLast: false });
    expect(calls[0]!.url).toContain("/issue/AB-1/changelog?startAt=0&maxResults=100");
  });

  test("maps Data Center `histories` and derives isLast", async () => {
    respond = () => ({ histories: [{ id: "2", created: "y", author: { displayName: "B" }, items: [] }], startAt: 1, total: 2 });
    const page = await new JiraClient(dataCenter).getChangelog("AB-1", { startAt: 1 });
    expect(page.values.map((v) => v.id)).toEqual(["2"]);
    expect(page.isLast).toBe(true);
  });
});

describe("deployment detection", () => {
  test("deploymentType cloud wins over the atlassian.net heuristic", async () => {
    respond = () => ({ id: "1", key: "AB-1", fields: {} });
    const client = new JiraClient({ ...cloud, baseUrl: "https://jira.custom-domain.example", deploymentType: "cloud" });
    expect(client.isCloudSite).toBe(true);
    expect(client.siteUrl).toBe("https://jira.custom-domain.example");
    await client.getIssue("AB-1");
    expect(calls[0]!.url).toContain("/rest/api/3/issue/AB-1");
  });

  test("without deploymentType the historical heuristic applies", () => {
    expect(new JiraClient(cloud).isCloudSite).toBe(true);
    expect(new JiraClient({ ...cloud, baseUrl: "https://jira.example.com" }).isCloudSite).toBe(false);
  });
});

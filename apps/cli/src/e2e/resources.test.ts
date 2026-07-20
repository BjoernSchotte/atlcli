/**
 * Tests for the live-E2E naming, ownership-marker and per-test-cleanup helpers
 * (spec 011 "E2E resource discipline").
 *
 * Offline by design: the tracker is exercised against in-memory port
 * implementations, and the REST adapter against a real local Bun HTTP server
 * standing in for the Confluence/Jira REST API. Nothing stubs `fetch`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";
import { MemoryConfluence, MemoryJira } from "./memory-ports.js";
import { createConfluencePort, createJiraPort } from "./rest-ports.js";
import {
  E2E_PROJECT_KEY,
  E2E_RUN_ID_PROPERTY,
  E2E_SPACE_KEY,
  E2eResourceTracker,
  makeE2eTitle,
  parseE2eTitle,
  resolveRunId,
  withE2eResources,
} from "./resources.js";

const AT = new Date(1_789_000_000_000); // 2026-09-08T…Z, epoch seconds 1789000000

describe("makeE2eTitle", () => {
  it("builds atlcli-e2e-<feature>-<epoch seconds>", () => {
    expect(makeE2eTitle("scope-tree", AT)).toBe("atlcli-e2e-scope-tree-1789000000");
  });

  it("rejects feature slugs that would produce an unrecoverable name", () => {
    // An out-of-convention name is invisible to the sweeper forever, so this is
    // a hard error rather than a silent slugify.
    expect(() => makeE2eTitle("Scope Tree", AT)).toThrow(/lowercase, dash-separated/);
    expect(() => makeE2eTitle("", AT)).toThrow();
    expect(() => makeE2eTitle("trailing-", AT)).toThrow();
    expect(() => makeE2eTitle("under_score", AT)).toThrow();
  });
});

describe("parseE2eTitle", () => {
  it("round-trips a generated name", () => {
    expect(parseE2eTitle(makeE2eTitle("macro-render", AT))).toEqual({
      feature: "macro-render",
      timestampSeconds: 1_789_000_000,
    });
  });

  it("keeps multi-segment feature slugs intact", () => {
    expect(parseE2eTitle("atlcli-e2e-scope-tree-labels-1789000000")?.feature).toBe("scope-tree-labels");
  });

  it("returns null for anything not following the convention", () => {
    for (const title of [
      "Spec-005 Logo & Image E2E (temp)",
      "M1 Abnahme 07",
      "DOCX feature zoo",
      "atlcli-e2e-1789000000", // no feature segment
      "atlcli-e2e-scope-tree", // no timestamp
      "atlcli-e2e-scope-tree-42", // timestamp too short to be epoch seconds
      "prefixed-atlcli-e2e-scope-tree-1789000000",
      "",
    ]) {
      expect(parseE2eTitle(title)).toBeNull();
    }
  });
});

describe("resolveRunId", () => {
  it("prefers the CI run identity, including the attempt number", () => {
    expect(resolveRunId({ GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "2" })).toBe("gha-12345-2");
    expect(resolveRunId({ GITHUB_RUN_ID: "12345" })).toBe("gha-12345");
  });

  it("falls back to a unique local id", () => {
    const first = resolveRunId({});
    const second = resolveRunId({});
    expect(first).toStartWith("local-");
    expect(first).not.toBe(second);
  });
});

describe("E2eResourceTracker", () => {
  it("creates a conventionally named page carrying the ownership marker", async () => {
    const confluence = new MemoryConfluence();
    const tracker = new E2eResourceTracker({ confluence }, "run-abc");

    const page = await tracker.createPage("scope-tree", { now: AT });

    expect(page.title).toBe("atlcli-e2e-scope-tree-1789000000");
    expect(confluence.pages.get(page.id)?.spaceKey).toBe(E2E_SPACE_KEY);
    expect(await confluence.getPageProperty(page.id, E2E_RUN_ID_PROPERTY)).toBe("run-abc");
  });

  it("creates a conventionally named issue carrying the ownership marker", async () => {
    const jira = new MemoryJira();
    const tracker = new E2eResourceTracker({ jira }, "run-abc");

    const issue = await tracker.createIssue("jira-macro", { now: AT });

    expect(issue.summary).toBe("atlcli-e2e-jira-macro-1789000000");
    expect(jira.issues.get(issue.key)?.projectKey).toBe(E2E_PROJECT_KEY);
    expect(await jira.getIssueProperty(issue.key, E2E_RUN_ID_PROPERTY)).toBe("run-abc");
  });

  it("still deletes a page whose marker write failed", async () => {
    // An unmarked orphan would be invisible to the marker-gated sweeper — i.e.
    // permanent residue — so the ID is tracked before the marker is stamped.
    const confluence = new MemoryConfluence();
    confluence.failNextPropertyWrite = true;
    const tracker = new E2eResourceTracker({ confluence }, "run-abc");

    await expect(tracker.createPage("scope-tree", { now: AT })).rejects.toThrow(/HTTP 403/);
    expect(tracker.trackedPages).toHaveLength(1);

    await tracker.cleanup();
    expect(confluence.pages.size).toBe(0);
  });

  it("deletes tracked resources newest-first and reports what it removed", async () => {
    const confluence = new MemoryConfluence();
    const jira = new MemoryJira();
    const tracker = new E2eResourceTracker({ confluence, jira }, "run-abc");

    const first = await tracker.createPage("first", { now: AT });
    const second = await tracker.createPage("second", { now: AT });
    const issue = await tracker.createIssue("third", { now: AT });

    const summary = await tracker.cleanup();

    expect(summary.deletedPages).toEqual([second.id, first.id]);
    expect(summary.deletedIssues).toEqual([issue.key]);
    expect(summary.failures).toEqual([]);
    expect(confluence.pages.size).toBe(0);
    expect(jira.issues.size).toBe(0);
  });

  it("never throws from cleanup, and reports failures instead", async () => {
    // cleanup() runs inside `finally`; throwing there would replace the test's
    // real failure with a cleanup error.
    const confluence = new MemoryConfluence();
    const tracker = new E2eResourceTracker({ confluence }, "run-abc");
    const doomed = await tracker.createPage("doomed", { now: AT });
    const fine = await tracker.createPage("fine", { now: AT });
    confluence.failDeletesFor.add(doomed.id);

    const summary = await tracker.cleanup();

    expect(summary.failures).toEqual([
      { kind: "page", id: doomed.id, error: `HTTP 500 deleting page ${doomed.id}` },
    ]);
    // The healthy resource is still removed.
    expect(summary.deletedPages).toEqual([fine.id]);
  });

  it("tracks resources created by something else (e.g. the CLI under test)", async () => {
    const confluence = new MemoryConfluence();
    const external = confluence.seed({ title: "atlcli-e2e-cli-made-1789000000", spaceKey: E2E_SPACE_KEY });
    const tracker = new E2eResourceTracker({ confluence }, "run-abc");

    tracker.trackPage(external.id);
    tracker.trackPage(external.id); // idempotent
    expect(tracker.trackedPages).toEqual([external.id]);

    await tracker.cleanup();
    expect(confluence.pages.size).toBe(0);
  });
});

describe("withE2eResources", () => {
  it("deletes everything the body created", async () => {
    const confluence = new MemoryConfluence();

    await withE2eResources({ confluence }, async (tracker) => {
      await tracker.createPage("happy-path", { now: AT });
      expect(confluence.pages.size).toBe(1);
    });

    expect(confluence.pages.size).toBe(0);
  });

  it("deletes everything even when the body throws", async () => {
    // This is the property that makes the nightly sweeper a recovery mechanism
    // rather than the primary one: a failing test still leaves a clean tenant.
    const confluence = new MemoryConfluence();
    const jira = new MemoryJira();

    await expect(
      withE2eResources({ confluence, jira }, async (tracker) => {
        await tracker.createPage("exploding", { now: AT });
        await tracker.createIssue("exploding", { now: AT });
        throw new Error("assertion failed inside the E2E body");
      })
    ).rejects.toThrow("assertion failed inside the E2E body");

    expect(confluence.pages.size).toBe(0);
    expect(jira.issues.size).toBe(0);
  });

  it("surfaces leftover resources to the caller without masking the body's error", async () => {
    const confluence = new MemoryConfluence();
    const summaries: Array<{ failures: unknown[] }> = [];

    await expect(
      withE2eResources(
        { confluence },
        async (tracker) => {
          const page = await tracker.createPage("stuck", { now: AT });
          confluence.failDeletesFor.add(page.id);
          throw new Error("body failure wins");
        },
        { onCleanup: (summary) => summaries.push(summary) }
      )
    ).rejects.toThrow("body failure wins");

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.failures).toHaveLength(1);
  });
});

describe("module registry is intact for later test files", () => {
  /**
   * Regression: `auth.test.ts`, `helloworld.test.ts` and `session-guard.test.ts`
   * all call `mock.module(...)`, which mutates the registry for the WHOLE
   * process. Without an `afterAll` that puts the real barrels back, their stubs
   * leaked into every file that runs after them — `getLogger()` came back with
   * only an `auth` method, so any later test touching a real API client died on
   * `logger.api is not a function`, and the real clients threw on construction.
   *
   * This file sorts after `src/commands/`, so it is exactly where such a leak
   * shows up. Asserting it here keeps the restores honest.
   */
  it("hands later files the real @atlcli/core logger, not a test stub", async () => {
    const { getLogger } = await import("@atlcli/core");
    const logger = getLogger();
    // `api` is the method the leaked stub omitted, which is what broke the
    // Confluence/Jira clients for every file that ran after the mock.
    expect(typeof logger.api).toBe("function");
    expect(typeof logger.auth).toBe("function");
  });

  it("hands later files constructible API clients", async () => {
    const { ConfluenceClient } = await import("@atlcli/confluence");
    const { JiraClient } = await import("@atlcli/jira");
    const profile: Profile = {
      name: "registry-probe",
      baseUrl: "https://probe.example.com",
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "probe-token" },
    };
    expect(() => new ConfluenceClient(profile)).not.toThrow();
    expect(() => new JiraClient(profile)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REST adapter against a real local HTTP server
// ---------------------------------------------------------------------------

describe("REST ports against a local stand-in REST API", () => {
  let server: ReturnType<typeof Bun.serve>;
  let profile: Profile;
  const unmatched: string[] = [];
  const authHeaders: string[] = [];

  // Server-side state, so the adapter is exercised end to end rather than
  // against canned responses.
  const pages = new Map<string, { id: string; title: string; spaceKey: string }>();
  const pageProperties = new Map<string, { value: unknown; version: number }>();
  const issueProperties = new Map<string, unknown>();
  const deletedPages: string[] = [];
  const deletedIssues: string[] = [];
  let nextPageId = 900;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const { pathname } = url;
        const auth = req.headers.get("authorization");
        if (auth) authHeaders.push(auth);

        // --- Confluence: content properties -------------------------------
        const propMatch = pathname.match(/^\/rest\/api\/content\/([^/]+)\/property(?:\/([^/]+))?$/);
        if (propMatch) {
          const [, pageId, key] = propMatch;
          if (req.method === "GET" && key) {
            const stored = pageProperties.get(`${pageId}:${key}`);
            if (!stored) return new Response("{}", { status: 404 });
            return Response.json({ key, value: stored.value, version: { number: stored.version } });
          }
          if (req.method === "POST") {
            const body = (await req.json()) as { key: string; value: unknown };
            pageProperties.set(`${pageId}:${body.key}`, { value: body.value, version: 1 });
            return Response.json({ key: body.key, value: body.value, version: { number: 1 } });
          }
          if (req.method === "PUT" && key) {
            const body = (await req.json()) as { value: unknown; version: { number: number } };
            pageProperties.set(`${pageId}:${key}`, { value: body.value, version: body.version.number });
            return Response.json({ key, value: body.value, version: body.version });
          }
        }

        // --- Confluence: content CRUD -------------------------------------
        if (pathname === "/rest/api/content" && req.method === "POST") {
          const body = (await req.json()) as { title: string; space: { key: string } };
          const id = String(nextPageId++);
          pages.set(id, { id, title: body.title, spaceKey: body.space.key });
          return Response.json({ id, title: body.title, space: { key: body.space.key }, version: { number: 1 } });
        }
        const contentMatch = pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
        if (contentMatch && req.method === "DELETE") {
          deletedPages.push(contentMatch[1]!);
          pages.delete(contentMatch[1]!);
          return new Response(null, { status: 204 });
        }

        // --- Confluence: paginated CQL search ------------------------------
        // Two pages, the first one SHORT but carrying a live next-link, so a
        // `results.length < limit` early break would visibly lose results.
        if (pathname === "/rest/api/content/search") {
          const cursor = url.searchParams.get("cursor");
          if (!cursor) {
            return Response.json({
              results: [
                {
                  id: "p1",
                  title: "atlcli-e2e-page-one-1789000000",
                  type: "page",
                  space: { key: "DOCSY" },
                },
              ],
              start: 0,
              limit: 100,
              size: 1,
              _links: { next: "/rest/api/content/search?cql=x&cursor=page2" },
            });
          }
          return Response.json({
            results: [
              {
                id: "p2",
                title: "atlcli-e2e-page-two-1789000000",
                type: "page",
                space: { key: "DOCSY" },
              },
              { id: "p3", title: "M1 Abnahme 42", type: "page", space: { key: "DOCSY" } },
            ],
            start: 1,
            limit: 100,
            size: 2,
            _links: {},
          });
        }

        // --- Jira: issue properties ----------------------------------------
        const issuePropMatch = pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)\/properties\/([^/]+)$/);
        if (issuePropMatch) {
          const [, issueKey, key] = issuePropMatch;
          if (req.method === "PUT") {
            issueProperties.set(`${issueKey}:${key}`, await req.json());
            return new Response(null, { status: 201 });
          }
          if (req.method === "GET") {
            const stored = issueProperties.get(`${issueKey}:${key}`);
            if (stored === undefined) return new Response("{}", { status: 404 });
            return Response.json({ key, value: stored });
          }
        }

        // --- Jira: issue CRUD ----------------------------------------------
        if (pathname === "/rest/api/2/issue" && req.method === "POST") {
          const body = (await req.json()) as { fields: { summary: string; project: { key: string } } };
          return Response.json({ id: "9001", key: `${body.fields.project.key}-1` });
        }
        const issueMatch = pathname.match(/^\/rest\/api\/2\/issue\/([^/]+)$/);
        if (issueMatch && req.method === "GET") {
          return Response.json({
            id: "9001",
            key: issueMatch[1],
            self: url.href,
            fields: { summary: "atlcli-e2e-jira-1789000000", project: { key: "ATLCLI", id: "1" } },
          });
        }
        if (issueMatch && req.method === "DELETE") {
          deletedIssues.push(issueMatch[1]!);
          return new Response(null, { status: 204 });
        }

        // --- Jira: paginated JQL search -------------------------------------
        if (pathname === "/rest/api/2/search/jql") {
          const body = (await req.json().catch(() => ({}))) as { nextPageToken?: string };
          if (!body.nextPageToken) {
            return Response.json({
              issues: [
                {
                  id: "1",
                  key: "ATLCLI-1",
                  fields: { summary: "atlcli-e2e-first-1789000000", project: { key: "ATLCLI" } },
                },
              ],
              nextPageToken: "token-2",
              maxResults: 100,
            });
          }
          return Response.json({
            issues: [
              {
                id: "2",
                key: "ATLCLI-2",
                fields: { summary: "atlcli-e2e-second-1789000000", project: { key: "ATLCLI" } },
              },
            ],
            maxResults: 100,
          });
        }

        unmatched.push(`${req.method} ${pathname}`);
        return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });

    // Bearer/data-center so the Confluence base URL is used verbatim (no /wiki)
    // and the token resolves from the profile without touching the keychain.
    profile = {
      name: "e2e-stub",
      baseUrl: server.url.origin,
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "stub-token" },
    };
  });

  afterAll(() => {
    server?.stop(true);
  });

  it("creates a page, stamps the marker, reads it back and deletes it", async () => {
    const port = createConfluencePort(profile);

    const page = await port.createPage({
      spaceKey: E2E_SPACE_KEY,
      title: "atlcli-e2e-rest-1789000000",
      storage: "<p>fixture</p>",
    });
    await port.setPageProperty(page.id, E2E_RUN_ID_PROPERTY, "gha-777");

    expect(await port.getPageProperty(page.id, E2E_RUN_ID_PROPERTY)).toBe("gha-777");

    await port.deletePage(page.id);
    expect(deletedPages).toContain(page.id);
    expect(authHeaders).toContain("Bearer stub-token");
  });

  it("reports no marker when the property does not exist", async () => {
    const port = createConfluencePort(profile);
    expect(await port.getPageProperty("does-not-exist", E2E_RUN_ID_PROPERTY)).toBeUndefined();
  });

  it("overwrites an existing marker with an incremented property version", async () => {
    const port = createConfluencePort(profile);
    const page = await port.createPage({ spaceKey: E2E_SPACE_KEY, title: "atlcli-e2e-v-1789000000", storage: "" });

    await port.setPageProperty(page.id, E2E_RUN_ID_PROPERTY, "gha-1");
    await port.setPageProperty(page.id, E2E_RUN_ID_PROPERTY, "gha-2");

    expect(await port.getPageProperty(page.id, E2E_RUN_ID_PROPERTY)).toBe("gha-2");
    expect(pageProperties.get(`${page.id}:${E2E_RUN_ID_PROPERTY}`)?.version).toBe(2);
  });

  it("drains every page of the Confluence listing, including a short first page", async () => {
    const port = createConfluencePort(profile);
    const records = await port.listPages("DOCSY");

    expect(records.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    // The retained "M1 Abnahme" fixture is listed but never gets a marker,
    // because its name does not follow the convention.
    expect(records.find((r) => r.id === "p3")?.runId).toBeUndefined();
  });

  it("drains every page of the Jira listing", async () => {
    const port = createJiraPort(profile);
    const records = await port.listIssues("ATLCLI");
    expect(records.map((r) => r.key)).toEqual(["ATLCLI-1", "ATLCLI-2"]);
  });

  it("stamps and reads a Jira issue property, then deletes the issue", async () => {
    const port = createJiraPort(profile);
    const issue = await port.createIssue({ projectKey: E2E_PROJECT_KEY, summary: "atlcli-e2e-jira-1789000000", issueType: "Task" });

    await port.setIssueProperty(issue.key, E2E_RUN_ID_PROPERTY, "gha-777");
    expect(await port.getIssueProperty(issue.key, E2E_RUN_ID_PROPERTY)).toBe("gha-777");

    await port.deleteIssue(issue.key);
    expect(deletedIssues).toContain(issue.key);
  });

  it("routed every request the adapters made", () => {
    expect(unmatched).toEqual([]);
  });
});

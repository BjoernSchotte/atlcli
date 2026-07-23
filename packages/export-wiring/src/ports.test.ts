/**
 * Port adapters over the real clients: method pinning and the error taxonomy
 * the macro resolver branches on.
 */
import { describe, expect, test } from "bun:test";
import type { ConfluenceClient } from "@atlcli/confluence";
import { isPortError } from "@atlcli/export-macros";
import {
  attachmentLookupFromClient,
  confluenceContentPortFromClient,
  exportViewPortFromClient,
  jiraIssuePortFromClient,
  type JiraClientLike,
  type JiraIssueLike,
} from "./ports.js";

const BASE = "https://acme.atlassian.net";

describe("confluenceContentPortFromClient", () => {
  test("getChildren uses the child-page endpoint (getChildrenWithPosition), never the CQL lookup", async () => {
    // Pin the client method: the CQL-based client.getChildren lags behind fresh
    // page creation (e2e-observed: a new child page was missing on the first
    // export, present on retry) and has no position guarantee.
    const calls: string[] = [];
    const fake = {
      async getChildrenWithPosition(parentId: string, opts?: { limit?: number }) {
        calls.push(`getChildrenWithPosition:${parentId}:${opts?.limit}`);
        return [
          { id: "2", title: "Beta", position: 1 },
          { id: "1", title: "Alpha", position: 0 },
        ];
      },
      async getChildren() {
        calls.push("getChildren");
        return [];
      },
    } as unknown as ConfluenceClient;

    const port = confluenceContentPortFromClient(fake);
    const children = await port.getChildren("42", { limit: 51 });

    expect(calls).toEqual(["getChildrenWithPosition:42:51"]);
    expect(children).toEqual([
      { id: "2", title: "Beta" },
      { id: "1", title: "Alpha" },
    ]);
  });

  test("port cap slices a fully-drained listing to the requested limit", async () => {
    const many = Array.from({ length: 10 }, (_v, i) => ({ id: `${i}`, title: `P${i}`, position: i }));
    const fake = {
      async getChildrenWithPosition() {
        return many;
      },
    } as unknown as ConfluenceClient;
    const port = confluenceContentPortFromClient(fake);
    expect((await port.getChildren("42", { limit: 3 })).length).toBe(3);
  });

  test("macro-supplied title/space are CQL-escaped, never interpolated raw", async () => {
    // Macro PARAMETERS are page-editor-controlled — a different trust boundary
    // than a CLI flag or a panel field.
    const seen: string[] = [];
    const fake = {
      async searchPages(cql: string) {
        seen.push(cql);
        return [];
      },
    } as unknown as ConfluenceClient;
    const port = confluenceContentPortFromClient(fake);
    await port.getPageStorage('evil" OR title~"', 'SP"ACE');
    expect(seen[0]).not.toContain('title="evil" OR');
    expect(seen[0]).toContain('\\"');
  });

  test("client errors are classified by status code", async () => {
    const kindOf = async (message: string): Promise<string> => {
      const fake = {
        async searchPages() {
          throw new Error(message);
        },
      } as unknown as ConfluenceClient;
      try {
        await confluenceContentPortFromClient(fake).searchCql("type=page", { limit: 1 });
        return "none";
      } catch (e) {
        expect(isPortError(e)).toBe(true);
        return (e as { kind: string }).kind;
      }
    };
    expect(await kindOf("Confluence API error (403): nope")).toBe("permission");
    expect(await kindOf("Confluence API error (401): nope")).toBe("permission");
    expect(await kindOf("Confluence API error (404): gone")).toBe("not-found");
    expect(await kindOf("Confluence API error (429): slow")).toBe("rate-limited");
    expect(await kindOf("Confluence API error (500): boom")).toBe("network");
    expect(await kindOf("socket hang up")).toBe("network");
  });

  test("searchContent uses searchDetailed, NOT searchPages", async () => {
    // Pin the client method. `searchPages` drives `GET /content/search`, which
    // returns neither the excerpt the `description` column needs nor the
    // `totalSize` the truncation note names — a table built on it would look
    // fine and be missing a column plus its own scale.
    const calls: string[] = [];
    const fake = {
      async searchDetailed(cql: string, opts: { limit?: number; contentStatuses?: string[] }) {
        calls.push(`searchDetailed:${cql}:${opts.limit}:${opts.contentStatuses?.join("|") ?? "-"}`);
        return {
          results: [
            {
              id: "1",
              title: "P",
              type: "page",
              spaceName: "S",
              excerpt: "E",
              ownedBy: "O",
              status: "current",
            },
          ],
          totalSize: 2817,
        };
      },
      async searchPages() {
        calls.push("searchPages");
        return [];
      },
    } as unknown as ConfluenceClient;

    const port = confluenceContentPortFromClient(fake);
    const page = await port.searchContent!('space in ("DOCSY")', {
      maximumResults: 11,
      contentStatuses: ["current"],
    });

    expect(calls).toEqual(['searchDetailed:space in ("DOCSY"):11:current']);
    expect(page.totalSize).toBe(2817);
    expect(page.hits[0]).toEqual({
      id: "1",
      title: "P",
      type: "page",
      spaceName: "S",
      excerpt: "E",
      ownedBy: "O",
      status: "current",
    });
  });

  test("searchContent slices to the requested cap so the renderer's probe still measures", async () => {
    const fake = {
      async searchDetailed() {
        return { results: Array.from({ length: 9 }, (_v, i) => ({ id: `${i}`, title: `P${i}` })) };
      },
    } as unknown as ConfluenceClient;
    const page = await confluenceContentPortFromClient(fake).searchContent!("type = page", {
      maximumResults: 4,
    });
    expect(page.hits).toHaveLength(4);
    expect(page.totalSize).toBeUndefined();
  });
});

describe("exportViewPortFromClient", () => {
  test("caches one batch per page and uses the versioned macro endpoint when absent", async () => {
    const pages: string[] = [];
    const individual: Array<{ pageId: string; pageVersion: number; macroId: string }> = [];
    const fake = {
      async getExportViewMacros(pageId: string) {
        pages.push(pageId);
        return new Map([["m1", "<p>rendered</p>"]]);
      },
      async getMacroBodyByMacroId(pageId: string, pageVersion: number, macroId: string) {
        individual.push({ pageId, pageVersion, macroId });
        return "<p>Forge export</p>";
      },
    } as unknown as ConfluenceClient;
    const port = exportViewPortFromClient(fake);
    expect(await port.renderMacroHtml("7", "m1")).toBe("<p>rendered</p>");
    expect(await port.renderMacroHtml("7", "forge-local-id", 3)).toBe("<p>Forge export</p>");
    expect(await port.renderMacroHtml("7", "missing")).toBeUndefined();
    expect(pages).toEqual(["7"]);
    expect(individual).toEqual([{
      pageId: "7",
      pageVersion: 3,
      macroId: "forge-local-id",
    }]);
  });
});

describe("attachmentLookupFromClient", () => {
  test("lists a page's attachments once and reuses the listing", async () => {
    let calls = 0;
    const fake = {
      async listAttachments() {
        calls += 1;
        return [{ filename: "a.png", version: 3, modified: "2026-01-01" }];
      },
    } as unknown as ConfluenceClient;
    const port = attachmentLookupFromClient(fake);
    expect(await port.lookup("1", "a.png")).toEqual({
      filename: "a.png",
      version: 3,
      modified: "2026-01-01",
    });
    expect(await port.lookup("1", "b.png")).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("jiraIssuePortFromClient", () => {
  function failing(err: Error): JiraClientLike {
    return {
      async getIssue(): Promise<JiraIssueLike> {
        throw err;
      },
      async search() {
        throw err;
      },
    };
  }

  test("403 → permission PortError", async () => {
    const port = jiraIssuePortFromClient(failing(new Error("Jira API error (403): forbidden")), BASE);
    try {
      await port.getIssue("ATL-1");
      throw new Error("expected throw");
    } catch (e) {
      expect(isPortError(e)).toBe(true);
      expect((e as { kind: string }).kind).toBe("permission");
    }
  });

  test("404 → not-found; 429 → rate-limited; other → network", async () => {
    const kindOf = async (message: string): Promise<string> => {
      try {
        await jiraIssuePortFromClient(failing(new Error(message)), BASE).getIssue("X");
        return "none";
      } catch (e) {
        return (e as { kind: string }).kind;
      }
    };
    expect(await kindOf("Jira API error (404): gone")).toBe("not-found");
    expect(await kindOf("Jira API error (429): slow down")).toBe("rate-limited");
    expect(await kindOf("Jira API error (500): boom")).toBe("network");
  });

  test("maps an issue to a ref with a browse URL and the renderer's extra columns", async () => {
    const client: JiraClientLike = {
      async getIssue(): Promise<JiraIssueLike> {
        return {
          key: "ATL-9",
          fields: {
            summary: "Hi",
            status: { name: "Done", statusCategory: { colorName: "green" } },
            assignee: { displayName: "Ada" },
            labels: ["a", "b"],
            issuetype: { name: "Bug" },
          },
        };
      },
      async search() {
        return { issues: [] };
      },
    };
    const ref = await jiraIssuePortFromClient(client, BASE).getIssue("ATL-9");
    expect(ref.url).toBe(`${BASE}/browse/ATL-9`);
    expect(ref.statusColor).toBe("green");
    expect(ref.fields).toMatchObject({ assignee: "Ada", labels: "a, b", type: "Bug" });
    // Datasource tables name this column `issuetype` (the Jira provider's own
    // schema key) while the legacy macro names it `type`. Both must resolve, or
    // a modern datasource table renders a column of blank cells.
    expect(ref.fields?.issuetype).toBe("Bug");
  });

  test("a trailing slash on the site base URL never doubles up in the browse link", async () => {
    const client: JiraClientLike = {
      async getIssue(): Promise<JiraIssueLike> {
        return { key: "ATL-1", fields: {} };
      },
      async search() {
        return { issues: [] };
      },
    };
    const ref = await jiraIssuePortFromClient(client, `${BASE}//`).getIssue("ATL-1");
    expect(ref.url).toBe(`${BASE}/browse/ATL-1`);
  });

  test("searchJql caps at maximumIssues even when the client over-returns", async () => {
    const client: JiraClientLike = {
      async getIssue(): Promise<JiraIssueLike> {
        return { key: "X", fields: {} };
      },
      async search() {
        return {
          issues: Array.from({ length: 9 }, (_v, i) => ({ key: `A-${i}`, fields: {} })),
        };
      },
    };
    const refs = await jiraIssuePortFromClient(client, BASE).searchJql("project = A", {
      maximumIssues: 3,
      columns: [],
    });
    expect(refs.length).toBe(3);
  });
});

/**
 * REST-backed implementations of the E2E ports (spec 011 "E2E resource
 * discipline").
 *
 * Page/issue CRUD and listing go through `ConfluenceClient` / `JiraClient` so
 * live E2E traffic uses the same retry, auth and pagination code paths the
 * product does. The two **property** endpoints are the exception: neither
 * client wraps content properties / issue properties today, so those are issued
 * directly against the same base URL with the same `Authorization` header
 * rather than growing the shared clients' public API for a test-only need.
 *
 * @module
 */

import { buildAuthHeader, getConfluenceBaseUrl, type Profile } from "@atlcli/core";
import { ConfluenceClient, escapeCqlValue } from "@atlcli/confluence";
import { JiraClient } from "@atlcli/jira";
import {
  E2E_NAME_PREFIX,
  E2E_RUN_ID_PROPERTY,
  parseE2eTitle,
  type E2eConfluencePort,
  type E2eIssueRecord,
  type E2eJiraPort,
  type E2ePageRecord,
} from "./resources.js";

/** Shape stored in the marker property. An object, so hosts that reject scalar property values still work. */
interface RunIdPropertyValue {
  runId: string;
  createdAt: string;
}

function encodeRunId(runId: string): RunIdPropertyValue {
  return { runId, createdAt: new Date().toISOString() };
}

/** Tolerates both the object shape written by {@link encodeRunId} and a bare string. */
function decodeRunId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const runId = (value as { runId?: unknown }).runId;
    if (typeof runId === "string") return runId.trim() || undefined;
  }
  return undefined;
}

/**
 * Jira's API path, mirroring `JiraClient`'s private `apiPath` getter — Cloud
 * sites get v3, everything else v2.
 */
function jiraApiPath(profile: Profile): string {
  return profile.baseUrl.includes(".atlassian.net") ? "/rest/api/3" : "/rest/api/2";
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Build a REST-backed Confluence port for live E2E resource handling. */
export function createConfluencePort(profile: Profile): E2eConfluencePort {
  const client = new ConfluenceClient(profile);
  const baseUrl = getConfluenceBaseUrl(profile);

  const propertyHeaders = (): Record<string, string> => ({
    Authorization: buildAuthHeader(profile),
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  const propertyUrl = (pageId: string, key?: string): string =>
    `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/property${key ? `/${encodeURIComponent(key)}` : ""}`;

  return {
    async createPage(input) {
      const page = await client.createPage(input);
      return { id: page.id, title: page.title };
    },

    async deletePage(pageId) {
      await client.deletePage(pageId);
    },

    async setPageProperty(pageId, key, value) {
      // Mirrors the client's own `setEditorVersion` dance: read the current
      // version to PUT over it, POST when the property does not exist yet.
      const existing = await fetch(propertyUrl(pageId, key), { headers: propertyHeaders() });
      const body = { key, value: encodeRunId(value) };

      if (existing.ok) {
        const current = (await readJson(existing)) as { version?: { number?: number } } | undefined;
        const next = (current?.version?.number ?? 0) + 1;
        const put = await fetch(propertyUrl(pageId, key), {
          method: "PUT",
          headers: propertyHeaders(),
          body: JSON.stringify({ ...body, version: { number: next } }),
        });
        if (!put.ok) {
          throw new Error(`Failed to update content property ${key} on page ${pageId}: HTTP ${put.status}`);
        }
        return;
      }

      const post = await fetch(propertyUrl(pageId), {
        method: "POST",
        headers: propertyHeaders(),
        body: JSON.stringify(body),
      });
      if (!post.ok) {
        throw new Error(`Failed to create content property ${key} on page ${pageId}: HTTP ${post.status}`);
      }
    },

    async getPageProperty(pageId, key) {
      const response = await fetch(propertyUrl(pageId, key), { headers: propertyHeaders() });
      // A missing property is the common case, not an error — and it means
      // "not ours", which the sweeper treats as do-not-delete.
      if (!response.ok) return undefined;
      const data = (await readJson(response)) as { value?: unknown } | undefined;
      return decodeRunId(data?.value);
    },

    async listPages(spaceKey) {
      // `searchPages` drains cursor pagination through `drainPaginated`, so a
      // short page carrying a live next-link is never mistaken for the last one.
      // The title filter only bounds the candidate set; ownership is still
      // decided by the marker property below.
      const cql = `space = "${escapeCqlValue(spaceKey)}" and type = page and title ~ "${E2E_NAME_PREFIX}*"`;
      const results = await client.searchPages(cql, 100);

      const records: E2ePageRecord[] = [];
      for (const result of results) {
        const record: E2ePageRecord = {
          id: result.id,
          title: result.title,
          // Left undefined when the API omits it — an unknown space fails the
          // scope guard rather than defaulting into it.
          spaceKey: result.spaceKey ?? "",
        };
        // Only pay a property round-trip for names that could ever be swept.
        if (parseE2eTitle(result.title)) {
          record.runId = await this.getPageProperty(result.id, E2E_RUN_ID_PROPERTY);
        }
        records.push(record);
      }
      return records;
    },
  };
}

/** Build a REST-backed Jira port for live E2E resource handling. */
export function createJiraPort(profile: Profile): E2eJiraPort {
  const client = new JiraClient(profile);
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");
  const apiPath = jiraApiPath(profile);

  const propertyHeaders = (): Record<string, string> => ({
    Authorization: buildAuthHeader(profile),
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  const propertyUrl = (issueKey: string, key: string): string =>
    `${baseUrl}${apiPath}/issue/${encodeURIComponent(issueKey)}/properties/${encodeURIComponent(key)}`;

  return {
    async createIssue(input) {
      const issue = await client.createIssue({
        fields: {
          project: { key: input.projectKey },
          issuetype: { name: input.issueType },
          summary: input.summary,
        },
      });
      return { id: issue.id, key: issue.key };
    },

    async deleteIssue(issueKey) {
      await client.deleteIssue(issueKey);
    },

    async setIssueProperty(issueKey, key, value) {
      const response = await fetch(propertyUrl(issueKey, key), {
        method: "PUT",
        headers: propertyHeaders(),
        body: JSON.stringify(encodeRunId(value)),
      });
      if (!response.ok) {
        throw new Error(`Failed to set issue property ${key} on ${issueKey}: HTTP ${response.status}`);
      }
    },

    async getIssueProperty(issueKey, key) {
      const response = await fetch(propertyUrl(issueKey, key), { headers: propertyHeaders() });
      if (!response.ok) return undefined;
      const data = (await readJson(response)) as { value?: unknown } | undefined;
      return decodeRunId(data?.value);
    },

    async listIssues(projectKey) {
      const jql = `project = "${projectKey.replace(/"/g, '\\"')}" AND summary ~ "${E2E_NAME_PREFIX}" ORDER BY created ASC`;
      const issues: E2eIssueRecord[] = [];

      // Token pagination: keep going while the server hands back a next token.
      let nextPageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const page = await client.search(jql, {
          maxResults: 100,
          fields: ["summary", "project"],
          nextPageToken,
        });
        for (const issue of page.issues) {
          const record: E2eIssueRecord = {
            key: issue.key,
            summary: issue.fields.summary,
            projectKey: issue.fields.project?.key ?? "",
          };
          if (parseE2eTitle(issue.fields.summary)) {
            record.runId = await this.getIssueProperty(issue.key, E2E_RUN_ID_PROPERTY);
          }
          issues.push(record);
        }
        nextPageToken = page.nextPageToken;
        if (nextPageToken) {
          if (seenTokens.has(nextPageToken)) {
            throw new Error(`Jira pagination loop: token ${nextPageToken} repeated`);
          }
          seenTokens.add(nextPageToken);
        }
      } while (nextPageToken);

      return issues;
    },
  };
}

/**
 * `@atlcli/export-macros` ports over the real Confluence/Jira REST clients.
 *
 * These are the adapters every host needs and none should own: they translate
 * `ConfluenceClient` / `JiraClient` calls into the pure port contracts the macro
 * resolver consumes, and translate client errors into the resolver's tagged
 * `PortError` vocabulary. Nothing here knows about a CLI flag, a browser tab, a
 * Forge context, or an auth mechanism — the caller supplies an already-built
 * client, so a token profile (CLI) and a session profile (extension) produce
 * identical ports.
 *
 * `@atlcli/export-macros` itself cannot host this: `src/deps.ts` keeps that
 * package at ZERO runtime imports from any `@atlcli/*` package, and these
 * adapters must import `@atlcli/confluence`.
 */
import { escapeCqlValue, type ConfluenceClient } from "@atlcli/confluence";
// `jiraStatusColor` is a renderer helper (not a frozen v1 seam) — spec 009
// review C1 trimmed it out of the `.` barrel; reach it via ./internal.
import { jiraStatusColor } from "@atlcli/export-macros/internal";
import {
  portError,
  type AttachmentLookupPort,
  type AttachmentMeta,
  type ConfluenceContentPort,
  type ExportViewPort,
  type JiraIssuePort,
  type JiraIssueRef,
  type PortErrorKind,
} from "@atlcli/export-macros";

/**
 * The slice of `JiraClient` the Jira port drives, expressed structurally.
 *
 * Structural rather than `import type { JiraClient } from "@atlcli/jira"` for
 * two reasons: `@atlcli/jira`'s barrel re-exports the Bun-native webhook server
 * (so a type import would drag a non-isomorphic module into every host's type
 * graph), and a host that has no `@atlcli/jira` dependency at all can still
 * satisfy this interface. A real `JiraClient` instance is assignable with no
 * cast — `packages/export-wiring/src/ports.test.ts` pins that.
 */
export interface JiraClientLike {
  getIssue(keyOrId: string, options?: { fields?: string[]; expand?: string }): Promise<JiraIssueLike>;
  search(
    jql: string,
    options?: { maxResults?: number; fields?: string[]; expand?: string; nextPageToken?: string }
  ): Promise<{ issues: JiraIssueLike[] }>;
}

/** The fields the Jira renderer reads off an issue (subset of `JiraIssue`). */
export interface JiraIssueLike {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { colorName?: string } } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    priority?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    created?: string;
    updated?: string;
    duedate?: string | null;
    labels?: string[];
  };
}

/** Parse the leading `(NNN)` status code out of a client's generic error. */
function statusOf(err: unknown): number | undefined {
  const m = (err instanceof Error ? err.message : String(err)).match(/\((\d{3})\)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Map a client error onto the resolver's tagged `PortError` vocabulary. Always
 * throws. Hosts with a richer taxonomy (e.g. the extension's session-expiry
 * latch) wrap their ports instead of replacing this.
 */
export function classifyClientError(err: unknown, service: string): never {
  const status = statusOf(err);
  let kind: PortErrorKind = "network";
  if (status === 403 || status === 401) kind = "permission";
  else if (status === 404) kind = "not-found";
  else if (status === 429) kind = "rate-limited";
  throw portError(kind, err instanceof Error ? err.message : String(err), { service, cause: err });
}

/** Best-effort extra-column values for a JQL table (beyond key/summary/status). */
function extraFields(issue: JiraIssueLike): Record<string, string> {
  const f = issue.fields;
  const out: Record<string, string> = {};
  if (f.assignee) out.assignee = f.assignee.displayName ?? "";
  if (f.reporter) out.reporter = f.reporter.displayName ?? "";
  if (f.priority) out.priority = f.priority.name ?? "";
  if (f.created) out.created = f.created;
  if (f.updated) out.updated = f.updated;
  if (f.duedate) out.duedate = f.duedate;
  if (f.labels) out.labels = f.labels.join(", ");
  if (f.issuetype) {
    out.type = f.issuetype.name ?? "";
    // Datasource tables name this column `issuetype` (the Jira provider's own
    // schema key), the legacy `jira` macro names it `type`. Both vocabularies
    // reach the same value here rather than one of them rendering blank cells.
    out.issuetype = out.type;
  }
  return out;
}

/**
 * Map a Jira issue onto the `JiraIssueRef` the renderers consume.
 *
 * Exported because a host that needs its OWN error handling around the same
 * calls (the extension's session-expiry latch, say) still needs this exact
 * mapping — browse URL, status colour, and the extra JQL-table columns — and a
 * second copy of it is how the two hosts start rendering different tables.
 */
export function jiraIssueRef(issue: JiraIssueLike, browseBaseUrl: string): JiraIssueRef {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    statusColor: jiraStatusColor(issue.fields.status?.statusCategory?.colorName),
    url: `${browseBaseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    fields: extraFields(issue),
  };
}

export function jiraIssuePortFromClient(
  client: JiraClientLike,
  browseBaseUrl: string
): JiraIssuePort {
  const toRef = (issue: JiraIssueLike): JiraIssueRef => jiraIssueRef(issue, browseBaseUrl);
  return {
    async getIssue(key) {
      try {
        return toRef(await client.getIssue(key));
      } catch (err) {
        classifyClientError(err, "jira");
      }
    },
    async searchJql(jql, opts) {
      try {
        const res = await client.search(jql, { maxResults: opts.maximumIssues });
        return res.issues.slice(0, opts.maximumIssues).map(toRef);
      } catch (err) {
        classifyClientError(err, "jira");
      }
    },
  };
}

export function confluenceContentPortFromClient(client: ConfluenceClient): ConfluenceContentPort {
  const fetchStorage = async (id: string) => {
    try {
      const page = await client.getPage(id);
      return { id: page.id, version: page.version ?? 1, storage: page.storage };
    } catch (err) {
      classifyClientError(err, "confluence");
    }
  };
  return {
    async getPageStorage(title, spaceKey) {
      try {
        // `title`/`spaceKey` come from MACRO PARAMETERS (page-editor-controlled,
        // a different trust boundary than CLI flags or panel input) — escape
        // through the same escapeCqlValue every other CQL builder uses, never
        // raw interpolation.
        const cql = spaceKey
          ? `type=page AND space="${escapeCqlValue(spaceKey)}" AND title="${escapeCqlValue(title)}"`
          : `type=page AND title="${escapeCqlValue(title)}"`;
        const results = await client.searchPages(cql, 1);
        if (results.length === 0) return undefined;
        return fetchStorage(results[0].id);
      } catch (err) {
        classifyClientError(err, "confluence");
      }
    },
    async getPageStorageById(id) {
      return fetchStorage(id);
    },
    async getChildren(pageId, opts) {
      try {
        // getChildrenWithPosition (the child-page endpoint), NOT the CQL-based
        // client.getChildren: CQL indexing lags (e2e-observed: a freshly
        // created child page was missing on first export, present on retry)
        // and has no position guarantee. This endpoint returns real UI order
        // with no indexing lag (pagination fixed by 002).
        const children = await client.getChildrenWithPosition(pageId, {
          limit: opts?.limit ?? 100,
        });
        // getChildrenWithPosition drains EVERY page (its `limit` is only the
        // per-request page size); slice to the port contract's cap so the
        // renderer's limit+1 truncation probe keeps working.
        const cap = opts?.limit ?? 100;
        return children.slice(0, cap).map((c) => ({ id: c.id, title: c.title }));
      } catch (err) {
        classifyClientError(err, "confluence");
      }
    },
    async searchCql(cql, opts) {
      try {
        const results = await client.searchPages(cql, opts?.limit ?? 25);
        return results.map((r) => ({ id: r.id, title: r.title }));
      } catch (err) {
        classifyClientError(err, "confluence");
      }
    },
  };
}

export function exportViewPortFromClient(client: ConfluenceClient): ExportViewPort {
  return {
    async renderMacroHtml(pageId, macroId) {
      try {
        // Batch: one export_view fetch per page, matched by data-macro-id.
        const macros = await client.getExportViewMacros(pageId);
        return macros.get(macroId);
      } catch (err) {
        classifyClientError(err, "exportView");
      }
    },
  };
}

export function attachmentLookupFromClient(client: ConfluenceClient): AttachmentLookupPort {
  const listings = new Map<
    string,
    Promise<Awaited<ReturnType<ConfluenceClient["listAttachments"]>>>
  >();
  return {
    async lookup(pageId, filename): Promise<AttachmentMeta | undefined> {
      try {
        let listing = listings.get(pageId);
        if (!listing) {
          listing = client.listAttachments(pageId);
          listings.set(pageId, listing);
        }
        const found = (await listing).find((a) => a.filename === filename);
        if (!found) return undefined;
        return {
          filename: found.filename,
          version: found.version,
          ...(found.modified ? { modified: found.modified } : {}),
        };
      } catch (err) {
        classifyClientError(err, "confluence");
      }
    },
  };
}

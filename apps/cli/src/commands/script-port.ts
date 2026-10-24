import { ConfluenceClient, markdownToStorage, storageToMarkdown } from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";
import { findTransition, JiraClient, type JiraIssue, toJiraRichText } from "@atlcli/jira";
import type { JiraIssueView, ScriptPort } from "@atlcli/script-runtime";

/** A port whose clients are created on first use: a Confluence-only script never builds a Jira client. */
export function createLazyCliScriptPort(profile: Profile): ScriptPort {
  return createCliScriptPort(once(() => new JiraClient(profile)), once(() => new ConfluenceClient(profile)), profile.baseUrl);
}

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

/**
 * ScriptPort over the CLI's REST clients: paging, retries and Markdown ↔
 * Storage/ADF conversion are the clients' and converters' existing behaviour.
 */
export function createCliScriptPort(jira: () => JiraClient, confluence: () => ConfluenceClient, baseUrl: string): ScriptPort {
  const conversion = { baseUrl };
  const richText = (markdown: string) => toJiraRichText(jira(), markdown);

  return {
    async jiraSearch(jql, { fields, pageToken, maxResults, signal }) {
      const page = await jira().search(jql, {
        fields: withUpdated(fields),
        maxResults,
        ...(pageToken ? { nextPageToken: pageToken } : {}),
        signal,
      });
      return { issues: page.issues.map(issueView), ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    },
    async jiraGetIssue(key, { fields, signal }) {
      return issueView(await jira().getIssue(key, { fields: withUpdated(fields), signal }));
    },
    async jiraGetTransitions(key) {
      return (await jira().getTransitions(key)).map((t) => t.name);
    },
    async jiraCreateIssue({ project, type, summary, description, fields }) {
      const issue = await jira().createIssue({
        fields: {
          ...fields,
          project: { key: project },
          issuetype: { name: type },
          summary,
          ...(description !== undefined ? { description: richText(description) } : {}),
        },
      });
      return { id: issue.id, key: issue.key };
    },
    async jiraUpdateIssue(key, { summary, description, fields }) {
      await jira().updateIssue(key, {
        fields: {
          ...fields,
          ...(summary !== undefined ? { summary } : {}),
          ...(description !== undefined ? { description: richText(description) } : {}),
        },
      });
    },
    async jiraTransitionIssue(key, name) {
      const transitions = await jira().getTransitions(key);
      const transition = findTransition(transitions, name);
      if (!transition) {
        throw new Error(`Transition "${name}" is not available for ${key} (available: ${transitions.map((t) => t.name).join(", ") || "none"})`);
      }
      await jira().transitionIssue(key, { transition: { id: transition.id } });
    },
    async jiraAddComment(key, markdown) {
      const comment = await jira().addComment(key, richText(markdown));
      return { id: String(comment.id) };
    },

    async confluenceSearch(cql, { cursor, limit, signal }) {
      const start = cursor ? Number(cursor) : 0;
      const page = await confluence().search(cql, { limit, start, detail: "minimal", signal });
      return {
        results: page.results.map((r) => ({ id: r.id, title: r.title, spaceKey: r.spaceKey ?? "" })),
        ...(page.hasMore ? { nextCursor: String(start + page.results.length) } : {}),
      };
    },
    async confluenceGetPage(id, { signal }) {
      const page = await confluence().getPage(id, { signal });
      return {
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? "",
        version: page.version ?? 1,
        ...(page.parentId ? { parentId: page.parentId } : {}),
        markdown: storageToMarkdown(page.storage, conversion),
      };
    },
    async confluenceFindPage(spaceKey, title, { signal }) {
      const matches = (await confluence().findPagesByTitle(title, { spaceKey, signal }))
        .filter((p) => p.title === title)
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (matches.length === 0) return null;
      const page = await confluence().getPage(matches[0]!.id, { signal });
      return { id: page.id, version: page.version ?? 1 };
    },
    async confluenceCreatePage({ spaceKey, title, markdown, parentId }) {
      const page = await confluence().createPage({
        spaceKey,
        title,
        storage: markdownToStorage(markdown, conversion),
        ...(parentId ? { parentId } : {}),
      });
      return { id: page.id, version: page.version ?? 1 };
    },
    async confluenceUpdatePage({ id, title, markdown, version }) {
      const page = await confluence().updatePage({ id, title, storage: markdownToStorage(markdown, conversion), version: version + 1 });
      return { id: page.id, version: page.version ?? version + 1 };
    },
    async confluenceAddLabels(pageId, labels) {
      await confluence().addLabels(pageId, labels);
    },
  };
}

/** `updated` is the precondition basis, so it is always fetched. */
function withUpdated(fields: string[] | undefined): string[] | undefined {
  if (!fields) return undefined;
  return fields.includes("updated") || fields.includes("*all") || fields.includes("*navigable") ? fields : [...fields, "updated"];
}

function issueView(issue: JiraIssue): JiraIssueView {
  const fields = (issue.fields ?? {}) as unknown as Record<string, unknown> & { updated?: string };
  return { id: issue.id, key: issue.key, fields: { ...fields, updated: String(fields.updated ?? "") } };
}

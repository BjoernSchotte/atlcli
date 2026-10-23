/**
 * Jira remote links that point at Confluence pages. Shared by
 * `jira issue link-page`, `jira bulk link-page`, `wiki page link-issue` and
 * `wiki page tasks-to-issues`, so every path writes the same globalId (which
 * `unlink-page --page` and the reverse lookups rely on) and the same comment.
 */
import { buildConfluenceUrl, type Profile } from "@atlcli/core";
import { toJiraRichText, type AdfDocument, type CreateRemoteLinkInput, type JiraClient } from "@atlcli/jira";

export interface LinkedConfluencePage {
  id: string;
  title: string;
  url: string;
  spaceKey?: string;
}

export function confluencePageGlobalId(pageId: string): string {
  return `atlcli-confluence-${pageId}`;
}

export function buildConfluencePageRemoteLink(profile: Profile, page: LinkedConfluencePage): CreateRemoteLinkInput {
  return {
    globalId: confluencePageGlobalId(page.id),
    application: { type: "com.atlassian.confluence", name: "Confluence" },
    relationship: "mentioned in",
    object: {
      url: page.url,
      title: page.title,
      summary: page.spaceKey ? `Space: ${page.spaceKey}` : undefined,
      icon: { url16x16: buildConfluenceUrl(profile, "/favicon.ico"), title: "Confluence Page" },
    },
  };
}

/** "Linked to Confluence page: <link>" as Markdown with a real link (not literal wiki markup). */
function linkedPageCommentMarkdown(page: LinkedConfluencePage): string {
  const title = page.title.replace(/[\\[\]]/g, "\\$&");
  const url = page.url.replace(/[()\s]/g, encodeURIComponent);
  return `Linked to Confluence page: [${title}](${url})`;
}

/**
 * The Markdown a link command's `--comment` posts: its text when it has one,
 * the standard link comment for a bare switch, nothing without the flag.
 */
export function linkPageCommentText(
  flag: string | boolean | string[] | undefined,
  page: LinkedConfluencePage
): string | undefined {
  if (flag === undefined || flag === false) return undefined;
  const text = Array.isArray(flag) ? flag[0] : flag;
  return typeof text === "string" && text.trim() ? text : linkedPageCommentMarkdown(page);
}

/** `--comment` as a request body for `addComment`, or undefined without the flag. */
export function linkPageComment(
  client: JiraClient,
  flag: string | boolean | string[] | undefined,
  page: LinkedConfluencePage
): AdfDocument | string | undefined {
  const text = linkPageCommentText(flag, page);
  return text === undefined
    ? undefined
    : toJiraRichText(client, text, { onWarning: (message) => process.stderr.write(`Warning: ${message}\n`) });
}

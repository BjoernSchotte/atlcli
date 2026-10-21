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

/** "Linked to Confluence page: <link>" as a real link (not literal wiki markup). */
export function linkedPageComment(client: JiraClient, page: LinkedConfluencePage): AdfDocument | string {
  const title = page.title.replace(/[\\[\]]/g, "\\$&");
  const url = page.url.replace(/[()\s]/g, encodeURIComponent);
  return toJiraRichText(client, `Linked to Confluence page: [${title}](${url})`);
}

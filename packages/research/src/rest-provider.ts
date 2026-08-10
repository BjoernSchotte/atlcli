import type { Profile } from "@atlcli/core";
import {
  JiraClient,
  type JiraTransportEvent,
} from "@atlcli/jira/browser";
import {
  ConfluenceClient,
  type ConfluenceTransportEvent,
} from "@atlcli/confluence/research";
import {
  ResearchContractError,
  type ResearchRequestV1,
} from "./contracts.js";
import type {
  ResearchReadProviders,
  JiraResearchSummary,
  WikiResearchSummary,
} from "./broker.js";
import { ResearchCapabilityBroker } from "./broker.js";
import { ResearchRunBudget } from "./budget.js";
import {
  projectConfluenceStorage,
  projectJiraDescription,
  appendBoundedDetailLinks,
  appendBoundedDetailProjection,
  prependBoundedDetailText,
  type ContentProjectionLimits,
} from "./content-projection.js";
import { navigateConfluenceDocumentV1 } from "./document-navigation.js";

export interface RestResearchProviderOptions {
  /**
   * Node-only live-test escape hatch. The packed extension must leave this
   * false so only its active browser session can authenticate.
   */
  allowProfileAuth?: boolean;
}

function assertBoundProfile(
  profile: Profile,
  request: ResearchRequestV1,
  options: RestResearchProviderOptions
): void {
  let profileOrigin: string;
  try {
    profileOrigin = new URL(profile.baseUrl).origin;
  } catch {
    throw new ResearchContractError("not-atlassian", "The active Atlassian site is invalid.");
  }
  if (
    (!options.allowProfileAuth && profile.auth.type !== "session") ||
    profileOrigin !== request.scope.siteOrigin
  ) {
    throw new ResearchContractError(
      "access-denied",
      "The active Atlassian session does not match the research site."
    );
  }
}

function projectionLimits(request: ResearchRequestV1): ContentProjectionLimits {
  return {
    maxTextChars: request.limits.maxBodyCharsPerItem,
    maxTextBytes: request.limits.maxBodyCharsPerItem * 4,
    maxLinks: 100,
    maxNodes: 20_000,
    maxDepth: 64,
  };
}

function boundedMetadataValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((value) => value.slice(0, 255)))].sort((left, right) => left.localeCompare(right, "en-US"));
}

const MAX_DETAIL_RELATION_IDS = 100;
const MAX_DETAIL_COMMENTS = 20;
const MAX_DETAIL_COMMENT_REQUESTS = 8;

interface BoundedRelationIds {
  values: string[];
  truncated: boolean;
}

function validJiraIssueKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}$/i.test(value);
}

function jiraIssueUrl(siteOrigin: string, issueKey: string): string {
  return `${siteOrigin}/browse/${encodeURIComponent(issueKey)}`;
}

function sameTenantWikiUrl(value: string, siteOrigin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value, siteOrigin);
  } catch {
    return undefined;
  }
  if (
    url.origin !== siteOrigin ||
    !/^\/wiki\/spaces\/[^/]+\/pages\/\d+(?:\/.*)?$/i.test(url.pathname)
  ) {
    return undefined;
  }
  url.hash = "";
  return url.href;
}

function jiraRemoteWikiLinks(
  links: Awaited<ReturnType<JiraClient["getRemoteLinks"]>>,
  siteOrigin: string,
): BoundedRelationIds {
  const values = [...new Set(links
    .map((link) => sameTenantWikiUrl(link.object.url, siteOrigin))
    .filter((url): url is string => url !== undefined))]
    .sort((left, right) => left.localeCompare(right, "en-US"));
  return {
    values: values.slice(0, MAX_DETAIL_RELATION_IDS),
    truncated: values.length > MAX_DETAIL_RELATION_IDS,
  };
}

function jiraRelationKeys(issue: Awaited<ReturnType<JiraClient["getIssue"]>>): BoundedRelationIds {
  const keys = [
    issue.fields.parent?.key,
    ...(issue.fields.subtasks ?? []).map((subtask) => subtask.key),
    ...(issue.fields.issuelinks ?? []).flatMap((link) => [
      link.inwardIssue?.key,
      link.outwardIssue?.key,
    ]),
  ].filter(validJiraIssueKey)
    .map((key) => key.toLocaleUpperCase("en-US"));
  const values = [...new Set(keys)].sort((left, right) => left.localeCompare(right, "en-US"));
  return {
    values: values.slice(0, MAX_DETAIL_RELATION_IDS),
    truncated: values.length > MAX_DETAIL_RELATION_IDS,
  };
}

function wikiAncestorIds(page: Awaited<ReturnType<ConfluenceClient["getPageDetails"]>>): BoundedRelationIds {
  const values = [...new Set((page.ancestors ?? [])
    .map((ancestor) => ancestor.id)
    .filter((id): id is string => /^[1-9][0-9]{0,127}$/.test(id)))];
  return {
    values: values.slice(0, MAX_DETAIL_RELATION_IDS),
    truncated: values.length > MAX_DETAIL_RELATION_IDS,
  };
}

function projectJiraComments(
  issue: Awaited<ReturnType<JiraClient["getIssue"]>>,
  siteOrigin: string,
  limits: ContentProjectionLimits,
) {
  const available = issue.fields.comment?.comments ?? [];
  const selected = available.slice(0, MAX_DETAIL_COMMENTS);
  const total = issue.fields.comment?.total ?? available.length;
  const capturedCount = selected.length;
  let projection = projectJiraDescription(undefined, siteOrigin, limits);
  for (const [index, comment] of selected.entries()) {
    const body = projectJiraDescription(comment.body, siteOrigin, limits);
    projection = appendBoundedDetailProjection(
      projection,
      prependBoundedDetailText(body, `Comment ${index + 1}:`, limits),
      limits,
    );
  }
  return {
    projection: {
      ...projection,
      truncated: projection.truncated || total > capturedCount || available.length > capturedCount,
    },
    summary: capturedCount > 0
      ? total > capturedCount
        ? `Comments: ${capturedCount} of ${total} captured`
        : `Comments: ${capturedCount} captured`
      : undefined,
  };
}

function projectWikiInlineComments(
  result: Awaited<ReturnType<ConfluenceClient["listPageInlineCommentsForExport"]>>,
  siteOrigin: string,
  limits: ContentProjectionLimits,
) {
  const flattened: Array<{ body: string; status: string }> = [];
  const visit = (comment: (typeof result.comments)[number]): void => {
    flattened.push({ body: comment.body, status: comment.status });
    for (const reply of comment.replies) visit(reply);
  };
  for (const comment of result.comments) visit(comment);

  let projection = projectConfluenceStorage("", siteOrigin, limits);
  for (const [index, comment] of flattened.entries()) {
    const body = projectConfluenceStorage(comment.body, siteOrigin, limits);
    projection = appendBoundedDetailProjection(
      projection,
      prependBoundedDetailText(
        body,
        `Inline comment ${index + 1} (${comment.status}):`,
        limits,
      ),
      limits,
    );
  }
  return {
    projection: {
      ...projection,
      truncated: projection.truncated || !result.complete,
    },
    summary: result.complete
      ? `Inline comments: ${flattened.length} captured`
      : `Inline comments: ${flattened.length} captured (partial)`,
  };
}

function detailPrefix(input: {
  summary?: string;
  status?: string;
  labels?: readonly string[];
  relationLabel?: string;
  relationIds?: readonly string[];
  commentSummary?: string;
}): string {
  return [
    input.summary ? `Summary: ${input.summary}` : undefined,
    input.status ? `Status: ${input.status}` : undefined,
    boundedMetadataValues(input.labels).length > 0
      ? `Labels: ${boundedMetadataValues(input.labels).join(", ")}`
      : undefined,
    input.relationLabel && input.relationIds && input.relationIds.length > 0
      ? `${input.relationLabel}: ${input.relationIds.join(", ")}`
      : undefined,
    input.commentSummary,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function guardTransport(
  budget: ResearchRunBudget
): (event: JiraTransportEvent | ConfluenceTransportEvent) => void {
  return (event) => {
    if (event.type === "attempt") budget.guardTransport({ type: "attempt" });
    else if (event.type === "response") {
      budget.guardTransport({
        type: "response",
        responseBytes: event.responseBytes,
      });
    }
  };
}

/**
 * Product clients adapted to the neutral broker contract.
 *
 * This factory is the only place that knows REST/JQL/CQL client APIs. The
 * broker and QuickJS-facing contracts remain provider-neutral.
 */
export function createRestResearchProviders(
  profile: Profile,
  request: ResearchRequestV1,
  budget: ResearchRunBudget,
  options: RestResearchProviderOptions = {}
): ResearchReadProviders {
  assertBoundProfile(profile, request, options);
  const guard = guardTransport(budget);
  const jira = new JiraClient(profile, { guardTransport: guard });
  const wiki = new ConfluenceClient(profile, { guardTransport: guard });
  const limits = projectionLimits(request);

  return {
    jira: {
      async searchPage(input) {
        const result = await jira.search(input.jql, {
          maxResults: input.pageSize,
          fields: ["summary", "description", "project", "status", "updated", "labels"],
          nextPageToken: input.providerCursor,
          signal: input.signal,
        });
        return {
          items: result.issues.map(
            (issue): JiraResearchSummary => {
              const description = projectJiraDescription(
                issue.fields.description,
                request.scope.siteOrigin,
                limits
              ).text.slice(0, 1_600);
              const excerpt = [
                issue.fields.status?.name
                  ? `Status: ${issue.fields.status.name}`
                  : "",
                description,
              ].filter(Boolean).join(" — ");
              return {
                issueKey: issue.key,
                projectKey: issue.fields.project?.key ?? "",
                title: issue.fields.summary ?? issue.key,
                ...(issue.fields.updated ? { updatedAt: issue.fields.updated } : {}),
                ...(excerpt ? { excerpt } : {}),
              };
            }
          ),
          ...(result.nextPageToken
            ? { nextProviderCursor: result.nextPageToken }
            : {}),
        };
      },
      async getIssue(input) {
        const optionalFields = [
          ...(input.includeMetadata ? ["labels"] : []),
          ...(input.includeComments ? ["comment"] : []),
        ];
        const [issue, remoteLinks] = await Promise.all([
          jira.getIssue(input.issueKey, {
            fields: [
              "summary",
              "description",
              "project",
              "status",
              "updated",
              "parent",
              "subtasks",
              "issuelinks",
              ...optionalFields,
            ],
            signal: input.signal,
          }),
          jira.getRemoteLinks(input.issueKey, { signal: input.signal }),
        ]);
        const description = projectJiraDescription(
          issue.fields.description,
          request.scope.siteOrigin,
          limits
        );
        const relations = jiraRelationKeys(issue);
        const remoteWikiLinks = jiraRemoteWikiLinks(remoteLinks, request.scope.siteOrigin);
        const comments = input.includeComments
          ? projectJiraComments(issue, request.scope.siteOrigin, limits)
          : undefined;
        const detailFields = detailPrefix({
          summary: issue.fields.summary ?? issue.key,
          status: issue.fields.status?.name,
          labels: input.includeMetadata ? issue.fields.labels : undefined,
          relationLabel: "Related issue keys",
          relationIds: relations.values,
          commentSummary: comments?.summary,
        });
        return {
          issueKey: issue.key,
          projectKey: issue.fields.project?.key ?? "",
          title: issue.fields.summary ?? issue.key,
          ...(issue.fields.updated ? { updatedAt: issue.fields.updated } : {}),
          content: appendBoundedDetailLinks(
            comments
              ? appendBoundedDetailProjection(
                  prependBoundedDetailText(description, detailFields, limits),
                  comments.projection,
                  limits,
                )
              : prependBoundedDetailText(description, detailFields, limits),
            [
              ...relations.values.map((issueKey) => jiraIssueUrl(request.scope.siteOrigin, issueKey)),
              ...remoteWikiLinks.values,
            ],
            request.scope.siteOrigin,
            limits,
            relations.truncated || remoteWikiLinks.truncated,
          ),
        };
      },
    },
    wiki: {
      async searchPage(input) {
        const result = input.providerCursor
          ? await wiki.searchNextPage(input.providerCursor, {
              signal: input.signal,
            })
          : await wiki.search(input.cql, {
              limit: input.pageSize,
              detail: "standard",
              signal: input.signal,
            });
        return {
          items: result.results.map(
            (page): WikiResearchSummary => ({
              contentId: page.id,
              spaceKey: page.spaceKey ?? "",
              title: page.title,
              ...(page.lastModified ? { updatedAt: page.lastModified } : {}),
              ...(page.excerpt ? { excerpt: page.excerpt } : {}),
            })
          ),
          ...(result.nextLink ? { nextProviderCursor: result.nextLink } : {}),
        };
      },
      async getPage(input) {
        const page = await wiki.getPageDetails(input.contentId, {
          signal: input.signal,
        });
        const ancestors = input.includeMetadata
          ? wikiAncestorIds(page)
          : { values: [] as string[], truncated: false };
        const inlineComments = input.includeComments
          ? await wiki.listPageInlineCommentsForExport(page.id, {
              signal: input.signal,
              maxInlineComments: MAX_DETAIL_COMMENTS,
              maxRequests: MAX_DETAIL_COMMENT_REQUESTS,
            })
          : undefined;
        const comments = inlineComments
          ? projectWikiInlineComments(inlineComments, request.scope.siteOrigin, limits)
          : undefined;
        const detailFields = detailPrefix({
          labels: input.includeMetadata ? page.labels : undefined,
          relationLabel: "Ancestor page IDs",
          relationIds: ancestors.values,
          commentSummary: comments?.summary,
        });
        if (!Number.isInteger(page.version) || (page.version ?? 0) < 1) {
          throw new Error("Confluence page detail has no verified source version.");
        }
        const navigation = navigateConfluenceDocumentV1({
          representation: "storage",
          value: page.storage,
          sourceVersion: page.version!,
          siteOrigin: request.scope.siteOrigin,
          projectionLimits: limits,
        });
        return {
          contentId: page.id,
          spaceKey: page.spaceKey ?? "",
          title: page.title,
          ...(page.modified ? { updatedAt: page.modified } : {}),
          ...(navigation ? { navigation } : {}),
          content: appendBoundedDetailLinks(
            comments
              ? appendBoundedDetailProjection(
                  prependBoundedDetailText(
                    projectConfluenceStorage(page.storage, request.scope.siteOrigin, limits),
                    detailFields,
                    limits,
                  ),
                  comments.projection,
                  limits,
                )
              : prependBoundedDetailText(
                  projectConfluenceStorage(page.storage, request.scope.siteOrigin, limits),
                  detailFields,
                  limits,
                ),
            page.spaceKey
              ? ancestors.values.map((ancestorId) =>
                  `${request.scope.siteOrigin}/wiki/spaces/${encodeURIComponent(page.spaceKey!)}/pages/${ancestorId}`,
                )
              : [],
            request.scope.siteOrigin,
            limits,
            ancestors.truncated,
          ),
        };
      },
    },
  };
}

export function createRestResearchBroker(
  profile: Profile,
  request: ResearchRequestV1
): ResearchCapabilityBroker {
  const budget = new ResearchRunBudget(request.limits);
  const providers = createRestResearchProviders(profile, request, budget);
  return new ResearchCapabilityBroker(request, providers, { budget });
}

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
  prependBoundedDetailText,
  type ContentProjectionLimits,
} from "./content-projection.js";

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

function detailPrefix(input: {
  summary?: string;
  status?: string;
  labels?: readonly string[];
  relationLabel?: string;
  relationIds?: readonly string[];
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
        const issue = await jira.getIssue(input.issueKey, {
          fields: [
            "summary",
            "description",
            "project",
            "status",
            "updated",
            "labels",
            "parent",
            "subtasks",
            "issuelinks",
          ],
          signal: input.signal,
        });
        const description = projectJiraDescription(
          issue.fields.description,
          request.scope.siteOrigin,
          limits
        );
        const relations = jiraRelationKeys(issue);
        const detailFields = detailPrefix({
          summary: issue.fields.summary ?? issue.key,
          status: issue.fields.status?.name,
          labels: issue.fields.labels,
          relationLabel: "Related issue keys",
          relationIds: relations.values,
        });
        return {
          issueKey: issue.key,
          projectKey: issue.fields.project?.key ?? "",
          title: issue.fields.summary ?? issue.key,
          ...(issue.fields.updated ? { updatedAt: issue.fields.updated } : {}),
          content: appendBoundedDetailLinks(
            prependBoundedDetailText(description, detailFields, limits),
            relations.values.map((issueKey) => jiraIssueUrl(request.scope.siteOrigin, issueKey)),
            request.scope.siteOrigin,
            limits,
            relations.truncated,
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
        const ancestors = wikiAncestorIds(page);
        const detailFields = detailPrefix({
          labels: page.labels,
          relationLabel: "Ancestor page IDs",
          relationIds: ancestors.values,
        });
        return {
          contentId: page.id,
          spaceKey: page.spaceKey ?? "",
          title: page.title,
          ...(page.modified ? { updatedAt: page.modified } : {}),
          content: appendBoundedDetailLinks(
            prependBoundedDetailText(
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

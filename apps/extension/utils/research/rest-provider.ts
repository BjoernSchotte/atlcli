import type { Profile } from "@atlcli/core";
import {
  JiraClient,
  type JiraTransportEvent,
} from "@atlcli/jira/browser";
import {
  ConfluenceClient,
  type ConfluenceTransportEvent,
} from "@atlcli/confluence/browser";
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
          fields: ["summary", "project", "status", "updated"],
          nextPageToken: input.providerCursor,
          signal: input.signal,
        });
        return {
          items: result.issues.map(
            (issue): JiraResearchSummary => ({
              issueKey: issue.key,
              projectKey: issue.fields.project?.key ?? "",
              title: issue.fields.summary ?? issue.key,
              ...(issue.fields.updated ? { updatedAt: issue.fields.updated } : {}),
              ...(issue.fields.status?.name
                ? { excerpt: `Status: ${issue.fields.status.name}` }
                : {}),
            })
          ),
          ...(result.nextPageToken
            ? { nextProviderCursor: result.nextPageToken }
            : {}),
        };
      },
      async getIssue(input) {
        const issue = await jira.getIssue(input.issueKey, {
          fields: ["summary", "description", "project", "status", "updated"],
          signal: input.signal,
        });
        return {
          issueKey: issue.key,
          projectKey: issue.fields.project?.key ?? "",
          title: issue.fields.summary ?? issue.key,
          ...(issue.fields.updated ? { updatedAt: issue.fields.updated } : {}),
          content: projectJiraDescription(
            issue.fields.description,
            request.scope.siteOrigin,
            limits
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
        return {
          contentId: page.id,
          spaceKey: page.spaceKey ?? "",
          title: page.title,
          ...(page.modified ? { updatedAt: page.modified } : {}),
          content: projectConfluenceStorage(
            page.storage,
            request.scope.siteOrigin,
            limits
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

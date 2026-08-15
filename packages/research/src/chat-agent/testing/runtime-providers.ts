import type { ResearchReadProviders } from "../../broker.js";
import { navigateConfluenceStorageV1 } from "../../document-navigation.js";
import type {
  ChatRuntimeFixtureV1,
  ChatRuntimeSourceFixtureV1,
} from "./runtime-fixtures.js";

export interface ChatRuntimeProviderObservationV1 {
  discoveredSourceIds: Set<string>;
  detailedSourceIds: Set<string>;
  calls: Array<{
    product: "jira" | "confluence";
    operation: "search" | "detail";
    sourceId?: string;
    page?: number;
  }>;
  responseBytes: number;
}

function pageForCursor(cursor?: string): number {
  if (!cursor) return 1;
  const match = /^page:([1-9][0-9]*)$/u.exec(cursor);
  if (!match) throw new Error("Synthetic provider cursor is invalid.");
  return Number(match[1]);
}

function matchingPage(
  fixture: ChatRuntimeFixtureV1,
  product: ChatRuntimeSourceFixtureV1["product"],
  page: number,
): ChatRuntimeSourceFixtureV1[] {
  if (fixture.scenarioId === "chat-gold:exact-link-index-miss") return [];
  return fixture.sources.filter((source) =>
    source.product === product && (source.searchPage ?? 1) === page
  );
}

export function createChatRuntimeProvidersV1(fixture: ChatRuntimeFixtureV1): {
  providers: ResearchReadProviders;
  observation: ChatRuntimeProviderObservationV1;
} {
  const observation: ChatRuntimeProviderObservationV1 = {
    discoveredSourceIds: new Set<string>(),
    detailedSourceIds: new Set<string>(),
    calls: [],
    responseBytes: 0,
  };
  const record = <T>(value: T): T => {
    observation.responseBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    return value;
  };
  const source = (id: string): ChatRuntimeSourceFixtureV1 => {
    const found = fixture.sources.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Synthetic provider has no source ${id}.`);
    return found;
  };
  const nextCursor = (
    product: ChatRuntimeSourceFixtureV1["product"],
    page: number,
  ): string | undefined => fixture.sources.some((candidate) =>
    candidate.product === product && (candidate.searchPage ?? 1) > page
  ) ? `page:${page + 1}` : undefined;

  return {
    observation,
    providers: {
      jira: {
        async searchPage({ providerCursor, signal }) {
          signal.throwIfAborted();
          const page = pageForCursor(providerCursor);
          const entries = matchingPage(fixture, "jira", page);
          entries.forEach((entry) => observation.discoveredSourceIds.add(entry.id));
          observation.calls.push({ product: "jira", operation: "search", page });
          return record({
            items: entries.map((entry) => ({
              issueKey: entry.key,
              projectKey: entry.scopeKey,
              title: entry.title,
              updatedAt: entry.updatedAt,
              excerpt: entry.excerpt,
            })),
            ...(nextCursor("jira", page)
              ? { nextProviderCursor: nextCursor("jira", page) }
              : {}),
          });
        },
        async getIssue({ issueKey, signal }) {
          signal.throwIfAborted();
          const entry = source(`jira:${issueKey}`);
          observation.discoveredSourceIds.add(entry.id);
          observation.detailedSourceIds.add(entry.id);
          observation.calls.push({
            product: "jira",
            operation: "detail",
            sourceId: entry.id,
          });
          return record({
            issueKey: entry.key,
            projectKey: entry.scopeKey,
            title: entry.title,
            updatedAt: entry.updatedAt,
            content: {
              text: entry.body,
              linkTargets: [...entry.links],
              truncated: entry.truncated === true,
              inputBytes: new TextEncoder().encode(entry.storage ?? entry.body).byteLength,
            },
          });
        },
      },
      wiki: {
        async searchPage({ providerCursor, signal }) {
          signal.throwIfAborted();
          const page = pageForCursor(providerCursor);
          const entries = matchingPage(fixture, "confluence", page);
          entries.forEach((entry) => observation.discoveredSourceIds.add(entry.id));
          observation.calls.push({ product: "confluence", operation: "search", page });
          return record({
            items: entries.map((entry) => ({
              contentId: entry.key,
              spaceKey: entry.scopeKey,
              title: entry.title,
              updatedAt: entry.updatedAt,
              excerpt: entry.excerpt,
            })),
            ...(nextCursor("confluence", page)
              ? { nextProviderCursor: nextCursor("confluence", page) }
              : {}),
          });
        },
        async getPage({ contentId, signal }) {
          signal.throwIfAborted();
          const entry = source(`wiki:${contentId}`);
          observation.discoveredSourceIds.add(entry.id);
          observation.detailedSourceIds.add(entry.id);
          observation.calls.push({
            product: "confluence",
            operation: "detail",
            sourceId: entry.id,
          });
          return record({
            contentId: entry.key,
            spaceKey: entry.scopeKey,
            title: entry.title,
            updatedAt: entry.updatedAt,
            content: {
              text: entry.body,
              linkTargets: [...entry.links],
              truncated: entry.truncated === true,
              inputBytes: new TextEncoder().encode(entry.storage ?? entry.body).byteLength,
            },
            ...(entry.storage
              ? {
                  navigation: navigateConfluenceStorageV1({
                    storage: entry.storage,
                    sourceVersion: 1,
                    siteOrigin: "https://chat-eval.atlassian.net",
                    projectionLimits: {
                      maxTextChars: 4_000,
                      maxTextBytes: 16_000,
                      maxLinks: 50,
                      maxNodes: 20_000,
                      maxDepth: 64,
                    },
                  }),
                }
              : {}),
          });
        },
      },
    },
  };
}

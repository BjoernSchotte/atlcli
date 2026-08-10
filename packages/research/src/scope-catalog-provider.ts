import type { Profile } from "@atlcli/core";
import { getConfluenceBaseUrl } from "@atlcli/core";
import { JiraClient, type JiraIssue, type JiraProject } from "@atlcli/jira/browser";
import { ConfluenceClient, type ConfluenceSpace } from "@atlcli/confluence/research";
import type {
  ResearchReferenceResolveIntentV1,
} from "@atlcli/research/scope-catalog";
import type {
  ResearchScopeCatalogProviderPageV1,
  ResearchScopeCatalogProvidersV1,
} from "@atlcli/research/scope-catalog-broker";
import type { ResearchScopeCandidateV1 } from "@atlcli/research/scope-discovery";
import { RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1 } from "@atlcli/research/scope-discovery";
import { ResearchContractError } from "@atlcli/research/contracts";
import { classifyResearchError } from "./redaction.js";

export interface RestScopeCatalogProviderOptions {
  /** Browser hosts keep this false so only the bound session can authenticate. */
  allowProfileAuth?: boolean;
  /** Injectable clock for deterministic tests and reproducible evidence. */
  now?: () => string;
}

function tenantOrigin(profile: Profile): string {
  try {
    return new URL(profile.baseUrl).origin;
  } catch {
    throw new ResearchContractError("not-atlassian", "The active Atlassian site is invalid.");
  }
}

function assertBoundProfile(
  profile: Profile,
  expectedTenantOrigin: string,
  options: RestScopeCatalogProviderOptions,
): string {
  const origin = tenantOrigin(profile);
  if (
    origin !== expectedTenantOrigin ||
    (!options.allowProfileAuth && profile.auth.type !== "session")
  ) {
    throw new ResearchContractError(
      "access-denied",
      "The active Atlassian session does not match the research site.",
    );
  }
  return origin;
}

function idPart(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

type ScopeCandidateKind = "project" | "space" | "issue" | "page";

function candidateId(product: "jira" | "confluence", kind: ScopeCandidateKind, key: string): string {
  return `research-scope-candidate:${product}-${kind}-${idPart(key)}`;
}

function entityRef(product: "jira" | "confluence", kind: ScopeCandidateKind, key: string): string {
  return `research-scope-entity:${product}-${kind}-${idPart(key)}`;
}

function currentTimestamp(options: RestScopeCatalogProviderOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

async function safeProviderRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResearchContractError) throw error;
    const classified = classifyResearchError(error);
    throw new ResearchContractError(classified.code, classified.message);
  }
}

async function safeReferenceRead<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await safeProviderRead(operation);
  } catch (error) {
    if (error instanceof ResearchContractError && error.code === "access-denied") {
      return undefined;
    }
    throw error;
  }
}

function compareCandidates(
  left: ResearchScopeCandidateV1,
  right: ResearchScopeCandidateV1,
): number {
  return left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }) ||
    (left.key ?? "").localeCompare(right.key ?? "", "en-US", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id);
}

function projectCandidate(
  project: JiraProject,
  origin: string,
  freshnessAt: string,
): ResearchScopeCandidateV1 {
  const status = project.archived === true ? "archived" : "current";
  return {
    schema: RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1,
    id: candidateId("jira", "project", project.key),
    tenantOrigin: origin,
    product: "jira",
    entityKind: "project",
    entityRef: entityRef("jira", "project", project.key),
    key: project.key,
    name: project.name,
    ...(project.url ? { canonicalUrl: project.url } : {}),
    status,
    accessible: true,
    providerFreshnessAt: freshnessAt,
  };
}

function spaceCandidate(
  space: ConfluenceSpace,
  origin: string,
  freshnessAt: string,
): ResearchScopeCandidateV1 | undefined {
  if (space.status === "trashed") return undefined;
  return {
    schema: RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1,
    id: candidateId("confluence", "space", space.key),
    tenantOrigin: origin,
    product: "confluence",
    entityKind: "space",
    entityRef: entityRef("confluence", "space", space.key),
    key: space.key,
    name: space.name,
    ...(space.aliases?.length ? { aliases: [...space.aliases] } : {}),
    ...(space.url ? { canonicalUrl: space.url } : {}),
    status: space.status === "archived" ? "archived" : "current",
    accessible: true,
    providerFreshnessAt: freshnessAt,
  };
}

function issueCandidate(
  issue: JiraIssue,
  origin: string,
  freshnessAt: string,
): ResearchScopeCandidateV1 {
  const issueKey = issue.key;
  const summary = typeof issue.fields.summary === "string" && issue.fields.summary.trim()
    ? issue.fields.summary.trim()
    : issueKey;
  return {
    schema: RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1,
    id: candidateId("jira", "issue", issueKey),
    tenantOrigin: origin,
    product: "jira",
    entityKind: "issue",
    entityRef: entityRef("jira", "issue", issueKey),
    key: issueKey,
    name: summary,
    accessible: true,
    providerFreshnessAt: freshnessAt,
  };
}

function pageCandidate(
  page: Awaited<ReturnType<ConfluenceClient["getPage"]>>,
  origin: string,
  freshnessAt: string,
): ResearchScopeCandidateV1 {
  return {
    schema: RESEARCH_SCOPE_CANDIDATE_SCHEMA_V1,
    id: candidateId("confluence", "page", page.id),
    tenantOrigin: origin,
    product: "confluence",
    entityKind: "page",
    entityRef: entityRef("confluence", "page", page.id),
    key: page.id,
    name: page.title,
    accessible: true,
    providerFreshnessAt: freshnessAt,
  };
}

function matchesQuery(candidate: ResearchScopeCandidateV1, query: string | undefined): boolean {
  if (!query) return true;
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return true;
  return `${candidate.key ?? ""} ${candidate.name} ${(candidate.aliases ?? []).join(" ")}`
    .toLocaleLowerCase("en-US")
    .includes(normalized);
}

function exactSpaceKeyQuery(value: string | undefined): string | undefined {
  const query = value?.trim();
  return query && /^[A-Za-z0-9~][A-Za-z0-9._~-]{0,254}$/.test(query)
    ? query
    : undefined;
}

function uniqueSpaces(spaces: readonly ConfluenceSpace[]): ConfluenceSpace[] {
  const seen = new Set<string>();
  return spaces.filter((space) => {
    const id = `${space.id}:${space.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function projectOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^jira-projects:(\d+)$/.exec(cursor);
  if (!match) throw new ResearchContractError("invalid-request", "Jira project catalog cursor is invalid.");
  return Number(match[1]);
}

type SpacePhase = "current" | "archived";

function encodeSpaceCursor(phase: SpacePhase, cursor?: string): string {
  return `confluence-spaces:${phase}:${encodeURIComponent(cursor ?? "")}`;
}

function decodeSpaceCursor(cursor: string | undefined): { phase: SpacePhase; cursor?: string } {
  if (!cursor) return { phase: "current" };
  const match = /^confluence-spaces:(current|archived):(.*)$/.exec(cursor);
  if (!match) throw new ResearchContractError("invalid-request", "Confluence space catalog cursor is invalid.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2] ?? "");
  } catch {
    throw new ResearchContractError("invalid-request", "Confluence space catalog cursor is invalid.");
  }
  return { phase: match[1] as SpacePhase, ...(decoded ? { cursor: decoded } : {}) };
}

function jiraProjectKey(reference: URL): string | undefined {
  const match = /^\/(?:plugins\/servlet\/project-config|projects)\/([A-Za-z][A-Za-z0-9_-]*)(?:\/|$)/.exec(reference.pathname);
  return match?.[1];
}

function jiraIssueKey(reference: URL): string | undefined {
  const match = /^\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/.exec(reference.pathname);
  return match?.[1];
}

function confluenceSpaceKey(profile: Profile, reference: URL): string | undefined {
  let basePath: string;
  try {
    basePath = new URL(getConfluenceBaseUrl(profile)).pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  if (basePath && reference.pathname !== basePath && !reference.pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const match = new RegExp(`^${basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:spaces|display)/([^/]+)(?:/|$)`).exec(reference.pathname);
  return match?.[1];
}

function confluencePageId(profile: Profile, reference: URL): string | undefined {
  let basePath: string;
  try {
    basePath = new URL(getConfluenceBaseUrl(profile)).pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  if (basePath && reference.pathname !== basePath && !reference.pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const escapedBasePath = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pageMatch = new RegExp(
    `^${escapedBasePath}/(?:(?:spaces|display)/[^/]+/pages|pages)/(\\d+)(?:/|$)`,
  ).exec(reference.pathname);
  if (pageMatch?.[1]) return pageMatch[1];
  // Cloud blog posts are Confluence content entities and use the same
  // read-only page detail API. Treat their dated URL as an exact page anchor
  // instead of degrading it to a broad space binding.
  return new RegExp(
    `^${escapedBasePath}/spaces/[^/]+/blog/\\d{4}/\\d{2}/\\d{2}/(\\d+)(?:/|$)`,
  ).exec(reference.pathname)?.[1];
}

function referenceCandidate(
  candidate: ResearchScopeCandidateV1,
  reference: string,
): ResearchScopeCandidateV1 {
  return { ...candidate, canonicalUrl: reference, match: "exact_link" };
}

/**
 * Adapt the existing read-only REST clients to the neutral scope catalog port.
 * Provider cursors never cross the broker boundary; the broker wraps them in
 * short-lived opaque cursor references before exposing them to PTC.
 */
export function createRestScopeCatalogProviders(
  profile: Profile,
  expectedTenantOrigin: string,
  options: RestScopeCatalogProviderOptions = {},
): ResearchScopeCatalogProvidersV1 {
  const origin = assertBoundProfile(profile, expectedTenantOrigin, options);
  const jira = new JiraClient(profile);
  const confluence = new ConfluenceClient(profile);

  return {
    jira: {
      async listProjects(input): Promise<ResearchScopeCatalogProviderPageV1> {
        input.signal.throwIfAborted();
        const startAt = projectOffset(input.providerCursor);
        const page = await safeProviderRead(() => jira.listProjects({
          startAt,
          maxResults: Math.min(input.maxCandidates, 50),
          orderBy: "name",
          query: input.query,
          signal: input.signal,
        }));
        const freshnessAt = currentTimestamp(options);
        const candidates = page.values
          .map((project) => projectCandidate(project, origin, freshnessAt))
          .filter((candidate) => input.includeArchived || candidate.status !== "archived")
          .filter((candidate) => matchesQuery(candidate, input.query))
          .sort(compareCandidates);
        const nextStartAt = startAt + page.values.length;
        return {
          candidates,
          ...(nextStartAt < page.total ? { nextProviderCursor: `jira-projects:${nextStartAt}` } : {}),
        };
      },
    },
    confluence: {
      async listSpaces(input): Promise<ResearchScopeCatalogProviderPageV1> {
        input.signal.throwIfAborted();
        const decoded = decodeSpaceCursor(input.providerCursor);
        const exactKey = !decoded.cursor ? exactSpaceKeyQuery(input.query) : undefined;
        const [page, exactPage] = await Promise.all([
          safeProviderRead(() => confluence.listSpacesV2({
            limit: input.maxCandidates,
            cursor: decoded.cursor,
            status: decoded.phase,
            signal: input.signal,
          })),
          exactKey
            ? safeProviderRead(() => confluence.listSpacesV2({
                limit: 1,
                status: decoded.phase,
                keys: [exactKey],
                signal: input.signal,
              }))
            : Promise.resolve(undefined),
        ]);
        const freshnessAt = currentTimestamp(options);
        const candidates = uniqueSpaces([...(exactPage?.spaces ?? []), ...page.spaces])
          .map((space) => spaceCandidate(space, origin, freshnessAt))
          .filter((candidate): candidate is ResearchScopeCandidateV1 => Boolean(candidate))
          .filter((candidate) => input.includeArchived || candidate.status !== "archived")
          .filter((candidate) => matchesQuery(candidate, input.query))
          .sort(compareCandidates);
        const nextProviderCursor = page.nextCursor
          ? encodeSpaceCursor(decoded.phase, page.nextCursor)
          : input.includeArchived && decoded.phase === "current"
            ? encodeSpaceCursor("archived")
            : undefined;
        return {
          candidates,
          ...(nextProviderCursor ? { nextProviderCursor } : {}),
        };
      },
    },
    async resolveReference(input: ResearchReferenceResolveIntentV1 & { signal: AbortSignal }) {
      input.signal.throwIfAborted();
      let reference: URL;
      try {
        reference = new URL(input.reference);
      } catch {
        return undefined;
      }
      if (reference.origin !== origin) return undefined;

      if (input.expectedKinds.includes("project")) {
        const key = jiraProjectKey(reference);
        if (key) {
          const project = await safeReferenceRead(() => jira.getProject(key, { signal: input.signal }));
          if (!project) return undefined;
          return referenceCandidate(projectCandidate(project, origin, currentTimestamp(options)), input.reference);
        }
      }
      if (input.expectedKinds.includes("issue")) {
        const key = jiraIssueKey(reference);
        if (key) {
          const issue = await safeReferenceRead(() => jira.getIssue(key, { signal: input.signal }));
          if (!issue) return undefined;
          if (issue.key.toLocaleUpperCase("en-US") !== key.toLocaleUpperCase("en-US")) {
            throw new ResearchContractError(
              "provider-error",
              "The exact Jira reference did not resolve to its requested issue.",
            );
          }
          return referenceCandidate(issueCandidate(issue, origin, currentTimestamp(options)), input.reference);
        }
      }
      if (input.expectedKinds.includes("space")) {
        const key = confluenceSpaceKey(profile, reference);
        if (key) {
          const space = await safeReferenceRead(() => confluence.getSpace(key, { signal: input.signal }));
          if (!space) return undefined;
          const candidate = spaceCandidate(space, origin, currentTimestamp(options));
          return candidate ? referenceCandidate(candidate, input.reference) : undefined;
        }
      }
      if (input.expectedKinds.includes("page")) {
        const id = confluencePageId(profile, reference);
        if (id) {
          const page = await safeReferenceRead(() => confluence.getPage(id, { signal: input.signal }));
          if (!page) return undefined;
          if (page.id !== id) {
            throw new ResearchContractError(
              "provider-error",
              "The exact Confluence reference did not resolve to its requested page.",
            );
          }
          return referenceCandidate(pageCandidate(page, origin, currentTimestamp(options)), input.reference);
        }
      }
      return undefined;
    },
  };
}

import type { Profile } from "@atlcli/core";
import { getConfluenceBaseUrl } from "@atlcli/core";
import { JiraClient, type JiraProject } from "@atlcli/jira/browser";
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

function candidateId(product: "jira" | "confluence", kind: "project" | "space", key: string): string {
  return `research-scope-candidate:${product}-${kind}-${idPart(key)}`;
}

function entityRef(product: "jira" | "confluence", kind: "project" | "space", key: string): string {
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

function matchesQuery(candidate: ResearchScopeCandidateV1, query: string | undefined): boolean {
  if (!query) return true;
  const normalized = query.trim().toLocaleLowerCase("en-US");
  if (!normalized) return true;
  return `${candidate.key ?? ""} ${candidate.name} ${(candidate.aliases ?? []).join(" ")}`
    .toLocaleLowerCase("en-US")
    .includes(normalized);
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
        const page = await safeProviderRead(() => confluence.listSpacesV2({
          limit: input.maxCandidates,
          cursor: decoded.cursor,
          status: decoded.phase,
          signal: input.signal,
        }));
        const freshnessAt = currentTimestamp(options);
        const candidates = page.spaces
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
      if (input.expectedKinds.includes("space")) {
        const key = confluenceSpaceKey(profile, reference);
        if (key) {
          const space = await safeReferenceRead(() => confluence.getSpace(key, { signal: input.signal }));
          if (!space) return undefined;
          const candidate = spaceCandidate(space, origin, currentTimestamp(options));
          return candidate ? referenceCandidate(candidate, input.reference) : undefined;
        }
      }
      return undefined;
    },
  };
}

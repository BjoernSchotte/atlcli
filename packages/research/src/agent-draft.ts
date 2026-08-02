import { z } from "zod/v4";
import {
  RESEARCH_REPORT_SCHEMA_V1,
  type AtlassianRelationshipV1,
  type ResearchFindingV1,
  type ResearchReportV1,
  type ResearchRequestV1,
  type ResearchRunSummaryV1,
  type ResearchSourceReferenceV1,
} from "./contracts.js";
import type { ResearchDetailEvidenceV1 } from "./broker.js";
import { finalizeResearchReportV1 } from "./report.js";

const boundedText = (maximum: number): z.ZodString =>
  z.string().trim().min(1).max(maximum);

const selectedClaimIdsSchema = z.array(
  boundedText(96).regex(/^claim:[a-f0-9]{48}$/, "Claim ID is invalid."),
).max(8);

export const RESEARCH_AGENT_DRAFT_SCHEMA_V1 = z
  .object({
    title: boundedText(300),
    executiveSummary: boundedText(2_000),
    findings: z
      .array(
        z
          .object({
            classification: z.enum(["fact", "inference"]),
            summary: boundedText(800),
            detail: boundedText(2_000).optional(),
            sourceIds: z.array(boundedText(200)).min(1).max(12),
          })
          .strict()
      )
      .max(12),
    relationships: z
      .array(
        z
          .object({
            classification: z.enum(["verified", "hypothesis"]),
            jiraIssueKey: boundedText(100),
            confluenceContentId: boundedText(200),
            summary: boundedText(800),
            sourceIds: z.array(boundedText(200)).min(1).max(12),
          })
          .strict()
      )
      .max(12),
    limitations: z.array(boundedText(700)).max(12),
    /** Optional in the legacy format; mandatory for dynamic V2 synthesis. */
    selectedClaimIds: selectedClaimIdsSchema.optional(),
  })
  .strict()
  .meta({ title: "AtlcliResearchAgentDraftV1" });

export type ResearchAgentDraftV1 = z.infer<typeof RESEARCH_AGENT_DRAFT_SCHEMA_V1>;

/**
 * JSON-Schema form used by QuickJS dynamic `task()` dispatches. Keeping this
 * next to the authoritative Zod schema prevents the synthesizer and the host
 * finalizer from drifting onto different report contracts.
 */
export const RESEARCH_AGENT_DRAFT_JSON_SCHEMA_V1 = {
  ...z.toJSONSchema(RESEARCH_AGENT_DRAFT_SCHEMA_V1, { target: "draft-7" }),
  title: "AtlcliResearchAgentDraftV1",
} as Record<string, unknown>;

/**
 * Dynamic V2 research needs one further control-plane value: the smallest
 * question-answering set of already host-normalized Claim IDs. It is distinct
 * from the legacy report draft because it never accepts model-authored claim
 * text and cannot point outside the host's claim ledger.
 */
export const RESEARCH_DYNAMIC_AGENT_DRAFT_SCHEMA_V1 = RESEARCH_AGENT_DRAFT_SCHEMA_V1
  .extend({
    selectedClaimIds: selectedClaimIdsSchema,
  })
  .strict()
  .meta({ title: "AtlcliDynamicResearchAgentDraftV1" });

export type ResearchDynamicAgentDraftV1 = z.infer<typeof RESEARCH_DYNAMIC_AGENT_DRAFT_SCHEMA_V1>;

export const RESEARCH_DYNAMIC_AGENT_DRAFT_JSON_SCHEMA_V1 = {
  ...z.toJSONSchema(RESEARCH_DYNAMIC_AGENT_DRAFT_SCHEMA_V1, { target: "draft-7" }),
  title: "AtlcliDynamicResearchAgentDraftV1",
} as Record<string, unknown>;

function uniqueKnownSourceIds(
  sourceIds: readonly string[],
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>
): string[] {
  return [...new Set(sourceIds)].filter((sourceId) => sources.has(sourceId));
}

function hasToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9_-])${escaped}($|[^A-Z0-9_-])`, "i").test(text);
}

function isVerifiedRelationship(
  relationship: ResearchAgentDraftV1["relationships"][number],
  detailEvidence: readonly ResearchDetailEvidenceV1[],
  siteOrigin: string
): boolean {
  const jiraId = `jira:${relationship.jiraIssueKey}`;
  const wikiId = `wiki:${relationship.confluenceContentId}`;
  const evidenceIds = new Set(relationship.sourceIds);
  if (!evidenceIds.has(jiraId) || !evidenceIds.has(wikiId)) return false;

  const jiraEvidence = detailEvidence.find((entry) => entry.source.id === jiraId);
  const wikiEvidence = detailEvidence.find((entry) => entry.source.id === wikiId);
  if (!jiraEvidence || !wikiEvidence) return false;

  const jiraUrl = `${siteOrigin}/browse/${encodeURIComponent(relationship.jiraIssueKey)}`;
  const wikiUrlPrefix = `${siteOrigin}/wiki/`;
  return (
    hasToken(wikiEvidence.content.text, relationship.jiraIssueKey) ||
    wikiEvidence.content.linkTargets.some((target) => target === jiraUrl) ||
    jiraEvidence.content.linkTargets.some(
      (target) =>
        target.startsWith(wikiUrlPrefix) &&
        new URL(target).pathname.split("/").includes(relationship.confluenceContentId)
    )
  );
}

const RELATIONSHIP_STOP_WORDS = new Set([
  "confluence",
  "dokumentation",
  "issue",
  "jira",
  "page",
  "seite",
  "ticket",
  "updated",
  "wurde",
]);

function meaningfulTokens(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (token) => token.length >= 4 && !RELATIONSHIP_STOP_WORDS.has(token)
    )
  );
}

function isPlausibleRelationshipHypothesis(
  relationship: ResearchAgentDraftV1["relationships"][number],
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
  detailEvidence: readonly ResearchDetailEvidenceV1[]
): boolean {
  const jiraId = `jira:${relationship.jiraIssueKey}`;
  const wikiId = `wiki:${relationship.confluenceContentId}`;
  if (
    !relationship.sourceIds.includes(jiraId) ||
    !relationship.sourceIds.includes(wikiId)
  ) {
    return false;
  }
  const jira = sources.get(jiraId);
  const wiki = sources.get(wikiId);
  if (!jira || !wiki) return false;
  const detailById = new Map(
    detailEvidence.map((entry) => [entry.source.id, entry.content.text])
  );
  const jiraTokens = meaningfulTokens(
    `${jira.title}\n${detailById.get(jiraId) ?? ""}`
  );
  const wikiTokens = meaningfulTokens(
    `${wiki.title}\n${detailById.get(wikiId) ?? ""}`
  );
  return [...jiraTokens].some((token) => wikiTokens.has(token));
}

function normalizeRelationships(
  relationships: ResearchAgentDraftV1["relationships"],
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
  detailEvidence: readonly ResearchDetailEvidenceV1[],
  siteOrigin: string
): AtlassianRelationshipV1[] {
  const readableDetailSourceIds = new Set(
    detailEvidence
      .filter(
        (entry) =>
          !entry.content.truncated &&
          (entry.content.text.trim().length > 0 ||
            entry.content.linkTargets.length > 0)
      )
      .map((entry) => entry.source.id)
  );
  const textDetailSourceIds = new Set(
    detailEvidence
      .filter(
        (entry) =>
          !entry.content.truncated && entry.content.text.trim().length > 0
      )
      .map((entry) => entry.source.id)
  );
  const normalized: AtlassianRelationshipV1[] = [];
  for (const relationship of relationships) {
    const sourceIds = uniqueKnownSourceIds(relationship.sourceIds, sources);
    const jiraId = `jira:${relationship.jiraIssueKey}`;
    const wikiId = `wiki:${relationship.confluenceContentId}`;
    if (
      sourceIds.length === 0 ||
      !readableDetailSourceIds.has(jiraId) ||
      !readableDetailSourceIds.has(wikiId)
    ) {
      continue;
    }
    const hostVerified =
      relationship.classification === "verified" &&
      isVerifiedRelationship(relationship, detailEvidence, siteOrigin);
    if (
      !hostVerified &&
      (!textDetailSourceIds.has(jiraId) ||
        !textDetailSourceIds.has(wikiId) ||
      !isPlausibleRelationshipHypothesis(
        relationship,
        sources,
        detailEvidence
      ))
    ) {
      continue;
    }
    normalized.push({
      id: `relationship-${normalized.length + 1}`,
      classification: hostVerified ? "verified" : "hypothesis",
      jiraIssueKey: relationship.jiraIssueKey,
      confluenceContentId: relationship.confluenceContentId,
      summary: relationship.summary,
      sourceIds,
    });
  }
  return normalized;
}

function deriveVerifiedRelationships(
  existing: readonly AtlassianRelationshipV1[],
  detailEvidence: readonly ResearchDetailEvidenceV1[],
  siteOrigin: string,
): AtlassianRelationshipV1[] {
  const readable = detailEvidence.filter(
    (entry) =>
      !entry.content.truncated &&
      (entry.content.text.trim().length > 0 || entry.content.linkTargets.length > 0),
  );
  const jiraEvidence = readable.filter(
    (entry) => entry.source.product === "jira" && entry.source.issueKey,
  );
  const wikiEvidence = readable.filter(
    (entry) => entry.source.product === "confluence" && entry.source.contentId,
  );
  const seen = new Set(
    existing.map(
      (relationship) =>
        `${relationship.jiraIssueKey}:${relationship.confluenceContentId}`,
    ),
  );
  const derived = [...existing];
  for (const jira of jiraEvidence) {
    for (const wiki of wikiEvidence) {
      if (derived.length >= 12) return derived;
      const issueKey = jira.source.issueKey!;
      const contentId = wiki.source.contentId!;
      const key = `${issueKey}:${contentId}`;
      if (seen.has(key)) continue;
      const candidate = {
        classification: "verified" as const,
        jiraIssueKey: issueKey,
        confluenceContentId: contentId,
        summary:
          "Retrieved Jira and Confluence detail evidence contains an explicit cross-reference.",
        sourceIds: [jira.source.id, wiki.source.id],
      };
      if (!isVerifiedRelationship(candidate, readable, siteOrigin)) continue;
      seen.add(key);
      derived.push({
        id: `relationship-${derived.length + 1}`,
        ...candidate,
      });
    }
  }
  return derived;
}

function normalizeFindings(
  findings: ResearchAgentDraftV1["findings"],
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
  detailEvidence: readonly ResearchDetailEvidenceV1[]
): ResearchFindingV1[] {
  const completeDetailSourceIds = new Set(
    detailEvidence
      .filter(
        (entry) =>
          !entry.content.truncated && entry.content.text.trim().length > 0
      )
      .map((entry) => entry.source.id)
  );
  const normalized: ResearchFindingV1[] = [];
  for (const finding of findings) {
    const sourceIds = uniqueKnownSourceIds(finding.sourceIds, sources);
    if (
      sourceIds.length === 0 ||
      sourceIds.some((sourceId) => !completeDetailSourceIds.has(sourceId))
    ) {
      continue;
    }
    normalized.push({
      id: `finding-${normalized.length + 1}`,
      classification: finding.classification,
      summary: finding.summary,
      ...(finding.detail ? { detail: finding.detail } : {}),
      sourceIds,
    });
  }
  return normalized;
}

function evidenceQualityBoundary(
  detailEvidence: readonly ResearchDetailEvidenceV1[],
  run: ResearchRunSummaryV1
): string | undefined {
  const truncatedDetails = detailEvidence.filter(
    (entry) => entry.content.truncated
  ).length;
  const emptyDetails = detailEvidence.filter(
    (entry) =>
      !entry.content.truncated &&
      entry.content.text.trim().length === 0 &&
      entry.content.linkTargets.length === 0
  ).length;
  const linkOnlyDetails = detailEvidence.filter(
    (entry) =>
      !entry.content.truncated &&
      entry.content.text.trim().length === 0 &&
      entry.content.linkTargets.length > 0
  ).length;
  if (
    run.complete &&
    truncatedDetails === 0 &&
    emptyDetails === 0 &&
    linkOnlyDetails === 0
  ) {
    return undefined;
  }

  const qualifications = [
    ...(truncatedDetails > 0
      ? [
          `${truncatedDetails} truncated detail ${truncatedDetails === 1 ? "projection was" : "projections were"} excluded from published findings.`,
        ]
      : []),
    ...(emptyDetails > 0
      ? [
          `${emptyDetails} empty detail ${emptyDetails === 1 ? "response was" : "responses were"} excluded from published findings.`,
        ]
      : []),
    ...(linkOnlyDetails > 0
      ? [
          `${linkOnlyDetails} link-only detail ${linkOnlyDetails === 1 ? "response was" : "responses were"} eligible only for explicit relationship verification, not content findings.`,
        ]
      : []),
    ...(!run.complete
      ? [
          "Candidate screening reached a configured search limit; published findings cite only fully retrieved detail evidence and may not be exhaustive.",
        ]
      : []),
  ];
  return qualifications.join(" ");
}

function evidenceBackedExecutiveSummary(
  findings: readonly ResearchFindingV1[],
  relationships: readonly AtlassianRelationshipV1[]
): string {
  const statements = [
    ...findings.slice(0, 4).map(
      (finding) =>
        `${finding.summary} (${finding.sourceIds.join(", ")})`
    ),
    ...relationships.slice(0, 2).map((relationship) => {
      const label = relationship.classification === "verified"
        ? "Verified relationship"
        : "Relationship hypothesis";
      return `${label}: ${relationship.summary} (${relationship.sourceIds.join(", ")})`;
    }),
  ];
  return statements.length > 0
    ? statements.join("\n\n")
    : "No non-empty, non-truncated detail evidence supported a publishable finding for this run.";
}

function clampText(value: unknown, maximum: number): unknown {
  return typeof value === "string" ? value.slice(0, maximum) : value;
}

function clampProviderDraft(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const draft = input as Record<string, unknown>;
  const clampSourceIds = (value: unknown): unknown => Array.isArray(value)
    ? value.slice(0, 12).map((sourceId) => clampText(sourceId, 200))
    : value;
  const findings = Array.isArray(draft.findings)
    ? draft.findings.slice(0, 12).map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const finding = value as Record<string, unknown>;
        return {
          ...finding,
          summary: clampText(finding.summary, 800),
          ...(finding.detail === undefined ? {} : { detail: clampText(finding.detail, 2_000) }),
          sourceIds: clampSourceIds(finding.sourceIds),
        };
      })
    : draft.findings;
  const relationships = Array.isArray(draft.relationships)
    ? draft.relationships.slice(0, 12).map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const relationship = value as Record<string, unknown>;
        return {
          ...relationship,
          jiraIssueKey: clampText(relationship.jiraIssueKey, 100),
          confluenceContentId: clampText(relationship.confluenceContentId, 200),
          summary: clampText(relationship.summary, 800),
          sourceIds: clampSourceIds(relationship.sourceIds),
        };
      })
    : draft.relationships;
  const limitations = Array.isArray(draft.limitations)
    ? draft.limitations.slice(0, 12).map((value) => clampText(value, 700))
    : draft.limitations;
  const selectedClaimIds = Array.isArray(draft.selectedClaimIds)
    ? draft.selectedClaimIds.slice(0, 8).map((value) => clampText(value, 96))
    : draft.selectedClaimIds;
  return {
    ...draft,
    title: clampText(draft.title, 300),
    executiveSummary: clampText(draft.executiveSummary, 2_000),
    findings,
    relationships,
    limitations,
    ...(selectedClaimIds === undefined ? {} : { selectedClaimIds }),
  };
}

/**
 * Apply provider-bound normalization and then the authoritative host schema at
 * every synthesizer boundary. The provider receives a deliberately narrower
 * JSON Schema, so its result is not trusted until this parser succeeds.
 */
export function parseResearchAgentDraftV1(input: unknown): ResearchAgentDraftV1 {
  return RESEARCH_AGENT_DRAFT_SCHEMA_V1.parse(clampProviderDraft(input));
}

/** Validate the stricter dynamic-synthesis control-plane contract. */
export function parseResearchDynamicAgentDraftV1(input: unknown): ResearchDynamicAgentDraftV1 {
  return RESEARCH_DYNAMIC_AGENT_DRAFT_SCHEMA_V1.parse(clampProviderDraft(input));
}

export function finalizeResearchAgentDraftV1(input: {
  draft: unknown;
  request: ResearchRequestV1;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  run: ResearchRunSummaryV1;
  /** Host-authored limitations, appended after untrusted model draft validation. */
  additionalLimitations?: readonly string[];
}): ResearchReportV1 {
  const draft = parseResearchAgentDraftV1(input.draft);
  const additionalLimitations = (input.additionalLimitations ?? [])
    .filter((limitation): limitation is string =>
      typeof limitation === "string" && limitation.trim().length > 0
    )
    .slice(0, 12)
    .map((limitation) => limitation.slice(0, 700));
  const sources = input.sources.map((source) => ({ ...source }));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const evidenceBoundary = evidenceQualityBoundary(input.detailEvidence, input.run);
  const findings = normalizeFindings(
    draft.findings,
    sourcesById,
    input.detailEvidence
  );
  const relationships = deriveVerifiedRelationships(
    normalizeRelationships(
      draft.relationships,
      sourcesById,
      input.detailEvidence,
      input.request.scope.siteOrigin
    ),
    input.detailEvidence,
    input.request.scope.siteOrigin,
  );
  const citedSourceIds = new Set([
    ...findings.flatMap((finding) => finding.sourceIds),
    ...relationships.flatMap((relationship) => relationship.sourceIds),
  ]);
  const executiveSummary = evidenceBackedExecutiveSummary(
    findings,
    relationships
  );
  const narrative = [executiveSummary, ...draft.limitations].join("\n");
  for (const source of sources) {
    if (
      hasToken(narrative, source.id) ||
      (source.issueKey ? hasToken(narrative, source.issueKey) : false)
    ) {
      citedSourceIds.add(source.id);
    }
  }
  const citedSources = sources.filter((source) => citedSourceIds.has(source.id));
  return finalizeResearchReportV1({
    schema: RESEARCH_REPORT_SCHEMA_V1,
    title: draft.title,
    question: input.request.question,
    scope: input.request.scope,
    executiveSummary,
    findings,
    relationships,
    limitations: [
      ...draft.limitations,
      ...additionalLimitations,
      ...(evidenceBoundary ? [evidenceBoundary] : []),
    ],
    sources: citedSources,
    run: input.run,
  });
}

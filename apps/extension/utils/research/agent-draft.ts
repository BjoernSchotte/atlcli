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

export const RESEARCH_AGENT_DRAFT_SCHEMA_V1 = z
  .object({
    title: boundedText(300),
    executiveSummary: boundedText(4_000),
    findings: z
      .array(
        z
          .object({
            classification: z.enum(["fact", "inference"]),
            summary: boundedText(1_000),
            detail: boundedText(4_000).optional(),
            sourceIds: z.array(boundedText(200)).min(1).max(20),
          })
          .strict()
      )
      .max(50),
    relationships: z
      .array(
        z
          .object({
            classification: z.enum(["verified", "hypothesis"]),
            jiraIssueKey: boundedText(100),
            confluenceContentId: boundedText(200),
            summary: boundedText(1_000),
            sourceIds: z.array(boundedText(200)).min(1).max(20),
          })
          .strict()
      )
      .max(50),
    limitations: z.array(boundedText(1_000)).max(30),
  })
  .strict();

export type ResearchAgentDraftV1 = z.infer<typeof RESEARCH_AGENT_DRAFT_SCHEMA_V1>;

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
  const normalized: AtlassianRelationshipV1[] = [];
  for (const relationship of relationships) {
    const sourceIds = uniqueKnownSourceIds(relationship.sourceIds, sources);
    if (sourceIds.length === 0) continue;
    const hostVerified =
      relationship.classification === "verified" &&
      isVerifiedRelationship(relationship, detailEvidence, siteOrigin);
    if (
      !hostVerified &&
      !isPlausibleRelationshipHypothesis(
        relationship,
        sources,
        detailEvidence
      )
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

function normalizeFindings(
  findings: ResearchAgentDraftV1["findings"],
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
  detailEvidence: readonly ResearchDetailEvidenceV1[]
): ResearchFindingV1[] {
  const truncatedSourceIds = new Set(
    detailEvidence
      .filter((entry) => entry.content.truncated)
      .map((entry) => entry.source.id)
  );
  const normalized: ResearchFindingV1[] = [];
  for (const finding of findings) {
    const sourceIds = uniqueKnownSourceIds(finding.sourceIds, sources);
    if (sourceIds.length === 0) continue;
    const citesTruncatedDetail = sourceIds.some((sourceId) =>
      truncatedSourceIds.has(sourceId)
    );
    const evidenceBoundary = citesTruncatedDetail
      ? "At least one cited detail was truncated; statements about its content apply only to the captured excerpt."
      : undefined;
    const detail = [finding.detail, evidenceBoundary]
      .filter(Boolean)
      .join("\n\n");
    normalized.push({
      id: `finding-${normalized.length + 1}`,
      classification: finding.classification,
      summary: finding.summary,
      ...(detail ? { detail } : {}),
      sourceIds,
    });
  }
  return normalized;
}

function evidenceCoverageBoundary(
  sources: readonly ResearchSourceReferenceV1[],
  detailEvidence: readonly ResearchDetailEvidenceV1[],
  run: ResearchRunSummaryV1
): string | undefined {
  const jiraSources = sources.filter((source) => source.product === "jira");
  const wikiSources = sources.filter(
    (source) => source.product === "confluence"
  );
  const detailedSourceIds = new Set(
    detailEvidence.map((entry) => entry.source.id)
  );
  const detailedJira = jiraSources.filter((source) =>
    detailedSourceIds.has(source.id)
  ).length;
  const detailedWiki = wikiSources.filter((source) =>
    detailedSourceIds.has(source.id)
  ).length;
  const truncatedDetails = detailEvidence.filter(
    (entry) => entry.content.truncated
  ).length;
  const detailCoverageIsPartial =
    detailedJira < jiraSources.length || detailedWiki < wikiSources.length;
  if (run.complete && !detailCoverageIsPartial && truncatedDetails === 0) {
    return undefined;
  }

  const qualifications = [
    `Evidence coverage: ${detailedJira} of ${jiraSources.length} returned Jira items and ${detailedWiki} of ${wikiSources.length} returned Confluence items were read in detail.`,
    ...(truncatedDetails > 0
      ? [`${truncatedDetails} detail projections were truncated.`]
      : []),
    ...(!run.complete ? ["At least one search was incomplete."] : []),
    "Negative content claims apply only to the captured detail evidence.",
  ];
  return qualifications.join(" ");
}

export function finalizeResearchAgentDraftV1(input: {
  draft: unknown;
  request: ResearchRequestV1;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  run: ResearchRunSummaryV1;
}): ResearchReportV1 {
  const draft = RESEARCH_AGENT_DRAFT_SCHEMA_V1.parse(input.draft);
  const sources = input.sources.map((source) => ({ ...source }));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const coverageBoundary = evidenceCoverageBoundary(
    sources,
    input.detailEvidence,
    input.run
  );
  return finalizeResearchReportV1({
    schema: RESEARCH_REPORT_SCHEMA_V1,
    title: draft.title,
    question: input.request.question,
    scope: input.request.scope,
    executiveSummary: [coverageBoundary, draft.executiveSummary]
      .filter(Boolean)
      .join("\n\n"),
    findings: normalizeFindings(
      draft.findings,
      sourcesById,
      input.detailEvidence
    ),
    relationships: normalizeRelationships(
      draft.relationships,
      sourcesById,
      input.detailEvidence,
      input.request.scope.siteOrigin
    ),
    limitations: draft.limitations,
    sources,
    run: input.run,
  });
}

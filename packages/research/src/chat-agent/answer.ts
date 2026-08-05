import type { ResearchDetailEvidenceV1 } from "../broker.js";
import type { ResearchSourceReferenceV1 } from "../contracts.js";
import type { BoundDocumentCoverageIssueV1 } from "../capability-contracts.js";
import type { ChatQualityPolicyV1 } from "../quality-policy.js";
import {
  CHAT_ANSWER_SCHEMA_V1,
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
  type ChatAnswerV1,
  type ChatRunSummaryV1,
} from "./contracts.js";

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/gu, "\\$&");
}

const WHOLE_DOCUMENT_SUBJECT_V1 =
  /\b(?:complete|entire|whole)\s+(?:page|document)|\b(?:gesamte|vollst[aä]ndige|komplette)\s+(?:seite|dokument)\b/iu;
const NEGATIVE_ABSENCE_V1 =
  /\b(?:no|not|none|nothing|without|lacks?|missing|absent|kein(?:e[rmns]?)?|nicht|nichts|ohne|fehlt|fehlen)\b/iu;

function removeUnsupportedWholeDocumentNegativesV1(
  markdown: string,
  hasIncompleteCitedDocument: boolean,
  locale: string | undefined,
  citedLinks: readonly string[],
): string {
  if (!hasIncompleteCitedDocument) return markdown;
  const retained = markdown
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => !(
      WHOLE_DOCUMENT_SUBJECT_V1.test(part) && NEGATIVE_ABSENCE_V1.test(part)
    ));
  const retainedMarkdown = retained.join("\n\n");
  const retainedProse = retainedMarkdown
    .replace(/\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\s+/gu, "")
    .trim();
  if (retainedProse.length > 0) return retainedMarkdown;
  const german = locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
  const sourceSuffix = citedLinks.length > 0 ? ` ${citedLinks.join(" ")}` : "";
  return german
    ? `Der gelesene Inhalt erlaubt keine Aussage darüber, was auf der vollständigen Seite fehlt.${sourceSuffix}`
    : `The content that was read does not establish what is absent from the complete page.${sourceSuffix}`;
}

export function finalizeChatAnswerV1(input: {
  draft: unknown;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  qualityPolicy: ChatQualityPolicyV1;
  run: ChatRunSummaryV1;
  locale?: string;
}): ChatAnswerV1 {
  const parsed = CHAT_AGENT_DRAFT_SCHEMA_V1.safeParse(input.draft);
  if (!parsed.success) {
    throw new ChatContractError("invalid-report", "The Chat answer did not match the required contract.");
  }
  const draft: ChatAgentDraftV1 = parsed.data;
  const detailedIds = new Set(input.detailEvidence.map((entry) => entry.source.id));
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const citationIds = [...new Set(draft.citationSourceIds)];
  for (const sourceId of citationIds) {
    if (!detailedIds.has(sourceId) || !sourceById.has(sourceId)) {
      throw new ChatContractError("invalid-report", "The Chat answer cites a source that was not read in detail.");
    }
  }
  for (const gap of draft.gaps) {
    if (gap.sourceIds.some((sourceId) => !sourceById.has(sourceId))) {
      throw new ChatContractError("invalid-report", "The Chat answer gap references unknown evidence.");
    }
  }
  const citedCoverage = new Map<string, {
    complete: boolean;
    incomplete: boolean;
    unreadSections: number;
    sourceTruncated: boolean;
    outlineTruncated: boolean;
    issues: Set<BoundDocumentCoverageIssueV1>;
  }>();
  for (const evidence of input.detailEvidence) {
    if (!citationIds.includes(evidence.source.id)) continue;
    const current = citedCoverage.get(evidence.source.id) ?? {
      complete: false,
      incomplete: false,
      unreadSections: Number.POSITIVE_INFINITY,
      sourceTruncated: false,
      outlineTruncated: false,
      issues: new Set<BoundDocumentCoverageIssueV1>(),
    };
    const complete = evidence.coverage?.completeDocumentRead === true ||
      (!evidence.coverage && !evidence.content.truncated);
    citedCoverage.set(evidence.source.id, {
      complete: current.complete || complete,
      incomplete: current.incomplete || !complete,
      unreadSections: Math.min(
        current.unreadSections,
        evidence.coverage?.unreadSections ?? (evidence.content.truncated ? 1 : 0),
      ),
      sourceTruncated: current.sourceTruncated || evidence.coverage?.sourceTruncated === true,
      outlineTruncated: current.outlineTruncated || evidence.coverage?.outlineTruncated === true,
      issues: new Set([
        ...current.issues,
        ...(evidence.coverage?.issues ?? []),
      ]),
    });
  }
  const gaps = draft.gaps.map((gap) => ({ ...gap, sourceIds: [...gap.sourceIds] }));
  const hostCoverageNotices: string[] = [];
  for (const [sourceId, coverage] of citedCoverage) {
    if (coverage.complete || !coverage.incomplete) continue;
    const disclosed = draft.gaps.some((gap) =>
      gap.sourceIds.includes(sourceId) &&
      (gap.code === "truncated-source" || gap.code === "incomplete-coverage"),
    );
    if (disclosed) continue;
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const unread = Number.isFinite(coverage.unreadSections)
      ? Math.max(0, coverage.unreadSections)
      : 0;
    const message = coverage.issues.has("unresolved_include")
      ? german
        ? "Mindestens ein eingebundener Confluence-Inhalt wurde nicht aufgelöst. Aussagen gelten nur für den direkt gelesenen Seiteninhalt."
        : "At least one included Confluence item was not resolved. Claims apply only to the directly read page content."
      : coverage.issues.has("unsupported_structure")
        ? german
          ? "Mindestens eine Seitenstruktur konnte nicht vollständig interpretiert werden. Aussagen gelten nur für den lesbar projizierten Inhalt."
          : "At least one page structure could not be interpreted completely. Claims apply only to the readable projected content."
        : coverage.issues.has("source_limit") || coverage.issues.has("parse_budget") ||
            coverage.sourceTruncated || coverage.outlineTruncated
      ? german
        ? "Die Quelle oder ihre Gliederung konnte nur teilweise verarbeitet werden. Aussagen gelten ausschließlich für den gelesenen Inhalt."
        : "The source or its outline could only be processed partially. Claims apply only to the content that was read."
      : german
        ? `${unread} weitere Seitenabschnitte wurden nicht im Detail gelesen.`
        : `${unread} additional page sections were not read in detail.`;
    gaps.push({
      code: coverage.sourceTruncated || coverage.issues.has("source_limit")
        ? "truncated-source"
        : "incomplete-coverage",
      message,
      sourceIds: [sourceId],
    });
    hostCoverageNotices.push(message);
  }
  let messageMarkdown = draft.messageMarkdown.trim();
  const placeholderIds = [...messageMarkdown.matchAll(/\[\[source:([^\]]+)\]\]/gu)]
    .map((match) => match[1]!);
  if (placeholderIds.some((sourceId) => !citationIds.includes(sourceId))) {
    throw new ChatContractError("invalid-report", "The Chat answer contains an unsupported citation placeholder.");
  }
  if (citationIds.some((sourceId) => !placeholderIds.includes(sourceId))) {
    throw new ChatContractError("invalid-report", "The Chat answer omitted a declared citation placeholder.");
  }
  for (const sourceId of citationIds) {
    const source = sourceById.get(sourceId)!;
    const placeholder = `[[source:${sourceId}]]`;
    const canonical = `[${escapeMarkdownLabel(source.title)}](${source.url})`;
    messageMarkdown = messageMarkdown.split(placeholder).join(canonical);
  }
  const incompleteCitedDocument = [...citedCoverage.values()].some((coverage) =>
    coverage.incomplete && !coverage.complete
  );
  messageMarkdown = removeUnsupportedWholeDocumentNegativesV1(
    messageMarkdown,
    incompleteCitedDocument,
    input.locale,
    citationIds.map((sourceId) => {
      const source = sourceById.get(sourceId)!;
      return `[${escapeMarkdownLabel(source.title)}](${source.url})`;
    }),
  );
  if (hostCoverageNotices.length > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    messageMarkdown += `\n\n> **${german ? "Abdeckungsgrenze" : "Coverage limit"}:** ${hostCoverageNotices.join(" ")}`;
  }
  if (messageMarkdown.length === 0 || messageMarkdown.length > 24_000) {
    throw new ChatContractError("limit-exceeded", "The Chat answer exceeds its bounded Markdown size.");
  }
  const reasonCode = input.qualityPolicy.mode === "quick"
    ? "quick-direct"
    : input.qualityPolicy.mode === "deep"
      ? "deep-direct"
      : "auto-direct";
  return {
    schema: CHAT_ANSWER_SCHEMA_V1,
    messageMarkdown,
    citations: citationIds.map((sourceId) => {
      const source = sourceById.get(sourceId)!;
      return {
        sourceId,
        title: source.title,
        url: source.url,
        product: source.product,
      };
    }),
    evidenceRefs: citationIds,
    gaps,
    strategy: {
      qualityMode: input.qualityPolicy.mode,
      path: "direct",
      delegated: false,
      reasonCode,
    },
    ...(draft.continuation ? { continuation: { ...draft.continuation } } : {}),
    run: structuredClone(input.run),
  };
}

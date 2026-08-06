import type {
  ResearchDetailEvidenceV1,
  ResearchReadSectionReferenceV1,
} from "../broker.js";
import type { ResearchSourceReferenceV1 } from "../contracts.js";
import type { BoundDocumentCoverageIssueV1 } from "../capability-contracts.js";
import type { ChatQualityPolicyV1 } from "../quality-policy.js";
import type {
  ChatQualityDispositionV1,
} from "./quality.js";
import { chatFinalGapCodeForQualityDefectV1 } from "./quality.js";
import {
  CHAT_ANSWER_SCHEMA_V1,
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
  type ChatAnswerV1,
  type ChatRunSummaryV1,
} from "./contracts.js";
import type {
  ChatStrategyDecisionV1,
  ChatStrategyReviewV1,
} from "./strategy.js";

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/gu, "\\$&");
}

interface ChatEvidencePlaceholderV1 {
  raw: string;
  sourceId: string;
  sectionId?: string;
}

function chatEvidencePlaceholdersV1(markdown: string): ChatEvidencePlaceholderV1[] {
  return [...markdown.matchAll(/\[\[source:([^\]#]+)(?:#([^\]]+))?\]\]/gu)].map((match) => ({
    raw: match[0],
    sourceId: match[1]!,
    ...(match[2] ? { sectionId: match[2] } : {}),
  }));
}

function lineHasSourcePlaceholderV1(line: string, sourceId: string): boolean {
  return chatEvidencePlaceholdersV1(line).some((placeholder) => placeholder.sourceId === sourceId);
}

/** Confluence Cloud's copied heading links use the heading with whitespace replaced by hyphens. */
function confluenceSectionUrlV1(url: string, heading: string): string {
  const fragment = heading.trim().replace(/\s+/gu, "-");
  return `${url.split("#", 1)[0]}#${encodeURIComponent(fragment)}`;
}

const WHOLE_DOCUMENT_SUBJECT_V1 =
  /\b(?:complete|entire|whole)\s+(?:page|document)|\b(?:gesamte|vollst[aä]ndige|komplette)\s+(?:seite|dokument)\b/iu;
const NEGATIVE_ABSENCE_V1 =
  /\b(?:no|not|none|nothing|without|lacks?|missing|absent|kein(?:e[rmns]?)?|nicht|nichts|ohne|fehlt|fehlen)\b/iu;
const ATLASSIAN_PRODUCT_SUBJECT_V1 =
  /\b(?:jira|confluence|issues?|tickets?|vorg[aä]nge?|arbeitselemente?|wiki-?seiten?|pages?)\b/iu;
const JIRA_CLAIM_SUBJECT_V1 =
  /\b(?:jira|issues?|tickets?|vorg[aä]nge?|arbeitselemente?|[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*)\b/iu;
const CONFLUENCE_CLAIM_SUBJECT_V1 =
  /\b(?:confluence|wiki-?seiten?|pages?|spaces?)\b/iu;
const JIRA_ISSUE_KEY_V1 = /\b[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*\b/gu;
const RELATIONSHIP_SECTION_V1 =
  /\b(?:comparison|relationship|mapping|agreement|contradiction|gap|vergleich|beziehung|zuordnung|übereinstimmung|widerspruch|lücke)\b/iu;
const DOCUMENTATION_ABSENCE_SUBJECT_V1 =
  /\b(?:documentation|documented|guide|instructions?|reference|configuration|setup|authentication|versioning|upgrade|environment variables?|api tokens?|dokumentiert|(?:dokumentations?|installations?|konfigurations?|authentifizierungs?|versionierungs?)[a-zäöüß-]*|anleitung|referenz|setup|upgrade|umgebungsvariablen|api-?token|befehle?)\b/iu;
const RETRIEVAL_GAP_SUBJECT_V1 =
  /\b(?:search|retrieval|candidate|coverage|index|suche|abruf|kandidat|abdeckung|suchindex)\b/iu;

function removeUnsupportedWholeDocumentNegativesV1(
  markdown: string,
  hasIncompleteCitedDocument: boolean,
  locale: string | undefined,
  citedLinks: readonly string[],
): string {
  if (!hasIncompleteCitedDocument) return markdown;
  let removed = false;
  const retainedMarkdown = markdown
    .split("\n")
    .map((line) => {
      if (!(WHOLE_DOCUMENT_SUBJECT_V1.test(line) && NEGATIVE_ABSENCE_V1.test(line))) {
        return line;
      }
      const retainedSentences = line
        .split(/(?<=[.!?])\s+/u)
        .filter((sentence) => {
          const unsupported = WHOLE_DOCUMENT_SUBJECT_V1.test(sentence) &&
            NEGATIVE_ABSENCE_V1.test(sentence);
          removed ||= unsupported;
          return !unsupported;
        });
      return retainedSentences.join(" ");
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!removed) return markdown;
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

function downgradeIncompleteScopeAbsenceClaimsV1(
  markdown: string,
  locale: string | undefined,
): { markdown: string; downgradedClaims: number } {
  const german = locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
  let downgradedClaims = 0;
  const replace = (
    value: string,
    pattern: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ): string => value.replace(pattern, (...args: string[]) => {
    downgradedClaims += 1;
    return typeof replacement === "string"
      ? replacement
      : replacement(args[0]!, ...args.slice(1));
  });
  const lines = markdown.split("\n").map((line) => {
    let scoped = line;
    if (german) {
      scoped = replace(
        scoped,
        /\b(?:Im|In dem)\s+[^.!?\n|]{0,80}?\b(?:Space|Projekt)\s+(?:existiert|gibt es)\s+(kein(?:e[rmns]?)?)\s+([^.!?\n|]+)([.!?]?)/giu,
        (_match, article, subject, punctuation) =>
          `In den detailliert gelesenen Quellen wurde ${article} ${subject.trim()} gefunden${punctuation}`,
      );
      scoped = replace(
        scoped,
        /\bNicht\s+vorhanden\s+im\s+(?:gesamten\s+)?(?:Space|Projekt)\b/giu,
        "In den detailliert gelesenen Quellen nicht gefunden",
      );
    } else {
      scoped = replace(
        scoped,
        /\bNo\s+([^.!?\n|]+?)\s+(?:exists?|is present)\s+in\s+(?:the\s+)?[^.!?\n|]{0,80}?\b(?:space|project)\b/giu,
        (_match, subject) => `No ${subject.trim()} was found in the sources read in detail`,
      );
      scoped = replace(
        scoped,
        /\bNot\s+present\s+in\s+(?:the\s+)?(?:whole\s+|entire\s+)?(?:space|project)\b/giu,
        "Not found in the sources read in detail",
      );
    }
    return scoped;
  });
  return { markdown: lines.join("\n"), downgradedClaims };
}

function markdownHeadingV1(line: string): { level: number; text: string } | undefined {
  const match = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
  return match ? { level: match[1]!.length, text: match[2]! } : undefined;
}

function removeUnsupportedMissingProductClaimsV1(
  markdown: string,
  missingProducts: readonly ("jira" | "confluence")[],
): string {
  if (missingProducts.length === 0) return markdown;
  const missingJira = missingProducts.includes("jira");
  const missingConfluence = missingProducts.includes("confluence");
  const isMissingProductSubject = (value: string): boolean =>
    (missingJira && JIRA_CLAIM_SUBJECT_V1.test(value)) ||
    (missingConfluence && CONFLUENCE_CLAIM_SUBJECT_V1.test(value));
  let relationshipSection = false;
  let suppressedSectionLevel: number | undefined;
  return markdown
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      const heading = markdownHeadingV1(trimmed);
      if (heading) {
        if (
          suppressedSectionLevel !== undefined &&
          heading.level > suppressedSectionLevel
        ) {
          return false;
        }
        suppressedSectionLevel = undefined;
        if (isMissingProductSubject(heading.text)) {
          suppressedSectionLevel = heading.level;
          return false;
        }
        relationshipSection = RELATIONSHIP_SECTION_V1.test(heading.text);
        return true;
      }
      if (suppressedSectionLevel !== undefined) return false;
      // Search excerpts and candidate titles can carry plausible-looking issue
      // keys. Without one detailed read for that product, none may survive as
      // a factual answer claim, even when phrased positively.
      if (isMissingProductSubject(trimmed)) return false;
      if (!NEGATIVE_ABSENCE_V1.test(trimmed)) return true;
      if (ATLASSIAN_PRODUCT_SUBJECT_V1.test(trimmed)) return false;
      // A bare "none found" directly below a comparison/relationship heading
      // is still an unsupported product-absence claim when the required
      // product yielded no detailed evidence.
      return !relationshipSection;
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function missingProductNoticeV1(
  product: "jira" | "confluence",
  german: boolean,
): string {
  const label = product === "jira" ? "Jira" : "Confluence";
  return german
    ? `Die ausgeführten ${label}-Abrufe lieferten keine detailliert gelesenen ${label}-Belege. Das belegt weder, dass im gebundenen Umfang keine passenden Inhalte existieren, noch dass die Suche vollständig war.`
    : `The attempted ${label} retrieval produced no detailed ${label} evidence. This does not establish that the bound scope contains no matching content or that discovery was complete.`;
}

function requiredQualityGapNoticeV1(
  code: ChatAgentDraftV1["gaps"][number]["code"],
  german: boolean,
): string {
  if (code === "no-detail-evidence") {
    return german
      ? "Mindestens eine im Qualitätscheck erkannte Aussage ließ sich mit den detailliert gelesenen Quellen nicht ausreichend belegen und wurde nicht als gesichert behandelt."
      : "At least one claim identified by the quality check lacked sufficient detail evidence and was not treated as established.";
  }
  if (code === "unresolved-reference") {
    return german
      ? "Mindestens ein Quellenbezug blieb im Qualitätscheck ungeklärt und wurde nicht als gesicherter Beleg verwendet."
      : "At least one source reference remained unresolved during quality review and was not used as established evidence.";
  }
  return german
    ? "Der unabhängige Qualitätscheck hat eine verbleibende Abdeckungsgrenze festgestellt; die Antwort gilt nur für die tatsächlich detailliert gelesenen Quellen."
    : "The independent quality check found a remaining coverage limit; the answer applies only to the sources that were actually read in detail.";
}

function removeUncitedJiraKeyLinesV1(
  markdown: string,
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
): { markdown: string; removedLines: number } {
  let removedLines = 0;
  const lines = markdown.split("\n").filter((line) => {
    const issueKeys = [...line.matchAll(JIRA_ISSUE_KEY_V1)].map((match) => match[0]!);
    if (issueKeys.length === 0) return true;
    const supported = issueKeys.every((issueKey) =>
      [...sources.values()].some((source) =>
        source.product === "jira" &&
        source.issueKey === issueKey &&
        lineHasSourcePlaceholderV1(line, source.id)
      )
    );
    if (!supported) removedLines += 1;
    return supported;
  });
  return {
    markdown: lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
    removedLines,
  };
}

function removeUncitedDocumentationAbsenceLinesV1(
  markdown: string,
): { markdown: string; removedLines: number } {
  let removedLines = 0;
  const lines = markdown.split("\n").filter((line) => {
    const unsupported = NEGATIVE_ABSENCE_V1.test(line) &&
      DOCUMENTATION_ABSENCE_SUBJECT_V1.test(line) &&
      !RETRIEVAL_GAP_SUBJECT_V1.test(line) &&
      chatEvidencePlaceholdersV1(line).length === 0;
    if (unsupported) removedLines += 1;
    return !unsupported;
  });
  return {
    markdown: lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
    removedLines,
  };
}

function correctRetrievalCountLanguageV1(
  markdown: string,
  retrieval: NonNullable<ChatRunSummaryV1["retrieval"]>,
  german: boolean,
): string {
  const detail = retrieval.detailReadCandidates;
  const admitted = retrieval.admittedCandidates;
  if (german) {
    return markdown
      .replace(
        new RegExp(`\\binsgesamt\\s+${detail}\\s+Seiten\\s+gefunden`, "giu"),
        `${detail} Seiten im Detail gelesen`,
      )
      .replace(
        new RegExp(`\\bDa die Suche auf maximal\\s+${detail}\\s+Seiten begrenzt war`, "giu"),
        `Da ${detail} von ${admitted} zugelassenen Kandidaten im Detail gelesen wurden`,
      );
  }
  return markdown
    .replace(
      new RegExp(`\\ba total of\\s+${detail}\\s+pages were found`, "giu"),
      `${detail} pages were read in detail`,
    )
    .replace(
      new RegExp(`\\bBecause the search was limited to\\s+${detail}\\s+pages`, "giu"),
      `Because ${detail} of ${admitted} admitted candidates were read in detail`,
    );
}

export function finalizeChatAnswerV1(input: {
  draft: unknown;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  readSectionReferences?: readonly ResearchReadSectionReferenceV1[];
  qualityPolicy: ChatQualityPolicyV1;
  strategyDecision?: ChatStrategyDecisionV1;
  strategyReview?: ChatStrategyReviewV1;
  qualityDisposition?: ChatQualityDispositionV1;
  delegated?: boolean;
  run: ChatRunSummaryV1;
  locale?: string;
}): ChatAnswerV1 {
  const parsed = CHAT_AGENT_DRAFT_SCHEMA_V1.safeParse(input.draft);
  if (!parsed.success) {
    throw new ChatContractError("invalid-report", "The Chat answer did not match the required contract.");
  }
  const draft: ChatAgentDraftV1 = parsed.data;
  const detailedIds = new Set(input.detailEvidence.map((entry) => entry.source.id));
  const rejectedIds = new Set(input.qualityDisposition?.rejectedSourceIds ?? []);
  const pageDetailedIds = new Set(
    input.detailEvidence
      .filter((entry) => entry.section === undefined)
      .map((entry) => entry.source.id),
  );
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  let messageMarkdown = draft.messageMarkdown.trim();
  const sectionReferenceByKey = new Map<string, ResearchReadSectionReferenceV1>([
    ...input.detailEvidence.flatMap((entry) => entry.section
      ? [[`${entry.source.id}#${entry.section.sectionId}`, {
          sourceId: entry.source.id,
          sectionId: entry.section.sectionId,
          heading: entry.section.heading,
          order: entry.section.order,
        }] as const]
      : []),
    ...(input.readSectionReferences ?? []).map((entry) => [
      `${entry.sourceId}#${entry.sectionId}`,
      { ...entry },
    ] as const),
  ]);
  const proposedPlaceholders = chatEvidencePlaceholdersV1(messageMarkdown);
  const downgradedSectionPlaceholders = proposedPlaceholders.filter((placeholder) =>
    placeholder.sectionId !== undefined &&
    pageDetailedIds.has(placeholder.sourceId) &&
    sourceById.has(placeholder.sourceId) &&
    !sectionReferenceByKey.has(`${placeholder.sourceId}#${placeholder.sectionId}`)
  );
  for (const placeholder of downgradedSectionPlaceholders) {
    messageMarkdown = messageMarkdown
      .split(placeholder.raw)
      .join(`[[source:${placeholder.sourceId}]]`);
  }
  const unsupportedPlaceholders = proposedPlaceholders.filter((placeholder) =>
    !detailedIds.has(placeholder.sourceId) ||
    rejectedIds.has(placeholder.sourceId) ||
    !sourceById.has(placeholder.sourceId) ||
    (placeholder.sectionId !== undefined &&
      !pageDetailedIds.has(placeholder.sourceId) &&
      !sectionReferenceByKey.has(`${placeholder.sourceId}#${placeholder.sectionId}`))
  );
  const unsupportedPlaceholderKeys = [...new Set(unsupportedPlaceholders.map((entry) => entry.raw))];
  if (unsupportedPlaceholderKeys.length > 0) {
    messageMarkdown = messageMarkdown
      .split("\n")
      .filter((line) => !unsupportedPlaceholderKeys.some((placeholder) =>
        line.includes(placeholder)
      ))
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
  }
  const jiraClaimProjection = removeUncitedJiraKeyLinesV1(
    messageMarkdown,
    sourceById,
  );
  messageMarkdown = jiraClaimProjection.markdown;
  const documentationAbsenceProjection = removeUncitedDocumentationAbsenceLinesV1(
    messageMarkdown,
  );
  messageMarkdown = documentationAbsenceProjection.markdown;
  const citationPlaceholders = chatEvidencePlaceholdersV1(messageMarkdown);
  const citationIds = [...new Set(citationPlaceholders.map((entry) => entry.sourceId))];
  const citationKeys = [...new Set(citationPlaceholders.map((entry) =>
    entry.sectionId ? `${entry.sourceId}#${entry.sectionId}` : entry.sourceId
  ))];
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
  const retrieval = input.run.retrieval;
  const incompleteRetrieval = retrieval !== undefined &&
    retrieval.admittedCandidates > 0 && (
    retrieval.deferredCandidates > 0 ||
    retrieval.detailReadCandidates < retrieval.admittedCandidates ||
    retrieval.detailReadCoverage < 1 ||
    (retrieval.observedRecall !== null && retrieval.observedRecall < 1)
  );
  if (downgradedSectionPlaceholders.length > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const sourceIds = [...new Set(
      downgradedSectionPlaceholders.map((entry) => entry.sourceId),
    )];
    const notice = german
      ? `${downgradedSectionPlaceholders.length} Abschnittsverweis war nicht separat detailgelesen und wurde deshalb als Seitenbeleg dargestellt.`
      : `${downgradedSectionPlaceholders.length} section reference was not read separately and was therefore presented as a page-level citation.`;
    gaps.push({
      code: "unresolved-reference",
      message: notice,
      sourceIds,
    });
  }
  if (unsupportedPlaceholderKeys.length > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const notice = german
      ? `${unsupportedPlaceholderKeys.length} nicht detailbelegte Aussage wurde aus der Antwort entfernt.`
      : `${unsupportedPlaceholderKeys.length} claim without detailed evidence was removed from the answer.`;
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
    hostCoverageNotices.push(notice);
  }
  if (jiraClaimProjection.removedLines > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const notice = german
      ? `${jiraClaimProjection.removedLines} Jira-Zuordnung ohne gleichzeiligen Detailbeleg wurde aus der Antwort entfernt.`
      : `${jiraClaimProjection.removedLines} Jira mapping without a same-line detail citation was removed from the answer.`;
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
    hostCoverageNotices.push(notice);
  }
  if (documentationAbsenceProjection.removedLines > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const notice = german
      ? `${documentationAbsenceProjection.removedLines} Negativbehauptungen über fehlende Dokumentation ohne zeilengleichen Detailbeleg wurden aus der Antwort entfernt.`
      : `${documentationAbsenceProjection.removedLines} documentation-absence claims without a same-line detail citation were removed from the answer.`;
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
    hostCoverageNotices.push(notice);
  }
  if (incompleteRetrieval) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    messageMarkdown = correctRetrievalCountLanguageV1(
      messageMarkdown,
      retrieval,
      german,
    );
    const scopedAbsence = downgradeIncompleteScopeAbsenceClaimsV1(
      messageMarkdown,
      input.locale,
    );
    messageMarkdown = scopedAbsence.markdown;
    const notice = german
      ? `${retrieval.detailReadCandidates} von ${retrieval.admittedCandidates} zugelassenen Kandidaten wurden im Detail gelesen. Aussagen über nicht gefundene Inhalte gelten deshalb nur für die detailliert gelesenen Quellen.`
      : `${retrieval.detailReadCandidates} of ${retrieval.admittedCandidates} admitted candidates were read in detail. Claims about content not found therefore apply only to the sources read in detail.`;
    if (!gaps.some((gap) => gap.message === notice)) {
      gaps.push({
        code: "incomplete-coverage",
        message: notice,
        sourceIds: [],
      });
    }
    hostCoverageNotices.push(notice);
  }
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
  for (const placeholder of citationPlaceholders) {
    const source = sourceById.get(placeholder.sourceId)!;
    const section = placeholder.sectionId
      ? sectionReferenceByKey.get(`${placeholder.sourceId}#${placeholder.sectionId}`)
      : undefined;
    const label = section?.heading ?? source.title;
    const url = section
      ? confluenceSectionUrlV1(source.url, section.heading)
      : source.url;
    const canonical = `[${escapeMarkdownLabel(label)}](${url})`;
    messageMarkdown = messageMarkdown.split(placeholder.raw).join(canonical);
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
  const missingProducts = input.strategyReview
    ? ([
        ...(input.strategyReview.unmetCapabilityClasses.includes("jira-discovery")
          ? ["jira" as const]
          : []),
        ...(input.strategyReview.unmetCapabilityClasses.includes("confluence-discovery")
          ? ["confluence" as const]
          : []),
      ])
    : [];
  messageMarkdown = removeUnsupportedMissingProductClaimsV1(
    messageMarkdown,
    missingProducts,
  );
  const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
  if (messageMarkdown.replace(/^#+\s.*$/gmu, "").trim().length === 0) {
    messageMarkdown = german
      ? "Für diese Antwort blieb keine detailbelegte Aussage übrig."
      : "No detail-backed claim remained for this answer.";
  }
  for (const product of missingProducts) {
    const notice = missingProductNoticeV1(product, german);
    if (!gaps.some((gap) => gap.message === notice)) {
      gaps.push({
        code: "incomplete-coverage",
        message: notice,
        sourceIds: [],
      });
    }
    hostCoverageNotices.push(notice);
  }
  if (hostCoverageNotices.length > 0) {
    messageMarkdown += `\n\n> **${german ? "Abdeckungsgrenze" : "Coverage limit"}:** ${hostCoverageNotices.join(" ")}`;
  }
  const fallbackReason = input.qualityPolicy.mode === "quick"
    ? "quick-direct" as const
    : input.detailEvidence.length === 0
      ? "no-atlassian-acquisition" as const
      : "single-exact-context" as const;
  const strategyDecision: ChatStrategyDecisionV1 = input.strategyDecision ?? {
    schema: "atlcli.chat-strategy-decision/v1",
    qualityMode: input.qualityPolicy.mode,
    execution: "direct",
    reasonCodes: [fallbackReason],
    ambiguityDisposition: "none",
    requiredCapabilities: [
      ...(input.detailEvidence.length > 0 ? ["exact-read" as const] : []),
      "chat-answer" as const,
    ],
    expectedComplexity: "simple",
    qualityRisks: [],
  };
  if (strategyDecision.qualityMode !== input.qualityPolicy.mode) {
    throw new ChatContractError(
      "invalid-report",
      "The accepted Chat strategy does not match the quality policy.",
    );
  }
  if (strategyDecision.execution === "agentic") {
    if (!input.strategyReview) {
      throw new ChatContractError(
        "invalid-report",
        "An agentic Chat answer requires a host evidence-gap review.",
      );
    }
    if (!input.qualityDisposition) {
      throw new ChatContractError(
        "invalid-report",
        "An agentic Chat answer requires the independent quality disposition.",
      );
    }
    const missingRequiredGaps = input.qualityDisposition.requiredGapCodes.filter((code) => {
      const expected = chatFinalGapCodeForQualityDefectV1(code);
      return !gaps.some((gap) => gap.code === expected);
    });
    if (missingRequiredGaps.length > 0) {
      const notices: string[] = [];
      for (const defectCode of missingRequiredGaps) {
        const gapCode = chatFinalGapCodeForQualityDefectV1(defectCode);
        if (gaps.some((gap) => gap.code === gapCode)) continue;
        const notice = requiredQualityGapNoticeV1(gapCode, german);
        gaps.push({ code: gapCode, message: notice, sourceIds: [] });
        notices.push(notice);
      }
      if (notices.length > 0) {
        messageMarkdown += `\n\n> **${german ? "Qualitätsgrenze" : "Quality limit"}:** ${notices.join(" ")}`;
      }
    }
    const currentDetailIds = [...new Set(input.detailEvidence.map((entry) => entry.source.id))]
      .sort((left, right) => left.localeCompare(right, "en-US"));
    if (
      JSON.stringify(currentDetailIds) !==
        JSON.stringify(input.strategyReview.detailedSourceIds)
    ) {
      throw new ChatContractError(
        "invalid-report",
        "The agentic Chat review does not cover the final detailed evidence set.",
      );
    }
    if (!input.strategyReview.readyForAnswer && draft.gaps.length === 0) {
      throw new ChatContractError(
        "invalid-report",
        "An agentic Chat answer must disclose the material gap identified by its host review.",
      );
    }
  } else if (input.strategyReview) {
    throw new ChatContractError(
      "invalid-report",
      "A direct Chat answer cannot attach an agentic evidence-gap review.",
    );
  } else if (input.qualityDisposition) {
    throw new ChatContractError(
      "invalid-report",
      "A direct Chat answer cannot attach an agentic quality disposition.",
    );
  }
  const visibleGapMessages = gaps
    .map((gap) => gap.message.trim())
    .filter((message, index, all) =>
      message.length > 0 &&
      all.indexOf(message) === index &&
      !messageMarkdown.includes(message)
    );
  if (visibleGapMessages.length > 0) {
    const visible = visibleGapMessages.slice(0, 6);
    const remaining = visibleGapMessages.length - visible.length;
    messageMarkdown += [
      "",
      `### ${german ? "Grenzen" : "Limits"}`,
      "",
      ...visible.map((message) => `- ${message}`),
      ...(remaining > 0
        ? [`- ${german ? `${remaining} weitere Abdeckungsgrenzen sind im Laufprotokoll festgehalten.` : `${remaining} additional coverage limits are recorded in the run metadata.`}`]
        : []),
    ].join("\n");
  }
  if (messageMarkdown.length === 0 || messageMarkdown.length > 24_000) {
    throw new ChatContractError("limit-exceeded", "The Chat answer exceeds its bounded Markdown size.");
  }
  const reasonCode = strategyDecision.execution === "agentic"
    ? "agentic-required" as const
    : input.qualityPolicy.mode === "quick"
      ? "quick-direct" as const
      : input.qualityPolicy.mode === "deep"
        ? "deep-direct" as const
        : "auto-direct" as const;
  return {
    schema: CHAT_ANSWER_SCHEMA_V1,
    messageMarkdown,
    citations: citationKeys.map((citationKey) => {
      const separator = citationKey.indexOf("#");
      const sourceId = separator === -1 ? citationKey : citationKey.slice(0, separator);
      const sectionId = separator === -1 ? undefined : citationKey.slice(separator + 1);
      const source = sourceById.get(sourceId)!;
      const section = sectionId ? sectionReferenceByKey.get(citationKey) : undefined;
      return {
        sourceId,
        title: section?.heading ?? source.title,
        url: section
          ? confluenceSectionUrlV1(source.url, section.heading)
          : source.url,
        product: source.product,
        ...(section ? {
          section: {
            sectionId: section.sectionId,
            heading: section.heading,
          },
        } : {}),
      };
    }),
    evidenceRefs: citationIds,
    gaps,
    strategy: {
      qualityMode: input.qualityPolicy.mode,
      path: strategyDecision.execution,
      delegated: input.delegated === true,
      reasonCode,
      reasonCodes: [...strategyDecision.reasonCodes],
      ambiguityDisposition: strategyDecision.ambiguityDisposition,
      requiredCapabilities: [...strategyDecision.requiredCapabilities],
      expectedComplexity: strategyDecision.expectedComplexity,
      qualityRisks: [...strategyDecision.qualityRisks],
    },
    ...(draft.continuation ? { continuation: { ...draft.continuation } } : {}),
    run: structuredClone(input.run),
  };
}

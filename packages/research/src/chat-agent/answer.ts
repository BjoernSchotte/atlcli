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
  CHAT_AGENT_DRAFT_SCHEMA_V2,
  ChatContractError,
  normalizeChatAgentDraftV2,
  type ChatAgentDraftV2,
  type ChatAgentDraftV1,
  type ChatAcceptedAnswerProjectionV1,
  type ChatAnswerBlockV2,
  type ChatAnswerGapV1,
  type ChatAnswerV1,
  type ChatRunSummaryV1,
} from "./contracts.js";
import type {
  ChatStrategyDecisionV1,
  ChatStrategyReviewV1,
} from "./strategy.js";

function answerSourceIdV2(sourceRef: string): string {
  const separator = sourceRef.indexOf("#");
  return separator === -1 ? sourceRef : sourceRef.slice(0, separator);
}

function detailProjectionCompleteV2(evidence: ResearchDetailEvidenceV1): boolean {
  return evidence.coverage?.completeDocumentRead === true ||
    (!evidence.coverage && !evidence.content.truncated);
}

function sourceReferenceIsDetailedV2(
  sourceRef: string,
  evidence: readonly ResearchDetailEvidenceV1[],
  sections: readonly ResearchReadSectionReferenceV1[],
): boolean {
  const separator = sourceRef.indexOf("#");
  const sourceId = answerSourceIdV2(sourceRef);
  if (separator === -1) {
    return evidence.some((entry) => entry.source.id === sourceId);
  }
  const sectionId = sourceRef.slice(separator + 1);
  return evidence.some((entry) =>
    entry.source.id === sourceId && entry.section?.sectionId === sectionId
  ) || sections.some((entry) =>
    entry.sourceId === sourceId && entry.sectionId === sectionId
  );
}

function absenceScopeIsSupportedV2(input: {
  block: ChatAnswerBlockV2;
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  run: ChatRunSummaryV1;
}): boolean {
  if (input.block.assertion !== "absence") return true;
  if (input.block.scope === "source") {
    return input.block.sourceRefs.every((sourceRef) => {
      const sourceId = answerSourceIdV2(sourceRef);
      const separator = sourceRef.indexOf("#");
      if (separator !== -1) {
        return input.detailEvidence.some((entry) =>
          entry.source.id === sourceId &&
          entry.section?.sectionId === sourceRef.slice(separator + 1) &&
          !entry.content.truncated
        );
      }
      return input.detailEvidence.some((entry) =>
        entry.source.id === sourceId && !entry.content.truncated
      );
    });
  }
  if (input.block.scope === "selected-sources") {
    return input.block.sourceRefs.every((sourceRef) => {
      const sourceId = answerSourceIdV2(sourceRef);
      return input.detailEvidence.some((entry) =>
        entry.source.id === sourceId &&
        entry.section === undefined &&
        detailProjectionCompleteV2(entry)
      );
    });
  }
  const retrieval = input.run.retrieval;
  return retrieval !== undefined &&
    retrieval.deferredCandidates === 0 &&
    retrieval.admittedCandidates === retrieval.detailReadCandidates &&
    retrieval.detailReadCoverage === 1 &&
    retrieval.observedRecall === 1;
}

function appendEvidencePlaceholdersV2(
  markdown: string,
  sourceRefs: readonly string[],
): string {
  const clean = markdown
    .replace(/\[\[source:[^\]]+\]\]/gu, "")
    .replace(/\s+$/gu, "")
    .trim();
  const placeholders = [...new Set(sourceRefs)]
    .map((sourceRef) => `[[source:${sourceRef}]]`)
    .join(" ");
  if (!placeholders) return clean;
  return clean.endsWith("|")
    ? clean.replace(/\|\s*$/u, ` ${placeholders} |`)
    : `${clean} ${placeholders}`;
}

function joinAnswerBlocksV2(blocks: readonly string[]): string {
  const compact = (value: string): boolean =>
    /^\s*(?:[-*+]\s+|\d+[.)]\s+|\|)/u.test(value);
  let output = "";
  let previous: string | undefined;
  for (const block of blocks) {
    if (!output) output = block;
    else output += `${previous && compact(previous) && compact(block) ? "\n" : "\n\n"}${block}`;
    previous = block;
  }
  return output;
}

function projectStructuredDraftV2(input: {
  draft: ChatAgentDraftV2;
  sources: readonly ResearchSourceReferenceV1[];
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  readSectionReferences: readonly ResearchReadSectionReferenceV1[];
  qualityDisposition?: ChatQualityDispositionV1;
  run: ChatRunSummaryV1;
  locale?: string;
}): {
  draft: ChatAgentDraftV1;
  projection: ChatAcceptedAnswerProjectionV1;
} {
  const sourceIds = new Set(input.sources.map((source) => source.id));
  const rejectedIds = new Set(input.qualityDisposition?.rejectedSourceIds ?? []);
  const retained: string[] = [];
  const retainedBlocks: ChatAcceptedAnswerProjectionV1["blocks"] = [];
  const retainedSourceIds = new Set<string>();
  const seenBlockIds = new Set<string>();
  const removedSourceIds = new Set<string>();
  let unsupportedBlocks = 0;
  let unsupportedAbsenceBlocks = 0;

  for (const block of input.draft.blocks) {
    if (seenBlockIds.has(block.id)) {
      unsupportedBlocks += 1;
      continue;
    }
    seenBlockIds.add(block.id);
    const normalizedRefs = block.assertion === "none"
      ? []
      : [...new Set(block.sourceRefs)];
    if (block.assertion !== "none" && normalizedRefs.length === 0) {
      unsupportedBlocks += 1;
      continue;
    }
    if (block.assertion === "absence" && block.scope === "none") {
      unsupportedAbsenceBlocks += 1;
      continue;
    }
    const invalidReference = normalizedRefs.some((sourceRef) => {
      const sourceId = answerSourceIdV2(sourceRef);
      return !sourceIds.has(sourceId) ||
        rejectedIds.has(sourceId) ||
        !sourceReferenceIsDetailedV2(
          sourceRef,
          input.detailEvidence,
          input.readSectionReferences,
        );
    });
    if (invalidReference) {
      unsupportedBlocks += 1;
      normalizedRefs.forEach((sourceRef) => removedSourceIds.add(answerSourceIdV2(sourceRef)));
      continue;
    }
    if (!absenceScopeIsSupportedV2({
      block,
      detailEvidence: input.detailEvidence,
      run: input.run,
    })) {
      unsupportedAbsenceBlocks += 1;
      normalizedRefs.forEach((sourceRef) => removedSourceIds.add(answerSourceIdV2(sourceRef)));
      continue;
    }
    normalizedRefs.forEach((sourceRef) => retainedSourceIds.add(answerSourceIdV2(sourceRef)));
    retained.push(appendEvidencePlaceholdersV2(block.markdown, normalizedRefs));
    retainedBlocks.push({
      id: block.id,
      assertion: block.assertion,
      sourceRefs: [...normalizedRefs],
    });
  }

  const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
  const gaps = input.draft.gaps.map((gap) => ({
    ...gap,
    sourceIds: [...gap.sourceIds],
  }));
  if (unsupportedBlocks > 0) {
    gaps.push({
      code: "no-detail-evidence",
      message: german
        ? "Einige vorgeschlagene Aussagen konnten mit den gelesenen Detailquellen nicht sicher belegt werden und wurden ausgelassen."
        : "Some proposed claims could not be supported safely by the detailed sources and were omitted.",
      sourceIds: [...removedSourceIds].filter((sourceId) => sourceIds.has(sourceId)),
    });
  }
  if (unsupportedAbsenceBlocks > 0) {
    gaps.push({
      code: "incomplete-coverage",
      message: german
        ? "Einige Negativaussagen wurden ausgelassen, weil ihr behaupteter Umfang nicht vollständig gelesen wurde."
        : "Some absence claims were omitted because their asserted scope was not read completely.",
      sourceIds: [...removedSourceIds].filter((sourceId) => sourceIds.has(sourceId)),
    });
  }
  const messageMarkdown = joinAnswerBlocksV2(retained).trim() ||
    (german
      ? "Für diese Antwort blieb keine detailbelegte Aussage übrig."
      : "No detail-backed claim remained for this answer.");
  return {
    draft: {
      messageMarkdown,
      citationSourceIds: [...retainedSourceIds],
      gaps,
      ...(input.draft.continuation
        ? { continuation: { ...input.draft.continuation } }
        : {}),
    },
    projection: { blocks: retainedBlocks },
  };
}

function mergeEquivalentGapsV1(gaps: readonly ChatAnswerGapV1[]): ChatAnswerGapV1[] {
  const merged = new Map<string, ChatAnswerGapV1>();
  for (const gap of gaps) {
    const message = gap.message.trim();
    if (!message) continue;
    const key = `${gap.code}:${message}`;
    const current = merged.get(key);
    if (current) {
      current.sourceIds = [...new Set([...current.sourceIds, ...gap.sourceIds])]
        .sort((left, right) => left.localeCompare(right, "en-US"));
      continue;
    }
    merged.set(key, {
      code: gap.code,
      message,
      sourceIds: [...new Set(gap.sourceIds)].sort((left, right) =>
        left.localeCompare(right, "en-US")
      ),
    });
  }
  return [...merged.values()];
}

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

function removeEmptyMarkdownHeadingsV1(markdown: string): string {
  const lines = markdown.split("\n");
  return lines.filter((line, index) => {
    const heading = markdownHeadingV1(line);
    if (!heading) return true;
    const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
    if (!next) return false;
    const nextHeading = markdownHeadingV1(next);
    return !nextHeading || nextHeading.level > heading.level;
  }).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function normalizeFinalMarkdownStructureV1(markdown: string): string {
  const lines = markdown
    .split("\n")
    .filter((line) => !/^\s*(?:[-*+]|\d+[.)])\s*$/u.test(line));
  let orderedListIndex = 0;
  let inOrderedList = false;
  const normalized = lines.map((line) => {
    const match = /^(\s*)\d+([.)])\s+(.+)$/u.exec(line);
    if (!match) {
      if (line.trim().length > 0) inOrderedList = false;
      return line.replace(/[ \t]+$/gu, "");
    }
    orderedListIndex = inOrderedList ? orderedListIndex + 1 : 1;
    inOrderedList = true;
    return `${match[1]}${orderedListIndex}${match[2]} ${match[3]}`;
  });
  return removeEmptyMarkdownHeadingsV1(
    normalized.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
  );
}

function balanceGermanClosingQuotesV1(markdown: string): string {
  return markdown.split("\n").map((line) => {
    const opening = [...line.matchAll(/„/gu)].length;
    const closing = [...line.matchAll(/“/gu)].length;
    if (opening <= closing) return line;
    const trailingCitation = /^(.*?)(\s+(?:\[[^\]]+\]\(https?:\/\/[^)]+\)\s*)+)$/u.exec(line);
    return trailingCitation
      ? `${trailingCitation[1]}“${trailingCitation[2]}`
      : `${line}“`;
  }).join("\n");
}

function collapseRepeatedSinglePageCitationV1(
  markdown: string,
  citationKeys: readonly string[],
  sourceById: ReadonlyMap<string, ResearchSourceReferenceV1>,
  allowed: boolean,
): string {
  if (!allowed || citationKeys.length !== 1 || citationKeys[0]!.includes("#")) return markdown;
  const source = sourceById.get(citationKeys[0]!);
  if (!source) return markdown;
  const canonical = `[${escapeMarkdownLabel(source.title)}](${source.url})`;
  let retained = false;
  return markdown.split("\n").map((line) => {
    if (!line.includes(canonical)) return line;
    if (!retained) {
      retained = true;
      return line;
    }
    return line.split(canonical).join("").replace(/[ \t]+$/gu, "");
  }).join("\n");
}

function removeStandaloneEvidencePlaceholderLinesV1(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*(?:\[\[source:[^\]]+\]\]\s*)+$/u.test(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function strongMarkerCountV1(markdown: string): number {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "");
  return [...withoutCode.matchAll(/\*\*/gu)].length;
}

export function chatDraftNeedsHostRepairV1(input: {
  draft: unknown;
  detailEvidence: readonly ResearchDetailEvidenceV1[];
  readSectionReferences?: readonly ResearchReadSectionReferenceV1[];
}): boolean {
  const parsed = CHAT_AGENT_DRAFT_SCHEMA_V2.safeParse(input.draft);
  if (!parsed.success) return false;
  const draft = normalizeChatAgentDraftV2(parsed.data);
  if (draft.blocks.some((block) => strongMarkerCountV1(block.markdown) % 2 !== 0)) {
    return true;
  }
  if (input.detailEvidence.length === 0) return false;
  const factual = draft.blocks.filter((block) => block.assertion !== "none");
  if (factual.length === 0) return true;
  const sections = input.readSectionReferences ?? [];
  return !factual.some((block) => block.sourceRefs.some((sourceRef) =>
    sourceReferenceIsDetailedV2(sourceRef, input.detailEvidence, sections)
  ));
}

/**
 * Structured output can still contain syntactically valid JSON whose Markdown
 * prose was abandoned and regenerated inside the same response. Do not expose
 * those half-written alternatives to the user. This projection is deliberately
 * conservative: it removes only paragraphs with an unmatched strong marker and
 * joins a short, obviously lower-case continuation to the preceding paragraph.
 * It never invents or rewrites factual content.
 */
function removeAbandonedMarkdownFragmentsV1(markdown: string): string {
  const paragraphs = markdown
    .split(/\n{2,}/gu)
    .map((paragraph) => paragraph.trimEnd())
    .filter((paragraph) => {
      if (paragraph.includes("```")) return true;
      return strongMarkerCountV1(paragraph) % 2 === 0;
    });
  const joined: string[] = [];
  const continuation = /^(?:das|der|die|den|dem|ein(?:e[rmns]?)?|dies(?:e[rmns]?)?|und|aber|the|this|that|and|but|however)\b/u;
  for (const paragraph of paragraphs) {
    const previous = joined.at(-1);
    if (
      previous &&
      continuation.test(paragraph.trimStart()) &&
      !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||```)/u.test(previous.trimStart()) &&
      !/```\s*$/u.test(previous.trimEnd())
    ) {
      joined[joined.length - 1] = `${previous.replace(/[\s.;:]+$/u, "")}; ${paragraph.trimStart()}`;
      continue;
    }
    joined.push(paragraph);
  }
  return joined.join("\n\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function humanizeInternalSourceIdsV1(
  value: string,
  sources: ReadonlyMap<string, ResearchSourceReferenceV1>,
): string {
  let result = value;
  for (const [sourceId, source] of sources) {
    if (!sourceId.startsWith("wiki:")) continue;
    result = result.split(sourceId).join(source.title);
  }
  return result;
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
  const inputLines = markdown.split("\n");
  const lines = inputLines.flatMap((line, index): string[] => {
    const issueKeys = [...line.matchAll(JIRA_ISSUE_KEY_V1)].map((match) => match[0]!);
    if (issueKeys.length === 0) return [line];
    const citedDetailedConfluenceSource = chatEvidencePlaceholdersV1(line).some((placeholder) =>
      sources.get(placeholder.sourceId)?.product === "confluence"
    );
    // A detail-read Confluence page can directly support that its own text
    // mentions or defines work associated with a Jira key. Requiring a second
    // Jira detail read here would erase valid Confluence -> Jira evidence. A
    // Jira-state claim without either detailed source remains blocked below.
    if (citedDetailedConfluenceSource) return [line];
    const issueSources = issueKeys.map((issueKey) =>
      [...sources.values()].find((source) =>
        source.product === "jira" &&
        (source.issueKey === issueKey || source.id === `jira:${issueKey}`)
      )
    );
    if (issueSources.some((source) => source === undefined)) {
      const unsupportedKeys = issueKeys.filter((_issueKey, issueIndex) =>
        issueSources[issueIndex] === undefined
      );
      const retainedSegments = line
        .split(/(?<=[.!?])\s+/u)
        .filter((segment) => !unsupportedKeys.some((issueKey) =>
          segment.includes(issueKey)
        ));
      const retained = retainedSegments.join(" ").trimEnd();
      const retainedKeys = [...retained.matchAll(JIRA_ISSUE_KEY_V1)]
        .map((match) => match[0]!);
      const retainedSources = retainedKeys.map((issueKey) =>
        [...sources.values()].find((source) =>
          source.product === "jira" &&
          (source.issueKey === issueKey || source.id === `jira:${issueKey}`)
        )
      );
      removedLines += 1;
      if (retained.length === 0 || retainedSources.some((source) => source === undefined)) {
        return [];
      }
      const missingPlaceholders = [...new Set(retainedSources.flatMap((source) =>
        source && !lineHasSourcePlaceholderV1(retained, source.id) ? [source.id] : []
      ))];
      const placeholders = missingPlaceholders
        .map((sourceId) => `[[source:${sourceId}]]`)
        .join(" ");
      return [placeholders ? `${retained} ${placeholders}` : retained];
    }
    const missingSourceIds = [...new Set(issueSources.flatMap((source) =>
      source && !lineHasSourcePlaceholderV1(line, source.id) ? [source.id] : []
    ))];
    if (missingSourceIds.length === 0) return [line];
    const isHeading = /^#{1,6}\s+/u.test(line.trim());
    const isTableHeader = line.includes("|") &&
      /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(inputLines[index + 1] ?? "");
    if (isHeading || isTableHeader) return [line];
    const placeholders = missingSourceIds.map((sourceId) => `[[source:${sourceId}]]`).join(" ");
    return [line.trimEnd().endsWith("|")
      ? line.replace(/\|\s*$/u, ` ${placeholders} |`)
      : `${line} ${placeholders}`];
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
  /** Internal, body-free evaluator seam; not part of ChatAnswerV1. */
  onAcceptedProjection?: (projection: ChatAcceptedAnswerProjectionV1) => void;
  /** Carries the already host-filtered projection through the V2 -> V1 pass. */
  acceptedProjection?: ChatAcceptedAnswerProjectionV1;
}): ChatAnswerV1 {
  const structured = CHAT_AGENT_DRAFT_SCHEMA_V2.safeParse(input.draft);
  if (structured.success) {
    const projected = projectStructuredDraftV2({
      draft: normalizeChatAgentDraftV2(structured.data),
      sources: input.sources,
      detailEvidence: input.detailEvidence,
      readSectionReferences: input.readSectionReferences ?? [],
      qualityDisposition: input.qualityDisposition,
      run: input.run,
      locale: input.locale,
    });
    return finalizeChatAnswerV1({
      ...input,
      draft: projected.draft,
      acceptedProjection: projected.projection,
    });
  }
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
    new Map([...sourceById].filter(([sourceId]) =>
      detailedIds.has(sourceId) && !rejectedIds.has(sourceId)
    )),
  );
  messageMarkdown = jiraClaimProjection.markdown;
  const documentationAbsenceProjection = removeUncitedDocumentationAbsenceLinesV1(
    messageMarkdown,
  );
  messageMarkdown = documentationAbsenceProjection.markdown;
  messageMarkdown = removeStandaloneEvidencePlaceholderLinesV1(messageMarkdown);
  messageMarkdown = removeAbandonedMarkdownFragmentsV1(messageMarkdown);
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
      ? "Einige vorgeschlagene Aussagen konnten mit den gelesenen Detailquellen nicht sicher belegt werden und wurden ausgelassen."
      : "Some proposed claims could not be supported safely by the detailed sources and were omitted.";
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
  }
  if (jiraClaimProjection.removedLines > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const notice = german
      ? "Einige vorgeschlagene Jira-Zuordnungen hatten keinen direkten Detailbeleg und wurden ausgelassen."
      : "Some proposed Jira mappings lacked direct detail evidence and were omitted.";
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
  }
  if (documentationAbsenceProjection.removedLines > 0) {
    const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
    const notice = german
      ? "Einige Aussagen über fehlende Dokumentation waren nicht direkt belegt und wurden ausgelassen."
      : "Some claims about missing documentation lacked direct evidence and were omitted.";
    gaps.push({
      code: "no-detail-evidence",
      message: notice,
      sourceIds: [],
    });
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
  messageMarkdown = collapseRepeatedSinglePageCitationV1(
    messageMarkdown,
    citationKeys,
    sourceById,
    input.strategyReview === undefined && input.detailEvidence.length === 1 &&
      detailProjectionCompleteV2(input.detailEvidence[0]!) &&
      (input.run.retrieval === undefined ||
        (input.run.retrieval.detailReadCoverage === 1 &&
          input.run.retrieval.deferredCandidates === 0 &&
          input.run.retrieval.admittedCandidates === input.run.retrieval.detailReadCandidates)),
  );
  messageMarkdown = balanceGermanClosingQuotesV1(messageMarkdown);
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
  messageMarkdown = normalizeFinalMarkdownStructureV1(messageMarkdown);
  const german = input.locale?.toLocaleLowerCase("en-US").startsWith("de") === true;
  const evidenceRequired = input.strategyDecision?.requiredCapabilities.some(
    (capability) => capability !== "chat-answer",
  ) === true;
  const attemptedEvidenceRead = (input.run.retrieval?.detailReadCandidates ?? 0) > 0 ||
    (input.run.retrieval?.atlassianHttpCalls ?? 0) > 0;
  if (evidenceRequired && attemptedEvidenceRead && citationIds.length === 0) {
    messageMarkdown = german
      ? "Für diese Antwort blieb keine detailbelegte Aussage übrig."
      : "No detail-backed claim remained for this answer.";
    if (!gaps.some((gap) => gap.code === "no-detail-evidence")) {
      gaps.push({
        code: "no-detail-evidence",
        message: german
          ? "Der angeforderte Atlassian-Kontext lieferte keinen zitierbaren Detailbeleg."
          : "The requested Atlassian context produced no citable detail evidence.",
        sourceIds: [],
      });
    }
  }
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
  messageMarkdown = humanizeInternalSourceIdsV1(messageMarkdown, sourceById);
  for (const gap of gaps) {
    gap.message = humanizeInternalSourceIdsV1(gap.message, sourceById);
  }
  const mergedGaps = mergeEquivalentGapsV1(gaps);
  gaps.splice(0, gaps.length, ...mergedGaps);
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
  messageMarkdown = normalizeFinalMarkdownStructureV1(messageMarkdown);
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
  const answer: ChatAnswerV1 = {
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
  input.onAcceptedProjection?.(structuredClone(
    input.acceptedProjection ?? { blocks: [] },
  ));
  return answer;
}

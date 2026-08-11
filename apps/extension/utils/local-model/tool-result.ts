const BOUND_READ_SCHEMA_V1 = "atlcli.ptc/atlassian.bound.read.output/v1";
const BOUND_SECTION_READ_SCHEMA_V1 =
  "atlcli.ptc/atlassian.bound.section.read.output/v1";
const LOCAL_TOOL_RESULT_MAX_TEXT_CHARS_V1 = 1_800;
const LOCAL_TOOL_RESULT_MAX_LINKS_V1 = 8;
const LOCAL_TOOL_RESULT_MAX_SECTIONS_V1 = 12;

interface LocalToolResultProjectionLimitsV1 {
  maxTextChars: number;
  maxLinks: number;
  maxSections: number;
  maxRelatedAnchors: number;
}

const LOCAL_TOOL_RESULT_DEFAULT_LIMITS_V1: LocalToolResultProjectionLimitsV1 = {
  maxTextChars: LOCAL_TOOL_RESULT_MAX_TEXT_CHARS_V1,
  maxLinks: LOCAL_TOOL_RESULT_MAX_LINKS_V1,
  maxSections: LOCAL_TOOL_RESULT_MAX_SECTIONS_V1,
  maxRelatedAnchors: 8,
};

const LOCAL_TOOL_RESULT_FINALIZATION_LIMITS_V1: LocalToolResultProjectionLimitsV1 = {
  maxTextChars: 600,
  maxLinks: 1,
  maxSections: 0,
  maxRelatedAnchors: 0,
};

function recordV1(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactContentV1(
  value: unknown,
  limits: LocalToolResultProjectionLimitsV1,
): unknown {
  const content = recordV1(value);
  if (!content) return value;
  const text = typeof content.text === "string"
    ? content.text.slice(0, limits.maxTextChars)
    : content.text;
  return {
    ...content,
    ...(text === undefined ? {} : { text }),
    ...(Array.isArray(content.linkTargets)
      ? { linkTargets: content.linkTargets.slice(0, limits.maxLinks) }
      : {}),
    ...(typeof content.text === "string" && content.text.length > limits.maxTextChars
      ? { truncated: true }
      : {}),
  };
}

function relevanceTermsV1(value: string): string[] {
  return [...new Set(
    value.toLocaleLowerCase("en-US").match(
      /(?:\p{L}[\p{L}\p{N}-]{2,}|\p{N}+)/gu,
    ) ?? [],
  )].filter((term) => ![
    "answer", "antworte", "bitte", "context", "context", "frage", "geöffneten",
    "kurzen", "opened", "page", "seite", "satz", "user", "with",
  ].includes(term));
}

function compactSectionsV1(
  value: unknown,
  relevanceText: string,
  limits: LocalToolResultProjectionLimitsV1,
): unknown {
  if (!Array.isArray(value)) return value;
  const terms = relevanceTermsV1(relevanceText);
  const candidates = value.map((candidate, index) => {
    const section = recordV1(candidate);
    const heading = typeof section?.heading === "string"
      ? section.heading.toLocaleLowerCase("en-US")
      : "";
    return { candidate, index, score: terms.filter((term) => heading.includes(term)).length };
  });
  const selected = new Set<number>(
    candidates
      .toSorted((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limits.maxSections)
      .map((candidate) => candidate.index),
  );
  return candidates.filter((candidate) => selected.has(candidate.index)).map(({ candidate }) => {
    const section = recordV1(candidate);
    if (!section) return candidate;
    return {
      sectionRef: section.sectionRef,
      sectionId: section.sectionId,
      heading: section.heading,
      level: section.level,
      order: section.order,
      contentBytes: section.contentBytes,
    };
  });
}

function compactBoundReadV1(
  value: Record<string, unknown>,
  relevanceText: string,
  limits: LocalToolResultProjectionLimitsV1,
): Record<string, unknown> {
  const document = recordV1(value.document);
  return {
    schema: value.schema,
    source: value.source,
    content: compactContentV1(value.content, limits),
    relatedAnchors: Array.isArray(value.relatedAnchors)
      ? value.relatedAnchors.slice(0, limits.maxRelatedAnchors)
      : value.relatedAnchors,
    ...(document
      ? {
          document: {
            coverageIssues: document.coverageIssues,
            sourceTruncated: document.sourceTruncated,
            outlineTruncated: document.outlineTruncated,
            projectionTruncated: document.projectionTruncated,
            genuinelyEmpty: document.genuinelyEmpty,
            totalSections: document.totalSections,
            unreadSections: document.unreadSections,
            ...(limits.maxSections > 0
              ? { sections: compactSectionsV1(document.sections, relevanceText, limits) }
              : {}),
          },
        }
      : {}),
  };
}

function compactBoundSectionReadV1(
  value: Record<string, unknown>,
  limits: LocalToolResultProjectionLimitsV1,
): Record<string, unknown> {
  return {
    schema: value.schema,
    source: value.source,
    section: value.section,
    content: compactContentV1(value.content, limits),
    support: value.support,
    coverage: value.coverage,
    relatedAnchors: Array.isArray(value.relatedAnchors)
      ? value.relatedAnchors.slice(0, limits.maxRelatedAnchors)
      : value.relatedAnchors,
  };
}

function compactNestedEvidenceV1(
  value: unknown,
  relevanceText: string,
  limits: LocalToolResultProjectionLimitsV1,
): unknown {
  if (typeof value === "string" && /^[\s]*[\[{]/u.test(value)) {
    try {
      return compactNestedEvidenceV1(JSON.parse(value), relevanceText, limits);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((nested) => compactNestedEvidenceV1(nested, relevanceText, limits));
  }
  const object = recordV1(value);
  if (!object) return value;
  if (object.schema === BOUND_READ_SCHEMA_V1) {
    return compactBoundReadV1(object, relevanceText, limits);
  }
  if (object.schema === BOUND_SECTION_READ_SCHEMA_V1) {
    return compactBoundSectionReadV1(object, limits);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, nested]) => [
      key,
      compactNestedEvidenceV1(nested, relevanceText, limits),
    ]),
  );
}

/**
 * Remove host bookkeeping and repeated per-section metadata from model-visible
 * evidence while retaining every source ID, coverage flag, section handle,
 * heading, and bounded text projection needed by the canonical Chat contract.
 */
export function projectLocalGemmaToolResultV1(
  content: string,
  relevanceText = "",
  limits: LocalToolResultProjectionLimitsV1 = LOCAL_TOOL_RESULT_DEFAULT_LIMITS_V1,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return content;
  }
  return JSON.stringify(compactNestedEvidenceV1(parsed, relevanceText, limits));
}

/**
 * The host has already selected the terminal answer tool, so discovery links
 * and a broad outline are no longer useful. Keep only the exact source,
 * question-relevant evidence projection, coverage flags, and a few relevant
 * section handles for the local finalization call. The full tool result stays
 * unchanged in canonical DeepAgents state and host evidence ledgers.
 */
export function projectLocalGemmaFinalToolResultV1(
  content: string,
  relevanceText = "",
): string {
  return projectLocalGemmaToolResultV1(
    content,
    relevanceText,
    LOCAL_TOOL_RESULT_FINALIZATION_LIMITS_V1,
  );
}

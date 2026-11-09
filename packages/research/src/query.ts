import type {
  ResearchScopeV1,
  ResearchTimeWindowV1,
} from "./contracts.js";
import {
  decodeResearchSearchInputV1,
  type ResearchSearchQueryV1,
} from "./capability-contracts.js";

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function escapeResearchJqlLiteral(value: string): string {
  return stripControls(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function escapeResearchCqlLiteral(value: string): string {
  return stripControls(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quotedList(values: readonly string[], escape: (value: string) => string): string {
  return values.map((value) => `"${escape(value)}"`).join(", ");
}

function orderedLabels(labels: readonly string[] | undefined): string[] {
  return [...(labels ?? [])].sort((left, right) => left.localeCompare(right, "en-US"));
}

function addDateClauses(
  clauses: string[],
  field: string,
  window: ResearchTimeWindowV1 | undefined
): void {
  if (window?.from) clauses.push(`${field} >= "${window.from}"`);
  if (window?.to) clauses.push(`${field} <= "${window.to}"`);
}

// Function words and question scaffolding the chat keeps in its keyword
// variants. A term disjunction is only as good as its terms: "den" or
// "Seiten" match nearly every page and would crowd the real topic terms out
// of the six-term cap.
const RESEARCH_TEXT_STOP_WORDS = new Set([
  "about", "and", "are", "auf", "aus", "bei", "behandeln", "das", "dem", "den",
  "der", "des", "die", "ein", "eine", "einen", "for", "from", "für", "how",
  "ist", "mit", "nach", "nenne", "oder", "page", "pages", "project", "seite",
  "seiten", "sind", "space", "the", "ticket", "und", "von", "was", "welche",
  "what", "which", "wie", "with", "work", "zwei", "confluence", "jira",
]);

/**
 * Turn an agent research intent into a small disjunction of Atlassian text
 * terms. JQL's quoted `text ~ "multi word phrase"` is too exact for discovery
 * across independently worded Confluence and Jira content. Every term remains
 * host-escaped and the project/date clauses remain mandatory.
 */
export function jiraResearchTextTerms(value: string): string[] {
  return [...new Set(
    (stripControls(value).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
      .map((term) => term.trim())
      .filter(
        (term) =>
          term.length >= 3 &&
          !RESEARCH_TEXT_STOP_WORDS.has(term.toLocaleLowerCase())
      )
  )].slice(0, 6);
}

export function buildResearchJql(
  scope: ResearchScopeV1,
  query: ResearchSearchQueryV1
): string {
  const clauses = [
    `project in (${quotedList(scope.jiraProjectKeys, escapeResearchJqlLiteral)})`,
  ];
  addDateClauses(clauses, "updated", scope.timeWindow);
  if (query.text) {
    const terms = jiraResearchTextTerms(query.text);
    if (terms.length > 0) {
      clauses.push(
        `(${terms
          .map((term) => `text ~ "${escapeResearchJqlLiteral(term)}"`)
          .join(" OR ")})`
      );
    }
  }
  for (const label of orderedLabels(query.labels)) {
    clauses.push(`labels = "${escapeResearchJqlLiteral(label)}"`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated DESC, key ASC`;
}

export function buildResearchCql(
  scope: ResearchScopeV1,
  query: ResearchSearchQueryV1
): string {
  const clauses = [
    "type = page",
    `space in (${quotedList(scope.confluenceSpaceKeys, escapeResearchCqlLiteral)})`,
  ];
  addDateClauses(clauses, "lastmodified", scope.timeWindow);
  for (const label of orderedLabels(query.labels)) {
    clauses.push(`label = "${escapeResearchCqlLiteral(label)}"`);
  }
  if (query.ancestorId) clauses.push(`ancestor = ${query.ancestorId}`);
  if (query.parentId) clauses.push(`parent = ${query.parentId}`);
  if (query.text) {
    // The exact phrase alone found nothing for keyword-bag queries (the chat's
    // "question-terms" variant): Confluence requires every word of a quoted or
    // multi-word `text ~` value. Keep the phrase for precision and OR in the
    // individual terms for recall; drop terms naming the scoped spaces.
    const phrase = `\\"${escapeResearchCqlLiteral(query.text)}\\"`;
    const spaceKeys = new Set(scope.confluenceSpaceKeys.map((key) => key.toLocaleLowerCase()));
    const terms = jiraResearchTextTerms(query.text)
      .filter((term) => !spaceKeys.has(term.toLocaleLowerCase()))
      .map((term) => `text ~ "${escapeResearchCqlLiteral(term)}"`);
    clauses.push(`(${[`title ~ "${phrase}"`, `text ~ "${phrase}"`, ...terms].join(" OR ")})`);
    // Without ORDER BY Confluence ranks text matches by relevance; recency
    // order would fill the page with recently edited pages matching any term.
    return clauses.join(" AND ");
  }
  return `${clauses.join(" AND ")} ORDER BY lastmodified DESC`;
}

export function researchQueryFingerprint(
  tool: "jira.issue.search" | "wiki.search",
  query: ResearchSearchQueryV1,
  pageSize: number
): string {
  return JSON.stringify({ tool, query, pageSize });
}

export function parseResearchQueryFingerprint(value: string): {
  tool: "jira.issue.search" | "wiki.search";
  query: ResearchSearchQueryV1;
  pageSize: number;
} {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid query state.");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.tool !== "jira.issue.search" && candidate.tool !== "wiki.search") {
    throw new Error("Invalid query tool.");
  }
  if (
    typeof candidate.pageSize !== "number" ||
    !Number.isSafeInteger(candidate.pageSize)
  ) {
    throw new Error("Invalid query page size.");
  }
  const query =
    typeof candidate.query === "object" && candidate.query !== null
      ? (candidate.query as Record<string, unknown>)
      : {};
  let decoded;
  try {
    decoded = decodeResearchSearchInputV1(candidate.tool, {
      schema: `atlcli.ptc/${candidate.tool}.input/v1`,
      query,
      pageSize: candidate.pageSize,
    }, 50);
  } catch {
    throw new Error("Invalid query state.");
  }
  if ("cursor" in decoded) {
    throw new Error("Invalid query state.");
  }
  return {
    tool: candidate.tool,
    query: decoded.query,
    pageSize: candidate.pageSize,
  };
}

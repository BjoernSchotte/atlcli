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

const JIRA_RESEARCH_STOP_WORDS = new Set([
  "and",
  "confluence",
  "der",
  "die",
  "for",
  "jira",
  "project",
  "the",
  "ticket",
  "und",
  "work",
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
          !JIRA_RESEARCH_STOP_WORDS.has(term.toLocaleLowerCase())
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
  if (query.text) {
    const phrase = `\\"${escapeResearchCqlLiteral(query.text)}\\"`;
    clauses.push(`(title ~ "${phrase}" OR text ~ "${phrase}")`);
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

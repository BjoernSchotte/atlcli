/**
 * Client-side JQL functions with ScriptRunner's names: `issue in
 * linkedIssuesOf("project = A")` and friends. Jira Cloud has none of them, so
 * `JiraClient.search` rewrites each call into native JQL before sending it:
 * either a native clause (`parent in (…)`) or the key list it stands for.
 *
 * Pure apart from the injected `search`; isomorphic.
 */

export interface JqlFunctionLimits {
  /** Keys a function may expand to (a `key in (…)` list). */
  maxKeys: number;
  /** Issues read from a function's inner query. */
  maxScan: number;
}

export const DEFAULT_JQL_FUNCTION_LIMITS: JqlFunctionLimits = { maxKeys: 1_000, maxScan: 2_000 };

export class JqlFunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JqlFunctionError";
  }
}

/** One page of a native search, as `JiraClient.search` returns it. */
export type JqlSearchPage = (
  jql: string,
  options: { fields: string[]; nextPageToken?: string; maxResults: number },
) => Promise<{ issues: Array<{ key: string; fields: Record<string, any> }>; nextPageToken?: string }>;

/** Functions resolved by atlcli, lower-cased. */
export const JQL_FUNCTIONS = [
  "linkedIssuesOf",
  "subtasksOf",
  "childrenOf",
  "issuesInEpics",
  "parentsOf",
  "epicsOf",
  "hasSubtasks",
  "hasLinks",
  "hasAttachments",
  "hasComments",
  "hasWorklogs",
] as const;

const BY_NAME = new Map(JQL_FUNCTIONS.map((name) => [name.toLowerCase(), name]));

export interface JqlFunctionCall {
  /** Offsets of the whole clause `issue [not] in fn(...)` in the query. */
  start: number;
  end: number;
  name: (typeof JQL_FUNCTIONS)[number];
  negated: boolean;
  args: string[];
}

const CLAUSE = /(issue|issuekey|key)\s+(not\s+)?in\s+([A-Za-z]+)\s*\(/iy;

/** Finds atlcli function clauses outside string literals. Throws on malformed calls. */
export function findJqlFunctions(jql: string): JqlFunctionCall[] {
  const calls: JqlFunctionCall[] = [];
  let i = 0;
  while (i < jql.length) {
    const ch = jql[i]!;
    if (ch === '"' || ch === "'") {
      i = skipString(jql, i);
      continue;
    }
    // A clause starts at a word boundary.
    if (i === 0 || !/[A-Za-z0-9_.]/.test(jql[i - 1]!)) {
      CLAUSE.lastIndex = i;
      const m = CLAUSE.exec(jql);
      const name = m && BY_NAME.get(m[3]!.toLowerCase());
      if (m && name) {
        const { args, end } = parseArgs(jql, CLAUSE.lastIndex, name);
        calls.push({ start: i, end, name, negated: Boolean(m[2]), args });
        i = end;
        continue;
      }
    }
    i++;
  }
  return calls;
}

function skipString(jql: string, start: number): number {
  const quote = jql[start];
  for (let i = start + 1; i < jql.length; i++) {
    if (jql[i] === "\\") i++;
    else if (jql[i] === quote) return i + 1;
  }
  throw new JqlFunctionError(`Unterminated string in JQL at position ${start}`);
}

/** Quoted string arguments up to the closing parenthesis. */
function parseArgs(jql: string, from: number, name: string): { args: string[]; end: number } {
  const args: string[] = [];
  let i = from;
  const ws = () => {
    while (/\s/.test(jql[i] ?? "")) i++;
  };
  ws();
  if (jql[i] === ")") return { args, end: i + 1 };
  for (;;) {
    ws();
    const quote = jql[i];
    if (quote !== '"' && quote !== "'") throw new JqlFunctionError(`${name}() takes quoted arguments, e.g. ${name}("project = ABC")`);
    const end = skipString(jql, i);
    args.push(jql.slice(i + 1, end - 1).replace(/\\(.)/g, "$1"));
    i = end;
    ws();
    if (jql[i] === ",") {
      i++;
      continue;
    }
    if (jql[i] === ")") return { args, end: i + 1 };
    throw new JqlFunctionError(`Expected "," or ")" after an argument of ${name}()`);
  }
}

/** True when the query uses at least one atlcli function. */
export function hasJqlFunctions(jql: string): boolean {
  // Cheap pre-check before tokenizing.
  return /\(/.test(jql) && JQL_FUNCTIONS.some((n) => jql.toLowerCase().includes(n.toLowerCase())) && findJqlFunctions(jql).length > 0;
}

/** Always true / always false, for empty key sets. */
const MATCH_ALL = "(created IS NOT EMPTY)";
const MATCH_NONE = "(created IS EMPTY)";

/**
 * Rewrites every atlcli function clause into native JQL. Inner queries run
 * through `search`; a function whose result exceeds the limits fails rather
 * than silently cutting the result.
 */
export async function expandJqlFunctions(
  jql: string,
  search: JqlSearchPage,
  limits: JqlFunctionLimits = DEFAULT_JQL_FUNCTION_LIMITS,
): Promise<string> {
  const calls = findJqlFunctions(jql);
  if (calls.length === 0) return jql;
  let out = "";
  let last = 0;
  for (const call of calls) {
    out += jql.slice(last, call.start) + (await expandCall(call, search, limits));
    last = call.end;
  }
  return out + jql.slice(last);
}

async function expandCall(call: JqlFunctionCall, search: JqlSearchPage, limits: JqlFunctionLimits): Promise<string> {
  const [inner, linkType, ...extra] = call.args;
  const takesLinkType = call.name === "linkedIssuesOf";
  if (inner === undefined || !inner.trim() || extra.length > 0 || (!takesLinkType && linkType !== undefined)) {
    throw new JqlFunctionError(`${call.name}() takes ${takesLinkType ? 'a query and an optional link type: linkedIssuesOf("…", "blocks")' : `one query: ${call.name}("…")`}`);
  }
  if (findJqlFunctions(inner).length > 0) {
    throw new JqlFunctionError(`${call.name}(): functions cannot be nested; combine the conditions in one script instead`);
  }
  const scan = (fields: string[]) => scanAll(inner, fields, search, limits, call.name);
  const not = call.negated;

  switch (call.name) {
    case "subtasksOf":
    case "childrenOf":
    case "issuesInEpics": {
      // Native, so the result itself is not capped: only the parents are.
      const parents = (await scan(["key"])).map((i) => i.key);
      if (parents.length === 0) return not ? MATCH_ALL : MATCH_NONE;
      const list = keyList(parents, limits, call.name);
      return not ? `(parent NOT IN ${list} OR parent IS EMPTY)` : `parent IN ${list}`;
    }
    case "parentsOf":
      return keyClause(new Set((await scan(["parent"])).map((i) => i.fields.parent?.key).filter(Boolean)), not, limits, call.name);
    case "epicsOf":
      return keyClause(await epicsOf(await scan(["parent"]), search, limits), not, limits, call.name);
    case "linkedIssuesOf": {
      const wanted = linkType?.toLowerCase();
      const keys = new Set<string>();
      for (const issue of await scan(["issuelinks"])) {
        for (const link of (issue.fields.issuelinks ?? []) as any[]) {
          const type = link.type ?? {};
          const out = link.outwardIssue?.key;
          const inw = link.inwardIssue?.key;
          // A direction ("blocks", "is blocked by") picks one side; the type name both.
          const outward = String(type.outward ?? "").toLowerCase() === wanted;
          const inward = String(type.inward ?? "").toLowerCase() === wanted;
          const both = !wanted || (!outward && !inward && String(type.name ?? "").toLowerCase() === wanted);
          if (out && (both || outward)) keys.add(out);
          if (inw && (both || inward)) keys.add(inw);
        }
      }
      return keyClause(keys, not, limits, call.name);
    }
    case "hasSubtasks":
      return keyClause(filterKeys(await scan(["subtasks"]), (f) => (f.subtasks ?? []).length > 0), not, limits, call.name);
    case "hasLinks":
      return keyClause(filterKeys(await scan(["issuelinks"]), (f) => (f.issuelinks ?? []).length > 0), not, limits, call.name);
    case "hasAttachments":
      return keyClause(filterKeys(await scan(["attachment"]), (f) => (f.attachment ?? []).length > 0), not, limits, call.name);
    case "hasComments":
      return keyClause(filterKeys(await scan(["comment"]), (f) => countOf(f.comment) > 0), not, limits, call.name);
    case "hasWorklogs":
      return keyClause(filterKeys(await scan(["worklog"]), (f) => countOf(f.worklog) > 0), not, limits, call.name);
  }
}

/** `comment`/`worklog` come as `{ total, comments|worklogs }`. */
const countOf = (value: any): number => Number(value?.total ?? (value?.comments ?? value?.worklogs ?? []).length) || 0;

const filterKeys = (issues: Array<{ key: string; fields: Record<string, any> }>, keep: (f: Record<string, any>) => boolean) =>
  new Set(issues.filter((i) => keep(i.fields ?? {})).map((i) => i.key));

/** Epics above the given issues: a direct parent at hierarchy level 1, else one more hop up. */
async function epicsOf(
  issues: Array<{ key: string; fields: Record<string, any> }>,
  search: JqlSearchPage,
  limits: JqlFunctionLimits,
): Promise<Set<string>> {
  const epics = new Set<string>();
  const middle = new Set<string>();
  for (const issue of issues) {
    const parent = issue.fields.parent;
    if (!parent?.key) continue;
    if (isEpic(parent.fields?.issuetype)) epics.add(parent.key);
    else middle.add(parent.key);
  }
  if (middle.size > 0) {
    const grand = await scanAll(`key IN ${keyList([...middle], limits, "epicsOf")}`, ["parent"], search, limits, "epicsOf");
    for (const issue of grand) {
      const parent = issue.fields.parent;
      if (parent?.key && isEpic(parent.fields?.issuetype)) epics.add(parent.key);
    }
  }
  return epics;
}

const isEpic = (type: any): boolean =>
  type?.hierarchyLevel === 1 || (type?.hierarchyLevel === undefined && /epic/i.test(String(type?.name ?? "")));

function keyClause(keys: Set<string>, not: boolean, limits: JqlFunctionLimits, name: string): string {
  if (keys.size === 0) return not ? MATCH_ALL : MATCH_NONE;
  return `key ${not ? "NOT IN" : "IN"} ${keyList([...keys], limits, name)}`;
}

function keyList(keys: string[], limits: JqlFunctionLimits, name: string): string {
  if (keys.length > limits.maxKeys) {
    throw new JqlFunctionError(
      `${name}() matched ${keys.length} issues, more than the limit of ${limits.maxKeys}. Narrow the inner query, or move the condition into a script.`,
    );
  }
  return `(${[...keys].sort().join(", ")})`;
}

async function scanAll(
  jql: string,
  fields: string[],
  search: JqlSearchPage,
  limits: JqlFunctionLimits,
  name: string,
): Promise<Array<{ key: string; fields: Record<string, any> }>> {
  const issues: Array<{ key: string; fields: Record<string, any> }> = [];
  let token: string | undefined;
  do {
    const page = await search(jql, { fields, nextPageToken: token, maxResults: 100 });
    issues.push(...page.issues);
    if (issues.length > limits.maxScan) {
      throw new JqlFunctionError(
        `${name}(): the inner query matches more than ${limits.maxScan} issues. Narrow it, or move the condition into a script.`,
      );
    }
    token = page.nextPageToken || undefined;
  } while (token);
  return issues;
}

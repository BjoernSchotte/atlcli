/**
 * `audit wiki` over rule scripts. The host turns the sync database (and,
 * when asked, the remote space and external URLs) into one snapshot per
 * page; every rule, built-in or a team's own, judges the pages in the
 * script sandbox. Suppression and the report are the same as for Jira.
 */
import { type AuditRegistry, type AuditRules, type AuditSeverity, isRuleActive, isRuleOff, ruleTitle } from "./config.js";
import { type AuditBaseline, type AuditFinding, type AuditReportV3, buildReport, type CandidateFinding, sortCandidates } from "./report.js";
import { type AuditRuleScript, type RuleHit, type RunRuleOptions, runDataRule, runItemRule } from "./rules.js";

export interface AuditUser {
  id: string;
  displayName: string | null;
  /** null: not checked yet (`audit wiki --refresh-users`). */
  active: boolean | null;
}

/** What a Confluence rule gets per page (`AuditPage` in atlcli.d.ts). */
export interface AuditPage {
  id: string;
  title: string;
  spaceKey: string;
  /** Local file, relative to the sync root; null for a page not synced. */
  path: string | null;
  url?: string;
  /** False for a page only in Confluence (`--include-remote`). */
  synced: boolean;
  parentId: string | null;
  ancestors: string[];
  contentType: string;
  /** current, draft, archived, … */
  status: string;
  version: number;
  versionCount: number;
  wordCount: number | null;
  createdAt: string | null;
  createdBy: AuditUser | null;
  lastModified: string | null;
  lastModifiedBy: AuditUser | null;
  labels: string[];
  restricted: boolean;
  /** No incoming links and no parent. */
  orphan: boolean;
  brokenLinks: Array<{ target: string | null; text: string | null; line: number | null }>;
  externalLinks: Array<{ url: string; domain: string; text: string | null; line: number | null; httpStatus?: number | "error"; httpError?: string; broken?: boolean }>;
  contributors: AuditUser[];
}

export interface FolderIssue {
  file: string;
  code: string;
  message: string;
}

export interface ConfluenceAuditInput {
  rules: AuditRules;
  registry: AuditRegistry;
  /** Loaded rule scripts for Confluence, in registry order. */
  scripts: AuditRuleScript[];
  pages: AuditPage[];
  folderIssues: FolderIssue[];
  now: Date;
  baseline?: AuditBaseline;
  useBaseline: boolean;
  partial?: string[];
  diagnostics?: string[];
  /** The space and scope, for the report. */
  query: string;
}

/** Runs every active Confluence rule and builds the report; `candidates` are all findings before suppression. */
export async function auditConfluence(input: ConfluenceAuditInput, run: RunRuleOptions): Promise<{ report: AuditReportV3; candidates: AuditFinding[] }> {
  const { rules, registry } = input;
  const byId = new Map(input.pages.map((p) => [p.id, p]));
  const raw: CandidateFinding[] = [];
  for (const script of input.scripts) {
    const id = script.meta.id;
    if (!isRuleActive(rules, id, registry)) continue;
    const config = rules.rules[id] ?? {};
    const level = (config.level as AuditSeverity | undefined) ?? "warning";
    if (script.meta.scope === "run") {
      const hits = await runDataRule(script, { pages: input.pages, folderIssues: input.folderIssues, now: input.now.getTime() }, config, run);
      for (const hit of hits) raw.push({ finding: assemble(script, hit, hit.key ? byId.get(hit.key) : undefined, level) });
      continue;
    }
    if (isRuleOff(config, id, registry)) continue;
    const entries = input.pages.map((page) => ({ item: page, config }));
    for (const { index, hits } of await runItemRule(script, entries, run)) {
      for (const hit of hits) raw.push({ finding: assemble(script, hit, input.pages[index], level) });
    }
  }
  const order = new Map(registry.ids().map((id, i) => [id, i]));
  const candidates = sortCandidates(raw, (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER);
  const report = buildReport({
    product: "confluence",
    query: input.query,
    rules,
    now: input.now,
    candidates,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    useBaseline: input.useBaseline,
    partial: input.partial ?? [],
    diagnostics: input.diagnostics ?? [],
    titles: Object.fromEntries(registry.ids().map((id) => [id, ruleTitle(id, registry)])),
  });
  return { report, candidates: candidates.map((c) => c.finding) };
}

function assemble(script: AuditRuleScript, hit: RuleHit, page: AuditPage | undefined, level: AuditSeverity): AuditFinding {
  const key = page?.id ?? hit.key ?? "";
  return {
    rule: script.meta.id,
    category: script.def.category,
    severity: hit.severity ?? level,
    target: page ? { kind: "page", key, ...(page.url ? { url: page.url } : {}) } : { kind: "other", key },
    key,
    summary: hit.summary ?? page?.title ?? "",
    status: hit.status ?? page?.status ?? "",
    ...((hit.assignee ?? page?.createdBy?.displayName) ? { assignee: (hit.assignee ?? page?.createdBy?.displayName)! } : {}),
    detail: hit.detail,
    ...(hit.ageDays !== undefined ? { ageDays: Math.floor(hit.ageDays) } : {}),
    subject: hit.subject ?? key,
    ...(script.hasFix ? { fixable: true } : {}),
  };
}

/**
 * `audit jira` over rule scripts. The host prepares the issues and the facts
 * no single issue holds (flow percentiles from the done issues, open sprints,
 * project versions, when an issue was flagged); every rule, built-in or a
 * team's own, then judges the issues in the script sandbox. Suppression and
 * the report are the same for every rule.
 */
import { buildIssueFlowTimeline, FLOW_MIN_PERCENTILE_SAMPLES, percentile, type JiraIssue, type StatusCategoryResolver } from "@atlcli/jira";
import {
  type AuditRegistry,
  type AuditRuleConfig,
  type AuditRules,
  type AuditSeverity,
  effectiveRule,
  isRuleActive,
  isRuleOff,
  ruleTitle,
} from "./config.js";
import { type AuditBaseline, type AuditFinding, type AuditReportV3, buildReport, type CandidateFinding, sortCandidates } from "./report.js";
import { type AuditRuleScript, type RuleEntry, type RuleHit, type RunRuleOptions, runDataRule, runItemRule } from "./rules.js";

export interface JiraAuditInput {
  rules: AuditRules;
  registry: AuditRegistry;
  /** Loaded rule scripts for Jira, in registry order. */
  scripts: AuditRuleScript[];
  open: JiraIssue[];
  done: JiraIssue[];
  resolve: StatusCategoryResolver;
  now: Date;
  /** Story-points field; without it the unestimated rule is skipped. */
  pointsField?: string;
  /** Keys of open issues in an open or active sprint; undefined when sprints could not be read. */
  inOpenSprint?: Set<string>;
  /** Project keys that have at least one version. */
  projectsUsingVersions: Set<string>;
  /** Resolved issues outside the Done category, with their status and resolution history. */
  resolvedNotDone?: { issues: JiraIssue[]; truncated: boolean };
  /** The Flagged field id; undefined skips `hygiene/flagged`. */
  flaggedField?: string;
  /** Custom (YAML) rule id → its hits. */
  custom?: Map<string, JiraIssue[]>;
  /** Per override index: the keys its `jql` matched. */
  jqlMatches?: Array<Set<string> | undefined>;
  baseline?: AuditBaseline;
  useBaseline: boolean;
  partial?: string[];
  query: string;
  /** Site URL for issue links. */
  baseUrl?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const isEpic = (issue: JiraIssue): boolean => {
  const type = issue.fields.issuetype as { name?: string; hierarchyLevel?: number } | undefined;
  return type?.hierarchyLevel === 1 || type?.name?.toLowerCase() === "epic";
};
const isSubtask = (issue: JiraIssue): boolean => {
  const type = issue.fields.issuetype as { subtask?: boolean; hierarchyLevel?: number } | undefined;
  return type?.subtask === true || type?.hierarchyLevel === -1;
};
const present = (value: unknown): boolean => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

/** When the Flagged field was last set, from the changelog. */
function flaggedSince(issue: JiraIssue, field: string): string | undefined {
  let since: string | undefined;
  const histories = [...(issue.changelog?.histories ?? [])].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  for (const history of histories) {
    for (const item of history.items) {
      const id = (item as { fieldId?: string }).fieldId;
      if (id !== field && item.field.toLowerCase() !== "flagged") continue;
      const to = Object.hasOwn(item, "toString") ? item.toString : null;
      since = present(to) ? history.created : undefined;
    }
  }
  return since;
}

/** Percentile thresholds a config uses (`p85` → 85). */
const percentilesIn = (config: AuditRuleConfig): number[] =>
  Object.values(config.thresholds ?? {}).flatMap((t) => ("percentile" in t ? [t.percentile] : []));

/**
 * Runs every active Jira rule and builds the report. `candidates` are all
 * findings before baseline, legacy and min level (for `--update-baseline`).
 */
export async function auditJira(input: JiraAuditInput, run: RunRuleOptions): Promise<{ report: AuditReportV3; candidates: AuditFinding[] }> {
  const { rules, registry, now } = input;
  const nowMs = now.getTime();
  const diagnostics: string[] = [];
  const raw: CandidateFinding[] = [];
  const active = (id: string) => isRuleActive(rules, id, registry);
  const config = (id: string, issue: JiraIssue): AuditRuleConfig =>
    effectiveRule(
      rules,
      id,
      {
        key: issue.key,
        project: issue.fields.project?.key,
        issueType: issue.fields.issuetype as { id?: string; name?: string } | undefined,
        status: issue.fields.status ?? undefined,
      },
      registry,
      input.jqlMatches,
    );

  // Reference sets from the done issues (epics left out): cycle times, and the time spent per status.
  const doneTimelines = input.done.filter((i) => !isEpic(i)).map((i) => buildIssueFlowTimeline(i, input.resolve));
  const cycle = sorted(
    doneTimelines.flatMap((t) => (t.startedAt && t.doneAt && t.unknownStatuses.length === 0 ? [(Date.parse(t.doneAt) - Date.parse(t.startedAt)) / DAY_MS] : [])),
  );
  const inStatus = new Map<string, number[]>();
  for (const t of doneTimelines) {
    for (const interval of t.intervals) {
      if (!interval.to || !interval.statusId || interval.category === "done") continue;
      inStatus.set(interval.statusId, [...(inStatus.get(interval.statusId) ?? []), (Date.parse(interval.to) - Date.parse(interval.from)) / DAY_MS]);
    }
  }
  for (const [id, list] of inStatus) inStatus.set(id, sorted(list));
  const pct = (samples: number[], ps: number[]) =>
    samples.length >= FLOW_MIN_PERCENTILE_SAMPLES ? Object.fromEntries(ps.map((p) => [p, percentile(samples, p)])) : {};

  // Open issues and what the rules need to know about each.
  const open = input.open
    .map((issue) => {
      const timeline = buildIssueFlowTimeline(issue, input.resolve);
      const current = timeline.intervals[timeline.intervals.length - 1];
      return { issue, timeline, current };
    })
    .filter((o) => o.timeline.currentCategory !== "done");
  const baseFacts = (o: (typeof open)[number]) => ({
    category: o.timeline.currentCategory,
    epic: isEpic(o.issue),
    subtask: isSubtask(o.issue),
    startedAt: o.timeline.startedAt ?? null,
    created: o.timeline.created,
    currentFrom: o.current?.from ?? null,
    statusId: o.issue.fields.status?.id ?? o.current?.statusId ?? null,
    statusName: o.issue.fields.status?.name ?? o.current?.statusName ?? null,
    inOpenSprint: input.inOpenSprint ? input.inOpenSprint.has(o.issue.key) : null,
    ...(input.pointsField ? { points: (o.issue.fields as unknown as Record<string, unknown>)[input.pointsField] ?? null } : {}),
    ...(input.flaggedField
      ? { flagged: present((o.issue.fields as unknown as Record<string, unknown>)[input.flaggedField]), flaggedSince: flaggedSince(o.issue, input.flaggedField) ?? null }
      : {}),
  });

  let stuckSkipped = false;
  const agingSkipped = new Set<string>();
  const doneItems = input.done;

  for (const script of input.scripts) {
    const id = script.meta.id;
    if (!active(id)) continue;
    if (script.meta.scope === "run") {
      if (script.meta.items === "resolved-not-done") {
        if (!input.resolvedNotDone) continue;
        const entries = input.resolvedNotDone.issues
          .filter((issue) => issue.fields.status && input.resolve(issue.fields.status) !== "done")
          .map((issue) => ({ issue, config: config(id, issue) }))
          .filter((e) => !isRuleOff(e.config, id, registry));
        if (!entries.length) continue;
        const hits = await runDataRule(script, { entries, truncated: input.resolvedNotDone.truncated }, rules.rules[id] ?? {}, run);
        for (const hit of hits) raw.push({ finding: assemble(script, hit, undefined, "warning") });
      } else {
        const hits = await runDataRule(script, { open: open.map((o) => o.issue), done: doneItems, now: nowMs }, rules.rules[id] ?? {}, run);
        for (const hit of hits) raw.push({ finding: assemble(script, hit, undefined, (rules.rules[id]?.level as AuditSeverity) ?? "warning"), ...(hit.updated ? { updated: hit.updated } : {}) });
      }
      continue;
    }
    const source = script.meta.items === "done" ? doneItems.map((issue) => ({ issue, facts: { projectUsesVersions: input.projectsUsingVersions.has(issue.fields.project?.key ?? "") } })) : open.map((o) => ({ issue: o.issue, facts: baseFacts(o), o }));
    const entries: Array<RuleEntry & { issue: JiraIssue }> = [];
    for (const s of source) {
      const c = config(id, s.issue);
      if (isRuleOff(c, id, registry)) continue;
      const facts: Record<string, unknown> = { ...s.facts };
      const ps = percentilesIn(c);
      if (ps.length && "o" in s && s.o && script.meta.needs.includes("cycle-percentiles")) {
        facts.percentiles = pct(cycle, ps);
        if (s.o.timeline.currentCategory === "wip" && !isEpic(s.issue) && cycle.length < FLOW_MIN_PERCENTILE_SAMPLES) stuckSkipped = true;
      }
      if (ps.length && "o" in s && s.o && script.meta.needs.includes("status-percentiles")) {
        const samples = (s.facts.statusId ? inStatus.get(String(s.facts.statusId)) : undefined) ?? [];
        facts.percentiles = pct(samples, ps);
        if (s.o.timeline.currentCategory === "wip" && !isEpic(s.issue) && samples.length < FLOW_MIN_PERCENTILE_SAMPLES) agingSkipped.add(String(s.facts.statusName ?? "?"));
      }
      entries.push({ item: s.issue, config: c, facts, issue: s.issue });
    }
    if (script.meta.needs.includes("points") && !input.pointsField) continue;
    if (script.meta.needs.includes("sprint") && !input.inOpenSprint) continue;
    if (script.meta.needs.includes("flagged") && !input.flaggedField) continue;
    for (const { index, hits } of await runItemRule(script, entries, run)) {
      const e = entries[index]!;
      for (const hit of hits) raw.push({ finding: assemble(script, hit, e.issue, e.config.level as AuditSeverity), updated: hit.updated ?? e.issue.fields.updated ?? e.issue.fields.created });
    }
  }

  if (stuckSkipped) diagnostics.push(`flow/stuck-wip percentiles skipped: ${cycle.length} completed issue(s) with a cycle time, need ${FLOW_MIN_PERCENTILE_SAMPLES}.`);
  if (agingSkipped.size) {
    diagnostics.push(`flow/status-aging percentiles skipped for ${[...agingSkipped].map((s) => `"${s}"`).join(", ")}: fewer than ${FLOW_MIN_PERCENTILE_SAMPLES} done issues passed through.`);
  }
  for (const script of input.scripts) {
    const id = script.meta.id;
    if (!active(id)) continue;
    if (script.meta.needs.includes("points") && !input.pointsField) diagnostics.push(`${id} skipped: no story points field detected.`);
    else if (script.meta.needs.includes("sprint") && !input.inOpenSprint) diagnostics.push(`${id} skipped: open sprints could not be read.`);
    if (script.meta.needs.includes("flagged") && !input.flaggedField) diagnostics.push(`${id} skipped: no Flagged field found (set flagged.field in the rules file).`);
  }

  for (const rule of rules.custom) {
    for (const issue of input.custom?.get(rule.id) ?? []) {
      const c = config(rule.id, issue);
      if (isRuleOff(c, rule.id, registry)) continue;
      raw.push({
        finding: issueFinding(issue, { rule: rule.id, category: "custom", severity: c.level as AuditSeverity, detail: rule.message }, input.baseUrl),
        updated: issue.fields.updated ?? issue.fields.created,
      });
    }
  }

  const order = new Map([...registry.ids(), ...rules.custom.map((c) => c.id)].map((id, i) => [id, i]));
  const candidates = sortCandidates(raw, (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER);
  const titles = Object.fromEntries([...registry.ids(), ...rules.custom.map((c) => c.id)].map((id) => [id, ruleTitle(id, registry, rules.custom)]));
  const report = buildReport({
    product: "jira",
    query: input.query,
    rules,
    now,
    candidates,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    useBaseline: input.useBaseline,
    partial: input.partial ?? [],
    diagnostics,
    titles,
    noLegacy: ["workflow"],
  });
  return { report, candidates: candidates.map((c) => c.finding) };

  function assemble(script: AuditRuleScript, hit: RuleHit, issue: JiraIssue | undefined, level: AuditSeverity): AuditFinding {
    const base = {
      rule: script.meta.id,
      category: script.def.category,
      severity: hit.severity ?? level,
      detail: hit.detail,
      ...(hit.ageDays !== undefined ? { ageDays: hit.ageDays } : {}),
      ...(script.hasFix ? { fixable: true } : {}),
    };
    if (issue) {
      const f = issueFinding(issue, base, input.baseUrl);
      return { ...f, ...overrides(hit) };
    }
    const key = hit.key ?? "";
    return {
      ...base,
      target: { kind: hit.subject?.startsWith("status:") ? "status" : "issue", key, ...(input.baseUrl && key ? { url: `${input.baseUrl}/browse/${key}` } : {}) },
      key,
      summary: hit.summary ?? "",
      status: hit.status ?? "",
      ...(hit.assignee ? { assignee: hit.assignee } : {}),
      subject: hit.subject ?? key,
      ...(hit.ageDays !== undefined ? { ageDays: Math.floor(hit.ageDays) } : {}),
    };
  }
}

const overrides = (hit: RuleHit): Partial<AuditFinding> => ({
  ...(hit.summary !== undefined ? { summary: hit.summary } : {}),
  ...(hit.status !== undefined ? { status: hit.status } : {}),
  ...(hit.subject !== undefined ? { subject: hit.subject } : {}),
});

/** A finding about one issue. */
function issueFinding(
  issue: JiraIssue,
  f: { rule: string; category: string; severity: AuditSeverity; detail: string; ageDays?: number; fixable?: boolean },
  baseUrl: string | undefined,
): AuditFinding {
  return {
    rule: f.rule,
    category: f.category,
    severity: f.severity,
    target: { kind: "issue", key: issue.key, ...(baseUrl ? { url: `${baseUrl}/browse/${issue.key}` } : {}) },
    key: issue.key,
    summary: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    ...(issue.fields.assignee?.displayName ? { assignee: issue.fields.assignee.displayName } : {}),
    detail: f.detail,
    ...(f.ageDays !== undefined ? { ageDays: Math.floor(f.ageDays) } : {}),
    subject: issue.key,
    ...(f.fixable ? { fixable: true } : {}),
  };
}

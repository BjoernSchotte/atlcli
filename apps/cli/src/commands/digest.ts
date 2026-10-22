/**
 * `atlcli digest` (spec digest-flow-metrics B1): what changed since X and
 * what waits on me, across Jira and Confluence, in a bounded number of
 * requests. This file is the IO shell; everything else is in digest-core.ts.
 */
import { readFile } from "node:fs/promises";
import {
  ERROR_CODES,
  type OutputOptions,
  getFlagValue,
  type Profile,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDefaults,
} from "@atlcli/core";
import { ConfluenceClient, type ConfluenceSearchResult } from "@atlcli/confluence";
import {
  type AuditRules,
  JiraClient,
  type JiraAuditBaseline,
  digestAuditRules,
  isRuleActive,
  type StatusCategoryResolver,
  createStatusCategoryResolver,
  parseAuditBaseline,
  parseStatusMap,
  resolveStatusMap,
  statusScopeJql,
} from "@atlcli/jira";
import { assertCliAuthSupported } from "./session-guard.js";
import { profileFilePath, writeJsonAtomic } from "./profile-paths.js";
import { searchAll } from "./jira-flow.js";
import { auditBaselinePath, collectJiraAudit, loadAuditRules } from "./audit-jira.js";
import {
  DIGEST_COMMENT_PAGES,
  type DigestProduct,
  type DigestRawInput,
  type DigestRawSprint,
  type DigestSince,
  type DigestState,
  anySectionSucceeded,
  buildCommentsCql,
  buildDigest,
  buildDigestQueries,
  digestItemCount,
  nextDigestState,
  projectsJql,
  parseDigestState,
  renderDigestMarkdown,
  renderDigestText,
  resolveDigestSince,
  sinceMinutes,
  succeededProducts,
} from "./digest-core.js";

type Flags = Record<string, string | boolean | string[]>;

const SECRET_FLAGS = ["api-key", "apikey", "anthropic-key", "key"];
const COMMENT_READ_CONCURRENCY = 5;
/** Changed issues read per run for the project overview (all projects together). */
export const DIGEST_PROJECT_FETCH = 200;
/** Open issues the digest's audit section reads across its projects. */
export const DIGEST_AUDIT_LIMIT = 300;

/** `~/.atlcli/profiles/<profile>/digest-state.json`; `homedir()` is read at call time. */
export function digestStatePath(profile: string): string {
  return profileFilePath(profile, "digest-state.json");
}

async function readState(path: string): Promise<{ state: DigestState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { state: { schemaVersion: 2 } };
  }
  try {
    return { state: parseDigestState(JSON.parse(text)) };
  } catch {
    return { state: { schemaVersion: 2 }, warning: `${path} is unreadable; treated as no previous run.` };
  }
}


function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs one section; a failure becomes a warning instead of failing the digest. */
function sectionRunner(product: DigestProduct, errors: DigestRawInput["errors"]) {
  return async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push({ section: `${product}.${name}`, message: message(err) });
      return undefined;
    }
  };
}

async function fetchJira(
  client: JiraClient,
  minutes: number,
  opts: {
    board?: number;
    fetchLimit: number;
    projects: string[];
    statusMap: Record<string, "todo" | "wip" | "done">;
    /** Rules for the "Audit" section, already cut to the digest (`digestAuditRules`). */
    audit?: { rules: AuditRules; baseline?: JiraAuditBaseline };
  },
  raw: DigestRawInput
): Promise<{ projectsTruncated: boolean }> {
  const run = sectionRunner("jira", raw.errors);
  // Statuses are read only when a status map or the project overview needs them.
  const needStatuses = opts.projects.length > 0 || Object.keys(opts.statusMap).length > 0;
  const scope = needStatuses
    ? await run("statuses", async () => {
        const statuses = await client.getStatuses();
        const resolve: StatusCategoryResolver = createStatusCategoryResolver(statuses, opts.statusMap);
        return { resolve, ...statusScopeJql(statuses, resolve) };
      })
    : undefined;
  const q = buildDigestQueries({ minutes, projects: opts.projects, open: scope?.open });
  if (raw.queries) {
    Object.assign(raw.queries, {
      "jira.waiting": q.waiting,
      "jira.changed": q.changed,
      ...(q.projects ? { "jira.projects": q.projects } : {}),
    });
  }
  let projectsTruncated = false;
  const audit = opts.audit;
  const [me, waiting, changed, sprints, project, auditResult] = await Promise.all([
    run("me", () => client.getCurrentUser()),
    run("waiting", async () => (await client.search(q.waiting, { fields: ["summary", "status", "priority"], maxResults: opts.fetchLimit })).issues),
    run("changed", async () => {
      const { issues } = await client.search(q.changed, {
        fields: ["summary", "status", "priority", "assignee", "reporter", "updated"],
        maxResults: opts.fetchLimit,
      });
      // Data Center has no bulk changelog; the issues are listed without change details.
      const changelogs = client.isCloudSite && issues.length ? await client.getChangelogs(issues) : undefined;
      return { issues, changelogs };
    }),
    opts.board === undefined
      ? Promise.resolve(undefined)
      : run("sprints", async () => {
          // Kanban and simple boards have no sprints; asking would be a 400.
          if ((await client.getBoard(opts.board!)).type !== "scrum") return [];
          const active = await client.listSprints(opts.board!, { state: "active" });
          return Promise.all(
            active.values.map(async (sprint): Promise<DigestRawSprint> => {
              const issues = await client.getAllSprintIssues(sprint.id, { fields: ["status", "assignee"] });
              return { id: sprint.id, name: sprint.name, endDate: sprint.endDate, issues };
            })
          );
        }),
    q.projects
      ? run("projects", async () => {
          const result = await searchAll(
            client,
            q.projects!,
            ["summary", "status", "priority", "assignee", "created", "updated", "project"],
            DIGEST_PROJECT_FETCH
          );
          projectsTruncated = result.truncated;
          const changelogs = client.isCloudSite && result.issues.length ? await client.getChangelogs(result.issues) : undefined;
          return { issues: result.issues, changelogs };
        })
      : Promise.resolve(undefined),
    audit && scope && q.projects && Object.keys(audit.rules.rules).some((id) => isRuleActive(audit.rules, id))
      ? run("audit", async () => {
          const { report } = await collectJiraAudit(client, { base: projectsJql(opts.projects), rules: audit.rules, scope, limit: DIGEST_AUDIT_LIMIT, baseline: audit.baseline, useBaseline: true });
          return report;
        })
      : Promise.resolve(undefined),
  ]);
  raw.me.jiraAccountId = me?.accountId;
  raw.me.displayName ??= me?.displayName;
  raw.jira = {
    waiting,
    changed: changed?.issues,
    changelogs: changed?.changelogs,
    sprints,
    ...(opts.projects.length
      ? { projectKeys: opts.projects, projectIssues: project?.issues, projectChangelogs: project?.changelogs }
      : {}),
    ...(scope ? { resolve: scope.resolve } : {}),
    ...(auditResult ? { audit: { findings: auditResult.findings, partial: auditResult.partial } } : {}),
  };
  return { projectsTruncated };
}

async function fetchConfluence(
  client: ConfluenceClient,
  minutes: number,
  opts: { space?: string; fetchLimit: number; maxPages: number },
  raw: DigestRawInput
): Promise<void> {
  const run = sectionRunner("confluence", raw.errors);
  const q = buildDigestQueries({ minutes, space: opts.space });
  const search = (cql: string, limit = opts.fetchLimit, expand?: string[]) =>
    client.search(cql, { limit, expand }).then((r) => r.results);

  const myPages = run("comments", () => client.search(q.myPageIds, { limit: DIGEST_COMMENT_PAGES, detail: "minimal" }).then((r) => r.results));
  const commentsCql = myPages.then((pages) => (pages ? buildCommentsCql(pages.map((p) => p.id), minutes) : undefined));
  const [me, mentions, myPagesEdited, watched, recent, comments, openInline] = await Promise.all([
    run("me", () => client.getCurrentUser()),
    run("mentions", () => search(q.mentions, opts.fetchLimit, ["container"])),
    run("myPagesEdited", () => search(q.myPagesEdited)),
    run("watched", () => search(q.watched)),
    q.recent ? run("recent", () => search(q.recent!)) : Promise.resolve(undefined),
    commentsCql.then((cql) =>
      cql ? run("comments", () => search(cql, opts.fetchLimit, ["container", "extensions.resolution"])) : myPages.then((p) => (p ? [] : undefined))
    ),
    myPages.then((pages) =>
      pages
        ? run("openInline", async () => {
            const out: ConfluenceSearchResult[] = [];
            const top = pages.slice(0, opts.maxPages);
            for (let i = 0; i < top.length; i += COMMENT_READ_CONCURRENCY) {
              const wave = await Promise.all(
                top.slice(i, i + COMMENT_READ_CONCURRENCY).map((page) =>
                  client.listPageCommentsV1(page.id, { location: "inline", limit: 50 })
                )
              );
              out.push(...wave.flat());
            }
            return out;
          })
        : (raw.errors.push({ section: "confluence.openInline", message: "your pages could not be read" }), undefined)
    ),
  ]);
  if (raw.queries) {
    Object.assign(raw.queries, {
      "confluence.mentions": q.mentions,
      "confluence.myPagesEdited": q.myPagesEdited,
      "confluence.myPageIds": q.myPageIds,
      "confluence.watched": q.watched,
      ...(q.recent ? { "confluence.recent": q.recent } : {}),
      ...((await commentsCql) ? { "confluence.comments": (await commentsCql)! } : {}),
    });
  }
  raw.me.confluenceAccountId = me?.accountId;
  raw.me.displayName ??= me?.displayName;
  raw.confluence = { mentions, myPagesEdited, comments, openInline, watched, recent };
}

function positiveInt(flags: Flags, name: string, fallback: number, opts: OutputOptions): number {
  const raw = getFlag(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(opts, 1, ERROR_CODES.USAGE, `--${name} must be a positive integer.`);
  return n;
}

export async function handleDigest(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (args[0] === "help" || hasFlag(flags, "help")) {
    output(digestHelp(), opts);
    return;
  }
  if (SECRET_FLAGS.some((key) => hasFlag(flags, key))) {
    fail(opts, 1, ERROR_CODES.USAGE, "Anthropic API keys are never accepted as command-line flags. Set ANTHROPIC_API_KEY in the process environment.");
  }
  const only = getFlag(flags, "only");
  if (only !== undefined && only !== "jira" && only !== "confluence") {
    fail(opts, 1, ERROR_CODES.USAGE, "--only must be jira or confluence.");
  }
  const products: DigestProduct[] = only ? [only] : ["jira", "confluence"];
  const limit = positiveInt(flags, "limit", 10, opts);
  const maxPages = positiveInt(flags, "max-pages", 10, opts);
  const verbose = hasFlag(flags, "verbose");

  const config = await loadConfig();
  const profile: Profile | undefined = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  const defaults = resolveDefaults(config, profile);
  const space = getFlag(flags, "space") ?? defaults.space;
  const boardRaw = getFlag(flags, "board") ?? (defaults.board !== undefined ? String(defaults.board) : undefined);
  const board = boardRaw === undefined ? undefined : Number(boardRaw);
  if (board !== undefined && !Number.isInteger(board)) fail(opts, 1, ERROR_CODES.USAGE, "--board must be a board id.");
  const projectFlag = getFlag(flags, "project");
  const projects = projectFlag !== undefined
    ? projectFlag.split(",").map((p) => p.trim()).filter(Boolean)
    : (profile.digest?.projects ?? config.digest?.projects ?? []);
  let flagMap: ReturnType<typeof parseStatusMap> | undefined;
  const mapSpec = getFlag(flags, "status-map");
  if (mapSpec !== undefined) {
    try {
      flagMap = parseStatusMap(mapSpec);
    } catch (err) {
      fail(opts, 1, ERROR_CODES.USAGE, message(err));
    }
  }
  const statusMap = resolveStatusMap(config.flow?.statusMap, profile.flow?.statusMap, flagMap);

  // The "Audit" section: errors from the audit rules for the digest's projects, when audit is enabled.
  let audit: { rules: AuditRules; baseline?: JiraAuditBaseline } | undefined;
  const auditErrors: DigestRawInput["errors"] = [];
  if (projects.length && products.includes("jira") && (await getFlagValue<boolean>("audit", false))) {
    try {
      const rules = digestAuditRules(await loadAuditRules(profile, config.audit?.jira?.staleDays));
      let baseline: JiraAuditBaseline | undefined;
      try {
        baseline = parseAuditBaseline(JSON.parse(await readFile(auditBaselinePath(profile.name), "utf8")));
      } catch {
        // No baseline (or an unreadable one): nothing accepted.
      }
      audit = { rules, baseline };
    } catch (err) {
      auditErrors.push({ section: "jira.audit", message: message(err) });
    }
  }

  const statePath = digestStatePath(profile.name);
  const { state, warning: stateWarning } = await readState(statePath);
  const runStartedAt = new Date();
  const sinceFlag = getFlag(flags, "since");
  const since: Partial<Record<DigestProduct, DigestSince>> = {};
  try {
    for (const product of products) {
      const last = state[product]?.lastRunAt;
      since[product] = resolveDigestSince(sinceFlag, runStartedAt, last ? new Date(last) : undefined);
    }
  } catch (err) {
    fail(opts, 1, ERROR_CODES.USAGE, message(err));
  }
  // The header shows the earliest window; each product queries its own.
  const headerSince = products.map((p) => since[p]!).sort((a, b) => a.at.getTime() - b.at.getTime())[0];

  let requests = 0;
  const count = (event: { type: string }) => {
    if (event.type === "attempt") requests++;
  };
  const raw: DigestRawInput = {
    profile: profile.name,
    since: headerSince,
    products,
    me: {},
    jiraBaseUrl: undefined,
    jira: {},
    confluence: {},
    errors: [...(stateWarning ? [{ section: "state", message: stateWarning }] : []), ...auditErrors],
    ...(verbose || opts.json ? { queries: {} } : {}),
  };
  const fetchLimit = 2 * limit + 1;
  const tasks: Promise<unknown>[] = [];
  let projectsTruncated = false;
  if (products.includes("jira")) {
    const jira = new JiraClient(profile, { observeTransport: count });
    raw.jiraBaseUrl = jira.siteUrl;
    tasks.push(
      fetchJira(jira, sinceMinutes(since.jira!, runStartedAt), { board, fetchLimit, projects, statusMap, audit }, raw).then((r) => {
        projectsTruncated = r.projectsTruncated;
      })
    );
  }
  if (products.includes("confluence")) {
    const confluence = new ConfluenceClient(profile, { observeTransport: count });
    tasks.push(fetchConfluence(confluence, sinceMinutes(since.confluence!, runStartedAt), { space, fetchLimit, maxPages }, raw));
  }
  await Promise.all(tasks);

  const now = new Date();
  const digest = buildDigest(raw, { now, includeOwn: hasFlag(flags, "include-own"), limit });
  if (projectsTruncated) digest.truncated.push(`jira.projects (more than ${DIGEST_PROJECT_FETCH} changed issues read)`);

  if (hasFlag(flags, "summarize")) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      digest.warnings.push({ section: "summary", message: "ANTHROPIC_API_KEY is not set; no summary." });
    } else {
      process.stderr.write(`Sending digest (${digestItemCount(digest)} items: keys, titles, statuses, names) to Anthropic.\n`);
      try {
        const { summarizeDigestV1 } = await import("@atlcli/research/node");
        digest.summary = await summarizeDigestV1({ apiKey, markdown: renderDigestMarkdown(digest, now) });
      } catch (err) {
        digest.warnings.push({ section: "summary", message: `Summary failed: ${message(err)}` });
      }
    }
  }

  if (opts.json) {
    output(digest, opts);
  } else {
    output(hasFlag(flags, "markdown") ? renderDigestMarkdown(digest, now).trimEnd() : renderDigestText(digest, now), opts);
  }
  if (verbose) {
    for (const [name, query] of Object.entries(raw.queries ?? {})) process.stderr.write(`${name}: ${query}\n`);
    process.stderr.write(`${requests} request(s) in ${now.getTime() - runStartedAt.getTime()} ms\n`);
  }

  const succeeded = succeededProducts(digest, products);
  const next = nextDigestState(state, {
    runStartedAt,
    succeeded,
    sinceSources: Object.fromEntries(products.map((p) => [p, since[p]!.source])),
    noMark: hasFlag(flags, "no-mark"),
  });
  if (JSON.stringify(next) !== JSON.stringify({ ...state, schemaVersion: 2 })) {
    try {
      await writeJsonAtomic(statePath, next);
    } catch (err) {
      process.stderr.write(`Warning: could not write ${statePath}: ${message(err)}\n`);
    }
  }

  if (!anySectionSucceeded(raw)) process.exit(1);
}

export function digestHelp(): string {
  return `Usage: atlcli digest [options]

What changed since your last look, and what waits on you, across Jira and Confluence.

Sections:
  Jira         Waiting on you · Changed (your issues and watched ones) · Active sprint
  Projects     Per project: completed · created · changed, by anyone (--project, digest.projects)
  Audit        Error findings of the audit rules for those projects (when audit is enabled)
  Confluence   Mentions · Comments on your pages · Open inline comments ·
               Your pages edited · Watched pages changed · Recently changed in space

Options:
  --since <when>       lastrun (default), 24h, 7d, 90m, today, yesterday, or an ISO date.
                       m means minutes. Without a previous run: 24h. At most 30 days.
  --only <product>     jira or confluence
  --space <keys>       Space(s) for "Recently changed in space" (default: defaults.space)
  --board <id>         Board for the active sprint (default: defaults.board; kanban boards
                       have no sprint and are skipped)
  --project <keys>     Projects for the overview, comma-separated (default: digest.projects)
  --status-map <map>   Override status categories, e.g. "Fertig=done" (config flow.statusMap)
  --limit <n>          Items per section (default: 10)
  --max-pages <n>      Your pages checked for open inline comments (default: 10)
  --include-own        Keep your own edits and comments
  --no-mark            Do not move the last-run marker
  --markdown           Markdown output (for a standup note)
  --summarize          Add a short summary from Anthropic (needs ANTHROPIC_API_KEY;
                       sends keys, titles, statuses and names, never page or comment bodies)
  --verbose            Print every query and the request count to stderr
  --json               JSON output

The last-run marker lives in ~/.atlcli/profiles/<profile>/digest-state.json, one per
product. It only moves after a run with the default --since in which none of that
product's sections failed.

Examples:
  atlcli digest
  atlcli digest --since 7d --only jira
  atlcli digest --project GROW,ATLCLI --since 7d
  atlcli digest --markdown > standup.md
  atlcli digest --summarize`;
}

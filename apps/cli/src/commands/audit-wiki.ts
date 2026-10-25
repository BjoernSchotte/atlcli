/**
 * `audit wiki`: the checks are rule scripts (product "confluence") run in the
 * script sandbox over one snapshot per page, built here from the sync
 * database (plus the remote space with --include-remote and HTTP checks with
 * --check-external). Rules, suppression, baseline, --fix and the reports are
 * the same as for `audit jira` (audit-scripts.ts, @atlcli/audit).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AUDIT_SEVERITY_RANK,
  type AuditBaseline,
  type AuditPage,
  type AuditRules,
  AuditRulesError,
  AuditScriptError,
  type AuditSeverity,
  type AuditUser,
  applyRulePatch,
  auditConfluence,
  createAuditBaseline,
  parseAuditBaseline,
  parseConfluenceAuditRules,
  pruneAuditBaseline,
  renderAuditText,
  resolveAuditChecks,
  restrictAuditRules,
} from "@atlcli/audit";
import { ERROR_CODES, type OutputOptions, type Profile, fail, getActiveProfile, getFlag, hasFlag, loadConfig, output } from "@atlcli/core";
import {
  ConfluenceClient,
  type LinkRecord,
  type PageRecord,
  type SyncDbAdapter,
  createSyncDb,
  findAtlcliDir,
  getAtlcliPath,
  hasSyncDb,
  readConfig,
  validateFolders,
} from "@atlcli/confluence/internal";
import type { ScriptPort } from "@atlcli/script-runtime";
import { auditRulesCandidates } from "./audit-jira.js";
import { customAuditReport, emitAuditReport, handleRuleListing, loadAuditScripts, registryOf, runAuditFixes, scriptFlags } from "./audit-scripts.js";
import { writeJsonAtomic } from "./profile-paths.js";
import { assertCliAuthSupported } from "./session-guard.js";

type Flags = Record<string, string | boolean | string[]>;
const FAIL_ON = ["info", "warning", "error", "never"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;

// ============================================================================
// HTTP Link Checking
// ============================================================================

interface LinkCheckResult {
  url: string;
  status: number | "error";
  error?: string;
  isBroken: boolean;
}

/**
 * Check if a URL is accessible via HTTP HEAD request.
 * Falls back to GET if HEAD fails (some servers don't support HEAD).
 */
async function checkUrl(url: string, timeoutMs = 10000): Promise<LinkCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Try HEAD first (faster, less data)
    let response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "atlcli-link-checker/1.0",
      },
    });

    // Some servers return 405 for HEAD, try GET
    if (response.status === 405) {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "atlcli-link-checker/1.0",
        },
      });
    }

    clearTimeout(timeout);

    // Consider 4xx and 5xx as broken (except 401/403 which may just need auth)
    const isBroken = response.status >= 400 && response.status !== 401 && response.status !== 403;

    return {
      url,
      status: response.status,
      isBroken,
    };
  } catch (err) {
    clearTimeout(timeout);
    const rawMessage = err instanceof Error ? err.message : String(err);

    // Simplify common error messages
    let error: string;
    if (rawMessage.includes("abort")) {
      error = "Timeout";
    } else if (rawMessage.includes("ENOTFOUND") || rawMessage.includes("getaddrinfo")) {
      error = "DNS lookup failed";
    } else if (rawMessage.includes("ECONNREFUSED")) {
      error = "Connection refused";
    } else if (rawMessage.includes("ECONNRESET")) {
      error = "Connection reset";
    } else if (rawMessage.includes("unable to connect") || rawMessage.includes("Unable to connect")) {
      error = "Connection failed";
    } else if (rawMessage.includes("certificate")) {
      error = "SSL error";
    } else {
      error = "Connection failed";
    }

    return {
      url,
      status: "error",
      error,
      isBroken: true,
    };
  }
}

/**
 * Check multiple URLs concurrently with rate limiting.
 */
async function checkUrls(
  urls: string[],
  opts: { concurrency?: number; timeoutMs?: number; onProgress?: (checked: number, total: number) => void }
): Promise<Map<string, LinkCheckResult>> {
  const { concurrency = 5, timeoutMs = 10000, onProgress } = opts;
  const results = new Map<string, LinkCheckResult>();
  const uniqueUrls = [...new Set(urls)]; // Dedupe
  let checked = 0;

  // Process in batches
  for (let i = 0; i < uniqueUrls.length; i += concurrency) {
    const batch = uniqueUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((url) => checkUrl(url, timeoutMs))
    );

    for (const result of batchResults) {
      results.set(result.url, result);
      checked++;
    }

    if (onProgress) {
      onProgress(checked, uniqueUrls.length);
    }
  }

  return results;
}

// ============================================================================
// Rules: the rules file's confluence: section, the older check flags
// ============================================================================

/** Older flags that switch one rule on (flag name = the rule's `legacy` name). */
const CHECK_FLAGS = ["orphans", "broken-links", "single-contributor", "inactive-contributors", "external-links", "check-external", "restricted", "drafts", "archived", "folders"] as const;
/** What --all switches on. */
const ALL_CHECKS = ["stale", "orphans", "broken-links", "single-contributor", "inactive-contributors", "folders", "restricted", "drafts", "archived"];

/** A whole number of months from a flag or the config, or an error message. */
function months(value: unknown, name: string): number | string | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : `${name} must be a number (months)`;
}

/**
 * The older selection: check flags, --all, or audit.defaultChecks of the
 * config. Returns undefined when none is given (the rules file or the
 * built-in profile decides), else the legacy names to run and the patches
 * that go with them.
 */
export function legacySelection(
  flags: Flags,
  config: { defaultChecks?: string[]; staleThresholds?: { high?: number; medium?: number; low?: number } } | undefined,
): { checks: string[]; patches: Record<string, unknown> } | string | undefined {
  const stale = { high: getFlag(flags, "stale-high"), medium: getFlag(flags, "stale-medium"), low: getFlag(flags, "stale-low") };
  const explicit = [
    ...CHECK_FLAGS.filter((f) => hasFlag(flags, f)),
    ...(stale.high !== undefined || stale.medium !== undefined || stale.low !== undefined ? ["stale"] : []),
    ...(getFlag(flags, "missing-label") !== undefined ? ["missing-label"] : []),
    ...(getFlag(flags, "high-churn") !== undefined ? ["high-churn"] : []),
  ];
  // --check-external lists the external links with their status.
  if (explicit.includes("check-external")) explicit.push("external-links");
  const fromConfig = !hasFlag(flags, "all") && explicit.length === 0 ? (config?.defaultChecks ?? []) : [];
  const checks = [...new Set([...(hasFlag(flags, "all") ? ALL_CHECKS : []), ...explicit, ...fromConfig])];
  if (checks.length === 0) return undefined;

  const patches: Record<string, unknown> = {};
  const fromFlags = stale.high !== undefined || stale.medium !== undefined || stale.low !== undefined;
  const source = fromFlags ? stale : (config?.staleThresholds ?? {});
  const thresholds: Record<string, string> = {};
  for (const [level, key, name] of [["error", "high", "--stale-high"], ["warning", "medium", "--stale-medium"], ["info", "low", "--stale-low"]] as const) {
    const m = months((source as Record<string, unknown>)[key], fromFlags ? name : `audit.staleThresholds.${key}`);
    if (typeof m === "string") return m;
    thresholds[level] = m === undefined ? "off" : `${m * MONTH_DAYS}d`;
  }
  if (checks.includes("stale") && Object.values(thresholds).some((t) => t !== "off")) patches["content/stale"] = thresholds;
  const label = getFlag(flags, "missing-label");
  if (label !== undefined) patches["content/missing-label"] = { severity: "info", label: [label] };
  const churn = getFlag(flags, "high-churn");
  if (churn !== undefined) {
    const n = Number(churn);
    if (!Number.isInteger(n) || n < 1) return "--high-churn must be a number of versions";
    patches["content/high-churn"] = { info: n };
  }
  return { checks, patches };
}

export const WIKI_BASELINE_FILE = "audit-baseline.json";

/**
 * Rules for a wiki audit: the rules file's `confluence:` section (first found,
 * as for `audit jira`), else the built-in default profile; and the rule
 * scripts (built-ins, audit directories, the section's `scripts:`, --script).
 */
export async function loadWikiAuditSetup(profileName: string | undefined, rulesFlag: string | undefined, cwd: string, extra: string[]) {
  const candidates = profileName ? auditRulesCandidates(profileName, cwd) : [join(cwd, ".atlcli", "audit-rules.yaml")];
  const path = rulesFlag ? resolvePath(rulesFlag) : candidates.find((p) => existsSync(p));
  let parsed: unknown;
  if (path) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new AuditRulesError(`Cannot read the rules file ${path}.`);
    }
    try {
      parsed = parseYaml(text);
    } catch (err) {
      throw new AuditRulesError(`${path}: invalid YAML: ${(err as Error).message}`);
    }
  }
  const section = (parsed as { confluence?: { scripts?: unknown } } | undefined)?.confluence;
  const { scripts, diagnostics } = await loadAuditScripts("confluence", {
    cwd,
    ...(path && section?.scripts !== undefined
      ? { fileScripts: { base: resolvePath(path, ".."), paths: Array.isArray(section.scripts) ? section.scripts.map(String) : [String(section.scripts)] } }
      : {}),
    extra,
  });
  const registry = registryOf(scripts);
  try {
    const rules = parseConfluenceAuditRules(parsed ?? null, path ?? "built-in profile default", registry);
    return { scripts, registry, rules: path ? rules : { ...rules, source: "built-in profile default" }, diagnostics };
  } catch (err) {
    if (path && err instanceof AuditRulesError && !err.message.startsWith(path)) throw new AuditRulesError(`${path}: ${err.message}`);
    throw err;
  }
}

// ============================================================================
// Page snapshots
// ============================================================================

export interface SnapshotOptions {
  /** What the active rules need: links, http, contributors, remote, folders. */
  needs: Set<string>;
  baseUrl?: string;
  spaceKey: string | null;
  filterLabel?: string;
  filterAncestor?: string;
  excludeLabel?: string;
  /** For --include-remote. */
  client?: ConfluenceClient | null;
  /** For --check-external. */
  checkUrls?: (urls: string[]) => Promise<Map<string, LinkCheckResult>>;
}

const pageUrl = (baseUrl: string | undefined, id: string): string | undefined => {
  if (!baseUrl) return undefined;
  const root = baseUrl.replace(/\/+$/, "");
  const wiki = /\.atlassian\.net$/.test(new URL(root).hostname) && !root.endsWith("/wiki") ? `${root}/wiki` : root;
  return `${wiki}/pages/viewpage.action?pageId=${id}`;
};

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
};

function group(links: LinkRecord[]): Map<string, LinkRecord[]> {
  const by = new Map<string, LinkRecord[]>();
  for (const l of links) by.set(l.sourcePageId, [...(by.get(l.sourcePageId) ?? []), l]);
  return by;
}

/** One snapshot per page in scope: what every rule reads, so rules stay pure. */
export async function buildPageSnapshots(adapter: SyncDbAdapter, o: SnapshotOptions): Promise<{ pages: AuditPage[]; partial: string[] }> {
  const partial: string[] = [];
  let records = await adapter.listPages({});
  if (o.filterLabel) {
    const ids = new Set((await adapter.getPagesWithLabel(o.filterLabel)).map((p) => p.pageId));
    records = records.filter((p) => ids.has(p.pageId));
  }
  if (o.filterAncestor) records = records.filter((p) => p.ancestors?.includes(o.filterAncestor!) || p.parentId === o.filterAncestor);
  if (o.excludeLabel) {
    const ids = new Set((await adapter.getPagesWithLabel(o.excludeLabel)).map((p) => p.pageId));
    records = records.filter((p) => !ids.has(p.pageId));
  }

  const users = new Map<string, Promise<AuditUser>>();
  const user = (id: string | null): Promise<AuditUser | null> => {
    if (!id) return Promise.resolve(null);
    if (!users.has(id)) {
      users.set(id, adapter.getUser(id).then((u) => ({ id, displayName: u?.displayName ?? null, active: u?.isActive ?? null })));
    }
    return users.get(id)!;
  };
  const links = o.needs.has("links");
  const orphans = links ? new Set((await adapter.getOrphanedPages()).map((p) => p.pageId)) : new Set<string>();
  const broken = links ? group(await adapter.getBrokenLinks()) : new Map<string, LinkRecord[]>();
  const external = links ? group(await adapter.getExternalLinks()) : new Map<string, LinkRecord[]>();
  const inScope = new Set(records.map((r) => r.pageId));
  const urls = [...external].filter(([id]) => inScope.has(id)).flatMap(([, l]) => l.map((x) => x.targetPath).filter((u): u is string => Boolean(u)));
  const http = o.needs.has("http") && o.checkUrls ? await o.checkUrls(urls) : new Map<string, LinkCheckResult>();

  const pages: AuditPage[] = [];
  for (const r of records) pages.push(await snapshot(r));

  if (o.needs.has("remote") && o.client && o.spaceKey) {
    const remote = await o.client.getAllPages({ scope: { type: "space", spaceKey: o.spaceKey }, limit: 500 });
    if (remote.length >= 500) partial.push("remote pages");
    const synced = new Set((await adapter.listPages({})).map((p) => p.pageId));
    for (const p of remote) {
      if (synced.has(p.id)) continue;
      pages.push({
        id: p.id,
        title: p.title,
        spaceKey: p.spaceKey ?? o.spaceKey,
        path: null,
        ...(pageUrl(o.baseUrl, p.id) ? { url: pageUrl(o.baseUrl, p.id)! } : {}),
        synced: false,
        parentId: null,
        ancestors: [],
        contentType: "page",
        status: "current",
        version: p.version ?? 1,
        versionCount: p.version ?? 1,
        wordCount: null,
        createdAt: null,
        createdBy: null,
        lastModified: p.lastModified ?? null,
        lastModifiedBy: null,
        labels: [],
        restricted: false,
        orphan: false,
        brokenLinks: [],
        externalLinks: [],
        contributors: [],
      });
    }
  }
  return { pages, partial };

  async function snapshot(r: PageRecord): Promise<AuditPage> {
    const contributors = o.needs.has("contributors")
      ? await Promise.all((await adapter.getPageContributors(r.pageId)).map(async (c) => (await user(c.userId))!))
      : [];
    const url = pageUrl(o.baseUrl, r.pageId);
    return {
      id: r.pageId,
      title: r.title,
      spaceKey: r.spaceKey,
      path: r.path,
      ...(url ? { url } : {}),
      synced: true,
      parentId: r.parentId,
      ancestors: r.ancestors ?? [],
      contentType: r.contentType,
      status: r.contentStatus,
      version: r.version,
      versionCount: r.versionCount,
      wordCount: r.wordCount,
      createdAt: r.createdAt,
      createdBy: await user(r.createdBy),
      lastModified: r.lastModified,
      lastModifiedBy: await user(r.lastModifiedBy),
      labels: await adapter.getPageLabels(r.pageId),
      restricted: r.isRestricted,
      orphan: orphans.has(r.pageId),
      brokenLinks: (broken.get(r.pageId) ?? []).map((l) => ({ target: l.targetPath, text: l.linkText, line: l.lineNumber })),
      externalLinks: (external.get(r.pageId) ?? [])
        .filter((l) => l.targetPath)
        .map((l) => {
          const check = http.get(l.targetPath!);
          return {
            url: l.targetPath!,
            domain: domainOf(l.targetPath!),
            text: l.linkText,
            line: l.lineNumber,
            ...(check ? { httpStatus: check.status, ...(check.error ? { httpError: check.error } : {}), broken: check.isBroken } : {}),
          };
        }),
      contributors,
    };
  }
}

// ============================================================================
// Main handler
// ============================================================================

async function readBaseline(path: string): Promise<{ baseline?: AuditBaseline; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    return { baseline: parseAuditBaseline(JSON.parse(text)) };
  } catch {
    return { warning: `${path} is unreadable; no baseline applied.` };
  }
}

/** A port for rules that read through `atlcli.*` when no profile is set up. */
const offlinePort = new Proxy({} as ScriptPort, {
  get: () => () => {
    throw new Error("No active profile: rules that read from Confluence or Jira need 'atlcli auth login'.");
  },
});

export async function handleAuditWiki(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(auditWikiHelp(), opts);
    return;
  }
  // The parser reads `--no-external <path>` as a value; take the path back.
  const noExternal = flags["no-external"];
  const pathFromNoExternal = typeof noExternal === "string" && noExternal.startsWith("/") ? noExternal : undefined;
  if (pathFromNoExternal) flags["no-external"] = true;
  const dir = args[0] ?? pathFromNoExternal ?? getFlag(flags, "dir") ?? ".";
  const atlcliDir = findAtlcliDir(dir);
  if (!atlcliDir) fail(opts, 1, ERROR_CODES.VALIDATION, "No .atlcli directory found. Run 'atlcli wiki docs init' first.");
  const atlcliPath = getAtlcliPath(atlcliDir);
  if (!hasSyncDb(atlcliPath)) fail(opts, 1, ERROR_CODES.VALIDATION, "No sync.db found. Run 'atlcli wiki docs pull' first to populate the database.");

  const failOn = (getFlag(flags, "fail-on") ?? "error") as (typeof FAIL_ON)[number];
  if (!FAIL_ON.includes(failOn)) fail(opts, 1, ERROR_CODES.USAGE, `--fail-on must be one of ${FAIL_ON.join(", ")}.`);
  const minLevel = getFlag(flags, "min-level");
  if (minLevel !== undefined && !["info", "warning", "error"].includes(minLevel)) fail(opts, 1, ERROR_CODES.USAGE, "--min-level must be info, warning or error.");

  const config = await loadConfig();
  const dirConfig = await readConfig(atlcliDir).catch(() => undefined);
  const profile: Profile | undefined = getActiveProfile(config, dirConfig?.profile);
  const needProfile = hasFlag(flags, "include-remote") || hasFlag(flags, "refresh-users") || hasFlag(flags, "fix");
  let client: ConfluenceClient | null = null;
  if (needProfile) {
    if (!profile) fail(opts, 1, ERROR_CODES.VALIDATION, "No active profile. Run 'atlcli auth login' first.");
    assertCliAuthSupported(profile, opts);
    client = new ConfluenceClient(profile);
  }

  let setup;
  try {
    setup = await loadWikiAuditSetup(profile?.name, getFlag(flags, "rules"), process.cwd(), scriptFlags(flags));
  } catch (err) {
    if (err instanceof AuditRulesError || err instanceof AuditScriptError) fail(opts, 1, ERROR_CODES.USAGE, err.message);
    throw err;
  }
  if (handleRuleListing(setup.scripts, flags, opts)) return;
  const { registry, scripts } = setup;
  let rules: AuditRules = setup.rules;

  const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });
  try {
    if (hasFlag(flags, "rebuild-graph")) {
      output("Rebuilding link graph from synced pages...", opts);
      output("Note: Full rebuild requires re-reading all markdown files. Use 'wiki docs pull' to refresh from remote.", opts);
    }
    if (hasFlag(flags, "refresh-users")) await handleRefreshUsers(adapter, client!, opts);
    if (hasFlag(flags, "export-graph")) {
      await handleExportGraph(adapter, opts);
      return;
    }

    const legacy = legacySelection(flags, config.audit);
    if (typeof legacy === "string") fail(opts, 1, ERROR_CODES.VALIDATION, legacy);
    if (legacy === undefined && (hasFlag(flags, "rebuild-graph") || hasFlag(flags, "refresh-users")) && getFlag(flags, "checks") === undefined) return;
    try {
      if (legacy) {
        // The older flags name what to run, and everything they find is listed.
        const ids = new Set(registry.defs.filter((d) => d.legacy && legacy.checks.includes(d.legacy)).map((d) => d.id));
        for (const id of ids) {
          const patch = legacy.patches[id];
          if (patch !== undefined) rules.rules[id] = applyRulePatch(rules.rules[id] ?? {}, patch, id, "flags", registry);
          else if ((rules.rules[id]?.level ?? "off") === "off" && registry.get(id)?.kind === "flag") rules.rules[id] = { ...rules.rules[id], level: "info" };
        }
        rules = restrictAuditRules(rules, new Set([...ids, ...(hasFlag(flags, "include-remote") ? ["content/unsynced"] : [])]));
        rules.minLevel = "info";
      }
      if (hasFlag(flags, "include-remote") && registry.has("content/unsynced") && rules.rules["content/unsynced"]?.level === "off") {
        rules.rules["content/unsynced"] = { level: "info" };
      }
      const fixLabel = getFlag(flags, "fix-label");
      if (fixLabel && registry.has("content/stale")) rules.rules["content/stale"] = applyRulePatch(rules.rules["content/stale"] ?? {}, { label: [fixLabel] }, "content/stale", "--fix-label", registry);
    } catch (err) {
      if (err instanceof AuditRulesError) fail(opts, 1, ERROR_CODES.USAGE, err.message);
      throw err;
    }
    const checksFlag = getFlag(flags, "checks");
    if (checksFlag !== undefined) {
      const checks = resolveAuditChecks(checksFlag, registry);
      if (typeof checks === "string") fail(opts, 1, ERROR_CODES.USAGE, checks);
      rules = restrictAuditRules(rules, checks);
    }
    if (minLevel) rules.minLevel = minLevel as AuditSeverity;

    const using = scripts.filter((s) => {
      const c = rules.rules[s.meta.id];
      return c && c.level !== "off" && (c.level !== undefined || Object.keys(c.thresholds ?? {}).length > 0);
    });
    const needs = new Set(using.flatMap((s) => s.meta.needs));
    if (needs.has("remote") && !client) needs.delete("remote");
    const spaceKey = await adapter.getMeta("space_key");
    const scope = {
      ...(getFlag(flags, "label") ? { filterLabel: getFlag(flags, "label")! } : {}),
      ...(getFlag(flags, "under-page") ? { filterAncestor: getFlag(flags, "under-page")! } : {}),
      ...(getFlag(flags, "exclude-label") ? { excludeLabel: getFlag(flags, "exclude-label")! } : {}),
    };
    const { pages, partial } = await buildPageSnapshots(adapter, {
      needs,
      ...(dirConfig?.baseUrl ?? profile?.baseUrl ? { baseUrl: (dirConfig?.baseUrl ?? profile?.baseUrl)! } : {}),
      spaceKey,
      ...scope,
      client,
      checkUrls: (urls) => checkUrls(urls, { concurrency: 5, timeoutMs: 10000 }),
    });
    const folderIssues = needs.has("folders") ? validateFolders(atlcliDir).map((i) => ({ file: i.file, code: i.code, message: i.message })) : [];
    const diagnostics = [...setup.diagnostics];
    if (needs.has("contributors")) {
      const oldest = await adapter.getOldestUserCheck();
      if (oldest) diagnostics.push(`User status checked ${timeAgo(oldest)}; --refresh-users updates it.`);
      else diagnostics.push("User status never checked; run --refresh-users so inactive contributors are known.");
    }

    const baselinePath = join(atlcliPath, WIKI_BASELINE_FILE);
    const useBaseline = !hasFlag(flags, "no-baseline");
    const { baseline, warning } = await readBaseline(baselinePath);
    if (warning) diagnostics.push(warning);
    const query = [`space ${spaceKey ?? "?"}`, scope.filterLabel && `label ${scope.filterLabel}`, scope.filterAncestor && `under ${scope.filterAncestor}`, scope.excludeLabel && `without label ${scope.excludeLabel}`]
      .filter(Boolean)
      .join(", ");
    const port = profile ? (await import("./script-port.js")).createLazyCliScriptPort(profile) : offlinePort;
    let result;
    try {
      result = await auditConfluence(
        { rules, registry, scripts, pages, folderIssues, now: new Date(), ...(baseline ? { baseline } : {}), useBaseline, partial, diagnostics, query },
        { port, now: new Date(), onLog: (level, message) => process.stderr.write(`${level === "info" ? "" : `${level}: `}${message}\n`) },
      );
    } catch (err) {
      if (err instanceof AuditScriptError) fail(opts, 1, ERROR_CODES.VALIDATION, err.message);
      throw err;
    }
    const { report, candidates } = result;

    if (hasFlag(flags, "update-baseline")) {
      const next = createAuditBaseline(candidates, new Date(), baseline);
      await writeJsonAtomic(baselinePath, next);
      report.diagnostics.push(`Baseline: ${next.entries.length} finding(s) accepted in ${baselinePath}.`);
    } else if (hasFlag(flags, "prune-baseline") && baseline) {
      const next = pruneAuditBaseline(baseline, candidates);
      await writeJsonAtomic(baselinePath, next);
      report.diagnostics.push(`Baseline: ${baseline.entries.length - next.entries.length} stale entr(y/ies) removed.`);
      report.staleBaselineEntries = 0;
    }

    if (hasFlag(flags, "fix")) {
      const byId = new Map(pages.map((p) => [p.id, p]));
      await runAuditFixes(report, scripts, (f) => byId.get(f.key), { profile: profile!, port, configFor: (f) => rules.rules[f.rule] }, flags, opts);
      return;
    }

    const custom = await customAuditReport(report, scripts, port, flags, opts);
    if (custom !== undefined) await emitAuditReport(custom, flags, opts);
    if (custom === undefined || getFlag(flags, "report") !== undefined) {
      if (opts.json || hasFlag(flags, "json")) output(report, { ...opts, json: true });
      else if (custom === undefined) output(renderAuditText(report), opts);
    }
    if (failOn !== "never" && report.findings.some((f) => AUDIT_SEVERITY_RANK[f.severity] >= AUDIT_SEVERITY_RANK[failOn])) process.exitCode = 2;
  } finally {
    await adapter.close();
  }
}

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  return days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

// ============================================================================
// Special actions
// ============================================================================

async function handleRefreshUsers(adapter: SyncDbAdapter, client: ConfluenceClient, opts: OutputOptions): Promise<void> {
  output("Refreshing user status from Confluence API...", opts);
  const pages = await adapter.listPages({});
  const userIds = new Set<string>();
  for (const page of pages) {
    if (page.createdBy) userIds.add(page.createdBy);
    if (page.lastModifiedBy) userIds.add(page.lastModifiedBy);
    for (const c of await adapter.getPageContributors(page.pageId)) userIds.add(c.userId);
  }
  const uniqueIds = [...userIds];
  output(`  Found ${uniqueIds.length} unique users to refresh...`, opts);
  const userMap = await client.getUsersBulk(uniqueIds, { concurrency: 5 });
  let updated = 0;
  let notFound = 0;
  for (const [, info] of userMap) {
    if (info) {
      await adapter.upsertUser({
        userId: info.accountId,
        displayName: info.displayName ?? null,
        email: info.email ?? null,
        isActive: info.isActive,
        lastCheckedAt: new Date().toISOString(),
      });
      updated++;
    } else {
      // Deleted, or no permission to see the user.
      notFound++;
    }
  }
  output(`  ✓ Updated ${updated} users (${notFound} not found)`, opts);
}

async function handleExportGraph(adapter: SyncDbAdapter, opts: OutputOptions): Promise<void> {
  const pages = await adapter.listPages({});
  const links: LinkRecord[] = [];
  for (const page of pages) links.push(...(await adapter.getOutgoingLinks(page.pageId)));
  output(
    {
      exportedAt: new Date().toISOString(),
      pages: pages.map((p) => ({ pageId: p.pageId, title: p.title, path: p.path })),
      links: links.map((l) => ({ sourcePageId: l.sourcePageId, targetPageId: l.targetPageId, targetPath: l.targetPath, linkType: l.linkType, isBroken: l.isBroken })),
    },
    { ...opts, json: true },
  );
}

// ============================================================================
// Help
// ============================================================================

export function auditWikiHelp(): string {
  return `Usage: atlcli audit wiki [dir] [options]

Findings over the pages of a synced directory (reads its sync database), under
a rules file's confluence: section (built-in profile "default" when there is none).

Rules (category/rule, older check flag):
  content/stale                Not edited for 90 / 180 / 365 days      --stale-high/-medium/-low <months>
  links/orphan                 No incoming links and no parent         --orphans
  links/broken                 Broken internal links                   --broken-links
  links/external               External URL inventory (off)            --external-links
  links/external-broken        External URLs that fail over HTTP (off) --check-external
  people/single-contributor    Only one contributor (bus factor)       --single-contributor
  people/inactive-contributors All contributors inactive               --inactive-contributors
  content/missing-label        Missing a required label (off)          --missing-label <label>
  content/restricted           View or edit restrictions               --restricted
  content/draft                Unpublished drafts                      --drafts
  content/archived             Archived pages                          --archived
  content/high-churn           Many versions (off)                     --high-churn <N>
  structure/folders            Empty folders, folders without index.md --folders
  content/unsynced             In Confluence, not synced (off)         --include-remote

Selecting checks:
  (none)                    The rules file, else the default profile
  --all                     stale, orphans, broken links, contributors, folders, restricted,
                            drafts, archived; with the check flags above, only what they
                            name runs and every finding is listed (min level info)
  --checks <list>           Only these rules: rule ids, categories or the older check names
  --rules <file>            Rules file to use (its confluence: section)

Rules file (first found): --rules <file>, ./.atlcli/audit-rules.yaml,
  ~/.atlcli/profiles/<profile>/audit-rules.yaml, ~/.atlcli/audit-rules.yaml
  confluence:
    extends: default            # minimal | default | strict
    minLevel: warning
    rules:
      content/stale: { warning: 120d, error: 365d }
      content/missing-label: { severity: warning, label: [owner] }
Baseline: .atlcli/${WIKI_BASELINE_FILE} in the synced directory.

Scope:
  --label <label>           Only pages with this label
  --under-page <pageId>     Only pages under this ancestor
  --exclude-label <label>   Leave out pages with this label
  --include-remote          Also pages in Confluence that are not synced (needs a profile)

Output:
  --min-level <level>       List findings from this level (default: the rules' minLevel)
  --fail-on <level>         Exit 2 when a listed finding reaches it: info, warning, error
                            (default), never
  --update-baseline         Accept every current finding into the baseline
  --prune-baseline          Remove baseline entries that no longer match
  --no-baseline             Ignore the baseline
  --markdown                Markdown report (the default Jinja template; --print-template prints it)
  --template <file>         Render the report with your own Jinja template
  --report <file>           Write the Markdown report to a file instead of stdout
  --report-script <id>      Use this rule script's \`report\` export
  --json                    JSON report (schemaVersion 3)
  --export-graph            Export the link graph as JSON

Rule scripts (TypeScript, run read-only in the script sandbox):
  --script <file>           Add a rule script (repeatable); also ./.atlcli/audit/*.ts,
                            ~/.atlcli/audit/*.ts and scripts: in the confluence: section.
                            A script with a built-in rule's id replaces it.
  --list-rules              List rules with their source
  --print-rule <id>         Print a rule's script
  --fix                     Plan the \`fix\` exports of listed findings (review, then apply):
                            content/stale labels error-level pages (--fix-label, default
                            needs-review) and archives pages not edited for 2 years;
                            links/orphan trashes orphans not edited for a year;
                            content/missing-label adds the label
    --apply [--yes]         Apply the plan right away
    --plan-out <file>       Save the plan for 'atlcli script apply'
  Start one with 'atlcli audit init --product confluence'.

Maintenance:
  --refresh-users           Refresh user active/inactive status from the API
  --rebuild-graph           Rebuild the link graph from synced markdown files
  --dir <path>              Directory to audit (default: current)

Configuration (~/.atlcli/config.json, used when no check flag is given):
  { "audit": { "defaultChecks": ["stale", "orphans", "broken-links"],
               "staleThresholds": { "high": 12, "medium": 6, "low": 3 } } }

Exit codes: 0 ran, 1 failed or wrong arguments, 2 findings at --fail-on.

Examples:
  atlcli audit wiki
  atlcli audit wiki --stale-high 12 --stale-medium 6 --orphans
  atlcli audit wiki --all --label documentation --markdown > AUDIT-REPORT.md
  atlcli audit wiki --checks links --fail-on warning
  atlcli audit wiki --all --update-baseline
  atlcli audit wiki --stale-high 12 --fix
  atlcli audit wiki --script owner-label.ts --fix --apply
  atlcli audit wiki --refresh-users --inactive-contributors`;
}

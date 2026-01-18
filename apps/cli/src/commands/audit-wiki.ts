import { ERROR_CODES, OutputOptions, fail, hasFlag, getFlag, output, loadConfig, getActiveProfile } from "@atlcli/core";
import {
  findAtlcliDir,
  getAtlcliPath,
  createSyncDb,
  hasSyncDb,
  ConfluenceClient,
  validateFolders,
  type SyncDbAdapter,
  type PageRecord,
  type LinkRecord,
  type UserRecord,
} from "@atlcli/confluence";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import * as readline from "node:readline";
import {
  formatTable,
  formatMarkdown,
  formatTimeAgo,
  type AuditResult,
  type StalePageInfo,
  type OrphanedPageInfo,
  type BrokenLinkInfo,
  type ContributorRiskInfo,
  type ExternalLinkInfo,
  type MissingLabelInfo,
  type RestrictedPageInfo,
  type ContentStatusInfo,
  type HighChurnInfo,
  type FolderIssueInfo,
  type RemotePageInfo,
} from "./audit-formatters.js";

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
// Types
// ============================================================================

interface AuditOptions {
  // Thresholds (months)
  staleHigh?: number;
  staleMedium?: number;
  staleLow?: number;
  // Check flags
  checkOrphans: boolean;
  checkBrokenLinks: boolean;
  checkSingleContributor: boolean;
  checkInactiveContributors: boolean;
  checkExternalLinks: boolean;
  checkExternalBroken: boolean; // Actually verify external links via HTTP
  checkFolders: boolean; // Check for folder structure issues
  // New audit checks
  missingLabel?: string; // Find pages missing this label
  checkRestricted: boolean; // Find pages with restrictions
  checkDrafts: boolean; // Find draft pages
  checkArchived: boolean; // Find archived pages
  highChurnThreshold?: number; // Find pages with >= N versions
  // Scope filtering
  filterLabel?: string; // Only audit pages with this label
  filterAncestor?: string; // Only audit pages under this ancestor (pageId)
  excludeLabel?: string; // Exclude pages with this label
  // Output
  json: boolean;
  markdown: boolean;
  exportGraph: boolean;
  // Actions
  rebuildGraph: boolean;
  refreshUsers: boolean;
  includeRemote: boolean; // Include unsynced pages via API
  localOnly: boolean; // Only audit synced pages (default: true)
  // Fix mode
  fix: boolean;
  dryRun: boolean;
  fixLabel: string; // Label to add to stale pages (default: "needs-review")
  reportPath?: string; // Path to write report file
}

// Fix action types
interface FixAction {
  type: "add-label" | "generate-report" | "archive" | "delete";
  pageId?: string;
  pageTitle?: string;
  label?: string;
  reportPath?: string;
  safe: boolean; // Safe actions auto-apply, unsafe require confirmation
}

interface FixResult {
  action: FixAction;
  success: boolean;
  error?: string;
  skipped?: boolean; // For dry-run or user declined
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleAuditWiki(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // Show help
  if (hasFlag(flags, "help") || hasFlag(flags, "h")) {
    output(auditWikiHelp(), opts);
    return;
  }

  // Find .atlcli directory (positional arg or --dir flag)
  // Handle case where path was consumed by --no-external flag (parser quirk)
  const noExternalValue = flags["no-external"];
  const pathFromNoExternal = typeof noExternalValue === "string" && noExternalValue.startsWith("/")
    ? noExternalValue
    : undefined;
  if (pathFromNoExternal) {
    flags["no-external"] = true; // Reset to boolean
  }
  const dir = args[0] ?? pathFromNoExternal ?? (getFlag(flags, "dir") as string) ?? ".";
  const atlcliDir = findAtlcliDir(dir);

  if (!atlcliDir) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No .atlcli directory found. Run 'atlcli wiki docs init' first.");
  }

  const atlcliPath = getAtlcliPath(atlcliDir);
  if (!hasSyncDb(atlcliPath)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No sync.db found. Run 'atlcli wiki docs pull' first to populate the database.");
  }

  // Parse options
  const options = await parseOptions(flags, opts);

  // Validate that at least one check is requested
  const hasAnyCheck =
    options.staleHigh !== undefined ||
    options.checkOrphans ||
    options.checkBrokenLinks ||
    options.checkSingleContributor ||
    options.checkInactiveContributors ||
    options.checkExternalLinks ||
    options.checkFolders ||
    options.missingLabel !== undefined ||
    options.checkRestricted ||
    options.checkDrafts ||
    options.checkArchived ||
    options.highChurnThreshold !== undefined ||
    options.rebuildGraph ||
    options.refreshUsers ||
    options.exportGraph;

  if (!hasAnyCheck) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      "No audit checks specified. Use --all, specify individual checks (--orphans, --broken-links, etc.), or configure audit.defaultChecks in ~/.atlcli/config.json"
    );
  }

  // Open adapter
  const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });

  // Create client if needed for API operations
  let client: ConfluenceClient | null = null;
  if (options.includeRemote || options.refreshUsers) {
    const config = await loadConfig();
    const profile = getActiveProfile(config);
    if (!profile) {
      fail(opts, 1, ERROR_CODES.VALIDATION, "No active profile. Run 'atlcli auth login' first.");
    }
    client = new ConfluenceClient(profile);
  }

  try {
    // Handle special actions first
    if (options.rebuildGraph) {
      await handleRebuildGraph(adapter, atlcliDir, opts);
      if (!options.checkOrphans && !options.checkBrokenLinks && options.staleHigh === undefined) {
        return; // Only rebuild was requested
      }
    }

    if (options.refreshUsers) {
      await handleRefreshUsers(adapter, client!, opts);
    }

    if (options.exportGraph) {
      await handleExportGraph(adapter, opts);
      return;
    }

    // Run audit
    const result = await runAudit(adapter, options, atlcliDir, client);

    // Output results
    if (options.json || opts.json) {
      output(result, { ...opts, json: true });
    } else if (options.markdown) {
      output(formatMarkdown(result), opts);
    } else {
      output(formatTable(result), opts);
    }

    // Handle fix mode
    if (options.fix) {
      const fixResults = await handleFixActions(result, options, atlcliDir, opts);
      if (fixResults.length > 0) {
        output("", opts);
        outputFixResults(fixResults, options.dryRun, opts);
      }
    }
  } finally {
    await adapter.close();
  }
}

// ============================================================================
// Option Parsing
// ============================================================================

async function parseOptions(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<AuditOptions> {
  const all = hasFlag(flags, "all");

  // Load config for defaults
  const config = await loadConfig();
  const auditConfig = config.audit;
  const defaultChecks = auditConfig?.defaultChecks ?? [];

  // Detect if user specified any explicit check flags
  const hasExplicitCheckFlags =
    hasFlag(flags, "orphans") ||
    hasFlag(flags, "broken-links") ||
    hasFlag(flags, "single-contributor") ||
    hasFlag(flags, "inactive-contributors") ||
    hasFlag(flags, "external-links") ||
    hasFlag(flags, "check-external") ||
    hasFlag(flags, "restricted") ||
    hasFlag(flags, "drafts") ||
    hasFlag(flags, "archived") ||
    getFlag(flags, "stale-high") !== undefined ||
    getFlag(flags, "stale-medium") !== undefined ||
    getFlag(flags, "stale-low") !== undefined ||
    getFlag(flags, "missing-label") !== undefined ||
    getFlag(flags, "high-churn") !== undefined;

  // Use defaultChecks from config when no explicit checks specified
  const useDefaults = !all && !hasExplicitCheckFlags && defaultChecks.length > 0;

  // Parse thresholds (flags override config)
  const staleHighStr = getFlag(flags, "stale-high") as string | undefined;
  const staleMediumStr = getFlag(flags, "stale-medium") as string | undefined;
  const staleLowStr = getFlag(flags, "stale-low") as string | undefined;

  // Use config thresholds if "stale" is in defaultChecks and no explicit threshold flags
  const staleFromDefaults = useDefaults && defaultChecks.includes("stale");
  const staleHigh = staleHighStr
    ? parseInt(staleHighStr, 10)
    : staleFromDefaults || all
      ? auditConfig?.staleThresholds?.high
      : undefined;
  const staleMedium = staleMediumStr
    ? parseInt(staleMediumStr, 10)
    : staleFromDefaults || all
      ? auditConfig?.staleThresholds?.medium
      : undefined;
  const staleLow = staleLowStr
    ? parseInt(staleLowStr, 10)
    : staleFromDefaults || all
      ? auditConfig?.staleThresholds?.low
      : undefined;

  // Validate thresholds
  if (staleHigh !== undefined && isNaN(staleHigh)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--stale-high must be a number (months)");
  }
  if (staleMedium !== undefined && isNaN(staleMedium)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--stale-medium must be a number (months)");
  }
  if (staleLow !== undefined && isNaN(staleLow)) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--stale-low must be a number (months)");
  }

  // Helper to check if a check should be enabled
  const shouldEnableCheck = (flagName: string, defaultCheckName: string): boolean => {
    return all || hasFlag(flags, flagName) || (useDefaults && defaultChecks.includes(defaultCheckName as typeof defaultChecks[number]));
  };

  return {
    staleHigh,
    staleMedium,
    staleLow,
    checkOrphans: shouldEnableCheck("orphans", "orphans"),
    checkBrokenLinks: shouldEnableCheck("broken-links", "broken-links"),
    checkSingleContributor: shouldEnableCheck("single-contributor", "single-contributor"),
    checkInactiveContributors: shouldEnableCheck("inactive-contributors", "inactive-contributors"),
    checkExternalLinks: hasFlag(flags, "external-links") || hasFlag(flags, "check-external") || (useDefaults && defaultChecks.includes("external-links")),
    checkExternalBroken: hasFlag(flags, "check-external"), // Actually verify via HTTP
    checkFolders: all || hasFlag(flags, "folders") || (useDefaults && defaultChecks.includes("folders")),
    // New audit checks
    missingLabel: getFlag(flags, "missing-label") as string | undefined,
    checkRestricted: all || hasFlag(flags, "restricted"),
    checkDrafts: all || hasFlag(flags, "drafts"),
    checkArchived: all || hasFlag(flags, "archived"),
    highChurnThreshold: parseHighChurn(flags),
    // Scope filtering
    filterLabel: getFlag(flags, "label") as string | undefined,
    filterAncestor: getFlag(flags, "under-page") as string | undefined,
    excludeLabel: getFlag(flags, "exclude-label") as string | undefined,
    // Output
    json: hasFlag(flags, "json"),
    markdown: hasFlag(flags, "markdown"),
    exportGraph: hasFlag(flags, "export-graph"),
    rebuildGraph: hasFlag(flags, "rebuild-graph"),
    refreshUsers: hasFlag(flags, "refresh-users"),
    includeRemote: hasFlag(flags, "include-remote"),
    localOnly: !hasFlag(flags, "include-remote"), // Default true, false if --include-remote
    // Fix mode
    fix: hasFlag(flags, "fix"),
    dryRun: hasFlag(flags, "dry-run"),
    fixLabel: (getFlag(flags, "fix-label") as string) ?? "needs-review",
    reportPath: getFlag(flags, "report") as string | undefined,
  };
}

function parseHighChurn(flags: Record<string, string | boolean | string[]>): number | undefined {
  const value = getFlag(flags, "high-churn") as string | undefined;
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

// ============================================================================
// Audit Logic
// ============================================================================

/**
 * Get filtered page IDs based on scope options.
 * Returns null if no filtering is needed, or a Set of page IDs to include.
 */
async function getFilteredPageIds(
  adapter: SyncDbAdapter,
  options: AuditOptions
): Promise<Set<string> | null> {
  const hasFilter = options.filterLabel || options.filterAncestor || options.excludeLabel;
  if (!hasFilter) return null;

  let pages = await adapter.listPages({});

  // Filter by label (only include pages with this label)
  if (options.filterLabel) {
    const pagesWithLabel = await adapter.getPagesWithLabel(options.filterLabel);
    const labelPageIds = new Set(pagesWithLabel.map((p) => p.pageId));
    pages = pages.filter((p) => labelPageIds.has(p.pageId));
  }

  // Filter by ancestor (only include pages under this page)
  if (options.filterAncestor) {
    pages = pages.filter(
      (p) => p.ancestors?.includes(options.filterAncestor!) || p.parentId === options.filterAncestor
    );
  }

  // Exclude by label
  if (options.excludeLabel) {
    const pagesWithExcludeLabel = await adapter.getPagesWithLabel(options.excludeLabel);
    const excludePageIds = new Set(pagesWithExcludeLabel.map((p) => p.pageId));
    pages = pages.filter((p) => !excludePageIds.has(p.pageId));
  }

  return new Set(pages.map((p) => p.pageId));
}

/**
 * Filter an array of items that have a page property by allowed page IDs.
 */
function filterByPageScope<T extends { page: PageRecord }>(
  items: T[],
  allowedPageIds: Set<string> | null
): T[] {
  if (!allowedPageIds) return items;
  return items.filter((item) => allowedPageIds.has(item.page.pageId));
}

async function runAudit(
  adapter: SyncDbAdapter,
  options: AuditOptions,
  atlcliDir: string,
  client: ConfluenceClient | null = null
): Promise<AuditResult> {
  const spaceKey = await adapter.getMeta("space_key");
  const result: AuditResult = {
    space: spaceKey,
    generatedAt: new Date().toISOString(),
    summary: {
      stale: { high: 0, medium: 0, low: 0 },
      orphans: 0,
      brokenLinks: 0,
      contributorRisks: 0,
      externalLinks: 0,
      brokenExternalLinks: 0,
      missingLabel: 0,
      restricted: 0,
      drafts: 0,
      archived: 0,
      highChurn: 0,
      folderIssues: 0,
      unsynced: 0,
      unsyncedStale: { high: 0, medium: 0, low: 0 },
    },
    stalePages: [],
    orphanedPages: [],
    brokenLinks: [],
    contributorRisks: [],
    externalLinks: [],
    missingLabelPages: [],
    restrictedPages: [],
    draftPages: [],
    archivedPages: [],
    highChurnPages: [],
    folderIssues: [],
    userCacheAge: null,
    unsyncedPages: [],
    unsyncedStalePages: [],
  };

  // Get scope-filtered page IDs (null if no filtering)
  const filteredPageIds = await getFilteredPageIds(adapter, options);

  // Get user cache age
  const oldestCheck = await adapter.getOldestUserCheck();
  if (oldestCheck) {
    result.userCacheAge = formatTimeAgo(oldestCheck);
  }

  // Stale detection
  if (options.staleHigh !== undefined) {
    let stalePages = await detectStalePages(adapter, options);
    stalePages = filterByPageScope(stalePages, filteredPageIds);
    result.stalePages = stalePages;
    result.summary.stale.high = stalePages.filter((p) => p.severity === "high").length;
    result.summary.stale.medium = stalePages.filter((p) => p.severity === "medium").length;
    result.summary.stale.low = stalePages.filter((p) => p.severity === "low").length;
  }

  // Orphan detection
  if (options.checkOrphans) {
    const orphans = await adapter.getOrphanedPages();
    let orphanedPages = orphans.map((page) => ({ page }));
    orphanedPages = filterByPageScope(orphanedPages, filteredPageIds);
    result.orphanedPages = orphanedPages;
    result.summary.orphans = orphanedPages.length;
  }

  // Broken links
  if (options.checkBrokenLinks) {
    const brokenLinks = await adapter.getBrokenLinks();
    let brokenLinkInfos = await Promise.all(
      brokenLinks.map(async (link) => ({
        link,
        sourcePage: await adapter.getPage(link.sourcePageId),
      }))
    );
    // Filter by source page scope
    if (filteredPageIds) {
      brokenLinkInfos = brokenLinkInfos.filter(
        (info) => info.sourcePage && filteredPageIds.has(info.sourcePage.pageId)
      );
    }
    result.brokenLinks = brokenLinkInfos;
    result.summary.brokenLinks = brokenLinkInfos.length;
  }

  // Contributor risks
  if (options.checkSingleContributor || options.checkInactiveContributors) {
    let risks = await detectContributorRisks(adapter, options);
    risks = filterByPageScope(risks, filteredPageIds);
    result.contributorRisks = risks;
    result.summary.contributorRisks = risks.length;
  }

  // External links
  if (options.checkExternalLinks) {
    const externalLinks = await adapter.getExternalLinks();

    // Build basic info for all external links
    let externalLinkInfos: ExternalLinkInfo[] = await Promise.all(
      externalLinks.map(async (link) => ({
        link,
        sourcePage: await adapter.getPage(link.sourcePageId),
        domain: extractDomain(link.targetPath),
      }))
    );

    // Filter by source page scope
    if (filteredPageIds) {
      externalLinkInfos = externalLinkInfos.filter(
        (info) => info.sourcePage && filteredPageIds.has(info.sourcePage.pageId)
      );
    }

    // If --check-external, verify URLs via HTTP
    if (options.checkExternalBroken) {
      const urls = externalLinkInfos
        .map((i) => i.link.targetPath)
        .filter((url): url is string => url !== null);

      const checkResults = await checkUrls(urls, {
        concurrency: 5,
        timeoutMs: 10000,
      });

      // Update external link info with HTTP results
      for (const info of externalLinkInfos) {
        const url = info.link.targetPath;
        if (url) {
          const checkResult = checkResults.get(url);
          if (checkResult) {
            info.httpStatus = checkResult.status;
            info.httpError = checkResult.error;
            info.isBroken = checkResult.isBroken;
          }
        }
      }

      // Count broken external links
      result.summary.brokenExternalLinks = externalLinkInfos.filter((i) => i.isBroken).length;
    }

    result.externalLinks = externalLinkInfos;
    result.summary.externalLinks = externalLinkInfos.length;
  }

  // Missing label check
  if (options.missingLabel) {
    let missingPages = await detectMissingLabel(adapter, options.missingLabel);
    missingPages = filterByPageScope(missingPages, filteredPageIds);
    result.missingLabelPages = missingPages;
    result.summary.missingLabel = missingPages.length;
  }

  // Restricted pages
  if (options.checkRestricted) {
    let restrictedPages = await detectRestrictedPages(adapter);
    restrictedPages = filterByPageScope(restrictedPages, filteredPageIds);
    result.restrictedPages = restrictedPages;
    result.summary.restricted = restrictedPages.length;
  }

  // Draft pages
  if (options.checkDrafts) {
    let draftPages = await detectDraftPages(adapter);
    draftPages = filterByPageScope(draftPages, filteredPageIds);
    result.draftPages = draftPages;
    result.summary.drafts = draftPages.length;
  }

  // Archived pages
  if (options.checkArchived) {
    let archivedPages = await detectArchivedPages(adapter);
    archivedPages = filterByPageScope(archivedPages, filteredPageIds);
    result.archivedPages = archivedPages;
    result.summary.archived = archivedPages.length;
  }

  // High churn pages
  if (options.highChurnThreshold !== undefined) {
    let highChurnPages = await detectHighChurnPages(adapter, options.highChurnThreshold);
    highChurnPages = filterByPageScope(highChurnPages, filteredPageIds);
    result.highChurnPages = highChurnPages;
    result.summary.highChurn = highChurnPages.length;
  }

  // Folder structure issues
  if (options.checkFolders) {
    // atlcliDir is the project root (directory containing .atlcli)
    const folderValidationIssues = validateFolders(atlcliDir);
    result.folderIssues = folderValidationIssues.map((issue) => ({
      file: issue.file,
      code: issue.code as "FOLDER_EMPTY" | "FOLDER_MISSING_INDEX",
      message: issue.message,
    }));
    result.summary.folderIssues = result.folderIssues.length;
  }

  // Include remote (unsynced) pages if requested
  if (options.includeRemote && client && spaceKey) {
    const remoteResult = await detectUnsyncedPages(adapter, client, spaceKey, options);
    result.unsyncedPages = remoteResult.unsyncedPages;
    result.unsyncedStalePages = remoteResult.unsyncedStalePages;
    result.summary.unsynced = remoteResult.unsyncedPages.length;
    result.summary.unsyncedStale.high = remoteResult.unsyncedStalePages.filter(
      (p) => p.severity === "high"
    ).length;
    result.summary.unsyncedStale.medium = remoteResult.unsyncedStalePages.filter(
      (p) => p.severity === "medium"
    ).length;
    result.summary.unsyncedStale.low = remoteResult.unsyncedStalePages.filter(
      (p) => p.severity === "low"
    ).length;
  }

  return result;
}

/**
 * Detect pages that exist in Confluence but are not synced locally.
 */
async function detectUnsyncedPages(
  adapter: SyncDbAdapter,
  client: ConfluenceClient,
  spaceKey: string,
  options: AuditOptions
): Promise<{ unsyncedPages: RemotePageInfo[]; unsyncedStalePages: RemotePageInfo[] }> {
  // Get all pages from Confluence API
  const remotePages = await client.getAllPages({
    scope: { type: "space", spaceKey },
    limit: 500,
  });

  // Get all synced page IDs
  const syncedPages = await adapter.listPages({});
  const syncedPageIds = new Set(syncedPages.map((p) => p.pageId));

  // Find unsynced pages
  const now = new Date();
  const unsyncedPages: RemotePageInfo[] = [];
  const unsyncedStalePages: RemotePageInfo[] = [];

  for (const remotePage of remotePages) {
    if (syncedPageIds.has(remotePage.id)) {
      continue; // Already synced
    }

    const pageInfo: RemotePageInfo = {
      pageId: remotePage.id,
      title: remotePage.title,
      lastModified: remotePage.lastModified ?? null,
      version: remotePage.version,
      spaceKey: remotePage.spaceKey ?? spaceKey,
    };

    unsyncedPages.push(pageInfo);

    // Check if stale
    if (remotePage.lastModified && options.staleHigh !== undefined) {
      const lastModified = new Date(remotePage.lastModified);
      const monthsStale = monthsDiff(lastModified, now);

      let severity: "high" | "medium" | "low" | undefined;
      if (monthsStale >= options.staleHigh) {
        severity = "high";
      } else if (options.staleMedium !== undefined && monthsStale >= options.staleMedium) {
        severity = "medium";
      } else if (options.staleLow !== undefined && monthsStale >= options.staleLow) {
        severity = "low";
      }

      if (severity) {
        unsyncedStalePages.push({
          ...pageInfo,
          monthsStale,
          severity,
        });
      }
    }
  }

  return { unsyncedPages, unsyncedStalePages };
}

async function detectStalePages(
  adapter: SyncDbAdapter,
  options: AuditOptions
): Promise<StalePageInfo[]> {
  const now = new Date();
  const stalePages: StalePageInfo[] = [];

  // Determine the minimum threshold to use for database filtering
  // This filters at the DB level for efficiency, then we categorize in JS
  const thresholds = [options.staleLow, options.staleMedium, options.staleHigh].filter(
    (t): t is number => t !== undefined
  );
  const minThreshold = Math.min(...thresholds);

  // Calculate the cutoff date for the minimum threshold
  const cutoffDate = new Date(now);
  cutoffDate.setMonth(cutoffDate.getMonth() - minThreshold);

  // Get only pages modified before the cutoff (efficient DB query)
  const pages = await adapter.listPages({
    modifiedBefore: cutoffDate.toISOString(),
  });

  for (const page of pages) {
    if (!page.lastModified) continue;

    const lastModified = new Date(page.lastModified);
    const monthsStale = monthsDiff(lastModified, now);

    let severity: "high" | "medium" | "low" | null = null;

    if (options.staleHigh !== undefined && monthsStale >= options.staleHigh) {
      severity = "high";
    } else if (options.staleMedium !== undefined && monthsStale >= options.staleMedium) {
      severity = "medium";
    } else if (options.staleLow !== undefined && monthsStale >= options.staleLow) {
      severity = "low";
    }

    if (severity) {
      const author = page.createdBy ? await adapter.getUser(page.createdBy) : null;
      stalePages.push({ page, monthsStale, severity, author });
    }
  }

  // Sort by months stale descending
  return stalePages.sort((a, b) => b.monthsStale - a.monthsStale);
}

async function detectContributorRisks(
  adapter: SyncDbAdapter,
  options: AuditOptions
): Promise<ContributorRiskInfo[]> {
  const risks: ContributorRiskInfo[] = [];
  const pages = await adapter.listPages({});

  for (const page of pages) {
    const contributors = await adapter.getPageContributors(page.pageId);

    // Single contributor (bus factor)
    if (options.checkSingleContributor && contributors.length === 1) {
      const user = await adapter.getUser(contributors[0].userId);
      risks.push({
        page,
        riskType: "bus-factor",
        details: `Only contributor: ${user?.displayName ?? contributors[0].userId}`,
        contributors: [
          {
            userId: contributors[0].userId,
            displayName: user?.displayName ?? null,
            isActive: user?.isActive ?? null,
          },
        ],
      });
      continue; // Don't double-count
    }

    // All contributors inactive
    if (options.checkInactiveContributors && contributors.length > 0) {
      const contributorDetails = await Promise.all(
        contributors.map(async (c) => {
          const user = await adapter.getUser(c.userId);
          return {
            userId: c.userId,
            displayName: user?.displayName ?? null,
            isActive: user?.isActive ?? null,
          };
        })
      );

      // Only flag if ALL are verified inactive (isActive === false, not null)
      const allInactive = contributorDetails.every((c) => c.isActive === false);
      if (allInactive) {
        risks.push({
          page,
          riskType: "no-maintainer",
          details: `All ${contributors.length} contributors inactive`,
          contributors: contributorDetails,
        });
      }
    }
  }

  return risks;
}

async function detectMissingLabel(
  adapter: SyncDbAdapter,
  requiredLabel: string
): Promise<MissingLabelInfo[]> {
  const pages = await adapter.listPages({});
  const missingPages: MissingLabelInfo[] = [];

  for (const page of pages) {
    const labels = await adapter.getPageLabels(page.pageId);
    if (!labels.includes(requiredLabel)) {
      missingPages.push({ page, currentLabels: labels });
    }
  }

  return missingPages;
}

async function detectRestrictedPages(adapter: SyncDbAdapter): Promise<RestrictedPageInfo[]> {
  const pages = await adapter.listPages({ isRestricted: true });
  return pages.map((page) => ({ page }));
}

async function detectDraftPages(adapter: SyncDbAdapter): Promise<ContentStatusInfo[]> {
  const pages = await adapter.listPages({ contentStatus: "draft" });
  return pages.map((page) => ({ page, status: "draft" as const }));
}

async function detectArchivedPages(adapter: SyncDbAdapter): Promise<ContentStatusInfo[]> {
  const pages = await adapter.listPages({ contentStatus: "archived" });
  return pages.map((page) => ({ page, status: "archived" as const }));
}

async function detectHighChurnPages(
  adapter: SyncDbAdapter,
  threshold: number
): Promise<HighChurnInfo[]> {
  const pages = await adapter.listPages({ minVersionCount: threshold });
  return pages
    .map((page) => ({ page, versionCount: page.versionCount }))
    .sort((a, b) => b.versionCount - a.versionCount);
}

// ============================================================================
// Special Actions
// ============================================================================

async function handleRebuildGraph(
  adapter: SyncDbAdapter,
  atlcliDir: string,
  opts: OutputOptions
): Promise<void> {
  output("Rebuilding link graph from synced pages...", opts);

  // This would re-extract links from all local markdown files
  // For now, just indicate it's not fully implemented
  output("Note: Full rebuild requires re-reading all markdown files. Use 'wiki docs pull' to refresh from remote.", opts);
}

async function handleRefreshUsers(
  adapter: SyncDbAdapter,
  client: ConfluenceClient,
  opts: OutputOptions
): Promise<void> {
  output("Refreshing user status from Confluence API...", opts);

  // Get all unique user IDs from pages and contributors
  const pages = await adapter.listPages({});
  const userIds = new Set<string>();

  for (const page of pages) {
    if (page.createdBy) userIds.add(page.createdBy);
    if (page.lastModifiedBy) userIds.add(page.lastModifiedBy);

    const contributors = await adapter.getPageContributors(page.pageId);
    for (const c of contributors) {
      userIds.add(c.userId);
    }
  }

  const uniqueIds = [...userIds];
  output(`  Found ${uniqueIds.length} unique users to refresh...`, opts);

  // Fetch user info from API
  const userMap = await client.getUsersBulk(uniqueIds, { concurrency: 5 });

  // Update users in database
  let updated = 0;
  let notFound = 0;

  for (const [userId, userInfo] of userMap) {
    if (userInfo) {
      await adapter.upsertUser({
        userId: userInfo.accountId,
        displayName: userInfo.displayName ?? null,
        email: userInfo.email ?? null,
        isActive: userInfo.isActive,
        lastCheckedAt: new Date().toISOString(),
      });
      updated++;
    } else {
      // User not found - might be deleted or no permission
      notFound++;
    }
  }

  output(`  ✓ Updated ${updated} users (${notFound} not found)`, opts);
}

async function handleExportGraph(adapter: SyncDbAdapter, opts: OutputOptions): Promise<void> {
  const pages = await adapter.listPages({});
  const links: LinkRecord[] = [];

  for (const page of pages) {
    const pageLinks = await adapter.getOutgoingLinks(page.pageId);
    links.push(...pageLinks);
  }

  const graph = {
    exportedAt: new Date().toISOString(),
    pages: pages.map((p) => ({
      pageId: p.pageId,
      title: p.title,
      path: p.path,
    })),
    links: links.map((l) => ({
      sourcePageId: l.sourcePageId,
      targetPageId: l.targetPageId,
      targetPath: l.targetPath,
      linkType: l.linkType,
      isBroken: l.isBroken,
    })),
  };

  output(graph, { ...opts, json: true });
}

// ============================================================================
// Fix Actions
// ============================================================================

/**
 * Prompt user for confirmation (yes/no/all/skip).
 */
async function promptConfirm(question: string): Promise<"yes" | "no" | "all" | "skip"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} [y/n/a(ll)/s(kip all)]: `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") {
        resolve("yes");
      } else if (normalized === "a" || normalized === "all") {
        resolve("all");
      } else if (normalized === "s" || normalized === "skip") {
        resolve("skip");
      } else {
        resolve("no");
      }
    });
  });
}

/**
 * Generate fix actions based on audit results.
 */
function generateFixActions(result: AuditResult, options: AuditOptions, atlcliDir: string): FixAction[] {
  const actions: FixAction[] = [];

  // Safe action: Add "needs-review" label to high-risk stale pages
  const highRiskStale = result.stalePages.filter((p) => p.severity === "high");
  for (const staleInfo of highRiskStale) {
    actions.push({
      type: "add-label",
      pageId: staleInfo.page.pageId,
      pageTitle: staleInfo.page.title,
      label: options.fixLabel,
      safe: true,
    });
  }

  // Safe action: Generate markdown report if there are any issues
  const totalIssues =
    result.summary.stale.high +
    result.summary.stale.medium +
    result.summary.stale.low +
    result.summary.orphans +
    result.summary.brokenLinks +
    result.summary.contributorRisks;

  if (totalIssues > 0) {
    const reportPath = options.reportPath ?? join(atlcliDir, "audit-report.md");
    actions.push({
      type: "generate-report",
      reportPath,
      safe: true,
    });
  }

  // Interactive action: Archive very old stale pages (24+ months)
  const veryOldPages = result.stalePages.filter((p) => p.monthsStale >= 24);
  for (const staleInfo of veryOldPages) {
    actions.push({
      type: "archive",
      pageId: staleInfo.page.pageId,
      pageTitle: staleInfo.page.title,
      safe: false,
    });
  }

  // Interactive action: Delete orphaned pages (with no links and very old)
  const oldOrphans = result.orphanedPages.filter((o) => {
    if (!o.page.lastModified) return false;
    const lastMod = new Date(o.page.lastModified);
    const monthsOld = monthsDiff(lastMod, new Date());
    return monthsOld >= 12; // Only suggest deleting orphans older than 12 months
  });
  for (const orphanInfo of oldOrphans) {
    actions.push({
      type: "delete",
      pageId: orphanInfo.page.pageId,
      pageTitle: orphanInfo.page.title,
      safe: false,
    });
  }

  return actions;
}

/**
 * Handle fix actions - apply safe actions automatically, prompt for interactive ones.
 */
async function handleFixActions(
  result: AuditResult,
  options: AuditOptions,
  atlcliDir: string,
  opts: OutputOptions
): Promise<FixResult[]> {
  const actions = generateFixActions(result, options, atlcliDir);
  if (actions.length === 0) {
    return [];
  }

  const results: FixResult[] = [];
  let client: ConfluenceClient | null = null;
  let skipAllInteractive = false;
  let applyAllInteractive = false;

  // Create Confluence client for API operations (if not dry-run and have unsafe actions)
  const hasApiActions = actions.some(
    (a) => (a.type === "add-label" || a.type === "archive" || a.type === "delete") && !options.dryRun
  );

  if (hasApiActions) {
    const config = await loadConfig();
    const profile = getActiveProfile(config);
    if (!profile) {
      output("Warning: No active profile - skipping API operations", opts);
    } else {
      client = new ConfluenceClient(profile);
    }
  }

  // Process safe actions first
  const safeActions = actions.filter((a) => a.safe);
  const unsafeActions = actions.filter((a) => !a.safe);

  if (safeActions.length > 0) {
    if (options.dryRun) {
      output(`\n[DRY RUN] Would apply ${safeActions.length} safe action(s):`, opts);
    } else {
      output(`\nApplying ${safeActions.length} safe action(s)...`, opts);
    }

    for (const action of safeActions) {
      const actionResult = await executeFixAction(action, client, result, options.dryRun, opts);
      results.push(actionResult);
    }
  }

  // Process interactive actions
  if (unsafeActions.length > 0) {
    if (options.dryRun) {
      output(`\n[DRY RUN] Would prompt for ${unsafeActions.length} interactive action(s):`, opts);
      for (const action of unsafeActions) {
        results.push({
          action,
          success: false,
          skipped: true,
        });
        outputActionDescription(action, true, opts);
      }
    } else {
      output(`\n${unsafeActions.length} interactive action(s) require confirmation:`, opts);

      for (const action of unsafeActions) {
        if (skipAllInteractive) {
          results.push({ action, success: false, skipped: true });
          continue;
        }

        outputActionDescription(action, false, opts);

        let proceed = false;
        if (applyAllInteractive) {
          proceed = true;
        } else {
          const answer = await promptConfirm("  Apply this action?");
          if (answer === "all") {
            applyAllInteractive = true;
            proceed = true;
          } else if (answer === "skip") {
            skipAllInteractive = true;
            results.push({ action, success: false, skipped: true });
            continue;
          } else {
            proceed = answer === "yes";
          }
        }

        if (proceed) {
          const actionResult = await executeFixAction(action, client, result, false, opts);
          results.push(actionResult);
        } else {
          results.push({ action, success: false, skipped: true });
        }
      }
    }
  }

  return results;
}

/**
 * Execute a single fix action.
 */
async function executeFixAction(
  action: FixAction,
  client: ConfluenceClient | null,
  result: AuditResult,
  dryRun: boolean,
  opts: OutputOptions
): Promise<FixResult> {
  if (dryRun) {
    outputActionDescription(action, true, opts);
    return { action, success: true, skipped: true };
  }

  try {
    switch (action.type) {
      case "add-label":
        if (!client) {
          return { action, success: false, error: "No Confluence client available" };
        }
        await client.addLabels(action.pageId!, [action.label!]);
        output(`  ✓ Added label "${action.label}" to "${action.pageTitle}"`, opts);
        return { action, success: true };

      case "generate-report":
        const markdown = formatMarkdown(result);
        await mkdir(dirname(action.reportPath!), { recursive: true });
        await writeFile(action.reportPath!, markdown, "utf-8");
        output(`  ✓ Generated report: ${action.reportPath}`, opts);
        return { action, success: true };

      case "archive":
        if (!client) {
          return { action, success: false, error: "No Confluence client available" };
        }
        await client.archivePage(action.pageId!);
        output(`  ✓ Archived "${action.pageTitle}"`, opts);
        return { action, success: true };

      case "delete":
        if (!client) {
          return { action, success: false, error: "No Confluence client available" };
        }
        await client.deletePage(action.pageId!);
        output(`  ✓ Deleted "${action.pageTitle}"`, opts);
        return { action, success: true };

      default:
        return { action, success: false, error: `Unknown action type: ${(action as FixAction).type}` };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    output(`  ✗ Failed: ${errorMsg}`, opts);
    return { action, success: false, error: errorMsg };
  }
}

/**
 * Output a description of what an action will do.
 */
function outputActionDescription(action: FixAction, isDryRun: boolean, opts: OutputOptions): void {
  const prefix = isDryRun ? "  [DRY RUN]" : " ";
  switch (action.type) {
    case "add-label":
      output(`${prefix} Add label "${action.label}" to "${action.pageTitle}"`, opts);
      break;
    case "generate-report":
      output(`${prefix} Generate report: ${action.reportPath}`, opts);
      break;
    case "archive":
      output(`${prefix} Archive page: "${action.pageTitle}"`, opts);
      break;
    case "delete":
      output(`${prefix} Delete page: "${action.pageTitle}"`, opts);
      break;
  }
}

/**
 * Output fix results summary.
 */
function outputFixResults(results: FixResult[], dryRun: boolean, opts: OutputOptions): void {
  const successful = results.filter((r) => r.success && !r.skipped).length;
  const failed = results.filter((r) => !r.success && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  if (dryRun) {
    output(`Fix Summary (DRY RUN): ${results.length} action(s) would be applied`, opts);
  } else {
    const parts: string[] = [];
    if (successful > 0) parts.push(`${successful} applied`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    output(`Fix Summary: ${parts.join(", ")}`, opts);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function monthsDiff(earlier: Date, later: Date): number {
  const months =
    (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
  return Math.max(0, months);
}

function extractDomain(url: string | null): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

// ============================================================================
// Help
// ============================================================================

export function auditWikiHelp(): string {
  return `Usage: atlcli audit wiki [options]

Audit Confluence wiki content for stale pages, orphans, and broken links.

Check Options:
  --all                     Run all checks (except external link options)
  --stale-high <months>     Flag pages not edited in N+ months as high risk
  --stale-medium <months>   Flag pages not edited in N+ months as medium risk
  --stale-low <months>      Flag pages not edited in N+ months as low risk
  --orphans                 Find pages with no incoming links
  --broken-links            Find broken internal links
  --single-contributor      Find pages with only one contributor (bus factor risk)
  --inactive-contributors   Find pages where all contributors are inactive
  --external-links          List all external URLs (inventory only)
  --check-external          Verify external links via HTTP (finds broken URLs)
  --missing-label <label>   Find pages missing a required label
  --restricted              Find pages with view/edit restrictions
  --drafts                  Find unpublished draft pages
  --archived                Find archived pages
  --high-churn <N>          Find pages with N+ versions (heavily edited)
  --folders                 Check for folder structure issues (empty folders, missing index.md)

Scope Filtering:
  --label <label>           Only audit pages with this label
  --under-page <pageId>     Only audit pages under this ancestor
  --exclude-label <label>   Exclude pages with this label

Output Options:
  --json                    Output as JSON
  --markdown                Output as Markdown report
  --export-graph            Export full link graph as JSON

Action Options:
  --rebuild-graph           Rebuild link graph from synced markdown files
  --refresh-users           Refresh user active/inactive status from API
  --local-only              Only audit synced pages (default)
  --include-remote          Include unsynced Confluence pages via API

Fix Options:
  --fix                     Apply fixes (safe actions auto-apply, unsafe prompt)
  --dry-run                 Preview fixes without applying (use with --fix)
  --fix-label <label>       Label to add to stale pages (default: "needs-review")
  --report <path>           Path for generated report (default: .atlcli/audit-report.md)

Other:
  --dir <path>              Directory to audit (default: current)
  --help, -h                Show this help

Configuration:
  Configure default checks in ~/.atlcli/config.json:
  {
    "audit": {
      "defaultChecks": ["stale", "orphans", "broken-links"],
      "staleThresholds": { "high": 12, "medium": 6, "low": 3 }
    }
  }

  Valid defaultChecks: stale, orphans, broken-links, single-contributor,
                       inactive-contributors, external-links, folders

Examples:
  # Run all checks with 12-month high threshold
  atlcli audit wiki --all --stale-high 12

  # Check for stale with multiple thresholds
  atlcli audit wiki --stale-high 12 --stale-medium 6 --stale-low 3

  # Check only for orphans and broken links
  atlcli audit wiki --orphans --broken-links

  # Generate JSON report
  atlcli audit wiki --all --stale-high 12 --json > report.json

  # Generate Markdown report
  atlcli audit wiki --all --stale-high 12 --markdown > AUDIT-REPORT.md

  # Export link graph for visualization
  atlcli audit wiki --export-graph > graph.json

  # Audit only pages with a specific label
  atlcli audit wiki --all --label documentation

  # Audit only pages under a specific parent
  atlcli audit wiki --all --under-page 12345678

  # Exclude archived pages from audit
  atlcli audit wiki --all --exclude-label archived

  # Preview fixes without applying (dry run)
  atlcli audit wiki --all --stale-high 12 --fix --dry-run

  # Apply fixes (adds labels to stale pages, generates report)
  atlcli audit wiki --all --stale-high 12 --fix

  # Use custom label for stale pages
  atlcli audit wiki --stale-high 12 --fix --fix-label stale-content

  # Include unsynced remote pages in audit
  atlcli audit wiki --all --include-remote

  # Refresh user status from Confluence API
  atlcli audit wiki --refresh-users --inactive-contributors`;
}

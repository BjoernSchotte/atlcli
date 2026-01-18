import { ERROR_CODES, OutputOptions, fail, hasFlag, getFlag, output, loadConfig } from "@atlcli/core";
import {
  findAtlcliDir,
  getAtlcliPath,
  createSyncDb,
  hasSyncDb,
  type SyncDbAdapter,
  type PageRecord,
  type LinkRecord,
  type UserRecord,
} from "@atlcli/confluence";

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
  // Output
  json: boolean;
  markdown: boolean;
  exportGraph: boolean;
  // Actions
  rebuildGraph: boolean;
  refreshUsers: boolean;
}

interface StalePageInfo {
  page: PageRecord;
  monthsStale: number;
  severity: "high" | "medium" | "low";
  author: UserRecord | null;
}

interface OrphanedPageInfo {
  page: PageRecord;
}

interface BrokenLinkInfo {
  link: LinkRecord;
  sourcePage: PageRecord | null;
}

interface ContributorRiskInfo {
  page: PageRecord;
  riskType: "bus-factor" | "no-maintainer";
  details: string;
  contributors: Array<{ userId: string; displayName: string | null; isActive: boolean | null }>;
}

interface ExternalLinkInfo {
  link: LinkRecord;
  sourcePage: PageRecord | null;
  domain: string;
}

interface AuditResult {
  space: string | null;
  generatedAt: string;
  summary: {
    stale: { high: number; medium: number; low: number };
    orphans: number;
    brokenLinks: number;
    contributorRisks: number;
    externalLinks: number;
  };
  stalePages: StalePageInfo[];
  orphanedPages: OrphanedPageInfo[];
  brokenLinks: BrokenLinkInfo[];
  contributorRisks: ContributorRiskInfo[];
  externalLinks: ExternalLinkInfo[];
  userCacheAge: string | null;
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

  // Find .atlcli directory
  const dir = (getFlag(flags, "dir") as string) ?? ".";
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
    options.rebuildGraph ||
    options.refreshUsers ||
    options.exportGraph;

  if (!hasAnyCheck) {
    fail(
      opts,
      1,
      ERROR_CODES.VALIDATION,
      "No audit checks specified. Use --all or specify individual checks (--orphans, --broken-links, etc.)"
    );
  }

  // Open adapter
  const adapter = await createSyncDb(atlcliPath, { autoMigrate: false });

  try {
    // Handle special actions first
    if (options.rebuildGraph) {
      await handleRebuildGraph(adapter, atlcliDir, opts);
      if (!options.checkOrphans && !options.checkBrokenLinks && options.staleHigh === undefined) {
        return; // Only rebuild was requested
      }
    }

    if (options.refreshUsers) {
      output("User refresh not yet implemented (requires API calls)", opts);
      // TODO: Implement user refresh via Confluence API
    }

    if (options.exportGraph) {
      await handleExportGraph(adapter, opts);
      return;
    }

    // Run audit
    const result = await runAudit(adapter, options);

    // Output results
    if (options.json || opts.json) {
      output(result, { ...opts, json: true });
    } else if (options.markdown) {
      output(formatMarkdown(result), opts);
    } else {
      output(formatTable(result, options), opts);
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

  // Parse thresholds (flags override config)
  const staleHighStr = getFlag(flags, "stale-high") as string | undefined;
  const staleMediumStr = getFlag(flags, "stale-medium") as string | undefined;
  const staleLowStr = getFlag(flags, "stale-low") as string | undefined;

  const staleHigh = staleHighStr
    ? parseInt(staleHighStr, 10)
    : auditConfig?.staleThresholds?.high;
  const staleMedium = staleMediumStr
    ? parseInt(staleMediumStr, 10)
    : auditConfig?.staleThresholds?.medium;
  const staleLow = staleLowStr
    ? parseInt(staleLowStr, 10)
    : auditConfig?.staleThresholds?.low;

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

  return {
    staleHigh: all ? staleHigh : staleHigh,
    staleMedium,
    staleLow,
    checkOrphans: all || hasFlag(flags, "orphans"),
    checkBrokenLinks: all || hasFlag(flags, "broken-links"),
    checkSingleContributor: all || hasFlag(flags, "single-contributor"),
    checkInactiveContributors: all || hasFlag(flags, "inactive-contributors"),
    checkExternalLinks: hasFlag(flags, "external-links"), // Not included in --all by default
    json: hasFlag(flags, "json"),
    markdown: hasFlag(flags, "markdown"),
    exportGraph: hasFlag(flags, "export-graph"),
    rebuildGraph: hasFlag(flags, "rebuild-graph"),
    refreshUsers: hasFlag(flags, "refresh-users"),
  };
}

// ============================================================================
// Audit Logic
// ============================================================================

async function runAudit(adapter: SyncDbAdapter, options: AuditOptions): Promise<AuditResult> {
  const result: AuditResult = {
    space: await adapter.getMeta("space_key"),
    generatedAt: new Date().toISOString(),
    summary: {
      stale: { high: 0, medium: 0, low: 0 },
      orphans: 0,
      brokenLinks: 0,
      contributorRisks: 0,
      externalLinks: 0,
    },
    stalePages: [],
    orphanedPages: [],
    brokenLinks: [],
    contributorRisks: [],
    externalLinks: [],
    userCacheAge: null,
  };

  // Get user cache age
  const oldestCheck = await adapter.getOldestUserCheck();
  if (oldestCheck) {
    result.userCacheAge = formatTimeAgo(oldestCheck);
  }

  // Stale detection
  if (options.staleHigh !== undefined) {
    result.stalePages = await detectStalePages(adapter, options);
    result.summary.stale.high = result.stalePages.filter((p) => p.severity === "high").length;
    result.summary.stale.medium = result.stalePages.filter((p) => p.severity === "medium").length;
    result.summary.stale.low = result.stalePages.filter((p) => p.severity === "low").length;
  }

  // Orphan detection
  if (options.checkOrphans) {
    const orphans = await adapter.getOrphanedPages();
    result.orphanedPages = orphans.map((page) => ({ page }));
    result.summary.orphans = orphans.length;
  }

  // Broken links
  if (options.checkBrokenLinks) {
    const brokenLinks = await adapter.getBrokenLinks();
    result.brokenLinks = await Promise.all(
      brokenLinks.map(async (link) => ({
        link,
        sourcePage: await adapter.getPage(link.sourcePageId),
      }))
    );
    result.summary.brokenLinks = brokenLinks.length;
  }

  // Contributor risks
  if (options.checkSingleContributor || options.checkInactiveContributors) {
    result.contributorRisks = await detectContributorRisks(adapter, options);
    result.summary.contributorRisks = result.contributorRisks.length;
  }

  // External links
  if (options.checkExternalLinks) {
    const externalLinks = await adapter.getExternalLinks();
    result.externalLinks = await Promise.all(
      externalLinks.map(async (link) => ({
        link,
        sourcePage: await adapter.getPage(link.sourcePageId),
        domain: extractDomain(link.targetPath),
      }))
    );
    result.summary.externalLinks = externalLinks.length;
  }

  return result;
}

async function detectStalePages(
  adapter: SyncDbAdapter,
  options: AuditOptions
): Promise<StalePageInfo[]> {
  const now = new Date();
  const stalePages: StalePageInfo[] = [];

  // Get all pages
  const pages = await adapter.listPages({});

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
// Formatters
// ============================================================================

function formatTable(result: AuditResult, options: AuditOptions): string {
  const lines: string[] = [];

  lines.push(`Audit Report${result.space ? ` - ${result.space} Space` : ""}`);
  lines.push("=".repeat(50));
  lines.push("");

  // Summary
  const totalIssues =
    result.summary.stale.high +
    result.summary.stale.medium +
    result.summary.stale.low +
    result.summary.orphans +
    result.summary.brokenLinks +
    result.summary.contributorRisks;

  if (totalIssues === 0 && result.summary.externalLinks === 0) {
    lines.push("No issues found.");
    if (result.userCacheAge) {
      lines.push(`(User status as of ${result.userCacheAge})`);
    }
    return lines.join("\n");
  }

  // Stale pages
  if (result.stalePages.length > 0) {
    const highCount = result.summary.stale.high;
    const medCount = result.summary.stale.medium;
    const lowCount = result.summary.stale.low;

    lines.push(`STALE PAGES (${result.stalePages.length} pages)`);
    if (highCount > 0) lines.push(`  High risk:   ${highCount} pages`);
    if (medCount > 0) lines.push(`  Medium risk: ${medCount} pages`);
    if (lowCount > 0) lines.push(`  Low risk:    ${lowCount} pages`);
    lines.push("");

    // Show details for high-risk pages
    const highRisk = result.stalePages.filter((p) => p.severity === "high");
    if (highRisk.length > 0) {
      lines.push("High Risk (oldest first):");
      for (const info of highRisk.slice(0, 10)) {
        const authorStr = info.author
          ? `${info.author.displayName ?? info.author.userId}${info.author.isActive === false ? " (inactive)" : ""}`
          : "unknown";
        lines.push(`  - ${info.page.title} (${info.monthsStale} months, by ${authorStr})`);
      }
      if (highRisk.length > 10) {
        lines.push(`  ... and ${highRisk.length - 10} more`);
      }
      lines.push("");
    }
  }

  // Orphaned pages
  if (result.orphanedPages.length > 0) {
    lines.push(`ORPHANED PAGES (${result.summary.orphans} pages) - No incoming links`);
    for (const info of result.orphanedPages.slice(0, 10)) {
      lines.push(`  - ${info.page.title} (${info.page.path})`);
    }
    if (result.orphanedPages.length > 10) {
      lines.push(`  ... and ${result.orphanedPages.length - 10} more`);
    }
    lines.push("");
  }

  // Broken links
  if (result.brokenLinks.length > 0) {
    lines.push(`BROKEN LINKS (${result.summary.brokenLinks} links)`);
    for (const info of result.brokenLinks.slice(0, 10)) {
      const source = info.sourcePage?.title ?? info.link.sourcePageId;
      const target = info.link.targetPath ?? "unknown";
      const line = info.link.lineNumber ? `:${info.link.lineNumber}` : "";
      lines.push(`  - ${source}${line} -> ${target}`);
    }
    if (result.brokenLinks.length > 10) {
      lines.push(`  ... and ${result.brokenLinks.length - 10} more`);
    }
    lines.push("");
  }

  // Contributor risks
  if (result.contributorRisks.length > 0) {
    lines.push(`CONTRIBUTOR RISKS (${result.summary.contributorRisks} pages)`);
    for (const info of result.contributorRisks.slice(0, 10)) {
      const riskLabel = info.riskType === "bus-factor" ? "Bus Factor" : "No Maintainer";
      lines.push(`  - ${info.page.title} [${riskLabel}] - ${info.details}`);
    }
    if (result.contributorRisks.length > 10) {
      lines.push(`  ... and ${result.contributorRisks.length - 10} more`);
    }
    lines.push("");
  }

  // External links
  if (result.externalLinks.length > 0) {
    lines.push(`EXTERNAL LINKS (${result.summary.externalLinks} links)`);

    // Group by domain
    const byDomain = new Map<string, number>();
    for (const info of result.externalLinks) {
      const count = byDomain.get(info.domain) ?? 0;
      byDomain.set(info.domain, count + 1);
    }

    const sorted = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 10)) {
      lines.push(`  ${domain}: ${count} links`);
    }
    if (sorted.length > 10) {
      lines.push(`  ... and ${sorted.length - 10} more domains`);
    }
    lines.push("");
  }

  // Footer
  if (result.userCacheAge) {
    lines.push(`User status as of ${result.userCacheAge}`);
  }
  lines.push("");
  lines.push("Use --json for full details, --markdown for report format.");

  return lines.join("\n");
}

function formatMarkdown(result: AuditResult): string {
  const lines: string[] = [];

  lines.push(`# Audit Report${result.space ? `: ${result.space} Space` : ""}`);
  lines.push("");
  lines.push(`Generated: ${new Date(result.generatedAt).toLocaleString()}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Check | Count |");
  lines.push("|-------|-------|");

  const totalStale = result.summary.stale.high + result.summary.stale.medium + result.summary.stale.low;
  if (totalStale > 0) {
    lines.push(
      `| Stale pages | ${totalStale} (High: ${result.summary.stale.high}, Med: ${result.summary.stale.medium}, Low: ${result.summary.stale.low}) |`
    );
  }
  if (result.summary.orphans > 0) {
    lines.push(`| Orphaned pages | ${result.summary.orphans} |`);
  }
  if (result.summary.brokenLinks > 0) {
    lines.push(`| Broken links | ${result.summary.brokenLinks} |`);
  }
  if (result.summary.contributorRisks > 0) {
    lines.push(`| Contributor risks | ${result.summary.contributorRisks} |`);
  }
  if (result.summary.externalLinks > 0) {
    lines.push(`| External links | ${result.summary.externalLinks} |`);
  }
  lines.push("");

  // Stale pages
  if (result.stalePages.length > 0) {
    lines.push("## Stale Pages");
    lines.push("");
    lines.push("| Page | Months Stale | Severity | Author |");
    lines.push("|------|--------------|----------|--------|");
    for (const info of result.stalePages) {
      const authorStr = info.author
        ? `${info.author.displayName ?? info.author.userId}${info.author.isActive === false ? " (inactive)" : ""}`
        : "unknown";
      lines.push(`| ${info.page.title} | ${info.monthsStale} | ${info.severity} | ${authorStr} |`);
    }
    lines.push("");
  }

  // Orphaned pages
  if (result.orphanedPages.length > 0) {
    lines.push("## Orphaned Pages");
    lines.push("");
    lines.push("| Page | Path |");
    lines.push("|------|------|");
    for (const info of result.orphanedPages) {
      lines.push(`| ${info.page.title} | \`${info.page.path}\` |`);
    }
    lines.push("");
  }

  // Broken links
  if (result.brokenLinks.length > 0) {
    lines.push("## Broken Links");
    lines.push("");
    lines.push("| Source | Target | Line |");
    lines.push("|--------|--------|------|");
    for (const info of result.brokenLinks) {
      const source = info.sourcePage?.title ?? info.link.sourcePageId;
      const target = info.link.targetPath ?? "unknown";
      const line = info.link.lineNumber ?? "-";
      lines.push(`| ${source} | ${target} | ${line} |`);
    }
    lines.push("");
  }

  // Contributor risks
  if (result.contributorRisks.length > 0) {
    lines.push("## Contributor Risks");
    lines.push("");
    lines.push("| Page | Risk | Details |");
    lines.push("|------|------|---------|");
    for (const info of result.contributorRisks) {
      const riskLabel = info.riskType === "bus-factor" ? "Bus Factor" : "No Maintainer";
      lines.push(`| ${info.page.title} | ${riskLabel} | ${info.details} |`);
    }
    lines.push("");
  }

  // External links
  if (result.externalLinks.length > 0) {
    lines.push("## External Links");
    lines.push("");

    // Group by domain
    const byDomain = new Map<string, ExternalLinkInfo[]>();
    for (const info of result.externalLinks) {
      const list = byDomain.get(info.domain) ?? [];
      list.push(info);
      byDomain.set(info.domain, list);
    }

    const sorted = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [domain, links] of sorted) {
      lines.push(`### ${domain} (${links.length} links)`);
      lines.push("");
      for (const info of links.slice(0, 5)) {
        const source = info.sourcePage?.title ?? info.link.sourcePageId;
        lines.push(`- ${info.link.targetPath} (from ${source})`);
      }
      if (links.length > 5) {
        lines.push(`- ... and ${links.length - 5} more`);
      }
      lines.push("");
    }
  }

  // Footer
  if (result.userCacheAge) {
    lines.push("---");
    lines.push("");
    lines.push(`*User status cached as of ${result.userCacheAge}*`);
  }

  return lines.join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

function monthsDiff(earlier: Date, later: Date): number {
  const months =
    (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
  return Math.max(0, months);
}

function formatTimeAgo(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffDays > 0) {
    return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
  } else if (diffHours > 0) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  } else if (diffMinutes > 0) {
    return diffMinutes === 1 ? "1 minute ago" : `${diffMinutes} minutes ago`;
  } else {
    return "just now";
  }
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
  --all                     Run all checks (except --external-links)
  --stale-high <months>     Flag pages not edited in N+ months as high risk
  --stale-medium <months>   Flag pages not edited in N+ months as medium risk
  --stale-low <months>      Flag pages not edited in N+ months as low risk
  --orphans                 Find pages with no incoming links
  --broken-links            Find broken internal links
  --single-contributor      Find pages with only one contributor (bus factor risk)
  --inactive-contributors   Find pages where all contributors are inactive
  --external-links          List all external URLs (inventory only)

Output Options:
  --json                    Output as JSON
  --markdown                Output as Markdown report
  --export-graph            Export full link graph as JSON

Action Options:
  --rebuild-graph           Rebuild link graph from synced markdown files
  --refresh-users           Refresh user active/inactive status from API

Other:
  --dir <path>              Directory to audit (default: current)
  --help, -h                Show this help

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
  atlcli audit wiki --export-graph > graph.json`;
}

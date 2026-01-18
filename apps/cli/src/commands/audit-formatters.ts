/**
 * Audit command output formatters.
 *
 * Provides table, JSON, and markdown formatting for audit results.
 *
 * @module audit-formatters
 */

import type { PageRecord, LinkRecord, UserRecord } from "@atlcli/confluence";

// ============================================================================
// Types
// ============================================================================

export interface StalePageInfo {
  page: PageRecord;
  monthsStale: number;
  severity: "high" | "medium" | "low";
  author: UserRecord | null;
}

export interface OrphanedPageInfo {
  page: PageRecord;
}

export interface BrokenLinkInfo {
  link: LinkRecord;
  sourcePage: PageRecord | null;
}

export interface ContributorRiskInfo {
  page: PageRecord;
  riskType: "bus-factor" | "no-maintainer";
  details: string;
  contributors: Array<{ userId: string; displayName: string | null; isActive: boolean | null }>;
}

export interface ExternalLinkInfo {
  link: LinkRecord;
  sourcePage: PageRecord | null;
  domain: string;
  httpStatus?: number | "error";
  httpError?: string;
  isBroken?: boolean;
}

export interface MissingLabelInfo {
  page: PageRecord;
  currentLabels: string[];
}

export interface RestrictedPageInfo {
  page: PageRecord;
}

export interface ContentStatusInfo {
  page: PageRecord;
  status: "draft" | "archived";
}

export interface HighChurnInfo {
  page: PageRecord;
  versionCount: number;
}

export interface RemotePageInfo {
  pageId: string;
  title: string;
  lastModified: string | null;
  version: number;
  spaceKey: string;
  monthsStale?: number;
  severity?: "high" | "medium" | "low";
}

export interface AuditSummary {
  stale: { high: number; medium: number; low: number };
  orphans: number;
  brokenLinks: number;
  contributorRisks: number;
  externalLinks: number;
  brokenExternalLinks: number;
  missingLabel: number;
  restricted: number;
  drafts: number;
  archived: number;
  highChurn: number;
  unsynced: number;
  unsyncedStale: { high: number; medium: number; low: number };
}

export interface AuditResult {
  space: string | null;
  generatedAt: string;
  summary: AuditSummary;
  stalePages: StalePageInfo[];
  orphanedPages: OrphanedPageInfo[];
  brokenLinks: BrokenLinkInfo[];
  contributorRisks: ContributorRiskInfo[];
  externalLinks: ExternalLinkInfo[];
  missingLabelPages: MissingLabelInfo[];
  restrictedPages: RestrictedPageInfo[];
  draftPages: ContentStatusInfo[];
  archivedPages: ContentStatusInfo[];
  highChurnPages: HighChurnInfo[];
  userCacheAge: string | null;
  unsyncedPages: RemotePageInfo[];
  unsyncedStalePages: RemotePageInfo[];
}

// ============================================================================
// Helpers
// ============================================================================

export function formatTimeAgo(isoDate: string): string {
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

// ============================================================================
// Table Formatter
// ============================================================================

export function formatTable(result: AuditResult): string {
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
    result.summary.contributorRisks +
    result.summary.missingLabel +
    result.summary.restricted +
    result.summary.drafts +
    result.summary.archived +
    result.summary.highChurn +
    result.summary.unsynced +
    result.summary.unsyncedStale.high +
    result.summary.unsyncedStale.medium +
    result.summary.unsyncedStale.low;

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
    // Show broken external links first if any
    const brokenExternal = result.externalLinks.filter((i) => i.isBroken);
    if (brokenExternal.length > 0) {
      lines.push(`BROKEN EXTERNAL LINKS (${brokenExternal.length} links)`);
      for (const info of brokenExternal.slice(0, 10)) {
        const source = info.sourcePage?.title ?? info.link.sourcePageId;
        const url = info.link.targetPath ?? "unknown";
        const status = info.httpStatus === "error" ? info.httpError : `HTTP ${info.httpStatus}`;
        lines.push(`  - ${source} -> ${url} (${status})`);
      }
      if (brokenExternal.length > 10) {
        lines.push(`  ... and ${brokenExternal.length - 10} more`);
      }
      lines.push("");
    }

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

  // Missing label pages
  if (result.missingLabelPages.length > 0) {
    lines.push(`MISSING LABEL (${result.summary.missingLabel} pages)`);
    for (const info of result.missingLabelPages.slice(0, 10)) {
      const currentLabels =
        info.currentLabels.length > 0 ? `current: ${info.currentLabels.join(", ")}` : "no labels";
      lines.push(`  - ${info.page.title} (${currentLabels})`);
    }
    if (result.missingLabelPages.length > 10) {
      lines.push(`  ... and ${result.missingLabelPages.length - 10} more`);
    }
    lines.push("");
  }

  // Restricted pages
  if (result.restrictedPages.length > 0) {
    lines.push(`RESTRICTED PAGES (${result.summary.restricted} pages)`);
    for (const info of result.restrictedPages.slice(0, 10)) {
      lines.push(`  - ${info.page.title} (${info.page.path})`);
    }
    if (result.restrictedPages.length > 10) {
      lines.push(`  ... and ${result.restrictedPages.length - 10} more`);
    }
    lines.push("");
  }

  // Draft pages
  if (result.draftPages.length > 0) {
    lines.push(`DRAFT PAGES (${result.summary.drafts} pages)`);
    for (const info of result.draftPages.slice(0, 10)) {
      lines.push(`  - ${info.page.title} (${info.page.path})`);
    }
    if (result.draftPages.length > 10) {
      lines.push(`  ... and ${result.draftPages.length - 10} more`);
    }
    lines.push("");
  }

  // Archived pages
  if (result.archivedPages.length > 0) {
    lines.push(`ARCHIVED PAGES (${result.summary.archived} pages)`);
    for (const info of result.archivedPages.slice(0, 10)) {
      lines.push(`  - ${info.page.title} (${info.page.path})`);
    }
    if (result.archivedPages.length > 10) {
      lines.push(`  ... and ${result.archivedPages.length - 10} more`);
    }
    lines.push("");
  }

  // High churn pages
  if (result.highChurnPages.length > 0) {
    lines.push(`HIGH CHURN PAGES (${result.summary.highChurn} pages)`);
    for (const info of result.highChurnPages.slice(0, 10)) {
      lines.push(`  - ${info.page.title} (${info.versionCount} versions)`);
    }
    if (result.highChurnPages.length > 10) {
      lines.push(`  ... and ${result.highChurnPages.length - 10} more`);
    }
    lines.push("");
  }

  // Unsynced pages (remote only)
  if (result.unsyncedPages.length > 0) {
    lines.push(
      `UNSYNCED PAGES (${result.summary.unsynced} pages) - Remote only, not synced locally`
    );
    for (const info of result.unsyncedPages.slice(0, 10)) {
      lines.push(`  - ${info.title} (v${info.version})`);
    }
    if (result.unsyncedPages.length > 10) {
      lines.push(`  ... and ${result.unsyncedPages.length - 10} more`);
    }
    lines.push("");
  }

  // Unsynced stale pages
  if (result.unsyncedStalePages.length > 0) {
    const highCount = result.summary.unsyncedStale.high;
    const medCount = result.summary.unsyncedStale.medium;
    const lowCount = result.summary.unsyncedStale.low;

    lines.push(`UNSYNCED STALE PAGES (${result.unsyncedStalePages.length} pages)`);
    if (highCount > 0) lines.push(`  High risk:   ${highCount} pages`);
    if (medCount > 0) lines.push(`  Medium risk: ${medCount} pages`);
    if (lowCount > 0) lines.push(`  Low risk:    ${lowCount} pages`);
    lines.push("");

    // Show details for high-risk unsynced pages
    const highRisk = result.unsyncedStalePages.filter((p) => p.severity === "high");
    if (highRisk.length > 0) {
      lines.push("High Risk (oldest first):");
      for (const info of highRisk.slice(0, 10)) {
        lines.push(`  - ${info.title} (${info.monthsStale} months)`);
      }
      if (highRisk.length > 10) {
        lines.push(`  ... and ${highRisk.length - 10} more`);
      }
      lines.push("");
    }
  }

  // Footer
  if (result.userCacheAge) {
    lines.push(`User status as of ${result.userCacheAge}`);
  }
  lines.push("");
  lines.push("Use --json for full details, --markdown for report format.");

  return lines.join("\n");
}

// ============================================================================
// Markdown Formatter
// ============================================================================

export function formatMarkdown(result: AuditResult): string {
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
  if (result.summary.missingLabel > 0) {
    lines.push(`| Missing label | ${result.summary.missingLabel} |`);
  }
  if (result.summary.restricted > 0) {
    lines.push(`| Restricted pages | ${result.summary.restricted} |`);
  }
  if (result.summary.drafts > 0) {
    lines.push(`| Draft pages | ${result.summary.drafts} |`);
  }
  if (result.summary.archived > 0) {
    lines.push(`| Archived pages | ${result.summary.archived} |`);
  }
  if (result.summary.highChurn > 0) {
    lines.push(`| High churn pages | ${result.summary.highChurn} |`);
  }
  if (result.summary.unsynced > 0) {
    lines.push(`| Unsynced pages | ${result.summary.unsynced} |`);
  }
  const totalUnsyncedStale =
    result.summary.unsyncedStale.high +
    result.summary.unsyncedStale.medium +
    result.summary.unsyncedStale.low;
  if (totalUnsyncedStale > 0) {
    lines.push(
      `| Unsynced stale | ${totalUnsyncedStale} (High: ${result.summary.unsyncedStale.high}, Med: ${result.summary.unsyncedStale.medium}, Low: ${result.summary.unsyncedStale.low}) |`
    );
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

  // Broken external links
  const brokenExternal = result.externalLinks.filter((i) => i.isBroken);
  if (brokenExternal.length > 0) {
    lines.push("## Broken External Links");
    lines.push("");
    lines.push("| URL | Source | Status |");
    lines.push("|-----|--------|--------|");
    for (const info of brokenExternal) {
      const source = info.sourcePage?.title ?? info.link.sourcePageId;
      const url = info.link.targetPath ?? "unknown";
      const status = info.httpStatus === "error" ? info.httpError : `HTTP ${info.httpStatus}`;
      lines.push(`| ${url} | ${source} | ${status} |`);
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
        const statusStr = info.isBroken ? " ❌" : info.httpStatus ? " ✓" : "";
        lines.push(`- ${info.link.targetPath} (from ${source})${statusStr}`);
      }
      if (links.length > 5) {
        lines.push(`- ... and ${links.length - 5} more`);
      }
      lines.push("");
    }
  }

  // Missing label pages
  if (result.missingLabelPages.length > 0) {
    lines.push("## Pages Missing Required Label");
    lines.push("");
    lines.push("| Page | Current Labels |");
    lines.push("|------|----------------|");
    for (const info of result.missingLabelPages) {
      const currentLabels = info.currentLabels.length > 0 ? info.currentLabels.join(", ") : "(none)";
      lines.push(`| ${info.page.title} | ${currentLabels} |`);
    }
    lines.push("");
  }

  // Restricted pages
  if (result.restrictedPages.length > 0) {
    lines.push("## Restricted Pages");
    lines.push("");
    lines.push("| Page | Path |");
    lines.push("|------|------|");
    for (const info of result.restrictedPages) {
      lines.push(`| ${info.page.title} | \`${info.page.path}\` |`);
    }
    lines.push("");
  }

  // Draft pages
  if (result.draftPages.length > 0) {
    lines.push("## Draft Pages");
    lines.push("");
    lines.push("| Page | Path |");
    lines.push("|------|------|");
    for (const info of result.draftPages) {
      lines.push(`| ${info.page.title} | \`${info.page.path}\` |`);
    }
    lines.push("");
  }

  // Archived pages
  if (result.archivedPages.length > 0) {
    lines.push("## Archived Pages");
    lines.push("");
    lines.push("| Page | Path |");
    lines.push("|------|------|");
    for (const info of result.archivedPages) {
      lines.push(`| ${info.page.title} | \`${info.page.path}\` |`);
    }
    lines.push("");
  }

  // High churn pages
  if (result.highChurnPages.length > 0) {
    lines.push("## High Churn Pages");
    lines.push("");
    lines.push("| Page | Version Count |");
    lines.push("|------|---------------|");
    for (const info of result.highChurnPages) {
      lines.push(`| ${info.page.title} | ${info.versionCount} |`);
    }
    lines.push("");
  }

  // Unsynced pages (remote only)
  if (result.unsyncedPages.length > 0) {
    lines.push("## Unsynced Pages (Remote Only)");
    lines.push("");
    lines.push("| Page | Version | Last Modified |");
    lines.push("|------|---------|---------------|");
    for (const info of result.unsyncedPages) {
      const lastMod = info.lastModified
        ? new Date(info.lastModified).toLocaleDateString()
        : "unknown";
      lines.push(`| ${info.title} | ${info.version} | ${lastMod} |`);
    }
    lines.push("");
  }

  // Unsynced stale pages
  if (result.unsyncedStalePages.length > 0) {
    lines.push("## Unsynced Stale Pages");
    lines.push("");
    lines.push("| Page | Months Stale | Severity |");
    lines.push("|------|--------------|----------|");
    for (const info of result.unsyncedStalePages) {
      lines.push(`| ${info.title} | ${info.monthsStale ?? "-"} | ${info.severity ?? "-"} |`);
    }
    lines.push("");
  }

  // Footer
  if (result.userCacheAge) {
    lines.push("---");
    lines.push("");
    lines.push(`*User status cached as of ${result.userCacheAge}*`);
  }

  return lines.join("\n");
}

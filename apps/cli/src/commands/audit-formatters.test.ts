import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PageRecord, LinkRecord, UserRecord } from "@atlcli/confluence";
import {
  formatTimeAgo,
  formatTable,
  formatMarkdown,
  type AuditResult,
  type StalePageInfo,
  type OrphanedPageInfo,
  type BrokenLinkInfo,
  type ExternalLinkInfo,
} from "./audit-formatters.js";

// ============================================================================
// Test Helpers
// ============================================================================

const createTestPage = (overrides?: Partial<PageRecord>): PageRecord => ({
  pageId: "page-1",
  path: "page-1.md",
  title: "Test Page",
  spaceKey: "TEST",
  version: 1,
  lastSyncedAt: new Date().toISOString(),
  localHash: "abc",
  remoteHash: "abc",
  baseHash: "abc",
  syncState: "synced",
  parentId: null,
  ancestors: [],
  hasAttachments: false,
  createdBy: null,
  createdAt: new Date().toISOString(),
  lastModifiedBy: null,
  lastModified: new Date().toISOString(),
  contentStatus: "current",
  versionCount: 1,
  wordCount: null,
  isRestricted: false,
  syncCreatedAt: new Date().toISOString(),
  syncUpdatedAt: new Date().toISOString(),
  remoteInaccessibleAt: null,
  remoteInaccessibleReason: null,
  ...overrides,
});

const createTestUser = (overrides?: Partial<UserRecord>): UserRecord => ({
  userId: "user-1",
  displayName: "Test User",
  email: null,
  isActive: true,
  lastCheckedAt: new Date().toISOString(),
  ...overrides,
});

const createEmptyAuditResult = (space: string | null = "TEST"): AuditResult => ({
  space,
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
  userCacheAge: null,
  unsyncedPages: [],
  unsyncedStalePages: [],
});

// ============================================================================
// formatTimeAgo tests
// ============================================================================

describe("formatTimeAgo", () => {
  test("returns 'just now' for very recent dates", () => {
    const now = new Date().toISOString();
    expect(formatTimeAgo(now)).toBe("just now");
  });

  test("returns minutes ago for dates less than an hour old", () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(formatTimeAgo(thirtyMinutesAgo)).toBe("30 minutes ago");
  });

  test("returns singular minute for 1 minute ago", () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatTimeAgo(oneMinuteAgo)).toBe("1 minute ago");
  });

  test("returns hours ago for dates less than a day old", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(fiveHoursAgo)).toBe("5 hours ago");
  });

  test("returns singular hour for 1 hour ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(oneHourAgo)).toBe("1 hour ago");
  });

  test("returns days ago for older dates", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(tenDaysAgo)).toBe("10 days ago");
  });

  test("returns singular day for 1 day ago", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(oneDayAgo)).toBe("1 day ago");
  });
});

// ============================================================================
// formatTable tests
// ============================================================================

describe("formatTable", () => {
  test("shows 'No issues found' for empty results", () => {
    const result = createEmptyAuditResult();
    const output = formatTable(result);

    expect(output).toContain("Audit Report - TEST Space");
    expect(output).toContain("No issues found");
  });

  test("includes space name in header when provided", () => {
    const result = createEmptyAuditResult("DOCS");
    const output = formatTable(result);

    expect(output).toContain("Audit Report - DOCS Space");
  });

  test("omits space name when null", () => {
    const result = createEmptyAuditResult(null);
    const output = formatTable(result);

    expect(output).toContain("Audit Report");
    expect(output).not.toContain("Space");
  });

  test("formats stale pages with severity breakdown", () => {
    const result = createEmptyAuditResult();
    result.summary.stale = { high: 2, medium: 3, low: 1 };
    result.stalePages = [
      {
        page: createTestPage({ pageId: "p1", title: "Stale Page 1" }),
        monthsStale: 24,
        severity: "high",
        author: createTestUser(),
      },
      {
        page: createTestPage({ pageId: "p2", title: "Stale Page 2" }),
        monthsStale: 18,
        severity: "high",
        author: null,
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("STALE PAGES (2 pages)");
    expect(output).toContain("High risk:   2 pages");
    expect(output).toContain("Medium risk: 3 pages");
    expect(output).toContain("Low risk:    1 pages");
    expect(output).toContain("Stale Page 1 (24 months, by Test User)");
    expect(output).toContain("Stale Page 2 (18 months, by unknown)");
  });

  test("shows inactive author status", () => {
    const result = createEmptyAuditResult();
    result.summary.stale = { high: 1, medium: 0, low: 0 };
    result.stalePages = [
      {
        page: createTestPage({ title: "Old Page" }),
        monthsStale: 24,
        severity: "high",
        author: createTestUser({ isActive: false }),
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("Test User (inactive)");
  });

  test("formats orphaned pages", () => {
    const result = createEmptyAuditResult();
    result.summary.orphans = 2;
    result.orphanedPages = [
      { page: createTestPage({ title: "Orphan 1", path: "orphan1.md" }) },
      { page: createTestPage({ title: "Orphan 2", path: "orphan2.md" }) },
    ];

    const output = formatTable(result);

    expect(output).toContain("ORPHANED PAGES (2 pages)");
    expect(output).toContain("Orphan 1 (orphan1.md)");
    expect(output).toContain("Orphan 2 (orphan2.md)");
  });

  test("formats broken links with line numbers", () => {
    const result = createEmptyAuditResult();
    result.summary.brokenLinks = 1;
    result.brokenLinks = [
      {
        link: {
          sourcePageId: "page-1",
          targetPageId: null,
          targetPath: "./missing.md",
          linkType: "internal",
          linkText: "Missing",
          lineNumber: 42,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Source Page" }),
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("BROKEN LINKS (1 links)");
    expect(output).toContain("Source Page:42 -> ./missing.md");
  });

  test("formats external links grouped by domain", () => {
    const result = createEmptyAuditResult();
    result.summary.externalLinks = 3;
    result.externalLinks = [
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://github.com/repo1",
          linkType: "external",
          linkText: "Repo 1",
          lineNumber: 1,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage(),
        domain: "github.com",
      },
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://github.com/repo2",
          linkType: "external",
          linkText: "Repo 2",
          lineNumber: 2,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage(),
        domain: "github.com",
      },
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://example.com",
          linkType: "external",
          linkText: "Example",
          lineNumber: 3,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage(),
        domain: "example.com",
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("EXTERNAL LINKS (3 links)");
    expect(output).toContain("github.com: 2 links");
    expect(output).toContain("example.com: 1 links");
  });

  test("formats broken external links separately", () => {
    const result = createEmptyAuditResult();
    result.summary.externalLinks = 1;
    result.summary.brokenExternalLinks = 1;
    result.externalLinks = [
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://dead-link.com/page",
          linkType: "external",
          linkText: "Dead Link",
          lineNumber: 1,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Source" }),
        domain: "dead-link.com",
        httpStatus: 404,
        isBroken: true,
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("BROKEN EXTERNAL LINKS (1 links)");
    expect(output).toContain("Source -> https://dead-link.com/page (HTTP 404)");
  });

  test("formats contributor risks", () => {
    const result = createEmptyAuditResult();
    result.summary.contributorRisks = 1;
    result.contributorRisks = [
      {
        page: createTestPage({ title: "Risky Page" }),
        riskType: "bus-factor",
        details: "Only 1 contributor",
        contributors: [{ userId: "user-1", displayName: "John", isActive: true }],
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("CONTRIBUTOR RISKS (1 pages)");
    expect(output).toContain("Risky Page [Bus Factor] - Only 1 contributor");
  });

  test("formats unsynced pages", () => {
    const result = createEmptyAuditResult();
    result.summary.unsynced = 2;
    result.unsyncedPages = [
      {
        pageId: "remote-1",
        title: "Remote Page 1",
        lastModified: new Date().toISOString(),
        version: 5,
        spaceKey: "TEST",
      },
      {
        pageId: "remote-2",
        title: "Remote Page 2",
        lastModified: null,
        version: 3,
        spaceKey: "TEST",
      },
    ];

    const output = formatTable(result);

    expect(output).toContain("UNSYNCED PAGES (2 pages)");
    expect(output).toContain("Remote Page 1 (v5)");
    expect(output).toContain("Remote Page 2 (v3)");
  });

  test("truncates lists to 10 items with '... and N more'", () => {
    const result = createEmptyAuditResult();
    result.summary.orphans = 15;
    result.orphanedPages = Array.from({ length: 15 }, (_, i) => ({
      page: createTestPage({ title: `Orphan ${i + 1}`, path: `orphan${i + 1}.md` }),
    }));

    const output = formatTable(result);

    expect(output).toContain("Orphan 10");
    expect(output).not.toContain("Orphan 11");
    expect(output).toContain("... and 5 more");
  });

  test("includes user cache age when present", () => {
    const result = createEmptyAuditResult();
    result.userCacheAge = "2 hours ago";

    const output = formatTable(result);

    expect(output).toContain("User status as of 2 hours ago");
  });

  test("includes format hint in footer", () => {
    const result = createEmptyAuditResult();
    result.summary.orphans = 1;
    result.orphanedPages = [{ page: createTestPage() }];

    const output = formatTable(result);

    expect(output).toContain("Use --json for full details, --markdown for report format.");
  });
});

// ============================================================================
// formatMarkdown tests
// ============================================================================

describe("formatMarkdown", () => {
  test("generates markdown header with space name", () => {
    const result = createEmptyAuditResult("DOCS");
    const output = formatMarkdown(result);

    expect(output).toContain("# Audit Report: DOCS Space");
    expect(output).toContain("Generated:");
  });

  test("generates summary table", () => {
    const result = createEmptyAuditResult();
    result.summary.stale = { high: 2, medium: 1, low: 0 };
    result.summary.orphans = 3;

    const output = formatMarkdown(result);

    expect(output).toContain("## Summary");
    expect(output).toContain("| Check | Count |");
    expect(output).toContain("| Stale pages | 3 (High: 2, Med: 1, Low: 0) |");
    expect(output).toContain("| Orphaned pages | 3 |");
  });

  test("generates stale pages table with all columns", () => {
    const result = createEmptyAuditResult();
    result.summary.stale = { high: 1, medium: 0, low: 0 };
    result.stalePages = [
      {
        page: createTestPage({ title: "Old Page" }),
        monthsStale: 24,
        severity: "high",
        author: createTestUser({ displayName: "Alice", isActive: false }),
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Stale Pages");
    expect(output).toContain("| Page | Months Stale | Severity | Author |");
    expect(output).toContain("| Old Page | 24 | high | Alice (inactive) |");
  });

  test("generates orphaned pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.orphans = 1;
    result.orphanedPages = [
      { page: createTestPage({ title: "Lonely Page", path: "lonely.md" }) },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Orphaned Pages");
    expect(output).toContain("| Page | Path |");
    expect(output).toContain("| Lonely Page | `lonely.md` |");
  });

  test("generates broken links table", () => {
    const result = createEmptyAuditResult();
    result.summary.brokenLinks = 1;
    result.brokenLinks = [
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "./missing.md",
          linkType: "internal",
          linkText: "Missing",
          lineNumber: 42,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Source" }),
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Broken Links");
    expect(output).toContain("| Source | Target | Line |");
    expect(output).toContain("| Source | ./missing.md | 42 |");
  });

  test("generates external links grouped by domain with subsections", () => {
    const result = createEmptyAuditResult();
    result.summary.externalLinks = 2;
    result.externalLinks = [
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://github.com/repo",
          linkType: "external",
          linkText: "Repo",
          lineNumber: 1,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Page 1" }),
        domain: "github.com",
        httpStatus: 200,
      },
      {
        link: {
          sourcePageId: "p2",
          targetPageId: null,
          targetPath: "https://github.com/other",
          linkType: "external",
          linkText: "Other",
          lineNumber: 2,
          isBroken: false,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Page 2" }),
        domain: "github.com",
        httpStatus: 200,
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## External Links");
    expect(output).toContain("### github.com (2 links)");
    expect(output).toContain("- https://github.com/repo (from Page 1) ✓");
  });

  test("generates broken external links section separately", () => {
    const result = createEmptyAuditResult();
    result.summary.externalLinks = 1;
    result.summary.brokenExternalLinks = 1;
    result.externalLinks = [
      {
        link: {
          sourcePageId: "p1",
          targetPageId: null,
          targetPath: "https://dead.com/page",
          linkType: "external",
          linkText: "Dead",
          lineNumber: 1,
          isBroken: true,
          createdAt: new Date().toISOString(),
        },
        sourcePage: createTestPage({ title: "Source" }),
        domain: "dead.com",
        httpStatus: 404,
        isBroken: true,
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Broken External Links");
    expect(output).toContain("| URL | Source | Status |");
    expect(output).toContain("| https://dead.com/page | Source | HTTP 404 |");
  });

  test("generates contributor risks table", () => {
    const result = createEmptyAuditResult();
    result.summary.contributorRisks = 1;
    result.contributorRisks = [
      {
        page: createTestPage({ title: "Critical Page" }),
        riskType: "no-maintainer",
        details: "All contributors inactive",
        contributors: [],
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Contributor Risks");
    expect(output).toContain("| Page | Risk | Details |");
    expect(output).toContain("| Critical Page | No Maintainer | All contributors inactive |");
  });

  test("generates unsynced pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.unsynced = 1;
    result.unsyncedPages = [
      {
        pageId: "remote-1",
        title: "Remote Only",
        lastModified: "2024-01-15T10:00:00Z",
        version: 3,
        spaceKey: "TEST",
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Unsynced Pages (Remote Only)");
    expect(output).toContain("| Page | Version | Last Modified |");
    expect(output).toContain("| Remote Only | 3 |");
  });

  test("generates unsynced stale pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.unsyncedStale = { high: 1, medium: 0, low: 0 };
    result.unsyncedStalePages = [
      {
        pageId: "remote-old",
        title: "Ancient Remote Page",
        lastModified: "2022-01-15T10:00:00Z",
        version: 1,
        spaceKey: "TEST",
        monthsStale: 24,
        severity: "high",
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Unsynced Stale Pages");
    expect(output).toContain("| Page | Months Stale | Severity |");
    expect(output).toContain("| Ancient Remote Page | 24 | high |");
  });

  test("includes user cache footer when present", () => {
    const result = createEmptyAuditResult();
    result.userCacheAge = "3 hours ago";

    const output = formatMarkdown(result);

    expect(output).toContain("---");
    expect(output).toContain("*User status cached as of 3 hours ago*");
  });

  test("generates missing label pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.missingLabel = 1;
    result.missingLabelPages = [
      {
        page: createTestPage({ title: "Unlabeled Page" }),
        currentLabels: ["docs"],
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Pages Missing Required Label");
    expect(output).toContain("| Page | Current Labels |");
    expect(output).toContain("| Unlabeled Page | docs |");
  });

  test("shows (none) for pages with no labels", () => {
    const result = createEmptyAuditResult();
    result.summary.missingLabel = 1;
    result.missingLabelPages = [
      {
        page: createTestPage({ title: "No Labels Page" }),
        currentLabels: [],
      },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("| No Labels Page | (none) |");
  });

  test("generates restricted pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.restricted = 1;
    result.restrictedPages = [
      { page: createTestPage({ title: "Secret Page", path: "secret.md" }) },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Restricted Pages");
    expect(output).toContain("| Secret Page | `secret.md` |");
  });

  test("generates draft pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.drafts = 1;
    result.draftPages = [
      { page: createTestPage({ title: "Draft Page", path: "draft.md" }), status: "draft" },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Draft Pages");
    expect(output).toContain("| Draft Page | `draft.md` |");
  });

  test("generates archived pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.archived = 1;
    result.archivedPages = [
      { page: createTestPage({ title: "Old Page", path: "old.md" }), status: "archived" },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## Archived Pages");
    expect(output).toContain("| Old Page | `old.md` |");
  });

  test("generates high churn pages table", () => {
    const result = createEmptyAuditResult();
    result.summary.highChurn = 1;
    result.highChurnPages = [
      { page: createTestPage({ title: "Frequently Edited" }), versionCount: 50 },
    ];

    const output = formatMarkdown(result);

    expect(output).toContain("## High Churn Pages");
    expect(output).toContain("| Page | Version Count |");
    expect(output).toContain("| Frequently Edited | 50 |");
  });
});

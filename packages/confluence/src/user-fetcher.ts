/**
 * User status fetching and caching for Confluence users.
 *
 * Handles:
 * - Collecting user IDs from page metadata
 * - TTL-based caching of user status
 * - Batch checking users via Confluence API
 *
 * Used during `wiki docs pull` to populate the users table.
 */

import type { ConfluenceClient, UserInfo, ConfluencePageDetails, PageHistory } from "./client.js";
import type { SyncDbAdapter, UserRecord, PageRecord, ContributorRecord } from "./sync-db/types.js";

/**
 * Default TTL for user status cache (7 days in milliseconds).
 */
export const DEFAULT_USER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Options for user status checking.
 */
export interface UserCheckOptions {
  /** Skip all user status checks (fast mode) */
  skipUserCheck?: boolean;
  /** Force refresh all users regardless of TTL */
  refreshUsers?: boolean;
  /** Custom TTL in milliseconds (default: 7 days) */
  ttlMs?: number;
  /** Concurrency for API requests (default: 5) */
  concurrency?: number;
}

/**
 * Result of user status check operation.
 */
export interface UserCheckResult {
  /** Number of users checked via API */
  checked: number;
  /** Number of users skipped (cached) */
  cached: number;
  /** Number of users that failed to check */
  failed: number;
  /** User IDs that were checked */
  checkedIds: string[];
  /** User IDs that failed */
  failedIds: string[];
}

/**
 * Extract user IDs from page details.
 * Returns both creator and last modifier if available.
 */
export function extractUserIdsFromPage(page: ConfluencePageDetails): string[] {
  const userIds: string[] = [];

  if (page.createdBy?.accountId) {
    userIds.push(page.createdBy.accountId);
  }

  if (page.modifiedBy?.accountId) {
    userIds.push(page.modifiedBy.accountId);
  }

  return [...new Set(userIds)]; // Dedupe
}

/**
 * Extract user IDs from multiple pages.
 */
export function extractUserIdsFromPages(pages: ConfluencePageDetails[]): string[] {
  const allIds = pages.flatMap(extractUserIdsFromPage);
  return [...new Set(allIds)]; // Dedupe
}

/**
 * Check if a user's cached status is expired.
 */
export function isUserCacheExpired(
  user: UserRecord | null,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS
): boolean {
  if (!user || !user.lastCheckedAt) {
    return true; // Never checked
  }

  const lastChecked = new Date(user.lastCheckedAt).getTime();
  const now = Date.now();
  return now - lastChecked > ttlMs;
}

/**
 * Filter user IDs to only those needing a status check.
 *
 * @param userIds - All user IDs to potentially check
 * @param adapter - Database adapter
 * @param options - Check options
 * @returns User IDs that need to be checked via API
 */
export async function filterUsersNeedingCheck(
  userIds: string[],
  adapter: SyncDbAdapter,
  options: UserCheckOptions = {}
): Promise<string[]> {
  const { skipUserCheck = false, refreshUsers = false, ttlMs = DEFAULT_USER_CACHE_TTL_MS } = options;

  if (skipUserCheck) {
    return []; // Skip all checks
  }

  if (refreshUsers) {
    return userIds; // Check all users
  }

  // Filter to users not in cache OR with expired cache
  const needsCheck: string[] = [];

  for (const userId of userIds) {
    const cached = await adapter.getUser(userId);
    if (isUserCacheExpired(cached, ttlMs)) {
      needsCheck.push(userId);
    }
  }

  return needsCheck;
}

/**
 * Check and update user statuses via Confluence API.
 *
 * @param userIds - User IDs to check
 * @param client - Confluence client
 * @param adapter - Database adapter
 * @param options - Check options
 * @returns Result of the check operation
 */
export async function checkUserStatuses(
  userIds: string[],
  client: ConfluenceClient,
  adapter: SyncDbAdapter,
  options: UserCheckOptions = {}
): Promise<UserCheckResult> {
  const { concurrency = 5 } = options;

  const result: UserCheckResult = {
    checked: 0,
    cached: 0,
    failed: 0,
    checkedIds: [],
    failedIds: [],
  };

  if (userIds.length === 0) {
    return result;
  }

  // Fetch users from API
  const userInfoMap = await client.getUsersBulk(userIds, { concurrency });
  const now = new Date().toISOString();

  // Update database
  for (const userId of userIds) {
    const userInfo = userInfoMap.get(userId);

    if (userInfo === undefined) {
      // Request failed (shouldn't happen with current implementation)
      result.failed++;
      result.failedIds.push(userId);
      continue;
    }

    const userRecord: UserRecord = {
      userId,
      displayName: userInfo?.displayName ?? null,
      email: userInfo?.email ?? null,
      isActive: userInfo ? userInfo.isActive : null, // null if user not found
      lastCheckedAt: now,
    };

    await adapter.upsertUser(userRecord);
    result.checked++;
    result.checkedIds.push(userId);
  }

  return result;
}

/**
 * Full user check workflow for a pull operation.
 *
 * 1. Extract user IDs from pages
 * 2. Filter to users needing check
 * 3. Check via API and update database
 *
 * @param pages - Pages that were pulled
 * @param client - Confluence client
 * @param adapter - Database adapter
 * @param options - Check options
 * @returns Result of the check operation
 */
export async function checkUsersFromPull(
  pages: ConfluencePageDetails[],
  client: ConfluenceClient,
  adapter: SyncDbAdapter,
  options: UserCheckOptions = {}
): Promise<UserCheckResult> {
  // Extract all user IDs from pages
  const allUserIds = extractUserIdsFromPages(pages);

  // Filter to users needing check
  const userIdsToCheck = await filterUsersNeedingCheck(allUserIds, adapter, options);

  // Calculate cached count
  const cachedCount = allUserIds.length - userIdsToCheck.length;

  // Check and update
  const checkResult = await checkUserStatuses(userIdsToCheck, client, adapter, options);

  return {
    ...checkResult,
    cached: cachedCount,
  };
}

/**
 * Create contributor records from page details.
 * By default, only creates records for creator and last modifier.
 *
 * @param page - Page details
 * @param pageId - Page ID (may differ from page.id for synced pages)
 * @returns Array of contributor records
 */
export function createContributorRecords(
  page: ConfluencePageDetails,
  pageId: string
): ContributorRecord[] {
  const contributors: ContributorRecord[] = [];
  const now = new Date().toISOString();

  // Creator
  if (page.createdBy?.accountId) {
    contributors.push({
      pageId,
      userId: page.createdBy.accountId,
      contributionCount: 1,
      lastContributedAt: page.created ?? now,
    });
  }

  // Last modifier (if different from creator)
  if (page.modifiedBy?.accountId && page.modifiedBy.accountId !== page.createdBy?.accountId) {
    contributors.push({
      pageId,
      userId: page.modifiedBy.accountId,
      contributionCount: 1,
      lastContributedAt: page.modified ?? now,
    });
  }

  return contributors;
}

/**
 * Result of fetching full contributor history.
 */
export interface FetchContributorsResult {
  /** Page ID */
  pageId: string;
  /** All contributor records for this page */
  contributors: ContributorRecord[];
  /** Total version count */
  versionCount: number;
  /** User IDs of all contributors */
  userIds: string[];
}

/**
 * Fetch full contributor history for a page from version history.
 *
 * WARNING: This requires fetching all versions which can be slow for pages
 * with many edits. Use sparingly.
 *
 * @param pageId - Page ID
 * @param client - Confluence client
 * @returns Full contributor records from version history
 */
export async function fetchAllContributorsForPage(
  pageId: string,
  client: ConfluenceClient
): Promise<FetchContributorsResult> {
  const history = await client.getVersionHistory(pageId);

  // Aggregate contributions by user
  const contributionMap = new Map<string, {
    userId: string;
    count: number;
    lastContributedAt: string;
  }>();

  for (const version of history.versions) {
    const userId = version.by.accountId;
    if (!userId) continue;

    const existing = contributionMap.get(userId);
    if (existing) {
      existing.count++;
      // Keep the most recent contribution date
      if (version.when > existing.lastContributedAt) {
        existing.lastContributedAt = version.when;
      }
    } else {
      contributionMap.set(userId, {
        userId,
        count: 1,
        lastContributedAt: version.when,
      });
    }
  }

  const contributors: ContributorRecord[] = Array.from(contributionMap.values()).map(
    (c) => ({
      pageId,
      userId: c.userId,
      contributionCount: c.count,
      lastContributedAt: c.lastContributedAt,
    })
  );

  return {
    pageId,
    contributors,
    versionCount: history.latest,
    userIds: Array.from(contributionMap.keys()),
  };
}

/**
 * Fetch full contributor history for multiple pages.
 *
 * @param pageIds - Page IDs to fetch contributors for
 * @param client - Confluence client
 * @param options - Options for batch processing
 * @returns Map of pageId to contributor result
 */
export async function fetchAllContributorsForPages(
  pageIds: string[],
  client: ConfluenceClient,
  options: { concurrency?: number; onProgress?: (completed: number, total: number) => void } = {}
): Promise<Map<string, FetchContributorsResult>> {
  const { concurrency = 3, onProgress } = options;
  const results = new Map<string, FetchContributorsResult>();
  let completed = 0;

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < pageIds.length; i += concurrency) {
    const batch = pageIds.slice(i, i + concurrency);
    const promises = batch.map(async (pageId) => {
      try {
        const result = await fetchAllContributorsForPage(pageId, client);
        results.set(pageId, result);
      } catch (error) {
        // Skip pages that fail (e.g., permissions)
        console.warn(`Failed to fetch contributors for page ${pageId}:`, error);
      }
      completed++;
      onProgress?.(completed, pageIds.length);
    });
    await Promise.all(promises);
  }

  return results;
}

/**
 * Extract all unique user IDs from contributor results.
 */
export function extractUserIdsFromContributorResults(
  results: Map<string, FetchContributorsResult>
): string[] {
  const allIds = new Set<string>();
  for (const result of results.values()) {
    for (const userId of result.userIds) {
      allIds.add(userId);
    }
  }
  return Array.from(allIds);
}

/**
 * Convert UserInfo from API to UserRecord for database.
 */
export function userInfoToRecord(userInfo: UserInfo): UserRecord {
  return {
    userId: userInfo.accountId,
    displayName: userInfo.displayName,
    email: userInfo.email,
    isActive: userInfo.isActive,
    lastCheckedAt: new Date().toISOString(),
  };
}

/**
 * Get all users from the database with optional filtering.
 */
export interface UserFilter {
  /** Filter by active status */
  isActive?: boolean | null;
  /** Filter to users checked before this date */
  checkedBefore?: string;
  /** Filter to users not checked since this date */
  notCheckedSince?: string;
}

/**
 * Find users that are contributors to pages but have unknown status.
 */
export async function findUsersWithUnknownStatus(
  adapter: SyncDbAdapter
): Promise<UserRecord[]> {
  const users = await adapter.listUsers();
  return users.filter((u) => u.isActive === null);
}

/**
 * Find users that haven't been checked in a while.
 */
export async function findStaleUsers(
  adapter: SyncDbAdapter,
  ttlMs: number = DEFAULT_USER_CACHE_TTL_MS
): Promise<UserRecord[]> {
  const users = await adapter.listUsers();
  return users.filter((u) => isUserCacheExpired(u, ttlMs));
}

/**
 * Get user statistics from the database.
 */
export async function getUserStats(adapter: SyncDbAdapter): Promise<{
  total: number;
  active: number;
  inactive: number;
  unknown: number;
  stale: number;
}> {
  const users = await adapter.listUsers();

  return {
    total: users.length,
    active: users.filter((u) => u.isActive === true).length,
    inactive: users.filter((u) => u.isActive === false).length,
    unknown: users.filter((u) => u.isActive === null).length,
    stale: users.filter((u) => isUserCacheExpired(u)).length,
  };
}

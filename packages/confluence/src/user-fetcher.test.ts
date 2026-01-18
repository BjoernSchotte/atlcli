import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  extractUserIdsFromPage,
  extractUserIdsFromPages,
  isUserCacheExpired,
  filterUsersNeedingCheck,
  createContributorRecords,
  userInfoToRecord,
  getUserStats,
  extractUserIdsFromContributorResults,
  DEFAULT_USER_CACHE_TTL_MS,
  type FetchContributorsResult,
} from "./user-fetcher.js";
import type { ConfluencePageDetails, UserInfo } from "./client.js";
import type { SyncDbAdapter, UserRecord } from "./sync-db/types.js";

/**
 * Create a mock page with user data.
 */
function createMockPage(overrides: Partial<ConfluencePageDetails> = {}): ConfluencePageDetails {
  return {
    id: "123",
    title: "Test Page",
    storage: "<p>Content</p>",
    createdBy: {
      accountId: "user-creator",
      displayName: "Creator User",
    },
    modifiedBy: {
      accountId: "user-modifier",
      displayName: "Modifier User",
    },
    created: "2024-01-01T00:00:00.000Z",
    modified: "2024-01-15T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Create a mock UserRecord.
 */
function createMockUserRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: "user-123",
    displayName: "Test User",
    email: "test@example.com",
    isActive: true,
    lastCheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractUserIdsFromPage", () => {
  test("extracts creator and modifier", () => {
    const page = createMockPage();
    const ids = extractUserIdsFromPage(page);

    expect(ids).toContain("user-creator");
    expect(ids).toContain("user-modifier");
    expect(ids.length).toBe(2);
  });

  test("deduplicates when creator is same as modifier", () => {
    const page = createMockPage({
      createdBy: { accountId: "user-same", displayName: "Same User" },
      modifiedBy: { accountId: "user-same", displayName: "Same User" },
    });
    const ids = extractUserIdsFromPage(page);

    expect(ids).toEqual(["user-same"]);
  });

  test("handles missing creator", () => {
    const page = createMockPage({ createdBy: undefined });
    const ids = extractUserIdsFromPage(page);

    expect(ids).toEqual(["user-modifier"]);
  });

  test("handles missing modifier", () => {
    const page = createMockPage({ modifiedBy: undefined });
    const ids = extractUserIdsFromPage(page);

    expect(ids).toEqual(["user-creator"]);
  });

  test("handles missing accountId", () => {
    const page = createMockPage({
      createdBy: { displayName: "No ID" },
      modifiedBy: { displayName: "Also No ID" },
    });
    const ids = extractUserIdsFromPage(page);

    expect(ids).toEqual([]);
  });
});

describe("extractUserIdsFromPages", () => {
  test("extracts and deduplicates across pages", () => {
    const pages = [
      createMockPage({
        createdBy: { accountId: "user-1", displayName: "User 1" },
        modifiedBy: { accountId: "user-2", displayName: "User 2" },
      }),
      createMockPage({
        createdBy: { accountId: "user-2", displayName: "User 2" },
        modifiedBy: { accountId: "user-3", displayName: "User 3" },
      }),
    ];

    const ids = extractUserIdsFromPages(pages);

    expect(ids.sort()).toEqual(["user-1", "user-2", "user-3"]);
  });
});

describe("isUserCacheExpired", () => {
  test("returns true for null user", () => {
    expect(isUserCacheExpired(null)).toBe(true);
  });

  test("returns true for user without lastCheckedAt", () => {
    const user = createMockUserRecord({ lastCheckedAt: null });
    expect(isUserCacheExpired(user)).toBe(true);
  });

  test("returns true for expired cache", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const user = createMockUserRecord({ lastCheckedAt: eightDaysAgo });

    expect(isUserCacheExpired(user)).toBe(true);
  });

  test("returns false for fresh cache", () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const user = createMockUserRecord({ lastCheckedAt: oneDayAgo });

    expect(isUserCacheExpired(user)).toBe(false);
  });

  test("respects custom TTL", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const user = createMockUserRecord({ lastCheckedAt: twoHoursAgo });

    // With 1 hour TTL, 2 hours ago is expired
    expect(isUserCacheExpired(user, 1 * 60 * 60 * 1000)).toBe(true);

    // With 3 hour TTL, 2 hours ago is still fresh
    expect(isUserCacheExpired(user, 3 * 60 * 60 * 1000)).toBe(false);
  });
});

describe("filterUsersNeedingCheck", () => {
  test("returns empty when skipUserCheck is true", async () => {
    const mockAdapter = {
      getUser: mock(() => Promise.resolve(null)),
    } as unknown as SyncDbAdapter;

    const result = await filterUsersNeedingCheck(
      ["user-1", "user-2"],
      mockAdapter,
      { skipUserCheck: true }
    );

    expect(result).toEqual([]);
    expect(mockAdapter.getUser).not.toHaveBeenCalled();
  });

  test("returns all when refreshUsers is true", async () => {
    const mockAdapter = {
      getUser: mock(() => Promise.resolve(createMockUserRecord())),
    } as unknown as SyncDbAdapter;

    const result = await filterUsersNeedingCheck(
      ["user-1", "user-2"],
      mockAdapter,
      { refreshUsers: true }
    );

    expect(result).toEqual(["user-1", "user-2"]);
    expect(mockAdapter.getUser).not.toHaveBeenCalled();
  });

  test("filters to users not in cache", async () => {
    const mockAdapter = {
      getUser: mock((userId: string) => {
        if (userId === "user-1") {
          return Promise.resolve(createMockUserRecord({ userId: "user-1" }));
        }
        return Promise.resolve(null);
      }),
    } as unknown as SyncDbAdapter;

    const result = await filterUsersNeedingCheck(
      ["user-1", "user-2"],
      mockAdapter
    );

    expect(result).toEqual(["user-2"]);
  });

  test("filters to users with expired cache", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    const mockAdapter = {
      getUser: mock((userId: string) => {
        return Promise.resolve(
          createMockUserRecord({
            userId,
            lastCheckedAt: userId === "user-1" ? eightDaysAgo : new Date().toISOString(),
          })
        );
      }),
    } as unknown as SyncDbAdapter;

    const result = await filterUsersNeedingCheck(
      ["user-1", "user-2"],
      mockAdapter
    );

    expect(result).toEqual(["user-1"]);
  });
});

describe("createContributorRecords", () => {
  test("creates records for creator and modifier", () => {
    const page = createMockPage();
    const records = createContributorRecords(page, "page-123");

    expect(records.length).toBe(2);
    expect(records[0].pageId).toBe("page-123");
    expect(records[0].userId).toBe("user-creator");
    expect(records[1].userId).toBe("user-modifier");
  });

  test("creates single record when creator is modifier", () => {
    const page = createMockPage({
      createdBy: { accountId: "user-same", displayName: "Same User" },
      modifiedBy: { accountId: "user-same", displayName: "Same User" },
    });
    const records = createContributorRecords(page, "page-123");

    expect(records.length).toBe(1);
    expect(records[0].userId).toBe("user-same");
  });

  test("handles missing users", () => {
    const page = createMockPage({
      createdBy: undefined,
      modifiedBy: undefined,
    });
    const records = createContributorRecords(page, "page-123");

    expect(records.length).toBe(0);
  });

  test("uses page timestamps for contribution dates", () => {
    const page = createMockPage({
      created: "2024-01-01T00:00:00.000Z",
      modified: "2024-06-15T12:00:00.000Z",
    });
    const records = createContributorRecords(page, "page-123");

    expect(records[0].lastContributedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(records[1].lastContributedAt).toBe("2024-06-15T12:00:00.000Z");
  });
});

describe("userInfoToRecord", () => {
  test("converts UserInfo to UserRecord", () => {
    const userInfo: UserInfo = {
      accountId: "user-123",
      displayName: "Test User",
      email: "test@example.com",
      isActive: true,
      profilePicture: "/avatar.png",
    };

    const record = userInfoToRecord(userInfo);

    expect(record.userId).toBe("user-123");
    expect(record.displayName).toBe("Test User");
    expect(record.email).toBe("test@example.com");
    expect(record.isActive).toBe(true);
    expect(record.lastCheckedAt).toBeDefined();
  });

  test("handles null values", () => {
    const userInfo: UserInfo = {
      accountId: "user-123",
      displayName: null,
      email: null,
      isActive: false,
      profilePicture: null,
    };

    const record = userInfoToRecord(userInfo);

    expect(record.displayName).toBeNull();
    expect(record.email).toBeNull();
    expect(record.isActive).toBe(false);
  });
});

describe("getUserStats", () => {
  test("calculates user statistics", async () => {
    const now = new Date().toISOString();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    const mockUsers: UserRecord[] = [
      { userId: "1", displayName: "Active", email: null, isActive: true, lastCheckedAt: now },
      { userId: "2", displayName: "Active Stale", email: null, isActive: true, lastCheckedAt: eightDaysAgo },
      { userId: "3", displayName: "Inactive", email: null, isActive: false, lastCheckedAt: now },
      { userId: "4", displayName: "Unknown", email: null, isActive: null, lastCheckedAt: null },
    ];

    const mockAdapter = {
      listUsers: mock(() => Promise.resolve(mockUsers)),
    } as unknown as SyncDbAdapter;

    const stats = await getUserStats(mockAdapter);

    expect(stats.total).toBe(4);
    expect(stats.active).toBe(2);
    expect(stats.inactive).toBe(1);
    expect(stats.unknown).toBe(1);
    expect(stats.stale).toBe(2); // eightDaysAgo + null lastCheckedAt
  });
});

describe("extractUserIdsFromContributorResults", () => {
  test("extracts unique user IDs from multiple pages", () => {
    const results = new Map<string, FetchContributorsResult>([
      [
        "page-1",
        {
          pageId: "page-1",
          contributors: [
            { pageId: "page-1", userId: "user-1", contributionCount: 5, lastContributedAt: "2024-01-01" },
            { pageId: "page-1", userId: "user-2", contributionCount: 3, lastContributedAt: "2024-01-02" },
          ],
          versionCount: 8,
          userIds: ["user-1", "user-2"],
        },
      ],
      [
        "page-2",
        {
          pageId: "page-2",
          contributors: [
            { pageId: "page-2", userId: "user-2", contributionCount: 2, lastContributedAt: "2024-01-03" },
            { pageId: "page-2", userId: "user-3", contributionCount: 1, lastContributedAt: "2024-01-04" },
          ],
          versionCount: 3,
          userIds: ["user-2", "user-3"],
        },
      ],
    ]);

    const userIds = extractUserIdsFromContributorResults(results);

    expect(userIds.sort()).toEqual(["user-1", "user-2", "user-3"]);
  });

  test("handles empty results", () => {
    const results = new Map<string, FetchContributorsResult>();
    const userIds = extractUserIdsFromContributorResults(results);

    expect(userIds).toEqual([]);
  });
});

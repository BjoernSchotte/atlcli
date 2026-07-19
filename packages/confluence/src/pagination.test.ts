import { describe, test, expect } from "bun:test";
import { drainPaginated, PaginationLoopError, type PaginatedPage } from "./pagination.js";

/**
 * These tests use pure in-memory response fixtures (no HTTP mocks) to prove the
 * shared completeness contract that backs all four paginated client methods
 * (`searchPages`, `getChildrenWithPosition`, `getPageDirectChildren`,
 * `getFolderChildren`). Each `fetchPage` fixture models exactly the response
 * shape the corresponding method feeds into `drainPaginated`.
 */

/** Build a fetcher that returns an ordered list of fixture pages in sequence. */
function fixtureFetcher<T>(pages: Array<PaginatedPage<T>>): {
  fetch: (token: string | undefined) => Promise<PaginatedPage<T>>;
  calls: number;
} {
  let index = 0;
  const state = {
    calls: 0,
    fetch: async (_token: string | undefined): Promise<PaginatedPage<T>> => {
      state.calls += 1;
      const page = pages[index];
      index += 1;
      if (!page) throw new Error("fetcher asked for a page beyond the fixture list");
      return page;
    },
  };
  return state;
}

describe("drainPaginated", () => {
  test("v1 link: a partial page carrying a valid next link is NOT the last page (getChildrenWithPosition / searchPages)", async () => {
    // First page returns fewer items than the limit but still has a next link —
    // the old `results.length < limit` break silently dropped page 2.
    const fetcher = fixtureFetcher<number>([
      { items: [1, 2], next: "/rest/api/content/x/child/page?start=2" },
      { items: [3], next: undefined },
    ]);
    const all = await drainPaginated(fetcher.fetch);
    expect(all).toEqual([1, 2, 3]);
    expect(fetcher.calls).toBe(2);
  });

  test("v2 cursor: a short page with a live cursor continues (getPageDirectChildren / getFolderChildren)", async () => {
    const fetcher = fixtureFetcher<string>([
      { items: ["a"], next: "cursor-2" },
      { items: ["b", "c"], next: "cursor-3" },
      { items: ["d"], next: undefined },
    ]);
    const all = await drainPaginated(fetcher.fetch);
    expect(all).toEqual(["a", "b", "c", "d"]);
    expect(fetcher.calls).toBe(3);
  });

  test("stops only on absence of a next token, not on an empty page", async () => {
    // searchPages exclude-label case: an EMPTY but next-carrying page precedes
    // the page holding the actual match. The old `results.length === 0` break
    // dropped the match; drainPaginated keeps going.
    const fetcher = fixtureFetcher<{ id: string }>([
      { items: [], next: "cursor-2" },
      { items: [{ id: "match-page" }], next: undefined },
    ]);
    const all = await drainPaginated(fetcher.fetch);
    expect(all).toEqual([{ id: "match-page" }]);
    expect(fetcher.calls).toBe(2);
  });

  test("empty-string next token ends pagination", async () => {
    const fetcher = fixtureFetcher<number>([{ items: [1], next: "" }]);
    expect(await drainPaginated(fetcher.fetch)).toEqual([1]);
    expect(fetcher.calls).toBe(1);
  });

  test("a repeated next token throws PaginationLoopError instead of spinning", async () => {
    let calls = 0;
    await expect(
      drainPaginated<number>(async () => {
        calls += 1;
        return { items: [calls], next: "same-cursor" };
      })
    ).rejects.toBeInstanceOf(PaginationLoopError);
    // First page sets the token, second page repeats it → throw. No infinite loop.
    expect(calls).toBe(2);
  });

  test("PaginationLoopError carries the repeated token and a stable code", async () => {
    try {
      await drainPaginated<number>(async () => ({ items: [1], next: "loopy" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PaginationLoopError);
      expect((error as PaginationLoopError).code).toBe("pagination-loop");
      expect((error as PaginationLoopError).token).toBe("loopy");
    }
  });

  test("single final page (no next) fetches exactly once", async () => {
    const fetcher = fixtureFetcher<number>([{ items: [1, 2], next: undefined }]);
    expect(await drainPaginated(fetcher.fetch)).toEqual([1, 2]);
    expect(fetcher.calls).toBe(1);
  });
});

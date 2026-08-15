import { describe, expect, test } from "bun:test";
import { planDevReleaseRetention, type RetentionRelease } from "./dev-release-retention";

function release(index: number, daysAgo: number, overrides: Partial<RetentionRelease> = {}): RetentionRelease {
  return {
    id: index,
    tag_name: `dev-202601${String(index).padStart(2, "0")}.${index}.1-01234567`,
    draft: false,
    prerelease: true,
    immutable: true,
    created_at: new Date(Date.parse("2026-08-12T00:00:00Z") - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
}

describe("dev release retention", () => {
  test("retains the newest count or age window and deletes only beyond both", () => {
    const releases = Array.from({ length: 18 }, (_, index) => release(index + 1, index * 5));
    const plan = planDevReleaseRetention({
      releases,
      now: "2026-08-12T00:00:00Z",
      stableLatest: "v0.17.2",
      homebrewDevTag: releases[17]!.tag_name,
      retainSuccessful: 4,
      retainDays: 30,
    });
    expect(plan.dryRun).toBe(true);
    expect(plan.delete.length).toBeGreaterThan(0);
    expect(plan.delete.map(({ tag }) => tag)).not.toContain(releases[17]!.tag_name);
    expect(plan.keep.find(({ tag }) => tag === releases[17]!.tag_name)?.reason).toBe(
      "protected-live-reference",
    );
  });

  test("never deletes drafts, stable tags, or the Homebrew pointer", () => {
    const homebrew = release(1, 500);
    const draft = release(2, 500, { draft: true });
    const stable = release(3, 500, { tag_name: "v0.17.2", prerelease: false });
    const plan = planDevReleaseRetention({
      releases: [homebrew, draft, stable],
      now: "2026-08-12T00:00:00Z",
      stableLatest: "v0.17.2",
      homebrewDevTag: homebrew.tag_name,
      retainSuccessful: 1,
      retainDays: 1,
    });
    expect(plan.delete).toEqual([]);
    expect(plan.keep.map(({ reason }) => reason)).toContain("failed-draft-requires-operator-review");
  });

  test("fails closed without valid stable and Homebrew protection", () => {
    expect(() => planDevReleaseRetention({
      releases: [],
      now: "2026-08-12T00:00:00Z",
      stableLatest: "",
      homebrewDevTag: "dev-20260812.1.1-01234567",
    })).toThrow("stable latest");
    expect(() => planDevReleaseRetention({
      releases: [],
      now: "2026-08-12T00:00:00Z",
      stableLatest: "v0.17.2",
      homebrewDevTag: "",
    })).toThrow("Homebrew dev tag");
  });

  test("rejects a dev tag that is not classified as a prerelease", () => {
    expect(() => planDevReleaseRetention({
      releases: [release(1, 100, { prerelease: false })],
      now: "2026-08-12T00:00:00Z",
      stableLatest: "v0.17.2",
      homebrewDevTag: "dev-20260812.2.1-01234567",
      retainSuccessful: 1,
      retainDays: 1,
    })).toThrow("not a prerelease");
  });

  test("ignores unrelated names and retains mutable historical dev releases", () => {
    const mutable = release(1, 500, { immutable: false });
    const unrelated = release(2, 500, { tag_name: "dev-not-a-release" });
    const plan = planDevReleaseRetention({
      releases: [mutable, unrelated],
      now: "2026-08-12T00:00:00Z",
      stableLatest: "v0.17.2",
      homebrewDevTag: "dev-20260812.99.1-01234567",
      retainSuccessful: 1,
      retainDays: 1,
    });
    expect(plan.delete).toEqual([]);
    expect(plan.keep).toEqual([{
      id: mutable.id,
      tag: mutable.tag_name,
      reason: "mutable-release-requires-operator-review",
    }]);
  });
});

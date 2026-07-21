/**
 * The durable-job decisions, tested where they are decidable (spec 010 T5.6).
 *
 * Every property here is one a browser test would only be able to observe
 * indirectly: which record survives a store at 127 MiB, what happens to a job
 * whose worker never answered, whether a preview can push a finished export out
 * of the way. They are pure functions precisely so those answers are pinned.
 */
import { describe, expect, it } from "bun:test";
import {
  PDF_JOB_TIMED_OUT_ERROR,
  evictionRank,
  isPdfJobInFlight,
  isPdfJobTerminal,
  jobAgeMinutes,
  jobBadgeText,
  planSweep,
  planStoreEviction,
  siteOriginFromSourceIdentity,
  type BudgetEntry,
  type SweepCandidate,
} from "../../utils/jobs/model.js";

const NOW = 1_000_000;
const MAX_AGE = 24 * 60 * 60 * 1000;
const options = { now: NOW, maxAgeMs: MAX_AGE };

function entry(overrides: Partial<BudgetEntry> & { id: string }): BudgetEntry {
  return {
    tenant: "job",
    bytes: 1_000,
    createdAt: NOW,
    status: "complete",
    kind: "export",
    consumed: false,
    ...overrides,
  };
}

describe("in-flight classification", () => {
  it("treats prepared (the plan's 'queued') and compiling as in flight", () => {
    expect(isPdfJobInFlight("prepared")).toBe(true);
    expect(isPdfJobInFlight("compiling")).toBe(true);
    for (const status of ["complete", "failed", "cancelled"] as const) {
      expect(isPdfJobInFlight(status)).toBe(false);
      expect(isPdfJobTerminal(status)).toBe(true);
    }
  });
});

describe("the shared eviction policy", () => {
  it("never evicts a finished export nobody has collected", () => {
    expect(evictionRank(entry({ id: "a", status: "complete", consumed: false }), options)).toBeNull();
  });

  it("never evicts a running export", () => {
    expect(evictionRank(entry({ id: "a", status: "compiling" }), options)).toBeNull();
    expect(evictionRank(entry({ id: "a", status: "prepared" }), options)).toBeNull();
  });

  it("ranks expired first, then the preview cache, then spent, then preview jobs", () => {
    const expired = entry({ id: "old", createdAt: NOW - MAX_AGE - 1 });
    const cache = entry({ id: "cache", tenant: "preview-cache", status: "cached", kind: "preview" });
    const spent = entry({ id: "spent", status: "complete", consumed: true });
    const previewJob = entry({ id: "prev", status: "compiling", kind: "preview" });
    expect(evictionRank(expired, options)).toBe(0);
    expect(evictionRank(cache, options)).toBe(1);
    expect(evictionRank(spent, options)).toBe(2);
    expect(evictionRank(entry({ id: "x", status: "failed" }), options)).toBe(2);
    expect(evictionRank(entry({ id: "x", status: "cancelled" }), options)).toBe(2);
    expect(evictionRank(previewJob, options)).toBe(3);
  });

  it("does nothing when the request already fits", () => {
    const plan = planStoreEviction([entry({ id: "a", bytes: 10 })], 5, { ...options, limit: 100 });
    expect(plan).toEqual({ evict: [], freed: 0, fits: true, shortfall: 0 });
  });

  /**
   * The property the whole policy exists for: a preview and a finished export
   * both want the same budget, and only one of them is regenerable.
   */
  it("evicts the preview cache to admit an export, never the reverse", () => {
    const cache = entry({
      id: "cache",
      tenant: "preview-cache",
      status: "cached",
      kind: "preview",
      bytes: 40,
    });
    const finished = entry({ id: "done", status: "complete", consumed: false, bytes: 50 });
    const plan = planStoreEviction([cache, finished], 20, { ...options, limit: 100 });
    expect(plan.fits).toBe(true);
    expect(plan.evict.map((e) => e.id)).toEqual(["cache"]);
    expect(plan.freed).toBe(40);
  });

  it("refuses rather than evicting a finished-but-unconsumed export", () => {
    const finished = entry({ id: "done", status: "complete", consumed: false, bytes: 90 });
    const plan = planStoreEviction([finished], 20, { ...options, limit: 100 });
    expect(plan.fits).toBe(false);
    expect(plan.evict).toEqual([]);
    expect(plan.shortfall).toBe(10);
  });

  it("evicts oldest-first inside one rank, and stops as soon as it fits", () => {
    const spentOld = entry({ id: "old", status: "failed", bytes: 30, createdAt: NOW - 5_000 });
    const spentNew = entry({ id: "new", status: "failed", bytes: 30, createdAt: NOW - 1_000 });
    const plan = planStoreEviction([spentOld, spentNew, entry({ id: "keep", bytes: 20 })], 30, {
      ...options,
      limit: 100,
    });
    expect(plan.evict.map((e) => e.id)).toEqual(["old"]);
  });
});

describe("the sweep", () => {
  function candidate(overrides: Partial<SweepCandidate> & { id: string }): SweepCandidate {
    return { status: "compiling", kind: "export", createdAt: NOW, consumed: false, ...overrides };
  }

  it("fails a job whose worker never reported back", () => {
    const actions = planSweep([candidate({ id: "hung", deadlineAt: NOW - 1 })], options);
    expect(actions).toEqual([{ id: "hung", action: "fail", error: PDF_JOB_TIMED_OUT_ERROR }]);
  });

  it("leaves a job that is still inside its deadline alone", () => {
    expect(planSweep([candidate({ id: "running", deadlineAt: NOW + 60_000 })], options)).toEqual([]);
  });

  it("never invents a deadline for a record that has none", () => {
    expect(planSweep([candidate({ id: "legacy" })], options)).toEqual([]);
  });

  it("deletes expired, consumed, preview and long-terminal records", () => {
    const actions = planSweep(
      [
        candidate({ id: "expired", createdAt: NOW - MAX_AGE - 1 }),
        candidate({ id: "collected", status: "complete", consumed: true }),
        candidate({ id: "preview", status: "complete", kind: "preview" }),
        candidate({ id: "stale", status: "failed", createdAt: NOW - 2 * 60 * 60 * 1000 }),
        candidate({ id: "fresh-failure", status: "failed", createdAt: NOW - 1_000 }),
      ],
      options
    );
    expect(actions.map((a) => a.id)).toEqual(["expired", "collected", "preview", "stale"]);
    expect(actions.every((a) => a.action === "delete")).toBe(true);
  });

  it("keeps a finished export the user has not collected", () => {
    expect(planSweep([candidate({ id: "waiting", status: "complete" })], options)).toEqual([]);
  });
});

describe("badge text", () => {
  it("is empty for nothing waiting and caps at two characters", () => {
    expect(jobBadgeText(0)).toBe("");
    expect(jobBadgeText(-1)).toBe("");
    expect(jobBadgeText(1)).toBe("1");
    expect(jobBadgeText(9)).toBe("9");
    expect(jobBadgeText(10)).toBe("9+");
  });
});

describe("attribution and age", () => {
  it("reads the site origin out of a sourceIdentity", () => {
    expect(
      siteOriginFromSourceIdentity("https://example.atlassian.net/wiki/spaces/D/pages/1|1|3")
    ).toBe("https://example.atlassian.net");
  });

  it("returns null for an identity that carries no URL", () => {
    expect(siteOriginFromSourceIdentity("page:1|1|3")).toBeNull();
  });

  it("floors age at zero for a clock that ran backwards", () => {
    expect(jobAgeMinutes(NOW + 10_000, NOW)).toBe(0);
    expect(jobAgeMinutes(NOW - 130_000, NOW)).toBe(2);
  });
});

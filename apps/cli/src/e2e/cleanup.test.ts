/**
 * Safety tests for the E2E recovery sweeper (spec 011 "E2E resource
 * discipline").
 *
 * The sweeper deletes real content in a real space, so each of its four safety
 * properties gets its own explicit proof here:
 *
 *   (a) it requires the `atlcli-e2e-run-id` ownership marker,
 *   (b) it honors the 24 h TTL,
 *   (c) it is a dry run unless `--force` is given,
 *   (d) it never touches anything outside space `DOCSY` / project `ATLCLI`,
 *
 * plus the max-delete circuit breaker. Everything runs against in-memory port
 * implementations — real implementations of the designed ports, not mocks.
 */

import { describe, expect, it } from "bun:test";
import { MemoryConfluence, MemoryJira } from "./memory-ports.js";
import {
  DEFAULT_MAX_DELETES,
  DEFAULT_PROFILE,
  assertMarked,
  classifyCandidate,
  executeSweep,
  parseSweeperArgs,
  planSweep,
  resolveSweeperProfile,
  runSweep,
  sweeperHelp,
  toIssueCandidate,
  toPageCandidate,
  type SweepCandidate,
} from "./cleanup.js";
import { E2E_PROJECT_KEY, E2E_SPACE_KEY, E2E_TTL_MS } from "./resources.js";

const NOW = 1_789_000_000_000; // ms
const HOUR = 60 * 60 * 1000;

/** A name whose encoded timestamp is `ageMs` old relative to NOW. */
function agedTitle(feature: string, ageMs: number): string {
  return `atlcli-e2e-${feature}-${Math.floor((NOW - ageMs) / 1000)}`;
}

/** A candidate that passes every gate, so individual tests can break exactly one. */
function sweepableCandidate(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    id: "page-1",
    name: agedTitle("scope-tree", 48 * HOUR),
    scope: E2E_SPACE_KEY,
    runId: "gha-12345",
    ...overrides,
  };
}

const pagePlanOptions = { scope: E2E_SPACE_KEY, now: NOW, ttlMs: E2E_TTL_MS };

describe("sweeper safety (a): the ownership marker is required", () => {
  it("never selects a page that carries no marker, however perfect its name", () => {
    const candidate = sweepableCandidate({ runId: undefined });
    expect(classifyCandidate(candidate, pagePlanOptions)).toBe("no-marker");

    const plan = planSweep("page", [candidate], pagePlanOptions);
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([{ candidate, reason: "no-marker" }]);
  });

  it("treats an empty or whitespace marker as no marker at all", () => {
    for (const runId of ["", "   "]) {
      expect(classifyCandidate(sweepableCandidate({ runId }), pagePlanOptions)).toBe("no-marker");
    }
  });

  it("refuses at the delete site too, if a target is hand-built past the type system", () => {
    // The types make this unreachable from `planSweep`; the runtime assertion
    // covers a caller casting their own SweepTarget together.
    const forged = { id: "p1", name: agedTitle("x", 48 * HOUR), scope: E2E_SPACE_KEY, runId: "" };
    expect(() => assertMarked(forged)).toThrow(/no atlcli-e2e-run-id ownership marker/);
  });

  it("deletes nothing from a space made entirely of unmarked pages", async () => {
    const confluence = new MemoryConfluence();
    for (let i = 0; i < 10; i++) {
      confluence.seed({ title: agedTitle(`unmarked-${i}`, 72 * HOUR), spaceKey: E2E_SPACE_KEY });
    }

    const code = await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(confluence.deleteLog).toEqual([]);
    expect(confluence.pages.size).toBe(10);
  });
});

describe("sweeper safety (b): the TTL is honored", () => {
  it("protects a resource younger than the TTL", () => {
    const fresh = sweepableCandidate({ name: agedTitle("scope-tree", 1 * HOUR) });
    expect(classifyCandidate(fresh, pagePlanOptions)).toBe("within-ttl");
  });

  it("protects a resource created seconds ago by a still-running E2E", () => {
    const running = sweepableCandidate({ name: agedTitle("scope-tree", 5_000) });
    expect(classifyCandidate(running, pagePlanOptions)).toBe("within-ttl");
  });

  it("selects a resource older than the TTL", () => {
    const stale = sweepableCandidate({ name: agedTitle("scope-tree", 25 * HOUR) });
    expect(classifyCandidate(stale, pagePlanOptions)).toBeNull();
  });

  it("treats the TTL boundary as exclusive — exactly 24 h old is still protected", () => {
    const boundary = sweepableCandidate({ name: agedTitle("scope-tree", E2E_TTL_MS) });
    expect(classifyCandidate(boundary, pagePlanOptions)).toBe("within-ttl");
  });

  it("does not delete a fresh marked page in a live sweep", async () => {
    const confluence = new MemoryConfluence();
    confluence.seed({ title: agedTitle("fresh", 2 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-1" });
    confluence.seed({ title: agedTitle("stale", 48 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-0" });

    await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect([...confluence.pages.values()].map((p) => p.title)).toEqual([agedTitle("fresh", 2 * HOUR)]);
  });
});

describe("sweeper safety (c): dry run by default, --force to delete", () => {
  it("defaults to a dry run", () => {
    expect(parseSweeperArgs([]).force).toBe(false);
    expect(parseSweeperArgs(["--dry-run"]).force).toBe(false);
    expect(parseSweeperArgs(["--force"]).force).toBe(true);
  });

  it("performs zero deletions without --force, but reports what it would delete", async () => {
    const confluence = new MemoryConfluence();
    const doomed = confluence.seed({
      title: agedTitle("stale", 48 * HOUR),
      spaceKey: E2E_SPACE_KEY,
      runId: "gha-1",
    });
    const lines: string[] = [];

    const code = await runSweep({
      confluence,
      args: { force: false, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: (message) => lines.push(message),
    });

    expect(code).toBe(0);
    expect(confluence.deleteLog).toEqual([]);
    expect(confluence.pages.size).toBe(1);
    expect(lines.join("\n")).toContain("DRY RUN");
    expect(lines.join("\n")).toContain(doomed.id);
  });

  it("actually deletes with --force", async () => {
    const confluence = new MemoryConfluence();
    const jira = new MemoryJira();
    const page = confluence.seed({ title: agedTitle("stale", 48 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-1" });
    const issue = jira.seed({ summary: agedTitle("stale", 48 * HOUR), projectKey: E2E_PROJECT_KEY, runId: "gha-1" });

    const code = await runSweep({
      confluence,
      jira,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(confluence.deleteLog).toEqual([page.id]);
    expect(jira.deleteLog).toEqual([issue.key]);
  });

  it("exits non-zero when a deletion fails, so a broken sweep is visible", async () => {
    const confluence = new MemoryConfluence();
    const page = confluence.seed({ title: agedTitle("stale", 48 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-1" });
    confluence.failDeletesFor.add(page.id);

    const code = await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect(code).toBe(1);
  });
});

describe("sweeper safety (d): scope is locked to DOCSY / ATLCLI", () => {
  it("never selects a marked, stale, correctly named page from another space", () => {
    const foreign = sweepableCandidate({ scope: "ENGINEERING" });
    expect(classifyCandidate(foreign, pagePlanOptions)).toBe("wrong-scope");
    expect(planSweep("page", [foreign], pagePlanOptions).targets).toEqual([]);
  });

  it("never selects an issue from another project", () => {
    const foreign = { id: "OTHER-9", name: agedTitle("stale", 48 * HOUR), scope: "OTHER", runId: "gha-1" };
    expect(classifyCandidate(foreign, { scope: E2E_PROJECT_KEY, now: NOW, ttlMs: E2E_TTL_MS })).toBe("wrong-scope");
  });

  it("fails closed when the API omits the space key", () => {
    expect(classifyCandidate(sweepableCandidate({ scope: "" }), pagePlanOptions)).toBe("wrong-scope");
  });

  it("offers no CLI flag that could widen the scope", () => {
    expect(() => parseSweeperArgs(["--space", "ENGINEERING"])).toThrow(/Unknown argument/);
    expect(() => parseSweeperArgs(["--project", "OTHER"])).toThrow(/Unknown argument/);
    expect(sweeperHelp()).toContain(E2E_SPACE_KEY);
    expect(sweeperHelp()).toContain(E2E_PROJECT_KEY);
  });

  it("only ever lists from the locked scopes", async () => {
    const confluence = new MemoryConfluence();
    confluence.seed({ title: agedTitle("stale", 48 * HOUR), spaceKey: "ENGINEERING", runId: "gha-1" });
    const inScope = confluence.seed({
      title: agedTitle("stale", 48 * HOUR),
      spaceKey: E2E_SPACE_KEY,
      runId: "gha-1",
    });

    await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect(confluence.deleteLog).toEqual([inScope.id]);
  });
});

describe("max-delete circuit breaker", () => {
  it("trips when the plan exceeds the limit", () => {
    const candidates = Array.from({ length: 51 }, (_, i) =>
      sweepableCandidate({ id: `p${i}`, name: agedTitle(`stale-${i}`, 48 * HOUR) })
    );
    const plan = planSweep("page", candidates, { ...pagePlanOptions, maxDeletes: 50 });
    expect(plan.circuitBreakerTripped).toBe(true);
  });

  it("does not trip exactly at the limit", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      sweepableCandidate({ id: `p${i}`, name: agedTitle(`stale-${i}`, 48 * HOUR) })
    );
    expect(planSweep("page", candidates, { ...pagePlanOptions, maxDeletes: 50 }).circuitBreakerTripped).toBe(false);
  });

  it("deletes NOTHING at all when tripped — not even up to the limit", async () => {
    const confluence = new MemoryConfluence();
    for (let i = 0; i < 51; i++) {
      confluence.seed({ title: agedTitle(`stale-${i}`, 48 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-1" });
    }

    const code = await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: 50 },
      now: NOW,
      log: () => {},
    });

    expect(code).toBe(2);
    expect(confluence.deleteLog).toEqual([]);
    expect(confluence.pages.size).toBe(51);
  });

  it("aborts the whole sweep, so a tripped page plan also blocks issue deletion", async () => {
    const confluence = new MemoryConfluence();
    const jira = new MemoryJira();
    for (let i = 0; i < 51; i++) {
      confluence.seed({ title: agedTitle(`stale-${i}`, 48 * HOUR), spaceKey: E2E_SPACE_KEY, runId: "gha-1" });
    }
    jira.seed({ summary: agedTitle("stale", 48 * HOUR), projectKey: E2E_PROJECT_KEY, runId: "gha-1" });

    const code = await runSweep({
      confluence,
      jira,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: 50 },
      now: NOW,
      log: () => {},
    });

    expect(code).toBe(2);
    expect(jira.deleteLog).toEqual([]);
  });

  it("reports the tripped plan as a dry run so an operator can see the query blew up", async () => {
    const plan = planSweep(
      "page",
      Array.from({ length: 3 }, (_, i) => sweepableCandidate({ id: `p${i}` })),
      { ...pagePlanOptions, maxDeletes: 2 }
    );
    const lines: string[] = [];
    const result = await executeSweep({
      plan,
      force: true,
      deleteResource: async () => {
        throw new Error("must never be called");
      },
      log: (message) => lines.push(message),
    });

    expect(result.aborted).toBe(true);
    expect(result.deleted).toEqual([]);
    expect(result.wouldDelete).toHaveLength(3);
    expect(lines.join("\n")).toContain("ABORT");
  });
});

describe("deliberately retained DOCSY fixtures stay safe", () => {
  // These exist in the real DOCSY space and must survive every sweep. None of
  // them carries the marker, so gate (a) alone is enough — but the naming gate
  // rejects them first, which is why the sweeper never even reads a property
  // for them.
  const retained = [
    { id: "1117356071", title: "DOCX Feature Zoo E2E" },
    { id: "1118437396", title: "Spec-005 Logo & Image E2E (temp)" },
    { id: "1125482517", title: "M1 Abnahme" },
    ...Array.from({ length: 57 }, (_, i) => ({ id: `m1-${i}`, title: `M1 Abnahme ${i + 1}` })),
  ];

  it("classifies every retained fixture as protected", () => {
    for (const fixture of retained) {
      const candidate: SweepCandidate = { id: fixture.id, name: fixture.title, scope: E2E_SPACE_KEY };
      expect(classifyCandidate(candidate, pagePlanOptions)).toBe("name-mismatch");
    }
  });

  it("protects them even if something stamped a marker on them by accident", () => {
    for (const fixture of retained) {
      const candidate: SweepCandidate = {
        id: fixture.id,
        name: fixture.title,
        scope: E2E_SPACE_KEY,
        runId: "gha-99999",
      };
      expect(classifyCandidate(candidate, pagePlanOptions)).toBe("name-mismatch");
    }
  });

  it("survives a forced sweep of a space that also contains real residue", async () => {
    const confluence = new MemoryConfluence();
    for (const fixture of retained) {
      confluence.seed({ id: fixture.id, title: fixture.title, spaceKey: E2E_SPACE_KEY });
    }
    const residue = confluence.seed({
      title: agedTitle("crashed-run", 48 * HOUR),
      spaceKey: E2E_SPACE_KEY,
      runId: "gha-crashed",
    });

    await runSweep({
      confluence,
      args: { force: true, ttlMs: E2E_TTL_MS, maxDeletes: DEFAULT_MAX_DELETES },
      now: NOW,
      log: () => {},
    });

    expect(confluence.deleteLog).toEqual([residue.id]);
    for (const fixture of retained) {
      expect(confluence.pages.has(fixture.id)).toBe(true);
    }
  });
});

describe("planning helpers", () => {
  it("projects page and issue records onto the same candidate shape", () => {
    expect(toPageCandidate({ id: "1", title: "t", spaceKey: "DOCSY", runId: "r" })).toEqual({
      id: "1",
      name: "t",
      scope: "DOCSY",
      runId: "r",
    });
    expect(toIssueCandidate({ key: "ATLCLI-1", summary: "s", projectKey: "ATLCLI" })).toEqual({
      id: "ATLCLI-1",
      name: "s",
      scope: "ATLCLI",
      runId: undefined,
    });
  });

  it("records a skip reason for every rejected candidate", () => {
    const plan = planSweep(
      "page",
      [
        sweepableCandidate({ id: "ok" }),
        sweepableCandidate({ id: "young", name: agedTitle("x", HOUR) }),
        sweepableCandidate({ id: "unmarked", runId: undefined }),
        sweepableCandidate({ id: "foreign", scope: "OTHER" }),
        sweepableCandidate({ id: "human", name: "Release notes 2026" }),
      ],
      pagePlanOptions
    );

    expect(plan.targets.map((t) => t.id)).toEqual(["ok"]);
    expect(plan.skipped.map((s) => [s.candidate.id, s.reason])).toEqual([
      ["young", "within-ttl"],
      ["unmarked", "no-marker"],
      ["foreign", "wrong-scope"],
      ["human", "name-mismatch"],
    ]);
  });
});

describe("sweeper argument parsing", () => {
  it("defaults to the mayflower profile, a 24 h TTL and a 50-resource breaker", () => {
    const args = parseSweeperArgs([]);
    expect(args).toEqual({
      force: false,
      profile: DEFAULT_PROFILE,
      ttlMs: E2E_TTL_MS,
      maxDeletes: DEFAULT_MAX_DELETES,
    });
  });

  it("accepts both --flag value and --flag=value", () => {
    expect(parseSweeperArgs(["--profile", "other"]).profile).toBe("other");
    expect(parseSweeperArgs(["--profile=other"]).profile).toBe("other");
    expect(parseSweeperArgs(["--ttl-hours", "48"]).ttlMs).toBe(48 * HOUR);
    expect(parseSweeperArgs(["--ttl-hours=48"]).ttlMs).toBe(48 * HOUR);
    expect(parseSweeperArgs(["--max-deletes=10"]).maxDeletes).toBe(10);
  });

  it("fails closed on typos and malformed values rather than guessing", () => {
    expect(() => parseSweeperArgs(["--forse"])).toThrow(/Unknown argument/);
    expect(() => parseSweeperArgs(["-f"])).toThrow(/Unknown argument/);
    expect(() => parseSweeperArgs(["--ttl-hours", "soon"])).toThrow(/non-negative number/);
    expect(() => parseSweeperArgs(["--max-deletes", "-1"])).toThrow(/non-negative integer/);
    expect(() => parseSweeperArgs(["--profile"])).toThrow(/requires a value/);
  });
});

describe("resolveSweeperProfile", () => {
  const configured = {
    profiles: {
      mayflower: {
        name: "mayflower",
        baseUrl: "https://example.atlassian.net",
        auth: { type: "apiToken" as const, email: "a@b.c" },
      },
    },
  };

  it("prefers a configured profile", () => {
    expect(resolveSweeperProfile(configured, "mayflower", {})?.baseUrl).toBe("https://example.atlassian.net");
  });

  it("falls back to env vars so CI never writes credentials to disk", () => {
    const profile = resolveSweeperProfile({ profiles: {} }, "mayflower", {
      ATLCLI_BASE_URL: "https://ci.atlassian.net",
      ATLCLI_EMAIL: "ci@example.com",
    });
    expect(profile).toEqual({
      name: "mayflower",
      baseUrl: "https://ci.atlassian.net",
      auth: { type: "apiToken", email: "ci@example.com" },
    });
  });

  it("never stores the token in the profile — it is resolved from the environment", () => {
    const profile = resolveSweeperProfile({ profiles: {} }, "mayflower", {
      ATLCLI_BASE_URL: "https://ci.atlassian.net",
      ATLCLI_API_TOKEN: "super-secret",
    });
    expect(JSON.stringify(profile)).not.toContain("super-secret");
  });

  it("returns null when neither a profile nor a base URL is available", () => {
    expect(resolveSweeperProfile({ profiles: {} }, "mayflower", {})).toBeNull();
  });
});

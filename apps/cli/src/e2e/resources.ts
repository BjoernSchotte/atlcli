/**
 * Shared naming + ownership conventions for **live** E2E test resources
 * (spec 011 "E2E resource discipline").
 *
 * Three rules, in force for every live E2E script and agent run:
 *
 *  1. **Naming** — every resource is named `atlcli-e2e-<feature>-<timestamp>`
 *     (epoch *seconds*). Confluence pages live exclusively in space `DOCSY`,
 *     Jira issues exclusively in project `ATLCLI` (summary prefix).
 *
 *  2. **Machine-readable ownership marker** — a visible title prefix proves
 *     nothing: a user page can happen to share the name, and two E2E runs can
 *     race inside the same second. So at creation every page also gets a
 *     content property `atlcli-e2e-run-id` (and every issue the equivalent
 *     issue property) holding the CI run ID or a local UUID. **That property,
 *     not the title, is the ownership proof any deletion path checks.**
 *
 *  3. **Per-test cleanup first** — each test records what it created and
 *     deletes it in a `finally` block ({@link withE2eResources}), so the tenant
 *     is clean after *every single run*. The nightly sweeper
 *     (`apps/cli/src/e2e/cleanup.ts`) is recovery for what a crashed or killed
 *     run missed — never the primary mechanism.
 *
 * @see src/content/docs/contributing.md — "E2E resources"
 * @module
 */

import { randomUUID } from "node:crypto";

/** Content/issue property key holding the owning run's ID. The ownership proof. */
export const E2E_RUN_ID_PROPERTY = "atlcli-e2e-run-id";

/** Fixed prefix of every live E2E resource name. */
export const E2E_NAME_PREFIX = "atlcli-e2e";

/** The ONLY Confluence space live E2E resources may be created in or swept from. */
export const E2E_SPACE_KEY = "DOCSY";

/** The ONLY Jira project live E2E resources may be created in or swept from. */
export const E2E_PROJECT_KEY = "ATLCLI";

/** Resources younger than this are never swept — a running E2E is never deleted. */
export const E2E_TTL_MS = 24 * 60 * 60 * 1000;

/** Feature slugs are lowercase alphanumerics joined by single dashes. */
const FEATURE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Epoch seconds crossed 1e9 in 2001; anything shorter is not a timestamp. */
const MIN_TIMESTAMP_SECONDS = 1_000_000_000;

/**
 * Build the canonical name for a live E2E resource.
 *
 * @param feature - Lowercase slug naming the feature under test (e.g. `scope-tree`).
 * @param now - Clock injection point; defaults to the current time.
 * @returns e.g. `atlcli-e2e-scope-tree-1789000000`
 * @throws If `feature` is not a lowercase dash-joined slug — an out-of-convention
 *   name would produce a resource the sweeper can never recover.
 */
export function makeE2eTitle(feature: string, now: Date = new Date()): string {
  if (!FEATURE_SLUG.test(feature)) {
    throw new Error(
      `E2E feature slug must match ${FEATURE_SLUG} (lowercase, dash-separated), got: ${JSON.stringify(feature)}`
    );
  }
  const seconds = Math.floor(now.getTime() / 1000);
  // The clock must produce a timestamp `parseE2eTitle` will accept. An injected
  // epoch-0 or otherwise bogus `now` would otherwise mint a name that parses as
  // null forever — a resource no sweeper can ever recover, which is the exact
  // failure this validation exists to prevent.
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TIMESTAMP_SECONDS) {
    throw new Error(
      `E2E timestamp must be epoch seconds >= ${MIN_TIMESTAMP_SECONDS}, got ${seconds} (from epoch ms ${now.getTime()}). ` +
        "A name outside the convention can never be swept."
    );
  }
  return `${E2E_NAME_PREFIX}-${feature}-${seconds}`;
}

/** The parts recovered from a conventional E2E resource name. */
export interface ParsedE2eTitle {
  feature: string;
  /** Creation time as epoch **seconds**, exactly as encoded in the name. */
  timestampSeconds: number;
}

/**
 * Recover `{ feature, timestampSeconds }` from a resource name.
 *
 * @returns `null` for anything that does not follow the convention — including
 *   every human-authored page title. Callers treat `null` as "not ours".
 */
export function parseE2eTitle(title: string): ParsedE2eTitle | null {
  if (typeof title !== "string") return null;
  const segments = title.trim().split("-");
  // `atlcli` + `e2e` + at least one feature segment + timestamp.
  if (segments.length < 4) return null;
  if (segments[0] !== "atlcli" || segments[1] !== "e2e") return null;

  const last = segments[segments.length - 1];
  if (!/^\d+$/.test(last)) return null;
  const timestampSeconds = Number.parseInt(last, 10);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < MIN_TIMESTAMP_SECONDS) return null;

  const feature = segments.slice(2, -1).join("-");
  if (!FEATURE_SLUG.test(feature)) return null;

  return { feature, timestampSeconds };
}

/**
 * The run ID stamped into every resource this process creates.
 *
 * Prefers the CI run identity (so a nightly sweep can attribute residue to a
 * specific workflow run); falls back to a fresh UUID locally.
 */
export function resolveRunId(env: Record<string, string | undefined> = process.env): string {
  const runId = env.GITHUB_RUN_ID?.trim();
  const attempt = env.GITHUB_RUN_ATTEMPT?.trim();
  if (runId) return attempt ? `gha-${runId}-${attempt}` : `gha-${runId}`;
  return `local-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
//
// The tracker and the sweeper talk to Confluence/Jira only through these two
// narrow interfaces. Production wiring supplies REST-backed implementations
// (`apps/cli/src/e2e/rest-ports.ts`); tests supply in-memory implementations.
// Nothing here is ever mocked at the `fetch` level.

/** A Confluence page as the sweeper needs to see it. */
export interface E2ePageRecord {
  id: string;
  title: string;
  spaceKey: string;
  /** Value of the {@link E2E_RUN_ID_PROPERTY} content property, if present. */
  runId?: string;
}

/** A Jira issue as the sweeper needs to see it. */
export interface E2eIssueRecord {
  key: string;
  summary: string;
  projectKey: string;
  /** Value of the {@link E2E_RUN_ID_PROPERTY} issue property, if present. */
  runId?: string;
}

export interface E2eConfluencePort {
  createPage(input: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<{ id: string; title: string }>;
  deletePage(pageId: string): Promise<void>;
  setPageProperty(pageId: string, key: string, value: string): Promise<void>;
  getPageProperty(pageId: string, key: string): Promise<string | undefined>;
  /** MUST fully paginate. A short page carrying a next-cursor is not the last page. */
  listPages(spaceKey: string): Promise<E2ePageRecord[]>;
}

export interface E2eJiraPort {
  createIssue(input: {
    projectKey: string;
    summary: string;
    issueType: string;
  }): Promise<{ id: string; key: string }>;
  deleteIssue(issueKey: string): Promise<void>;
  setIssueProperty(issueKey: string, key: string, value: string): Promise<void>;
  getIssueProperty(issueKey: string, key: string): Promise<string | undefined>;
  /** MUST fully paginate. */
  listIssues(projectKey: string): Promise<E2eIssueRecord[]>;
}

export interface E2ePorts {
  confluence?: E2eConfluencePort;
  jira?: E2eJiraPort;
}

// ---------------------------------------------------------------------------
// Per-test tracking + cleanup
// ---------------------------------------------------------------------------

/** What a {@link E2eResourceTracker.cleanup} pass actually managed to remove. */
export interface E2eCleanupSummary {
  deletedPages: string[];
  deletedIssues: string[];
  /** Deletions that failed. Never thrown — reported, so a `finally` cannot mask the real error. */
  failures: Array<{ kind: "page" | "issue"; id: string; error: string }>;
}

/**
 * Records every live resource a test creates and deletes them again.
 *
 * Two invariants worth stating, because both exist to keep the tenant clean
 * even when things go wrong:
 *
 *  - The ID is recorded **before** the ownership marker is written. If stamping
 *    the marker fails, the resource is already tracked and this run's `finally`
 *    still deletes it — otherwise it would be orphaned *and* invisible to the
 *    marker-gated sweeper, i.e. permanent residue.
 *  - {@link cleanup} never throws. It runs inside `finally` blocks, where a
 *    throw would replace the test's actual failure with a cleanup error.
 */
export class E2eResourceTracker {
  readonly runId: string;
  private readonly pageIds: string[] = [];
  private readonly issueKeys: string[] = [];

  constructor(
    private readonly ports: E2ePorts,
    runId: string = resolveRunId()
  ) {
    this.runId = runId;
  }

  /** IDs of pages created through (or handed to) this tracker, creation order. */
  get trackedPages(): readonly string[] {
    return [...this.pageIds];
  }

  /** Keys of issues created through (or handed to) this tracker, creation order. */
  get trackedIssues(): readonly string[] {
    return [...this.issueKeys];
  }

  /**
   * Record a page created by something else (e.g. the CLI under test) so it is
   * still deleted in `finally`. Prefer {@link createPage}, which also stamps
   * the ownership marker.
   */
  trackPage(pageId: string): void {
    if (!this.pageIds.includes(pageId)) this.pageIds.push(pageId);
  }

  /** Record an issue created by something else. Prefer {@link createIssue}. */
  trackIssue(issueKey: string): void {
    if (!this.issueKeys.includes(issueKey)) this.issueKeys.push(issueKey);
  }

  /**
   * Create a conventionally named DOCSY page carrying the ownership marker.
   *
   * @param feature - Feature slug for the name (see {@link makeE2eTitle}).
   */
  async createPage(
    feature: string,
    options: { storage?: string; parentId?: string; now?: Date } = {}
  ): Promise<{ id: string; title: string }> {
    const confluence = this.requireConfluence();
    const title = makeE2eTitle(feature, options.now);
    const page = await confluence.createPage({
      spaceKey: E2E_SPACE_KEY,
      title,
      storage: options.storage ?? `<p>atlcli E2E fixture (run ${this.runId}). Safe to delete.</p>`,
      parentId: options.parentId,
    });
    // Track BEFORE stamping: an unmarked orphan is worse than a tracked failure.
    this.trackPage(page.id);
    await confluence.setPageProperty(page.id, E2E_RUN_ID_PROPERTY, this.runId);
    return { id: page.id, title };
  }

  /** Create a conventionally named ATLCLI issue carrying the ownership marker. */
  async createIssue(
    feature: string,
    options: { issueType?: string; now?: Date } = {}
  ): Promise<{ id: string; key: string; summary: string }> {
    const jira = this.requireJira();
    const summary = makeE2eTitle(feature, options.now);
    const issue = await jira.createIssue({
      projectKey: E2E_PROJECT_KEY,
      summary,
      issueType: options.issueType ?? "Task",
    });
    this.trackIssue(issue.key);
    await jira.setIssueProperty(issue.key, E2E_RUN_ID_PROPERTY, this.runId);
    return { ...issue, summary };
  }

  /**
   * Delete everything recorded, newest first.
   *
   * Best-effort and non-throwing: a failed deletion is collected into
   * {@link E2eCleanupSummary.failures} and the remaining resources are still
   * attempted. Whatever survives is the sweeper's problem — it carries the
   * marker, so the sweeper can prove ownership.
   */
  async cleanup(): Promise<E2eCleanupSummary> {
    const summary: E2eCleanupSummary = { deletedPages: [], deletedIssues: [], failures: [] };

    for (const pageId of [...this.pageIds].reverse()) {
      try {
        await this.ports.confluence?.deletePage(pageId);
        summary.deletedPages.push(pageId);
      } catch (error) {
        summary.failures.push({ kind: "page", id: pageId, error: errorMessage(error) });
      }
    }
    this.pageIds.length = 0;

    for (const issueKey of [...this.issueKeys].reverse()) {
      try {
        await this.ports.jira?.deleteIssue(issueKey);
        summary.deletedIssues.push(issueKey);
      } catch (error) {
        summary.failures.push({ kind: "issue", id: issueKey, error: errorMessage(error) });
      }
    }
    this.issueKeys.length = 0;

    return summary;
  }

  private requireConfluence(): E2eConfluencePort {
    if (!this.ports.confluence) throw new Error("E2eResourceTracker: no Confluence port configured");
    return this.ports.confluence;
  }

  private requireJira(): E2eJiraPort {
    if (!this.ports.jira) throw new Error("E2eResourceTracker: no Jira port configured");
    return this.ports.jira;
  }
}

/**
 * Run `fn` with a tracker and delete everything it created — **always**,
 * including when `fn` throws.
 *
 * This is the shape every live E2E case should use; it is what makes the
 * nightly sweeper a recovery mechanism instead of the primary one.
 *
 * @example
 * ```ts
 * await withE2eResources({ confluence }, async (t) => {
 *   const page = await t.createPage("scope-tree");
 *   await runCli(["wiki", "export", page.id]);
 * });
 * ```
 */
export async function withE2eResources<T>(
  ports: E2ePorts,
  fn: (tracker: E2eResourceTracker) => Promise<T>,
  options: { runId?: string; onCleanup?: (summary: E2eCleanupSummary) => void } = {}
): Promise<T> {
  const tracker = new E2eResourceTracker(ports, options.runId);
  try {
    return await fn(tracker);
  } finally {
    const summary = await tracker.cleanup();
    if (options.onCleanup) {
      options.onCleanup(summary);
    } else if (summary.failures.length > 0) {
      // Surface, never throw: the nightly sweeper is the backstop for these.
      console.warn(
        `[e2e] cleanup left ${summary.failures.length} resource(s) behind (run ${tracker.runId}); ` +
          `the nightly sweeper will recover them: ${summary.failures.map((f) => `${f.kind}:${f.id}`).join(", ")}`
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable-job decisions, as pure functions (spec 010 T5.6).
 *
 * Everything a background export needs to *decide* lives here — which record is
 * still in flight, which bytes may be evicted, which record the sweep must fail
 * or delete, what the toolbar badge says. None of it touches IndexedDB,
 * `chrome.*` or React, so the interesting cases (a service worker that restarted
 * mid-compile, a store at 127 MiB of 128 MiB, a worker that never answered) are
 * ordinary unit tests rather than browser choreography.
 *
 * The types are structural on purpose: `job-store.ts` maps its records onto
 * {@link BudgetEntry} / {@link SweepCandidate} rather than this module importing
 * the store, so the store can depend on these decisions without a cycle.
 */
import type { PdfJobKind } from "../messages.js";
import type { PdfJobStatus } from "../pdf/job-store.js";

export type { PdfJobKind, PdfJobStatus };

/**
 * Statuses that mean "a compiler is, or is about to be, working on this".
 *
 * `"prepared"` is the plan's `queued`: the record exists and the compile has
 * been requested, but no worker has claimed it yet. It is spelled `prepared`
 * because that is the value already written to `atlcli-pdf` and read by
 * `workers/pdf-compiler.ts`; the panel already *shows* it as the `queued`
 * export phase (`ExportPhase`, `pdf.phase.queued`).
 */
export const PDF_JOB_IN_FLIGHT_STATUSES = ["prepared", "compiling"] as const;

/** True while a compiler still owns this record. */
export function isPdfJobInFlight(status: PdfJobStatus): boolean {
  return status === "prepared" || status === "compiling";
}

/** True once the record can no longer change by itself. */
export function isPdfJobTerminal(status: PdfJobStatus): boolean {
  return !isPdfJobInFlight(status);
}

// ---------------------------------------------------------------------------
// One eviction policy over one shared budget
// ---------------------------------------------------------------------------

/** Which tenant of the shared `PDF_STORE_MAX_BYTES` budget an entry belongs to. */
export type BudgetTenant = "job" | "preview-cache";

/** One occupant of the shared byte budget, whatever store it physically lives in. */
export interface BudgetEntry {
  id: string;
  tenant: BudgetTenant;
  bytes: number;
  createdAt: number;
  /** `"cached"` for the preview cache, which has no job lifecycle. */
  status: PdfJobStatus | "cached";
  kind: PdfJobKind;
  /** True once the panel has handed these bytes to the user. */
  consumed: boolean;
}

/**
 * Eviction order, low rank first. `null` means **never evictable**.
 *
 * The asymmetry this encodes is the whole point of having one policy instead of
 * two: a preview is a cache the panel can rebuild in seconds, whereas a
 * finished-but-unconsumed export is the only copy of work the user waited
 * minutes for. Sorting by size or recency alone would happily throw the second
 * away to make room for the first.
 */
export function evictionRank(
  entry: BudgetEntry,
  options: { now: number; maxAgeMs: number }
): number | null {
  // 0 — past the retention horizon. Garbage under every policy.
  if (options.now - entry.createdAt > options.maxAgeMs) return 0;
  // 1 — the preview cache. A cache, by construction regenerable.
  if (entry.tenant === "preview-cache") return 1;
  // 2 — spent: the user already has these bytes, or never will.
  if (entry.status === "cancelled" || entry.status === "failed") return 2;
  if (entry.status === "complete" && entry.consumed) return 2;
  // 3 — a preview job record. Regenerable like the cache, one debounce later.
  if (entry.kind === "preview") return 3;
  // null — a running export, or a finished one nobody has collected yet.
  return null;
}

export interface EvictionPlan {
  /** Ids to drop, in the order they should be dropped. */
  evict: readonly BudgetEntry[];
  /** Bytes those evictions release. */
  freed: number;
  /** Whether the request fits once the plan is carried out. */
  fits: boolean;
  /** Bytes still over budget when `fits` is false (0 otherwise). */
  shortfall: number;
}

/**
 * Plan the evictions that make room for `incomingBytes`.
 *
 * Greedy over ({@link evictionRank}, oldest first) — not over size. Evicting the
 * biggest first would trade one 30 MiB preview for thirty stale 1 MiB records
 * that a later export would have had to evict anyway; evicting the *cheapest to
 * lose* first is the property that matters, and inside a rank the oldest entry
 * is the one whose loss the user is least likely to notice.
 */
export function planStoreEviction(
  entries: readonly BudgetEntry[],
  incomingBytes: number,
  options: { limit: number; now: number; maxAgeMs: number }
): EvictionPlan {
  const held = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let over = held + incomingBytes - options.limit;
  if (over <= 0) return { evict: [], freed: 0, fits: true, shortfall: 0 };

  const candidates = entries
    .map((entry) => ({ entry, rank: evictionRank(entry, options) }))
    .filter((c): c is { entry: BudgetEntry; rank: number } => c.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.entry.createdAt - b.entry.createdAt);

  const evict: BudgetEntry[] = [];
  let freed = 0;
  for (const candidate of candidates) {
    if (over <= 0) break;
    evict.push(candidate.entry);
    freed += candidate.entry.bytes;
    over -= candidate.entry.bytes;
  }
  return { evict, freed, fits: over <= 0, shortfall: over > 0 ? over : 0 };
}

// ---------------------------------------------------------------------------
// Sweep: the guarantee that no record is stuck in flight forever
// ---------------------------------------------------------------------------

/** How long a terminal record the user never collected stays around. */
export const PDF_JOB_TERMINAL_GRACE_MS = 60 * 60 * 1000;

/**
 * The error a job gets when its worker never reported back.
 *
 * Deliberately recoverable wording: nothing was corrupted, the export simply has
 * to be started again. A record stuck at `compiling` forever is the failure the
 * panel cannot explain — this is the sentence that replaces it.
 */
export const PDF_JOB_TIMED_OUT_ERROR =
  "The export stopped responding and was ended. Start it again.";

/** The subset of a stored record the sweep reasons about. */
export interface SweepCandidate {
  id: string;
  status: PdfJobStatus;
  kind: PdfJobKind;
  createdAt: number;
  /** Wall clock after which an unfinished job is declared failed. */
  deadlineAt?: number;
  consumed: boolean;
}

export type SweepAction =
  | { id: string; action: "fail"; error: string }
  | { id: string; action: "delete"; reason: "expired" | "consumed" | "preview" | "stale-terminal" };

/**
 * Decide what the sweep does to each record.
 *
 * Ordered so that a record can only be described once: expiry beats everything,
 * then the watchdog, then the retention rules. The watchdog is the half that
 * makes durability honest — an MV3 service worker that dies mid-compile takes
 * the `sendMessage` response with it, and without a deadline the record would
 * read `compiling` until the 24 h sweep.
 */
export function planSweep(
  candidates: readonly SweepCandidate[],
  options: { now: number; maxAgeMs: number; terminalGraceMs?: number }
): SweepAction[] {
  const grace = options.terminalGraceMs ?? PDF_JOB_TERMINAL_GRACE_MS;
  const actions: SweepAction[] = [];
  for (const candidate of candidates) {
    if (options.now - candidate.createdAt > options.maxAgeMs) {
      actions.push({ id: candidate.id, action: "delete", reason: "expired" });
      continue;
    }
    if (isPdfJobInFlight(candidate.status)) {
      if (candidate.deadlineAt !== undefined && options.now > candidate.deadlineAt) {
        actions.push({ id: candidate.id, action: "fail", error: PDF_JOB_TIMED_OUT_ERROR });
      }
      continue;
    }
    if (candidate.consumed) {
      actions.push({ id: candidate.id, action: "delete", reason: "consumed" });
      continue;
    }
    // A preview is never re-attached to: the panel either used its bytes (and
    // the preview cache kept its own copy) or asked for a newer one.
    if (candidate.kind === "preview") {
      actions.push({ id: candidate.id, action: "delete", reason: "preview" });
      continue;
    }
    if (
      (candidate.status === "failed" || candidate.status === "cancelled") &&
      options.now - candidate.createdAt > grace
    ) {
      actions.push({ id: candidate.id, action: "delete", reason: "stale-terminal" });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/**
 * Badge text for `n` finished exports nobody has collected yet.
 *
 * The toolbar badge is the *only* notification channel available here:
 * `chrome.notifications` would need a new manifest permission, and this folder
 * ships none (`tests/manifest.test.ts`). Two characters is all the badge renders
 * legibly, so anything past nine collapses.
 */
export function jobBadgeText(unconsumedFinished: number): string {
  if (unconsumedFinished <= 0) return "";
  return unconsumedFinished > 9 ? "9+" : String(unconsumedFinished);
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure; the component supplies the translated frame)
// ---------------------------------------------------------------------------

/** Coarse age bucket for a job row: minutes, then hours. */
export function jobAgeMinutes(createdAt: number, now: number): number {
  return Math.max(0, Math.floor((now - createdAt) / 60_000));
}

/**
 * Site origin of a job, derived from its `sourceIdentity`
 * (`pageUrl|contentId|version`).
 *
 * The Jobs list is per-site: a job started on a staging site must not appear
 * while the user is looking at production, even though both live in the same
 * profile's IndexedDB. Returns `null` for an identity whose first segment is not
 * a URL, which is exactly the "cannot attribute it, do not show it" case.
 */
export function siteOriginFromSourceIdentity(sourceIdentity: string): string | null {
  const first = sourceIdentity.split("|")[0] ?? "";
  try {
    const url = new URL(first);
    // `new URL("page:1")` parses happily — protocol `page:`, origin the *string*
    // `"null"` — so an opaque identity would otherwise be attributed to a site
    // literally named "null" and shown next to real jobs.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

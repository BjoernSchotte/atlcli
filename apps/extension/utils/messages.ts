/**
 * Typed message protocol for the atlcli extension (spec 002 §2.3).
 *
 * All cross-context messages (side panel <-> service worker <-> offscreen)
 * are members of the `ExtMessage` discriminated union, keyed on `kind`. Both
 * sides exhaustively switch on `kind`; later specs EXTEND this union rather
 * than inventing ad-hoc messages.
 *
 * Request/response pairing rides `chrome.runtime.sendMessage`'s response
 * callback (promise-returning in MV3): a request message resolves to its
 * paired response, related by the `ResponseFor<K>` mapping below.
 */

import type { AtlassianEntity } from "@atlcli/core";
import {
  isCodeThemeId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import type {
  ResearchErrorCode,
  ResearchOneShotEventV1,
  ResearchOneShotPolicyV1,
  ResearchProgressV1,
  ResearchReport,
  ResearchRequestV1,
} from "./research/contracts.js";
import type {
  ResearchResumableSessionV1,
  ResearchClarificationReviewResolutionV1,
  ResearchScopeClarificationReviewResolutionV1,
  ResearchSessionClarificationReviewV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
  ResearchScopePreflightOptionsV1,
  ResearchScopePreflightOutcomeV1,
} from "@atlcli/research";
import { isResearchOneShotEventV1 } from "./research/events.js";

/**
 * Detection payload shared by the SW push (`entity-changed`) and the
 * panel-initiated pull (`current-entity`): the active tab's URL and the entity
 * the extractor resolved from it (`null` for non-Atlassian / unrecognized tabs).
 */
export interface EntityDetection {
  /** Chrome window whose active tab produced this detection. */
  windowId: number;
  /** Active tab URL, or `null` when no URL is available (e.g. no active tab). */
  url: string | null;
  /** Entity resolved via `extractEntityFromUrl`, or `null` when none matches. */
  entity: AtlassianEntity | null;
  /**
   * Monotonic ordering token stamped by the service worker's tab observer
   * (spec 003, finding: detection ordering). Both the SW push (`entity-changed`)
   * and the panel-initiated pull (`current-entity`) draw from the SAME counter,
   * so the panel can drop any detection older than the newest it has applied —
   * e.g. a delayed pull response for tab A that arrives after a newer push for
   * tab B must not clobber B.
   */
  seq: number;
}

/**
 * What a queued compile is *for* (spec 010 T5.3).
 *
 * Part of the wire protocol rather than of the compiler host, because the
 * decision is made in the panel (`utils/pdf/compile-port.ts`) and consumed in
 * the offscreen document (`utils/pdf/compiler-host.ts`) — two contexts that
 * share nothing but this module. Both scheduling fields below are **scalars**:
 * the invariant that no PDF or asset byte ever crosses `sendMessage` (bytes go
 * through IndexedDB) is unaffected.
 */
export type PdfJobKind = "preview" | "export";

/** Scheduling hints carried alongside a compile request. Both optional. */
export interface PdfCompileHints {
  /** Absent → `"export"`: the conservative default for any caller that has not opted in. */
  job?: PdfJobKind;
  /**
   * Estimated *source* pages (chapters) in the bundle, used only to scale the
   * hang timeout. Never the compiled PDF page count — that is knowable only
   * after `validatePdfOutput`.
   */
  pages?: number;
}

/**
 * A revision-fenced decision over one durable scope-expansion proposal. The
 * side panel never sends a scope key, candidate, binding, tenant, or lease:
 * the background host derives those from the persisted proposal after it has
 * bound the session to the active tab's tenant.
 */
export interface ResearchScopeReviewActionRequest {
  sessionId: string;
  revision: number;
  briefRevision: number;
  graphRevision: number;
  proposalId: string;
}

/** A proposal-free revision fence for the replacement plan of a whole scope. */
export interface ResearchScopePlanReviewActionRequest {
  sessionId: string;
  revision: number;
  briefRevision: number;
  graphRevision: number;
}

/** Revision fence for one initial durable research plan. */
export interface ResearchPlanReviewActionRequest {
  sessionId: string;
  revision: number;
  briefRevision: number;
  graphRevision: number;
}

/**
 * A correction to one exact durable plan. The panel never supplies a graph,
 * scope, tenant, or policy; the background derives those from stored state.
 */
export interface ResearchPlanRevisionActionRequest extends ResearchPlanReviewActionRequest {
  instruction: string;
}

/** Revision-fenced answers and decisions for one durable brief revision. */
export interface ResearchClarificationReviewActionRequest {
  sessionId: string;
  revision: number;
  briefRevision: number;
  answers: Array<{ questionId: string; response: string }>;
  assumptionDecisions: Array<{ assumptionId: string; decision: "accepted" | "rejected" }>;
}

/** Revision fence for a previous answer-committed planning checkpoint. */
export interface ResearchClarificationPlanningActionRequest {
  sessionId: string;
  revision: number;
  briefRevision: number;
}

/** Revision-fenced choice for a persisted, pre-brief scope clarification. */
export interface ResearchScopeClarificationReviewActionRequest {
  sessionId: string;
  revision: number;
  selection: {
    schema: "atlcli.research-scope-candidate-selection/v1";
    mentionId: string;
    candidateId: string;
  };
}

/** Revision fence for a post-choice brief/plan recovery checkpoint. */
export interface ResearchScopeClarificationPlanningActionRequest {
  sessionId: string;
  revision: number;
}

/** Revision-fenced request to erase one terminal, tenant-bound research session. */
export interface ResearchSessionDeletionActionRequest {
  sessionId: string;
  revision: number;
}

/** One bounded user instruction applied only at a persisted retrieval checkpoint. */
export interface ResearchSessionSteeringActionRequest {
  sessionId: string;
  revision: number;
  instruction: string;
}

/** Bounded timing/result projection for cross-realm DOCX runtime preparation. */
export interface DocxRuntimePreparationMessage {
  totalMs: number;
  highlightingMs: number;
  codeFontMs: number;
  codeFontBytes: number;
}

/** Request messages sent from the panel to the service worker. */
export type ExtRequest =
  | { kind: "ping" }
  | { kind: "wasm-smoke"; a: number; b: number }
  | { kind: "get-current-entity"; windowId: number }
  | ({ kind: "pdf:compile"; jobId: string } & PdfCompileHints)
  | { kind: "pdf:cancel"; jobId: string }
  | { kind: "docx:prepare-runtime"; codeTheme?: CodeThemeId }
  | { kind: "jobs:wake"; jobIds?: string[]; resumeWaiting?: boolean }
  | {
      kind: "research:resolve-scope";
      windowId: number;
      request: ResearchRequestV1;
      options?: ResearchScopePreflightOptionsV1;
    }
  | {
      kind: "research:run";
      runId: string;
      sessionId: string;
      turnId: string;
      windowId: number;
      request: ResearchRequestV1;
      policy?: ResearchOneShotPolicyV1;
    }
  | {
      /** Resume one host-validated durable turn without accepting new scope or policy. */
      kind: "research:resume";
      runId: string;
      sessionId: string;
      windowId: number;
    }
  | { kind: "research:list-resumable-sessions"; windowId: number }
  | ({ kind: "research:steer-session"; windowId: number } & ResearchSessionSteeringActionRequest)
  | ({ kind: "research:delete-session"; windowId: number } & ResearchSessionDeletionActionRequest)
  | { kind: "research:list-scope-reviews"; windowId: number }
  | ({ kind: "research:approve-scope-review"; windowId: number } & ResearchScopeReviewActionRequest)
  | ({ kind: "research:reject-scope-review"; windowId: number } & ResearchScopeReviewActionRequest)
  | { kind: "research:list-scope-plan-reviews"; windowId: number }
  | ({ kind: "research:approve-scope-plan-review"; windowId: number } & ResearchScopePlanReviewActionRequest)
  | {
      kind: "research:prepare-plan-review";
      windowId: number;
      request: ResearchRequestV1;
      policy: ResearchOneShotPolicyV1;
    }
  | { kind: "research:list-plan-reviews"; windowId: number }
  | ({ kind: "research:approve-plan-review"; windowId: number } & ResearchPlanReviewActionRequest)
  | ({ kind: "research:reject-plan-review"; windowId: number } & ResearchPlanRevisionActionRequest)
  | {
      kind: "research:prepare-clarification-review";
      windowId: number;
      request: ResearchRequestV1;
      policy: ResearchOneShotPolicyV1;
    }
  | { kind: "research:list-clarification-reviews"; windowId: number }
  | ({ kind: "research:resolve-clarification-review"; windowId: number } & ResearchClarificationReviewActionRequest)
  | ({ kind: "research:continue-clarification-review"; windowId: number } & ResearchClarificationPlanningActionRequest)
  | {
      kind: "research:prepare-scope-clarification-review";
      windowId: number;
      request: ResearchRequestV1;
      policy: ResearchOneShotPolicyV1;
    }
  | { kind: "research:list-scope-clarification-reviews"; windowId: number }
  | ({ kind: "research:resolve-scope-clarification-review"; windowId: number } & ResearchScopeClarificationReviewActionRequest)
  | ({ kind: "research:continue-scope-clarification-review"; windowId: number } & ResearchScopeClarificationPlanningActionRequest)
  /** Stop only the in-flight worker; recovery remains possible. */
  | { kind: "research:cancel"; runId: string }
  /** Request a cooperative stop at the next durable retrieval checkpoint. */
  | { kind: "research:pause-session"; runId: string }
  /** Explicit user cancellation also terminally records the owned session. */
  | { kind: "research:cancel-session"; runId: string };

/** Response messages returned to the panel. */
export type ExtResponse =
  | { kind: "pong" }
  | { kind: "wasm-smoke-result"; ok: true; result: number }
  | { kind: "wasm-smoke-result"; ok: false; error: string }
  | { kind: "current-entity"; detection: EntityDetection }
  | { kind: "pdf:compile-result"; jobId: string; ok: true }
  | { kind: "pdf:compile-result"; jobId: string; ok: false; error: string }
  | { kind: "pdf:cancel-result"; jobId: string; cancelled: boolean }
  | { kind: "docx:prepare-runtime-result"; ok: true; preparation: DocxRuntimePreparationMessage }
  | { kind: "docx:prepare-runtime-result"; ok: false; error: string }
  | { kind: "jobs:wake-result"; claimedJobId?: string; error?: never }
  | { kind: "jobs:wake-result"; error: string; claimedJobId?: never }
  | { kind: "research:resolve-scope-result"; ok: true; outcome: ResearchScopePreflightOutcomeV1 }
  | {
      kind: "research:resolve-scope-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | { kind: "research:run-result"; runId: string; ok: true; report: ResearchReport }
  | {
      kind: "research:run-result";
      runId: string;
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | { kind: "research:resume-result"; runId: string; ok: true; report: ResearchReport }
  | {
      kind: "research:resume-result";
      runId: string;
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-resumable-sessions-result";
      ok: true;
      sessions: ResearchResumableSessionV1[];
    }
  | {
      kind: "research:list-resumable-sessions-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:steer-session-result";
      ok: true;
      sessionId: string;
      revision: number;
      status: "waiting_steering";
    }
  | {
      kind: "research:steer-session-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:delete-session-result";
      ok: true;
      /** `false` means a previous successful deletion already erased this id. */
      deleted: boolean;
    }
  | {
      kind: "research:delete-session-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-scope-reviews-result";
      ok: true;
      reviews: ResearchSessionScopeReviewV1[];
    }
  | {
      kind: "research:list-scope-reviews-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:approve-scope-review-result";
      ok: true;
      review: ResearchSessionScopeReviewV1;
    }
  | {
      kind: "research:approve-scope-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:reject-scope-review-result";
      ok: true;
      review: ResearchSessionScopeReviewV1;
    }
  | {
      kind: "research:reject-scope-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-scope-plan-reviews-result";
      ok: true;
      reviews: ResearchSessionScopeReviewV1[];
    }
  | {
      kind: "research:list-scope-plan-reviews-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:approve-scope-plan-review-result";
      ok: true;
      review: ResearchSessionScopeReviewV1;
    }
  | {
      kind: "research:approve-scope-plan-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:prepare-plan-review-result";
      ok: true;
      review: ResearchSessionPlanReviewV1;
    }
  | {
      kind: "research:prepare-plan-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-plan-reviews-result";
      ok: true;
      reviews: ResearchSessionPlanReviewV1[];
    }
  | {
      kind: "research:list-plan-reviews-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:approve-plan-review-result";
      ok: true;
      session: ResearchResumableSessionV1;
    }
  | {
      kind: "research:approve-plan-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:reject-plan-review-result";
      ok: true;
      review: ResearchSessionPlanReviewV1;
    }
  | {
      kind: "research:reject-plan-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:prepare-clarification-review-result";
      ok: true;
      review: ResearchSessionClarificationReviewV1;
    }
  | {
      kind: "research:prepare-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-clarification-reviews-result";
      ok: true;
      reviews: ResearchSessionClarificationReviewV1[];
    }
  | {
      kind: "research:list-clarification-reviews-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:resolve-clarification-review-result";
      ok: true;
      outcome: ResearchClarificationReviewResolutionV1;
    }
  | {
      kind: "research:resolve-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:continue-clarification-review-result";
      ok: true;
      outcome: ResearchClarificationReviewResolutionV1;
    }
  | {
      kind: "research:continue-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:prepare-scope-clarification-review-result";
      ok: true;
      review: ResearchSessionScopeClarificationReviewV1;
    }
  | {
      kind: "research:prepare-scope-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:list-scope-clarification-reviews-result";
      ok: true;
      reviews: ResearchSessionScopeClarificationReviewV1[];
    }
  | {
      kind: "research:list-scope-clarification-reviews-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:resolve-scope-clarification-review-result";
      ok: true;
      outcome: ResearchScopeClarificationReviewResolutionV1;
    }
  | {
      kind: "research:resolve-scope-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "research:continue-scope-clarification-review-result";
      ok: true;
      outcome: ResearchScopeClarificationReviewResolutionV1;
    }
  | {
      kind: "research:continue-scope-clarification-review-result";
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | { kind: "research:cancel-result"; runId: string; cancelled: boolean }
  | {
      kind: "research:pause-session-result";
      runId: string;
      ok: true;
      status: "pause_requested" | "paused";
    }
  | {
      kind: "research:pause-session-result";
      runId: string;
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | { kind: "research:cancel-session-result"; runId: string; cancelled: boolean };

/**
 * Push message: the service worker (canonical tab observer, PLAN §2.1) notifies
 * the panel that the active tab's entity changed. Fire-and-forget — no paired
 * response — so it is NOT part of `ExtRequest`/`ResponseMap`. The panel filters
 * for it with {@link isEntityChanged}.
 */
export type EntityChanged = { kind: "entity-changed"; detection: EntityDetection };
/** Fire-and-forget hint; durable snapshots remain the badge correctness path. */
export type ExportJobsChanged = { kind: "jobs:changed"; jobId: string };
export type ResearchProgressMessage = {
  kind: "research:progress";
  runId: string;
  progress: ResearchProgressV1;
};
export type ResearchEventMessage = {
  kind: "research:event";
  runId: string;
  event: ResearchOneShotEventV1;
};

/**
 * Internal messages the service worker forwards to the offscreen document.
 * Namespaced (`offscreen:`) so the SW's own panel-facing listener ignores them
 * (no self-delivery loop over the shared `chrome.runtime` message bus).
 */
export type OffscreenRequest =
  | { kind: "offscreen:wasm-add"; a: number; b: number }
  | ({ kind: "offscreen:pdf-compile"; jobId: string } & PdfCompileHints)
  | { kind: "offscreen:pdf-cancel"; jobId: string }
  | { kind: "offscreen:docx-prepare-runtime"; codeTheme?: CodeThemeId }
  | { kind: "offscreen:jobs-wake"; jobIds?: string[]; resumeWaiting?: boolean }
  | {
      kind: "offscreen:research-run";
      runId: string;
      sessionId: string;
      turnId: string;
      apiKey: string;
      request: ResearchRequestV1;
      policy?: ResearchOneShotPolicyV1;
    }
  | {
      kind: "offscreen:research-resume";
      runId: string;
      sessionId: string;
      turnId: string;
      apiKey: string;
    }
  | { kind: "offscreen:research-pause"; runId: string }
  | { kind: "offscreen:research-cancel"; runId: string };
export type OffscreenResponse =
  | { kind: "offscreen:wasm-add-result"; ok: true; result: number }
  | { kind: "offscreen:wasm-add-result"; ok: false; error: string }
  | { kind: "offscreen:pdf-compile-result"; jobId: string; ok: true }
  | { kind: "offscreen:pdf-compile-result"; jobId: string; ok: false; error: string }
  | { kind: "offscreen:pdf-cancel-result"; jobId: string; cancelled: boolean }
  | { kind: "offscreen:docx-prepare-runtime-result"; ok: true; preparation: DocxRuntimePreparationMessage }
  | { kind: "offscreen:docx-prepare-runtime-result"; ok: false; error: string }
  | { kind: "offscreen:jobs-wake-result"; claimedJobId?: string; error?: never }
  | { kind: "offscreen:jobs-wake-result"; error: string; claimedJobId?: never }
  | {
      kind: "offscreen:research-run-result";
      runId: string;
      ok: true;
      report: ResearchReport;
    }
  | {
      kind: "offscreen:research-run-result";
      runId: string;
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | {
      kind: "offscreen:research-resume-result";
      runId: string;
      ok: true;
      report: ResearchReport;
    }
  | {
      kind: "offscreen:research-resume-result";
      runId: string;
      ok: false;
      code: ResearchErrorCode;
      error: string;
    }
  | { kind: "offscreen:research-pause-result"; runId: string; paused: boolean }
  | { kind: "offscreen:research-cancel-result"; runId: string; cancelled: boolean };

/** Every message that can travel over the protocol. */
export type ExtMessage =
  | ExtRequest
  | ExtResponse
  | EntityChanged
  | ExportJobsChanged
  | ResearchProgressMessage
  | ResearchEventMessage
  | OffscreenRequest
  | OffscreenResponse;

/** Discriminant literal type for requests. */
export type ExtRequestKind = ExtRequest["kind"];

/**
 * Maps a request `kind` to the exact response type the router resolves with.
 * Keeps `sendMessage` call sites type-safe without runtime cost.
 */
export interface ResponseMap {
  ping: Extract<ExtResponse, { kind: "pong" }>;
  "wasm-smoke": Extract<ExtResponse, { kind: "wasm-smoke-result" }>;
  "get-current-entity": Extract<ExtResponse, { kind: "current-entity" }>;
  "pdf:compile": Extract<ExtResponse, { kind: "pdf:compile-result" }>;
  "pdf:cancel": Extract<ExtResponse, { kind: "pdf:cancel-result" }>;
  "docx:prepare-runtime": Extract<ExtResponse, { kind: "docx:prepare-runtime-result" }>;
  "jobs:wake": Extract<ExtResponse, { kind: "jobs:wake-result" }>;
  "research:resolve-scope": Extract<ExtResponse, { kind: "research:resolve-scope-result" }>;
  "research:run": Extract<ExtResponse, { kind: "research:run-result" }>;
  "research:resume": Extract<ExtResponse, { kind: "research:resume-result" }>;
  "research:list-resumable-sessions": Extract<ExtResponse, { kind: "research:list-resumable-sessions-result" }>;
  "research:steer-session": Extract<ExtResponse, { kind: "research:steer-session-result" }>;
  "research:delete-session": Extract<ExtResponse, { kind: "research:delete-session-result" }>;
  "research:list-scope-reviews": Extract<ExtResponse, { kind: "research:list-scope-reviews-result" }>;
  "research:approve-scope-review": Extract<ExtResponse, { kind: "research:approve-scope-review-result" }>;
  "research:reject-scope-review": Extract<ExtResponse, { kind: "research:reject-scope-review-result" }>;
  "research:list-scope-plan-reviews": Extract<ExtResponse, { kind: "research:list-scope-plan-reviews-result" }>;
  "research:approve-scope-plan-review": Extract<ExtResponse, { kind: "research:approve-scope-plan-review-result" }>;
  "research:prepare-plan-review": Extract<ExtResponse, { kind: "research:prepare-plan-review-result" }>;
  "research:list-plan-reviews": Extract<ExtResponse, { kind: "research:list-plan-reviews-result" }>;
  "research:approve-plan-review": Extract<ExtResponse, { kind: "research:approve-plan-review-result" }>;
  "research:reject-plan-review": Extract<ExtResponse, { kind: "research:reject-plan-review-result" }>;
  "research:prepare-clarification-review": Extract<ExtResponse, { kind: "research:prepare-clarification-review-result" }>;
  "research:list-clarification-reviews": Extract<ExtResponse, { kind: "research:list-clarification-reviews-result" }>;
  "research:resolve-clarification-review": Extract<ExtResponse, { kind: "research:resolve-clarification-review-result" }>;
  "research:continue-clarification-review": Extract<ExtResponse, { kind: "research:continue-clarification-review-result" }>;
  "research:prepare-scope-clarification-review": Extract<ExtResponse, { kind: "research:prepare-scope-clarification-review-result" }>;
  "research:list-scope-clarification-reviews": Extract<ExtResponse, { kind: "research:list-scope-clarification-reviews-result" }>;
  "research:resolve-scope-clarification-review": Extract<ExtResponse, { kind: "research:resolve-scope-clarification-review-result" }>;
  "research:continue-scope-clarification-review": Extract<ExtResponse, { kind: "research:continue-scope-clarification-review-result" }>;
  "research:cancel": Extract<ExtResponse, { kind: "research:cancel-result" }>;
  "research:pause-session": Extract<ExtResponse, { kind: "research:pause-session-result" }>;
  "research:cancel-session": Extract<ExtResponse, { kind: "research:cancel-session-result" }>;
}

export type ResponseFor<K extends ExtRequestKind> = ResponseMap[K];

/** Narrowing type guard for panel-facing request messages. */
export function isExtRequest(value: unknown): value is ExtRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; jobId?: unknown; windowId?: unknown };
  const kind = candidate.kind;
  if (kind === "pdf:compile") return hasOnlyKeys(value, ["kind", "jobId", "job", "pages"]) && isPdfJobId(candidate.jobId) && hasValidCompileHints(value);
  if (kind === "pdf:cancel") return hasOnlyKeys(value, ["kind", "jobId"]) && isPdfJobId(candidate.jobId);
  if (kind === "docx:prepare-runtime") {
    const preparation = value as { codeTheme?: unknown };
    return hasOnlyKeys(value, ["kind", "codeTheme"]) &&
      (preparation.codeTheme === undefined || isCodeThemeId(preparation.codeTheme));
  }
  if (kind === "jobs:wake") {
    const wake = value as { jobIds?: unknown; resumeWaiting?: unknown };
    return hasOnlyKeys(value, ["kind", "jobIds", "resumeWaiting"]) &&
      hasValidJobIds(wake.jobIds) &&
      (wake.resumeWaiting === undefined || typeof wake.resumeWaiting === "boolean") &&
      (wake.resumeWaiting !== true || Array.isArray(wake.jobIds));
  }
  if (kind === "research:run") {
    const run = value as { runId?: unknown; sessionId?: unknown; turnId?: unknown; windowId?: unknown; request?: unknown; policy?: unknown };
    return hasOnlyKeys(value, ["kind", "runId", "sessionId", "turnId", "windowId", "request", "policy"]) &&
      isResearchRunId(run.runId) &&
      isResearchSessionId(run.sessionId) &&
      isResearchTurnId(run.turnId) &&
      isWindowId(run.windowId) &&
      typeof run.request === "object" &&
      run.request !== null &&
      (run.policy === undefined || (typeof run.policy === "object" && run.policy !== null));
  }
  if (kind === "research:resume") {
    const resume = value as { runId?: unknown; sessionId?: unknown; windowId?: unknown };
    return hasOnlyKeys(value, ["kind", "runId", "sessionId", "windowId"]) &&
      isResearchRunId(resume.runId) &&
      isResearchSessionId(resume.sessionId) &&
      isWindowId(resume.windowId);
  }
  if (kind === "research:list-resumable-sessions") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:steer-session") {
    const action = value as Partial<ResearchSessionSteeringActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, ["kind", "windowId", "sessionId", "revision", "instruction"]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      typeof action.instruction === "string" && action.instruction.trim().length > 0 &&
      action.instruction.length <= 2_000;
  }
  if (kind === "research:delete-session") {
    const action = value as Partial<ResearchSessionDeletionActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, ["kind", "windowId", "sessionId", "revision"]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision);
  }
  if (kind === "research:list-scope-reviews") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:approve-scope-review" || kind === "research:reject-scope-review") {
    const action = value as Partial<ResearchScopeReviewActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, [
      "kind",
      "windowId",
      "sessionId",
      "revision",
      "briefRevision",
      "graphRevision",
      "proposalId",
    ]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision) &&
      isResearchRevision(action.graphRevision) &&
      isResearchScopeProposalId(action.proposalId);
  }
  if (kind === "research:list-scope-plan-reviews") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:approve-scope-plan-review") {
    const action = value as Partial<ResearchScopePlanReviewActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, [
      "kind",
      "windowId",
      "sessionId",
      "revision",
      "briefRevision",
      "graphRevision",
    ]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision) &&
      isResearchRevision(action.graphRevision);
  }
  if (kind === "research:prepare-plan-review") {
    const prepare = value as { windowId?: unknown; request?: unknown; policy?: unknown };
    return hasOnlyKeys(value, ["kind", "windowId", "request", "policy"]) &&
      isWindowId(prepare.windowId) &&
      typeof prepare.request === "object" && prepare.request !== null &&
      typeof prepare.policy === "object" && prepare.policy !== null;
  }
  if (kind === "research:list-plan-reviews") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:approve-plan-review") {
    const action = value as Partial<ResearchPlanReviewActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, [
      "kind",
      "windowId",
      "sessionId",
      "revision",
      "briefRevision",
      "graphRevision",
    ]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision) &&
      isResearchRevision(action.graphRevision);
  }
  if (kind === "research:reject-plan-review") {
    const action = value as Partial<ResearchPlanRevisionActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, [
      "kind",
      "windowId",
      "sessionId",
      "revision",
      "briefRevision",
      "graphRevision",
      "instruction",
    ]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision) &&
      isResearchRevision(action.graphRevision) &&
      isResearchPlanRevisionInstruction(action.instruction);
  }
  if (kind === "research:prepare-clarification-review") {
    const prepare = value as { windowId?: unknown; request?: unknown; policy?: unknown };
    return hasOnlyKeys(value, ["kind", "windowId", "request", "policy"]) &&
      isWindowId(prepare.windowId) &&
      typeof prepare.request === "object" && prepare.request !== null &&
      typeof prepare.policy === "object" && prepare.policy !== null;
  }
  if (kind === "research:list-clarification-reviews") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:resolve-clarification-review") {
    const action = value as Partial<ResearchClarificationReviewActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, [
      "kind",
      "windowId",
      "sessionId",
      "revision",
      "briefRevision",
      "answers",
      "assumptionDecisions",
    ]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision) &&
      hasValidClarificationAnswers(action.answers) &&
      hasValidAssumptionDecisions(action.assumptionDecisions);
  }
  if (kind === "research:continue-clarification-review") {
    const action = value as Partial<ResearchClarificationPlanningActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, ["kind", "windowId", "sessionId", "revision", "briefRevision"]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      isResearchRevision(action.briefRevision);
  }
  if (kind === "research:prepare-scope-clarification-review") {
    const prepare = value as { windowId?: unknown; request?: unknown; policy?: unknown };
    return hasOnlyKeys(value, ["kind", "windowId", "request", "policy"]) &&
      isWindowId(prepare.windowId) &&
      typeof prepare.request === "object" && prepare.request !== null &&
      typeof prepare.policy === "object" && prepare.policy !== null;
  }
  if (kind === "research:list-scope-clarification-reviews") {
    return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  }
  if (kind === "research:resolve-scope-clarification-review") {
    const action = value as Partial<ResearchScopeClarificationReviewActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, ["kind", "windowId", "sessionId", "revision", "selection"]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision) &&
      hasValidScopePreflightOptions({ candidateSelections: [action.selection] });
  }
  if (kind === "research:continue-scope-clarification-review") {
    const action = value as Partial<ResearchScopeClarificationPlanningActionRequest & { windowId: unknown }>;
    return hasOnlyKeys(value, ["kind", "windowId", "sessionId", "revision"]) &&
      isWindowId(action.windowId) &&
      isResearchSessionId(action.sessionId) &&
      isResearchRevision(action.revision);
  }
  if (kind === "research:resolve-scope") {
    const preflight = value as { windowId?: unknown; request?: unknown; options?: unknown };
    return hasOnlyKeys(value, ["kind", "windowId", "request", "options"]) &&
      isWindowId(preflight.windowId) &&
      typeof preflight.request === "object" &&
      preflight.request !== null &&
      hasValidScopePreflightOptions(preflight.options);
  }
  if (kind === "research:cancel" || kind === "research:pause-session" || kind === "research:cancel-session") {
    const cancel = value as { runId?: unknown };
    return hasOnlyKeys(value, ["kind", "runId"]) && isResearchRunId(cancel.runId);
  }
  if (kind === "get-current-entity") return hasOnlyKeys(value, ["kind", "windowId"]) && isWindowId(candidate.windowId);
  if (kind === "ping") return hasOnlyKeys(value, ["kind"]);
  return kind === "wasm-smoke"
    && hasOnlyKeys(value, ["kind", "a", "b"])
    && hasFiniteOperands(value);
}

/** Narrowing type guard for the SW→panel `entity-changed` push message. */
export function isEntityChanged(value: unknown): value is EntityChanged {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; detection?: { windowId?: unknown } };
  return candidate.kind === "entity-changed" && isWindowId(candidate.detection?.windowId);
}

export function isExportJobsChanged(value: unknown): value is ExportJobsChanged {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; jobId?: unknown };
  return candidate.kind === "jobs:changed" &&
    hasOnlyKeys(value, ["kind", "jobId"]) &&
    isOpaqueExportJobId(candidate.jobId);
}

export function isResearchProgress(
  value: unknown,
  runId?: string
): value is ResearchProgressMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    kind?: unknown;
    runId?: unknown;
    progress?: { phase?: unknown };
  };
  return candidate.kind === "research:progress" &&
    isResearchRunId(candidate.runId) &&
    (runId === undefined || candidate.runId === runId) &&
    typeof candidate.progress === "object" &&
    candidate.progress !== null &&
    ["preparing", "researching", "rendering", "complete"].includes(
      String(candidate.progress.phase)
    );
}

export function isResearchEvent(
  value: unknown,
  runId?: string,
): value is ResearchEventMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    kind?: unknown;
    runId?: unknown;
    event?: { kind?: unknown; seq?: unknown; at?: unknown };
  };
  if (!(candidate.kind === "research:event" &&
    hasOnlyKeys(value, ["kind", "runId", "event"]) &&
    isResearchRunId(candidate.runId) &&
    (runId === undefined || candidate.runId === runId) &&
    typeof candidate.event === "object" &&
    candidate.event !== null &&
    Number.isSafeInteger(candidate.event.seq) &&
    Number(candidate.event.seq) > 0 &&
    typeof candidate.event.at === "string" &&
    candidate.event.at.length <= 64 &&
    Number.isFinite(Date.parse(candidate.event.at)))) return false;

  return isResearchOneShotEventV1(candidate.event);
}

/** Narrow a broadcast push to the Chrome window owned by one side panel. */
export function isEntityChangedForWindow(
  value: unknown,
  windowId: number
): value is EntityChanged {
  return isEntityChanged(value) && value.detection.windowId === windowId;
}

/** Narrowing type guard for offscreen-bound request messages. */
export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; jobId?: unknown };
  if (candidate.kind === "offscreen:pdf-compile") {
    return hasOnlyKeys(value, ["kind", "jobId", "job", "pages"]) && isPdfJobId(candidate.jobId) && hasValidCompileHints(value);
  }
  if (candidate.kind === "offscreen:pdf-cancel") return hasOnlyKeys(value, ["kind", "jobId"]) && isPdfJobId(candidate.jobId);
  if (candidate.kind === "offscreen:docx-prepare-runtime") {
    const preparation = value as { codeTheme?: unknown };
    return hasOnlyKeys(value, ["kind", "codeTheme"]) &&
      (preparation.codeTheme === undefined || isCodeThemeId(preparation.codeTheme));
  }
  if (candidate.kind === "offscreen:jobs-wake") {
    const wake = value as { jobIds?: unknown; resumeWaiting?: unknown };
    return hasOnlyKeys(value, ["kind", "jobIds", "resumeWaiting"]) &&
      hasValidJobIds(wake.jobIds) &&
      (wake.resumeWaiting === undefined || typeof wake.resumeWaiting === "boolean") &&
      (wake.resumeWaiting !== true || Array.isArray(wake.jobIds));
  }
  if (candidate.kind === "offscreen:research-run") {
    const run = value as { runId?: unknown; sessionId?: unknown; turnId?: unknown; apiKey?: unknown; request?: unknown; policy?: unknown };
    return hasOnlyKeys(value, ["kind", "runId", "sessionId", "turnId", "apiKey", "request", "policy"]) &&
      isResearchRunId(run.runId) &&
      isResearchSessionId(run.sessionId) &&
      isResearchTurnId(run.turnId) &&
      isResearchApiKey(run.apiKey) &&
      typeof run.request === "object" &&
      run.request !== null &&
      (run.policy === undefined || (typeof run.policy === "object" && run.policy !== null));
  }
  if (candidate.kind === "offscreen:research-resume") {
    const resume = value as { runId?: unknown; sessionId?: unknown; turnId?: unknown; apiKey?: unknown };
    return hasOnlyKeys(value, ["kind", "runId", "sessionId", "turnId", "apiKey"]) &&
      isResearchRunId(resume.runId) &&
      isResearchSessionId(resume.sessionId) &&
      isResearchTurnId(resume.turnId) &&
      isResearchApiKey(resume.apiKey);
  }
  if (candidate.kind === "offscreen:research-cancel" || candidate.kind === "offscreen:research-pause") {
    const cancel = value as { runId?: unknown };
    return hasOnlyKeys(value, ["kind", "runId"]) && isResearchRunId(cancel.runId);
  }
  return candidate.kind === "offscreen:wasm-add"
    && hasOnlyKeys(value, ["kind", "a", "b"])
    && hasFiniteOperands(value);
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "object" && value !== null
    && Object.keys(value).every((key) => allowed.includes(key));
}

function isResearchApiKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_000 &&
    !/[\u0000-\u0020\u007f]/.test(value);
}

function hasValidJobIds(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 100 && value.every(isOpaqueExportJobId));
}

function hasValidScopePreflightOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!hasOnlyKeys(value, ["candidateSelections"])) return false;
  const selections = (value as { candidateSelections?: unknown }).candidateSelections;
  if (selections === undefined) return true;
  return Array.isArray(selections) && selections.length <= 8 && selections.every(
    (selection) =>
      hasOnlyKeys(selection, ["schema", "mentionId", "candidateId"]) &&
      (selection as { schema?: unknown }).schema ===
        "atlcli.research-scope-candidate-selection/v1" &&
      typeof (selection as { mentionId?: unknown }).mentionId === "string" &&
      /^mention:[A-Za-z0-9._-]{1,80}$/.test(
        (selection as { mentionId: string }).mentionId,
      ) &&
      typeof (selection as { candidateId?: unknown }).candidateId === "string" &&
      /^research-scope-candidate:[A-Za-z0-9._-]{1,200}$/.test(
        (selection as { candidateId: string }).candidateId,
      ),
  );
}

function hasValidClarificationAnswers(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 24 && value.every((answer) =>
    hasOnlyKeys(answer, ["questionId", "response"]) &&
    typeof (answer as { questionId?: unknown }).questionId === "string" &&
    /^clarification:[A-Za-z0-9._-]{1,120}$/.test((answer as { questionId: string }).questionId) &&
    typeof (answer as { response?: unknown }).response === "string" &&
    (answer as { response: string }).response.trim().length > 0 &&
    (answer as { response: string }).response.length <= 2_000,
  );
}

function hasValidAssumptionDecisions(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 24 && value.every((decision) =>
    hasOnlyKeys(decision, ["assumptionId", "decision"]) &&
    typeof (decision as { assumptionId?: unknown }).assumptionId === "string" &&
    /^assumption:[A-Za-z0-9._-]{1,120}$/.test((decision as { assumptionId: string }).assumptionId) &&
    ((decision as { decision?: unknown }).decision === "accepted" ||
      (decision as { decision?: unknown }).decision === "rejected"),
  );
}

function isResearchPlanRevisionInstruction(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2_000;
}

/** Mirrors the host-neutral export-job contract: opaque, non-empty, bounded text. */
function isOpaqueExportJobId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096;
}

function hasFiniteOperands(value: unknown): boolean {
  const candidate = value as { a?: unknown; b?: unknown };
  return typeof candidate.a === "number" && Number.isFinite(candidate.a)
    && typeof candidate.b === "number" && Number.isFinite(candidate.b);
}

/**
 * Validate the optional scheduling hints on a compile request.
 *
 * Both fields are advisory (they change queue order and the hang timeout, never
 * output), but they arrive over a bus any extension page can post to, so a
 * wrong-typed `job` must reject the whole message rather than be silently
 * coerced into `"export"` — a silently-coerced hint is indistinguishable from a
 * caller that never set one.
 */
function hasValidCompileHints(value: unknown): boolean {
  const candidate = value as { job?: unknown; pages?: unknown };
  if (candidate.job !== undefined && candidate.job !== "preview" && candidate.job !== "export") {
    return false;
  }
  if (candidate.pages !== undefined) {
    if (typeof candidate.pages !== "number" || !Number.isFinite(candidate.pages)) return false;
    if (candidate.pages < 1) return false;
  }
  return true;
}

function isPdfJobId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isWindowId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isResearchRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,200}$/.test(value);
}

function isResearchSessionId(value: unknown): value is string {
  return typeof value === "string" && /^research-session:[A-Za-z0-9._-]{1,120}$/.test(value);
}

function isResearchTurnId(value: unknown): value is string {
  return typeof value === "string" && /^research-turn:[A-Za-z0-9._-]{1,120}$/.test(value);
}

function isResearchScopeProposalId(value: unknown): value is string {
  return typeof value === "string" && /^scope-expansion:[A-Za-z0-9._-]{1,120}$/.test(value);
}

function isResearchRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

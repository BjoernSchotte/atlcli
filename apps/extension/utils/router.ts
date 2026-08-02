/**
 * Pure message router (functional core — spec 002 Task 3).
 *
 * `routeMessage` is a pure async function of (request, injected effects) ->
 * response. It contains ZERO references to `chrome.*` or any ambient global,
 * so it is exhaustively unit-testable. The imperative shell (background.ts)
 * wires the real effects (offscreen round-trip) into `RouterDeps` and adapts
 * the result onto `chrome.runtime.onMessage`.
 */
import type {
  DocxRuntimePreparationMessage,
  EntityDetection,
  ExtRequest,
  ExtResponse,
  PdfCompileHints,
  ResearchClarificationPlanningActionRequest,
  ResearchClarificationReviewActionRequest,
  ResearchPlanReviewActionRequest,
  ResearchPlanRevisionActionRequest,
  ResearchScopeClarificationPlanningActionRequest,
  ResearchScopeClarificationReviewActionRequest,
  ResearchScopePlanReviewActionRequest,
  ResearchScopeReviewActionRequest,
} from "./messages.js";
import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type {
  ResearchReport,
  ResearchRequestV1,
  ResearchOneShotPolicyV1,
} from "./research/contracts.js";
import type {
  ResearchResumableSessionV1,
  ResearchClarificationReviewResolutionV1,
  ResearchSessionClarificationReviewV1,
  ResearchScopeClarificationReviewResolutionV1,
  ResearchSessionScopeClarificationReviewV1,
  ResearchSessionPlanReviewV1,
  ResearchSessionScopeReviewV1,
  ResearchScopePreflightOptionsV1,
  ResearchScopePreflightOutcomeV1,
} from "@atlcli/research";
import { classifyResearchError } from "@atlcli/research";

/** Injected side effects the router needs to fulfil requests. */
export interface RouterDeps {
  /** Runs the WASM smoke computation (in practice: round-trip to offscreen). */
  runWasmSmoke: (a: number, b: number) => Promise<number>;
  /** Resolves the active tab's current entity (queries `chrome.tabs`). */
  getCurrentEntity: (windowId: number) => Promise<EntityDetection>;
  /**
   * Compiles a prepared PDF job through the offscreen worker. `hints` carries
   * the T5.3 scheduling metadata (`job` kind, estimated source `pages`); it is
   * advisory and every implementation must behave sanely when it is empty.
   */
  runPdfCompile: (
    jobId: string,
    hints?: PdfCompileHints
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Cancels a queued or active PDF job. */
  runPdfCancel: (jobId: string) => Promise<boolean>;
  /** Warms deterministic DOCX runtime assets in the productive offscreen realm. */
  prepareDocxRuntime?: (
    codeTheme?: CodeThemeId,
  ) => Promise<DocxRuntimePreparationMessage>;
  /** Wakes the common offscreen queue using opaque job ids only. */
  runJobsWake?: (
    jobIds?: string[],
    options?: { resumeWaiting?: boolean },
  ) => Promise<string | undefined>;
  runResearch?: (
    runId: string,
    sessionId: string,
    turnId: string,
    windowId: number,
    request: ResearchRequestV1,
    policy?: ResearchOneShotPolicyV1,
  ) => Promise<ResearchReport>;
  resumeResearch?: (
    runId: string,
    sessionId: string,
    windowId: number,
  ) => Promise<ResearchReport>;
  listResumableResearchSessions?: (
    windowId: number,
  ) => Promise<ResearchResumableSessionV1[]>;
  listResearchScopeReviews?: (
    windowId: number,
  ) => Promise<ResearchSessionScopeReviewV1[]>;
  approveResearchScopeReview?: (
    windowId: number,
    action: ResearchScopeReviewActionRequest,
  ) => Promise<ResearchSessionScopeReviewV1>;
  listResearchScopePlanReviews?: (
    windowId: number,
  ) => Promise<ResearchSessionScopeReviewV1[]>;
  approveResearchScopePlanReview?: (
    windowId: number,
    action: ResearchScopePlanReviewActionRequest,
  ) => Promise<ResearchSessionScopeReviewV1>;
  prepareResearchPlanReview?: (
    windowId: number,
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ) => Promise<ResearchSessionPlanReviewV1>;
  listResearchPlanReviews?: (
    windowId: number,
  ) => Promise<ResearchSessionPlanReviewV1[]>;
  approveResearchPlanReview?: (
    windowId: number,
    action: ResearchPlanReviewActionRequest,
  ) => Promise<ResearchResumableSessionV1>;
  rejectResearchPlanReview?: (
    windowId: number,
    action: ResearchPlanRevisionActionRequest,
  ) => Promise<ResearchSessionPlanReviewV1>;
  prepareResearchClarificationReview?: (
    windowId: number,
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ) => Promise<ResearchSessionClarificationReviewV1>;
  listResearchClarificationReviews?: (
    windowId: number,
  ) => Promise<ResearchSessionClarificationReviewV1[]>;
  resolveResearchClarificationReview?: (
    windowId: number,
    action: ResearchClarificationReviewActionRequest,
  ) => Promise<ResearchClarificationReviewResolutionV1>;
  continueResearchClarificationReview?: (
    windowId: number,
    action: ResearchClarificationPlanningActionRequest,
  ) => Promise<ResearchClarificationReviewResolutionV1>;
  prepareResearchScopeClarificationReview?: (
    windowId: number,
    request: ResearchRequestV1,
    policy: ResearchOneShotPolicyV1,
  ) => Promise<ResearchSessionScopeClarificationReviewV1>;
  listResearchScopeClarificationReviews?: (
    windowId: number,
  ) => Promise<ResearchSessionScopeClarificationReviewV1[]>;
  resolveResearchScopeClarificationReview?: (
    windowId: number,
    action: ResearchScopeClarificationReviewActionRequest,
  ) => Promise<ResearchScopeClarificationReviewResolutionV1>;
  continueResearchScopeClarificationReview?: (
    windowId: number,
    action: ResearchScopeClarificationPlanningActionRequest,
  ) => Promise<ResearchScopeClarificationReviewResolutionV1>;
  rejectResearchScopeReview?: (
    windowId: number,
    action: ResearchScopeReviewActionRequest,
  ) => Promise<ResearchSessionScopeReviewV1>;
  resolveResearchScope?: (
    windowId: number,
    request: ResearchRequestV1,
    options?: ResearchScopePreflightOptionsV1,
  ) => Promise<ResearchScopePreflightOutcomeV1>;
  cancelResearch?: (runId: string) => Promise<boolean>;
}

/**
 * Route one request to its response. Never throws: the `wasm-smoke` failure
 * path is captured and returned as an error response so the panel gets a
 * message instead of a hang (Task 5 failure path).
 */
export async function routeMessage(
  msg: ExtRequest,
  deps: RouterDeps
): Promise<ExtResponse> {
  switch (msg.kind) {
    case "ping":
      return { kind: "pong" };
    case "wasm-smoke": {
      try {
        const result = await deps.runWasmSmoke(msg.a, msg.b);
        return { kind: "wasm-smoke-result", ok: true, result };
      } catch (err) {
        return {
          kind: "wasm-smoke-result",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "get-current-entity": {
      const detection = await deps.getCurrentEntity(msg.windowId);
      return { kind: "current-entity", detection };
    }
    case "pdf:compile": {
      try {
        const result = await deps.runPdfCompile(msg.jobId, { job: msg.job, pages: msg.pages });
        return result.ok
          ? { kind: "pdf:compile-result", jobId: msg.jobId, ok: true }
          : { kind: "pdf:compile-result", jobId: msg.jobId, ok: false, error: result.error };
      } catch (error) {
        return {
          kind: "pdf:compile-result",
          jobId: msg.jobId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "pdf:cancel": {
      const cancelled = await deps.runPdfCancel(msg.jobId).catch(() => false);
      return { kind: "pdf:cancel-result", jobId: msg.jobId, cancelled };
    }
    case "docx:prepare-runtime": {
      if (!deps.prepareDocxRuntime) {
        return {
          kind: "docx:prepare-runtime-result",
          ok: false,
          error: "DOCX runtime preparation is not configured.",
        };
      }
      try {
        const preparation = await deps.prepareDocxRuntime(msg.codeTheme);
        return { kind: "docx:prepare-runtime-result", ok: true, preparation };
      } catch (error) {
        return {
          kind: "docx:prepare-runtime-result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "jobs:wake": {
      if (!deps.runJobsWake) {
        return { kind: "jobs:wake-result", error: "Common export queue is not configured." };
      }
      try {
        const claimedJobId = await deps.runJobsWake(msg.jobIds, {
          resumeWaiting: msg.resumeWaiting,
        });
        return { kind: "jobs:wake-result", ...(claimedJobId ? { claimedJobId } : {}) };
      } catch (error) {
        return {
          kind: "jobs:wake-result",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "research:run": {
      if (!deps.runResearch) {
        return {
          kind: "research:run-result",
          runId: msg.runId,
          ok: false,
          code: "provider-error",
          error: "Research is not configured.",
        };
      }
      try {
        const report = await deps.runResearch(
          msg.runId,
          msg.sessionId,
          msg.turnId,
          msg.windowId,
          msg.request,
          msg.policy,
        );
        return { kind: "research:run-result", runId: msg.runId, ok: true, report };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:run-result",
          runId: msg.runId,
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:resume": {
      if (!deps.resumeResearch) {
        return {
          kind: "research:resume-result",
          runId: msg.runId,
          ok: false,
          code: "provider-error",
          error: "Research resume is not configured.",
        };
      }
      try {
        const report = await deps.resumeResearch(msg.runId, msg.sessionId, msg.windowId);
        return { kind: "research:resume-result", runId: msg.runId, ok: true, report };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:resume-result",
          runId: msg.runId,
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-resumable-sessions": {
      if (!deps.listResumableResearchSessions) {
        return {
          kind: "research:list-resumable-sessions-result",
          ok: false,
          code: "provider-error",
          error: "Research session listing is not configured.",
        };
      }
      try {
        const sessions = await deps.listResumableResearchSessions(msg.windowId);
        return { kind: "research:list-resumable-sessions-result", ok: true, sessions };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-resumable-sessions-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-scope-reviews": {
      if (!deps.listResearchScopeReviews) {
        return {
          kind: "research:list-scope-reviews-result",
          ok: false,
          code: "provider-error",
          error: "Research scope review is not configured.",
        };
      }
      try {
        const reviews = await deps.listResearchScopeReviews(msg.windowId);
        return { kind: "research:list-scope-reviews-result", ok: true, reviews };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-scope-reviews-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-scope-plan-reviews": {
      if (!deps.listResearchScopePlanReviews) {
        return {
          kind: "research:list-scope-plan-reviews-result",
          ok: false,
          code: "provider-error",
          error: "Research scope-plan review is not configured.",
        };
      }
      try {
        const reviews = await deps.listResearchScopePlanReviews(msg.windowId);
        return { kind: "research:list-scope-plan-reviews-result", ok: true, reviews };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-scope-plan-reviews-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:approve-scope-review": {
      if (!deps.approveResearchScopeReview) {
        return {
          kind: "research:approve-scope-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope approval is not configured.",
        };
      }
      try {
        const review = await deps.approveResearchScopeReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          graphRevision: msg.graphRevision,
          proposalId: msg.proposalId,
        });
        return { kind: "research:approve-scope-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:approve-scope-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:reject-scope-review": {
      if (!deps.rejectResearchScopeReview) {
        return {
          kind: "research:reject-scope-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope rejection is not configured.",
        };
      }
      try {
        const review = await deps.rejectResearchScopeReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          graphRevision: msg.graphRevision,
          proposalId: msg.proposalId,
        });
        return { kind: "research:reject-scope-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:reject-scope-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:approve-scope-plan-review": {
      if (!deps.approveResearchScopePlanReview) {
        return {
          kind: "research:approve-scope-plan-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope-plan approval is not configured.",
        };
      }
      try {
        const review = await deps.approveResearchScopePlanReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          graphRevision: msg.graphRevision,
        });
        return { kind: "research:approve-scope-plan-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:approve-scope-plan-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:prepare-plan-review": {
      if (!deps.prepareResearchPlanReview) {
        return {
          kind: "research:prepare-plan-review-result",
          ok: false,
          code: "provider-error",
          error: "Research plan preparation is not configured.",
        };
      }
      try {
        const review = await deps.prepareResearchPlanReview(
          msg.windowId,
          msg.request,
          msg.policy,
        );
        return { kind: "research:prepare-plan-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:prepare-plan-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-plan-reviews": {
      if (!deps.listResearchPlanReviews) {
        return {
          kind: "research:list-plan-reviews-result",
          ok: false,
          code: "provider-error",
          error: "Research plan review is not configured.",
        };
      }
      try {
        const reviews = await deps.listResearchPlanReviews(msg.windowId);
        return { kind: "research:list-plan-reviews-result", ok: true, reviews };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-plan-reviews-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:approve-plan-review": {
      if (!deps.approveResearchPlanReview) {
        return {
          kind: "research:approve-plan-review-result",
          ok: false,
          code: "provider-error",
          error: "Research plan approval is not configured.",
        };
      }
      try {
        const session = await deps.approveResearchPlanReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          graphRevision: msg.graphRevision,
        });
        return { kind: "research:approve-plan-review-result", ok: true, session };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:approve-plan-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:reject-plan-review": {
      if (!deps.rejectResearchPlanReview) {
        return {
          kind: "research:reject-plan-review-result",
          ok: false,
          code: "provider-error",
          error: "Research plan revision is not configured.",
        };
      }
      try {
        const review = await deps.rejectResearchPlanReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          graphRevision: msg.graphRevision,
          instruction: msg.instruction,
        });
        return { kind: "research:reject-plan-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:reject-plan-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:prepare-clarification-review": {
      if (!deps.prepareResearchClarificationReview) {
        return {
          kind: "research:prepare-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research clarification preparation is not configured.",
        };
      }
      try {
        const review = await deps.prepareResearchClarificationReview(
          msg.windowId,
          msg.request,
          msg.policy,
        );
        return { kind: "research:prepare-clarification-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:prepare-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-clarification-reviews": {
      if (!deps.listResearchClarificationReviews) {
        return {
          kind: "research:list-clarification-reviews-result",
          ok: false,
          code: "provider-error",
          error: "Research clarification review is not configured.",
        };
      }
      try {
        const reviews = await deps.listResearchClarificationReviews(msg.windowId);
        return { kind: "research:list-clarification-reviews-result", ok: true, reviews };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-clarification-reviews-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:resolve-clarification-review": {
      if (!deps.resolveResearchClarificationReview) {
        return {
          kind: "research:resolve-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research clarification resolution is not configured.",
        };
      }
      try {
        const outcome = await deps.resolveResearchClarificationReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
          answers: msg.answers,
          assumptionDecisions: msg.assumptionDecisions,
        });
        return { kind: "research:resolve-clarification-review-result", ok: true, outcome };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:resolve-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:continue-clarification-review": {
      if (!deps.continueResearchClarificationReview) {
        return {
          kind: "research:continue-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research clarification recovery is not configured.",
        };
      }
      try {
        const outcome = await deps.continueResearchClarificationReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          briefRevision: msg.briefRevision,
        });
        return { kind: "research:continue-clarification-review-result", ok: true, outcome };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:continue-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:prepare-scope-clarification-review": {
      if (!deps.prepareResearchScopeClarificationReview) {
        return {
          kind: "research:prepare-scope-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope clarification preparation is not configured.",
        };
      }
      try {
        const review = await deps.prepareResearchScopeClarificationReview(
          msg.windowId,
          msg.request,
          msg.policy,
        );
        return { kind: "research:prepare-scope-clarification-review-result", ok: true, review };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:prepare-scope-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:list-scope-clarification-reviews": {
      if (!deps.listResearchScopeClarificationReviews) {
        return {
          kind: "research:list-scope-clarification-reviews-result",
          ok: false,
          code: "provider-error",
          error: "Research scope clarification review is not configured.",
        };
      }
      try {
        const reviews = await deps.listResearchScopeClarificationReviews(msg.windowId);
        return { kind: "research:list-scope-clarification-reviews-result", ok: true, reviews };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:list-scope-clarification-reviews-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:resolve-scope-clarification-review": {
      if (!deps.resolveResearchScopeClarificationReview) {
        return {
          kind: "research:resolve-scope-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope clarification resolution is not configured.",
        };
      }
      try {
        const outcome = await deps.resolveResearchScopeClarificationReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
          selection: msg.selection,
        });
        return { kind: "research:resolve-scope-clarification-review-result", ok: true, outcome };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:resolve-scope-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:continue-scope-clarification-review": {
      if (!deps.continueResearchScopeClarificationReview) {
        return {
          kind: "research:continue-scope-clarification-review-result",
          ok: false,
          code: "provider-error",
          error: "Research scope clarification recovery is not configured.",
        };
      }
      try {
        const outcome = await deps.continueResearchScopeClarificationReview(msg.windowId, {
          sessionId: msg.sessionId,
          revision: msg.revision,
        });
        return { kind: "research:continue-scope-clarification-review-result", ok: true, outcome };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:continue-scope-clarification-review-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:resolve-scope": {
      if (!deps.resolveResearchScope) {
        return {
          kind: "research:resolve-scope-result",
          ok: false,
          code: "provider-error",
          error: "Research scope resolution is not configured.",
        };
      }
      try {
        const outcome = await deps.resolveResearchScope(
          msg.windowId,
          msg.request,
          msg.options,
        );
        return { kind: "research:resolve-scope-result", ok: true, outcome };
      } catch (error) {
        const classified = classifyResearchError(error);
        return {
          kind: "research:resolve-scope-result",
          ok: false,
          code: classified.code,
          error: classified.message,
        };
      }
    }
    case "research:cancel": {
      const cancelled = await deps.cancelResearch?.(msg.runId).catch(() => false);
      return {
        kind: "research:cancel-result",
        runId: msg.runId,
        cancelled: cancelled ?? false,
      };
    }
    default: {
      // Exhaustiveness: adding a request kind without handling it fails typecheck.
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

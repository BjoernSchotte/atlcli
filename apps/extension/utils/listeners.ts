/**
 * `chrome.runtime.onMessage` adapters (imperative-shell glue — spec 002).
 *
 * These wrap the pure router / offscreen effects onto the listener contract. The
 * synchronous `true` return is LOAD-BEARING: MV3 keeps the message channel open
 * for an asynchronous `sendResponse` only when the listener returns `true`.
 * Returning `false` (or nothing) for a handled async request would drop the
 * reply. Extracting the bodies here makes that contract unit-testable — a
 * regression that removes the `true` now fails a test instead of silently
 * closing the channel.
 */
import {
  isExtRequest,
  isOffscreenRequest,
  type DocxRuntimePreparationMessage,
  type ExtResponse,
  type OffscreenResponse,
  type PdfCompileHints,
} from "./messages.js";
import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type {
  ChatQualityPolicyV1,
  ChatAnswerV1,
  ResearchReport,
  ResearchRequestV1,
  ResearchOneShotPolicyV1,
} from "./research/contracts.js";
import { routeMessage, type RouterDeps } from "./router.js";
import { ChatUserQuestionRequiredError, classifyResearchError } from "@atlcli/research";
import type {
  ChatHostIdentityV1,
  ChatInteractionControlV1,
  ChatInteractionStateV1,
  ChatUserQuestionAnswerV1,
} from "@atlcli/research";

/** Effects the offscreen listener depends on (injectable for tests). */
export interface OffscreenListenerDeps {
  runPdfCompile: (
    jobId: string,
    hints?: PdfCompileHints
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  runPdfCancel: (jobId: string) => Promise<boolean>;
  prepareDocxRuntime?: (
    codeTheme?: CodeThemeId,
  ) => Promise<DocxRuntimePreparationMessage>;
  runJobsWake?: (
    jobIds?: string[],
    options?: { resumeWaiting?: boolean },
  ) => Promise<string | undefined>;
  runResearch?: (
    runId: string,
    sessionId: string,
    turnId: string,
    apiKey: string,
    mode: "chat" | "research",
    request: ResearchRequestV1,
    policy?: ResearchOneShotPolicyV1,
    qualityPolicy?: ChatQualityPolicyV1,
    hostIdentity?: ChatHostIdentityV1,
    resumeAnswer?: ChatUserQuestionAnswerV1,
    resumeCheckpoint?: {
      kind: "stream-interruption" | "steering";
    },
  ) => Promise<ResearchReport | ChatAnswerV1>;
  resumeResearch?: (
    runId: string,
    sessionId: string,
    turnId: string,
    apiKey: string,
  ) => Promise<ResearchReport>;
  pauseResearch?: (runId: string) => Promise<boolean>;
  cancelResearch?: (runId: string) => Promise<boolean>;
  controlChat?: (
    runId: string,
    controlId: string,
    control: ChatInteractionControlV1,
  ) => Promise<ChatInteractionStateV1>;
}

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Background service-worker adapter: route panel-facing requests and answer via
 * `sendResponse`. Returns `true` (keep the channel open) for a handled request,
 * `false` for anything else (e.g. offscreen replies) so the SW doesn't hold the
 * channel open for messages it won't answer.
 */
export function handleExtMessage(
  message: unknown,
  sendResponse: (response: ExtResponse) => void,
  deps: RouterDeps
): boolean {
  if (!isExtRequest(message)) return false;

  // The router turns an effect failure into that request's own error result
  // wherever the protocol has one. What can still reject (the entity lookup
  // has no error variant) is answered rather than left hanging: every caller
  // already treats an unexpected `kind` as "no result".
  routeMessage(message, deps)
    .then((response) => sendResponse(response))
    .catch((err) => sendResponse({ kind: "request-failed", error: toMessage(err) }));

  return true;
}

/**
 * Offscreen-document adapter: run the requested effect and answer via
 * `sendResponse`. Returns `true` for a handled request, `false` otherwise.
 */
export function handleOffscreenMessage(
  message: unknown,
  sendResponse: (response: OffscreenResponse) => void,
  deps: OffscreenListenerDeps = {
    runPdfCompile: async () => ({ ok: false, error: "PDF compiler host is not configured." }),
    runPdfCancel: async () => false,
    prepareDocxRuntime: async () => {
      throw new Error("DOCX runtime preparation is not configured.");
    },
    runJobsWake: async () => undefined,
  }
): boolean {
  if (!isOffscreenRequest(message)) return false;

  switch (message.kind) {
    case "offscreen:pdf-compile":
      deps.runPdfCompile(message.jobId, { job: message.job, pages: message.pages })
        .then((result) => sendResponse(result.ok
          ? { kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: true }
          : { kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: false, error: result.error }))
        .catch((err) => sendResponse({ kind: "offscreen:pdf-compile-result", jobId: message.jobId, ok: false, error: toMessage(err) }));
      break;
    case "offscreen:pdf-cancel":
      deps.runPdfCancel(message.jobId)
        .then((cancelled) => sendResponse({ kind: "offscreen:pdf-cancel-result", jobId: message.jobId, cancelled }))
        .catch(() => sendResponse({ kind: "offscreen:pdf-cancel-result", jobId: message.jobId, cancelled: false }));
      break;
    case "offscreen:docx-prepare-runtime":
      (deps.prepareDocxRuntime
        ? deps.prepareDocxRuntime(message.codeTheme)
        : Promise.reject(new Error("DOCX runtime preparation is not configured.")))
        .then((preparation) => sendResponse({
          kind: "offscreen:docx-prepare-runtime-result",
          ok: true,
          preparation,
        }))
        .catch((error) => sendResponse({
          kind: "offscreen:docx-prepare-runtime-result",
          ok: false,
          error: toMessage(error),
        }));
      break;
    case "offscreen:jobs-wake":
      (deps.runJobsWake?.(message.jobIds, {
        resumeWaiting: message.resumeWaiting,
      }) ?? Promise.resolve(undefined))
        .then((claimedJobId) => sendResponse({
          kind: "offscreen:jobs-wake-result",
          ...(claimedJobId ? { claimedJobId } : {}),
        }))
        .catch((error) => sendResponse({
          kind: "offscreen:jobs-wake-result",
          error: toMessage(error),
        }));
      break;
    case "offscreen:research-run":
      (deps.runResearch
        ? deps.runResearch(
          message.runId,
          message.sessionId,
          message.turnId,
          message.apiKey,
          message.mode,
          message.request,
          message.policy,
          message.qualityPolicy,
          message.hostIdentity,
          message.resumeAnswer,
          message.resumeCheckpoint,
        )
        : Promise.reject(new Error("Research worker host is not configured.")))
        .then((report) => sendResponse({
          kind: "offscreen:research-run-result",
          runId: message.runId,
          ok: true,
          report,
        }))
        .catch((error) => {
          const classified = classifyResearchError(error);
          sendResponse({
            kind: "offscreen:research-run-result",
            runId: message.runId,
            ok: false,
            code: classified.code,
            error: classified.message,
            ...(error instanceof ChatUserQuestionRequiredError
              ? { question: error.question }
              : {}),
          });
        });
      break;
    case "offscreen:research-resume":
      (deps.resumeResearch
        ? deps.resumeResearch(
          message.runId,
          message.sessionId,
          message.turnId,
          message.apiKey,
        )
        : Promise.reject(new Error("Research worker resume is not configured.")))
        .then((report) => sendResponse({
          kind: "offscreen:research-resume-result",
          runId: message.runId,
          ok: true,
          report,
        }))
        .catch((error) => {
          const classified = classifyResearchError(error);
          sendResponse({
            kind: "offscreen:research-resume-result",
            runId: message.runId,
            ok: false,
            code: classified.code,
            error: classified.message,
          });
        });
      break;
    case "offscreen:research-cancel":
      (deps.cancelResearch?.(message.runId) ?? Promise.resolve(false))
        .then((cancelled) => sendResponse({
          kind: "offscreen:research-cancel-result",
          runId: message.runId,
          cancelled,
        }))
        .catch(() => sendResponse({
          kind: "offscreen:research-cancel-result",
          runId: message.runId,
          cancelled: false,
        }));
      break;
    case "offscreen:research-chat-control":
      (deps.controlChat
        ? deps.controlChat(message.runId, message.controlId, message.control)
        : Promise.reject(new Error("Chat interaction control is not configured.")))
        .then((state) => sendResponse({
          kind: "offscreen:research-chat-control-result",
          runId: message.runId,
          controlId: message.controlId,
          ok: true,
          state,
        }))
        .catch((error) => {
          const classified = classifyResearchError(error);
          sendResponse({
            kind: "offscreen:research-chat-control-result",
            runId: message.runId,
            controlId: message.controlId,
            ok: false,
            code: classified.code,
            error: classified.message,
          });
        });
      break;
    case "offscreen:research-pause":
      (deps.pauseResearch?.(message.runId) ?? Promise.resolve(false))
        .then((paused) => sendResponse({
          kind: "offscreen:research-pause-result",
          runId: message.runId,
          paused,
        }))
        .catch(() => sendResponse({
          kind: "offscreen:research-pause-result",
          runId: message.runId,
          paused: false,
        }));
      break;
  }

  return true;
}

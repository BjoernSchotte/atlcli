/**
 * Service worker (imperative shell — spec 002 Task 3/4/5).
 *
 * Owns three responsibilities and nothing else; all decision logic lives in the
 * pure `routeMessage` core and the injectable `ensureOffscreen` helper:
 *   1. open the side panel on the toolbar action click,
 *   2. route panel requests (`ping`, `wasm-smoke`) via the pure router,
 *   3. manage the offscreen document lifecycle for the WASM round-trip.
 */
import { defineBackground } from "wxt/utils/define-background";
// Import from @atlcli/core's BROWSER entry. Presence in the bundle proves Vite
// resolves the `browser` export condition (PLAN §6 risk 4); the Task 6 output
// scan then proves this pulls in zero node:/bun: specifiers.
import { extractEntityFromUrl } from "@atlcli/core";
import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import {
  ChatUserQuestionRequiredError,
  type ChatHostIdentityV1,
  type ChatInteractionCommandV1,
  type ChatInteractionStateV1,
  type ChatUserQuestionAnswerV1,
} from "@atlcli/research";
import {
  type EntityChanged,
  type EntityDetection,
  type OffscreenResponse,
  type PdfCompileHints,
  type ResearchClarificationPlanningActionRequest,
  type ResearchClarificationReviewActionRequest,
  type ResearchScopeClarificationPlanningActionRequest,
  type ResearchScopeClarificationReviewActionRequest,
  type ResearchScopePlanReviewActionRequest,
  type ResearchPlanReviewActionRequest,
  type ResearchPlanRevisionActionRequest,
  type ResearchScopeReviewActionRequest,
  type ResearchSessionSteeringActionRequest,
  type ResearchSessionDeletionActionRequest,
  isExportJobsChanged,
} from "../utils/messages.js";
import type {
  ChatQualityPolicyV1,
  ResearchOneShotPolicyV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import {
  ResearchContractError,
  normalizeResearchOneShotPolicyV1,
  normalizeChatQualityPolicyV1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import {
  chromeBrowserCredentialStorageV1,
  readBrowserApiKeyV1,
} from "../utils/research/browser-credential-storage.js";
import { normalizeAnthropicApiKey } from "../utils/research/credential.js";
import { profileFromTabUrl } from "../utils/profile.js";
import {
  ResearchScopeCatalogBroker,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  approveResearchScopeExpansionV1,
  composeResearchGraphV1,
  appendResearchSessionTurnV1,
  createResearchSessionV1,
  createResearchScopeBindingV1,
  createStandardResearchBriefV1,
  createRestScopeCatalogProviders,
  IndexedDbResearchSessionStoreV1,
  continueResearchSessionClarificationPlanningV1,
  continueResearchSessionScopeClarificationV1,
  initializeResearchSessionTurnV1,
  initializeResearchSessionClarificationWaitV1,
  initializeResearchSessionScopeClarificationWaitV1,
  prepareResearchBriefPreflightV1,
  prepareResearchScopePreflightV1,
  projectResearchSessionScopeReviewV1,
  projectResearchSessionClarificationReviewV1,
  projectResearchSessionScopeClarificationReviewV1,
  projectResearchSessionPlanReviewV1,
  projectResearchRetainedSessionV1,
  projectResearchResumableSessionV1,
  proposeResearchGraphForReadyBriefV1,
  recoverResearchSessionForResumeV1,
  resolveResearchSessionClarificationsV1,
  resolveResearchSessionScopeClarificationV1,
  resolveChatScopeClarificationV1,
  refreshResearchSessionScopeClarificationV1,
  researchRequestFromBriefV1,
  researchPolicyFromBriefV1,
  type ResearchSessionV1,
  type ResearchScopePreflightOptionsV1,
  WorkspaceChatInteractionControllerV1,
  applyChatInteractionControlV1,
  assertChatSessionBindingV1,
  assertChatInteractionBindingV1,
  CHAT_SESSION_PATH_V1,
  CHAT_INTERACTION_STATE_PATH_V1,
  parseChatSessionV1,
  parseChatInteractionStateV1,
  stampChatInteractionCommandV1,
} from "@atlcli/research/browser";
import { handleExtMessage } from "../utils/listeners.js";
import { closeOffscreen, ensureOffscreen } from "../utils/offscreen.js";
import { createIdleTimer } from "../utils/idle-timer.js";
import { createOffscreenActivityTracker } from "../utils/pdf/offscreen-activity.js";
import { createDurableIdleGate } from "../utils/jobs/idle-gate.js";
import {
  APP_SETTINGS_STORAGE_KEY,
  normalizeSettings,
} from "../utils/ports/settings.js";
import { LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1 } from "../utils/local-model/storage.js";
import { resolveBrowserChatModelRunBindingV1 } from "../utils/local-model/run-binding.js";
import { recoverUnownedRunningChatTurnV1 } from "../utils/research/chat-recovery.js";
import {
  browserChatActiveConversationStorageKeyV1,
  browserChatProviderCacheIdentityV1,
} from "../utils/local-model/selection.js";
import {
  countInFlightPdfJobs,
  listPdfJobMeta,
  sweepPdfJobs,
} from "../utils/pdf/job-store.js";
import { IndexedDbExportJobCatalog } from "../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../utils/export-jobs/chunk-store.js";
import { listExtensionExportActivity } from "../utils/export-jobs/activity.js";
import { sweepExtensionExportJobRetention } from "../utils/export-jobs/retention.js";
import {
  EXTENSION_EXPORT_BADGE_PULSE_ENABLED_KEY,
  EXTENSION_EXPORT_BADGE_PULSE_FRAME_MS,
  EXTENSION_EXPORT_BADGE_STATE_KEY,
  exportBadgeColor,
  exportBadgePulseFrames,
  parseExtensionExportBadgeState,
  planExtensionExportBadge,
} from "../utils/export-jobs/badge.js";
import { createObserverSession } from "../utils/observer-session.js";
import {
  currentDetection,
  initialObserverState,
  isObserverState,
  observeTab,
  type ObserverState,
} from "../utils/tab-observer.js";

/**
 * Idle-close policy (PLAN §2.3): after 5 minutes with no offscreen request,
 * close the offscreen document; the next request re-creates it via
 * `ensureOffscreen`. Best-effort — the SW may be torn down first, and the
 * offscreen document dies with the extension process anyway.
 */
const OFFSCREEN_IDLE_MS = 5 * 60 * 1000;
const TAB_OBSERVER_STORAGE_KEY = "tab-observer-state-v1";
const CHAT_HOST_PRINCIPAL_KEY = "atlcli.chat.host-principal-id.v1";
const CHAT_HOST_PRINCIPAL_PATTERN = /^browser-principal:[0-9a-f-]{36}$/u;
const CHAT_CONVERSATION_ID_PATTERN = /^research-session:[A-Za-z0-9._-]{1,120}$/u;
const commonExportCatalog = new IndexedDbExportJobCatalog();
const commonExportBytes = new IndexedDbExportByteStore();

async function countInFlightExportJobs(): Promise<number> {
  const [legacy, common] = await Promise.all([
    countInFlightPdfJobs(),
    commonExportCatalog.list({
      states: ["running", "cancelling"],
      limit: 1,
    }),
  ]);
  return legacy + common.length;
}

const offscreenIdle = createIdleTimer({
  delayMs: OFFSCREEN_IDLE_MS,
  onIdle: () => {
    // Re-check at the destructive boundary too. The offscreen queue may have
    // auto-claimed its next durable job without another service-worker message.
    void countInFlightExportJobs()
      .then((inFlight) => {
        if (inFlight > 0) {
          offscreenIdle.reset();
          return;
        }
        return closeOffscreen();
      })
      .catch((err) => console.error("closeOffscreen (idle) failed", err));
  },
});

/**
 * Idle-close policy for the offscreen document (spec 010 T5.3/T5.6).
 *
 * **Preview compiles are offscreen activity like any other**, which is what
 * lets the warm compiler survive a debounce pause: previews arrive as ordinary
 * `pdf:compile` requests, so they go through {@link runPdfCompile} and stop the
 * idle timer exactly the way an export does. The tracker also guarantees the
 * other half — once the last job finishes the timer is re-armed, so a panel
 * that goes quiet still closes the document and releases the ≥ 20 MB wasm
 * artifact.
 *
 * T5.6 closes Architecture point 3(b): the tracker's counter is in-memory and
 * resets to zero when the service worker restarts, so after a restart a *second*
 * job's completion would arm the timer under a first job that is still
 * compiling — and five minutes later close the document out from under it. The
 * counter still decides "did this worker's own traffic stop"; whether the timer
 * may actually be armed is decided by {@link createDurableIdleGate} from the
 * durable job records, which survived the restart. Both former call sites
 * (`runWasmSmoke`'s `touch()`, `runPdfCompile`'s `end()`) funnel through the
 * gate's `reset()`, so neither can arm the timer under a running compile.
 */
const durableIdle = createDurableIdleGate({
  timer: offscreenIdle,
  countInFlight: countInFlightExportJobs,
  onError: (error) => console.error("in-flight job lookup failed", error),
});
const offscreenActivity = createOffscreenActivityTracker(durableIdle);

/**
 * Toolbar badge is a projection of durable common + migration snapshots.
 * Storage is written before animation, so a service-worker restart cannot
 * replay the same terminal transition. Opening Activity never clears it.
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function renderStaticBadge(
  text: string,
  color: string,
): Promise<void> {
  await Promise.all([
    Promise.resolve(chrome.action?.setBadgeText?.({ text })),
    Promise.resolve(
      chrome.action?.setBadgeBackgroundColor?.({ color }),
    ),
  ]);
}

async function updateExportBadge(): Promise<void> {
  const rows = await listExtensionExportActivity({
    listCommon: commonExportCatalog.list.bind(commonExportCatalog),
    listLegacyPdf: () => listPdfJobMeta(),
    listLegacyBridges:
      commonExportCatalog.listLegacyBridges.bind(commonExportCatalog),
  });
  const stored = await chrome.storage.local.get([
    EXTENSION_EXPORT_BADGE_STATE_KEY,
    EXTENSION_EXPORT_BADGE_PULSE_ENABLED_KEY,
  ]);
  const state = parseExtensionExportBadgeState(
    stored[EXTENSION_EXPORT_BADGE_STATE_KEY],
  );
  const pulseEnabled =
    stored[EXTENSION_EXPORT_BADGE_PULSE_ENABLED_KEY] !== false;
  const plan = planExtensionExportBadge(rows, state, pulseEnabled);
  let pulseDurable = false;
  try {
    await chrome.storage.local.set({
      [EXTENSION_EXPORT_BADGE_STATE_KEY]: plan.nextState,
    });
    pulseDurable = true;
  } catch (error) {
    console.debug("[atlcli] badge pulse checkpoint skipped", error);
  }
  await renderStaticBadge(
    plan.projection.text,
    exportBadgeColor(plan.projection.kind),
  );
  if (!plan.pulse || !pulseDurable) return;
  for (const color of exportBadgePulseFrames(plan.pulse, plan.projection)) {
    await Promise.resolve(
      chrome.action?.setBadgeBackgroundColor?.({ color }),
    );
    await delay(EXTENSION_EXPORT_BADGE_PULSE_FRAME_MS);
  }
}

let badgeRefreshTail: Promise<void> = Promise.resolve();
function refreshExportBadge(): void {
  badgeRefreshTail = badgeRefreshTail
    .catch(() => undefined)
    .then(updateExportBadge);
  void badgeRefreshTail.catch((error) =>
    console.debug("[atlcli] badge update skipped", error)
  );
}

/**
 * The watchdog + retention pass, run from the worker (which outlives the panel).
 *
 * Not `chrome.alarms` — that is a permission this folder does not have. Instead
 * it runs on worker start-up and, throttled, whenever the panel talks to the
 * worker: both are moments where being wrong about a stuck record is about to
 * become visible.
 */
const SWEEP_THROTTLE_MS = 60_000;
let lastSweep = 0;
function sweepJobs(force = false): void {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_THROTTLE_MS) return;
  lastSweep = now;
  void sweepPdfJobs().catch((error) => console.error("PDF job sweep failed", error));
  void sweepExtensionExportJobRetention({
    catalog: commonExportCatalog,
    bytes: commonExportBytes,
  }).catch((error) => console.error("Export job retention sweep failed", error));
}

async function restoreCommonExportQueueAfterHostStart(): Promise<void> {
  const candidates = await commonExportCatalog.list({
    states: ["queued", "running", "cancelling", "waiting"],
    limit: 1_000,
  });
  const hasRecoverableWork = candidates.some(
    (job) =>
      job.state !== "waiting" ||
      job.waiting?.until !== undefined,
  );
  if (hasRecoverableWork) await ensureOffscreen();
}

/**
 * Effect wired into the pure router: ensure the offscreen document exists,
 * then round-trip the WASM computation through it. Rejects on failure so the
 * router turns it into an error response. Each call (re)arms the idle-close
 * timer so the document is closed once traffic stops.
 */
async function runWasmSmoke(a: number, b: number): Promise<number> {
  offscreenActivity.touch();
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({
    kind: "offscreen:wasm-add",
    a,
    b,
  })) as OffscreenResponse | undefined;

  if (!res || res.kind !== "offscreen:wasm-add-result") {
    throw new Error("offscreen document returned no result");
  }
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function runPdfCompile(
  jobId: string,
  hints?: PdfCompileHints
): Promise<{ ok: true } | { ok: false; error: string }> {
  offscreenActivity.begin();
  try {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:pdf-compile",
      jobId,
      // Forwarded verbatim: the SW makes no scheduling decision of its own, it
      // just carries the panel's `job`/`pages` scalars to the offscreen queue.
      job: hints?.job,
      pages: hints?.pages,
    })) as OffscreenResponse | undefined;
    if (!response || response.kind !== "offscreen:pdf-compile-result" || response.jobId !== jobId) {
      return { ok: false, error: "Offscreen PDF compiler returned no correlated result." };
    }
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  } finally {
    offscreenActivity.end();
    if (hints?.job !== "preview") refreshExportBadge();
  }
}

async function runPdfCancel(jobId: string): Promise<boolean> {
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    kind: "offscreen:pdf-cancel",
    jobId,
  })) as OffscreenResponse | undefined;
  return Boolean(
    response &&
      response.kind === "offscreen:pdf-cancel-result" &&
      response.jobId === jobId &&
      response.cancelled
  );
}

async function prepareDocxRuntime(codeTheme?: CodeThemeId) {
  offscreenActivity.touch();
  await ensureOffscreen();
  const response = (await chrome.runtime.sendMessage({
    kind: "offscreen:docx-prepare-runtime",
    ...(codeTheme ? { codeTheme } : {}),
  })) as OffscreenResponse | undefined;
  if (!response || response.kind !== "offscreen:docx-prepare-runtime-result") {
    throw new Error("Offscreen DOCX runtime returned no preparation result.");
  }
  if (!response.ok) throw new Error(response.error);
  return response.preparation;
}

async function runJobsWake(
  jobIds?: string[],
  options?: { resumeWaiting?: boolean },
): Promise<string | undefined> {
  // Unlike the legacy compile call, the queue response returns immediately
  // after claim. Durable state, rather than the tracker's in-memory counter,
  // owns the remainder of the execution lifetime.
  durableIdle.stop();
  let claimed = false;
  try {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:jobs-wake",
      ...(jobIds ? { jobIds } : {}),
      ...(options?.resumeWaiting ? { resumeWaiting: true } : {}),
    })) as OffscreenResponse | undefined;
    if (!response || response.kind !== "offscreen:jobs-wake-result") {
      throw new Error("Offscreen export queue returned no result.");
    }
    if (response.error !== undefined) throw new Error(response.error);
    claimed = response.claimedJobId !== undefined;
    // Refresh only after the offscreen catalog open/claim has settled. Starting
    // a second version upgrade in parallel can queue behind a deliberately
    // blocked open without receiving its own `onblocked` event.
    refreshExportBadge();
    return response.claimedJobId;
  } finally {
    if (claimed) {
      // The durable gate sees the claimed common row and keeps checking until
      // the offscreen runner has drained its auto-pumped queue.
      durableIdle.reset();
    } else {
      // Do not start another catalog upgrade after a blocked queue-open already
      // failed. The destructive idle callback performs its own durable recheck.
      offscreenIdle.reset();
    }
  }
}

/**
 * Push an `entity-changed` message to the panel (fire-and-forget). The panel may
 * be closed — `sendMessage` then rejects with "no receiving end"; swallow it.
 */
function pushEntityChanged(message: EntityChanged): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* panel not open — nothing to receive; ignore */
  });
}

export default defineBackground({
  // Emit `"background": { "type": "module", ... }` in the manifest (PLAN §2.3).
  type: "module",
  main() {
  // Retain the @atlcli/core import (spec 003 uses it for page detection);
  // logging keeps it from being tree-shaken away, proving browser resolution.
  console.debug("[atlcli] @atlcli/core browser entry loaded:", typeof extractEntityFromUrl);

  // Toolbar action opens the side panel (Task 4 AC).
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed", err));

  // ---- Tab observation (Task 1) --------------------------------------------
  // The SW is the canonical observer (PLAN §2.1), but MV3 workers are
  // disposable. Keep the ordering cursor in storage.session so a worker wakeup
  // cannot restart `seq` at 1 while a still-open panel retains a higher
  // `lastSeq`. The session also serializes pulls and pushes, including the tab
  // query itself, so a slow pull cannot be stamped newer than a tab-switch push.
  const observerSession = createObserverSession<ObserverState>(chrome.storage.session, {
    key: TAB_OBSERVER_STORAGE_KEY,
    initialState: initialObserverState,
    isState: isObserverState,
  });

  /**
   * This extension's own origin, so the observer can tell "the user navigated
   * away" from "we opened our own large-preview tab". Resolved once here rather
   * than inside the pure core, which must not know about `chrome`.
   */
  const ownOrigin = chrome.runtime.getURL("/");

  const feed = async (
    windowId: number,
    url: string | undefined | null
  ): Promise<void> => {
    const message = await observerSession.mutate((observer) => {
      const result = observeTab(observer, windowId, url, ownOrigin);
      return { state: result.state, value: result.message };
    });
    if (message) pushEntityChanged(message);
  };

  /**
   * Resolve the active tab's entity for a `get-current-entity` request (panel
   * mount). Feeds the active tab's URL through the shared observer so the pull
   * response carries an ordering `seq` comparable to the pushes — a late pull
   * for tab A can then be dropped by the panel once a newer push for tab B has
   * been applied (Task 1 AC, no lost-update race).
   */
  const getCurrentEntity = (windowId: number): Promise<EntityDetection> =>
    observerSession.mutate(async (observer) => {
      let url: string | undefined;
      try {
        const tabs = await chrome.tabs.query({ active: true, windowId });
        url = tabs[0]?.url;
      } catch {
        // The panel's window may have closed while its request was in flight.
        // Never fall back to a tab from another window.
        url = undefined;
      }
      const result = currentDetection(observer, windowId, url, ownOrigin);
      return { state: result.state, value: result.detection };
    });

  /**
   * Ephemeral routing only: the durable store remains authoritative. Keeping
   * this map in the service worker lets an explicit UI cancellation identify
   * its own session without accepting a caller-provided session ID.
   */
  const activeResearchRuns = new Map<string, {
    sessionId: string;
    mode: "chat" | "research";
  }>();

  /**
   * A resumed durable session must have exactly one owner in a live service
   * worker. The IndexedDB revision/lease fence remains the cross-restart
   * authority, but reserving before the first await prevents two same-worker
   * resume messages from both reaching the worker host and turns the loser
   * into a deterministic caller error rather than an incidental provider
   * failure.
   */
  const pendingResearchResumes = new Map<string, string>();

  const runResearch = async (
    runId: string,
    sessionId: string,
    turnId: string,
    windowId: number,
    mode: "chat" | "research",
    value: ResearchRequestV1,
    policyValue?: ResearchOneShotPolicyV1,
    qualityPolicyValue?: ChatQualityPolicyV1,
    hostIdentity?: ChatHostIdentityV1,
    resumeAnswer?: ChatUserQuestionAnswerV1,
    resumeCheckpoint?: {
      kind: "stream-interruption" | "steering";
    },
  ) => {
    const request = normalizeResearchRequestV1(value);
    const policy = normalizeResearchOneShotPolicyV1(policyValue);
    const qualityPolicy = mode === "chat" && qualityPolicyValue
      ? normalizeChatQualityPolicyV1(qualityPolicyValue)
      : undefined;
    const detection = await getCurrentEntity(windowId);
    const profile = detection.url ? profileFromTabUrl(detection.url) : null;
    if (!profile || new URL(profile.baseUrl).origin !== request.scope.siteOrigin) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab no longer matches the research site."
      );
    }
    const storedSettings = await chrome.storage.local.get(APP_SETTINGS_STORAGE_KEY);
    const modelSelection = normalizeSettings(
      storedSettings[APP_SETTINGS_STORAGE_KEY],
    ).modelSelection;
    const modelRunBinding = await resolveBrowserChatModelRunBindingV1({
      selection: modelSelection,
      mode,
      readAnthropicApiKey: () =>
        readBrowserApiKeyV1(chromeBrowserCredentialStorageV1()),
      readLocalActivation: async () => {
        const storedActivation = await chrome.storage.local.get(
          LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1,
        );
        return storedActivation[LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1];
      },
    });
    let effectiveHostIdentity = hostIdentity;
    if (mode === "chat") {
      const storedPrincipal = await chrome.storage.local.get(CHAT_HOST_PRINCIPAL_KEY);
      const userId = storedPrincipal[CHAT_HOST_PRINCIPAL_KEY];
      if (!hostIdentity || typeof userId !== "string" ||
          !CHAT_HOST_PRINCIPAL_PATTERN.test(userId) || hostIdentity.userId !== userId) {
        throw new ResearchContractError(
          "access-denied",
          "The browser Chat principal does not own this model run.",
        );
      }
      effectiveHostIdentity = {
        userId,
        providerCacheIdentity: browserChatProviderCacheIdentityV1(modelSelection, userId),
      };
    }
    if (activeResearchRuns.has(runId)) {
      throw new ResearchContractError("invalid-request", "Research run id is already active.");
    }
    if (mode === "chat" && effectiveHostIdentity) {
      if ([...activeResearchRuns.values()].some((active) =>
        active.mode === "chat" && active.sessionId === sessionId
      )) {
        throw new ResearchContractError(
          "invalid-request",
          "This retained Chat conversation is already active.",
        );
      }
      const store = await IndexedDbResearchSessionStoreV1.open();
      try {
        if (await store.read(sessionId)) {
          const workspace = await store.workspace(sessionId);
          const serialized = await workspace.readFile(CHAT_SESSION_PATH_V1);
          if (serialized !== undefined) {
            const retained = parseChatSessionV1(JSON.parse(serialized));
            assertChatSessionBindingV1({
              session: retained,
              conversationId: sessionId,
              identity: effectiveHostIdentity,
              tenantOrigin: request.scope.siteOrigin,
            });
            const recovered = recoverUnownedRunningChatTurnV1({
              session: retained,
              at: new Date().toISOString(),
            });
            if (recovered !== retained) {
              await workspace.writeFile(CHAT_SESSION_PATH_V1, JSON.stringify(recovered));
            }
          }
        }
      } finally {
        store.close();
      }
    }
    activeResearchRuns.set(runId, { sessionId, mode });
    offscreenActivity.begin();
    try {
      await ensureOffscreen();
      const response = (await chrome.runtime.sendMessage({
        kind: "offscreen:research-run",
        runId,
        sessionId,
        turnId,
        apiKey: modelRunBinding.apiKey,
        modelProvider: modelRunBinding.modelProvider,
        mode,
        request,
        policy,
        ...(effectiveHostIdentity ? { hostIdentity: effectiveHostIdentity } : {}),
        ...(qualityPolicy ? { qualityPolicy } : {}),
        ...(resumeAnswer ? { resumeAnswer } : {}),
        ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
      })) as OffscreenResponse | undefined;
      if (
        !response ||
        response.kind !== "offscreen:research-run-result" ||
        response.runId !== runId
      ) {
        throw new ResearchContractError(
          "provider-error",
          "The research worker host returned no correlated result."
        );
      }
      if (!response.ok) {
        if (response.question) {
          throw new ChatUserQuestionRequiredError(response.question);
        }
        throw new ResearchContractError(response.code, response.error);
      }
      return response.report;
    } finally {
      offscreenActivity.end();
      activeResearchRuns.delete(runId);
    }
  };

  const resumeResearch = async (
    runId: string,
    sessionId: string,
    windowId: number,
  ) => {
    if (activeResearchRuns.has(runId)) {
      throw new ResearchContractError("invalid-request", "Research run id is already active.");
    }
    if ([...activeResearchRuns.values()].some((active) => active.sessionId === sessionId)) {
      throw new ResearchContractError(
        "invalid-request",
        "This durable research session is already active.",
      );
    }
    if (pendingResearchResumes.has(sessionId)) {
      throw new ResearchContractError(
        "invalid-request",
        "A resume attempt for this durable research session is already in progress.",
      );
    }
    pendingResearchResumes.set(sessionId, runId);

    let store: IndexedDbResearchSessionStoreV1 | undefined;
    try {
      store = await IndexedDbResearchSessionStoreV1.open();
      const stored = await store.read(sessionId);
      if (!stored) {
        throw new ResearchContractError(
          "invalid-request",
          "Only a released durable research turn can be resumed by the browser.",
        );
      }
      const detection = await getCurrentEntity(windowId);
      const profile = detection.url ? profileFromTabUrl(detection.url) : null;
      if (!profile) {
        throw new ResearchContractError(
          "access-denied",
          "The active Atlassian tab no longer matches the research site.",
        );
      }
      const now = new Date().toISOString();
      const resumable = projectResearchResumableSessionV1(stored, {
        tenantOrigin: new URL(profile.baseUrl).origin,
        at: now,
      });
      if (!resumable) {
        throw new ResearchContractError(
          "invalid-request",
          "The durable browser session is not at a safe resume checkpoint for this Atlassian site.",
        );
      }
      const turn = stored.turns.find((candidate) => candidate.id === resumable.turnId);
      if (!turn?.brief) {
        throw new ResearchContractError(
          "invalid-request",
          "The durable browser session is missing its accepted brief.",
        );
      }
      const request = researchRequestFromBriefV1(turn.brief);
      let apiKey: string;
      try {
        apiKey = normalizeAnthropicApiKey(
          await readBrowserApiKeyV1(chromeBrowserCredentialStorageV1()),
        );
      } catch (error) {
        // A browser restart clears a session-only credential. Once the old
        // lease is released, record that durable wait rather than leaving the
        // session looking actively runnable without its required input. A
        // device-remembered credential is rehydrated before this boundary.
        if (stored.status === "running" && Date.parse(now) >= Date.parse(stored.lease.expiresAt)) {
          await store.commit(stored.sessionId, {
            kind: "wait_authentication",
            expectedRevision: stored.revision,
            expectedLeaseEpoch: stored.lease.epoch,
            at: now,
          });
        }
        throw error;
      }
      const resumed = await recoverResearchSessionForResumeV1({
        store,
        sessionId: stored.sessionId,
        ownerId: `owner:browser-${runId}`,
        leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        at: now,
      });
      const resumedTurn = resumed.activeTurnId
        ? resumed.turns.find((candidate) => candidate.id === resumed.activeTurnId)
        : undefined;
      if (!resumedTurn?.brief || !resumedTurn.graph || resumedTurn.id !== resumable.turnId) {
        throw new ResearchContractError(
          "invalid-request",
          "Recovered browser session no longer has its accepted durable turn.",
        );
      }
      if (activeResearchRuns.has(runId)) {
        throw new ResearchContractError("invalid-request", "Research run id is already active.");
      }
      activeResearchRuns.set(runId, { sessionId: resumed.sessionId, mode: "research" });
      offscreenActivity.begin();
      try {
        await ensureOffscreen();
        const response = (await chrome.runtime.sendMessage({
          kind: "offscreen:research-resume",
          runId,
          sessionId: resumed.sessionId,
          turnId: resumedTurn.id,
          apiKey,
        })) as OffscreenResponse | undefined;
        if (!response || response.kind !== "offscreen:research-resume-result" || response.runId !== runId) {
          throw new ResearchContractError(
            "provider-error",
            "The research worker host returned no correlated resume result.",
          );
        }
        if (!response.ok) throw new ResearchContractError(response.code, response.error);
        return response.report;
      } finally {
        offscreenActivity.end();
        activeResearchRuns.delete(runId);
      }
    } finally {
      store?.close();
      if (pendingResearchResumes.get(sessionId) === runId) {
        pendingResearchResumes.delete(sessionId);
      }
    }
  };

  const listResumableResearchSessions = async (windowId: number) => {
    const detection = await getCurrentEntity(windowId);
    const profile = detection.url ? profileFromTabUrl(detection.url) : null;
    if (!profile) {
      throw new ResearchContractError(
        "not-atlassian",
        "Open an Atlassian Cloud page before viewing resumable research sessions.",
      );
    }
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const now = new Date().toISOString();
      const tenantOrigin = new URL(profile.baseUrl).origin;
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const projected = projectResearchResumableSessionV1(session, {
            tenantOrigin,
            at: now,
          });
          return projected ? [projected] : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 20);
    } finally {
      store.close();
    }
  };

  const listRetainedResearchSessions = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const projected = projectResearchRetainedSessionV1(session, { tenantOrigin });
          return projected ? [projected] : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 20);
    } finally {
      store.close();
    }
  };

  /**
   * Browser equivalent of the CLI's `research --session` path. A caller adds
   * only a question; the terminal projection, scope provenance, policy,
   * limits, tenant, and revision fence all come from durable host state. The
   * result is deliberately paused at a plan-review or resume affordance, never
   * dispatched from the side-panel control message.
   */
  const prepareResearchFollowUpTurn = async (
    windowId: number,
    action: { sessionId: string; revision: number; question: string },
  ) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if ([...activeResearchRuns.values()].some((active) => active.sessionId === action.sessionId)) {
      throw new ResearchContractError("invalid-request", "An active research session cannot accept a follow-up turn.");
    }
    const question = action.question.trim();
    if (!question) throw new ResearchContractError("invalid-request", "A follow-up research question is required.");
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(action.sessionId);
      if (!stored) throw new ResearchContractError("invalid-request", "The terminal research session no longer exists.");
      const retained = projectResearchRetainedSessionV1(stored, { tenantOrigin });
      if (!retained || retained.revision !== action.revision) {
        throw new ResearchContractError(
          "invalid-request",
          "The terminal research session is stale or belongs to a different Atlassian site. Refresh the sidebar before continuing.",
        );
      }
      const previousTurn = stored.turns.find((candidate) => candidate.id === retained.turnId);
      if (!previousTurn?.brief) {
        throw new ResearchContractError("invalid-request", "The terminal research session is missing its accepted brief.");
      }
      const now = new Date().toISOString();
      const turnId = `research-turn:${crypto.randomUUID()}`;
      const request = normalizeResearchRequestV1({
        ...researchRequestFromBriefV1(previousTurn.brief),
        question,
      });
      const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(
        request.question,
        {
          sessionId: stored.sessionId,
          turnId,
          scope: request.scope,
          scopeBindings: previousTurn.scopeBindings,
          limits: request.limits,
          asOf: now,
          policy: researchPolicyFromBriefV1(previousTurn.brief),
          reportLanguage: request.reportLanguage,
        },
      ));
      if (briefOutcome.kind !== "ready") {
        throw new ResearchContractError(
          "clarification-required",
          "The follow-up question requires clarification before it can be added to the terminal session.",
        );
      }
      const graph = composeResearchGraphV1(briefOutcome.brief, {
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      });
      let appended = await appendResearchSessionTurnV1({
        store,
        sessionId: stored.sessionId,
        brief: briefOutcome.brief,
        graph,
        approveAutomatically: briefOutcome.brief.resolvedPlanApproval === "automatic",
        at: now,
      });
      const review = projectResearchSessionPlanReviewV1(appended, tenantOrigin);
      if (review) return { kind: "plan_review" as const, review };
      if (appended.status !== "running") {
        throw new ResearchContractError("provider-error", "The follow-up research turn did not reach a safe durable state.");
      }
      appended = (await store.commit(appended.sessionId, {
        kind: "release_lease",
        expectedRevision: appended.revision,
        expectedLeaseEpoch: appended.lease.epoch,
        at: now,
      })).session;
      const resumable = projectResearchResumableSessionV1(appended, { tenantOrigin, at: now });
      if (!resumable) {
        throw new ResearchContractError("provider-error", "The follow-up research turn could not be made safely resumable.");
      }
      return { kind: "resumable" as const, session: resumable };
    } finally {
      store.close();
    }
  };

  /**
   * Store one bounded focus/prioritization request. The active-tab tenant,
   * durable revision, graph revision, and safe checkpoint are all enforced by
   * the host/session reducer; caller text never chooses capabilities or scope.
   */
  const requestResearchSteering = async (
    windowId: number,
    action: ResearchSessionSteeringActionRequest,
  ): Promise<{ sessionId: string; revision: number; status: "waiting_steering" }> => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if ([...activeResearchRuns.values()].some((active) => active.sessionId === action.sessionId)) {
      throw new ResearchContractError("invalid-request", "An active research run cannot be steered.");
    }
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session is unavailable for steering.");
      }
      const turn = stored.activeTurnId
        ? stored.turns.find((candidate) => candidate.id === stored.activeTurnId)
        : undefined;
      if (!turn?.brief || !turn.graph || turn.brief.scope.siteOrigin !== tenantOrigin) {
        throw new ResearchContractError("access-denied", "The durable research session does not belong to the active Atlassian site.");
      }
      if (stored.revision !== action.revision) {
        throw new ResearchContractError("invalid-request", "The research session revision is stale. Refresh the sidebar before steering.");
      }
      const steered = (await store.commit(stored.sessionId, {
        kind: "request_steering",
        steeringId: `steering:${crypto.randomUUID()}`,
        basedOnGraphRevision: turn.graph.revision,
        request: action.instruction,
        expectedRevision: stored.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        at: new Date().toISOString(),
      })).session;
      return {
        sessionId: steered.sessionId,
        revision: steered.revision,
        status: "waiting_steering",
      };
    } finally {
      store.close();
    }
  };

  /**
   * Erase a terminal session only from the Atlassian tenant that originally
   * created it. The message contains opaque ids and a revision fence; neither
   * report content nor credentials cross this boundary.
   */
  const deleteResearchSession = async (
    windowId: number,
    action: ResearchSessionDeletionActionRequest,
  ): Promise<boolean> => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if ([...activeResearchRuns.values()].some((active) => active.sessionId === action.sessionId)) {
      throw new ResearchContractError(
        "invalid-request",
        "An active research run cannot be deleted.",
      );
    }
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(action.sessionId);
      // A previous successful deletion has already removed the entire record.
      // Treat that as the idempotent terminal result without exposing whether a
      // session was ever present in another tenant.
      if (!stored) return false;
      const storedTenantOrigin =
        stored.turns.find((turn) => turn.brief)?.brief?.scope.siteOrigin ??
        stored.scopeClarification?.request.scope.siteOrigin;
      if (!storedTenantOrigin || storedTenantOrigin !== tenantOrigin) {
        throw new ResearchContractError(
          "access-denied",
          "The durable research session does not belong to the active Atlassian site.",
        );
      }
      if (stored.revision !== action.revision) {
        throw new ResearchContractError(
          "invalid-request",
          "The research session revision is stale. Refresh the sidebar before deleting it.",
        );
      }
      const at = new Date().toISOString();
      const deletionRequested = (await store.commit(stored.sessionId, {
        kind: "request_deletion",
        expectedRevision: stored.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        at,
      })).session;
      const deleted = (await store.commit(deletionRequested.sessionId, {
        kind: "delete",
        expectedRevision: deletionRequested.revision,
        expectedLeaseEpoch: deletionRequested.lease.epoch,
        at,
      })).session;
      if (!await store.eraseDeleted(deleted.sessionId)) {
        throw new ResearchContractError(
          "provider-error",
          "The research session deletion did not erase its owned data.",
        );
      }
      return true;
    } finally {
      store.close();
    }
  };

  const activeResearchTenantOrigin = async (windowId: number): Promise<string> => {
    const detection = await getCurrentEntity(windowId);
    const profile = detection.url ? profileFromTabUrl(detection.url) : null;
    if (!profile) {
      throw new ResearchContractError(
        "not-atlassian",
        "Open an Atlassian Cloud page before reviewing durable research scope.",
      );
    }
    return new URL(profile.baseUrl).origin;
  };

  const prepareResearchPlanReview = async (
    windowId: number,
    value: ResearchRequestV1,
    policyValue: ResearchOneShotPolicyV1,
  ) => {
    const request = normalizeResearchRequestV1(value);
    const policy = normalizeResearchOneShotPolicyV1(policyValue);
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if (request.scope.siteOrigin !== tenantOrigin) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab no longer matches the research site.",
      );
    }
    const sessionId = `research-session:${crypto.randomUUID()}`;
    const turnId = `research-turn:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(
      request.question,
      {
        sessionId,
        turnId,
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf: now,
        policy,
        reportLanguage: request.reportLanguage,
      },
    ));
    if (briefOutcome.kind !== "ready") {
      throw new ResearchContractError(
        "clarification-required",
        "Research brief requires clarification before plan preparation.",
      );
    }
    const graph = composeResearchGraphV1(briefOutcome.brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const session = await initializeResearchSessionTurnV1({
        store,
        session: createResearchSessionV1({
          sessionId,
          ownerId: `owner:browser-plan-review-${sessionId.slice("research-session:".length)}`,
          createdAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        }),
        brief: briefOutcome.brief,
        graph,
        approveAutomatically: false,
        at: now,
      });
      const review = projectResearchSessionPlanReviewV1(session, tenantOrigin);
      if (!review) {
        throw new ResearchContractError(
          "provider-error",
          "The durable research plan could not be projected for the active site.",
        );
      }
      return review;
    } finally {
      store.close();
    }
  };

  const listResearchPlanReviews = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const review = projectResearchSessionPlanReviewV1(session, tenantOrigin);
          return review ? [review] : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      store.close();
    }
  };

  const approveResearchPlanReview = async (input: {
    windowId: number;
    action: ResearchPlanReviewActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionPlanReviewV1(stored, tenantOrigin);
      if (!review ||
          review.revision !== input.action.revision ||
          review.turn.briefRevision !== input.action.briefRevision ||
          review.turn.graphRevision !== input.action.graphRevision) {
        throw new ResearchContractError(
          "invalid-request",
          "The research plan review is stale. Refresh the sidebar before approving it.",
        );
      }
      const at = new Date().toISOString();
      const committed = (await store.commit(stored.sessionId, {
        kind: "approve_graph",
        graphRevision: input.action.graphRevision,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        at,
      })).session;
      const resumable = projectResearchResumableSessionV1(committed, {
        tenantOrigin,
        at,
      });
      if (!resumable) {
        throw new ResearchContractError(
          "provider-error",
          "The approved research plan could not be made resumable for the active site.",
        );
      }
      return resumable;
    } finally {
      store.close();
    }
  };

  /**
   * Browser equivalent of the CLI's aggregate reject-plan command. The exact
   * stored review establishes tenant, scope, limits, capability envelope, and
   * lease fence; the side panel contributes only its bounded correction.
   */
  const rejectResearchPlanReview = async (input: {
    windowId: number;
    action: ResearchPlanRevisionActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionPlanReviewV1(stored, tenantOrigin);
      if (!review ||
          review.revision !== input.action.revision ||
          review.turn.briefRevision !== input.action.briefRevision ||
          review.turn.graphRevision !== input.action.graphRevision) {
        throw new ResearchContractError(
          "invalid-request",
          "The research plan review is stale. Refresh the sidebar before revising it.",
        );
      }
      const instruction = input.action.instruction.trim();
      if (!instruction || instruction.length > 2_000) {
        throw new ResearchContractError("invalid-request", "A bounded plan correction is required.");
      }
      const at = new Date().toISOString();
      const rejected = (await store.commit(stored.sessionId, {
        kind: "reject_plan",
        graphRevision: review.turn.graphRevision,
        reason: instruction,
        expectedRevision: stored.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        at,
      })).session;
      const requested = (await store.commit(stored.sessionId, {
        kind: "request_plan_revision",
        graphRevision: review.turn.graphRevision,
        instruction,
        expectedRevision: rejected.revision,
        expectedLeaseEpoch: rejected.lease.epoch,
        at,
      })).session;
      const revised = await proposeResearchGraphForReadyBriefV1({
        store,
        sessionId: stored.sessionId,
        expectedRevision: requested.revision,
        expectedLeaseEpoch: requested.lease.epoch,
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
        approveAutomatically: false,
        at,
      });
      const replacement = projectResearchSessionPlanReviewV1(revised, tenantOrigin);
      if (!replacement) {
        throw new ResearchContractError(
          "provider-error",
          "The corrected research plan could not be projected for the active site.",
        );
      }
      return replacement;
    } finally {
      store.close();
    }
  };

  const projectClarificationResolution = (
    session: ResearchSessionV1,
    tenantOrigin: string,
    at: string,
  ) => {
    const planReview = projectResearchSessionPlanReviewV1(session, tenantOrigin);
    if (planReview) return { kind: "plan_review" as const, review: planReview };
    const resumable = projectResearchResumableSessionV1(session, { tenantOrigin, at });
    if (resumable) return { kind: "resumable" as const, session: resumable };
    throw new ResearchContractError(
      "provider-error",
      "The resolved clarification did not produce a safe plan or resume checkpoint.",
    );
  };

  const prepareResearchClarificationReview = async (
    windowId: number,
    value: ResearchRequestV1,
    policyValue: ResearchOneShotPolicyV1,
  ) => {
    const request = normalizeResearchRequestV1(value);
    const policy = normalizeResearchOneShotPolicyV1(policyValue);
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if (request.scope.siteOrigin !== tenantOrigin) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab no longer matches the research site.",
      );
    }
    const sessionId = `research-session:${crypto.randomUUID()}`;
    const turnId = `research-turn:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const briefOutcome = prepareResearchBriefPreflightV1(createStandardResearchBriefV1(
      request.question,
      {
        sessionId,
        turnId,
        scope: request.scope,
        scopeBindings: request.scopeSeeds?.map((seed) => seed.binding),
        limits: request.limits,
        asOf: now,
        policy,
        reportLanguage: request.reportLanguage,
      },
    ));
    if (briefOutcome.kind !== "clarification_required") {
      throw new ResearchContractError(
        "invalid-request",
        "This research brief does not require clarification.",
      );
    }
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const session = await initializeResearchSessionClarificationWaitV1({
        store,
        session: createResearchSessionV1({
          sessionId,
          ownerId: `owner:browser-clarification-${sessionId.slice("research-session:".length)}`,
          createdAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        }),
        brief: briefOutcome.brief,
        at: now,
      });
      const review = projectResearchSessionClarificationReviewV1(session, tenantOrigin);
      if (!review) {
        throw new ResearchContractError(
          "provider-error",
          "The durable research clarification could not be projected for the active site.",
        );
      }
      return review;
    } finally {
      store.close();
    }
  };

  const listResearchClarificationReviews = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const review = projectResearchSessionClarificationReviewV1(session, tenantOrigin);
          return review ? [review] : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      store.close();
    }
  };

  const resolveResearchClarificationReview = async (input: {
    windowId: number;
    action: ResearchClarificationReviewActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionClarificationReviewV1(stored, tenantOrigin);
      if (!review || review.stage !== "answer_required" ||
          review.revision !== input.action.revision ||
          review.turn.briefRevision !== input.action.briefRevision) {
        throw new ResearchContractError(
          "invalid-request",
          "The research clarification is stale. Refresh the sidebar before answering it.",
        );
      }
      const turn = stored.turns.find((candidate) => candidate.id === review.turn.id);
      if (!turn?.brief) {
        throw new ResearchContractError("invalid-request", "The durable research clarification has no active brief.");
      }
      const at = new Date().toISOString();
      const committed = await resolveResearchSessionClarificationsV1({
        store,
        sessionId: stored.sessionId,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        briefRevision: input.action.briefRevision,
        answers: input.action.answers,
        assumptionDecisions: input.action.assumptionDecisions,
        approveAutomatically: turn.brief.resolvedPlanApproval === "automatic",
        releaseApprovedLease: true,
        at,
      });
      return projectClarificationResolution(committed, tenantOrigin, at);
    } finally {
      store.close();
    }
  };

  const continueResearchClarificationReview = async (input: {
    windowId: number;
    action: ResearchClarificationPlanningActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionClarificationReviewV1(stored, tenantOrigin);
      if (!review || review.stage !== "plan_required" ||
          review.revision !== input.action.revision ||
          review.turn.briefRevision !== input.action.briefRevision) {
        throw new ResearchContractError(
          "invalid-request",
          "The recovered research clarification is stale. Refresh the sidebar before continuing it.",
        );
      }
      const turn = stored.turns.find((candidate) => candidate.id === review.turn.id);
      if (!turn?.brief) {
        throw new ResearchContractError("invalid-request", "The recovered research clarification has no active brief.");
      }
      const at = new Date().toISOString();
      const committed = await continueResearchSessionClarificationPlanningV1({
        store,
        sessionId: stored.sessionId,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        briefRevision: input.action.briefRevision,
        approveAutomatically: turn.brief.resolvedPlanApproval === "automatic",
        releaseApprovedLease: true,
        at,
      });
      return projectClarificationResolution(committed, tenantOrigin, at);
    } finally {
      store.close();
    }
  };

  const projectScopeClarificationResolution = (
    session: ResearchSessionV1,
    tenantOrigin: string,
    at: string,
  ) => {
    const scopeReview = projectResearchSessionScopeClarificationReviewV1(session, tenantOrigin);
    if (scopeReview) return { kind: "scope_clarification" as const, review: scopeReview };
    const clarificationReview = projectResearchSessionClarificationReviewV1(session, tenantOrigin);
    if (clarificationReview) return { kind: "clarification_review" as const, review: clarificationReview };
    return projectClarificationResolution(session, tenantOrigin, at);
  };

  const prepareResearchScopeClarificationReview = async (
    windowId: number,
    value: ResearchRequestV1,
    policyValue: ResearchOneShotPolicyV1,
    purpose: "chat" | "research" = "research",
  ) => {
    const request = normalizeResearchRequestV1(value);
    const policy = normalizeResearchOneShotPolicyV1(policyValue);
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    if (request.scope.siteOrigin !== tenantOrigin) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab no longer matches the research site.",
      );
    }
    const scopeOutcome = await resolveResearchScope(windowId, request);
    if (scopeOutcome.kind !== "clarification_required") {
      throw new ResearchContractError(
        "invalid-request",
        "This research scope no longer requires clarification.",
      );
    }
    const now = new Date().toISOString();
    const sessionId = `research-session:${crypto.randomUUID()}`;
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const session = await initializeResearchSessionScopeClarificationWaitV1({
        store,
        session: createResearchSessionV1({
          sessionId,
          ownerId: `owner:browser-scope-clarification-${sessionId.slice("research-session:".length)}`,
          createdAt: now,
          leaseExpiresAt: new Date(Date.parse(now) + request.limits.maxRunMs).toISOString(),
        }),
        request,
        policy,
        purpose,
        clarification: scopeOutcome.clarification,
        candidateChoices: scopeOutcome.candidateChoices,
        at: now,
      });
      const review = projectResearchSessionScopeClarificationReviewV1(session, tenantOrigin);
      if (!review || review.stage !== "choice_required") {
        throw new ResearchContractError(
          "provider-error",
          "The durable research scope clarification could not be projected for the active site.",
        );
      }
      return review;
    } finally {
      store.close();
    }
  };

  const listResearchScopeClarificationReviews = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const review = projectResearchSessionScopeClarificationReviewV1(session, tenantOrigin);
          return review ? [review] : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      store.close();
    }
  };

  const resolveResearchScopeClarificationReview = async (input: {
    windowId: number;
    action: ResearchScopeClarificationReviewActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionScopeClarificationReviewV1(stored, tenantOrigin);
      if (!review || review.stage !== "choice_required" || review.revision !== input.action.revision ||
          input.action.selection.mentionId !== review.clarification.mentionId) {
        throw new ResearchContractError(
          "invalid-request",
          "The research scope clarification is stale. Refresh the sidebar before choosing it.",
        );
      }
      if (!review.clarification.candidates.some((candidate) => candidate.id === input.action.selection.candidateId)) {
        throw new ResearchContractError("invalid-request", "The selected research scope candidate is unavailable.");
      }
      const scopeClarification = stored.scopeClarification;
      if (!scopeClarification) {
        throw new ResearchContractError("invalid-request", "The durable research scope clarification is missing its request.");
      }
      const scopeOutcome = await resolveResearchScope(input.windowId, scopeClarification.request, {
        candidateSelections: [input.action.selection],
      });
      const at = new Date().toISOString();
      if (scopeOutcome.kind === "clarification_required") {
        const refreshed = await refreshResearchSessionScopeClarificationV1({
          store,
          sessionId: stored.sessionId,
          expectedRevision: input.action.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          clarification: scopeOutcome.clarification,
          candidateChoices: scopeOutcome.candidateChoices,
          at,
        });
        const next = projectResearchSessionScopeClarificationReviewV1(refreshed, tenantOrigin);
        if (!next) {
          throw new ResearchContractError("provider-error", "The refreshed research scope clarification could not be projected.");
        }
        return { kind: "scope_clarification" as const, review: next };
      }
      if (scopeClarification.purpose === "chat") {
        const resolved = await resolveChatScopeClarificationV1({
          store,
          sessionId: stored.sessionId,
          expectedRevision: input.action.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          selection: input.action.selection,
          resolvedRequest: scopeOutcome.request,
          at,
        });
        return {
          kind: "chat_ready" as const,
          request: resolved.request,
          conversationId: resolved.conversationSession.sessionId,
        };
      }
      const committed = await resolveResearchSessionScopeClarificationV1({
        store,
        sessionId: stored.sessionId,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        selection: input.action.selection,
        resolvedRequest: scopeOutcome.request,
        releaseApprovedLease: true,
        at,
      });
      return projectScopeClarificationResolution(committed, tenantOrigin, at);
    } finally {
      store.close();
    }
  };

  const continueResearchScopeClarificationReview = async (input: {
    windowId: number;
    action: ResearchScopeClarificationPlanningActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionScopeClarificationReviewV1(stored, tenantOrigin);
      if (!review || review.stage === "choice_required" || review.revision !== input.action.revision) {
        throw new ResearchContractError(
          "invalid-request",
          "The recovered research scope clarification is stale. Refresh the sidebar before continuing it.",
        );
      }
      const at = new Date().toISOString();
      const committed = await continueResearchSessionScopeClarificationV1({
        store,
        sessionId: stored.sessionId,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        releaseApprovedLease: true,
        at,
      });
      return projectScopeClarificationResolution(committed, tenantOrigin, at);
    } finally {
      store.close();
    }
  };

  const scopeReviewForActiveTenant = async (input: {
    windowId: number;
    action: ResearchScopeReviewActionRequest;
    approve: boolean;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionScopeReviewV1(stored, tenantOrigin);
      if (!review) {
        throw new ResearchContractError(
          "access-denied",
          "The durable research session does not belong to the active Atlassian site.",
        );
      }
      if (
        review.status !== "waiting_scope_approval" ||
        review.revision !== input.action.revision ||
        review.turn.briefRevision !== input.action.briefRevision ||
        review.turn.graphRevision !== input.action.graphRevision
      ) {
        throw new ResearchContractError(
          "invalid-request",
          "The scope review revision is stale. Refresh the sidebar before deciding.",
        );
      }
      const proposal = stored.turns
        .find((turn) => turn.id === review.turn.id)
        ?.scopeExpansionProposals.find((candidate) => candidate.id === input.action.proposalId);
      if (!proposal || proposal.status !== "proposed" ||
          proposal.basedOnBriefRevision !== review.turn.briefRevision ||
          proposal.basedOnGraphRevision !== review.turn.graphRevision) {
        throw new ResearchContractError(
          "invalid-request",
          "The scope proposal is stale, unknown, or already resolved.",
        );
      }
      let committed: ResearchSessionV1;
      const at = new Date().toISOString();
      if (input.approve) {
        const turn = stored.turns.find((candidate) => candidate.id === review.turn.id)!;
        const candidate = turn.scopeCandidates.find((entry) => entry.id === proposal.candidateId);
        if (!candidate) {
          throw new ResearchContractError(
            "invalid-request",
            "The persisted scope candidate is no longer available.",
          );
        }
        committed = await approveResearchScopeExpansionV1({
          store,
          sessionId: stored.sessionId,
          expectedRevision: input.action.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          proposalId: proposal.id,
          binding: createResearchScopeBindingV1({
            candidate,
            source: "research_discovery",
            authority: "approved",
            approvedAt: at,
          }),
          at,
        });
      } else {
        committed = (await store.commit(stored.sessionId, {
          kind: "reject_scope_expansion",
          proposalId: proposal.id,
          expectedRevision: input.action.revision,
          expectedLeaseEpoch: stored.lease.epoch,
          at,
        })).session;
      }
      const next = projectResearchSessionScopeReviewV1(committed, tenantOrigin);
      if (!next) {
        throw new ResearchContractError(
          "provider-error",
          "The durable scope decision could not be projected for the active site.",
        );
      }
      return next;
    } finally {
      store.close();
    }
  };

  const listResearchScopeReviews = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const review = projectResearchSessionScopeReviewV1(session, tenantOrigin);
          return review?.status === "waiting_scope_approval" &&
              review.turn.expansionProposals.some((proposal) => proposal.status === "proposed")
            ? [review]
            : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      store.close();
    }
  };

  const listResearchScopePlanReviews = async (windowId: number) => {
    const tenantOrigin = await activeResearchTenantOrigin(windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const page = await store.list({ limit: 100 });
      return page.sessions
        .flatMap((session) => {
          const review = projectResearchSessionScopeReviewV1(session, tenantOrigin);
          return review?.status === "waiting_plan_approval" &&
              review.turn.scopeRevisions.some((revision) => revision.state === "proposed")
            ? [review]
            : [];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      store.close();
    }
  };

  const approveResearchScopePlanReview = async (input: {
    windowId: number;
    action: ResearchScopePlanReviewActionRequest;
  }) => {
    const tenantOrigin = await activeResearchTenantOrigin(input.windowId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const stored = await store.read(input.action.sessionId);
      if (!stored) {
        throw new ResearchContractError("invalid-request", "The durable research session no longer exists.");
      }
      const review = projectResearchSessionScopeReviewV1(stored, tenantOrigin);
      if (!review) {
        throw new ResearchContractError(
          "access-denied",
          "The durable research session does not belong to the active Atlassian site.",
        );
      }
      const matchingScopeRevision = review.turn.scopeRevisions.some((revision) =>
        revision.state === "proposed" &&
        revision.proposedGraphRevision === input.action.graphRevision,
      );
      if (
        review.status !== "waiting_plan_approval" ||
        review.revision !== input.action.revision ||
        review.turn.briefRevision !== input.action.briefRevision ||
        review.turn.graphRevision !== input.action.graphRevision ||
        !matchingScopeRevision
      ) {
        throw new ResearchContractError(
          "invalid-request",
          "The scope replacement plan is stale. Refresh the sidebar before approving it.",
        );
      }
      const committed = (await store.commit(stored.sessionId, {
        kind: "approve_graph",
        graphRevision: input.action.graphRevision,
        expectedRevision: input.action.revision,
        expectedLeaseEpoch: stored.lease.epoch,
        at: new Date().toISOString(),
      })).session;
      const next = projectResearchSessionScopeReviewV1(committed, tenantOrigin);
      if (!next) {
        throw new ResearchContractError(
          "provider-error",
          "The durable scope-plan decision could not be projected for the active site.",
        );
      }
      return next;
    } finally {
      store.close();
    }
  };

  const resolveResearchScope = async (
    windowId: number,
    value: ResearchRequestV1,
    options?: ResearchScopePreflightOptionsV1,
  ) => {
    const request = normalizeResearchRequestV1(value);
    const detection = await getCurrentEntity(windowId);
    const profile = detection.url ? profileFromTabUrl(detection.url) : null;
    if (!profile || new URL(profile.baseUrl).origin !== request.scope.siteOrigin) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab no longer matches the research site.",
      );
    }
    const broker = new ResearchScopeCatalogBroker({
      tenantOrigin: request.scope.siteOrigin,
      providers: createRestScopeCatalogProviders(profile, request.scope.siteOrigin),
    });
    return prepareResearchScopePreflightV1({
      request,
      catalog: broker,
      automaticApproval: true,
      candidateSelections: options?.candidateSelections,
    });
  };

  const controlActiveChat = async (
    windowId: number,
    command: ChatInteractionCommandV1,
  ): Promise<ChatInteractionStateV1> => {
    const detection = await getCurrentEntity(windowId);
    const profile = detection.url ? profileFromTabUrl(detection.url) : null;
    if (!profile) {
      throw new ResearchContractError(
        "access-denied",
        "The active Atlassian tab is unavailable for Chat control.",
      );
    }
    const stored = await chrome.storage.local.get([
      APP_SETTINGS_STORAGE_KEY,
      CHAT_HOST_PRINCIPAL_KEY,
    ]);
    const modelSelection = normalizeSettings(
      stored[APP_SETTINGS_STORAGE_KEY],
    ).modelSelection;
    const activeConversationKey = browserChatActiveConversationStorageKeyV1(
      modelSelection,
    );
    const storedConversation = await chrome.storage.local.get(activeConversationKey);
    const conversationId = storedConversation[activeConversationKey];
    const userId = stored[CHAT_HOST_PRINCIPAL_KEY];
    if (typeof conversationId !== "string" ||
        !CHAT_CONVERSATION_ID_PATTERN.test(conversationId) ||
        typeof userId !== "string" ||
        !CHAT_HOST_PRINCIPAL_PATTERN.test(userId)) {
      throw new ResearchContractError(
        "invalid-request",
        "The active Chat conversation is unavailable.",
      );
    }
    const tenantOrigin = new URL(profile.baseUrl).origin;
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      if (!await store.read(conversationId)) {
        throw new ResearchContractError(
          "invalid-request",
          "The active Chat conversation is unavailable.",
        );
      }
      const workspace = await store.workspace(conversationId);
      const serialized = await workspace.readFile(CHAT_INTERACTION_STATE_PATH_V1);
      if (serialized === undefined) {
        throw new ResearchContractError(
          "invalid-request",
          "The active Chat interaction is unavailable.",
        );
      }
      const state = parseChatInteractionStateV1(JSON.parse(serialized));
      assertChatInteractionBindingV1({
        state,
        conversationId,
        binding: {
          userId,
          providerCacheIdentity: browserChatProviderCacheIdentityV1(
            modelSelection,
            userId,
          ),
          threadId: conversationId,
          tenantOrigin,
        },
      });
      const control = stampChatInteractionCommandV1(command, new Date().toISOString());
      const active = [...activeResearchRuns.entries()].find(([, candidate]) =>
        candidate.mode === "chat" && candidate.sessionId === conversationId
      );
      if (active) {
        await ensureOffscreen();
        const [runId] = active;
        const controlId = `chat-control:${crypto.randomUUID()}`;
        const response = (await chrome.runtime.sendMessage({
          kind: "offscreen:research-chat-control",
          runId,
          controlId,
          control,
        })) as OffscreenResponse | undefined;
        if (!response ||
            response.kind !== "offscreen:research-chat-control-result" ||
            response.runId !== runId ||
            response.controlId !== controlId) {
          throw new ResearchContractError(
            "provider-error",
            "The Chat interaction host returned no correlated result.",
          );
        }
        if (!response.ok) {
          throw new ResearchContractError(response.code, response.error);
        }
        return response.state;
      }
      const interactions = await WorkspaceChatInteractionControllerV1.bind({
        workspace,
        conversationId,
        binding: state.binding,
        at: new Date().toISOString(),
      });
      return await interactions.update((current) =>
        applyChatInteractionControlV1(current, control)
      );
    } finally {
      store.close();
    }
  };

  const cancelResearch = async (runId: string): Promise<boolean> => {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:research-cancel",
      runId,
    })) as OffscreenResponse | undefined;
    return Boolean(
      response &&
        response.kind === "offscreen:research-cancel-result" &&
        response.runId === runId &&
        response.cancelled
    );
  };

  const pauseResearchWorker = async (runId: string): Promise<boolean> => {
    await ensureOffscreen();
    const response = (await chrome.runtime.sendMessage({
      kind: "offscreen:research-pause",
      runId,
    })) as OffscreenResponse | undefined;
    return Boolean(
      response &&
        response.kind === "offscreen:research-pause-result" &&
        response.runId === runId &&
        response.paused,
    );
  };

  /**
   * Request cooperative browser pause without accepting a session identifier
   * from the caller. A running retrieval wave keeps its lease and settles its
   * own checkpoint. If that checkpoint already exists, stop the worker first,
   * then release the durable session in the same pause boundary.
   */
  const requestResearchPause = async (
    runId: string,
  ): Promise<"pause_requested" | "paused"> => {
    const active = activeResearchRuns.get(runId);
    if (!active) {
      throw new ResearchContractError(
        "invalid-request",
        "There is no active research run to pause.",
      );
    }
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const current = await store.read(active.sessionId);
      if (!current) {
        throw new ResearchContractError(
          "invalid-request",
          "The active research run no longer has a durable session.",
        );
      }
      if (current.status === "paused") return "paused";
      if (current.status === "pause_requested") return "pause_requested";
      if (current.status !== "running") {
        throw new ResearchContractError(
          "invalid-request",
          "Only a running research session can be paused.",
        );
      }
      const requested = (await store.commit(current.sessionId, {
        kind: "request_pause",
        expectedRevision: current.revision,
        expectedLeaseEpoch: current.lease.epoch,
        at: new Date().toISOString(),
      })).session;
      const activeTurn = requested.activeTurnId
        ? requested.turns.find((candidate) => candidate.id === requested.activeTurnId)
        : undefined;
      const issuedContinuation = activeTurn?.retrievalAssessments?.some(
        (assessment) => assessment.continuation?.status === "issued",
      ) ?? false;
      if (!issuedContinuation) return "pause_requested";

      // The session is already at a safe continuation boundary. Stop this
      // exact worker before releasing its lease, so no later provider action
      // can race a resumed owner.
      const interrupted = await pauseResearchWorker(runId);
      if (!interrupted) {
        const afterInterrupt = await store.read(active.sessionId);
        if (afterInterrupt?.status === "paused") return "paused";
        throw new ResearchContractError(
          "provider-error",
          "The research worker could not acknowledge the durable pause.",
        );
      }
      const beforeAcknowledgement = await store.read(active.sessionId);
      if (!beforeAcknowledgement) {
        throw new ResearchContractError(
          "invalid-request",
          "The paused research session is no longer available.",
        );
      }
      if (beforeAcknowledgement.status === "paused") return "paused";
      const paused = (await store.commit(beforeAcknowledgement.sessionId, {
        kind: "acknowledge_pause",
        expectedRevision: beforeAcknowledgement.revision,
        expectedLeaseEpoch: beforeAcknowledgement.lease.epoch,
        at: new Date().toISOString(),
      })).session;
      if (paused.status !== "paused") {
        throw new ResearchContractError(
          "provider-error",
          "The research worker did not reach a durable pause checkpoint.",
        );
      }
      return "paused";
    } finally {
      store.close();
    }
  };

  /**
   * A deliberate sidebar cancellation is terminal only after its dedicated
   * worker has stopped. An uncorrelated worker interrupt remains resumable for
   * recovery tests and host-loss handling; the UI uses this durable variant.
   */
  const cancelResearchSession = async (runId: string): Promise<boolean> => {
    const active = activeResearchRuns.get(runId);
    if (!active) return false;
    // The worker may acknowledge its terminal abort and disappear between the
    // routing lookup above and the offscreen interrupt response. The captured
    // run-to-session binding is still authoritative for this deliberate UI
    // cancellation, so persist the terminal checkpoint even when the worker
    // reports that there is no longer anything left to interrupt.
    await cancelResearch(runId);
    const store = await IndexedDbResearchSessionStoreV1.open();
    try {
      const current = await store.read(active.sessionId);
      if (!current) return true;
      if (current.status === "cancelled" || current.status === "complete" || current.status === "failed") {
        return current.status === "cancelled";
      }
      await store.commit(current.sessionId, {
        kind: "cancel",
        expectedRevision: current.revision,
        expectedLeaseEpoch: current.lease.epoch,
        at: new Date().toISOString(),
      });
      return true;
    } finally {
      store.close();
    }
  };

  // Start-up pass: a worker that just woke may be looking at records whose
  // compile died with the previous one.
  sweepJobs(true);
  refreshExportBadge();
  void restoreCommonExportQueueAfterHostStart().catch((error) =>
    console.error("Common export queue host recovery failed", error)
  );

  // The `true` return from handleExtMessage keeps the channel open for the
  // async sendResponse — see utils/listeners.ts (covered by listeners.test.ts).
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isExportJobsChanged(message)) {
      refreshExportBadge();
      return false;
    }
    const handled = handleExtMessage(message, sendResponse, {
      runWasmSmoke,
      getCurrentEntity,
      runPdfCompile,
      runPdfCancel,
      prepareDocxRuntime,
      runJobsWake,
      runResearch,
      resumeResearch,
      listResumableResearchSessions,
      listRetainedResearchSessions,
      prepareResearchFollowUpTurn,
      requestResearchSteering,
      deleteResearchSession,
      listResearchScopeReviews,
      listResearchScopePlanReviews,
      prepareResearchPlanReview,
      listResearchPlanReviews,
      approveResearchScopeReview: (windowId, action) => scopeReviewForActiveTenant({
        windowId,
        action,
        approve: true,
      }),
      rejectResearchScopeReview: (windowId, action) => scopeReviewForActiveTenant({
        windowId,
        action,
        approve: false,
      }),
      approveResearchScopePlanReview: (windowId, action) => approveResearchScopePlanReview({
        windowId,
        action,
      }),
      approveResearchPlanReview: (windowId, action) => approveResearchPlanReview({
        windowId,
        action,
      }),
      rejectResearchPlanReview: (windowId, action) => rejectResearchPlanReview({
        windowId,
        action,
      }),
      prepareResearchClarificationReview,
      listResearchClarificationReviews,
      resolveResearchClarificationReview: (windowId, action) => resolveResearchClarificationReview({
        windowId,
        action,
      }),
      continueResearchClarificationReview: (windowId, action) => continueResearchClarificationReview({
        windowId,
        action,
      }),
      prepareResearchScopeClarificationReview,
      listResearchScopeClarificationReviews,
      resolveResearchScopeClarificationReview: (windowId, action) => resolveResearchScopeClarificationReview({
        windowId,
        action,
      }),
      continueResearchScopeClarificationReview: (windowId, action) => continueResearchScopeClarificationReview({
        windowId,
        action,
      }),
      resolveResearchScope,
      controlActiveChat,
      cancelResearch,
      requestResearchPause,
      cancelResearchSession,
    });
    if (handled) {
      // Opening or reading the panel is not acknowledgement. Productive queue
      // wakes refresh after their catalog operation; durable actions and queue
      // settlements send `jobs:changed`.
      sweepJobs();
    }
    return handled;
  });

  // Tab switch: resolve the newly-active tab's URL, then observe it.
  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs
      .get(activeInfo.tabId)
      .then((tab) => {
        void feed(activeInfo.windowId, tab?.url).catch((err) =>
          console.error("tab observer persistence failed", err)
        );
      })
      .catch(() => {
        /* tab gone before we could read it; ignore */
      });
  });

  // URL change (incl. Confluence SPA history navigation): only when the URL
  // actually changed AND it's the active tab — avoids reacting to background
  // tabs the panel isn't showing.
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!changeInfo.url) return;
    if (!tab.active) return;
    void feed(tab.windowId, changeInfo.url).catch((err) =>
      console.error("tab observer persistence failed", err)
    );
  });

  // A freshly-started MV3 worker can become visible to Chrome before its
  // module has finished evaluating and the listeners above are registered.
  // Reconcile every window's active tab after registration so a navigation
  // that raced worker start (or happened while the worker was asleep) is not
  // lost. The serialized observer session deduplicates a later listener event.
  void chrome.tabs
    .query({ active: true })
    .then((tabs) =>
      Promise.all(
        tabs.map((tab) =>
          feed(tab.windowId, tab.url).catch((err) =>
            console.error("tab observer start-up reconciliation failed", err)
          )
        )
      )
    )
    .catch((err) =>
      console.error("active tab start-up reconciliation failed", err)
    );
  },
});

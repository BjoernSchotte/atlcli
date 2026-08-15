import type {
  SurfaceNavigationPort,
  SurfaceNavigationRequestV1,
} from "../../../utils/ports/index.js";
import type {
  ActionPaletteMessageV1,
  ActionPaletteResponseV1,
} from "../../../utils/action-palette/protocol.js";

export const ACTION_PALETTE_NAVIGATION_STORAGE_KEY = "actionPalette.navigation.v1";

export interface QueueSurfaceNavigationDepsV1 {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly persist: (message: ActionPaletteNavigationMessageV1) => Promise<void>;
  readonly deliver: (message: ActionPaletteNavigationMessageV1) => Promise<void>;
  readonly reportError?: (phase: "persist" | "deliver", caught: unknown) => void;
}

export type ActionPaletteNavigationMessageV1 = Extract<
  ActionPaletteResponseV1,
  { kind: "action-palette:open-surface-request" }
>;

/**
 * Queue a side-panel target through independent cold and live lanes. A
 * transient storage failure must not discard a message that an already-mounted
 * panel can receive, while a missing live receiver is safe once the mailbox is
 * durable. Only losing both lanes rejects the action.
 */
export async function queueSurfaceNavigationV1(
  screen: ActionPaletteNavigationMessageV1["screen"],
  continuationId: string | undefined,
  deps: QueueSurfaceNavigationDepsV1,
): Promise<ActionPaletteNavigationMessageV1> {
  const now = (deps.now ?? Date.now)();
  const navigationId = (deps.randomId ?? (() => crypto.randomUUID()))();
  const message: ActionPaletteNavigationMessageV1 = {
    kind: "action-palette:open-surface-request",
    requestId: `navigation:${navigationId}`,
    navigationId,
    screen,
    ...(continuationId ? { continuationId } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
  };
  let persisted = false;
  try {
    await deps.persist(message);
    persisted = true;
  } catch (caught) {
    deps.reportError?.("persist", caught);
  }
  try {
    await deps.deliver(message);
  } catch (caught) {
    deps.reportError?.("deliver", caught);
    if (!persisted) throw new Error("Action palette surface navigation could not be delivered.");
  }
  return message;
}

function isNavigationRequest(value: unknown): value is Extract<
  ActionPaletteMessageV1,
  { kind: "action-palette:open-surface-request" }
> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const expectedKeys = candidate.continuationId === undefined
    ? ["kind", "requestId", "navigationId", "screen", "createdAt", "expiresAt"]
    : ["kind", "requestId", "navigationId", "screen", "continuationId", "createdAt", "expiresAt"];
  return Object.keys(candidate).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(candidate, key)) &&
    candidate.kind === "action-palette:open-surface-request" &&
    typeof candidate.requestId === "string" && typeof candidate.navigationId === "string" &&
    ["export", "research", "activity", "settings"].includes(String(candidate.screen)) &&
    (candidate.continuationId === undefined || (
      typeof candidate.continuationId === "string" &&
      candidate.screen === "research" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.continuationId)
    )) &&
    typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt)) &&
    typeof candidate.expiresAt === "string";
}

function toPortRequest(message: Extract<
  ActionPaletteMessageV1,
  { kind: "action-palette:open-surface-request" }
>): SurfaceNavigationRequestV1 {
  return {
    id: message.navigationId,
    screen: message.screen,
    ...(message.continuationId ? { continuationId: message.continuationId } : {}),
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  };
}

export function chromeSurfaceNavigationPort(): SurfaceNavigationPort {
  return {
    subscribe(onRequest) {
      let active = true;
      const delivered = new Set<string>();
      const deliver = (message: unknown): void => {
        if (!active || !isNavigationRequest(message) || delivered.has(message.navigationId) ||
            Date.parse(message.expiresAt) <= Date.now()) return;
        delivered.add(message.navigationId);
        onRequest(toPortRequest(message));
      };
      const listener = (message: unknown): false => {
        deliver(message);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      void chrome.storage.session.get(ACTION_PALETTE_NAVIGATION_STORAGE_KEY).then((stored) => {
        deliver(stored[ACTION_PALETTE_NAVIGATION_STORAGE_KEY]);
      }).catch(() => {
        // A transient storage failure must not break live delivery.
      });
      return () => {
        if (!active) return;
        active = false;
        chrome.runtime.onMessage.removeListener(listener);
      };
    },
    async acknowledge(id) {
      const response = await chrome.runtime.sendMessage({
        kind: "action-palette:open-surface-ack",
        requestId: `ack:${id}`,
        navigationId: id,
      });
      return Boolean(response && typeof response === "object" &&
        (response as { kind?: unknown }).kind === "action-palette:open-surface-ack-result" &&
        (response as { accepted?: unknown }).accepted === true);
    },
  };
}

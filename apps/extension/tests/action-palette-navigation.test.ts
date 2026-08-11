import { afterEach, describe, expect, test } from "bun:test";
import { ACTION_IDS, type ActionExecutionRequestV1, type ActionResultV1 } from "@atlcli/action-registry";
import {
  createExtensionActionPaletteExecutorsV1,
  type ActionPaletteExecutorEntryV1,
} from "../utils/action-palette/background-host.js";
import { EXTENSION_ACTION_CAPABILITIES_V1 } from "../utils/action-palette/catalog.js";
import { openActionPaletteSidePanelForGestureV1 } from "../utils/action-palette/gesture.js";
import type { ActionPaletteSenderV1 } from "../utils/action-palette/context.js";
import {
  ACTION_PALETTE_NAVIGATION_STORAGE_KEY,
  chromeSurfaceNavigationPort,
} from "../entrypoints/sidepanel/ports/surface-navigation.js";

const chromeGlobal = globalThis as typeof globalThis & { chrome?: typeof chrome };
const originalChrome = chromeGlobal.chrome;
afterEach(() => {
  if (originalChrome === undefined) delete (chromeGlobal as unknown as Record<string, unknown>).chrome;
  else chromeGlobal.chrome = originalChrome;
});

const sender: ActionPaletteSenderV1 = {
  tabId: 7,
  documentId: "document-7",
  frameId: 0,
  origin: "https://fixture.atlassian.net",
  url: "https://fixture.atlassian.net/wiki/spaces/DOC/pages/42/Guide",
};

function executeMessage(actionId: string): unknown {
  return {
    kind: "action-palette:execute",
    requestId: `execute:${actionId}`,
    catalogRevision: "revision:1",
    actionId,
    locale: "en-US",
  };
}

const execution: ActionExecutionRequestV1 = {
  schemaVersion: 1,
  requestId: "execute:surface",
  actionId: ACTION_IDS.openActivity,
  intent: { kind: "surface.open", target: { kind: "sidebar", screen: "activity" } },
  context: {
    siteOrigin: "https://fixture.atlassian.net",
    product: "atlassian",
    locale: "en-US",
    capabilities: [EXTENSION_ACTION_CAPABILITIES_V1.surface],
  },
};

const exportRunner = async (): Promise<ActionResultV1> => ({
  status: "completed",
  messageKey: "atlcli.test.done",
});

describe("action palette navigation", () => {
  test("opens only explicit surface actions synchronously on the trusted top-frame gesture", () => {
    const order: string[] = [];
    const opened = openActionPaletteSidePanelForGestureV1(
      executeMessage(ACTION_IDS.openActivity),
      sender,
      (tabId) => order.push(`open:${tabId}`),
    );
    order.push("after");
    expect(opened).toBe(true);
    expect(order).toEqual(["open:7", "after"]);

    for (const message of [
      executeMessage(ACTION_IDS.exportPdfCurrentPage),
      executeMessage(ACTION_IDS.exportDocxCurrentPage),
      executeMessage(ACTION_IDS.quickAsk),
    ]) {
      expect(openActionPaletteSidePanelForGestureV1(message, sender, () => {
        throw new Error("must not open");
      })).toBe(false);
    }
    expect(openActionPaletteSidePanelForGestureV1(
      executeMessage(ACTION_IDS.openActivity),
      { ...sender, frameId: 1 },
      () => { throw new Error("must not open"); },
    )).toBe(false);
  });

  test("queues the validated target while keeping shell-open and target selection separate", async () => {
    const screens: string[] = [];
    const entries = createExtensionActionPaletteExecutorsV1({
      queueSurface: async (screen) => { screens.push(screen); },
      exportPdf: exportRunner,
      exportDocx: exportRunner,
      quickAsk: exportRunner,
    });
    const activity = entries.find((entry) => entry.actionId === ACTION_IDS.openActivity);
    expect(activity).toBeDefined();
    expect(await activity!.execute(
      execution,
      new AbortController().signal,
      async () => ({
        tabId: 1,
        documentId: "doc-1",
        frameId: 0,
        origin: "https://fixture.atlassian.net",
        url: "https://fixture.atlassian.net/wiki/spaces/DOC/pages/42/Guide",
      }),
      async () => undefined,
    )).toEqual({
      status: "open-surface",
      target: { kind: "sidebar", screen: "activity" },
    });
    expect(screens).toEqual(["activity"]);
  });

  test("drops expired mail, suppresses cold/live duplicates, acknowledges, and unsubscribes once", async () => {
    type Listener = (message: unknown) => false;
    const listeners = new Set<Listener>();
    const sent: unknown[] = [];
    const expired = {
      kind: "action-palette:open-surface-request",
      requestId: "navigation:expired",
      navigationId: "expired",
      screen: "research",
      createdAt: "2026-08-11T12:00:00.000Z",
      expiresAt: "2026-08-11T12:01:00.000Z",
    };
    chromeGlobal.chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: Listener) => listeners.add(listener),
          removeListener: (listener: Listener) => { listeners.delete(listener); },
        },
        sendMessage: async (message: unknown) => {
          sent.push(message);
          return { kind: "action-palette:open-surface-ack-result", accepted: true };
        },
      },
      storage: { session: { get: async () => ({ [ACTION_PALETTE_NAVIGATION_STORAGE_KEY]: expired }) } },
    } as unknown as typeof chrome;

    const received: string[] = [];
    const port = chromeSurfaceNavigationPort();
    const unsubscribe = port.subscribe((request) => received.push(`${request.id}:${request.screen}`));
    await Promise.resolve();
    expect(received).toEqual([]);

    const live = {
      ...expired,
      requestId: "navigation:live",
      navigationId: "live",
      screen: "activity",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const listener of listeners) listener(live);
    for (const listener of listeners) listener(live);
    expect(received).toEqual(["live:activity"]);
    expect(await port.acknowledge("live")).toBe(true);
    expect(sent).toEqual([{
      kind: "action-palette:open-surface-ack",
      requestId: "ack:live",
      navigationId: "live",
    }]);
    unsubscribe();
    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  test("advertises no navigation capability when the host supplies no surface adapter", () => {
    const entries: readonly ActionPaletteExecutorEntryV1[] = createExtensionActionPaletteExecutorsV1({
      exportPdf: exportRunner,
      exportDocx: exportRunner,
    });
    expect(entries.some((entry) => entry.capability === EXTENSION_ACTION_CAPABILITIES_V1.surface)).toBe(false);
    expect(entries.some((entry) => entry.actionId === ACTION_IDS.openActivity)).toBe(false);
    expect(entries.map((entry) => entry.actionId).sort()).toEqual([
      ACTION_IDS.exportDocxCurrentPage,
      ACTION_IDS.exportPdfCurrentPage,
    ].sort());
  });
});

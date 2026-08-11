import { afterEach, describe, expect, test } from "bun:test";
import { isStructuredCloneSafeV1 } from "@atlcli/action-registry";
import {
  actionPaletteInvalidRequest,
  isActionPaletteRequestCandidateV1,
  isActionPaletteRequestV1,
  type ActionPaletteMessageV1,
} from "../utils/action-palette/protocol.js";
import type { ExtMessage } from "../utils/messages.js";
import { chromeShortcutPort } from "../entrypoints/sidepanel/ports/shortcut.js";
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

describe("action palette protocol", () => {
  test("accepts every bounded request variant", () => {
    const requests = [
      { kind: "action-palette:toggle", requestId: "r1" },
      { kind: "action-palette:catalog", requestId: "r2", locale: "de-DE" },
      {
        kind: "action-palette:execute",
        requestId: "r3",
        catalogRevision: "revision:1",
        actionId: "atlcli.ai.quick-ask",
        locale: "en-US",
        input: { question: "What changed?" },
      },
      { kind: "action-palette:stream-control", requestId: "r4", executionId: "r3", command: "abort" },
      { kind: "action-palette:open-surface-ack", requestId: "r5", navigationId: "nav:1" },
      { kind: "action-palette:diagnostics", requestId: "r6" },
    ];
    expect(requests.map(isActionPaletteRequestV1)).toEqual([true, true, true, true, true, true]);
  });

  test("rejects every caller-supplied authority or private payload field", () => {
    const forbidden = [
      "siteOrigin", "url", "scope", "tenant", "tabId", "windowId", "host",
      "providerCredential", "exportRequest", "templateBytes", "researchRequest",
    ];
    for (const field of forbidden) {
      const spoofed = {
        kind: "action-palette:execute",
        requestId: `spoof:${field}`,
        catalogRevision: "revision:1",
        actionId: "atlcli.ai.quick-ask",
        locale: "en-US",
        [field]: field === "tabId" || field === "windowId" ? 7 : "attacker-value",
      };
      expect(isActionPaletteRequestCandidateV1(spoofed)).toBe(true);
      expect(isActionPaletteRequestV1(spoofed)).toBe(false);
    }
  });

  test("rejects unknown keys, invalid IDs/locales, oversized input, and prototype-bearing input", () => {
    expect(isActionPaletteRequestV1({ kind: "action-palette:catalog", requestId: "r", locale: "de_DE" })).toBe(false);
    expect(isActionPaletteRequestV1({ kind: "action-palette:toggle", requestId: "bad id" })).toBe(false);
    expect(isActionPaletteRequestV1({ kind: "action-palette:diagnostics", requestId: "r", verbose: true })).toBe(false);
    expect(isActionPaletteRequestV1({
      kind: "action-palette:execute", requestId: "r", catalogRevision: "rev",
      actionId: "atlcli.ai.quick-ask", locale: "en-US", input: { question: "x".repeat(10_001) },
    })).toBe(false);
    const inherited = Object.create({ question: "hidden" }) as Record<string, string>;
    expect(isActionPaletteRequestV1({
      kind: "action-palette:execute", requestId: "r", catalogRevision: "rev",
      actionId: "atlcli.ai.quick-ask", locale: "en-US", input: inherited,
    })).toBe(false);
  });

  test("keeps palette variants inside the extension discriminated union and clone-safe", () => {
    const palette: ActionPaletteMessageV1 = actionPaletteInvalidRequest("r1");
    const extension: ExtMessage = palette;
    expect(extension.kind).toBe("action-palette:error");
    expect(isStructuredCloneSafeV1(extension)).toBe(true);
    expect(structuredClone(extension)).toEqual(extension);
  });

  test("reports assigned and unbound Chrome shortcut states through the portable port", async () => {
    let shortcut = "Ctrl+Shift+K";
    const opened: chrome.tabs.CreateProperties[] = [];
    chromeGlobal.chrome = {
      commands: { getAll: async () => [{ name: "action-palette", shortcut }] },
      tabs: { create: async (properties: chrome.tabs.CreateProperties) => {
        opened.push(properties);
        return {} as chrome.tabs.Tab;
      } },
    } as unknown as typeof chrome;
    const port = chromeShortcutPort();
    expect(await port.getAssignment()).toEqual({
      commandId: "action-palette", status: "assigned", value: "Ctrl+Shift+K",
    });
    shortcut = "";
    expect(await port.getAssignment()).toEqual({
      commandId: "action-palette", status: "unbound", value: null,
    });
    await port.openSettings();
    expect(opened).toEqual([{ url: "chrome://extensions/shortcuts" }]);
  });

  test("delivers cold and live surface requests, acknowledges, and unsubscribes", async () => {
    type Listener = (message: unknown) => false;
    const listeners = new Set<Listener>();
    const removed: Listener[] = [];
    const sent: unknown[] = [];
    const cold = {
      kind: "action-palette:open-surface-request",
      requestId: "navigation:cold",
      navigationId: "cold",
      screen: "research",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    chromeGlobal.chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: Listener) => listeners.add(listener),
          removeListener: (listener: Listener) => { listeners.delete(listener); removed.push(listener); },
        },
        sendMessage: async (message: unknown) => {
          sent.push(message);
          return { kind: "action-palette:open-surface-ack-result", accepted: true };
        },
      },
      storage: { session: { get: async () => ({ [ACTION_PALETTE_NAVIGATION_STORAGE_KEY]: cold }) } },
    } as unknown as typeof chrome;
    const received: string[] = [];
    const port = chromeSurfaceNavigationPort();
    const unsubscribe = port.subscribe((request) => received.push(`${request.id}:${request.screen}`));
    await Promise.resolve();
    expect(received).toEqual(["cold:research"]);
    for (const listener of listeners) listener(cold);
    expect(received).toEqual(["cold:research"]);
    const live = { ...cold, requestId: "navigation:live", navigationId: "live", screen: "activity" };
    for (const listener of listeners) listener(live);
    expect(received).toEqual(["cold:research", "live:activity"]);
    expect(await port.acknowledge("live")).toBe(true);
    expect(sent).toEqual([{
      kind: "action-palette:open-surface-ack", requestId: "ack:live", navigationId: "live",
    }]);
    unsubscribe();
    unsubscribe();
    expect(listeners.size).toBe(0);
    expect(removed).toHaveLength(1);
  });
});

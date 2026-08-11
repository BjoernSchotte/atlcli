import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { SettingsScreen } from "../components/screens/SettingsScreen.js";
import { SettingsProvider } from "../components/app/settings-context.js";
import { I18nProvider } from "../utils/i18n/context.js";
import { memorySettingsStore } from "../utils/ports/settings.js";
import type { AppPorts } from "../utils/ports/index.js";
import type { ShortcutPort } from "../utils/ports/action-palette.js";
import type { ResearchPort } from "../utils/research/contracts.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

function screenProps(research: ResearchPort, shortcut?: ShortcutPort): ScreenProps {
  return {
    ports: {
      host: { kind: "test", name: "test", version: "1", capabilities: ["research"] },
      research,
      settings: memorySettingsStore(),
      ...(shortcut ? { shortcut } : {}),
    } as unknown as AppPorts,
    page: { status: "idle", token: 0, lastSeq: 0 },
    retry: () => undefined,
    navigate: () => undefined,
  };
}

describe("AI settings", () => {
  it("stores and forgets a BYOK key outside the research chat", async () => {
    let stored = false;
    let persistence: "session" | "device" = "session";
    const values: Array<{ value: string; persistence: "session" | "device" }> = [];
    const research: ResearchPort = {
      hasApiKey: async () => stored,
      getApiKeyPersistence: async () => persistence,
      setApiKey: async (value, options) => {
        persistence = options?.persistence ?? "session";
        values.push({ value, persistence });
        stored = true;
      },
      setApiKeyPersistence: async (value) => { persistence = value; },
      clearApiKey: async () => { stored = false; },
      resolveScope: async () => {
        throw new Error("Scope resolution is not part of settings.");
      },
      run: async () => {
        throw new Error("Research execution is not part of settings.");
      },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <SettingsProvider store={memorySettingsStore()}>
        <I18nProvider locale="en">
          <SettingsScreen {...screenProps(research)} />
        </I18nProvider>
      </SettingsProvider>,
    );
    await dom.setValue("settings-ai-key", "synthetic-key");
    expect(dom.find("settings-ai").textContent).toContain("not yet stored");
    await dom.click("settings-ai-remember-key");
    await dom.click("settings-ai-store-key");

    expect(values).toEqual([{ value: "synthetic-key", persistence: "device" }]);
    expect(dom.find("settings-ai").textContent).toContain("remembered on this device");
    expect(dom.find("settings-ai").textContent).toContain("local-model option");

    await dom.click("settings-ai-remember-key");
    expect(persistence).toBe("session");
    expect(dom.find("settings-ai").textContent).toContain("browser session");

    await dom.click("settings-ai-forget-key");
    expect(stored).toBe(false);
  });
});

describe("action palette shortcut settings", () => {
  const research: ResearchPort = {
    hasApiKey: async () => false,
    getApiKeyPersistence: async () => "session",
    setApiKey: async () => undefined,
    setApiKeyPersistence: async () => undefined,
    clearApiKey: async () => undefined,
    resolveScope: async () => { throw new Error("not used"); },
    run: async () => { throw new Error("not used"); },
    copyMarkdown: async () => undefined,
    downloadMarkdown: async () => undefined,
  };

  it("shows the actual assignment and opens Chrome's shortcut settings", async () => {
    let opened = 0;
    const shortcut: ShortcutPort = {
      getAssignment: async () => ({
        commandId: "action-palette",
        status: "assigned",
        value: "Command+Shift+K",
      }),
      openSettings: async () => { opened += 1; },
    };
    await dom.render(
      <SettingsProvider store={memorySettingsStore()}>
        <I18nProvider locale="en">
          <SettingsScreen {...screenProps(research, shortcut)} />
        </I18nProvider>
      </SettingsProvider>,
    );
    await dom.flush();
    expect(dom.find("settings-shortcut-value").textContent).toBe("Command+Shift+K");
    expect(dom.find("settings-shortcut").textContent).toContain("Chrome currently opens");
    await dom.click("settings-shortcut-open");
    expect(opened).toBe(1);
  });

  it("labels an unbound command honestly", async () => {
    const shortcut: ShortcutPort = {
      getAssignment: async () => ({ commandId: "action-palette", status: "unbound", value: null }),
      openSettings: async () => undefined,
    };
    await dom.render(
      <SettingsProvider store={memorySettingsStore()}>
        <I18nProvider locale="en">
          <SettingsScreen {...screenProps(research, shortcut)} />
        </I18nProvider>
      </SettingsProvider>,
    );
    await dom.flush();
    expect(dom.find("settings-shortcut-value").textContent).toBe("Unbound");
    expect(dom.find("settings-shortcut").textContent).toContain("No shortcut is assigned");
  });
});

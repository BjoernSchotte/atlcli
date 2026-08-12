import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { SettingsScreen } from "../components/screens/SettingsScreen.js";
import { SettingsProvider } from "../components/app/settings-context.js";
import { I18nProvider } from "../utils/i18n/context.js";
import { memorySettingsStore } from "../utils/ports/settings.js";
import type { AppPorts } from "../utils/ports/index.js";
import type { ResearchPort } from "../utils/research/contracts.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import { createReactHarness } from "./react-harness.js";
import {
  ANTHROPIC_BROWSER_MODEL_SELECTION_V1,
  browserModelSelectionKey,
  LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
} from "../utils/local-model/selection.js";
import type {
  BrowserLocalModelPortV1,
  BrowserLocalModelStateV1,
} from "../utils/local-model/storage.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => expect(dom.leakedGlobals()).toEqual([]));

function screenProps(
  research: ResearchPort,
  localModel?: BrowserLocalModelPortV1,
): ScreenProps {
  return {
    ports: {
      host: { kind: "test", name: "test", version: "1", capabilities: ["research"] },
      research,
      localModel,
      settings: memorySettingsStore(),
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
    expect(dom.find("settings-ai-model").textContent).toContain("Gemma 4 E4B (local)");

    await dom.click("settings-ai-remember-key");
    expect(persistence).toBe("session");
    expect(dom.find("settings-ai").textContent).toContain("browser session");

    await dom.click("settings-ai-forget-key");
    expect(stored).toBe(false);
  });

  it("defaults to Anthropic and persists the exact local Gemma selection", async () => {
    const store = memorySettingsStore();
    let localState: BrowserLocalModelStateV1 = { status: "not-installed" };
    const listeners = new Set<(state: BrowserLocalModelStateV1) => void>();
    let installCalls = 0;
    const localModel: BrowserLocalModelPortV1 = {
      status: async () => localState,
      install: async () => {
        installCalls += 1;
        localState = {
          status: "installing",
          receivedBytes: 1,
          totalBytes: 2,
          currentFile: "config.json",
        };
        for (const listener of listeners) listener(localState);
        await Promise.resolve();
        localState = { status: "ready", aggregateByteLength: 2 };
        for (const listener of listeners) listener(localState);
        return localState;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        listener(localState);
        return () => listeners.delete(listener);
      },
    };
    const research: ResearchPort = {
      hasApiKey: async () => false,
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      resolveScope: async () => { throw new Error("unused"); },
      run: async () => { throw new Error("unused"); },
      copyMarkdown: async () => undefined,
      downloadMarkdown: async () => undefined,
    };
    await dom.render(
      <SettingsProvider store={store}>
        <I18nProvider locale="en">
          <SettingsScreen {...screenProps(research, localModel)} />
        </I18nProvider>
      </SettingsProvider>,
    );

    expect((dom.find("settings-ai-model") as HTMLSelectElement).value).toBe(
      browserModelSelectionKey(ANTHROPIC_BROWSER_MODEL_SELECTION_V1),
    );
    expect(dom.maybeFind("settings-ai-anthropic")).not.toBeNull();

    await dom.setValue(
      "settings-ai-model",
      browserModelSelectionKey(LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1),
    );

    expect(dom.maybeFind("settings-ai-anthropic")).toBeNull();
    expect(dom.find("settings-ai-local-gemma").textContent).toContain(
      "runs locally in this browser",
    );
    expect(dom.maybeFind("settings-ai-local-install")).not.toBeNull();
    await dom.click("settings-ai-local-install");
    expect(installCalls).toBe(1);
    expect(dom.find("settings-ai-local-ready").textContent).toContain(
      "installed and verified",
    );
    expect((await store.load()).modelSelection).toEqual(
      LOCAL_GEMMA_BROWSER_MODEL_SELECTION_V1,
    );
  });
});

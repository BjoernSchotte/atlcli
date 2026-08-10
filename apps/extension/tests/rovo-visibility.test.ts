import { describe, expect, it } from "bun:test";
import {
  ROVO_HIDDEN_ATTRIBUTE,
  applyRovoVisibility,
  watchRovoVisibility,
  type RovoVisibilitySettingsSource,
} from "../utils/rovo-visibility.js";
import type { AppSettings } from "../utils/ports/settings.js";

class FakeRoot {
  readonly attributes = new Set<string>();

  toggleAttribute(name: string, force?: boolean): boolean {
    const present = force ?? !this.attributes.has(name);
    if (present) this.attributes.add(name);
    else this.attributes.delete(name);
    return present;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

function settings(hideRovoEntrypoints: boolean): AppSettings {
  return { locale: null, lastWorkspace: null, hideRovoEntrypoints };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Rovo visibility core", () => {
  it("projects the setting onto one owned root attribute", () => {
    const root = new FakeRoot();
    applyRovoVisibility(root as unknown as Element, true);
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(true);
    applyRovoVisibility(root as unknown as Element, false);
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(false);
  });

  it("applies the initial value and live changes without observing the DOM", async () => {
    const root = new FakeRoot();
    const callback: { current?: (value: AppSettings) => void } = {};
    let unsubscribed = false;
    const source: RovoVisibilitySettingsSource = {
      load: async () => settings(true),
      subscribe: (next) => {
        callback.current = next;
        return () => {
          unsubscribed = true;
        };
      },
    };

    const stop = watchRovoVisibility(root as unknown as Element, source);
    await flush();
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(true);

    callback.current?.(settings(false));
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(false);
    callback.current?.(settings(true));
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(true);

    stop();
    stop();
    expect(unsubscribed).toBe(true);
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(false);
  });

  it("does not let a stale initial read overwrite a newer storage event", async () => {
    const root = new FakeRoot();
    let resolveLoad!: (value: AppSettings) => void;
    const load = new Promise<AppSettings>((resolve) => {
      resolveLoad = resolve;
    });
    const callback: { current?: (value: AppSettings) => void } = {};
    const source: RovoVisibilitySettingsSource = {
      load: () => load,
      subscribe: (next) => {
        callback.current = next;
        return () => undefined;
      },
    };

    watchRovoVisibility(root as unknown as Element, source);
    callback.current?.(settings(true));
    resolveLoad(settings(false));
    await flush();

    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(true);
  });

  it("fails open when the initial storage read rejects", async () => {
    const root = new FakeRoot();
    root.toggleAttribute(ROVO_HIDDEN_ATTRIBUTE, true);
    const source: RovoVisibilitySettingsSource = {
      load: async () => {
        throw new Error("storage unavailable");
      },
      subscribe: () => () => undefined,
    };

    watchRovoVisibility(root as unknown as Element, source);
    await flush();
    expect(root.hasAttribute(ROVO_HIDDEN_ATTRIBUTE)).toBe(false);
  });
});

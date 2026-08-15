import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SETTINGS,
  memorySettingsStore,
  normalizeSettings,
} from "../utils/ports/settings.js";

describe("app settings", () => {
  it("keeps legacy records visible by default", () => {
    expect(normalizeSettings({ locale: "de" })).toEqual({
      locale: "de",
      lastWorkspace: null,
      hideRovoEntrypoints: false,
    });
  });

  it("accepts only an explicit boolean true for Rovo hiding", () => {
    expect(
      normalizeSettings({ locale: "en", hideRovoEntrypoints: true })
    ).toEqual({
      locale: "en",
      lastWorkspace: null,
      hideRovoEntrypoints: true,
    });
    expect(
      normalizeSettings({ locale: "en", hideRovoEntrypoints: "true" })
    ).toEqual({
      locale: "en",
      lastWorkspace: null,
      hideRovoEntrypoints: false,
    });
  });

  it("falls back safely for malformed records", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({ locale: "fr", hideRovoEntrypoints: 1 })
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("persists the combined workspace and Rovo settings through the memory port", async () => {
    const store = memorySettingsStore();
    await store.save({ locale: "de", lastWorkspace: "ai", hideRovoEntrypoints: true });
    expect(await store.load()).toEqual({
      locale: "de",
      lastWorkspace: "ai",
      hideRovoEntrypoints: true,
    });
  });
});

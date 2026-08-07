import { describe, expect, test } from "bun:test";
import {
  browserApiKeyPersistenceV1,
  changeBrowserApiKeyPersistenceV1,
  clearBrowserApiKeyV1,
  readBrowserApiKeyV1,
  storeBrowserApiKeyV1,
  type BrowserCredentialStorageAreaV1,
  type BrowserCredentialStorageV1,
} from "../utils/research/browser-credential-storage.js";
import {
  RESEARCH_ANTHROPIC_DEVICE_KEY,
  RESEARCH_ANTHROPIC_SESSION_KEY,
} from "../utils/research/credential.js";

class MemoryArea implements BrowserCredentialStorageAreaV1 {
  readonly values = new Map<string, unknown>();
  readonly accessLevels: string[] = [];

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      selected.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> {
    this.accessLevels.push(options.accessLevel);
  }
}

function memoryStorage(): BrowserCredentialStorageV1 & {
  session: MemoryArea;
  local: MemoryArea;
} {
  return { session: new MemoryArea(), local: new MemoryArea() };
}

describe("browser credential persistence", () => {
  test("keeps session-only storage as the default and removes durable residue", async () => {
    const storage = memoryStorage();
    storage.local.values.set(RESEARCH_ANTHROPIC_DEVICE_KEY, "stale-device-key");

    await storeBrowserApiKeyV1(storage, "session-key", "session");

    expect(storage.session.values.get(RESEARCH_ANTHROPIC_SESSION_KEY)).toBe("session-key");
    expect(storage.local.values.has(RESEARCH_ANTHROPIC_DEVICE_KEY)).toBe(false);
    expect(await browserApiKeyPersistenceV1(storage)).toBe("session");
  });

  test("rehydrates an explicitly remembered key after session storage is cleared", async () => {
    const storage = memoryStorage();
    await storeBrowserApiKeyV1(storage, "device-key", "device");
    storage.session.values.clear();

    expect(await readBrowserApiKeyV1(storage)).toBe("device-key");
    expect(storage.session.values.get(RESEARCH_ANTHROPIC_SESSION_KEY)).toBe("device-key");
    expect(await browserApiKeyPersistenceV1(storage)).toBe("device");
    expect(storage.local.accessLevels).toContain("TRUSTED_CONTEXTS");
    expect(storage.session.accessLevels).toContain("TRUSTED_CONTEXTS");
  });

  test("migrates an existing key in either direction without returning it to the UI", async () => {
    const storage = memoryStorage();
    await storeBrowserApiKeyV1(storage, "migration-key", "session");

    await changeBrowserApiKeyPersistenceV1(storage, "device");
    expect(storage.local.values.get(RESEARCH_ANTHROPIC_DEVICE_KEY)).toBe("migration-key");

    await changeBrowserApiKeyPersistenceV1(storage, "session");
    expect(storage.local.values.has(RESEARCH_ANTHROPIC_DEVICE_KEY)).toBe(false);
    expect(storage.session.values.get(RESEARCH_ANTHROPIC_SESSION_KEY)).toBe("migration-key");
  });

  test("forget removes both session and device copies", async () => {
    const storage = memoryStorage();
    await storeBrowserApiKeyV1(storage, "forgotten-key", "device");

    await clearBrowserApiKeyV1(storage);

    expect(await readBrowserApiKeyV1(storage)).toBeUndefined();
    expect(storage.session.values.size).toBe(0);
    expect(storage.local.values.size).toBe(0);
  });
});

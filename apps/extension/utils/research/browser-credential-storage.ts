import {
  RESEARCH_ANTHROPIC_DEVICE_KEY,
  RESEARCH_ANTHROPIC_SESSION_KEY,
  normalizeAnthropicApiKey,
} from "./credential.js";

export type BrowserApiKeyPersistenceV1 = "session" | "device";

export interface BrowserCredentialStorageAreaV1 {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface BrowserCredentialStorageV1 {
  session: BrowserCredentialStorageAreaV1;
  local: BrowserCredentialStorageAreaV1;
}

export function chromeBrowserCredentialStorageV1(): BrowserCredentialStorageV1 {
  return {
    session: {
      get: (keys) => chrome.storage.session.get(keys),
      set: (items) => chrome.storage.session.set(items),
      remove: (keys) => chrome.storage.session.remove(keys),
      setAccessLevel: (options) => chrome.storage.session.setAccessLevel(options),
    },
    local: {
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
      setAccessLevel: (options) => chrome.storage.local.setAccessLevel(options),
    },
  };
}

async function restrictCredentialStorageV1(
  storage: BrowserCredentialStorageV1,
): Promise<void> {
  await Promise.all([
    storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

async function readValidKeyV1(
  area: BrowserCredentialStorageAreaV1,
  key: string,
): Promise<string | undefined> {
  const stored = await area.get(key);
  const value = stored[key];
  if (value === undefined) return undefined;
  try {
    return normalizeAnthropicApiKey(value);
  } catch {
    await area.remove(key);
    return undefined;
  }
}

/**
 * Resolve the current credential without ever exposing it to content scripts.
 * A durable opt-in key is copied into memory so existing worker call paths keep
 * the same session-only hand-off contract.
 */
export async function readBrowserApiKeyV1(
  storage: BrowserCredentialStorageV1,
): Promise<string | undefined> {
  await restrictCredentialStorageV1(storage);
  const session = await readValidKeyV1(storage.session, RESEARCH_ANTHROPIC_SESSION_KEY);
  if (session) return session;
  const device = await readValidKeyV1(storage.local, RESEARCH_ANTHROPIC_DEVICE_KEY);
  if (!device) return undefined;
  await storage.session.set({ [RESEARCH_ANTHROPIC_SESSION_KEY]: device });
  return device;
}

export async function browserApiKeyPersistenceV1(
  storage: BrowserCredentialStorageV1,
): Promise<BrowserApiKeyPersistenceV1> {
  await restrictCredentialStorageV1(storage);
  return await readValidKeyV1(storage.local, RESEARCH_ANTHROPIC_DEVICE_KEY)
    ? "device"
    : "session";
}

export async function storeBrowserApiKeyV1(
  storage: BrowserCredentialStorageV1,
  apiKeyValue: unknown,
  persistence: BrowserApiKeyPersistenceV1,
): Promise<void> {
  await restrictCredentialStorageV1(storage);
  const apiKey = normalizeAnthropicApiKey(apiKeyValue);
  await storage.session.set({ [RESEARCH_ANTHROPIC_SESSION_KEY]: apiKey });
  if (persistence === "device") {
    await storage.local.set({ [RESEARCH_ANTHROPIC_DEVICE_KEY]: apiKey });
  } else {
    await storage.local.remove(RESEARCH_ANTHROPIC_DEVICE_KEY);
  }
}

export async function changeBrowserApiKeyPersistenceV1(
  storage: BrowserCredentialStorageV1,
  persistence: BrowserApiKeyPersistenceV1,
): Promise<void> {
  const apiKey = await readBrowserApiKeyV1(storage);
  if (!apiKey) return;
  await storeBrowserApiKeyV1(storage, apiKey, persistence);
}

export async function clearBrowserApiKeyV1(
  storage: BrowserCredentialStorageV1,
): Promise<void> {
  await restrictCredentialStorageV1(storage);
  await Promise.all([
    storage.session.remove(RESEARCH_ANTHROPIC_SESSION_KEY),
    storage.local.remove(RESEARCH_ANTHROPIC_DEVICE_KEY),
  ]);
}

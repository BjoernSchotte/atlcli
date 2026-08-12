import type { ChatHostIdentityV1 } from "@atlcli/research";

export const ACTIVE_CHAT_CONVERSATION_KEY =
  "atlcli.research.active-chat-conversation-id.v1";
export const CHAT_HOST_PRINCIPAL_KEY = "atlcli.chat.host-principal-id.v1";
export const CHAT_HOST_PRINCIPAL_PATTERN = /^browser-principal:[0-9a-f-]{36}$/u;
export const CHAT_CONVERSATION_ID_PATTERN =
  /^research-session:[A-Za-z0-9._-]{1,120}$/u;

export interface BrowserChatIdentityStorageV1 {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

/** Stable browser principal shared by sidebar and background Chat adapters. */
export async function browserChatHostIdentityV1(
  storage: BrowserChatIdentityStorageV1 = chrome.storage.local,
): Promise<ChatHostIdentityV1> {
  const stored = await storage.get(CHAT_HOST_PRINCIPAL_KEY);
  const storedUserId = stored[CHAT_HOST_PRINCIPAL_KEY];
  let userId: string;
  if (typeof storedUserId === "string" && CHAT_HOST_PRINCIPAL_PATTERN.test(storedUserId)) {
    userId = storedUserId;
  } else {
    userId = `browser-principal:${crypto.randomUUID()}`;
    await storage.set({ [CHAT_HOST_PRINCIPAL_KEY]: userId });
  }
  return {
    userId,
    providerCacheIdentity: `anthropic:${userId}`,
  };
}

export async function activeBrowserChatConversationIdV1(
  storage: BrowserChatIdentityStorageV1 = chrome.storage.local,
): Promise<string | undefined> {
  const stored = await storage.get(ACTIVE_CHAT_CONVERSATION_KEY);
  const candidate = stored[ACTIVE_CHAT_CONVERSATION_KEY];
  return typeof candidate === "string" && CHAT_CONVERSATION_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

export const BROWSER_CHAT_CALLER_PATH_SIDEPANEL_V1 = [
  "research-screen",
  "sidepanel-port",
] as const;

export const BROWSER_CHAT_CALLER_PATH_BACKGROUND_V1 = [
  ...BROWSER_CHAT_CALLER_PATH_SIDEPANEL_V1,
  "background",
] as const;

export const BROWSER_CHAT_CALLER_PATH_OFFSCREEN_V1 = [
  ...BROWSER_CHAT_CALLER_PATH_BACKGROUND_V1,
  "offscreen",
] as const;

export const BROWSER_CHAT_CALLER_PATH_WORKER_V1 = [
  ...BROWSER_CHAT_CALLER_PATH_OFFSCREEN_V1,
  "research-worker",
] as const;

export type BrowserChatCallerPathSidepanelV1 =
  typeof BROWSER_CHAT_CALLER_PATH_SIDEPANEL_V1;
export type BrowserChatCallerPathBackgroundV1 =
  typeof BROWSER_CHAT_CALLER_PATH_BACKGROUND_V1;
export type BrowserChatCallerPathOffscreenV1 =
  typeof BROWSER_CHAT_CALLER_PATH_OFFSCREEN_V1;
export type BrowserChatCallerPathWorkerV1 =
  typeof BROWSER_CHAT_CALLER_PATH_WORKER_V1;

export function isBrowserChatCallerPathV1(
  value: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((stage, index) => stage === expected[index]);
}

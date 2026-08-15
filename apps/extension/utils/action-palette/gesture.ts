import { ACTION_IDS } from "@atlcli/action-registry";
import type { ActionPaletteSenderV1 } from "./context.js";
import { isActionPaletteRequestV1 } from "./protocol.js";

const SURFACE_ACTION_IDS = new Set<string>([
  ACTION_IDS.configureDocx,
  ACTION_IDS.openSidebar,
  ACTION_IDS.openPublishing,
  ACTION_IDS.openResearch,
  ACTION_IDS.openActivity,
]);

/**
 * Open Chrome's non-sensitive side-panel shell synchronously while the
 * content-script gesture is still live. Target-screen delivery remains behind
 * the asynchronous authoritative broker and its one-shot mailbox.
 */
export function openActionPaletteSidePanelForGestureV1(
  message: unknown,
  sender: ActionPaletteSenderV1,
  open: (tabId: number) => void,
): boolean {
  if (!isActionPaletteRequestV1(message) || message.kind !== "action-palette:execute" ||
      !SURFACE_ACTION_IDS.has(message.actionId) || sender.frameId !== 0 ||
      !Number.isSafeInteger(sender.tabId) || sender.tabId < 0 || !sender.documentId ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/iu.test(sender.origin)) {
    return false;
  }
  open(sender.tabId);
  return true;
}

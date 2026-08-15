import type { ShortcutPort } from "../../../utils/ports/index.js";

export const ACTION_PALETTE_COMMAND_ID = "action-palette";

export function chromeShortcutPort(): ShortcutPort {
  return {
    async getAssignment() {
      const commands = await chrome.commands.getAll();
      const command = commands.find((candidate) => candidate.name === ACTION_PALETTE_COMMAND_ID);
      const value = command?.shortcut?.trim() || null;
      return {
        commandId: ACTION_PALETTE_COMMAND_ID,
        status: value ? "assigned" : "unbound",
        value,
      };
    },
    async openSettings() {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    },
  };
}

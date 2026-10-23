import type { VfsLogger } from "@atlcli/confluence-vfs";

/**
 * The VFS logger for `wiki sh` and `wiki mount`: warnings and errors go to
 * stderr, where the user sees them (#299). Without it the VFS logs nowhere, and
 * a warning such as "this page does not round-trip through Markdown" is lost.
 */
export const stderrVfsLogger: VfsLogger = {
  debug() {},
  info() {},
  warn(message) {
    process.stderr.write(`atlcli: warning: ${message}\n`);
  },
  error(message) {
    process.stderr.write(`atlcli: error: ${message}\n`);
  },
};

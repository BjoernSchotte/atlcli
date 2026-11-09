import { existsSync } from "node:fs";
import { copyFile, rename, rm, unlink } from "node:fs/promises";

/**
 * Move the current binary aside, run `install` (which must produce
 * `targetPath`), and put the old binary back if `install` throws — a failed
 * extraction must not leave the user without an executable.
 *
 * Kept out of `update.ts` because that module is `export *`-ed from the public
 * barrel; this is an internal helper.
 */
export async function swapBinary(
  targetPath: string,
  backupPath: string,
  install: () => Promise<void>
): Promise<void> {
  const hadBinary = existsSync(targetPath);
  if (hadBinary) {
    try {
      await rename(targetPath, backupPath);
    } catch {
      // If rename fails, try copy + delete
      await copyFile(targetPath, backupPath);
      await unlink(targetPath);
    }
  }

  try {
    await install();
  } catch (error) {
    if (hadBinary) {
      try {
        await rm(targetPath, { force: true });
        await rename(backupPath, targetPath);
      } catch {
        // Keep the original failure; the backup is still at backupPath.
      }
    }
    throw error;
  }
}

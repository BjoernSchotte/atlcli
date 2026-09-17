import { posix } from "node:path";
import type { ConfluenceVfs } from "@atlcli/confluence-vfs";
import type { NfsJournal } from "./nfs-journal.js";

/** Finish only a positively identified move; never resend an uncertain reparent. */
export async function reconcileNfsMove(vfs: ConfluenceVfs, journal: NfsJournal, source: string): Promise<boolean> {
  const move = journal.moveIntent(source);
  if (!move) return false;
  const targetSpace = move.target.split("/")[1]!;
  const confirmed = () => vfs.confirmMove(move.id, targetSpace, move.targetParentId, move.title, move.kind);
  if (await confirmed()) { journal.completeMove(source); return true; }
  if (move.completed || move.kind !== "page" || move.sourceTitle === null ||
      move.sourceTitle === move.title || move.sourceParentId === move.targetParentId) return false;
  if (!await vfs.confirmMove(move.id, targetSpace, move.targetParentId, move.sourceTitle, move.kind)) return false;
  const intermediate = posix.join(posix.dirname(move.target), posix.basename(move.source));
  await vfs.rename(intermediate, move.target, { id: move.id, spaceKey: targetSpace,
    sourceParentId: move.targetParentId, targetParentId: move.targetParentId, kind: "page" });
  if (!await confirmed()) return false;
  journal.completeMove(source);
  return true;
}

/**
 * The single gate every mutating operation passes through (WP1.7).
 *
 * Centralised on purpose: `ro` has to hold on *every* route — just-bash, the
 * WebDAV adapter and the extra commands alike — and the only way to keep that
 * true as routes are added is for there to be exactly one function that can
 * say yes. WP9.1 audits that nothing calls the REST client's write methods
 * without coming through here.
 */
import type { VfsMode } from "./options.js";
import { VfsError } from "./types.js";

/** Every mutating operation the VFS exposes. */
export type WriteOp =
  | "create"
  | "update"
  | "mkdir"
  | "rename"
  | "move"
  | "copy"
  | "delete"
  | "upload-attachment"
  | "delete-attachment";

/** Operations that put content in the trash, gated a second time by `allowDelete`. */
const DELETE_OPS = new Set<WriteOp>(["delete", "delete-attachment"]);

const OP_LABEL: Record<WriteOp, string> = {
  create: "create a page",
  update: "update a page",
  mkdir: "create a page for a new directory",
  rename: "rename a page",
  move: "move a page",
  copy: "copy a page",
  delete: "send a page to the trash",
  "upload-attachment": "upload an attachment",
  "delete-attachment": "delete an attachment",
};

export interface ModeGuard {
  mode: VfsMode;
  allowDelete: boolean;
}

/**
 * Throws unless `op` is permitted.
 *
 * `EROFS` for the mode, `EACCES` for the delete gate: they are different
 * refusals and an agent should be able to tell them apart without reading the
 * message. Both messages name the flag that would grant it, because an agent
 * that cannot see the fix will retry the same call.
 */
export function assertWritable(guard: ModeGuard, op: WriteOp, path?: string): void {
  if (guard.mode !== "rw") {
    throw new VfsError(
      "EROFS",
      `Read-only filesystem: cannot ${OP_LABEL[op]}${path ? ` at ${path}` : ""}. Start the VFS with --mode rw to allow writes`,
      { path },
    );
  }
  if (DELETE_OPS.has(op) && !guard.allowDelete) {
    throw new VfsError(
      "EACCES",
      `Deletion is not enabled: cannot ${OP_LABEL[op]}${path ? ` at ${path}` : ""}. Add --allow-delete (deletion moves the page to the trash; it is never a purge)`,
      { path },
    );
  }
}

/** Non-throwing form, for a frontend deciding whether to advertise a capability. */
export function isWritable(guard: ModeGuard, op: WriteOp): boolean {
  if (guard.mode !== "rw") return false;
  return !DELETE_OPS.has(op) || guard.allowDelete;
}

/**
 * Refusal for the parts of the tree that are read-only whatever the mode:
 * `.versions/`, `.labels/`, `.recent/`, `.search/`, `_space.json`, `.me.json`
 * and the `_index.md` of a Confluence folder (folders have no body).
 */
export function assertNotStructurallyReadOnly(path: string, reason: string): never {
  throw new VfsError("EROFS", `Read-only: ${reason} (${path})`, { path });
}

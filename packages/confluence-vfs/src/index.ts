/**
 * `@atlcli/confluence-vfs` — Confluence as a filesystem, as a functional core.
 *
 * The package knows nothing about just-bash, WebDAV or the CLI. It exposes one
 * asynchronous interface ({@link ConfluenceVfs}) that both frontends adapt, and
 * it throws exactly one error type ({@link VfsError}).
 *
 * See `specs/confluence-virtual-filesystem/PLAN.md` for the design, and in
 * particular section 1b, whose demand principle every module here has to hold:
 * the VFS is a cache, not a mirror.
 */
export type { VfsClient } from "./client-port.js";
export {
  httpStatusOf,
  mapClientError,
  retryAfterMsOf,
  withRateLimitRetry,
  type RateLimitRetryOptions,
} from "./errors.js";
export {
  assertNotStructurallyReadOnly,
  assertWritable,
  isWritable,
  type ModeGuard,
  type WriteOp,
} from "./mode.js";
export {
  resolveVfsOptions,
  VFS_DEFAULTS,
  type ResolvedVfsOptions,
  type VfsLogger,
  type VfsMode,
  type VfsOptions,
} from "./options.js";
export {
  isVfsError,
  VfsError,
  type VfsDirent,
  type VfsErrorCode,
  type VfsNode,
  type VfsNodeKind,
  type VfsStat,
} from "./types.js";
export type { ConfluenceVfs, VfsWriteResult } from "./vfs.js";

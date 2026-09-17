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
export { AuditLog, type AuditEntry } from "./audit-log.js";
export {
  BodyCache,
  hashStorage,
  normalizeStorage,
  identityPathFor,
  recallIdentity,
  rememberIdentity,
  resolveCachePaths,
  siteHashOf,
  type BodyCacheOptions,
  type CacheStats,
  type CachedAttachment,
  type CachedBody,
} from "./body-cache.js";
export {
  ConflictStore,
  type ConflictRecord,
} from "./conflict-store.js";
export {
  assertNotReserved,
  ConfluenceVfsImpl,
  type VfsRuntime,
} from "./confluence-vfs.js";
export { WriteBack, type WriteBackOptions } from "./write-back.js";
export {
  PageStore,
  parseVfsFrontmatter,
  renderFrontmatter,
  renderPageMarkdown,
  toStorage,
  type PageStoreOptions,
  type VfsFrontmatter,
} from "./page-store.js";
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
  formatDirName,
  formatName,
  INDEX_FILE,
  joinPath,
  normalizePath,
  parseName,
  RESERVED_NAMES,
  resolveNameToId,
  splitParent,
  splitPath,
  stripVfsExtension,
  titleFromName,
  vfsSlug,
  type ParsedName,
} from "./path-mapper.js";
export {
  canonicalPathOf,
  hasBody,
  isContainer,
  PathResolver,
  RECENT_WINDOWS,
  type MissingLeaf,
  type RecentWindow,
  type Resolved,
  type ResolveResult,
} from "./resolver.js";
export {
  TreeIndex,
  type TreeIndexOptions,
  type TreeNode,
} from "./tree-index.js";
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
export {
  MAX_REMEMBERED_QUERIES,
  MAX_VERSIONS_LISTED,
  renderComments,
  VirtualDirs,
  type VirtualDirsOptions,
} from "./virtual-dirs.js";
export type { ConfluenceVfs, VfsWriteResult, VfsWriteCondition } from "./vfs.js";

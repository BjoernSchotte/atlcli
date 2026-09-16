/**
 * Core value types for the Confluence virtual filesystem.
 *
 * These are the vocabulary the functional core speaks. Nothing here knows about
 * just-bash, WebDAV, the CLI or `node:fs` — the frontends translate (spec
 * `specs/confluence-virtual-filesystem/PLAN.md`, section 4).
 */

/** What a resolved path turned out to be. */
export type VfsNodeKind =
  | "space"
  | "page"
  | "folder"
  | "attachment"
  | "virtual-dir"
  | "virtual-file"
  | "symlink";

/**
 * A resolved node.
 *
 * `size` is optional on purpose: rule 2 of the demand principle forbids a body
 * fetch just to answer `stat`, so the exact byte length is only known once a
 * body has actually been read. See {@link VfsStat} for what callers get instead.
 */
export interface VfsNode {
  kind: VfsNodeKind;
  /** Confluence ID for pages, folders, attachments and spaces; synthetic for virtual nodes. */
  id: string;
  title: string;
  /** `slugifyTitle(title)`; present for readability only, never used to resolve. */
  slug: string;
  /** Page version number. Absent for nodes that do not version (virtual dirs). */
  version?: number;
  parentId?: string;
  /** Space key the node lives in; absent at the filesystem root. */
  spaceKey?: string;
  mtime: Date;
  size?: number;
  /** Target path for `kind: "symlink"`, absolute inside the VFS. */
  target?: string;
  /** True when the node may never be written, whatever the mode. */
  readOnly?: boolean;
}

/** The subset of `fs.Stats` the frontends need. */
export interface VfsStat {
  kind: VfsNodeKind;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
  /** True when {@link size} is a guess rather than a measured body length. */
  sizeEstimated: boolean;
  mtime: Date;
  mode: number;
  /** Confluence ID, so a frontend can build an ETag without a second lookup. */
  id: string;
  version?: number;
}

/** One entry of a `readdir`, carrying enough type information to skip a `stat`. */
export interface VfsDirent {
  name: string;
  kind: VfsNodeKind;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * The error codes the core raises.
 *
 * Deliberately POSIX: both frontends already have a mapping for these, and an
 * agent reading `EROFS` knows what happened without reading our documentation.
 */
export type VfsErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EROFS"
  | "EISDIR"
  | "ENOTDIR"
  | "EEXIST"
  | "EBUSY"
  | "ENOTEMPTY"
  | "EINVAL"
  | "ENOSPC"
  | "EAGAIN";

/**
 * Every failure leaving the core is one of these.
 *
 * `code` is what a frontend switches on; `message` is what a human or an agent
 * reads, so it should always name the next action where one exists.
 */
export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path: string | undefined;
  /** HTTP status this was mapped from, when it came from the REST client. */
  readonly status: number | undefined;
  override readonly cause: unknown;

  constructor(
    code: VfsErrorCode,
    message: string,
    options: { path?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "VfsError";
    this.code = code;
    this.path = options.path;
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Narrowing helper, since `instanceof` breaks across bundle boundaries. */
export function isVfsError(value: unknown): value is VfsError {
  return (
    value instanceof VfsError ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "VfsError" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}

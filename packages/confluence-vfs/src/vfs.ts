/**
 * The narrow asynchronous API both frontends sit on.
 *
 * Every method takes an absolute VFS path (`/DOCSY/architecture-62.../_index.md`)
 * and throws {@link VfsError} on failure — never a bare `Error`, never a REST
 * error object. That is the whole contract: `apps/cli/src/vfs/just-bash-fs.ts`
 * and `apps/cli/src/vfs/webdav-fs.ts` are adapters over these ten methods.
 */
import type { ModeGuard } from "./mode.js";
import type { VfsDirent, VfsNode, VfsStat } from "./types.js";

export interface VfsWriteResult {
  /** The canonical path after the write, which differs when a page was created. */
  path: string;
  pageId: string;
  version: number;
  /** True when this call created the page rather than updating one. */
  created: boolean;
}

export type VfsWriteCondition =
  | { id: string; spaceKey: string }
  | { createOnly: true; spaceKey: string; parentId: string };

export interface ConfluenceVfs {
  readonly guard: ModeGuard;

  /** Metadata for one path. Never fetches a body (demand principle, rule 2). */
  stat(path: string): Promise<VfsStat>;

  /** Directory entries, names only, one API request per directory at most. */
  readdir(path: string): Promise<VfsDirent[]>;

  /** Markdown (or JSON, for the `_space.json` style nodes) of one file. */
  readFile(path: string): Promise<string>;

  /** Raw bytes, the path attachments take. */
  readFileBytes(path: string): Promise<Uint8Array>;

  /** Create or update a page. Throws `EROFS` in `ro` mode.
   * An ID condition only updates that page; createOnly only creates under the specified parent. */
  writeFile(path: string, content: string | Uint8Array, condition?: VfsWriteCondition): Promise<VfsWriteResult>;

  /** Create a page with an empty body (decision 7). Throws `EROFS` in `ro` mode. */
  mkdir(path: string): Promise<VfsWriteResult>;

  /** Retitle, reparent or move across spaces, depending on what changed. */
  rename(from: string, to: string): Promise<void>;

  /** Move to trash. Needs `mode: "rw"` *and* `allowDelete`. Never purges. */
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;

  /** Copy a page through the existing `copyPage` endpoint. */
  copy(from: string, to: string): Promise<VfsWriteResult>;

  /** Symlink target for the convenience directories, absolute inside the VFS. */
  readlink(path: string): Promise<string>;

  /** Resolve a folder identity within one selected space, without downloading bodies. */
  folderPath(id: string, spaceKey: string): Promise<string>;

  /** Resolve an attachment ID inside one selected space, without downloading bytes. */
  attachmentPath(id: string, spaceKey: string): Promise<string>;

  /** Resolve a path to its node without the `stat` projection. */
  resolve(path: string): Promise<VfsNode>;
}

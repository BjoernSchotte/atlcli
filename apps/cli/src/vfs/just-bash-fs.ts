/**
 * `IFileSystem` over the Confluence VFS (WP6.1).
 *
 * A thin adapter, deliberately: everything interesting lives in
 * `@atlcli/confluence-vfs`. This file's whole job is translating between two
 * vocabularies — just-bash's Node-shaped filesystem and the core's
 * `VfsError`-throwing API — and it must not grow policy of its own. If a rule
 * about what the filesystem does belongs anywhere, it belongs in the core,
 * where the WebDAV adapter gets it too.
 *
 * ## Errors
 *
 * just-bash inspects `error.code`, exactly as `node:fs` callers do, so a
 * `VfsError` is rethrown as an `Error` carrying the same code. Its message is
 * kept intact: those messages name the flag that would have allowed the
 * operation, and that is the most useful thing an agent can read.
 */
import { posix } from "node:path";
// Type-only: importing the *value* would pull just-bash into the eager module
// graph, which WP6.8 exists to avoid. The one cast below is what
// `unsafeBytesFromLatin1` does, inlined for the same reason.
import type { ByteString } from "just-bash";
import {
  isVfsError,
  vfsSlug,
  type ConfluenceVfsImpl,
  type VfsDirent,
} from "@atlcli/confluence-vfs";

const slugOf = vfsSlug;

/** Structural copies of the just-bash types, so this file needs no import. */
interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
  identity?: string;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

interface CpOptions {
  recursive?: boolean;
}

/**
 * A Node-style error: what just-bash and every `fs` consumer expects.
 *
 * The message is prefixed with the code, exactly as `node:fs` does
 * (`ENOENT: no such file or directory, open '/x'`). That is not cosmetic:
 * just-bash's `mv` decides whether a destination is inside its source by
 * probing parents with `realpath` and treating an error as "missing" only when
 * the *message* contains `ENOENT` or `no such file`. Without the prefix every
 * `mv` into a not-yet-existing destination failed with "cannot safely
 * determine whether ... is inside ...". The core's own wording follows the
 * prefix, so the part a human reads — which flag would have allowed this — is
 * still there.
 */
function toNodeError(error: unknown): Error {
  if (!isVfsError(error)) return error instanceof Error ? error : new Error(String(error));
  const nodeError = new Error(`${error.code}: ${error.message}`) as Error & {
    code?: string;
    path?: string;
  };
  nodeError.code = error.code;
  if (error.path) nodeError.path = error.path;
  return nodeError;
}

async function translate<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw toNodeError(error);
  }
}

function direntOf(entry: VfsDirent): DirentEntry {
  return {
    name: entry.name,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymbolicLink,
  };
}

export class ConfluenceJustBashFs {
  constructor(
    private readonly vfs: ConfluenceVfsImpl,
    /** Where this filesystem is mounted, stripped from incoming paths. */
    private readonly mountPoint = "/",
  ) {}

  /** `/DOCSY/a-1.md` under a `/DOCSY` mount arrives here as `/a-1.md`. */
  private toVfsPath(path: string): string {
    const normalized = posix.normalize(path.startsWith("/") ? path : `/${path}`);
    if (this.mountPoint === "/") return normalized;
    return posix.join(this.mountPoint, normalized);
  }

  async readFile(path: string): Promise<string> {
    return translate(() => this.vfs.readFile(this.toVfsPath(path)));
  }

  async readFileBytes(path: string): Promise<ByteString> {
    const bytes = await translate(() => this.vfs.readFileBytes(this.toVfsPath(path)));
    // just-bash's ByteString is a latin1-shaped string: one character per byte.
    return Buffer.from(bytes).toString("latin1") as unknown as ByteString;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return translate(() => this.vfs.readFileBytes(this.toVfsPath(path)));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await translate(() => this.vfs.writeFile(this.toVfsPath(path), content));
  }

  /**
   * `>>` on a page.
   *
   * Read-modify-write rather than a true append: Confluence has no append, and
   * the read is what supplies the version the update needs anyway.
   */
  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const target = this.toVfsPath(path);
    const addition = typeof content === "string" ? content : new TextDecoder().decode(content);
    let existing = "";
    try {
      existing = await this.vfs.readFile(target);
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOENT") throw toNodeError(error);
    }
    await translate(() => this.vfs.writeFile(target, existing + addition));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.vfs.stat(this.toVfsPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const stat = await translate(() => this.vfs.stat(this.toVfsPath(path)));
    return {
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      isSymbolicLink: stat.isSymbolicLink,
      mode: stat.mode,
      size: stat.size,
      mtime: stat.mtime,
      // The Confluence id is a genuinely stable identity, which lets commands
      // that need to tell two paths apart (`mv`, `cp`) do so without guessing.
      identity: stat.id,
    };
  }

  /** No symlink following here; `stat` already reports links as links. */
  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string): Promise<void> {
    await translate(() => this.vfs.mkdir(this.toVfsPath(path)));
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await translate(() => this.vfs.readdir(this.toVfsPath(path)));
    return entries.map((entry) => entry.name);
  }

  /**
   * The reason `ls -l` and `find` do not cause a stat storm.
   *
   * The core already knows each entry's type from the listing it just made, so
   * handing it over here saves one `stat` per entry — which against a REST API
   * is the difference between one request and a hundred.
   */
  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await translate(() => this.vfs.readdir(this.toVfsPath(path)));
    return entries.map(direntOf);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    try {
      await this.vfs.rm(this.toVfsPath(path), { recursive: options.recursive ?? false });
    } catch (error) {
      if (options.force && isVfsError(error) && error.code === "ENOENT") return;
      throw toNodeError(error);
    }
  }

  async cp(src: string, dest: string, _options: CpOptions = {}): Promise<void> {
    await translate(() => this.vfs.copy(this.toVfsPath(src), this.toVfsPath(dest)));
  }

  async mv(src: string, dest: string): Promise<void> {
    await translate(() => this.vfs.rename(this.toVfsPath(src), this.toVfsPath(dest)));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return posix.normalize(path);
    return posix.normalize(posix.join(base, path));
  }

  /**
   * Paths just-bash may glob over, **from memory only**.
   *
   * This is synchronous, so it cannot fetch — which is exactly right: a glob
   * must not be able to walk a space. It returns what the tree index already
   * holds, so `*.md` matches what has been listed and nothing more. just-bash
   * falls back to `readdir` for the rest, which is the demand-driven path.
   */
  getAllPaths(): string[] {
    const paths = new Set<string>();
    for (const node of this.vfs.index.loadedNodes()) {
      const segments = this.pathSegmentsOf(node.id);
      if (!segments) continue;
      const dir = this.fromVfsPath(`/${[node.spaceKey, ...segments].join("/")}`);
      if (dir === undefined) continue;
      paths.add(dir);
      // Both addressable forms, since a glob may be written either way.
      paths.add(`${dir}/_index.md`);
      paths.add(`${dir}.md`);
    }
    return [...paths];
  }

  /**
   * Segments from the space root down to `id`, or undefined when an ancestor
   * is missing.
   *
   * The page whose `parentId` is null is the space home page, which *is* the
   * space directory, so it contributes no segment of its own.
   */
  private pathSegmentsOf(id: string): string[] | undefined {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current = this.vfs.index.node(id);
    while (current) {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      if (current.parentId === null) return segments;
      segments.unshift(`${slugOf(current.title)}-${current.id}`);
      current = this.vfs.index.node(current.parentId!);
    }
    return undefined;
  }

  /** The inverse of {@link toVfsPath}; undefined when outside this mount. */
  private fromVfsPath(path: string): string | undefined {
    if (this.mountPoint === "/") return path;
    if (path === this.mountPoint) return "/";
    if (!path.startsWith(`${this.mountPoint}/`)) return undefined;
    return path.slice(this.mountPoint.length);
  }

  async chmod(): Promise<void> {
    // Confluence has no file modes; silently accepting keeps `cp -p` working.
  }

  async symlink(): Promise<void> {
    throw Object.assign(new Error("EPERM: the Confluence filesystem cannot create symlinks"), {
      code: "EPERM",
    });
  }

  async link(): Promise<void> {
    throw Object.assign(new Error("EPERM: the Confluence filesystem cannot create hard links"), {
      code: "EPERM",
    });
  }

  /**
   * Link targets come back in **this mount's** namespace.
   *
   * The core speaks absolute VFS paths (`/DOCSY/.by-id/102.md`); a filesystem
   * mounted at `/DOCSY` must answer in its own (`/.by-id/102.md`). Returning
   * the core's form makes every caller see a path one level too deep — and it
   * is what made `mv` refuse with "cannot safely determine whether ... is
   * inside ...", because it compared a mount-qualified destination against a
   * mount-relative source.
   */
  async readlink(path: string): Promise<string> {
    const target = await translate(() => this.vfs.readlink(this.toVfsPath(path)));
    return this.fromVfsPath(target) ?? target;
  }

  /**
   * Resolve as much of the path as exists.
   *
   * POSIX `realpath` fails on a missing path, but just-bash calls this on a
   * *destination* — `mv a b/c` has to decide whether the destination sits
   * inside the source before either exists — and a throw there makes `mv`
   * refuse with "cannot safely determine whether...". So a missing leaf
   * resolves against its parent, which is `realpath -m` behaviour and is what
   * the containment check actually needs.
   */
  async realpath(path: string): Promise<string> {
    const target = this.toVfsPath(path);
    try {
      const stat = await this.vfs.stat(target);
      const resolved = stat.isSymbolicLink ? await this.vfs.readlink(target) : target;
      return this.fromVfsPath(resolved) ?? resolved;
    } catch (error) {
      if (!isVfsError(error) || error.code !== "ENOENT") throw toNodeError(error);
      const parent = posix.dirname(target);
      if (parent === target) throw toNodeError(error);
      const parentInMount = this.fromVfsPath(parent) ?? parent;
      return posix.join(await this.realpath(parentInMount), posix.basename(target));
    }
  }

  async utimes(): Promise<void> {
    // Modification time comes from the page version and cannot be set.
  }
}

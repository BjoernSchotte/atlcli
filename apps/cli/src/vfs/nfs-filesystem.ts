import type { NfsJournal, StagedNfsFile } from "./nfs-journal.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { VfsError, parseVfsFrontmatter, type ConfluenceVfs, type VfsStat } from "@atlcli/confluence-vfs";
import { INDEXER_SHIELDS, SHIELD_DIRECTORIES, isClientDropping, SweepDetector } from "./mount-client-probes.js";

export const NFS_MAX_READ = 1024 * 1024;
export const NFS_MAX_HANDLES = 65_536;
export interface NfsAttributes {
  id: number;
  directory: boolean;
  size: number;
  mtime: number;
  writable?: boolean;
}

/** Protocol projection. All paths are resolved inside the selected export. */
export class NfsFilesystem {
  private readonly paths = new Map<number, { path: string; identity: string; parent?: number; name?: string; shield?: "file" | "directory"; rendered?: { hash: string; mtime: number } }>();
  private readonly shieldIds = new Map<string, number>();
  private readonly identities = new Map<string, number>();
  private nextId = 2;
  private readonly directories = new Map<number, { signature: string; mtime: number }>();
  readonly root: string;

  constructor(private readonly vfs: ConfluenceVfs, spaces: readonly string[],
    private readonly sweepDetector = new SweepDetector(), private readonly journal?: NfsJournal) {
    if (spaces.length === 0 || spaces.some((s) => !s || /[\/\0]/.test(s) || s === "." || s === "..")) {
      throw new VfsError("EINVAL", "Invalid NFS export spaces");
    }
    this.root = spaces.length === 1 ? `/${spaces[0]}` : "/";
    this.spaces = new Set(spaces);
    this.paths.set(1, { path: this.root, identity: "root" });
    for (const name of [...INDEXER_SHIELDS, ...SHIELD_DIRECTORIES]) {
      const id = this.nextId++;
      this.shieldIds.set(name, id);
      this.paths.set(id, { path: posix.join(this.root, name), identity: `shield:${name}`,
        shield: SHIELD_DIRECTORIES.has(name) ? "directory" : "file" });
    }
  }

  private readonly spaces: Set<string>;

  private assertExport(path: string): void {
    if (path !== "/" && !this.spaces.has(path.split("/")[1])) {
      throw new VfsError("EACCES", "Outside NFS export");
    }
    if (this.root !== "/" && path !== this.root && !path.startsWith(`${this.root}/`)) {
      throw new VfsError("EACCES", "Outside NFS export");
    }
  }

  private isObjectView(stat: VfsStat): boolean {
    return (stat.kind === "virtual-dir" && /^[0-9]+\/(?:_attachments|\.versions)$/.test(stat.id)) ||
      (stat.kind === "virtual-file" && /^[0-9]+(?:@[0-9]+|\/\.comments)?$/.test(stat.id));
  }

  private identity(stat: VfsStat, path: string): string {
    // Generated views may share core IDs (e.g. space-json, label-dir). Their
    // export path distinguishes the view; real content keeps ID-based identity.
    const view = !this.isObjectView(stat) && (stat.kind === "virtual-dir" || stat.kind === "virtual-file") ? `:${path}` : "";
    return `${stat.kind}:${stat.id}:${stat.isDirectory ? "directory" : "file"}${view}`;
  }

  private stale(id: number): never {
    const old = this.paths.get(id);
    if (old && this.identities.get(old.identity) === id) this.identities.delete(old.identity);
    this.paths.delete(id);
    this.directories.delete(id);
    throw Object.assign(new Error("Stale NFS handle; look up the file again"), { code: "ESTALE" });
  }

  private async relocateAttachment(id: number): Promise<string> {
    const entry = this.paths.get(id)!;
    const attachmentId = entry.identity.slice("attachment:".length, -":file".length);
    for (const space of this.spaces) {
      try {
        const path = await this.vfs.attachmentPath(attachmentId, space);
        this.assertExport(path);
        await this.checkResolvedScope(path);
        if (this.identity(await this.vfs.stat(path), path) !== entry.identity) {
          throw new VfsError("EAGAIN", "Attachment moved while resolving its path; retry");
        }
        entry.parent = await this.register(posix.dirname(path));
        entry.name = posix.basename(path);
        entry.path = path;
        return path;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return this.stale(id);
  }

  private async checkResolvedScope(path: string): Promise<void> {
    const node = await this.vfs.resolve(path);
    if (node.spaceKey && !this.spaces.has(node.spaceKey)) throw new VfsError("EACCES", "Outside NFS export");
    if (node.kind === "symlink") {
      const target = posix.resolve(posix.dirname(path), await this.vfs.readlink(path));
      this.assertExport(target);
      const resolved = await this.vfs.resolve(target);
      if (resolved.spaceKey && !this.spaces.has(resolved.spaceKey)) throw new VfsError("EACCES", "Outside NFS export");
      if (resolved.kind === "symlink") throw new VfsError("EINVAL", "Chained NFS aliases are unsupported");
    }
  }

  private async pathFor(id: number): Promise<string> {
    if (!Number.isSafeInteger(id) || id < 1) throw new VfsError("EINVAL", "Invalid NFS handle");
    const entry = this.paths.get(id);
    if (!entry) return this.stale(id);
    if (entry.shield) return entry.path; // Fixed empty volume markers, never backend paths.
    this.assertExport(entry.path);
    try {
      const stat = await this.vfs.stat(entry.path);
      await this.checkResolvedScope(entry.path);
      if (id !== 1 && this.identity(stat, entry.path) !== entry.identity) {
        // The old filename may have been reused; recover the original object,
        // never serve the replacement through its handle.
        throw new VfsError("ENOENT", "NFS object moved from its previous path");
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (entry.parent !== undefined && entry.name !== undefined) {
          try {
            const parentPath = await this.pathFor(entry.parent);
            if (entry.identity.startsWith("attachment:")) {
              const candidate = (await this.vfs.readdir(parentPath)).find(child =>
                child.kind === "attachment" && child.id !== undefined &&
                `attachment:${child.id}:file` === entry.identity);
              if (!candidate) throw new VfsError("ENOENT", "Attachment left its previous owner");
              if (!candidate.name || /[\/\0]/.test(candidate.name) || candidate.name === "." || candidate.name === "..") {
                throw new VfsError("EINVAL", "Invalid attachment filename");
              }
              entry.name = candidate.name;
            }
            const relocated = posix.join(parentPath, entry.name);
            this.assertExport(relocated);
            await this.checkResolvedScope(relocated);
            if (this.identity(await this.vfs.stat(relocated), relocated) !== entry.identity) return this.stale(id);
            entry.path = relocated;
            return relocated;
          } catch (relocationError) {
            if (relocationError && typeof relocationError === "object" && "code" in relocationError &&
                (relocationError.code === "ENOENT" || relocationError.code === "ESTALE")) {
              return entry.identity.startsWith("attachment:") ? this.relocateAttachment(id) : this.stale(id);
            }
            throw relocationError;
          }
        }
        // NFS handles name objects, not their last observed parent. Reuse the
        // core's scoped ID lookup instead of walking the export after a move.
        const page = /^(page|folder):([0-9]+):(directory|file)$/.exec(entry.identity);
        if (page) {
          for (const space of this.spaces) {
            try {
              const relocated = page[1] === "folder"
                ? await this.vfs.folderPath(page[2]!, space)
                : await this.vfs.readlink(`/${space}/.by-id/${page[2]}.md`).then(body => page[3] === "directory" ? posix.dirname(body) : body);
              this.assertExport(relocated);
              await this.checkResolvedScope(relocated);
              if (this.identity(await this.vfs.stat(relocated), relocated) !== entry.identity) continue;
              entry.path = relocated;
              return relocated;
            } catch (relocationError) {
              if (relocationError && typeof relocationError === "object" && "code" in relocationError &&
                  relocationError.code === "ENOENT") continue;
              throw relocationError;
            }
          }
        }
        return this.stale(id);
      }
      throw error;
    }
    return entry.path;
  }

  private async register(path: string): Promise<number> {
    this.assertExport(path);
    if (path === this.root) return 1;
    const stat = await this.vfs.stat(path);
    await this.checkResolvedScope(path);
    const identity = this.identity(stat, path);
    const followsParent = stat.kind === "attachment" || this.isObjectView(stat);
    const entry = { path, identity, ...(followsParent
      ? { parent: await this.register(posix.dirname(path)), name: posix.basename(path) } : {}) };
    const existing = this.identities.get(identity);
    if (existing !== undefined) {
      this.paths.set(existing, { ...entry, rendered: this.paths.get(existing)?.rendered });
      return existing;
    }
    if (this.paths.size >= NFS_MAX_HANDLES || this.nextId > Number.MAX_SAFE_INTEGER) throw new VfsError("ENOSPC", "NFS handle capacity exceeded");
    const id = this.nextId++;
    this.paths.set(id, entry);
    this.identities.set(identity, id);
    return id;
  }

  async lookup(parent: number, name: string): Promise<number> {
    if (!name || /[\/\0]/.test(name)) {
      throw new VfsError("EINVAL", "Invalid NFS filename");
    }
    if (Buffer.byteLength(name) > 255) {
      throw Object.assign(new Error("NFS filenames must not exceed 255 bytes"), { code: "ENAMETOOLONG" });
    }
    const shield = this.paths.get(parent)?.shield;
    if (shield === "file") throw new VfsError("ENOTDIR", "Not a directory");
    if (shield === "directory") {
      if (name === ".") return parent;
      if (name === "..") return 1;
      throw new VfsError("ENOENT", "No such file");
    }
    if (parent === 1) {
      const marker = this.shieldIds.get(name);
      if (marker !== undefined) return marker;
      if (isClientDropping(name)) throw new VfsError("ENOENT", "No such file");
    }
    const directory = await this.pathFor(parent);
    if (!(await this.vfs.stat(directory)).isDirectory) throw new VfsError("ENOTDIR", "Not a directory");
    if (name === ".") return parent;
    if (name === "..") return directory === this.root ? 1 : this.register(posix.dirname(directory));
    return this.register(posix.join(directory, name));
  }

  private async directoryView(id: number, path: string) {
    const shield = this.paths.get(id)?.shield;
    if (shield === "file") throw new VfsError("ENOTDIR", "Not a directory");
    const names = (shield ? [] : await this.vfs.readdir(path))
      .filter((entry) => path !== "/" || this.spaces.has(entry.name))
      .map((entry) => entry.name);
    if (id === 1) names.push(...this.shieldIds.keys());
    names.sort();
    const ids: number[] = [];
    // Bound pending lookup work independently of the number of directory entries.
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.allSettled(names.slice(offset, offset + 32).map(name => this.lookup(id, name)));
      // Drain a failed batch too: retries must not accumulate detached lookups.
      for (const result of batch) {
        if (result.status === "rejected") throw result.reason;
        ids.push(result.value);
      }
    }
    const signature = createHash("sha256").update(JSON.stringify(names.map((name, i) => [name, ids[i]]))).digest("hex");
    let revision = this.directories.get(id);
    if (!revision || revision.signature !== signature) {
      revision = { signature, mtime: Math.max(Date.now(), (revision?.mtime ?? 0) + 1) };
      this.directories.set(id, revision);
    }
    return { names, ids, mtime: revision.mtime };
  }

  private async stagedFile(id: number): Promise<StagedNfsFile> {
    if (!this.journal) throw new VfsError("EROFS", "NFS staging is disabled");
    const path = await this.pathFor(id);
    const stat = await this.vfs.stat(path);
    if (stat.isDirectory) throw new VfsError("EISDIR", "Cannot write a directory");
    if (stat.kind !== "page" || !(stat.mode & 0o222)) throw new VfsError("EROFS", "Not a writable page body");
    const existing = this.journal.get(stat.id);
    if (existing) return existing;
    const bytes = await this.vfs.readFileBytes(path);
    const { frontmatter } = parseVfsFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (frontmatter.id !== stat.id || frontmatter.version === undefined) {
      throw new VfsError("EAGAIN", "Page changed during staging admission");
    }
    return this.journal.admit(stat.id, path, bytes, frontmatter.version);
  }

  /** Returns only after SQLite has durably committed the local byte image. */
  async write(id: number, offset: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength > NFS_MAX_READ) {
      throw new VfsError("EINVAL", "Invalid NFS write range");
    }
    const file = await this.stagedFile(id);
    this.journal!.write(file.id, offset, bytes);
  }

  async truncate(id: number, size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) throw new VfsError("EINVAL", "Invalid NFS file size");
    const file = await this.stagedFile(id);
    this.journal!.truncate(file.id, size);
  }

  async getattr(id: number): Promise<NfsAttributes> {
    return this.attributes(id, true);
  }

  private async attributes(id: number, refreshDirectory: boolean): Promise<NfsAttributes> {
    const path = await this.pathFor(id);
    const shield = this.paths.get(id)?.shield;
    if (shield) return { id, directory: shield === "directory", size: 0,
      mtime: shield === "directory" ? (await this.directoryView(id, path)).mtime : 0 };
    const stat = await this.vfs.stat(path);
    const staged = stat.kind === "page" && !stat.isDirectory ? this.journal?.get(stat.id) : undefined;
    if (staged) {
      const entry = this.paths.get(id)!;
      const hash = createHash("sha256").update(staged.bytes).digest("hex");
      if (!entry.rendered || entry.rendered.hash !== hash) {
        entry.rendered = { hash, mtime: Math.max(Date.now(), (entry.rendered?.mtime ?? 0) + 1, stat.mtime.getTime() + 1) };
      }
      return { id, directory: false, size: staged.bytes.byteLength, mtime: entry.rendered.mtime, writable: !!(stat.mode & 0o222) };
    }
    // Never publish estimated sizes to a kernel client.
    const bytes = stat.isDirectory || (stat.kind === "attachment" && !stat.sizeEstimated)
      ? undefined : await this.vfs.readFileBytes(path);
    const size = stat.isDirectory ? 0 : bytes?.byteLength ?? stat.size;
    // Entry attributes must not enumerate an unopened child directory.
    let mtime = stat.mtime.getTime();
    if (bytes && (stat.kind === "page" || stat.kind === "symlink" ||
        (stat.kind === "virtual-file" && /^[0-9]+@[0-9]+$/.test(stat.id)))) {
      // A cold read can fetch a newer version than the preceding stat. Use
      // metadata from these exact generated bytes, not a second mutable stat.
      const modified = parseVfsFrontmatter(Buffer.from(bytes).toString("utf8")).frontmatter.lastModified;
      if (modified && Number.isFinite(Date.parse(modified))) mtime = Date.parse(modified);
      else if (stat.kind === "virtual-file") mtime = 0; // Unknown historic time is not the current page time.
    }
    if (bytes && stat.kind === "virtual-file" && !/^[0-9]+@[0-9]+$/.test(stat.id)) {
      // Generated content can change without a page version (comments, metadata).
      // Keep a stable revision until the actual bytes change, including same-size edits.
      const entry = this.paths.get(id)!;
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (!entry.rendered || entry.rendered.hash !== hash) {
        entry.rendered = { hash, mtime: Math.max(Date.now(), (entry.rendered?.mtime ?? 0) + 1) };
      }
      mtime = entry.rendered.mtime;
    }
    if (stat.isDirectory) {
      mtime = refreshDirectory ? (await this.directoryView(id, path)).mtime : this.directories.get(id)?.mtime ?? mtime;
    }
    return { id, directory: stat.isDirectory, size, mtime,
      writable: !!this.journal && stat.kind === "page" && !stat.isDirectory && !!(stat.mode & 0o222) };
  }

  async read(id: number, offset: number, count: number): Promise<{ data: string; eof: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 || count > NFS_MAX_READ) {
      throw new VfsError("EINVAL", "Invalid NFS read range");
    }
    const path = await this.pathFor(id);
    const shield = this.paths.get(id)?.shield;
    if (shield === "directory") throw new VfsError("EISDIR", "Cannot read directory");
    if (shield === "file") return { data: "", eof: true };
    const stat = await this.vfs.stat(path);
    if (stat.isDirectory) throw new VfsError("EISDIR", "Cannot read directory");
    const staged = stat.kind === "page" ? this.journal?.get(stat.id) : undefined;
    const bytes = staged?.bytes ?? await this.vfs.readFileBytes(path);
    if (count > 0) this.sweepDetector.noteRead(posix.dirname(path), id);
    const start = Math.min(offset, bytes.byteLength);
    const end = Math.min(start + count, bytes.byteLength);
    return { data: Buffer.from(bytes.subarray(start, end)).toString("base64"), eof: end === bytes.byteLength };
  }

  async readdir(id: number, after: number, count: number, verifier?: string): Promise<{
    entries: { name: string; attr: NfsAttributes }[]; end: boolean;
  }> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(count) || count < 1 || count > 256) {
      throw new VfsError("EINVAL", "Invalid NFS directory range");
    }
    const path = await this.pathFor(id);
    const { names, ids, mtime } = await this.directoryView(id, path);
    const current = Buffer.alloc(8);
    current.writeUInt32BE(Math.floor(mtime / 1000), 0);
    current.writeUInt32BE((mtime % 1000) * 1_000_000, 4);
    if (verifier !== undefined && verifier !== current.toString("hex")) {
      throw Object.assign(new Error("Directory changed; restart listing"), { code: "EBADCOOKIE" });
    }
    const start = after === 0 ? 0 : ids.indexOf(after) + 1;
    if (after !== 0 && start === 0) throw Object.assign(new Error("Expired NFS directory cursor"), { code: "EBADCOOKIE" });
    const end = Math.min(start + count, names.length);
    const entries = [];
    for (let i = start; i < end; i++) entries.push({ name: names[i], attr: await this.attributes(ids[i], false) });
    if (!this.paths.get(id)?.shield) this.sweepDetector.noteListing(path);
    return { entries, end: end === names.length };
  }
}

import type { NfsJournal, StagedNfsFile } from "./nfs-journal.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { VfsError, assertWritable, parseVfsFrontmatter, type ConfluenceVfs, type VfsStat } from "@atlcli/confluence-vfs";
import { INDEXER_SHIELDS, SHIELD_DIRECTORIES, isClientDropping, isNfsPageDraft, SweepDetector } from "./mount-client-probes.js";

export const NFS_MAX_READ = 1024 * 1024;
export const NFS_MAX_HANDLES = 65_536;
export interface NfsAttributes {
  id: number;
  directory: boolean;
  size: number;
  mtime: number;
  writable?: boolean;
  mode?: number;
  atime?: number;
  uid?: number;
  gid?: number;
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

  private forgetHandle(id: number): void {
    const old = this.paths.get(id);
    if (old && this.identities.get(old.identity) === id) this.identities.delete(old.identity);
    this.paths.delete(id);
    this.directories.delete(id);
  }

  private stale(id: number): never {
    this.forgetHandle(id);
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
    if (entry.identity.startsWith("local:") && this.journal?.promotion(entry.identity)) {
      const pageId = this.journal.promotion(entry.identity)!.pageId;
      const path = await this.promotedPath(pageId);
      const stat = await this.vfs.stat(path);
      this.moveHandles(entry.identity, this.identity(stat, path), path, id);
      return path;
    }
    if (entry.identity.startsWith("local:")) {
      const file = this.journal?.get(entry.identity);
      if (!file || this.journal?.local(file.path)?.id !== file.id) return this.stale(id);
      this.assertExport(file.path);
      await this.localParent(posix.dirname(file.path));
      entry.path = file.path;
      return file.path;
    }
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

  private async promotedPath(pageId: string): Promise<string> {
    for (const space of this.spaces) {
      try {
        const path = await this.vfs.readlink(`/${space}/.by-id/${pageId}.md`);
        this.assertExport(path);
        await this.checkPageIdentity(path, pageId);
        return path;
      } catch (error) { if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error; }
    }
    throw new VfsError("ENOENT", "Created page left the export or was deleted");
  }

  private async register(path: string): Promise<number> {
    this.assertExport(path);
    if (this.journal?.displaced(path)) throw new VfsError("ENOENT", "Page moved aside for replacement");
    const promoted = this.journal?.promotion(path);
    if (promoted) {
      const handle = this.identities.get(promoted.localId);
      if (handle !== undefined) await this.pathFor(handle);
      path = await this.promotedPath(promoted.pageId);
    }
    if (path === this.root) return 1;
    const local = this.journal?.local(path);
    const stat = await this.stat(path);
    if (!local) await this.checkResolvedScope(path);
    const promotion = !local && this.journal?.promotion(stat.id);
    const localHandle = promotion ? this.identities.get(promotion.localId) : undefined;
    if (localHandle !== undefined) await this.pathFor(localHandle);
    const identity = local?.id ?? this.identity(stat, path);
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
    return this.lookupAt(parent, name);
  }

  // Only directoryView supplies knownDirectory after resolving/listing the parent.
  // Child registration still checks each object's identity and export scope.
  private async lookupAt(parent: number, name: string, knownDirectory?: string): Promise<number> {
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
    const directory = knownDirectory ?? await this.pathFor(parent);
    if (knownDirectory === undefined && !(await this.stat(directory)).isDirectory) throw new VfsError("ENOTDIR", "Not a directory");
    if (name === ".") return parent;
    if (name === "..") return directory === this.root ? 1 : this.register(posix.dirname(directory));
    return this.register(posix.join(directory, name));
  }

  private async directoryView(id: number, path: string) {
    const shield = this.paths.get(id)?.shield;
    if (shield === "file") throw new VfsError("ENOTDIR", "Not a directory");
    const names = (shield || this.journal?.local(path)?.kind === "directory" ? [] : await this.vfs.readdir(path))
      .filter((entry) => path !== "/" || this.spaces.has(entry.name))
      .map((entry) => entry.name)
      .filter(name => !this.journal?.displaced(posix.join(path, name)) || this.journal?.local(posix.join(path, name)));
    if (!shield) for (const local of this.journal?.localEntries(path) ?? []) {
      const name = posix.basename(local.path);
      if (!names.includes(name)) names.push(name);
    }
    if (id === 1) names.push(...this.shieldIds.keys());
    names.sort();
    const ids: number[] = [];
    // Bound pending lookup work independently of the number of directory entries.
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.allSettled(names.slice(offset, offset + 32).map(name => this.lookupAt(id, name, path)));
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

  private async localParent(path: string): Promise<void> {
    this.assertExport(path);
    const local = this.journal?.local(path);
    if (local) {
      if (local.kind !== "directory") throw new VfsError("ENOTDIR", "Not a directory");
      await this.localParent(posix.dirname(path));
      return;
    }
    await this.checkResolvedScope(path);
    const stat = await this.vfs.stat(path);
    const node = await this.vfs.resolve(path);
    if (!stat.isDirectory) throw new VfsError("ENOTDIR", "Not a directory");
    if (!["space", "page", "folder"].includes(stat.kind) || node.readOnly) {
      throw new VfsError("EROFS", "Not a writable content directory");
    }
  }

  private async stat(path: string): Promise<VfsStat> {
    if (this.journal?.displaced(path)) throw new VfsError("ENOENT", "Page moved aside for replacement");
    const promotion = this.journal?.promotion(path);
    if (promotion) path = await this.promotedPath(promotion.pageId);
    const file = this.journal?.local(path);
    if (!file) {
      if (this.journal?.displaced(path)) throw new VfsError("ENOENT", "Page moved aside for replacement");
      const stat = await this.vfs.stat(path);
      const metadata = stat.kind === "page" && !stat.isDirectory ? this.journal?.attributes(stat.id) : undefined;
      return metadata ? { ...stat, mode: metadata.mode & (this.vfs.guard.mode === "rw" ? 0o777 : 0o555) } : stat;
    }
    await this.localParent(posix.dirname(path));
    return { id: file.id, kind: "page", isFile: file.kind === "file", isDirectory: file.kind === "directory", isSymbolicLink: false,
      size: file.bytes.byteLength, sizeEstimated: false, mtime: new Date(0),
      mode: (this.journal?.attributes(file.id)?.mode ?? (file.kind === "directory" ? 0o755 : 0o644)) & (this.vfs.guard.mode === "rw" ? 0o777 : 0o555) };
  }

  private async mutationPath(parent: number, name: string): Promise<string> {
    if (!this.journal) throw new VfsError("EROFS", "NFS staging is disabled");
    assertWritable(this.vfs.guard, "update");
    if (!name || name === "." || name === ".." || /[\/\0]/.test(name)) throw new VfsError("EINVAL", "Invalid NFS filename");
    if (Buffer.byteLength(name) > 255) throw Object.assign(new Error("NFS filename too long"), { code: "ENAMETOOLONG" });
    if (this.paths.get(parent)?.shield || INDEXER_SHIELDS.has(name) || SHIELD_DIRECTORIES.has(name) || isClientDropping(name)) {
      throw new VfsError("EROFS", "Protected mount metadata");
    }
    const directory = await this.pathFor(parent);
    await this.localParent(directory);
    if (!((await this.stat(directory)).mode & 0o222)) throw new VfsError("EACCES", "Directory is not writable");
    return posix.join(directory, name);
  }

  async createRegular(parent: number, name: string, guarded: boolean, values: { mode?: number; size?: number }): Promise<{ file: number; pageId: string | null }> {
    if (values.mode !== undefined && (!Number.isInteger(values.mode) || values.mode < 0 || values.mode > 0o777)) throw new VfsError("EINVAL", "Invalid CREATE mode");
    if (values.size !== undefined && (!Number.isSafeInteger(values.size) || values.size < 0)) throw new VfsError("EINVAL", "Invalid CREATE size");
    const path = await this.mutationPath(parent, name);
    if (this.journal!.displaced(path)) {
      await this.checkReservation(path);
      const page = this.journal!.restoreCreated(path, values);
      return { file: await this.register(path), pageId: page.id };
    }
    let stat: VfsStat | undefined;
    try { stat = await this.stat(path); }
    catch (error) { if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error; }
    if (stat && guarded) throw new VfsError("EEXIST", "NFS file exists");
    if (stat?.isDirectory) throw new VfsError("EISDIR", "Cannot create over directory");
    if (stat && !(stat.mode & 0o222)) throw new VfsError("EROFS", "File is not writable");
    if (!stat || this.journal!.local(path)) {
      if (!stat && (this.paths.size >= NFS_MAX_HANDLES || this.nextId > Number.MAX_SAFE_INTEGER)) throw new VfsError("ENOSPC", "NFS handle capacity exceeded");
      this.journal!.createRegularLocal(path, guarded, values);
      return { file: await this.register(path), pageId: null };
    }
    const file = await this.register(path);
    await this.stagedFile(file);
    const pageId = values.size === undefined ? null : await this.truncate(file, values.size);
    return { file, pageId };
  }

  async mkdir(parent: number, name: string, mode = 0o755): Promise<number> {
    return this.createEntry(parent, name, true, undefined, mode);
  }

  async create(parent: number, name: string, verifier?: string): Promise<number> {
    return this.createEntry(parent, name, false, verifier);
  }

  /** CREATE can be the only mutation for an empty document. */
  publicationId(handle: number): string | null {
    const identity = this.paths.get(handle)?.identity;
    if (!identity || !this.journal) return null;
    const id = this.journal.promotion(identity)?.pageId ?? /^page:([0-9]+):file$/.exec(identity)?.[1] ?? identity;
    const file = this.journal.get(id);
    if (!file) return null;
    if (!file.id.startsWith("local:")) return file.revision > file.publishedRevision ? file.id : null;
    return isNfsPageDraft(file.path) && !this.journal.isBackup(file.id) ? file.id : null;
  }

  private async createEntry(parent: number, name: string, directory: boolean, verifier?: string, mode = 0o755): Promise<number> {
    const path = await this.mutationPath(parent, name);
    if (this.journal!.displaced(path)) {
      if (directory) throw new VfsError("EISDIR", "Reserved page position requires a file");
      await this.checkReservation(path);
      this.journal!.restoreCreated(path, {}, verifier);
      return this.register(path);
    }
    const replay = verifier === undefined ? null : this.journal!.exclusivePageReplay(path, verifier);
    if (replay) {
      await this.checkPageIdentity(path, replay.id);
      return this.register(path);
    }
    if (verifier !== undefined && this.journal!.local(path)) {
      this.journal!.createLocal(path, verifier);
      return this.register(path);
    }
    try { await this.stat(path); }
    catch (error) {
      if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
      if (this.paths.size >= NFS_MAX_HANDLES || this.nextId > Number.MAX_SAFE_INTEGER) throw new VfsError("ENOSPC", "NFS handle capacity exceeded");
      if (directory) this.journal!.createLocalDirectory(path, mode);
      else this.journal!.createLocal(path, verifier);
      return this.register(path);
    }
    throw new VfsError("EEXIST", "NFS file exists");
  }

  async remove(parent: number, name: string, directory = false): Promise<void> {
    const path = await this.mutationPath(parent, name);
    const local = this.journal!.local(path);
    if (!local) {
      if (path === `${this.root}/_index.md`) throw new VfsError("EROFS", "Cannot trash the export homepage");
      assertWritable(this.vfs.guard, "delete", path);
      const handle = await this.register(path);
      const stat = await this.stat(path);
      if (stat.isDirectory) throw new VfsError("ENOTEMPTY", "Remove the page body before its directory");
      if (directory) throw new VfsError("ENOTDIR", "Not a directory");
      const page = await this.stagedFile(handle, true);
      if (this.journal!.trashIntent(page.id)) throw new VfsError("EBUSY", "Previous trash result requires reconciliation");
      const spaceKey = path.split("/")[1]!;
      const canonical = await this.vfs.readlink(`/${spaceKey}/.by-id/${page.id}.md`);
      if (canonical === `/${spaceKey}/_index.md`) throw new VfsError("EROFS", "Cannot trash the export homepage");
      this.journal!.beginTrash(page.id, canonical, spaceKey);
      await this.vfs.rm(canonical, { expected: { id: page.id, spaceKey } });
      this.journal!.completeTrash(page.id);
      for (const [id, entry] of this.paths) {
        if (entry.identity === `page:${page.id}:file` || entry.identity === `page:${page.id}:directory`) this.forgetHandle(id);
      }
      return;
    }
    this.journal!.removeLocal(path, directory);
    const handle = this.identities.get(local.id);
    if (handle !== undefined) this.forgetHandle(handle);
  }

  private async checkReservation(path: string): Promise<VfsStat> {
    const reserved = this.journal!.displaced(path)!;
    const stat = await this.checkPageIdentity(path, reserved.id);
    if (this.paths.size >= NFS_MAX_HANDLES || this.nextId > Number.MAX_SAFE_INTEGER) throw new VfsError("ENOSPC", "NFS handle capacity exceeded");
    return stat;
  }

  private async checkPageIdentity(path: string, id: string): Promise<VfsStat> {
    const promotion = this.journal?.promotion(path);
    if (promotion) path = await this.vfs.readlink(`/${path.split("/")[1]}/.by-id/${promotion.pageId}.md`);
    const stat = await this.vfs.stat(path);
    await this.checkResolvedScope(path);
    if (stat.isDirectory || stat.kind !== "page" || stat.id !== id) throw Object.assign(new Error("Reserved page identity changed"), { code: "ESTALE" });
    return stat;
  }

  private moveHandles(previous: string, identity: string, path: string, canonical: number): void {
    this.identities.delete(previous);
    for (const [id, entry] of this.paths) {
      if (entry.identity === previous) this.paths.set(id, { path, identity });
    }
    this.identities.set(identity, canonical);
  }

  /** Returns the page identity to schedule only after a local-to-page replacement. */
  async rename(parent: number, name: string, targetParent: number, targetName: string): Promise<string | null> {
    const source = await this.mutationPath(parent, name);
    const target = await this.mutationPath(targetParent, targetName);
    if (source === target) { await this.stat(source); return null; }
    if (!this.journal!.local(source)) {
      const sourceId = await this.register(source);
      const page = await this.stagedFile(sourceId);
      const oldTarget = this.journal!.local(target);
      if (!oldTarget) {
        try { await this.stat(target); throw new VfsError("EROFS", "Cannot rename a page over remote content"); }
        catch (error) { if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error; }
      }
      const backup = this.journal!.backupPage(page.id, target, source);
      if (oldTarget) {
        const oldHandle = this.identities.get(oldTarget.id);
        if (oldHandle !== undefined) this.forgetHandle(oldHandle);
      }
      this.moveHandles(this.paths.get(sourceId)!.identity, backup.id, target, sourceId);
      return null;
    }
    const reserved = this.journal!.displaced(target);
    if (reserved) {
      const stat = await this.checkReservation(target);
      const sourceId = await this.register(source);
      const identity = this.paths.get(sourceId)!.identity;
      this.journal!.replaceLocal(source, reserved.id);
      this.moveHandles(identity, this.identity(stat, target), target, sourceId);
      return reserved.id;
    }
    const replaced = this.journal!.local(target);
    if (replaced) {
      this.journal!.renameLocal(source, target);
      const handle = this.identities.get(replaced.id);
      if (handle !== undefined) this.forgetHandle(handle);
      const renamed = this.journal!.local(target)!;
      return isNfsPageDraft(target) && !this.journal!.isBackup(renamed.id) ? renamed.id : null;
    }
    let targetId: number;
    try { targetId = await this.register(target); }
    catch (error) {
      if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
      this.journal!.renameLocal(source, target);
      return isNfsPageDraft(target) ? this.journal!.local(target)!.id : null;
    }
    const page = await this.stagedFile(targetId);
    const local = this.journal!.local(source)!;
    this.journal!.replaceLocal(source, page.id);
    const handle = this.identities.get(local.id);
    if (handle !== undefined) {
      // NFS has no close notification: the source descriptor may still receive
      // writes after rename. Keep it as another handle for the same page.
      this.identities.delete(local.id);
      this.paths.set(handle, { ...this.paths.get(targetId)! });
    }
    return page.id;
  }

  private async stagedFile(id: number, metadataOnly = false): Promise<StagedNfsFile> {
    if (!this.journal) throw new VfsError("EROFS", "NFS staging is disabled");
    const path = await this.pathFor(id);
    const stat = await this.stat(path);
    if (stat.isDirectory) throw new VfsError("EISDIR", "Cannot write a directory");
    if (stat.kind !== "page" || this.vfs.guard.mode !== "rw" || (!metadataOnly && !(stat.mode & 0o222))) throw new VfsError("EROFS", "Not a writable page body");
    const existing = await this.stagedImage(path, stat);
    if (existing) return existing;
    const bytes = await this.vfs.readFileBytes(path);
    const { frontmatter } = parseVfsFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (frontmatter.id !== stat.id || frontmatter.version === undefined) {
      throw new VfsError("EAGAIN", "Page changed during staging admission");
    }
    return this.journal.admit(stat.id, path, bytes, frontmatter.version);
  }

  private async stagedImage(path: string, stat: VfsStat): Promise<StagedNfsFile | undefined> {
    if (stat.kind !== "page" || stat.isDirectory || !this.journal) return undefined;
    const file = this.journal.get(stat.id);
    if (!file) return undefined;
    if (file.revision !== file.publishedRevision || file.id.startsWith("local:") || this.journal.displaced(file.path)) return file;
    const bytes = await this.vfs.readFileBytes(path);
    const { frontmatter } = parseVfsFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (frontmatter.id !== file.id || frontmatter.version === undefined) throw new VfsError("EAGAIN", "Page changed during refresh");
    await this.checkResolvedScope(path);
    return this.journal.refreshClean(file.id, path, bytes, frontmatter.version, file.revision);
  }

  /** Returns only after SQLite has durably committed the local byte image. */
  async write(id: number, offset: number, bytes: Uint8Array): Promise<string | null> {
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength > NFS_MAX_READ) {
      throw new VfsError("EINVAL", "Invalid NFS write range");
    }
    const file = await this.stagedFile(id);
    const updated = this.journal!.write(file.id, offset, bytes);
    return updated.id.startsWith("local:") && (!isNfsPageDraft(updated.path) || this.journal!.isBackup(updated.id)) ? null : updated.id;
  }

  async truncate(id: number, size: number): Promise<string | null> {
    if (!Number.isSafeInteger(size) || size < 0) throw new VfsError("EINVAL", "Invalid NFS file size");
    const file = await this.stagedFile(id);
    const updated = this.journal!.truncate(file.id, size);
    // Linux requests server mtime with truncate, including unchanged sizes.
    const entry = this.paths.get(id)!;
    entry.rendered = { hash: createHash("sha256").update(updated.bytes).digest("hex"),
      mtime: Math.max(Date.now(), (entry.rendered?.mtime ?? 0) + 1) };
    return updated.id.startsWith("local:") && (!isNfsPageDraft(updated.path) || this.journal!.isBackup(updated.id)) ? null : updated.id;
  }

  async setAttributes(id: number, values: { mode?: number; atime?: number; mtime?: number }): Promise<void> {
    const path = await this.pathFor(id);
    const local = this.journal?.local(path);
    if (local?.kind === "directory") {
      assertWritable(this.vfs.guard, "update");
      this.journal!.setAttributes(local.id, values);
      return;
    }
    const file = await this.stagedFile(id, true);
    this.journal!.setAttributes(file.id, values);
  }

  async getattr(id: number): Promise<NfsAttributes> {
    return this.attributes(id, true);
  }

  private async attributes(id: number, refreshDirectory: boolean): Promise<NfsAttributes> {
    const path = await this.pathFor(id);
    const shield = this.paths.get(id)?.shield;
    if (shield) return { id, directory: shield === "directory", size: 0,
      mtime: shield === "directory" ? (await this.directoryView(id, path)).mtime : 0 };
    const stat = await this.stat(path);
    const local = this.journal?.local(path);
    if (local?.kind === "directory") {
      const metadata = this.journal!.attributes(local.id);
      return { id, directory: true, size: 0, mode: stat.mode,
        mtime: metadata?.mtime ?? (refreshDirectory ? (await this.directoryView(id, path)).mtime : this.directories.get(id)?.mtime ?? 0),
        atime: metadata?.atime ?? undefined, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
        writable: this.vfs.guard.mode === "rw" };
    }
    const staged = await this.stagedImage(path, stat);
    if (staged) {
      const entry = this.paths.get(id)!;
      const hash = createHash("sha256").update(staged.bytes).digest("hex");
      if (!entry.rendered || entry.rendered.hash !== hash) {
        entry.rendered = { hash, mtime: Math.max(Date.now(), (entry.rendered?.mtime ?? 0) + 1, stat.mtime.getTime() + 1) };
      }
      const metadata = this.journal!.attributes(staged.id);
      return { id, directory: false, size: staged.bytes.byteLength, mtime: metadata?.mtime ?? entry.rendered.mtime,
        mode: metadata ? metadata.mode & (this.vfs.guard.mode === "rw" ? 0o777 : 0o555) : undefined,
        atime: metadata?.atime ?? undefined, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, writable: !!(stat.mode & 0o222) };
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
      ...(this.journal ? { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 } : {}),
      writable: !!this.journal && (stat.isDirectory
        ? this.vfs.guard.mode === "rw" && ["space", "page", "folder"].includes(stat.kind)
        : stat.kind === "page" && !!(stat.mode & 0o222)) };
  }

  async read(id: number, offset: number, count: number): Promise<{ data: string; eof: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 || count > NFS_MAX_READ) {
      throw new VfsError("EINVAL", "Invalid NFS read range");
    }
    const path = await this.pathFor(id);
    const shield = this.paths.get(id)?.shield;
    if (shield === "directory") throw new VfsError("EISDIR", "Cannot read directory");
    if (shield === "file") return { data: "", eof: true };
    const stat = await this.stat(path);
    if (stat.isDirectory) throw new VfsError("EISDIR", "Cannot read directory");
    const staged = await this.stagedImage(path, stat);
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

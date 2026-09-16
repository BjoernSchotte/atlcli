import { posix } from "node:path";
import { VfsError, type ConfluenceVfs, type VfsStat } from "@atlcli/confluence-vfs";

export const NFS_MAX_READ = 1024 * 1024;
export interface NfsAttributes {
  id: number;
  directory: boolean;
  size: number;
  mtime: number;
}

/** Read-only protocol projection. All paths are resolved inside the selected export. */
export class NfsFilesystem {
  private readonly paths = new Map<number, { path: string; identity: string }>();
  private readonly identities = new Map<string, number>();
  private nextId = 2;
  readonly root: string;

  constructor(private readonly vfs: ConfluenceVfs, spaces: readonly string[]) {
    if (spaces.length === 0 || spaces.some((s) => !s || /[\/\0]/.test(s) || s === "." || s === "..")) {
      throw new VfsError("EINVAL", "Invalid NFS export spaces");
    }
    this.root = spaces.length === 1 ? `/${spaces[0]}` : "/";
    this.spaces = new Set(spaces);
    this.paths.set(1, { path: this.root, identity: "root" });
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

  private identity(stat: VfsStat, path: string): string {
    // Generated views may share core IDs (e.g. space-json, label-dir). Their
    // export path distinguishes the view; real content keeps ID-based identity.
    const view = stat.kind === "virtual-dir" || stat.kind === "virtual-file" ? `:${path}` : "";
    return `${stat.kind}:${stat.id}:${stat.isDirectory ? "directory" : "file"}${view}`;
  }

  private stale(id: number): never {
    const old = this.paths.get(id);
    if (old && this.identities.get(old.identity) === id) this.identities.delete(old.identity);
    this.paths.delete(id);
    throw Object.assign(new Error("Stale NFS handle; look up the file again"), { code: "ESTALE" });
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
    this.assertExport(entry.path);
    try {
      const stat = await this.vfs.stat(entry.path);
      await this.checkResolvedScope(entry.path);
      if (id !== 1 && this.identity(stat, entry.path) !== entry.identity) return this.stale(id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return this.stale(id);
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
    const existing = this.identities.get(identity);
    if (existing !== undefined) {
      this.paths.set(existing, { path, identity });
      return existing;
    }
    if (this.nextId > Number.MAX_SAFE_INTEGER) throw new VfsError("ENOSPC", "NFS handle capacity exceeded");
    const id = this.nextId++;
    this.paths.set(id, { path, identity });
    this.identities.set(identity, id);
    return id;
  }

  async lookup(parent: number, name: string): Promise<number> {
    const directory = await this.pathFor(parent);
    if (!(await this.vfs.stat(directory)).isDirectory) throw new VfsError("ENOTDIR", "Not a directory");
    if (!name || /[\/\0]/.test(name) || Buffer.byteLength(name) > 255) {
      throw new VfsError("EINVAL", "Invalid NFS filename");
    }
    if (name === ".") return parent;
    if (name === "..") return directory === this.root ? 1 : this.register(posix.dirname(directory));
    return this.register(posix.join(directory, name));
  }

  async getattr(id: number): Promise<NfsAttributes> {
    const path = await this.pathFor(id);
    const stat = await this.vfs.stat(path);
    // Never publish estimated sizes to a kernel client.
    const size = stat.isDirectory ? 0 : (await this.vfs.readFileBytes(path)).byteLength;
    return { id, directory: stat.isDirectory, size, mtime: stat.mtime.getTime() };
  }

  async read(id: number, offset: number, count: number): Promise<{ data: string; eof: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(count) || count < 0 || count > NFS_MAX_READ) {
      throw new VfsError("EINVAL", "Invalid NFS read range");
    }
    const path = await this.pathFor(id);
    if ((await this.vfs.stat(path)).isDirectory) throw new VfsError("EISDIR", "Cannot read directory");
    const bytes = await this.vfs.readFileBytes(path);
    const start = Math.min(offset, bytes.byteLength);
    const end = Math.min(start + count, bytes.byteLength);
    return { data: Buffer.from(bytes.subarray(start, end)).toString("base64"), eof: end === bytes.byteLength };
  }

  async readdir(id: number, after: number, count: number): Promise<{
    entries: { name: string; attr: NfsAttributes }[]; end: boolean;
  }> {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(count) || count < 1 || count > 256) {
      throw new VfsError("EINVAL", "Invalid NFS directory range");
    }
    const path = await this.pathFor(id);
    const names = (await this.vfs.readdir(path))
      .filter((entry) => path !== "/" || this.spaces.has(entry.name))
      .map((entry) => entry.name).sort();
    const ids = await Promise.all(names.map((name) => this.lookup(id, name)));
    const start = after === 0 ? 0 : ids.indexOf(after) + 1;
    if (after !== 0 && start === 0) throw new VfsError("EINVAL", "Expired NFS directory cursor");
    const end = Math.min(start + count, names.length);
    const entries = [];
    for (let i = start; i < end; i++) entries.push({ name: names[i], attr: await this.getattr(ids[i]) });
    return { entries, end: end === names.length };
  }
}

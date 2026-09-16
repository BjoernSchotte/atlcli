/**
 * Minimal async IFileSystem backed by a plain map, standing in for the
 * Confluence-backed filesystem the VFS will provide (WP0.2).
 *
 * Deliberately implements only the methods a remote backend can answer
 * cheaply, so the spike shows which methods just-bash actually calls.
 */
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "just-bash";

export interface FakeCallLog {
  method: string;
  path: string;
}

function enoent(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & {
    code?: string;
  };
  err.code = "ENOENT";
  return err;
}

/** Normalizes to an absolute posix path without a trailing slash. */
function norm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

export class FakeRemoteFs implements IFileSystem {
  readonly calls: FakeCallLog[] = [];
  private files = new Map<string, string>();
  private dirs = new Set<string>(["/"]);

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.seed(path, content);
    }
  }

  seed(path: string, content: string): void {
    const full = norm(path);
    this.files.set(full, content);
    let dir = full.slice(0, full.lastIndexOf("/")) || "/";
    while (dir !== "/") {
      this.dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
  }

  private record(method: string, path: string): void {
    this.calls.push({ method, path: norm(path) });
  }

  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    this.record("readFile", path);
    // Simulate remote latency so the spike exercises the async path.
    await Promise.resolve();
    const content = this.files.get(norm(path));
    if (content === undefined) throw enoent(path);
    return content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    this.record("readFileBuffer", path);
    return new TextEncoder().encode(await this.readFile(path));
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.record("writeFile", path);
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    this.seed(path, text);
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    this.record("appendFile", path);
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    this.seed(path, (this.files.get(norm(path)) ?? "") + text);
  }

  async exists(path: string): Promise<boolean> {
    this.record("exists", path);
    const full = norm(path);
    return this.files.has(full) || this.dirs.has(full);
  }

  async stat(path: string): Promise<FsStat> {
    this.record("stat", path);
    const full = norm(path);
    if (this.files.has(full)) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: this.files.get(full)!.length,
        mtime: new Date("2026-09-15T00:00:00Z"),
      };
    }
    if (this.dirs.has(full)) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date("2026-09-15T00:00:00Z"),
      };
    }
    throw enoent(path);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    this.record("mkdir", path);
    this.dirs.add(norm(path));
  }

  async readdir(path: string): Promise<string[]> {
    this.record("readdir", path);
    const full = norm(path);
    if (!this.dirs.has(full)) throw enoent(path);
    const prefix = full === "/" ? "/" : `${full}/`;
    const names = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.dirs]) {
      if (candidate === full || !candidate.startsWith(prefix)) continue;
      names.add(candidate.slice(prefix.length).split("/")[0]!);
    }
    return [...names].sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    this.record("readdirWithFileTypes", path);
    const full = norm(path);
    const names = await this.readdir(path);
    return names.map((name) => {
      const child = full === "/" ? `/${name}` : `${full}/${name}`;
      return {
        name,
        isFile: this.files.has(child),
        isDirectory: this.dirs.has(child),
        isSymbolicLink: false,
      };
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.record("rm", path);
    const full = norm(path);
    if (this.files.delete(full)) return;
    if (this.dirs.has(full)) {
      if (!options?.recursive) throw new Error(`ENOTEMPTY: ${path}`);
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(`${full}/`)) this.files.delete(key);
      }
      for (const key of [...this.dirs]) {
        if (key.startsWith(`${full}/`) || key === full) this.dirs.delete(key);
      }
      return;
    }
    if (!options?.force) throw enoent(path);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    this.record("cp", src);
    this.seed(dest, await this.readFile(src));
  }

  async mv(src: string, dest: string): Promise<void> {
    this.record("mv", src);
    this.seed(dest, await this.readFile(src));
    this.files.delete(norm(src));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return norm(path);
    return norm(`${base}/${path}`);
  }

  getAllPaths(): string[] {
    return [...this.files.keys(), ...this.dirs].sort();
  }

  async chmod(_path: string, _mode: number): Promise<void> {}

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("ENOSYS: symlink not supported by the fake backend");
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error("ENOSYS: link not supported by the fake backend");
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`EINVAL: not a symlink, '${path}'`);
  }

  async realpath(path: string): Promise<string> {
    return norm(path);
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}
}

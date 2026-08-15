import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ResearchContractError } from "./contracts.js";
import { normalizeResearchWorkspacePath, type ResearchWorkspace } from "./workspace.js";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class FileSystemResearchWorkspace implements ResearchWorkspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  static async createTemporary(prefix = "atlcli-research-"): Promise<FileSystemResearchWorkspace> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    await chmod(root, 0o700);
    return new FileSystemResearchWorkspace(root);
  }

  private resolveVirtual(path: string): string {
    const normalized = normalizeResearchWorkspacePath(path);
    const target = resolve(this.root, `.${normalized}`);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new ResearchContractError("access-denied", "Workspace path escapes its session root.");
    }
    return target;
  }

  private async assertNoSymlink(target: string): Promise<void> {
    const relativeTarget = relative(this.root, target);
    let current = this.root;
    for (const segment of relativeTarget.split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (!(await exists(current))) continue;
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new ResearchContractError("access-denied", "Workspace symlink escape is not allowed.");
    }
  }

  private async ensureDirectory(target: string): Promise<void> {
    const relativeTarget = relative(this.root, target);
    let current = this.root;
    for (const segment of relativeTarget.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new ResearchContractError("access-denied", "Workspace symlink escape is not allowed.");
      }
      if (!info.isDirectory()) {
        throw new ResearchContractError("access-denied", "Workspace parent path is not a directory.");
      }
    }
  }

  async readFile(path: string): Promise<string | undefined> {
    const target = this.resolveVirtual(path);
    await this.assertNoSymlink(target);
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    if (contents.length > 2_000_000) throw new ResearchContractError("limit-exceeded", "Workspace file is too large.");
    const target = this.resolveVirtual(path);
    const parent = dirname(target);
    await this.ensureDirectory(parent);
    const temporary = join(parent, `.atlcli-write-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async remove(path: string): Promise<void> {
    const target = this.resolveVirtual(path);
    await this.assertNoSymlink(target);
    await rm(target, { recursive: true, force: true });
  }

  async list(prefix = "/"): Promise<string[]> {
    const target = this.resolveVirtual(prefix);
    await this.assertNoSymlink(target);
    const results: string[] = [];
    const walk = async (current: string): Promise<void> => {
      if (!(await exists(current))) return;
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new ResearchContractError("access-denied", "Workspace symlink escape is not allowed.");
      if (info.isFile()) {
        results.push(`/${relative(this.root, current).split(sep).join("/")}`);
        return;
      }
      for (const entry of await readdir(current)) await walk(join(current, entry));
    };
    await walk(target);
    return results.sort();
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

import { parseVfsFrontmatter, VfsError, type ConfluenceVfs, type VfsWriteResult } from "@atlcli/confluence-vfs";
import { NfsJournal } from "./nfs-journal.js";

/** Publishes one durable page image; scheduling and NFS save boundaries are separate. */
export class NfsPublisher {
  private readonly running = new Map<string, Promise<VfsWriteResult | null>>();

  constructor(private readonly journal: NfsJournal, private readonly vfs: ConfluenceVfs,
    private readonly spaces: readonly string[]) {
    if (!spaces.length || spaces.some(space => !space || /[\/\0]/.test(space) || space === "." || space === "..")) {
      throw new VfsError("EINVAL", "Invalid publication export spaces");
    }
  }

  publish(id: string): Promise<VfsWriteResult | null> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const task = this.publishImage(id).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }

  private validate(id: string, bytes: Uint8Array, baseVersion: number): string {
    if (!/^[0-9]+$/.test(id)) throw new VfsError("EINVAL", "Only existing page IDs can be published");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new VfsError("EINVAL", "Staged page is not complete UTF-8"); }
    const { frontmatter } = parseVfsFrontmatter(content);
    if (frontmatter.id !== id || frontmatter.version === undefined || frontmatter.version > baseVersion) {
      throw new VfsError("EINVAL", "Staged page identity or base version is invalid");
    }
    return content;
  }

  private async publishImage(id: string): Promise<VfsWriteResult | null> {
    const file = this.journal.get(id);
    if (!file || file.revision === file.publishedRevision) return null;
    try {
      // Reject incomplete local bytes before freezing a publication intent.
      this.validate(id, file.bytes, file.baseVersion);
      const intent = this.journal.beginPublish(id)!;
      const content = this.validate(id, intent.bytes, intent.baseVersion);

      // Resolve by immutable page identity, never create a replacement at an old path.
      let target: { path: string; spaceKey: string } | undefined;
      for (const space of this.spaces) {
        const alias = `/${space}/.by-id/${id}.md`;
        try {
          const path = await this.vfs.readlink(alias);
          const resolved = await this.vfs.resolve(path);
          if (resolved.id === id && resolved.kind === "page" && resolved.spaceKey === space) {
            target = { path, spaceKey: space };
            break;
          }
        } catch (error) {
          if (error instanceof VfsError && error.code === "ENOENT") continue;
          throw error;
        }
      }
      if (!target) throw new VfsError("ENOENT", "Staged page is outside the selected export or was deleted");
      const result = await this.vfs.writeFile(target.path, content, { id, spaceKey: target.spaceKey });
      if (result.created || result.pageId !== id) throw new Error("Unexpected NFS publication identity");
      this.journal.completePublish(id, intent.revision, result.version);
      return result;
    } catch (error) {
      this.journal.failPublish(id, error instanceof VfsError ? error.code : "REMOTE_RESULT_UNKNOWN");
      throw error;
    }
  }
}

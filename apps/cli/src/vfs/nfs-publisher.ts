import { posix } from "node:path";
import { createInOrderLimiter } from "@atlcli/confluence";
import { threeWayMerge } from "@atlcli/confluence/internal";
import { parseVfsFrontmatter, renderFrontmatter, VfsError, type ConfluenceVfs, type VfsWriteResult } from "@atlcli/confluence-vfs";
import { NfsJournal } from "./nfs-journal.js";

/** Debounced publication of durable page images; transport save boundaries remain separate. */
export class NfsPublisher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly running = new Map<string, Promise<VfsWriteResult | null>>();
  // ponytail: one publication at a time bounds materialized bodies; raise only with a measured memory budget.
  private readonly limit = createInOrderLimiter(1);

  constructor(private readonly journal: NfsJournal, private readonly vfs: ConfluenceVfs,
    private readonly spaces: readonly string[]) {
    if (!spaces.length || spaces.some(space => !space || /[\/\0]/.test(space) || space === "." || space === "..")) {
      throw new VfsError("EINVAL", "Invalid publication export spaces");
    }
  }

  schedule(id: string): void {
    if (this.stopped) return;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(async () => {
      // A newer write can replace this timer while a preceding upload finishes.
      await this.running.get(id)?.catch(() => {});
      if (this.stopped || this.timers.get(id) !== timer) return;
      this.timers.delete(id);
      const result = await this.publish(id).catch(() => null); // Durable errors stay in the journal.
      // Recovery may first reconcile an older intent; no new editor event will
      // schedule the newer bytes that were already durable before restart.
      if (result && !this.timers.has(id) && this.journal.pendingIds().includes(id)) this.schedule(id);
    }, 500);
    timer.unref();
    this.timers.set(id, timer);
  }

  resume(): void {
    for (const id of this.journal.pendingIds()) this.schedule(id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.running.values());
  }

  publish(id: string): Promise<VfsWriteResult | null> {
    if (this.stopped) return Promise.reject(new VfsError("EAGAIN", "NFS publisher stopped"));
    const existing = this.running.get(id);
    if (existing) return existing;
    const task = this.limit(() => this.stopped || this.timers.has(id) ? Promise.resolve(null) : this.publishImage(id))
      .finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }

  private validate(id: string, bytes: Uint8Array, baseVersion: number): string {
    if (!/^[0-9]+$/.test(id)) throw new VfsError("EINVAL", "Only existing page IDs can be published");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new VfsError("EINVAL", "Staged page is not complete UTF-8"); }
    if (content.includes("\0")) throw new VfsError("EINVAL", "Staged page contains unwritten or binary bytes");
    const { frontmatter } = parseVfsFrontmatter(content);
    const plain = frontmatter.id === undefined && frontmatter.version === undefined;
    if (!plain && (frontmatter.id !== id || frontmatter.version === undefined || frontmatter.version > baseVersion)) {
      throw new VfsError("EINVAL", "Staged page identity or base version is invalid");
    }
    return content;
  }

  private async publishImage(id: string): Promise<VfsWriteResult | null> {
    const file = this.journal.get(id);
    if (!file || file.revision === file.publishedRevision) return null;
    if (this.journal.local(file.path)?.id === id || this.journal.displaced(file.path)?.id === id) return null;
    try {
      // Reject incomplete local bytes before freezing a publication intent.
      this.validate(id, file.bytes, file.baseVersion);
      // Existing uncertain outcomes keep their frozen image. New images are
      // frozen only after local validation/rebasing can no longer reject them.
      const intent = this.journal.publishIntent(id) ?? file;
      let content = this.validate(id, intent.bytes, intent.baseVersion);

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
      const source = this.journal.publishedSource(id);
      if (!source && parseVfsFrontmatter(content).frontmatter.id === undefined) {
        throw new VfsError("EINVAL", "Plain Markdown requires a durable published source");
      }
      if (source) {
        const base = parseVfsFrontmatter(new TextDecoder("utf-8", { fatal: true }).decode(source));
        const ours = parseVfsFrontmatter(content);
        let remote = parseVfsFrontmatter(await this.vfs.readFile(target.path));
        if (remote.frontmatter.version !== intent.baseVersion) {
          remote = parseVfsFrontmatter(await this.vfs.readFile(posix.join(posix.dirname(target.path), ".versions", `${intent.baseVersion}.md`)));
        }
        if (remote.frontmatter.id !== id || remote.frontmatter.version !== intent.baseVersion) {
          throw new VfsError("EBUSY", "Published base version is unavailable");
        }
        const merged = threeWayMerge(base.body, ours.body, remote.body);
        const title = ours.frontmatter.title === undefined || ours.frontmatter.title === base.frontmatter.title ? remote.frontmatter.title : ours.frontmatter.title;
        if (title === undefined || !merged.success || (ours.frontmatter.title !== undefined && ours.frontmatter.title !== base.frontmatter.title &&
            remote.frontmatter.title !== base.frontmatter.title && remote.frontmatter.title !== ours.frontmatter.title)) {
          throw new VfsError("EBUSY", "New local edits conflict with the previously published result");
        }
        content = `${renderFrontmatter({ ...ours.frontmatter, id, version: intent.baseVersion, title })}\n${merged.content}`;
      }
      // A backup rename can arrive while resolving/rebasing the frozen image.
      if (this.journal.displaced(this.journal.get(id)!.path)?.id === id) return null;
      if (!this.journal.beginPublish(id, intent.revision)) {
        this.schedule(id); // A newer edit arrived during asynchronous preparation.
        return null;
      }
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

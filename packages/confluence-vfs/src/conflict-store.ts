/**
 * Persisted conflict files (WP5.2, decision 9).
 *
 * When a three-way merge cannot reconcile a write, the edit **must not vanish
 * with the session.** An agent that ran `sed -i` across forty pages and lost
 * one to a concurrent edit has to be able to find that one afterwards, from
 * outside the shell that made it. So the losing content, both parents and the
 * markers land in a real file under the cache directory, and
 * `atlcli wiki vfs conflicts` lists them.
 *
 * Deleting a conflict file is a **local** operation: it touches no Confluence
 * content, so it is allowed in `ro` mode and without `--allow-delete`. Gating
 * it behind write permissions would leave a read-only session unable to clean
 * up after itself.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConflictRecord {
  pageId: string;
  path: string;
  /** Version the edit was based on. */
  baseVersion: number;
  /** Version the server had when the write was attempted. */
  serverVersion: number;
  createdAt: string;
  origin: string;
  /** The merged text, carrying conflict markers. */
  content: string;
  /** Absolute path of the file on disk. */
  file: string;
}

const HEADER = /^<!-- atlcli-vfs-conflict\n([\s\S]*?)\n-->\n/;

export class ConflictStore {
  constructor(private readonly dir: string) {}

  /** Writes one conflict and returns where it went. */
  record(conflict: Omit<ConflictRecord, "file">): ConflictRecord {
    mkdirSync(this.dir, { recursive: true });
    const stamp = conflict.createdAt.replace(/[:.]/g, "-");
    const file = join(this.dir, `${conflict.pageId}-${stamp}.md`);
    const header = [
      "<!-- atlcli-vfs-conflict",
      `pageId: ${conflict.pageId}`,
      `path: ${conflict.path}`,
      `baseVersion: ${conflict.baseVersion}`,
      `serverVersion: ${conflict.serverVersion}`,
      `createdAt: ${conflict.createdAt}`,
      `origin: ${conflict.origin}`,
      "-->",
      "",
    ].join("\n");
    writeFileSync(file, header + conflict.content);
    return { ...conflict, file };
  }

  list(): ConflictRecord[] {
    if (!existsSync(this.dir)) return [];
    const records: ConflictRecord[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const record = this.read(join(this.dir, name));
      if (record) records.push(record);
    }
    return records;
  }

  /** Every open conflict for one page, newest last. */
  forPage(pageId: string): ConflictRecord[] {
    return this.list().filter((record) => record.pageId === pageId);
  }

  read(file: string): ConflictRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const match = HEADER.exec(raw);
    if (!match) return undefined;
    const fields: Record<string, string> = {};
    for (const line of match[1]!.split("\n")) {
      const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (pair) fields[pair[1]!] = pair[2]!;
    }
    if (!fields.pageId) return undefined;
    return {
      pageId: fields.pageId,
      path: fields.path ?? "",
      baseVersion: Number(fields.baseVersion ?? 0),
      serverVersion: Number(fields.serverVersion ?? 0),
      createdAt: fields.createdAt ?? "",
      origin: fields.origin ?? "",
      content: raw.slice(match[0].length),
      file,
    };
  }

  /** Local-only, so permitted in `ro` mode and without `--allow-delete`. */
  discard(file: string): boolean {
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }

  discardAllFor(pageId: string): number {
    let removed = 0;
    for (const record of this.forPage(pageId)) {
      if (this.discard(record.file)) removed += 1;
    }
    return removed;
  }
}

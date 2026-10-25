/**
 * Copy an attachment to another issue through a private temp file, so the
 * bytes never sit in memory as a whole and no size cap beyond the target
 * site's own applies. Shared by `jira issue attachment copy`,
 * `jira issue clone --attachments`, `jira project copy-issues` and the
 * `jira.copyAttachment` script verb. Node-only (fs, os): not part of the
 * browser barrel.
 */
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { JiraClient } from "./client.js";
import type { JiraAttachment } from "./types.js";

export interface CopyAttachmentOptions {
  signal?: AbortSignal;
  /** The source's metadata when the caller already has it (saves a request). */
  source?: JiraAttachment;
  /** Directory for the temp folder; defaults to `os.tmpdir()`. */
  tempRoot?: string;
}

/**
 * Download attachment `id` to a temp file, check its size against the
 * metadata, upload it to `toIssue` under the same filename, and always remove
 * the temp folder. A size mismatch aborts before anything is uploaded.
 */
export async function copyAttachment(
  client: JiraClient,
  id: string,
  toIssue: string,
  options: CopyAttachmentOptions = {},
): Promise<JiraAttachment> {
  const source = options.source ?? (await client.getAttachment(id));
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "atlcli-attach-"));
  try {
    const path = join(dir, "content");
    const res = await client.openAttachment(source.content, { signal: options.signal });
    if (!res.body) throw new Error(`Attachment ${id} has no content`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(path, { mode: 0o600 }), { signal: options.signal });
    const { size } = await stat(path);
    if (size !== source.size) {
      throw new Error(`Attachment ${id} (${source.filename}) downloaded ${size} bytes, expected ${source.size}; nothing uploaded`);
    }
    const [uploaded] = await client.uploadAttachment(toIssue, source.filename, await openAsBlob(path));
    if (!uploaded) throw new Error(`Jira returned no attachment for ${source.filename} on ${toIssue}`);
    return uploaded;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

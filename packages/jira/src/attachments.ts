/**
 * Pure helpers behind `atlcli jira issue attachments` / `jira issue attachment`
 * (issue #8: both commands were documented but never wired into the CLI).
 *
 * Everything here is the functional core: argument shapes, filename safety,
 * collision handling and rendering. The imperative shell (`apps/cli`) does the
 * REST calls and the writes. Keeping the rules here is what makes the nasty
 * cases — a server-supplied `../../.ssh/authorized_keys`, two attachments
 * called `screenshot.png` on the same issue — testable without a Jira or a
 * filesystem.
 */
import type { JiraAttachment } from "./types.js";

/** What `attachment download|delete` was pointed at. */
export type AttachmentTarget =
  | { kind: "id"; id: string }
  | { kind: "issue"; issueKey: string; filename: string };

export type AttachmentTargetResult =
  | { ok: true; target: AttachmentTarget }
  | { ok: false; error: string };

/** An attachment id is always numeric in both Jira Cloud and Server/DC. */
const ATTACHMENT_ID = /^\d+$/;

/**
 * Read the positional arguments of `attachment download|delete`.
 *
 * Two documented shapes:
 *   `<attachment-id>`            → download/delete that exact attachment
 *   `<issue-key> <filename>`     → look the name up on the issue first
 *
 * A single non-numeric argument is the interesting error: it is almost always
 * an issue key whose filename the user forgot, so say that instead of a generic
 * usage line.
 */
export function parseAttachmentTarget(args: string[]): AttachmentTargetResult {
  const positional = args.filter((a) => a.length > 0);

  if (positional.length === 0) {
    return {
      ok: false,
      error: "Attachment id or <issue-key> <filename> is required.",
    };
  }

  if (positional.length === 1) {
    const [only] = positional;
    if (ATTACHMENT_ID.test(only)) {
      return { ok: true, target: { kind: "id", id: only } };
    }
    return {
      ok: false,
      error: `"${only}" is not an attachment id. Pass a numeric id, or an issue key followed by a filename.`,
    };
  }

  if (positional.length === 2) {
    const [issueKey, filename] = positional;
    if (ATTACHMENT_ID.test(issueKey)) {
      return {
        ok: false,
        error: `Expected an issue key before "${filename}", got the attachment id ${issueKey}. Pass either an id alone or <issue-key> <filename>.`,
      };
    }
    return { ok: true, target: { kind: "issue", issueKey, filename } };
  }

  return {
    ok: false,
    error: `Too many arguments: ${positional.join(" ")}. Expected <attachment-id> or <issue-key> <filename>.`,
  };
}

/** An issue key: project key, dash, number (`PROJ-123`, `ATLCLI-1`). */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** What `jira issue attach` was asked to upload. */
export type AttachRequest = { issueKey: string; files: string[] };

export type AttachRequestResult =
  | { ok: true; request: AttachRequest }
  | { ok: false; error: string };

const ATTACH_USAGE = "Usage: jira issue attach <issue-key> <file> [file...]";

/**
 * Read the arguments of `jira issue attach` (issue #90).
 *
 * Two documented shapes, both accepted:
 *   `attach PROJ-123 a.png b.pdf`          → key positional, several files
 *   `attach --key PROJ-123 a.png b.pdf`    → key as a flag (the older syntax)
 *
 * Every remaining positional is a file: a glob the shell expanded to ten paths
 * uploads ten files. Silently keeping only the first — the old behaviour — is
 * what made this a data-loss-shaped bug in scripts.
 *
 * A first positional that is not issue-key-shaped and no `--key` is the
 * interesting error: the old code passed it straight to the filesystem and
 * reported `File not found: PROJ-123`, which pointed at the wrong thing.
 */
export function parseAttachRequest(
  args: string[],
  keyFlag?: string
): AttachRequestResult {
  const positional = args.filter((a) => a.length > 0);

  if (keyFlag) {
    // `--key` wins; a positional repeat of the same key is a paste artefact,
    // not a file, so drop it rather than failing on `File not found: PROJ-123`.
    const files =
      positional[0] === keyFlag ? positional.slice(1) : positional;
    if (files.length === 0) {
      return { ok: false, error: `At least one file is required. ${ATTACH_USAGE}` };
    }
    return { ok: true, request: { issueKey: keyFlag, files } };
  }

  if (positional.length === 0) {
    return { ok: false, error: `Issue key and at least one file are required. ${ATTACH_USAGE}` };
  }

  const [first, ...rest] = positional;
  if (!ISSUE_KEY.test(first)) {
    return {
      ok: false,
      error: `"${first}" is not an issue key. ${ATTACH_USAGE}`,
    };
  }

  if (rest.length === 0) {
    return { ok: false, error: `At least one file is required. ${ATTACH_USAGE}` };
  }

  return { ok: true, request: { issueKey: first, files: rest } };
}

/**
 * Every attachment on the issue carrying `filename`.
 *
 * Jira does not enforce unique attachment names, so this returns a list on
 * purpose — the caller downloads all matches rather than silently picking one.
 * Exact matches win outright; only when there are none does the case-insensitive
 * pass run, so `Screenshot.png` never shadows an exact `screenshot.png`.
 */
export function selectAttachmentsByFilename<T extends { filename: string }>(
  attachments: readonly T[],
  filename: string
): T[] {
  const exact = attachments.filter((a) => a.filename === filename);
  if (exact.length > 0) return exact;
  const lower = filename.toLowerCase();
  return attachments.filter((a) => a.filename.toLowerCase() === lower);
}

/**
 * Reduce a server-supplied attachment name to something safe to write.
 *
 * The name comes from whoever uploaded the file, so it is untrusted input on a
 * path: separators are stripped down to the basename (`../../etc/passwd` →
 * `passwd`), and names that resolve to no file at all fall back to
 * `attachment-<id>`.
 */
export function sanitizeAttachmentFilename(filename: string, id: string): string {
  const withoutPath = filename.split(/[/\\]/).pop() ?? "";
  // Control characters (NUL included) are never part of a real filename and
  // break the write on some platforms.
  const cleaned = withoutPath.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return `attachment-${id}`;
  }
  return cleaned;
}

/**
 * Insert an attachment id before the extension: `shot.png` → `shot.10001.png`.
 *
 * Splitting on the LAST dot keeps the real extension intact, and a leading dot
 * is not an extension (`.gitignore` → `.gitignore.10001`).
 */
export function insertIdSuffix(filename: string, id: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}.${id}`;
  return `${filename.slice(0, dot)}.${id}${filename.slice(dot)}`;
}

/** An attachment paired with the name it should be written under. */
export type PlannedDownload<T> = { attachment: T; filename: string };

/**
 * Decide the on-disk name for each attachment about to be written.
 *
 * Names are sanitized first, and only names that collide *within this batch*
 * get an id suffix — downloading a single `screenshot.png` still writes
 * `screenshot.png`, while two attachments of that name on one issue become
 * `screenshot.10001.png` and `screenshot.10002.png` instead of one overwriting
 * the other.
 */
export function planDownloads<T extends { id: string; filename: string }>(
  attachments: readonly T[]
): PlannedDownload<T>[] {
  const sanitized = attachments.map((attachment) => ({
    attachment,
    filename: sanitizeAttachmentFilename(attachment.filename, attachment.id),
  }));

  const counts = new Map<string, number>();
  for (const { filename } of sanitized) {
    counts.set(filename, (counts.get(filename) ?? 0) + 1);
  }

  return sanitized.map(({ attachment, filename }) =>
    (counts.get(filename) ?? 0) > 1
      ? { attachment, filename: insertIdSuffix(filename, attachment.id) }
      : { attachment, filename }
  );
}

/**
 * Whether `-o/--output` names a directory to write into or the target file.
 *
 * `existsAsDirectory` is the caller's filesystem answer; a trailing separator
 * is honoured even when the directory does not exist yet (the shell creates
 * it), and more than one file to write can only mean a directory.
 */
export function outputIsDirectory(
  output: string | undefined,
  opts: { existsAsDirectory: boolean; fileCount: number }
): boolean {
  if (output === undefined) return true;
  if (opts.existsAsDirectory) return true;
  if (/[/\\]$/.test(output)) return true;
  return opts.fileCount > 1;
}

/**
 * The path a single download is written to.
 *
 * `output` as a file path is only honoured for a single file; `planDownloads`
 * has already made `filename` unique and safe.
 */
export function resolveDownloadPath(
  output: string | undefined,
  filename: string,
  opts: { isDirectory: boolean }
): string {
  if (output === undefined) return filename;
  if (!opts.isDirectory) return output;
  const base = output.replace(/[/\\]+$/, "");
  return base === "" ? `/${filename}` : `${base}/${filename}`;
}

/** `245 KB`, `1.2 MB` — the sizes the docs table promises. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** ISO timestamp → `YYYY-MM-DD`; anything unparseable passes through. */
export function formatAttachmentDate(created: string | undefined): string {
  if (!created) return "-";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(created);
  return match ? match[1] : created;
}

/** The `--json` shape documented on the Attachments page. */
export type AttachmentJson = {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  author: { displayName: string; email?: string };
  content: string;
};

export function toAttachmentJson(attachment: JiraAttachment): AttachmentJson {
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    mimeType: attachment.mimeType,
    created: attachment.created,
    author: {
      displayName: attachment.author?.displayName ?? "Unknown",
      ...(attachment.author?.emailAddress
        ? { email: attachment.author.emailAddress }
        : {}),
    },
    content: attachment.content,
  };
}

/** `ID  FILENAME  SIZE  CREATED`, column widths driven by the actual rows. */
export function formatAttachmentsTable(attachments: readonly JiraAttachment[]): string[] {
  const rows = attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    size: formatAttachmentSize(a.size),
    created: formatAttachmentDate(a.created),
  }));

  const width = (header: string, values: string[]): number =>
    Math.max(header.length, ...values.map((v) => v.length), 0);

  const idWidth = width("ID", rows.map((r) => r.id));
  const nameWidth = width("FILENAME", rows.map((r) => r.filename));
  const sizeWidth = width("SIZE", rows.map((r) => r.size));

  const lines = [
    `${"ID".padEnd(idWidth)}  ${"FILENAME".padEnd(nameWidth)}  ${"SIZE".padEnd(sizeWidth)}  CREATED`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.id.padEnd(idWidth)}  ${row.filename.padEnd(nameWidth)}  ${row.size.padEnd(sizeWidth)}  ${row.created}`
    );
  }
  return lines;
}

/**
 * Session-auth read path (spec 003 Task 2 + Task 3).
 *
 * Loads a detected Confluence page in the PANEL context (PLAN §2.1: extension
 * pages share the extension's host permissions, so plain fetches ride the user's
 * Atlassian session without a SW proxy). The converter and attachment metadata
 * (Task 3) are folded in here so the panel gets a single, ready-to-render
 * result object.
 *
 * The client is imported through `@atlcli/confluence/browser` — the browser
 * entry from Task 0 — so the panel bundle never drags the node-only barrel.
 *
 * Error taxonomy (PLAN §2.3) is a pure classifier over the thrown value plus one
 * shape check: ConfluenceClient does NOT throw on a 200 HTML login page (its
 * JSON.parse falls back to the raw text, yielding a details object with no
 * `id`). Changing that fallback would break the CLI's empty-body handling
 * (DELETE etc.), so — per the PLAN pitfall — the login-page classification lives
 * HERE, in the extension wrapper, keyed off the missing `id`.
 */
import {
  ConfluenceClient,
  storageToMarkdown,
  type AttachmentInfo,
  type ConfluencePageDetails,
} from "@atlcli/confluence/browser";
import type { Profile } from "@atlcli/core";

/** Distinct, user-renderable failure classes (PLAN §2.3 / §2.4). */
export type ReadErrorKind = "not-logged-in" | "access-denied" | "network" | "unknown";

/** A classified read failure carrying the panel-facing error kind. */
export class ReadError extends Error {
  constructor(
    readonly kind: ReadErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ReadError";
  }
}

/** Attachment metadata surfaced to the panel (Task 3): count + per-file detail. */
export interface AttachmentMeta {
  name: string;
  mediaType: string;
  /** Size in bytes (0 when Confluence omits it). */
  size: number;
  /** Download link relative to the Confluence base (for 004 image embedding). */
  link: string;
}

/** Everything the `loaded` panel state renders (PLAN §2.4). */
export interface LoadedPage {
  details: ConfluencePageDetails;
  /** Storage body converted to markdown (Task 3). */
  markdown: string;
  /** Word count of the converted markdown (006 benchmark input). */
  wordCount: number;
  attachments: AttachmentMeta[];
}

/**
 * Pure: map a thrown value to an error kind (PLAN §2.3).
 *
 * ConfluenceClient throws `Confluence API[ v2] error (<status>): …` for HTTP
 * error responses; a network/CORS failure surfaces the raw `fetch` rejection
 * (a `TypeError`). Anything else (5xx-after-retries, rate limit, malformed) is
 * `unknown`.
 */
export function classifyThrownError(err: unknown): ReadErrorKind {
  const message = err instanceof Error ? err.message : String(err);

  const status = message.match(/Confluence API(?: v2)? error \((\d{3})\)/);
  if (status) {
    const code = Number(status[1]);
    if (code === 401) return "not-logged-in";
    if (code === 403 || code === 404) return "access-denied";
    return "unknown";
  }

  if (err instanceof TypeError) return "network";
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) {
    return "network";
  }
  return "unknown";
}

/** Count words in markdown (whitespace-separated non-empty tokens). */
export function countWords(markdown: string): number {
  const tokens = markdown.trim().split(/\s+/).filter(Boolean);
  return tokens.length;
}

/** Shape a client `AttachmentInfo` into the panel-facing metadata. */
export function toAttachmentMeta(a: AttachmentInfo): AttachmentMeta {
  return { name: a.filename, mediaType: a.mediaType, size: a.fileSize, link: a.downloadUrl };
}

/** Injectable seam so tests can supply a fake client without a real network. */
export interface ReadPathDeps {
  makeClient: (profile: Profile) => Pick<
    ConfluenceClient,
    "getPageDetails" | "listAttachments"
  >;
  /** storage → markdown converter (defaults to the shared one). */
  toMarkdown: (storage: string) => string;
}

const defaultDeps: ReadPathDeps = {
  makeClient: (profile) => new ConfluenceClient(profile),
  toMarkdown: (storage) => storageToMarkdown(storage),
};

/**
 * Load a Confluence page via session auth and produce the panel's `loaded`
 * payload. Throws {@link ReadError} with a classified `kind` on any failure.
 *
 * Attachment listing is best-effort: a failure there does not sink the whole
 * load (the page content is the primary artifact), so it degrades to an empty
 * list rather than an error state.
 *
 * @param pageId   the Confluence content id (from the detected entity).
 * @param profile  session profile (from {@link profileFromTabUrl}).
 * @param deps     injectable client/converter seam (defaults to real impls).
 */
export async function loadConfluencePage(
  pageId: string,
  profile: Profile,
  deps: Partial<ReadPathDeps> = {}
): Promise<LoadedPage> {
  const { makeClient, toMarkdown } = { ...defaultDeps, ...deps };
  const client = makeClient(profile);

  let details: ConfluencePageDetails;
  try {
    details = await client.getPageDetails(pageId);
  } catch (err) {
    throw new ReadError(classifyThrownError(err), err instanceof Error ? err.message : String(err));
  }

  // A 200 HTML login page parses to a details object with no id (see file
  // header): treat it as not-logged-in, the SameSite/session proof (PLAN §2.3).
  if (!details.id) {
    throw new ReadError(
      "not-logged-in",
      "Confluence returned a non-page response (login page?) with HTTP 200"
    );
  }

  const markdown = toMarkdown(details.storage ?? "");
  const wordCount = countWords(markdown);

  let attachments: AttachmentMeta[] = [];
  try {
    const list = await client.listAttachments(pageId);
    attachments = list.map(toAttachmentMeta);
  } catch {
    // Non-fatal: keep the page, show zero attachments.
    attachments = [];
  }

  return { details, markdown, wordCount, attachments };
}

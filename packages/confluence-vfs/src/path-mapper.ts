/**
 * Names and paths (WP2.1).
 *
 * Decision 4: every page is `<slug>-<id>` — `architecture-623869955.md` for a
 * leaf, `architecture-623869955/` for a page with children. **The ID is the
 * key and the slug is decoration.** Two consequences fall straight out:
 *
 *  - Collisions are impossible, so `generateUniqueFilename()` is not needed.
 *  - A rename does not break an existing path: `cat architecture-62.../‌_index.md`
 *    still resolves after the page is retitled to "Platform Architecture",
 *    because resolution never looks at the slug.
 *
 * ## The digit trap
 *
 * `parseName` cannot decide on its own where a title ends and an ID begins.
 * A page titled "Release 2026" is `release-2026-623869955.md`, and the greedy
 * pattern splits that correctly. But a *new* file the user wrote as
 * `release-2026.md` has no ID at all, and a naive parse would read `2026` as
 * one. So `parseName` only ever reports a **candidate**, and
 * {@link resolveNameToId} confirms it against the tree index before it counts.
 * Nothing in this module may treat an unconfirmed candidate as an ID.
 */
import { slugifyTitle } from "@atlcli/confluence/internal";
import { VfsError } from "./types.js";

/** The file inside a page directory that carries the page's own body. */
export const INDEX_FILE = "_index.md";

/** Names the VFS owns. A page can never shadow one of these. */
export const RESERVED_NAMES = new Set([
  INDEX_FILE,
  "_space.json",
  "_attachments",
  ".versions",
  ".comments.md",
  ".by-id",
  ".labels",
  ".recent",
  ".search",
  ".me.json",
]);

/** Reserved names that only make sense at the filesystem root. */
export const ROOT_RESERVED_NAMES = new Set([".me.json"]);

/** Reserved names that only make sense directly inside a space. */
export const SPACE_RESERVED_NAMES = new Set([
  "_space.json",
  ".by-id",
  ".labels",
  ".recent",
  ".search",
]);

/**
 * `slugifyTitle` with a floor.
 *
 * A title made entirely of characters the slugifier drops ("日本語", "***")
 * slugifies to the empty string, which would produce the name `-623869955.md`.
 * Legal, but it reads like a bug and confuses shell globs starting with `-`,
 * so those fall back to a fixed stem. The ID still carries all the meaning.
 */
export function vfsSlug(title: string | undefined | null): string {
  const slug = slugifyTitle(title);
  return slug === "" ? "page" : slug;
}

/** `<slug>-<id>.md` for a leaf, `<slug>-<id>` for a page with children. */
export function formatName(title: string, id: string, hasChildren: boolean): string {
  const stem = `${vfsSlug(title)}-${id}`;
  return hasChildren ? stem : `${stem}.md`;
}

/** The directory form, used when a page turns out to have children. */
export function formatDirName(title: string, id: string): string {
  return `${vfsSlug(title)}-${id}`;
}

/**
 * Strips the extension the VFS gives a node.
 *
 * Two shapes: `<slug>-<id>.md` for a page body, and
 * `<slug>-<id>.<type>.json` for a whiteboard, database or embed stub.
 */
export function stripVfsExtension(name: string): {
  stem: string;
  isMarkdown: boolean;
  nonPageType: string | undefined;
} {
  if (name.endsWith(".md")) {
    return { stem: name.slice(0, -3), isMarkdown: true, nonPageType: undefined };
  }
  const json = /^(.*)\.([a-z][a-z0-9-]*)\.json$/.exec(name);
  if (json) return { stem: json[1]!, isMarkdown: false, nonPageType: json[2]! };
  return { stem: name, isMarkdown: false, nonPageType: undefined };
}

export interface ParsedName {
  /** The name with any `.md` removed. */
  stem: string;
  /** Trailing digits that *might* be a page ID. Confirm before believing it. */
  idCandidate: string | undefined;
  /** Everything before the candidate ID. Meaningless until the ID is confirmed. */
  slugCandidate: string;
  /** True when the name ended in `.md`. */
  isMarkdown: boolean;
  /** The content type for a `<slug>-<id>.<type>.json` stub, if that is what this is. */
  nonPageType: string | undefined;
}

/**
 * Split a name into its slug and ID candidate.
 *
 * Greedy on purpose: for `release-2026-623869955.md` the last digit run is the
 * ID and `release-2026` is the slug. Callers must still confirm — see the
 * module comment.
 */
export function parseName(name: string): ParsedName {
  const { stem, isMarkdown, nonPageType } = stripVfsExtension(name);
  const match = /^(.*)-(\d+)$/.exec(stem);
  if (!match) {
    return { stem, idCandidate: undefined, slugCandidate: stem, isMarkdown, nonPageType };
  }
  return {
    stem,
    idCandidate: match[2],
    slugCandidate: match[1]!,
    isMarkdown,
    nonPageType,
  };
}

/**
 * Confirm a name's ID candidate against something that knows the real IDs.
 *
 * `knowsId` is the tree index. Returning `undefined` means "this name does not
 * address an existing node by ID", which is how a newly written
 * `release-2026.md` stays a *new page* rather than an edit of page 2026.
 */
export function resolveNameToId(
  name: string,
  knowsId: (id: string) => boolean,
): string | undefined {
  const parsed = parseName(name);
  if (parsed.idCandidate === undefined) return undefined;
  return knowsId(parsed.idCandidate) ? parsed.idCandidate : undefined;
}

/**
 * Title for a page created from a name that carried no ID.
 *
 * `new-page.md` becomes "New Page". Crude on purpose: frontmatter wins whenever
 * it is present (WP5.3), and this is only the fallback for `touch` and
 * `echo > file`.
 */
export function titleFromName(name: string): string {
  const parsed = parseName(name);
  const words = parsed.stem.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return "Untitled";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Absolute, normalised, no trailing slash. `/` stays `/`. */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new VfsError("EINVAL", `Path escapes the filesystem root: ${path}`, { path });
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** Normalised path split into segments; `/` yields an empty array. */
export function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

/** `["/DOCSY/a-1", "b-2.md"]`, the POSIX `dirname`/`basename` pair. */
export function splitParent(path: string): { parent: string; name: string } {
  const segments = splitPath(path);
  if (segments.length === 0) {
    throw new VfsError("EINVAL", "The filesystem root has no parent", { path });
  }
  const name = segments[segments.length - 1]!;
  const parent = segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
  return { parent, name };
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** A Confluence space key: upper-case letters, digits and underscores. */
export function isSpaceKey(segment: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(segment) && !RESERVED_NAMES.has(segment);
}

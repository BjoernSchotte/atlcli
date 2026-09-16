/**
 * Path resolution (WP2.2).
 *
 * Turns `/DOCSY/architecture-623869955/_attachments/diagram.png` into a tagged
 * description of what that path *is*, loading exactly the directory levels it
 * had to walk and no more.
 *
 * ## Deviation from the plan: every page is a directory
 *
 * Section 7 of the plan shows a leaf page as `getting-started-623869001.md` and
 * a page with children as `architecture-623869955/`. That layout is not
 * reachable under the demand principle: deciding which form a child takes means
 * knowing whether *that child* has children, and Confluence answers that only
 * with one `direct-children` request per child — the N+1 that rule 1 exists to
 * forbid. The two ways out were both worse:
 *
 *  - Spend a request per entry on every `ls`. Rejected: rule 1.
 *  - Guess "leaf" for anything not yet entered. Rejected for the same reason
 *    decision 12 rejects a silently-empty `grep`: `ls -R`, `find` and recursive
 *    `grep` would quietly skip whole subtrees, and an agent reads a missing
 *    result as "not there".
 *
 * So a **page is always a directory** and its body is always `_index.md`.
 * `<slug>-<id>.md` stays resolvable as an alias for `<slug>-<id>/_index.md`, so
 * the short form in the plan's examples still works — it is simply not what a
 * listing shows. Recorded as deviation D1 in the plan.
 */
import type { TreeIndex, TreeNode } from "./tree-index.js";
import {
  INDEX_FILE,
  parseName,
  splitPath,
  vfsSlug,
} from "./path-mapper.js";
import { VfsError } from "./types.js";

/** Content types that have a Markdown body. Everything else is a JSON stub. */
export function hasBody(node: TreeNode): boolean {
  return node.type === "page";
}

/** Containers you can `cd` into. */
export function isContainer(node: TreeNode): boolean {
  return node.type === "page" || node.type === "folder";
}

export const RECENT_WINDOWS = ["24h", "7d", "30d"] as const;
export type RecentWindow = (typeof RECENT_WINDOWS)[number];

export type Resolved =
  | { kind: "root" }
  | { kind: "me-json" }
  | { kind: "space"; spaceKey: string; homepageId: string | null }
  | { kind: "space-json"; spaceKey: string }
  /** A page or folder addressed as a directory. */
  | { kind: "container"; node: TreeNode }
  /** A page's Markdown body: `_index.md`, or the `<slug>-<id>.md` alias. */
  | { kind: "body"; node: TreeNode }
  /** A whiteboard, database or embed: read-only JSON carrying a link. */
  | { kind: "non-page"; node: TreeNode }
  | { kind: "attachments-dir"; node: TreeNode }
  | { kind: "attachment"; node: TreeNode; filename: string }
  | { kind: "versions-dir"; node: TreeNode }
  | { kind: "version-file"; node: TreeNode; version: number }
  | { kind: "comments-file"; node: TreeNode }
  | { kind: "conflict-file"; node: TreeNode }
  | { kind: "by-id-dir"; spaceKey: string }
  | { kind: "by-id-link"; spaceKey: string; id: string }
  | { kind: "labels-dir"; spaceKey: string }
  | { kind: "label-dir"; spaceKey: string; label: string }
  | { kind: "label-link"; spaceKey: string; label: string; name: string }
  | { kind: "recent-dir"; spaceKey: string }
  | { kind: "recent-window"; spaceKey: string; window: RecentWindow }
  | { kind: "recent-link"; spaceKey: string; window: RecentWindow; name: string }
  | { kind: "search-dir"; spaceKey: string }
  | { kind: "search-readme"; spaceKey: string }
  | { kind: "search-query"; spaceKey: string; query: string }
  | { kind: "search-link"; spaceKey: string; query: string; name: string };

function enoent(path: string): VfsError {
  return new VfsError("ENOENT", `No such file or directory: ${path}`, { path });
}

/**
 * Names a *new* file may take inside a page directory, so `writeFile` on a
 * path that does not exist yet can still say what it would create.
 */
export interface ResolveOptions {
  /** Return a description of what the last segment *would* be, not ENOENT. */
  allowMissingLeaf?: boolean;
}

export interface MissingLeaf {
  kind: "missing";
  /** The directory the missing name sits in. */
  parent: Resolved;
  name: string;
  path: string;
}

export type ResolveResult = Resolved | MissingLeaf;

export class PathResolver {
  constructor(private readonly index: TreeIndex) {}

  /** Resolve a path, loading only the levels it has to walk. */
  async resolve(path: string, options: ResolveOptions = {}): Promise<ResolveResult> {
    const segments = splitPath(path);
    if (segments.length === 0) return { kind: "root" };

    const [first, ...rest] = segments;
    if (first === ".me.json") {
      if (rest.length > 0) throw enoent(path);
      return { kind: "me-json" };
    }

    // A space key is the only thing that lives at the root.
    const homepageId = await this.index.getHomepageId(first!).catch((error: unknown) => {
      // getSpace already answers ENOENT for an invisible or unknown key; keep
      // that, and keep the caller's path on it.
      if (error instanceof VfsError && error.code === "ENOENT") throw enoent(path);
      throw error;
    });
    const space: Resolved = { kind: "space", spaceKey: first!, homepageId };
    if (rest.length === 0) return space;

    return this.resolveInSpace(first!, homepageId, rest, path, options);
  }

  private async resolveInSpace(
    spaceKey: string,
    homepageId: string | null,
    segments: string[],
    path: string,
    options: ResolveOptions,
  ): Promise<ResolveResult> {
    const [head, ...rest] = segments;

    switch (head) {
      case "_space.json":
        if (rest.length > 0) throw enoent(path);
        return { kind: "space-json", spaceKey };
      case INDEX_FILE: {
        if (rest.length > 0) throw enoent(path);
        if (!homepageId) throw enoent(path);
        const node = this.index.node(homepageId);
        if (!node) throw enoent(path);
        return { kind: "body", node };
      }
      case ".by-id":
        return this.resolveById(spaceKey, rest, path);
      case ".labels":
        return this.resolveLabels(spaceKey, rest, path);
      case ".recent":
        return this.resolveRecent(spaceKey, rest, path);
      case ".search":
        return this.resolveSearch(spaceKey, rest, path);
      default:
        break;
    }

    if (!homepageId) throw enoent(path);
    return this.resolveUnderContainer(homepageId, segments, path, options);
  }

  /**
   * Walk page segments one level at a time.
   *
   * Each step costs at most one `direct-children` request, and only for the
   * directory actually being entered.
   */
  private async resolveUnderContainer(
    containerId: string,
    segments: string[],
    path: string,
    options: ResolveOptions,
  ): Promise<ResolveResult> {
    let currentId = containerId;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const rest = segments.slice(i + 1);
      const currentNode = this.index.node(currentId);
      if (!currentNode) throw enoent(path);

      // Side objects of the *current* page, not children of it.
      const side = this.resolveSideObject(currentNode, segment, rest, path);
      if (side) return side;

      const children = await this.index.loadChildren(currentId);
      const match = this.matchChild(children, segment);

      if (!match) {
        if (options.allowMissingLeaf && rest.length === 0) {
          return {
            kind: "missing",
            parent: { kind: "container", node: currentNode },
            name: segment,
            path,
          };
        }
        throw enoent(path);
      }

      // `<slug>-<id>.md` addresses the body directly, so it must be last.
      if (match.asBody) {
        if (rest.length > 0) throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
        return hasBody(match.node)
          ? { kind: "body", node: match.node }
          : { kind: "non-page", node: match.node };
      }

      if (rest.length === 0) {
        if (!isContainer(match.node)) return { kind: "non-page", node: match.node };
        return { kind: "container", node: match.node };
      }

      if (!isContainer(match.node)) {
        throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
      }
      currentId = match.node.id;
    }

    const node = this.index.node(currentId);
    if (!node) throw enoent(path);
    return { kind: "container", node };
  }

  /**
   * Match a listed child by ID.
   *
   * The slug is ignored entirely, which is what makes a path survive a rename.
   * A name whose trailing digits are *not* a child's ID does not match, so
   * `release-2026.md` stays a missing name rather than addressing page 2026.
   */
  private matchChild(
    children: TreeNode[],
    segment: string,
  ): { node: TreeNode; asBody: boolean } | undefined {
    const parsed = parseName(segment);
    if (parsed.idCandidate === undefined) return undefined;
    const node = children.find((child) => child.id === parsed.idCandidate);
    if (!node) return undefined;
    return { node, asBody: parsed.isMarkdown };
  }

  /** `_index.md`, `_attachments/`, `.versions/`, `.comments.md` of one page. */
  private resolveSideObject(
    node: TreeNode,
    segment: string,
    rest: string[],
    path: string,
  ): Resolved | undefined {
    switch (segment) {
      case INDEX_FILE:
        if (rest.length > 0) throw enoent(path);
        return hasBody(node) ? { kind: "body", node } : { kind: "non-page", node };
      case ".comments.md":
        if (rest.length > 0) throw enoent(path);
        return { kind: "comments-file", node };
      case "_attachments": {
        if (rest.length === 0) return { kind: "attachments-dir", node };
        if (rest.length > 1) throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
        return { kind: "attachment", node, filename: rest[0]! };
      }
      case ".versions": {
        if (rest.length === 0) return { kind: "versions-dir", node };
        if (rest.length > 1) throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
        const version = Number(rest[0]!.replace(/\.md$/, ""));
        if (!Number.isInteger(version) || version < 1) throw enoent(path);
        return { kind: "version-file", node, version };
      }
      default:
        return undefined;
    }
  }

  private resolveById(spaceKey: string, rest: string[], path: string): Resolved {
    if (rest.length === 0) return { kind: "by-id-dir", spaceKey };
    if (rest.length > 1) throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
    const id = rest[0]!.replace(/\.md$/, "");
    if (!/^\d+$/.test(id)) throw enoent(path);
    return { kind: "by-id-link", spaceKey, id };
  }

  private resolveLabels(spaceKey: string, rest: string[], path: string): Resolved {
    if (rest.length === 0) return { kind: "labels-dir", spaceKey };
    if (rest.length === 1) return { kind: "label-dir", spaceKey, label: rest[0]! };
    if (rest.length === 2) {
      return { kind: "label-link", spaceKey, label: rest[0]!, name: rest[1]! };
    }
    throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
  }

  private resolveRecent(spaceKey: string, rest: string[], path: string): Resolved {
    if (rest.length === 0) return { kind: "recent-dir", spaceKey };
    const window = rest[0]! as RecentWindow;
    if (!RECENT_WINDOWS.includes(window)) throw enoent(path);
    if (rest.length === 1) return { kind: "recent-window", spaceKey, window };
    if (rest.length === 2) return { kind: "recent-link", spaceKey, window, name: rest[1]! };
    throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
  }

  private resolveSearch(spaceKey: string, rest: string[], path: string): Resolved {
    if (rest.length === 0) return { kind: "search-dir", spaceKey };
    if (rest[0] === "README") return { kind: "search-readme", spaceKey };
    if (rest.length === 1) return { kind: "search-query", spaceKey, query: rest[0]! };
    if (rest.length === 2) {
      return { kind: "search-link", spaceKey, query: rest[0]!, name: rest[1]! };
    }
    throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
  }
}

/** The canonical path of a node, ignoring whatever slug the caller used. */
export function canonicalPathOf(index: TreeIndex, node: TreeNode, homepageId: string | null): string {
  const segments: string[] = [];
  let current: TreeNode | undefined = node;
  while (current && current.id !== homepageId) {
    segments.unshift(`${vfsSlug(current.title)}-${current.id}`);
    current = current.parentId ? index.node(current.parentId) : undefined;
  }
  return `/${[node.spaceKey, ...segments].join("/")}`;
}

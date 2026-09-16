/**
 * `atlcli wiki vfs` — cache and conflict maintenance (WP3.6, WP3.7).
 *
 * Both subcommands exist because the VFS keeps state **outside** any shell
 * session, and state you cannot inspect from outside is state you cannot trust:
 *
 *  - `cache stats|clear` makes the bounded LRU visible and disposable. The
 *    cache is never a source of truth, so clearing it is always safe — this
 *    command is the promise that you can.
 *  - `conflicts list|show|resolve|discard` makes a failed write findable. A
 *    conflict that only exists inside the shell that produced it is a lost
 *    edit, which is the one outcome the write path must never have.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  ERROR_CODES,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveVfsConfig,
  type OutputOptions,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  BodyCache,
  ConflictStore,
  identityPathFor,
  recallIdentity,
  resolveCachePaths,
} from "@atlcli/confluence-vfs";
import { assertCliAuthSupported } from "./session-guard.js";

type Flags = Record<string, string | boolean | string[]>;

const DEFAULT_CACHE_DIR = join(homedir(), ".atlcli", "vfs");

export async function handleWikiVfs(
  args: string[],
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const [group, action, ...rest] = args;
  if (!group || hasFlag(flags, "help")) {
    output(wikiVfsHelp(), opts);
    return;
  }
  switch (group) {
    case "cache":
      await handleCache(action, flags, opts);
      return;
    case "conflicts":
      await handleConflicts(action, rest, flags, opts);
      return;
    default:
      output(wikiVfsHelp(), opts);
      return;
  }
}

/**
 * Locate the cache without opening a filesystem.
 *
 * The account id normally costs a `getCurrentUser` call; the identity file an
 * online session leaves behind lets these maintenance commands work offline and
 * without touching the network at all.
 */
async function locate(
  flags: Flags,
  opts: OutputOptions,
): Promise<
  | { cacheDir: string; dbPath: string; blobDir: string; conflictDir: string; profileName: string }
  | undefined
> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {});
    return undefined;
  }
  assertCliAuthSupported(profile, opts);

  const vfsConfig = resolveVfsConfig(config, profile);
  const cacheDir = getFlag(flags, "cache-dir") ?? vfsConfig.cacheDir ?? DEFAULT_CACHE_DIR;
  const client = new ConfluenceClient(profile);
  const instanceUrl = client.getInstanceUrl();

  const remembered = recallIdentity(identityPathFor(cacheDir, profile.name, instanceUrl));
  const accountId = remembered?.accountId ?? (await client.getCurrentUser()).accountId;
  const paths = resolveCachePaths({ cacheDir, profile: profile.name, accountId, instanceUrl });
  return { ...paths, cacheDir, profileName: profile.name };
}

async function handleCache(
  action: string | undefined,
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const located = await locate(flags, opts);
  if (!located) return;

  const cache = new BodyCache({
    dbPath: located.dbPath,
    blobDir: located.blobDir,
    maxBytes: Number.MAX_SAFE_INTEGER,
    now: () => Date.now(),
  });
  try {
    if (action === "clear") {
      const before = cache.stats();
      cache.clear();
      output(
        {
          cleared: true,
          bodies: before.bodies,
          attachments: before.attachments,
          bytes: before.bytes,
          note: "The cache is never a source of truth; clearing it only costs the next read a request.",
        },
        opts,
      );
      return;
    }
    const stats = cache.stats();
    output(
      {
        profile: located.profileName,
        database: located.dbPath,
        bodies: stats.bodies,
        attachments: stats.attachments,
        bytes: stats.bytes,
        blobBytesOnDisk: cache.blobBytesOnDisk(),
        oldestFetchedAt: stats.oldestFetchedAt
          ? new Date(stats.oldestFetchedAt).toISOString()
          : undefined,
        newestFetchedAt: stats.newestFetchedAt
          ? new Date(stats.newestFetchedAt).toISOString()
          : undefined,
      },
      opts,
    );
  } finally {
    cache.close();
  }
}

async function handleConflicts(
  action: string | undefined,
  rest: string[],
  flags: Flags,
  opts: OutputOptions,
): Promise<void> {
  const located = await locate(flags, opts);
  if (!located) return;
  const store = new ConflictStore(located.conflictDir);

  switch (action) {
    case "show": {
      const record = pick(store, rest[0]);
      if (!record) {
        fail(opts, 1, ERROR_CODES.VALIDATION, "No such conflict.", { id: rest[0] });
        return;
      }
      output(record.content, opts);
      return;
    }
    case "resolve": {
      // "Resolve" is deliberately *not* a write back to Confluence: the file
      // carries conflict markers, and pushing it would publish them. It prints
      // the path so an editor can take over, and the next ordinary write —
      // which goes through the merge again — is what actually resolves it.
      const record = pick(store, rest[0]);
      if (!record) {
        fail(opts, 1, ERROR_CODES.VALIDATION, "No such conflict.", { id: rest[0] });
        return;
      }
      output(
        {
          file: record.file,
          pageId: record.pageId,
          path: record.path,
          next: `Edit ${record.file} to remove the conflict markers, then write the result back through the filesystem; discard it with 'atlcli wiki vfs conflicts discard ${record.pageId}'.`,
        },
        opts,
      );
      return;
    }
    case "discard": {
      const target = rest[0];
      if (!target) {
        fail(opts, 2, ERROR_CODES.VALIDATION, "Pass a page id or a conflict file.", {});
        return;
      }
      // Local only: allowed whatever the mode, because it touches no page.
      const removed = target.includes("/")
        ? (store.discard(target) ? 1 : 0)
        : store.discardAllFor(target);
      output({ discarded: removed }, opts);
      return;
    }
    default: {
      const records = store.list();
      output(
        records.map((record) => ({
          pageId: record.pageId,
          path: record.path,
          baseVersion: record.baseVersion,
          serverVersion: record.serverVersion,
          createdAt: record.createdAt,
          file: record.file,
        })),
        opts,
      );
      return;
    }
  }
}

function pick(store: ConflictStore, target: string | undefined) {
  if (!target) return store.list()[0];
  if (target.includes("/")) {
    const record = store.read(target);
    if (record) return record;
    try {
      readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
    return undefined;
  }
  return store.forPage(target).at(-1);
}

export function wikiVfsHelp(): string {
  return `atlcli wiki vfs <command>

Maintenance for the Confluence virtual filesystem.

Commands:
  cache stats            Size, entry counts and age of the body cache
  cache clear            Empty it — always safe; the cache is never a source of truth
  conflicts list         Writes that could not be merged, and where they were kept
  conflicts show [id]    Print one conflict file, markers included
  conflicts resolve [id] Print the file and what to do with it
  conflicts discard <id> Delete a conflict file (local only; works in ro mode)

Options:
  --cache-dir <path>  Cache root (default: ~/.atlcli/vfs)
  --profile <name>    Use a specific auth profile
  --json              JSON output

Examples:
  atlcli wiki vfs cache stats --json
  atlcli wiki vfs conflicts list
  atlcli wiki vfs conflicts discard 623869955
`;
}

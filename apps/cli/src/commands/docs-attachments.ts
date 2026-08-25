import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a flat Confluence attachment name without allowing local escape. */
export function resolveAttachmentFile(directory: string, filename: string): string | undefined {
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    basename(filename) !== filename
  ) {
    return undefined;
  }

  const root = resolve(directory);
  const candidate = resolve(root, filename);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return candidate;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Read a regular attachment without following a filename symlink. `O_NOFOLLOW`
 * closes the check/open race on platforms that provide it; lstat + realpath
 * keep the same fail-closed policy on every supported runtime.
 */
export async function readAttachmentFile(directory: string, filename: string): Promise<Buffer> {
  const candidate = resolveAttachmentFile(directory, filename);
  if (!candidate) throw new Error(`Unsafe attachment filename: ${filename}`);

  const [rootPath, candidateStats] = await Promise.all([realpath(resolve(directory)), lstat(candidate)]);
  if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) {
    throw new Error(`Attachment is not a regular file: ${filename}`);
  }
  const candidatePath = await realpath(candidate);
  if (!isInside(rootPath, candidatePath)) throw new Error(`Attachment escapes its directory: ${filename}`);

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error(`Attachment is not a regular file: ${filename}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Names a desktop client invents and then asks for on every directory it shows.
 *
 * Answering these from the backend would double the request count of an
 * ordinary `ls` in the Finder, for files that never exist.
 */
const CLIENT_DROPPINGS = [
  /^\._/, // AppleDouble sidecars
  /^\.DS_Store$/,
  /^\.hidden$/,
  /^desktop\.ini$/i,
  /^Thumbs\.db$/i,
  /^\.Spotlight-V100$/,
  /^\.Trashes$/,
  /^\.TemporaryItems$/,
  /^\.apdisk$/,
];

/**
 * Files served as **empty** rather than refused (WP7.3b).
 *
 * `.metadata_never_index` tells Spotlight to skip a volume — but only if it is
 * there. A 404 is an invitation to index, which on a demand-driven filesystem
 * means downloading every page in every space. `.fseventsd` exists for the same
 * reason: its absence makes the volume look like one worth watching.
 */
export const INDEXER_SHIELDS = new Set([
  ".metadata_never_index",
  ".metadata_never_index_unless_rootfs",
  ".metadata_direct_scope_only",
]);

export const SHIELD_DIRECTORIES = new Set([".fseventsd"]);

export function isClientDropping(name: string): boolean {
  return CLIENT_DROPPINGS.some((pattern) => pattern.test(name));
}

export function isIndexerShield(name: string): boolean {
  return INDEXER_SHIELDS.has(name);
}

export function isShieldDirectory(name: string): boolean {
  return SHIELD_DIRECTORIES.has(name);
}

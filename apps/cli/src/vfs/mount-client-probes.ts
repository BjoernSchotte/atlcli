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

export interface SweepReport {
  reads: number;
  windowMs: number;
}

/** Best-effort hint: distinct successful file reads without a recent parent listing. */
export class SweepDetector {
  private readonly reads = new Map<string | number, number>();
  private readonly listedDirs = new Map<string, number>();
  private reported = false;

  constructor(
    private readonly threshold = 50,
    private readonly windowMs = 10_000,
    private readonly onSweep: (report: SweepReport) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  noteListing(directory: string): void {
    if (this.reported) return;
    this.listedDirs.delete(directory);
    this.listedDirs.set(directory, this.now());
    // ponytail: retain at most 4096 recent directories; this is a diagnostic, not an audit log.
    if (this.listedDirs.size > 4096) this.listedDirs.delete(this.listedDirs.keys().next().value!);
  }

  noteRead(directory: string, file: string | number): void {
    if (this.reported) return;
    const at = this.now();
    const listed = this.listedDirs.get(directory);
    if (listed !== undefined && at - listed <= this.windowMs) return;
    for (const [id, time] of this.reads) if (at - time > this.windowMs) this.reads.delete(id);
    this.reads.set(file, at);
    if (this.reads.size >= this.threshold) {
      this.reported = true;
      this.onSweep({ reads: this.reads.size, windowMs: this.windowMs });
      this.reads.clear();
      this.listedDirs.clear();
    }
  }

  get suspected(): boolean { return this.reported; }
}

/** Visible Markdown drafts may become pages; common hidden/swap/backup names stay local. */
export function isNfsPageDraft(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1)!;
  return name.endsWith(".md") && name !== "_index.md" && !/^[.#~]/.test(name) &&
    !parts.some(part => part.startsWith("."));
}

/** Ordinary directory names denote pages; editor staging trees stay local. */
export function isNfsPageDirectory(path: string): boolean {
  return path.split("/").filter(Boolean).every(part => !/^[.#~]/.test(part) &&
    !/(?:~|\.(?:tmp|swp|swo|bak))$/i.test(part) && !/\.sb-/.test(part) &&
    part !== "_attachments" && part !== "_index.md" && !isClientDropping(part));
}

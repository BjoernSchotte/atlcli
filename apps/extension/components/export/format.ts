/** Display formatting shared by the export panels. Pure, locale-independent. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `YYYY-MM-DD` for an epoch-millisecond timestamp.
 *
 * ISO rather than `toLocaleDateString` on purpose: the panel renders in two UI
 * languages inside a 400 px column, and an unambiguous date beats a
 * locale-shuffled one. An unparseable timestamp renders as an em dash rather
 * than the string `Invalid Date`.
 */
export function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "—";
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 1000) return `${Math.round(safeMilliseconds)} ms`;
  return `${(safeMilliseconds / 1000).toFixed(1)} s`;
}

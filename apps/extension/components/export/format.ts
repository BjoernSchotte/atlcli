/** Display formatting shared by the export panels. Pure, locale-independent. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(milliseconds: number): string {
  const safeMilliseconds = Math.max(0, milliseconds);
  if (safeMilliseconds < 1000) return `${Math.round(safeMilliseconds)} ms`;
  return `${(safeMilliseconds / 1000).toFixed(1)} s`;
}

/** Package-private helpers shared by the job contract modules. Not exported from the index. */

const KEY_ORDER = new Intl.Collator("en");

/**
 * Key order of every canonical JSON digest. It is pinned to English collation,
 * which is what the former default-locale `localeCompare` produced on English
 * hosts, so stored digests stay valid while lt/cs/... hosts now agree.
 */
export function compareCanonicalKeys(left: string, right: string): number {
  return KEY_ORDER.compare(left, right);
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareCanonicalKeys(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Export job operation was cancelled.", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

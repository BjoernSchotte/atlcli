function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, ordered(item)])
    );
  }
  return value;
}

/** Stable, whitespace-free JSON used for portable analysis digests and tests. */
export function canonicalIntakeJson(value: unknown): string {
  return JSON.stringify(ordered(value));
}

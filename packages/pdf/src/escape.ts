/** Escape literal text for Typst markup content. */
export function escapeTypstContent(value: string): string {
  return value.replace(/[\\#*_$@<>\[\]`]/g, (char) => `\\${char}`);
}

/** Escape a value embedded in a Typst string literal. */
export function escapeTypstString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function typstString(value: string): string {
  return `"${escapeTypstString(value)}"`;
}

/** Stable Typst label component. */
export function typstLabel(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
}

export function safeColor(value: string | undefined, fallback = "#42526E"): string {
  if (!value) return fallback;
  const raw = value.startsWith("#") ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : fallback;
}

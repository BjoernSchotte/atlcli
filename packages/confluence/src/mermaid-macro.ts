/** Inline body used by Mermaid Integration for Confluence (Connect macro `mermaid`). */
export function mermaidMacroSource(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    // Attachment-backed v2 macros have an empty body. Keep those as raw macros.
    if (Object.keys(record).some((key) => key !== "diagramDefinition")) return undefined;
    return typeof record.diagramDefinition === "string" && record.diagramDefinition.trim()
      ? record.diagramDefinition : undefined;
  } catch { return undefined; }
}

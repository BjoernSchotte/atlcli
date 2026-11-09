// export-blocks.ts imports this module back; both sides only call each other
// from function bodies, so the cycle is safe at load time.
import { normalizeExportColor, type InlineNode } from "./export-blocks.js";

/** Read one color property from an inline `style` attribute. */
export function inlineCssColor(style: string, property: "color" | "background-color"): string | undefined {
  const escaped = property.replace("-", "\\-");
  const value = style.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "i"))?.[1];
  return normalizeExportColor(value);
}

/** Apply span colors to every nested text run, including link labels. */
export function applyInlineColors(
  nodes: InlineNode[],
  colors: { color?: string; backgroundColor?: string }
): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === "text") {
      return {
        ...node,
        ...(colors.color && !node.color ? { color: colors.color } : {}),
        ...(colors.backgroundColor && !node.backgroundColor
          ? { backgroundColor: colors.backgroundColor }
          : {}),
      };
    }
    if (node.type === "link") {
      return { ...node, content: applyInlineColors(node.content, colors) };
    }
    return node;
  });
}

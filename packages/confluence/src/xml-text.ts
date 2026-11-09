import type { XmlNode } from "./export-blocks.js";

/** Concatenated text content of an XML node. */
export function textOf(node: XmlNode): string {
  if (node.type === "text") return node.text;
  return node.children.map(textOf).join("");
}

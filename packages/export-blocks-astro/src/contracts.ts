import type { ExportBlock, InlineNode } from "@atlcli/export-blocks";

export function assertNeverExportBlockV1(value: never): never {
  throw new TypeError(`Unsupported ExportBlock discriminator: ${JSON.stringify(value)}`);
}

export function assertNeverInlineNodeV1(value: never): never {
  throw new TypeError(`Unsupported inline-node discriminator: ${JSON.stringify(value)}`);
}

/** Compile-time exhaustive discriminator guard used by the Astro dispatchers. */
export function exportBlockKindV1(block: ExportBlock): ExportBlock["type"] {
  switch (block.type) {
    case "heading": case "paragraph": case "smartCard": case "codeBlock":
    case "callout": case "expand": case "list": case "layout": case "table":
    case "image": case "mediaFallback": case "blockquote": case "chart": case "divider":
    case "pageBreak": case "orientation": case "anchor": case "unknown":
      return block.type;
    default: return assertNeverExportBlockV1(block);
  }
}

/** Compile-time exhaustive discriminator guard used by the Astro dispatchers. */
export function inlineNodeKindV1(node: InlineNode): InlineNode["type"] {
  switch (node.type) {
    case "text": case "link": case "mention": case "date": case "status":
    case "smartCard": case "media": case "placeholder": case "lineBreak":
      return node.type;
    default: return assertNeverInlineNodeV1(node);
  }
}

import type { Caption, ExportBlock, InlineNode } from "./export-blocks.js";

export interface ExportMentionResolution {
  blocks: ExportBlock[];
  unresolved: number;
}

export type ExportMentionLookup = (
  accountIds: string[]
) => Promise<ReadonlyMap<string, string | null>>;

function collectUnresolvedMentionIds(blocks: ExportBlock[]): string[] {
  const ids = new Set<string>();
  const visitInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "mention" && !node.displayName?.trim() && node.accountId.trim()) {
        ids.add(node.accountId);
      } else if (node.type === "link") {
        visitInline(node.content);
      }
    }
  };
  const visitBlocks = (items: ExportBlock[]): void => {
    for (const block of items) {
      switch (block.type) {
        case "heading":
        case "paragraph":
          visitInline(block.content);
          break;
        case "callout":
        case "blockquote":
          visitBlocks(block.content);
          break;
        case "orientation":
          visitBlocks(block.content);
          break;
        case "list":
          for (const item of block.items) visitBlocks(item.content);
          break;
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) visitBlocks(cell.content);
          }
          if (block.caption) visitInline(block.caption.content);
          break;
        case "codeBlock":
        case "image":
          if (block.caption) visitInline(block.caption.content);
          break;
      }
    }
  };
  visitBlocks(blocks);
  return [...ids];
}

function resolveInlineMentions(
  nodes: InlineNode[],
  displayNames: ReadonlyMap<string, string | null>
): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === "link") {
      return { ...node, content: resolveInlineMentions(node.content, displayNames) };
    }
    if (node.type !== "mention" || node.displayName?.trim()) return node;
    const displayName = displayNames.get(node.accountId)?.trim();
    return displayName ? { ...node, displayName } : node;
  });
}

function resolveBlockMentions(
  blocks: ExportBlock[],
  displayNames: ReadonlyMap<string, string | null>
): ExportBlock[] {
  const resolveCaption = (caption: Caption): Caption => ({
    ...caption,
    content: resolveInlineMentions(caption.content, displayNames),
  });

  return blocks.map((block): ExportBlock => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return { ...block, content: resolveInlineMentions(block.content, displayNames) };
      case "callout":
      case "blockquote":
        return { ...block, content: resolveBlockMentions(block.content, displayNames) };
      case "orientation":
        return { ...block, content: resolveBlockMentions(block.content, displayNames) };
      case "list":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            content: resolveBlockMentions(item.content, displayNames),
          })),
        };
      case "table":
        return {
          ...block,
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              content: resolveBlockMentions(cell.content, displayNames),
            })),
          })),
          ...(block.caption ? { caption: resolveCaption(block.caption) } : {}),
        };
      case "codeBlock":
      case "image":
        return block.caption ? { ...block, caption: resolveCaption(block.caption) } : block;
      // NOTE: `unknown.body` is deliberately NOT traversed here. It is populated
      // unconditionally by the walker but nothing renders it yet; resolving
      // mentions inside it would make the extension's PDF path issue live user
      // lookups for invisible content. Traversal belongs with Lane E (T1.7),
      // once a macro renderer turns that body into visible output.
      default:
        return block;
    }
  });
}

export async function resolveExportMentions(
  blocks: ExportBlock[],
  lookup: ExportMentionLookup
): Promise<ExportMentionResolution> {
  const accountIds = collectUnresolvedMentionIds(blocks);
  if (accountIds.length === 0) return { blocks, unresolved: 0 };
  const displayNames = await lookup(accountIds);
  const unresolved = accountIds.filter((accountId) => !displayNames.get(accountId)?.trim()).length;
  return { blocks: resolveBlockMentions(blocks, displayNames), unresolved };
}

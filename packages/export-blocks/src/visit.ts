import type { ExportBlock, InlineNode } from "./index.js";

export interface ExportBlockVisitContextV1 {
  path: string;
  ancestors: readonly ExportBlock[];
}

export interface ExportInlineVisitContextV1 extends ExportBlockVisitContextV1 {
  owner: ExportBlock;
}

export interface ExportBlockVisitorV1 {
  block?(block: ExportBlock, context: ExportBlockVisitContextV1): void;
  inline?(inline: InlineNode, context: ExportInlineVisitContextV1): void;
}

function neverBlock(value: never): never {
  throw new TypeError(`Unknown ExportBlock variant: ${String((value as { type?: unknown }).type)}`);
}

function neverInline(value: never): never {
  throw new TypeError(`Unknown InlineNode variant: ${String((value as { type?: unknown }).type)}`);
}

function visitInline(
  node: InlineNode,
  owner: ExportBlock,
  path: string,
  ancestors: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  visitor.inline?.(node, { owner, path, ancestors });
  switch (node.type) {
    case "link":
      node.content.forEach((child, index) => visitInline(child, owner, `${path}.content[${index}]`, ancestors, visitor));
      return;
    case "text":
    case "mention":
    case "date":
    case "status":
    case "smartCard":
    case "media":
    case "placeholder":
    case "lineBreak":
      return;
    default:
      return neverInline(node);
  }
}

function visitInlines(
  nodes: readonly InlineNode[],
  owner: ExportBlock,
  path: string,
  ancestors: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  nodes.forEach((node, index) => visitInline(node, owner, `${path}[${index}]`, ancestors, visitor));
}

function visitChildren(
  children: readonly ExportBlock[],
  path: string,
  ancestors: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  children.forEach((child, index) => visitBlock(child, `${path}[${index}]`, ancestors, visitor));
}

function visitCaption(
  owner: ExportBlock,
  caption: { content: readonly InlineNode[] } | undefined,
  path: string,
  ancestors: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  if (caption) visitInlines(caption.content, owner, `${path}.content`, ancestors, visitor);
}

function visitBlock(
  block: ExportBlock,
  path: string,
  ancestors: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  visitor.block?.(block, { path, ancestors });
  const nestedAncestors = [...ancestors, block];
  switch (block.type) {
    case "heading":
    case "paragraph":
      visitInlines(block.content, block, `${path}.content`, nestedAncestors, visitor);
      return;
    case "codeBlock":
      visitCaption(block, block.caption, `${path}.caption`, nestedAncestors, visitor);
      return;
    case "callout":
    case "expand":
    case "blockquote":
    case "orientation":
      visitChildren(block.content, `${path}.content`, nestedAncestors, visitor);
      return;
    case "list":
      block.items.forEach((item, index) => visitChildren(item.content, `${path}.items[${index}].content`, nestedAncestors, visitor));
      return;
    case "layout":
      block.columns.forEach((column, index) => visitChildren(column.content, `${path}.columns[${index}].content`, nestedAncestors, visitor));
      return;
    case "table":
      block.rows.forEach((row, rowIndex) => row.cells.forEach((cell, cellIndex) => {
        visitChildren(cell.content, `${path}.rows[${rowIndex}].cells[${cellIndex}].content`, nestedAncestors, visitor);
      }));
      visitCaption(block, block.caption, `${path}.caption`, nestedAncestors, visitor);
      return;
    case "image":
    case "mediaFallback":
      visitCaption(block, block.caption, `${path}.caption`, nestedAncestors, visitor);
      return;
    case "unknown":
      if (block.body) visitChildren(block.body, `${path}.body`, nestedAncestors, visitor);
      block.extensionFrames?.forEach((frame, index) => visitChildren(frame.content, `${path}.extensionFrames[${index}].content`, nestedAncestors, visitor));
      return;
    case "smartCard":
    case "divider":
    case "pageBreak":
    case "anchor":
      return;
    default:
      return neverBlock(block);
  }
}

export function visitExportBlocksV1(
  blocks: readonly ExportBlock[],
  visitor: ExportBlockVisitorV1,
): void {
  visitChildren(blocks, "$blocks", [], visitor);
}

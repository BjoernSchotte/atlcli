import {
  storageToBlocks,
  type ExportBlock,
  type InlineNode,
  type LinkTarget,
} from "@atlcli/confluence/browser";
import type { AdfDocument, AdfNode } from "@atlcli/jira/browser";
import type { BoundedContentProjectionV1 } from "./capability-contracts.js";

export interface ContentProjectionLimits {
  maxTextChars: number;
  maxTextBytes: number;
  maxLinks: number;
  maxNodes: number;
  maxDepth: number;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function safeAtlassianLink(
  href: string | undefined,
  siteOrigin: string
): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, siteOrigin);
  } catch {
    return undefined;
  }
  if (
    url.origin !== siteOrigin ||
    !(
      /^\/browse\/[A-Z][A-Z0-9]{1,19}-\d+$/i.test(url.pathname) ||
      /^\/wiki\/spaces\/[^/]+\/pages\/\d+(?:\/.*)?$/i.test(url.pathname)
    )
  ) {
    return undefined;
  }
  url.hash = "";
  return url.href;
}

function linkTargetHref(target: LinkTarget): string | undefined {
  switch (target.kind) {
    case "external":
      return target.href;
    case "page":
    case "attachment":
      return target.href;
    case "anchor":
      return undefined;
  }
}

function truncateUtf8(
  value: string,
  maximumChars: number,
  maximumBytes: number
): { value: string; truncated: boolean } {
  let result = "";
  let chars = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (chars + 1 > maximumChars || bytes + characterBytes > maximumBytes) {
      return { value: result, truncated: true };
    }
    result += character;
    chars += 1;
    bytes += characterBytes;
  }
  return { value: result, truncated: false };
}

class ProjectionCollector {
  readonly #siteOrigin: string;
  readonly #limits: ContentProjectionLimits;
  readonly #parts: string[] = [];
  readonly #links = new Set<string>();
  #nodes = 0;
  #truncated = false;

  constructor(siteOrigin: string, limits: ContentProjectionLimits) {
    this.#siteOrigin = siteOrigin;
    this.#limits = limits;
  }

  text(value: string | undefined): void {
    if (!value) return;
    this.#parts.push(value);
  }

  separator(): void {
    this.#parts.push("\n");
  }

  link(href: string | undefined): void {
    const safe = safeAtlassianLink(href, this.#siteOrigin);
    if (!safe) return;
    if (this.#links.size >= this.#limits.maxLinks) {
      this.#truncated = true;
      return;
    }
    this.#links.add(safe);
  }

  node(depth: number): boolean {
    this.#nodes += 1;
    if (this.#nodes > this.#limits.maxNodes || depth > this.#limits.maxDepth) {
      this.#truncated = true;
      return false;
    }
    return true;
  }

  finish(inputBytes: number): BoundedContentProjectionV1 {
    const normalized = this.#parts
      .join("")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const bounded = truncateUtf8(
      normalized,
      this.#limits.maxTextChars,
      this.#limits.maxTextBytes
    );
    return {
      text: bounded.value,
      linkTargets: [...this.#links].sort(),
      truncated: this.#truncated || bounded.truncated,
      inputBytes,
    };
  }
}

function walkAdfNode(node: AdfNode, collector: ProjectionCollector, depth: number): void {
  if (!collector.node(depth)) return;
  collector.text(node.text);
  for (const mark of node.marks ?? []) {
    if (mark.type === "link" && typeof mark.attrs?.href === "string") {
      collector.link(mark.attrs.href);
    }
  }
  if (
    (node.type === "inlineCard" ||
      node.type === "blockCard" ||
      node.type === "embedCard") &&
    typeof node.attrs?.url === "string"
  ) {
    collector.link(node.attrs.url);
  }
  for (const child of node.content ?? []) walkAdfNode(child, collector, depth + 1);
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "listItem" ||
    node.type === "codeBlock"
  ) {
    collector.separator();
  }
}

export function projectJiraDescription(
  description: AdfDocument | string | null | undefined,
  siteOrigin: string,
  limits: ContentProjectionLimits
): BoundedContentProjectionV1 {
  const collector = new ProjectionCollector(siteOrigin, limits);
  if (!description) return collector.finish(0);
  if (typeof description === "string") {
    collector.text(description);
    return collector.finish(new TextEncoder().encode(description).byteLength);
  }
  for (const node of description.content ?? []) walkAdfNode(node, collector, 1);
  return collector.finish(jsonBytes(description));
}

function walkInline(
  node: InlineNode,
  collector: ProjectionCollector,
  depth: number
): void {
  if (!collector.node(depth)) return;
  switch (node.type) {
    case "text":
      collector.text(node.text);
      return;
    case "link":
      collector.link(linkTargetHref(node.target));
      node.content.forEach((child) => walkInline(child, collector, depth + 1));
      return;
    case "mention":
      collector.text(node.displayName ? `@${node.displayName}` : "@mention");
      return;
    case "date":
      collector.text(node.timestamp);
      return;
    case "status":
      collector.text(node.text);
      return;
    case "smartCard":
      collector.text(node.card.title ?? node.card.url);
      collector.link(node.card.url);
      return;
    case "media":
      collector.text(node.alt);
      return;
    default:
      return;
  }
}

function walkUnknownBlocks(
  value: unknown,
  collector: ProjectionCollector,
  depth: number
): void {
  if (Array.isArray(value)) {
    for (const entry of value) walkUnknownBlocks(entry, collector, depth);
    return;
  }
  if (typeof value !== "object" || value === null || !collector.node(depth)) return;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "heading" || type === "paragraph") {
    for (const inline of (record.content as InlineNode[]) ?? []) {
      walkInline(inline, collector, depth + 1);
    }
    collector.separator();
    return;
  }
  if (type === "codeBlock") {
    collector.text(typeof record.code === "string" ? record.code : undefined);
    collector.separator();
  }
  if (type === "smartCard") {
    const card = record.card as { title?: string; url?: string } | undefined;
    collector.text(card?.title ?? card?.url);
    collector.link(card?.url);
    collector.separator();
  }
  for (const key of ["content", "items", "rows", "cells", "header", "body"]) {
    if (key in record) walkUnknownBlocks(record[key], collector, depth + 1);
  }
}

export function projectConfluenceStorage(
  storage: string,
  siteOrigin: string,
  limits: ContentProjectionLimits
): BoundedContentProjectionV1 {
  const collector = new ProjectionCollector(siteOrigin, limits);
  const { blocks } = storageToBlocks(storage, {
    parseBudget: {
      maxNodes: limits.maxNodes,
      maxDepth: limits.maxDepth,
      maxTextLength: limits.maxTextChars * 2,
    },
  });
  walkUnknownBlocks(blocks as ExportBlock[], collector, 1);
  return collector.finish(new TextEncoder().encode(storage).byteLength);
}

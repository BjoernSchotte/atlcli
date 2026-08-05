import {
  StorageParseError,
  storageToBlocks,
  type ExportBlock,
} from "@atlcli/confluence/research";
import type { BoundDocumentSectionOutlineV1 } from "./capability-contracts.js";
import {
  projectConfluenceBlocks,
  type ContentProjectionLimits,
} from "./content-projection.js";

const MAX_DOCUMENT_SOURCE_BYTES_V1 = 4_000_000;
const MAX_DOCUMENT_SOURCE_CHARS_V1 = 1_500_000;
const MAX_DOCUMENT_SECTIONS_V1 = 128;
const MAX_DOCUMENT_NODES_V1 = 50_000;
const MAX_DOCUMENT_DEPTH_V1 = 64;
const MAX_OUTLINE_MACROS_V1 = 20;
const MAX_OUTLINE_JIRA_KEYS_V1 = 20;
const JIRA_KEY_V1 = /\b[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,18}\b/g;

export interface BoundedDocumentSectionSourceV1 {
  sectionId: string;
  heading: string;
  level: number;
  order: number;
  contentBytes: number;
  content: ReturnType<typeof projectConfluenceBlocks>;
  metadata: BoundDocumentSectionOutlineV1["metadata"];
}

export interface BoundedDocumentSourceV1 {
  sourceTruncated: boolean;
  outlineTruncated: boolean;
  genuinelyEmpty: boolean;
  totalSections: number;
  sections: BoundedDocumentSectionSourceV1[];
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

function sectionBytes(blocks: readonly ExportBlock[]): number {
  return bytes(JSON.stringify(blocks));
}

function macroNames(value: unknown, names: Set<string>, counter: { count: number }): void {
  if (Array.isArray(value)) {
    for (const entry of value) macroNames(entry, names, counter);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "unknown" && typeof record.macroName === "string") {
    counter.count += 1;
    if (names.size < MAX_OUTLINE_MACROS_V1) {
      const normalized = record.macroName.replace(/\s+/g, " ").trim().slice(0, 120);
      if (normalized) names.add(normalized);
    }
  }
  for (const nested of Object.values(record)) macroNames(nested, names, counter);
}

function headingText(block: Extract<ExportBlock, { type: "heading" }>, siteOrigin: string): string {
  return projectConfluenceBlocks(
    [block],
    siteOrigin,
    { maxTextChars: 240, maxTextBytes: 960, maxLinks: 0, maxNodes: 512, maxDepth: 16 },
    sectionBytes([block]),
  ).text || "Untitled section";
}

/**
 * Parse one host-fetched Confluence Storage body into a body-free outline and
 * bounded private section projections. No model-authored identity participates
 * in this operation; section capabilities are added by the broker afterwards.
 */
export function navigateConfluenceStorageV1(input: {
  storage: string;
  siteOrigin: string;
  projectionLimits: ContentProjectionLimits;
}): BoundedDocumentSourceV1 | undefined {
  const sourceBytes = bytes(input.storage);
  const sourceTruncated = sourceBytes > MAX_DOCUMENT_SOURCE_BYTES_V1 ||
    input.storage.length > MAX_DOCUMENT_SOURCE_CHARS_V1;
  if (sourceTruncated) {
    return {
      sourceTruncated: true,
      outlineTruncated: true,
      genuinelyEmpty: false,
      totalSections: 0,
      sections: [],
    };
  }

  let blocks: ExportBlock[];
  try {
    blocks = storageToBlocks(input.storage, {
      parseBudget: {
        maxNodes: MAX_DOCUMENT_NODES_V1,
        maxDepth: MAX_DOCUMENT_DEPTH_V1,
        maxTextLength: MAX_DOCUMENT_SOURCE_CHARS_V1,
      },
    }).blocks;
  } catch (error) {
    if (error instanceof StorageParseError) {
      return {
        sourceTruncated: false,
        outlineTruncated: true,
        genuinelyEmpty: false,
        totalSections: 0,
        sections: [],
      };
    }
    throw error;
  }

  const groups: Array<{
    heading: string;
    level: number;
    blocks: ExportBlock[];
  }> = [];
  let current: (typeof groups)[number] = {
    heading: "Introduction",
    level: 0,
    blocks: [],
  };
  for (const block of blocks) {
    if (block.type === "heading") {
      if (current.blocks.length > 0) groups.push(current);
      current = {
        heading: headingText(block, input.siteOrigin),
        level: block.level,
        blocks: [block],
      };
      continue;
    }
    current.blocks.push(block);
  }
  if (current.blocks.length > 0) groups.push(current);

  const nonEmptyGroups = groups.filter((group) => {
    const projection = projectConfluenceBlocks(
      group.blocks,
      input.siteOrigin,
      { ...input.projectionLimits, maxTextChars: 256, maxTextBytes: 1_024 },
      sectionBytes(group.blocks),
    );
    return projection.text.length > 0 || projection.linkTargets.length > 0;
  });
  const selected = nonEmptyGroups.slice(0, MAX_DOCUMENT_SECTIONS_V1);
  const outlineTruncated = nonEmptyGroups.length > selected.length;
  const perSectionChars = Math.max(
    256,
    Math.min(
      input.projectionLimits.maxTextChars,
      Math.floor(MAX_DOCUMENT_SOURCE_CHARS_V1 / Math.max(1, selected.length)),
    ),
  );
  const sections = selected.map((group, order): BoundedDocumentSectionSourceV1 => {
    const inputBytes = sectionBytes(group.blocks);
    const content = projectConfluenceBlocks(
      group.blocks,
      input.siteOrigin,
      {
        ...input.projectionLimits,
        maxTextChars: perSectionChars,
        maxTextBytes: perSectionChars * 4,
      },
      inputBytes,
    );
    const names = new Set<string>();
    const macroCounter = { count: 0 };
    macroNames(group.blocks, names, macroCounter);
    const jiraIssueKeys = [...new Set(content.text.match(JIRA_KEY_V1) ?? [])]
      .slice(0, MAX_OUTLINE_JIRA_KEYS_V1);
    return {
      sectionId: `section:${String(order).padStart(3, "0")}:${boundedSlug(group.heading)}`,
      heading: group.heading,
      level: group.level,
      order,
      contentBytes: inputBytes,
      content,
      metadata: {
        macroNames: [...names].sort((left, right) => left.localeCompare(right, "en-US")),
        macroCount: macroCounter.count,
        macrosTruncated: macroCounter.count > names.size,
        linkCount: content.linkTargets.length,
        linksTruncated: content.truncated,
        jiraIssueKeys,
      },
    };
  });
  return {
    sourceTruncated: false,
    outlineTruncated,
    genuinelyEmpty: sections.length === 0,
    totalSections: nonEmptyGroups.length,
    sections,
  };
}

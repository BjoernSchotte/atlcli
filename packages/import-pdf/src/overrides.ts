import type { ImportBlock, ImportDocumentV2 } from "@atlcli/import-core";
import { parseDocument } from "yaml";
import { digestPdfCanonical } from "./canonical.js";
import { PdfImportError } from "./issues.js";

export const PDF_IMPORT_OVERRIDES_SCHEMA_V1 = "atlcli.pdf-import-overrides/1" as const;
export const PDF_IMPORT_OVERRIDES_MAX_BYTES = 256 * 1024;
export const PDF_IMPORT_OVERRIDES_MAX_OPERATIONS = 200;

export type PdfImportOverrideOperationV1 =
  | { kind: "set-heading-level"; sourceId: string; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "set-figure-alt"; sourceId: string; alt: string }
  | { kind: "set-title-from"; sourceId: string }
  | { kind: "move-before"; sourceId: string; beforeSourceId: string };

export interface PdfImportOverridesV1 {
  schema: typeof PDF_IMPORT_OVERRIDES_SCHEMA_V1;
  sourceSha256: string;
  operations: PdfImportOverrideOperationV1[];
}

export interface ParsedPdfImportOverridesV1 {
  overrides: PdfImportOverridesV1;
  digest: string;
}

export interface AppliedPdfImportOverridesV1 {
  document: ImportDocumentV2;
  titleCandidate?: string;
  digest: string;
  applied: Array<{ kind: PdfImportOverrideOperationV1["kind"]; sourceId: string }>;
}

function invalid(message: string, context?: Record<string, string | number>): never {
  throw new PdfImportError("pdf/override-invalid", message, context);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be a mapping.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${where} has an unsafe prototype.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) invalid(`${where} contains a forbidden key.`);
    if (!accepted.has(key)) invalid(`${where} contains unknown field ${JSON.stringify(key)}.`);
  }
}

function sourceId(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || !value.startsWith("pdf:")) {
    invalid(`${where} must be a bounded PDF source id.`);
  }
  if (/\p{Cc}/u.test(value)) invalid(`${where} contains control characters.`);
  return value;
}

function operation(value: unknown, index: number): PdfImportOverrideOperationV1 {
  const where = `operations[${index}]`;
  const item = object(value, where);
  if (typeof item.kind !== "string") invalid(`${where}.kind must be a string.`);
  if (item.kind === "set-heading-level") {
    exactKeys(item, ["kind", "sourceId", "level"], where);
    if (!Number.isInteger(item.level) || Number(item.level) < 1 || Number(item.level) > 6) {
      invalid(`${where}.level must be an integer from 1 through 6.`);
    }
    return {
      kind: item.kind,
      sourceId: sourceId(item.sourceId, `${where}.sourceId`),
      level: Number(item.level) as 1 | 2 | 3 | 4 | 5 | 6,
    };
  }
  if (item.kind === "set-figure-alt") {
    exactKeys(item, ["kind", "sourceId", "alt"], where);
    if (
      typeof item.alt !== "string"
      || item.alt.trim().length < 1
      || item.alt.length > 500
      || /\p{Cc}/u.test(item.alt)
    ) invalid(`${where}.alt must be non-empty plain text of at most 500 characters.`);
    return {
      kind: item.kind,
      sourceId: sourceId(item.sourceId, `${where}.sourceId`),
      alt: item.alt.trim(),
    };
  }
  if (item.kind === "set-title-from") {
    exactKeys(item, ["kind", "sourceId"], where);
    return { kind: item.kind, sourceId: sourceId(item.sourceId, `${where}.sourceId`) };
  }
  if (item.kind === "move-before") {
    exactKeys(item, ["kind", "sourceId", "beforeSourceId"], where);
    const id = sourceId(item.sourceId, `${where}.sourceId`);
    const before = sourceId(item.beforeSourceId, `${where}.beforeSourceId`);
    if (id === before) invalid(`${where} cannot move a source before itself.`);
    return { kind: item.kind, sourceId: id, beforeSourceId: before };
  }
  return invalid(`${where}.kind is unsupported.`);
}

export async function parsePdfImportOverrides(
  text: string,
  expectedSourceSha256: string,
): Promise<ParsedPdfImportOverridesV1> {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > PDF_IMPORT_OVERRIDES_MAX_BYTES) {
    invalid("PDF override file exceeds the 256 KiB limit.", { actual: byteLength, limit: PDF_IMPORT_OVERRIDES_MAX_BYTES });
  }
  let raw: unknown;
  try {
    const document = parseDocument(text, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) invalid(`Invalid PDF override YAML: ${document.errors[0]!.message}`);
    if (document.warnings.length > 0) invalid(`Unsafe PDF override YAML: ${document.warnings[0]!.message}`);
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof PdfImportError) throw error;
    invalid(`Invalid PDF override YAML: ${(error as Error).message}`);
  }
  const root = object(raw, "override file");
  exactKeys(root, ["schema", "sourceSha256", "operations"], "override file");
  if (root.schema !== PDF_IMPORT_OVERRIDES_SCHEMA_V1) {
    invalid(`Override file must declare schema: ${PDF_IMPORT_OVERRIDES_SCHEMA_V1}.`);
  }
  if (root.sourceSha256 !== expectedSourceSha256 || !/^[0-9a-f]{64}$/u.test(String(root.sourceSha256))) {
    invalid("Override sourceSha256 does not match the PDF being reviewed.");
  }
  if (!Array.isArray(root.operations) || root.operations.length > PDF_IMPORT_OVERRIDES_MAX_OPERATIONS) {
    invalid(`operations must be an array with at most ${PDF_IMPORT_OVERRIDES_MAX_OPERATIONS} entries.`);
  }
  const operations = root.operations.map(operation);
  const decisionKeys = new Set<string>();
  let titleDecision = false;
  for (const item of operations) {
    const key = `${item.kind}:${item.sourceId}`;
    if (decisionKeys.has(key)) invalid(`Conflicting duplicate override for ${item.sourceId} (${item.kind}).`);
    decisionKeys.add(key);
    if (item.kind === "set-title-from") {
      if (titleDecision) invalid("Only one set-title-from decision is allowed.");
      titleDecision = true;
    }
  }
  const overrides: PdfImportOverridesV1 = {
    schema: PDF_IMPORT_OVERRIDES_SCHEMA_V1,
    sourceSha256: expectedSourceSha256,
    operations,
  };
  return { overrides, digest: await digestPdfCanonical(overrides) };
}

function blockMatches(block: ImportBlock, id: string): boolean {
  return block.id === id || block.sourceRefs?.includes(id) === true;
}

function blockText(block: ImportBlock): string {
  if (block.type === "heading" || block.type === "paragraph") {
    return block.runs.map((run) => run.kind === "text" ? run.text : " ").join("").replace(/\s+/gu, " ").trim();
  }
  return "";
}

export async function applyPdfImportOverrides(
  document: ImportDocumentV2,
  parsed?: ParsedPdfImportOverridesV1,
): Promise<AppliedPdfImportOverridesV1> {
  if (!parsed) {
    return {
      document,
      digest: await digestPdfCanonical({ schema: PDF_IMPORT_OVERRIDES_SCHEMA_V1, sourceSha256: null, operations: [] }),
      applied: [],
    };
  }
  const blocks = document.blocks.map((block) => ({ ...block })) as ImportBlock[];
  let titleCandidate: string | undefined;
  const applied: AppliedPdfImportOverridesV1["applied"] = [];
  for (const item of parsed.overrides.operations) {
    const index = blocks.findIndex((block) => blockMatches(block, item.sourceId));
    if (index < 0) invalid(`Override source id is stale or unknown: ${item.sourceId}.`);
    const block = blocks[index]!;
    if (item.kind === "set-heading-level") {
      if (block.type !== "heading") invalid(`Override ${item.sourceId} does not identify a heading.`);
      blocks[index] = { ...block, level: item.level };
    } else if (item.kind === "set-figure-alt") {
      if (block.type !== "image") invalid(`Override ${item.sourceId} does not identify a materialized figure.`);
      blocks[index] = { ...block, alt: item.alt };
    } else if (item.kind === "set-title-from") {
      const text = blockText(block);
      if (!text || text.length > 255) invalid(`Override ${item.sourceId} does not identify bounded extracted title text.`);
      titleCandidate = text;
    } else {
      const before = blocks.findIndex((candidate) => blockMatches(candidate, item.beforeSourceId));
      if (before < 0) invalid(`Override beforeSourceId is stale or unknown: ${item.beforeSourceId}.`);
      if (before === index) invalid(`Override ${item.sourceId} and ${item.beforeSourceId} identify the same block.`);
      const [moved] = blocks.splice(index, 1);
      const adjusted = blocks.findIndex((candidate) => blockMatches(candidate, item.beforeSourceId));
      blocks.splice(adjusted, 0, moved!);
    }
    applied.push({ kind: item.kind, sourceId: item.sourceId });
  }
  return {
    document: { ...document, blocks, ...(titleCandidate ? { titleCandidate } : {}) },
    ...(titleCandidate ? { titleCandidate } : {}),
    digest: parsed.digest,
    applied,
  };
}

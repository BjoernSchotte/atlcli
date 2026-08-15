/**
 * Versioned batch manifest (specs/import-docx/010-batch-import §3,
 * `atlcli.docx-batch-manifest/1`) — pure parsing/validation over injected
 * text, same hardened YAML gate as recipes.
 */
import { sha256Hex } from "@atlcli/core";
import { isAlias, parseDocument, visit } from "yaml";
import { canonicalJson } from "./baseline.js";

export const BATCH_MANIFEST_SCHEMA = "atlcli.docx-batch-manifest/1" as const;
export const BATCH_STATE_SCHEMA = "atlcli.docx-batch-state/1" as const;

export interface BatchManifestDocumentV1 {
  sourcePath: string;
  /** Slash-separated folder path below the batch root (folder pages). */
  relativeParentPath?: string;
  title?: string;
  splitHeading?: 1 | 2 | 3 | 4 | 5 | 6;
  labels?: string[];
}

export interface DocxBatchManifestV1 {
  schema: typeof BATCH_MANIFEST_SCHEMA;
  batchId: string;
  destination: {
    spaceKey: string;
    parentId?: string;
    staging: "private" | "none";
  };
  defaults: {
    splitHeading?: 1 | 2 | 3 | 4 | 5 | 6;
    titleConflict: "fail" | "rename";
    recipe?: string;
  };
  documents: BatchManifestDocumentV1[];
}

/** Per-item checkpoint entry (plan 010 §3 state). */
export interface BatchStateItemV1 {
  sourcePath: string;
  sourceSha256: string;
  status: "planned" | "complete" | "failed" | "skipped";
  rootPageId?: string;
  pageIds: string[];
  /** Canonicalized readback body digest of the root page when complete. */
  verifiedBodyDigest?: string;
  lastError?: string;
}

export interface DocxBatchStateV1 {
  schema: typeof BATCH_STATE_SCHEMA;
  batchId: string;
  manifestDigest: string;
  stagingRootId?: string;
  /** relativeParentPath → created folder page id. */
  folderPages: Record<string, string>;
  items: BatchStateItemV1[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_SEGMENT_RE = /^[^/\\]{1,120}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse and validate manifest YAML; returns every violation at once. */
export async function parseBatchManifest(
  text: string,
): Promise<{ manifest?: DocxBatchManifestV1; digest?: string; errors: string[] }> {
  const errors: string[] = [];
  if (text.length > 512 * 1024) return { errors: ["Manifest exceeds 512 KiB."] };

  const doc = parseDocument(text, { uniqueKeys: true, version: "1.2" });
  for (const err of doc.errors) errors.push(`YAML: ${err.message.split("\n")[0]}`);
  visit(doc, {
    Node(_, node) {
      if (isAlias(node)) errors.push("YAML anchors/aliases are not allowed in manifests.");
      if ("tag" in node && node.tag && !String(node.tag).startsWith("tag:yaml.org,2002:")) {
        errors.push(`Custom YAML tag ${String(node.tag)} is not allowed.`);
      }
    },
  });
  if (errors.length > 0) return { errors };

  const raw = doc.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isPlainObject(raw)) return { errors: ["Manifest root must be a mapping."] };
  if (raw.schema !== BATCH_MANIFEST_SCHEMA) {
    errors.push(`Field "schema" must be exactly "${BATCH_MANIFEST_SCHEMA}".`);
  }
  if (typeof raw.batchId !== "string" || !ID_RE.test(raw.batchId)) {
    errors.push(`Field "batchId" must match ${ID_RE}.`);
  }

  const dest = raw.destination;
  let destination: DocxBatchManifestV1["destination"] = { spaceKey: "", staging: "none" };
  if (!isPlainObject(dest) || typeof dest.spaceKey !== "string" || !dest.spaceKey) {
    errors.push(`"destination.spaceKey" is required.`);
  } else {
    const staging = dest.staging ?? "none";
    if (staging !== "private" && staging !== "none") {
      errors.push(`"destination.staging" must be private|none.`);
    }
    destination = {
      spaceKey: dest.spaceKey,
      ...(typeof dest.parentId === "string" ? { parentId: dest.parentId } : {}),
      staging: staging as "private" | "none",
    };
  }

  const rawDefaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const titleConflict = rawDefaults.titleConflict ?? "fail";
  if (titleConflict !== "fail" && titleConflict !== "rename") {
    errors.push(`"defaults.titleConflict" must be fail|rename.`);
  }
  const checkSplit = (value: unknown, where: string): 1 | 2 | 3 | 4 | 5 | 6 | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 6) {
      errors.push(`${where} must be an integer 1..6.`);
      return undefined;
    }
    return value as 1 | 2 | 3 | 4 | 5 | 6;
  };
  const defaults: DocxBatchManifestV1["defaults"] = {
    titleConflict: titleConflict as "fail" | "rename",
    ...(checkSplit(rawDefaults.splitHeading, `"defaults.splitHeading"`) !== undefined
      ? { splitHeading: rawDefaults.splitHeading as 1 | 2 | 3 | 4 | 5 | 6 }
      : {}),
    ...(typeof rawDefaults.recipe === "string" ? { recipe: rawDefaults.recipe } : {}),
  };

  const documents: BatchManifestDocumentV1[] = [];
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) {
    errors.push(`"documents" must be a non-empty array.`);
  } else {
    const seenPaths = new Set<string>();
    for (const [index, item] of raw.documents.entries()) {
      const where = `documents[${index}]`;
      if (!isPlainObject(item) || typeof item.sourcePath !== "string" || !item.sourcePath) {
        errors.push(`${where}.sourcePath is required.`);
        continue;
      }
      if (item.sourcePath.includes("..") || item.sourcePath.startsWith("/")) {
        errors.push(`${where}.sourcePath must be relative without "..".`);
        continue;
      }
      if (seenPaths.has(item.sourcePath)) {
        errors.push(`${where}.sourcePath duplicates ${item.sourcePath}.`);
        continue;
      }
      seenPaths.add(item.sourcePath);
      let relativeParentPath: string | undefined;
      if (item.relativeParentPath !== undefined) {
        if (typeof item.relativeParentPath !== "string") {
          errors.push(`${where}.relativeParentPath must be a string.`);
        } else {
          const segments = item.relativeParentPath.split("/").filter(Boolean);
          if (segments.some((seg) => seg === ".." || !PATH_SEGMENT_RE.test(seg))) {
            errors.push(`${where}.relativeParentPath has invalid segments.`);
          } else if (segments.length > 0) {
            relativeParentPath = segments.join("/");
          }
        }
      }
      documents.push({
        sourcePath: item.sourcePath,
        ...(relativeParentPath ? { relativeParentPath } : {}),
        ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
        ...(checkSplit(item.splitHeading, `${where}.splitHeading`) !== undefined
          ? { splitHeading: item.splitHeading as 1 | 2 | 3 | 4 | 5 | 6 }
          : {}),
        ...(Array.isArray(item.labels) ? { labels: item.labels.map(String) } : {}),
      });
    }
  }

  if (errors.length > 0) return { errors };
  const manifest: DocxBatchManifestV1 = {
    schema: BATCH_MANIFEST_SCHEMA,
    batchId: raw.batchId as string,
    destination,
    defaults,
    documents,
  };
  const digest = await sha256Hex(new TextEncoder().encode(canonicalJson(manifest)));
  return { manifest, digest, errors: [] };
}

/** Validate a loaded state file against the manifest identity. */
export function validateBatchState(
  value: unknown,
  batchId: string,
  manifestDigest: string,
): { state?: DocxBatchStateV1; reason?: string } {
  if (!isPlainObject(value)) return { reason: "state is not an object" };
  const s = value as Partial<DocxBatchStateV1>;
  if (s.schema !== BATCH_STATE_SCHEMA) return { reason: `unknown state schema ${JSON.stringify(s.schema)}` };
  if (s.batchId !== batchId) return { reason: `state belongs to batch "${s.batchId}", not "${batchId}"` };
  if (s.manifestDigest !== manifestDigest) {
    return { reason: "manifest changed since this state was written (digest mismatch) — re-run without --resume or restore the manifest" };
  }
  if (!Array.isArray(s.items) || !isPlainObject(s.folderPages ?? {})) {
    return { reason: "state is missing required fields" };
  }
  return { state: s as DocxBatchStateV1 };
}

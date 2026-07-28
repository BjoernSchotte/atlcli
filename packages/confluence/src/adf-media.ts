import { isTrustedValidatedAdf } from "./adf-validation-cache.js";
import type {
  AdfNode,
  ValidatedAdfDocument,
} from "./adf-types.js";

/**
 * Collect the exact Confluence Media Services IDs referenced by validated ADF.
 *
 * Traversal is iterative and preserves first document occurrence. The bounded
 * validator is the authority for node/attribute shape; structural lookalikes
 * cannot use this helper to bypass it.
 */
export function collectAdfMediaFileIds(
  validated: ValidatedAdfDocument,
): string[] {
  if (!isTrustedValidatedAdf(validated)) {
    throw new TypeError(
      "collectAdfMediaFileIds() requires a validateAdf() result.",
    );
  }

  const fileIds: string[] = [];
  const seen = new Set<string>();
  const stack: AdfNode[] = [];
  for (let index = validated.document.content.length - 1; index >= 0; index -= 1) {
    stack.push(validated.document.content[index]!);
  }

  while (stack.length > 0) {
    const node = stack.pop()!;
    const isAttachmentMedia =
      node.type === "mediaInline" ||
      (node.type === "media" && node.attrs?.type !== "external");
    const fileId = isAttachmentMedia ? node.attrs?.id : undefined;
    if (typeof fileId === "string" && !seen.has(fileId)) {
      seen.add(fileId);
      fileIds.push(fileId);
    }
    if (node.content) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        stack.push(node.content[index]!);
      }
    }
  }

  return fileIds;
}

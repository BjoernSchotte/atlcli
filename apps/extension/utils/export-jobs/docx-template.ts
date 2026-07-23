import { sha256Hex } from "@atlcli/core";
import type { SpoolRefV1, SpoolWriteLimitsV1 } from "@atlcli/export-jobs";
import type { DocxPinnedTemplatePortV1 } from "@atlcli/export-wiring/jobs";
import { IndexedDbExportByteStore } from "./chunk-store.js";

const MIB = 1024 * 1024;

export const EXTENSION_DOCX_TEMPLATE_LIMITS_V1: SpoolWriteLimitsV1 =
  Object.freeze({
    maxObjectBytes: 128 * MIB,
    maxJobBytes: 256 * MIB,
    maxTotalBytes: 512 * MIB,
  });

export function extensionDocxTemplateSpoolRef(jobId: string): SpoolRefV1 {
  return {
    jobId,
    leaseEpoch: 0,
    namespace: "request-assets",
    key: "docx-template",
  };
}

/**
 * Resolve the immutable, job-owned template copy. The mutable template library
 * is deliberately not consulted after submission: replacing or deleting a
 * picker entry cannot invalidate queued work or retained Retry/Run-again data.
 */
export function createExtensionDocxPinnedTemplatePort(
  bytes: Pick<IndexedDbExportByteStore, "stat" | "read">,
): DocxPinnedTemplatePortV1 {
  return {
    async resolve({ jobId, recordKey, expectedSha256, signal }) {
      signal.throwIfAborted();
      const ref = extensionDocxTemplateSpoolRef(jobId);
      const stored = await bytes.stat(ref);
      if (
        !stored
        || stored.sha256.toLowerCase() !== expectedSha256
      ) {
        throw new Error("Pinned DOCX template bytes are unavailable or changed.");
      }
      const templateBytes = new Uint8Array(stored.byteLength);
      let offset = 0;
      for await (const chunk of bytes.read(ref, { signal })) {
        signal.throwIfAborted();
        if (offset + chunk.byteLength > templateBytes.byteLength) {
          throw new Error("Pinned DOCX template bytes exceed their durable length.");
        }
        templateBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (
        offset !== stored.byteLength
        || await sha256Hex(templateBytes) !== expectedSha256
      ) {
        throw new Error("Pinned DOCX template bytes failed their integrity binding.");
      }
      signal.throwIfAborted();
      return { recordKey, bytes: templateBytes };
    },
  };
}

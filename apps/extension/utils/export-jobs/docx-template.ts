import { sha256Hex } from "@atlcli/core";
import type { DocxPinnedTemplatePortV1 } from "@atlcli/export-wiring/jobs";
import { getTemplate } from "../docx/template-store.js";

/** Resolve one exact physical template row; logical selection never runs here. */
export function createExtensionDocxPinnedTemplatePort(
  factory?: IDBFactory,
): DocxPinnedTemplatePortV1 {
  return {
    async resolve({ recordKey, expectedSha256, signal }) {
      signal.throwIfAborted();
      const record = await getTemplate(recordKey, factory);
      signal.throwIfAborted();
      if (
        !record
        || record.recordKey !== recordKey
        || record.engine !== "docx"
        || record.migrationPending
        || typeof record.sha256 !== "string"
        || record.sha256.toLowerCase() !== expectedSha256
      ) {
        throw new Error("Pinned DOCX template record is unavailable or changed.");
      }
      const bytes = new Uint8Array(record.bytes.slice(0));
      if (bytes.byteLength !== record.size || await sha256Hex(bytes) !== expectedSha256) {
        throw new Error("Pinned DOCX template bytes failed their integrity binding.");
      }
      signal.throwIfAborted();
      return { recordKey, bytes };
    },
  };
}

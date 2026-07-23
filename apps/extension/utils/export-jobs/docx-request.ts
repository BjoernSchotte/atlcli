import {
  parseDocxExportJobRequestV1,
  type DocxExportJobRequestV1,
} from "@atlcli/export-jobs";
import { sha256Hex } from "@atlcli/core";
import type { DocxExportRequest } from "../ports/export.js";
import { sanitizeDownloadName } from "../download.js";
import { createExtensionConfluenceJobSource } from "./request-source.js";

export interface CreateExtensionDocxJobRequestOptions {
  now?: () => number;
  randomUUID?: () => string;
  requestId?: string;
}

/** Build and integrity-check the unresolved request before any source discovery. */
export async function createExtensionDocxJobRequest(
  request: DocxExportRequest,
  options: CreateExtensionDocxJobRequestOptions = {},
): Promise<DocxExportJobRequestV1> {
  request.signal?.throwIfAborted();
  const recordKey = request.template.recordKey?.trim();
  const expectedSha256 = request.template.sha256?.toLowerCase();
  if (!recordKey || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Background DOCX export requires a pinned template record and SHA-256.");
  }
  const templateBytes = new Uint8Array(request.template.bytes);
  const actualSha256 = await sha256Hex(templateBytes);
  request.signal?.throwIfAborted();
  if (actualSha256 !== expectedSha256) {
    throw new Error("DOCX template bytes do not match the pinned SHA-256.");
  }

  const source = createExtensionConfluenceJobSource(request);
  const id = options.requestId ?? (options.randomUUID ?? (() => crypto.randomUUID()))();
  const createdAt = (options.now ?? Date.now)();
  return parseDocxExportJobRequestV1({
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `extension:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source,
    authRef: `session:${source.siteOrigin}`,
    displayName: request.page.details.title || "Confluence DOCX export",
    requestedFilename: sanitizeDownloadName(request.page.details.title || "export", "docx"),
    createdAt,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey,
      sha256: expectedSha256,
      name: request.template.name,
    },
    options: {
      embedImages: true,
      resolveMacros: request.resolveMacros !== false,
    },
  });
}

import {
  parsePdfExportJobRequestV1,
  type PdfExportLogoV1,
  type PdfExportJobRequestV1,
  type PdfExportSettingsV1,
} from "@atlcli/export-jobs";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "@atlcli/pdf/browser";
import type { PdfExportRequest } from "../ports/export.js";
import { sanitizeDownloadName } from "../download.js";
import { createExtensionConfluenceJobSource } from "./request-source.js";

export interface CreateExtensionPdfJobRequestOptions {
  now?: () => number;
  randomUUID?: () => string;
  requestId?: string;
  pinnedLogo?: PdfExportLogoV1;
}

function durableSettings(request: PdfExportRequest, pinnedLogo?: PdfExportLogoV1): PdfExportSettingsV1 {
  const settings = request.settings ?? {};
  if (settings.logo !== undefined && pinnedLogo === undefined) {
    throw new Error("Background PDF logo bytes require a pinned asset reference.");
  }
  if (settings.logo === undefined && pinnedLogo !== undefined) {
    throw new Error("A pinned PDF logo must correspond to the submitted settings.");
  }
  return {
    ...(settings.page === undefined ? {} : { page: settings.page }),
    ...(settings.orientation === undefined ? {} : { orientation: settings.orientation }),
    ...(settings.cover === undefined ? {} : { cover: settings.cover }),
    ...(settings.outline === undefined ? {} : { outline: settings.outline }),
    ...(settings.headerText === undefined ? {} : { headerText: settings.headerText }),
    ...(settings.footerText === undefined ? {} : { footerText: settings.footerText }),
    ...(settings.accentColor === undefined ? {} : { accentColor: settings.accentColor }),
    ...(settings.organizationName === undefined ? {} : { organizationName: settings.organizationName }),
    ...(settings.watermark === undefined ? {} : { watermark: structuredClone(settings.watermark) }),
    ...(pinnedLogo === undefined ? {} : { logo: structuredClone(pinnedLogo) }),
  };
}

/** Build the unresolved, replay-safe request that must be durable before discovery starts. */
export function createExtensionPdfJobRequest(
  request: PdfExportRequest,
  options: CreateExtensionPdfJobRequestOptions = {},
): PdfExportJobRequestV1 {
  request.signal?.throwIfAborted();
  const source = createExtensionConfluenceJobSource(request);
  const id = options.requestId ?? (options.randomUUID ?? (() => crypto.randomUUID()))();
  const createdAt = (options.now ?? Date.now)();
  return parsePdfExportJobRequestV1({
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `extension:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source,
    authRef: `session:${source.siteOrigin}`,
    displayName: request.page.details.title || "Confluence PDF export",
    requestedFilename: sanitizeDownloadName(request.page.details.title || "export", "pdf"),
    createdAt,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      id: BUILTIN_PDF_TEMPLATE_MANIFEST.id,
      manifestVersion: BUILTIN_PDF_TEMPLATE_MANIFEST.version,
    },
    settings: durableSettings(request, options.pinnedLogo),
    options: {
      resolveMacros: request.resolveMacros !== false,
      // Recovery before `ready-to-render` must rebuild byte-identical metadata.
      // Pin the timestamp with the unresolved request instead of sampling the
      // offscreen host's clock on each attempt.
      exportedAt: createdAt,
    },
  });
}

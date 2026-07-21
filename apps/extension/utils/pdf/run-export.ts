import {
  ConfluenceClient,
  resolveExportMentions,
  storageToBlocks,
  type ExportBlock,
  type ExportMentionResolution,
  type ExportNote,
} from "@atlcli/confluence/browser";
import {
  normalizePdfLocale,
  runPdfExport as runNeutralPdfExport,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportPhase as NeutralPdfExportPhase,
  type PdfExportReport,
  type PdfOutputSink,
  type PdfProfile,
  type PdfThemeOptions,
} from "@atlcli/pdf/browser";
import type { LoadedPage } from "../read-path.js";
import { profileFromTabUrl } from "../profile.js";
import { sessionAssetFetcher } from "../docx/env.js";
import { downloadBytes, sanitizeDownloadName } from "../download.js";
import { extensionPdfCompilePort } from "./compile-port.js";

export { normalizePdfLocale };

export type PdfExportPhase =
  | "preparing"
  | "fetching"
  | "queued"
  | "compiling"
  | "validating"
  | "downloading";

export interface RunPdfExportInput {
  page: LoadedPage;
  pageUrl: string;
  theme?: PdfThemeOptions;
  profile?: PdfProfile;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
}

export interface RunPdfExportDeps {
  now: () => number;
  locale: () => string;
  resolveMentions: (
    blocks: ExportBlock[],
    pageUrl: string,
    signal?: AbortSignal
  ) => Promise<ExportMentionResolution>;
  resolver?: PdfAssetResolver;
  createCompilePort: (options: {
    sourceIdentity: string;
    onQueued: () => void;
    onCompiling: () => void;
  }) => PdfCompilePort;
  output: PdfOutputSink;
}

function runtimeLocale(): string {
  return (typeof document !== "undefined" ? document.documentElement.lang : "")
    || (typeof navigator !== "undefined" ? navigator.language : "")
    || "en";
}

async function defaultResolveMentions(
  blocks: ExportBlock[],
  pageUrl: string,
  signal?: AbortSignal
): Promise<ExportMentionResolution> {
  return resolveExportMentions(blocks, async (accountIds) => {
    throwIfAborted(signal);
    const profile = profileFromTabUrl(pageUrl);
    if (!profile) throw new Error("The active page is not on an approved Atlassian host.");
    const users = await new ConfluenceClient(profile).getUsersBulk(accountIds);
    throwIfAborted(signal);
    return new Map([...users].map(([accountId, user]) => [accountId, user?.displayName ?? null]));
  });
}

const defaultDeps: RunPdfExportDeps = {
  now: () => Date.now(),
  locale: runtimeLocale,
  resolveMentions: defaultResolveMentions,
  createCompilePort: (options) => extensionPdfCompilePort(options),
  output: {
    emit: (name, bytes, context) => downloadBytes({
      name,
      bytes,
      mimeType: "application/pdf",
      signal: context?.signal,
    }),
  },
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

function mimeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

function pageResolver(page: LoadedPage, pageUrl: string, signal?: AbortSignal): PdfAssetResolver {
  const profile = profileFromTabUrl(pageUrl);
  if (!profile) {
    return { resolve: async () => { throw new Error("The active page is not on an approved Atlassian host."); } };
  }
  const baseUrl = `${profile.baseUrl.replace(/\/+$/, "")}/wiki`;
  const fetcher = sessionAssetFetcher(
    baseUrl,
    ((request: RequestInfo | URL, init?: RequestInit) => fetch(request, { ...init, signal })) as typeof fetch
  );
  return {
    async resolve(ref) {
      throwIfAborted(signal);
      if (ref.kind === "external") throw new Error("External image hosts are not fetched by the PDF exporter.");
      const filename = ref.filename ?? "attachment";
      const bytes = await fetcher.fetch({
        url: `/download/attachments/${encodeURIComponent(page.details.id)}/${encodeURIComponent(filename)}`,
        pageId: page.details.id,
        filename,
      });
      throwIfAborted(signal);
      if (bytes.byteLength === 0) throw new Error("Attachment response was empty.");
      return { bytes, mediaType: mimeFromFilename(filename), filename };
    },
  };
}

function mapNeutralPhase(
  phase: NeutralPdfExportPhase,
  onPhase: RunPdfExportInput["onPhase"]
): void {
  switch (phase) {
    case "preparing": onPhase?.("preparing"); break;
    case "fetching": onPhase?.("fetching"); break;
    case "compiling": break;
    case "validating": onPhase?.("validating"); break;
    case "emitting": onPhase?.("downloading"); break;
  }
}

export async function runPdfExport(
  input: RunPdfExportInput,
  overrides: Partial<RunPdfExportDeps> = {}
): Promise<PdfExportReport> {
  const deps = { ...defaultDeps, ...overrides };
  throwIfAborted(input.signal);
  const { blocks: walkedBlocks, notes: walkerNotes } = storageToBlocks(
    input.page.details.storage ?? "",
    { exporter: "pdf" }
  );
  let blocks = walkedBlocks;
  const mentionNotes: ExportNote[] = [];
  try {
    const resolved = await deps.resolveMentions(blocks, input.pageUrl, input.signal);
    blocks = resolved.blocks;
    if (resolved.unresolved > 0) {
      // SHARED code (spec 010): the CLI's PDF host
      // (`apps/cli/src/commands/export-pdf.ts`) and its DOCX host
      // (`apps/cli/src/commands/export.ts`) both report this exact condition as
      // `mention-unresolved`. A host-local spelling made one report's
      // `notesByCode` unfilterable with the other's key even though the fact —
      // "an account id did not resolve to a display name on the source page" —
      // is identical and has nothing to do with which host noticed it.
      mentionNotes.push({
        level: "warning",
        code: "mention-unresolved",
        message: `${resolved.unresolved} mention display name(s) could not be resolved; technical identifiers were retained.`,
      });
    }
  } catch {
    throwIfAborted(input.signal);
    mentionNotes.push({
      level: "warning",
      code: "pdf-mention-resolution-failed",
      message: "Mention display names could not be resolved; technical identifiers were retained.",
    });
  }

  const locale = normalizePdfLocale(deps.locale());
  const sourceIdentity = `${input.pageUrl}|${input.page.details.id}|${input.page.details.version ?? ""}`;
  const compiler = deps.createCompilePort({
    sourceIdentity,
    onQueued: () => input.onPhase?.("queued"),
    onCompiling: () => input.onPhase?.("compiling"),
  });

  return runNeutralPdfExport({
    blocks,
    sourceNotes: [...walkerNotes, ...mentionNotes],
    metadata: {
      title: input.page.details.title,
      space: input.page.details.spaceKey,
      version: input.page.details.version,
      author: input.page.details.modifiedBy?.displayName,
      exporter: input.page.details.modifiedBy?.displayName ?? "atlcli",
      language: locale.language,
      region: locale.region,
      exportedAt: new Date(deps.now()),
    },
    profile: input.profile,
    theme: input.theme,
    filename: sanitizeDownloadName(input.page.details.title, "pdf"),
    signal: input.signal,
    onPhase: (phase) => mapNeutralPhase(phase, input.onPhase),
  }, {
    assets: deps.resolver ?? pageResolver(input.page, input.pageUrl, input.signal),
    compiler,
    output: deps.output,
    now: deps.now,
  });
}

export function hasPdfRelevantBlocks(blocks: ExportBlock[]): boolean {
  return blocks.length > 0;
}

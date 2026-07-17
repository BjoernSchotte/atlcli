import {
  ConfluenceClient,
  storageToBlocks,
  type ExportBlock,
  type ExportNote,
  type InlineNode,
  type UserInfo,
} from "@atlcli/confluence/browser";
import {
  preparePdfDocument,
  serializePdfDocument,
  type PdfAssetResolver,
  type PdfExportReport,
  type PdfSourceBundle,
  type PreparedPdfBlock,
} from "@atlcli/pdf/browser";
import type { LoadedPage } from "../read-path.js";
import { profileFromTabUrl } from "../profile.js";
import { sessionAssetFetcher } from "../docx/env.js";
import { downloadBytes, sanitizeDownloadName } from "../download.js";
import {
  cleanupPdfJobs,
  createPdfJobId,
  deletePdfJob,
  getPdfJob,
  putPdfJob,
} from "./job-store.js";
import { validatePdfOutput } from "./validate.js";

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
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
}

export interface RunPdfExportDeps {
  now: () => number;
  makeJobId: () => string;
  createJob: typeof putPdfJob;
  getJob: typeof getPdfJob;
  deleteJob: typeof deletePdfJob;
  cleanupJobs: typeof cleanupPdfJobs;
  sendMessage: (message: { kind: "pdf:compile" | "pdf:cancel"; jobId: string }) => Promise<unknown>;
  download: (name: string, bytes: Uint8Array) => Promise<void>;
  prepare: typeof preparePdfDocument;
  serialize: typeof serializePdfDocument;
  resolveMentions: (
    blocks: ExportBlock[],
    pageUrl: string,
    signal?: AbortSignal
  ) => Promise<PdfMentionResolution>;
  resolver?: PdfAssetResolver;
}

type PdfMentionUser = Pick<UserInfo, "displayName">;

export interface PdfMentionResolution {
  blocks: ExportBlock[];
  unresolved: number;
}

function unresolvedMentionIds(blocks: ExportBlock[]): string[] {
  const ids = new Set<string>();
  const visitInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "mention" && !node.displayName?.trim() && node.accountId.trim()) {
        ids.add(node.accountId);
      } else if (node.type === "link") {
        visitInline(node.content);
      }
    }
  };
  const visitBlocks = (items: ExportBlock[]): void => {
    for (const block of items) {
      switch (block.type) {
        case "heading":
        case "paragraph":
          visitInline(block.content);
          break;
        case "callout":
        case "blockquote":
          visitBlocks(block.content);
          break;
        case "list":
          for (const item of block.items) visitBlocks(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) visitBlocks(cell.content);
          break;
      }
    }
  };
  visitBlocks(blocks);
  return [...ids];
}

function resolveInlineMentions(
  nodes: InlineNode[],
  users: ReadonlyMap<string, PdfMentionUser | null>
): InlineNode[] {
  return nodes.map((node) => {
    if (node.type === "link") {
      return { ...node, content: resolveInlineMentions(node.content, users) };
    }
    if (node.type !== "mention" || node.displayName?.trim()) return node;
    const displayName = users.get(node.accountId)?.displayName?.trim();
    return displayName ? { ...node, displayName } : node;
  });
}

function resolveBlockMentions(
  blocks: ExportBlock[],
  users: ReadonlyMap<string, PdfMentionUser | null>
): ExportBlock[] {
  return blocks.map((block): ExportBlock => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return { ...block, content: resolveInlineMentions(block.content, users) };
      case "callout":
      case "blockquote":
        return { ...block, content: resolveBlockMentions(block.content, users) };
      case "list":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            content: resolveBlockMentions(item.content, users),
          })),
        };
      case "table":
        return {
          ...block,
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              content: resolveBlockMentions(cell.content, users),
            })),
          })),
        };
      default:
        return block;
    }
  });
}

export async function resolvePdfMentionNames(
  blocks: ExportBlock[],
  loadUsers: (
    accountIds: string[]
  ) => Promise<ReadonlyMap<string, PdfMentionUser | null>>
): Promise<PdfMentionResolution> {
  const accountIds = unresolvedMentionIds(blocks);
  if (accountIds.length === 0) return { blocks, unresolved: 0 };
  const users = await loadUsers(accountIds);
  const unresolved = accountIds.filter((accountId) => !users.get(accountId)?.displayName?.trim()).length;
  return { blocks: resolveBlockMentions(blocks, users), unresolved };
}

async function defaultResolveMentions(
  blocks: ExportBlock[],
  pageUrl: string,
  signal?: AbortSignal
): Promise<PdfMentionResolution> {
  return resolvePdfMentionNames(blocks, async (accountIds) => {
    throwIfAborted(signal);
    const profile = profileFromTabUrl(pageUrl);
    if (!profile) throw new Error("The active page is not on an approved Atlassian host.");
    const users = await new ConfluenceClient(profile).getUsersBulk(accountIds);
    throwIfAborted(signal);
    return users;
  });
}

const defaultDeps: RunPdfExportDeps = {
  now: () => Date.now(),
  makeJobId: () => createPdfJobId(),
  createJob: putPdfJob,
  getJob: getPdfJob,
  deleteJob: deletePdfJob,
  cleanupJobs: cleanupPdfJobs,
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  download: (name, bytes) => downloadBytes({ name, bytes, mimeType: "application/pdf" }),
  prepare: preparePdfDocument,
  serialize: serializePdfDocument,
  resolveMentions: defaultResolveMentions,
};

export function normalizePdfLocale(locale: string | undefined): {
  language: string;
  region?: string;
} {
  const parts = (locale ?? "")
    .trim()
    .replaceAll("_", "-")
    .split("-")
    .filter(Boolean);
  const rawLanguage = parts[0] ?? "";
  const language = /^[a-z]{2,3}$/i.test(rawLanguage) ? rawLanguage.toLowerCase() : "en";
  const rawRegion = parts.slice(1).find((part) => /^(?:[a-z]{2}|[0-9]{3})$/i.test(part));
  return rawRegion ? { language, region: rawRegion.toUpperCase() } : { language };
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
    ((request: RequestInfo | URL, init?: RequestInit) =>
      fetch(request, { ...init, signal })) as typeof fetch
  );
  return {
    async resolve(ref) {
      throwIfAborted(signal);
      if (ref.kind === "external") {
        throw new Error("External image hosts are not fetched by the PDF exporter.");
      }
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

function countPrepared(blocks: PreparedPdfBlock[]): { images: number; diagrams: number; skipped: number } {
  const total = { images: 0, diagrams: 0, skipped: 0 };
  const walk = (list: PreparedPdfBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          if (block.assetPath) total.images += 1;
          else total.skipped += 1;
          break;
        case "diagram":
          total.diagrams += 1;
          break;
        case "callout":
        case "blockquote":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return total;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

export async function runPdfExport(
  input: RunPdfExportInput,
  overrides: Partial<RunPdfExportDeps> = {}
): Promise<PdfExportReport> {
  const deps = { ...defaultDeps, ...overrides };
  const startedAt = deps.now();
  await deps.cleanupJobs().catch(() => 0);
  throwIfAborted(input.signal);

  input.onPhase?.("preparing");
  const { blocks: walkedBlocks, notes: walkerNotes } = storageToBlocks(input.page.details.storage ?? "");
  input.onPhase?.("fetching");
  let blocks = walkedBlocks;
  const mentionNotes: ExportNote[] = [];
  try {
    const resolved = await deps.resolveMentions(blocks, input.pageUrl, input.signal);
    blocks = resolved.blocks;
    if (resolved.unresolved > 0) {
      mentionNotes.push({
        level: "warning",
        code: "pdf-mention-unresolved",
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
  const prepareStarted = deps.now();
  const prepared = await deps.prepare(
    blocks,
    deps.resolver ?? pageResolver(input.page, input.pageUrl, input.signal)
  );
  const prepareMs = deps.now() - prepareStarted;
  throwIfAborted(input.signal);

  const exportedAt = new Date(deps.now());
  const runtimeLocale =
    (typeof document !== "undefined" ? document.documentElement.lang : "") ||
    (typeof navigator !== "undefined" ? navigator.language : "") ||
    "en";
  const locale = normalizePdfLocale(runtimeLocale);
  const bundle: PdfSourceBundle = deps.serialize(prepared, {
    metadata: {
      title: input.page.details.title,
      space: input.page.details.spaceKey,
      version: input.page.details.version,
      author: input.page.details.modifiedBy?.displayName,
      exporter: input.page.details.modifiedBy?.displayName ?? "atlcli",
      language: locale.language,
      region: locale.region,
      exportedAt,
    },
  });
  const notes: ExportNote[] = [...walkerNotes, ...mentionNotes, ...bundle.notes];
  const counts = countPrepared(prepared.blocks);
  const jobId = deps.makeJobId();
  const sourceIdentity = `${input.pageUrl}|${input.page.details.id}|${input.page.details.version ?? ""}`;
  input.onPhase?.("queued");
  await deps.createJob({ id: jobId, sourceIdentity, bundle });

  let cancelSent = false;
  const cancel = (): void => {
    if (cancelSent) return;
    cancelSent = true;
    void deps.sendMessage({ kind: "pdf:cancel", jobId }).catch(() => undefined);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });

  try {
    throwIfAborted(input.signal);
    input.onPhase?.("compiling");
    const compileStarted = deps.now();
    const response = (await deps.sendMessage({ kind: "pdf:compile", jobId })) as
      | { kind?: string; jobId?: string; ok?: boolean; error?: string }
      | undefined;
    const compileMs = deps.now() - compileStarted;
    throwIfAborted(input.signal);
    if (!response || response.kind !== "pdf:compile-result" || response.jobId !== jobId) {
      throw new Error("PDF compiler returned no correlated response.");
    }
    if (!response.ok) throw new Error(response.error || "PDF compilation failed.");
    const completed = await deps.getJob(jobId);
    if (!completed || completed.status !== "complete" || !completed.pdf) {
      throw new Error(completed?.error ?? "PDF compiler completed without a stored result.");
    }
    throwIfAborted(input.signal);
    input.onPhase?.("validating");
    const inspection = validatePdfOutput(completed.pdf);
    input.onPhase?.("downloading");
    const downloadStarted = deps.now();
    const filename = sanitizeDownloadName(input.page.details.title, "pdf");
    await deps.download(filename, completed.pdf);
    const downloadMs = deps.now() - downloadStarted;
    return {
      filename,
      profile: "tagged",
      compilerVersion: completed.compilerVersion ?? "unknown",
      pageCount: inspection.pageCount,
      embeddedImages: counts.images,
      renderedDiagrams: counts.diagrams,
      skippedAssets: counts.skipped,
      notes,
      timings: {
        prepareMs,
        compileMs,
        downloadMs,
        totalMs: deps.now() - startedAt,
      },
    };
  } finally {
    input.signal?.removeEventListener("abort", cancel);
    await deps.deleteJob(jobId).catch(() => undefined);
  }
}

export function hasPdfRelevantBlocks(blocks: ExportBlock[]): boolean {
  return blocks.length > 0;
}

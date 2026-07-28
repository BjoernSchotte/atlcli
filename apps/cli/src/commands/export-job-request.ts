import { basename, resolve } from "node:path";
import {
  resolveCodeThemeId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import type { Profile } from "@atlcli/core";
import type {
  DocxExportJobRequestV1,
  ExportSourceV1,
  PdfExportJobRequestV1,
  PdfTemplateReferenceV1,
} from "@atlcli/export-jobs";
import type { ParsedExportRequest } from "./export-request.js";

function sourceLocator(request: ParsedExportRequest): ExportSourceV1["locator"] {
  if (request.scopeKind === "space") {
    return { kind: "space-key", spaceKey: request.spaceKey! };
  }
  const ref = request.pageRef!;
  if (/^\d+$/.test(ref)) return { kind: "page-id", id: ref };
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    const id = ref.match(/pages\/(\d+)/)?.[1] ?? ref.match(/[?&]pageId=(\d+)/)?.[1];
    if (id) return { kind: "page-id", id };
  }
  return { kind: "content-key", value: ref };
}

function siteOrigin(profile: Profile): string {
  const raw = /^https?:\/\//i.test(profile.baseUrl) ? profile.baseUrl : `https://${profile.baseUrl}`;
  return new URL(raw).origin;
}

function authRef(profile: Profile): string {
  return profile.name === "ephemeral"
    ? `cli-ephemeral:process-${process.pid}`
    : `cli-profile:${profile.name}`;
}

export function buildCliExportSource(
  request: ParsedExportRequest,
  profile: Profile,
): ExportSourceV1 {
  const scope: ExportSourceV1["scope"] =
    request.scopeKind === "page"
      ? { kind: "page" }
      : request.scopeKind === "tree"
        ? {
            kind: "tree",
            includeRoot: request.includeRoot,
            ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
          }
        : { kind: "space" };
  return {
    kind: "confluence",
    siteOrigin: siteOrigin(profile),
    locator: sourceLocator(request),
    scope,
    ...(request.labels ? { labels: request.labels } : {}),
    completenessMode: request.completenessMode,
    ...(request.maxPages !== undefined ? { maxPages: request.maxPages } : {}),
    ...(request.maxFolders !== undefined ? { maxFolders: request.maxFolders } : {}),
  };
}

interface CliJobBaseInput {
  id: string;
  idempotencyKey: string;
  createdAt: number;
  request: ParsedExportRequest;
  profile: Profile;
  outputPath: string;
  outputTargetKind?: "file" | "directory";
  displayName?: string;
  codeTheme?: CodeThemeId;
}

export function buildCliDocxJobRequest(
  input: CliJobBaseInput & {
    template: { recordKey: string; sha256: string; name: string };
    embedImages: boolean;
    keepIgnored: boolean;
    strict: boolean;
    noFieldUpdatePrompt: boolean;
    overwriteExisting: boolean;
  },
): DocxExportJobRequestV1 {
  const targetKind = input.outputTargetKind ?? "file";
  return {
    schema: "atlcli.export-job-request/1",
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    format: "docx",
    renderer: "docx-typescript",
    source: buildCliExportSource(input.request, input.profile),
    authRef: authRef(input.profile),
    displayName: input.displayName ?? input.request.pageRef ?? input.request.spaceKey ?? "Confluence export",
    ...(targetKind === "file" ? { requestedFilename: basename(input.outputPath) } : {}),
    createdAt: input.createdAt,
    priority: "interactive",
    output: {
      policy: "path",
      targetRef: resolve(input.outputPath),
      targetKind,
      overwriteExisting: input.overwriteExisting,
    },
    template: input.template,
    options: {
      embedImages: input.embedImages,
      resolveMacros: true,
      codeTheme: resolveCodeThemeId(input.codeTheme),
      keepIgnored: input.keepIgnored,
      strict: input.strict,
      updateFields: input.noFieldUpdatePrompt ? "never" : "auto",
    },
  };
}

export function buildCliPdfJobRequest(
  input: CliJobBaseInput & {
    force: boolean;
    strict: boolean;
    noCache: boolean;
    exportedAt?: Date;
    template?: PdfTemplateReferenceV1;
  },
): PdfExportJobRequestV1 {
  const targetKind = input.outputTargetKind ?? "file";
  return {
    schema: "atlcli.export-job-request/1",
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    format: "pdf",
    renderer: "pdf-typst",
    source: buildCliExportSource(input.request, input.profile),
    authRef: authRef(input.profile),
    displayName: input.displayName ?? input.request.pageRef ?? input.request.spaceKey ?? "Confluence export",
    ...(targetKind === "file" ? { requestedFilename: basename(input.outputPath) } : {}),
    createdAt: input.createdAt,
    priority: "interactive",
    output: {
      policy: "path",
      targetRef: resolve(input.outputPath),
      targetKind,
      overwriteExisting: input.force,
    },
    template:
      input.template ??
      {
        kind: "builtin",
        id: "builtin-default",
        manifestVersion: "1",
      },
    settings: {},
    options: {
      resolveMacros: true,
      codeTheme: resolveCodeThemeId(input.codeTheme),
      profile: input.profile.name,
      strict: input.strict,
      noCache: input.noCache,
      ...(input.exportedAt ? { exportedAt: input.exportedAt.getTime() } : {}),
    },
  };
}

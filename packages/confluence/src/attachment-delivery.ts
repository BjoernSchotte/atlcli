import type { AttachmentInfo } from "./client.js";

/** A Confluence product request supplied by the active host. */
export type ConfluenceProductRequestV1 = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

/** Browser-safe attachment input. Blob inputs are never materialized as bytes. */
export type AttachmentBodyV1 = Blob | Uint8Array;

export type AttachmentDeliveryFailureKind =
  | "forbidden"
  | "not-found"
  | "name-conflict"
  | "rate-limited"
  | "too-large"
  | "invalid-response"
  | "transport";

export type AttachmentDeliveryOperation =
  | "find-by-filename"
  | "create"
  | "update-data";

export interface AttachmentDeliveryErrorOptions {
  operation: AttachmentDeliveryOperation;
  pageId: string;
  filename?: string;
  attachmentId?: string;
  status?: number;
  retryAfterMs?: number;
  requestMayHaveSucceeded?: boolean;
  requerySuggested?: boolean;
  diagnostic?: string;
  cause?: unknown;
}

/**
 * Stable, host-neutral attachment failure.
 *
 * The error intentionally retains no request headers, multipart body, file
 * bytes, or raw response body.
 */
export class AttachmentDeliveryError extends Error {
  readonly operation: AttachmentDeliveryOperation;
  readonly pageId: string;
  readonly filename?: string;
  readonly attachmentId?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestMayHaveSucceeded: boolean;
  readonly requerySuggested: boolean;
  readonly diagnostic?: string;

  constructor(
    readonly kind: AttachmentDeliveryFailureKind,
    options: AttachmentDeliveryErrorOptions,
  ) {
    const status = options.status === undefined ? "" : ` (HTTP ${options.status})`;
    const diagnostic = options.diagnostic ? `: ${options.diagnostic}` : "";
    super(`Confluence attachment ${options.operation} failed [${kind}]${status}${diagnostic}`, {
      cause: options.cause,
    });
    this.name = "AttachmentDeliveryError";
    this.operation = options.operation;
    this.pageId = options.pageId;
    this.filename = options.filename;
    this.attachmentId = options.attachmentId;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestMayHaveSucceeded = options.requestMayHaveSucceeded ?? false;
    this.requerySuggested = options.requerySuggested ?? false;
    this.diagnostic = options.diagnostic;
  }
}

export interface FindPageAttachmentByFilenameInputV1 {
  pageId: string;
  filename: string;
}

export interface CreatePageAttachmentInputV1 {
  pageId: string;
  filename: string;
  body: AttachmentBodyV1;
  mimeType: string;
  comment?: string;
  /** Defaults to true for generated exports. */
  minorEdit?: boolean;
}

export interface UpdatePageAttachmentDataInputV1
  extends CreatePageAttachmentInputV1 {
  attachmentId: string;
}

export interface PageAttachmentWriterV1 {
  /**
   * Find an exact filename through the bounded Confluence Cloud v2 filter.
   * This method never walks attachment pagination.
   */
  findByFilename(
    input: FindPageAttachmentByFilenameInputV1,
  ): Promise<AttachmentInfo | undefined>;

  /**
   * Create a new attachment after an exact-name conflict preflight.
   *
   * A matching name or a duplicate-name race rejects with `name-conflict`;
   * create never silently changes into an update.
   */
  create(input: CreatePageAttachmentInputV1): Promise<AttachmentInfo>;

  /** Create a new version of an existing attachment. */
  updateData(input: UpdatePageAttachmentDataInputV1): Promise<AttachmentInfo>;
}

export interface PageAttachmentWriterOptionsV1 {
  /**
   * Confluence context path. Cloud and Forge use `/wiki`; an adapter already
   * rooted at the Confluence context can pass an empty string.
   */
  pathPrefix?: string;
}

interface ErrorContext {
  operation: AttachmentDeliveryOperation;
  pageId: string;
  filename?: string;
  attachmentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePathPrefix(pathPrefix: string | undefined): string {
  if (pathPrefix === undefined) return "/wiki";
  const trimmed = pathPrefix.trim();
  if (trimmed === "" || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, "");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function safeDiagnostic(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  for (const key of ["message", "errorMessage", "reason", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.replace(/\s+/gu, " ").trim().slice(0, 512);
    }
  }
  return undefined;
}

function searchableErrorText(payload: unknown, rawText: string): string {
  const parts = [rawText];
  if (isRecord(payload)) {
    for (const key of ["message", "errorMessage", "reason", "error"]) {
      const value = payload[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n").toLowerCase();
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function mutationMayBeAmbiguous(
  operation: AttachmentDeliveryOperation,
  status?: number,
): boolean {
  return operation !== "find-by-filename" &&
    (status === undefined || status >= 500);
}

function deliveryError(
  kind: AttachmentDeliveryFailureKind,
  context: ErrorContext,
  options: Omit<AttachmentDeliveryErrorOptions, keyof ErrorContext> = {},
): AttachmentDeliveryError {
  const requestMayHaveSucceeded =
    options.requestMayHaveSucceeded ??
    mutationMayBeAmbiguous(context.operation, options.status);
  return new AttachmentDeliveryError(kind, {
    ...context,
    ...options,
    requestMayHaveSucceeded,
    requerySuggested:
      options.requerySuggested ??
      (kind === "name-conflict" || requestMayHaveSucceeded),
  });
}

function classifyHttpFailure(
  response: Response,
  payload: unknown,
  rawText: string,
  context: ErrorContext,
): AttachmentDeliveryError {
  const searchable = searchableErrorText(payload, rawText);
  const duplicate =
    response.status === 409 ||
    /(?:same|duplicate).{0,40}(?:file\s*name|filename|attachment)|already exists/u.test(
      searchable,
    );
  const tooLarge =
    response.status === 413 ||
    /(?:too large|exceeds.{0,40}(?:limit|maximum|max)|maximum.{0,40}(?:attachment|file|size))/u.test(
      searchable,
    );

  let kind: AttachmentDeliveryFailureKind;
  if (duplicate) kind = "name-conflict";
  else if (tooLarge) kind = "too-large";
  else if (response.status === 401 || response.status === 403) kind = "forbidden";
  else if (response.status === 404) kind = "not-found";
  else if (response.status === 429) kind = "rate-limited";
  else kind = "transport";

  return deliveryError(kind, context, {
    status: response.status,
    retryAfterMs:
      response.status === 429
        ? parseRetryAfterMs(response.headers.get("Retry-After"))
        : undefined,
    diagnostic: safeDiagnostic(payload),
  });
}

async function responsePayload(
  response: Response,
  context: ErrorContext,
): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await response.text();
  } catch (cause) {
    throw deliveryError("transport", context, { cause });
  }

  let payload: unknown;
  try {
    payload = rawText === "" ? undefined : JSON.parse(rawText);
  } catch (cause) {
    if (!response.ok) {
      throw classifyHttpFailure(response, undefined, rawText, context);
    }
    throw deliveryError("invalid-response", context, {
      cause,
      diagnostic: "response body is not valid JSON",
    });
  }

  if (!response.ok) {
    throw classifyHttpFailure(response, payload, rawText, context);
  }
  return payload;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedLink(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeAttachment(
  value: unknown,
  pageId: string,
  context: ErrorContext,
): AttachmentInfo {
  if (!isRecord(value)) {
    throw deliveryError("invalid-response", context, {
      diagnostic: "attachment content is not an object",
    });
  }

  const id = stringValue(value.id);
  const filename = stringValue(value.title) ?? stringValue(value.filename);
  if (!id || !filename) {
    throw deliveryError("invalid-response", context, {
      diagnostic: "attachment id or filename is missing",
    });
  }

  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const extensions = isRecord(value.extensions) ? value.extensions : {};
  const versionValue = isRecord(value.version) ? value.version : {};
  const links = isRecord(value._links) ? value._links : {};
  const container = isRecord(value.container) ? value.container : {};

  const base = normalizedLink(links.base);
  const webui =
    normalizedLink(value.webuiLink) ??
    normalizedLink(links.webui);
  const downloadUrl =
    normalizedLink(value.downloadLink) ??
    normalizedLink(links.download) ??
    "";
  const url = webui
    ? base && webui.startsWith("/") ? `${base}${webui}` : webui
    : undefined;

  const version = numberValue(versionValue.number);
  const fileSize =
    numberValue(value.fileSize) ??
    numberValue(extensions.fileSize) ??
    0;
  const mediaType =
    stringValue(value.mediaType) ??
    stringValue(metadata.mediaType) ??
    stringValue(extensions.mediaType) ??
    "application/octet-stream";

  return {
    id,
    filename,
    mediaType,
    fileSize,
    version: version && Number.isInteger(version) && version > 0 ? version : 1,
    modified:
      stringValue(versionValue.when) ??
      stringValue(versionValue.createdAt),
    pageId:
      stringValue(value.pageId) ??
      stringValue(container.id) ??
      pageId,
    downloadUrl,
    url,
    comment:
      stringValue(value.comment) ??
      stringValue(metadata.comment) ??
      stringValue(versionValue.message),
  };
}

function multipartBody(input: CreatePageAttachmentInputV1): FormData {
  const form = new FormData();
  const blob =
    input.body instanceof Blob
      ? input.body.type === input.mimeType
        ? input.body
        : input.body.slice(0, input.body.size, input.mimeType)
      : new Blob([input.body as unknown as BlobPart], { type: input.mimeType });
  form.append("file", blob, input.filename);
  form.append("minorEdit", String(input.minorEdit ?? true));
  if (input.comment !== undefined) form.append("comment", input.comment);
  return form;
}

/**
 * Create a browser-safe Confluence attachment writer over a host request.
 *
 * The writer adds product headers only. Authentication, credentials, CORS,
 * cancellation, and any Forge bridge integration remain owned by the adapter.
 */
export function createPageAttachmentWriterV1(
  request: ConfluenceProductRequestV1,
  options: PageAttachmentWriterOptionsV1 = {},
): PageAttachmentWriterV1 {
  const pathPrefix = normalizePathPrefix(options.pathPrefix);

  const findByFilename = async (
    input: FindPageAttachmentByFilenameInputV1,
  ): Promise<AttachmentInfo | undefined> => {
    const context: ErrorContext = {
      operation: "find-by-filename",
      pageId: input.pageId,
      filename: input.filename,
    };
    const query = new URLSearchParams({
      filename: input.filename,
      limit: "1",
    });
    const path =
      `${pathPrefix}/api/v2/pages/${encodePathSegment(input.pageId)}` +
      `/attachments?${query.toString()}`;

    let response: Response;
    try {
      response = await request(path, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (cause) {
      if (cause instanceof AttachmentDeliveryError) throw cause;
      throw deliveryError("transport", context, { cause });
    }

    const payload = await responsePayload(response, context);
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw deliveryError("invalid-response", context, {
        diagnostic: "v2 attachment result array is missing",
      });
    }
    const first = payload.results[0];
    return first === undefined
      ? undefined
      : normalizeAttachment(first, input.pageId, context);
  };

  const create = async (
    input: CreatePageAttachmentInputV1,
  ): Promise<AttachmentInfo> => {
    const existing = await findByFilename({
      pageId: input.pageId,
      filename: input.filename,
    });
    const context: ErrorContext = {
      operation: "create",
      pageId: input.pageId,
      filename: input.filename,
    };
    if (existing) {
      throw deliveryError("name-conflict", context, {
        status: 409,
        diagnostic: "an attachment with this filename already exists",
        requerySuggested: true,
      });
    }

    let response: Response;
    try {
      response = await request(
        `${pathPrefix}/rest/api/content/${encodePathSegment(input.pageId)}/child/attachment`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "X-Atlassian-Token": "nocheck",
          },
          body: multipartBody(input),
        },
      );
    } catch (cause) {
      if (cause instanceof AttachmentDeliveryError) throw cause;
      throw deliveryError("transport", context, { cause });
    }

    const payload = await responsePayload(response, context);
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw deliveryError("invalid-response", context, {
        diagnostic: "create ContentArray is missing",
      });
    }
    if (payload.results.length === 0) {
      throw deliveryError("invalid-response", context, {
        diagnostic: "create ContentArray is empty",
      });
    }
    return normalizeAttachment(payload.results[0], input.pageId, context);
  };

  const updateData = async (
    input: UpdatePageAttachmentDataInputV1,
  ): Promise<AttachmentInfo> => {
    const context: ErrorContext = {
      operation: "update-data",
      pageId: input.pageId,
      filename: input.filename,
      attachmentId: input.attachmentId,
    };
    let response: Response;
    try {
      response = await request(
        `${pathPrefix}/rest/api/content/${encodePathSegment(input.pageId)}` +
          `/child/attachment/${encodePathSegment(input.attachmentId)}/data`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "X-Atlassian-Token": "nocheck",
          },
          body: multipartBody(input),
        },
      );
    } catch (cause) {
      if (cause instanceof AttachmentDeliveryError) throw cause;
      throw deliveryError("transport", context, { cause });
    }

    const payload = await responsePayload(response, context);
    return normalizeAttachment(payload, input.pageId, context);
  };

  return { findByFilename, create, updateData };
}
